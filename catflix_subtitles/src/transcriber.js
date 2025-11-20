const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const config = require('./config');

const execAsync = promisify(exec);

/**
 * Transcribe audio using Whisper
 */
async function transcribeAudio(audioPath) {
  const model = config.WHISPER_MODEL || 'base';
  const outputDir = path.dirname(audioPath);
  const baseName = path.basename(audioPath, path.extname(audioPath));
  
  console.log(`[transcriber] Starting Whisper transcription with model: ${model}`);
  console.log(`[transcriber] Audio file: ${audioPath}`);
  
  try {
    // Whisper command with anti-hallucination settings:
    // --condition_on_previous_text False: Prevents repetitive hallucinations
    // --no_speech_threshold 0.6: Higher threshold to ignore silence (default is 0.6, we use 0.6)
    // --logprob_threshold -1.0: Filters out low-confidence segments
    // --compression_ratio_threshold 2.4: Rejects repetitive text
    // --fp16 False: Use FP32 instead of FP16 (required for CPU-only systems)
    // --beam_size 5: Standard beam search for quality
    // Note: initial_prompt removed to prevent prompt text from leaking into transcription
    const command = `whisper "${audioPath}" --model ${model} --output_format json --output_dir "${outputDir}" --task transcribe --temperature 0.0 --beam_size 5 --condition_on_previous_text False --no_speech_threshold 0.6 --logprob_threshold -1.0 --compression_ratio_threshold 2.4 --fp16 False`;
    
    console.log(`[transcriber] Running: ${command}`);
    console.log(`[transcriber] Anti-hallucination settings enabled`);
    console.log(`[transcriber] This may take ~15-30 minutes for a 2-hour movie with the small model...`);
    
    let stdout, stderr;
    try {
      const result = await execAsync(command, {
        maxBuffer: 100 * 1024 * 1024, // 100MB buffer - whisper outputs a lot to stderr
        timeout: 7200000, // 2 hour timeout for long movies
        killSignal: 'SIGTERM'
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (execError) {
      // Command failed - log the actual error details
      console.error(`[transcriber] Whisper command failed with exit code:`, execError.code);
      console.error(`[transcriber] Signal:`, execError.signal);
      console.error(`[transcriber] Killed:`, execError.killed);
      console.error(`[transcriber] Error message:`, execError.message);
      if (execError.stdout) {
        console.error(`[transcriber] stdout (first 1000 chars):`, execError.stdout.substring(0, 1000));
      }
      if (execError.stderr) {
        console.error(`[transcriber] stderr (first 1000 chars):`, execError.stderr.substring(0, 1000));
      }
      // If killed by timeout or buffer, give more specific error
      if (execError.killed) {
        throw new Error(`Whisper process was killed (likely timeout or buffer overflow)`);
      }
      throw new Error(`Whisper command failed: ${execError.stderr || execError.message}`);
    }
    
    if (stdout) {
      // Whisper verbose output shows progress - log it
      const progressLines = stdout.split('\n').filter(line => 
        line.includes('%') || line.includes('Processing') || line.includes('Detected language')
      );
      if (progressLines.length > 0) {
        console.log(`[transcriber] Whisper progress:`, progressLines.join(' | '));
      }
    }
    
    if (stderr) {
      // Whisper often outputs progress to stderr too
      console.log(`[transcriber] Whisper stderr output:`, stderr.substring(0, 500));
    }
    
    // Whisper outputs JSON file with same name as input (without extension) + .json
    const jsonPath = path.join(outputDir, `${baseName}.json`);
    
    // Check if the JSON file was created
    try {
      await fs.access(jsonPath);
    } catch {
      throw new Error(`Whisper output file not found: ${jsonPath}`);
    }
    
    // Read and parse the JSON
    const jsonContent = await fs.readFile(jsonPath, 'utf-8');
    const transcription = JSON.parse(jsonContent);
    
    // Clean up Whisper's JSON output file (we've already read it)
    await fs.unlink(jsonPath).catch(() => {});
    
    console.log(`[transcriber] Transcription complete`);
    
    return transcription;
  } catch (error) {
    console.error(`[transcriber] Transcription failed:`, error.message);
    throw new Error(`Whisper transcription failed: ${error.message}`);
  }
}

/**
 * Filter out common Whisper hallucinations and artifacts
 */
function filterHallucinations(segments) {
  const HALLUCINATION_PATTERNS = [
    /^you\.?$/i,
    /^thank you\.?$/i,
    /^thanks\.?$/i,
    /^thanks for watching\.?$/i,
    /^please subscribe\.?$/i,
    /^like and subscribe\.?$/i,
    /^subtitles?\.?$/i,
    /^music\.?$/i,
    /^\[music\]\.?$/i,
    /^\(music\)\.?$/i,
    /^\.+$/,  // Just dots
    /^,+$/,   // Just commas
    // Filter out the initial prompt text that sometimes leaks into results
    /this is a movie dialogue/i,
    /clear speech/i,
    /avoid filler/i,
    /^this is a movie dialogue with clear speech\.?\s*avoid filler words\.?$/i,
  ];

  const filtered = [];
  const timestamps = new Map(); // Track text patterns and their timestamps
  
  for (const segment of segments) {
    const text = segment.text.trim();
    const duration = segment.end - segment.start;
    
    // Skip empty or very short text
    if (!text || text.length < 2) continue;
    
    // Skip very short duration segments (< 0.5 seconds) - likely artifacts
    if (duration < 0.5) continue;
    
    // Skip known hallucination patterns
    if (HALLUCINATION_PATTERNS.some(pattern => pattern.test(text))) {
      console.log(`[filter] Removed hallucination: "${text}" at ${segment.start.toFixed(1)}s`);
      continue;
    }
    
    // Detect repetitive patterns (same text appearing regularly)
    // If we see the same short text (< 15 chars) more than 3 times, it's likely a hallucination
    if (text.length < 15) {
      if (!timestamps.has(text)) {
        timestamps.set(text, []);
      }
      timestamps.get(text).push(segment.start);
      
      const occurrences = timestamps.get(text);
      if (occurrences.length > 3) {
        // Check if they appear at regular intervals (hallucination pattern)
        const intervals = [];
        for (let i = 1; i < occurrences.length; i++) {
          intervals.push(occurrences[i] - occurrences[i-1]);
        }
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const isRegular = intervals.every(interval => Math.abs(interval - avgInterval) < 5);
        
        if (isRegular && avgInterval > 20 && avgInterval < 60) {
          console.log(`[filter] Removed repetitive hallucination: "${text}" (${occurrences.length} times at ~${avgInterval.toFixed(0)}s intervals)`);
          continue;
        }
      }
    }
    
    // Skip if the segment is only punctuation or whitespace after filtering
    if (!/[a-zA-Z0-9]/.test(text)) continue;
    
    filtered.push(segment);
  }
  
  console.log(`[filter] Filtered ${segments.length - filtered.length} hallucinations from ${segments.length} segments`);
  return filtered;
}

/**
 * Convert Whisper JSON output to our subtitle format
 */
function convertToSubtitleFormat(whisperOutput) {
  const rawSubtitles = [];
  
  if (!whisperOutput.segments || !Array.isArray(whisperOutput.segments)) {
    throw new Error('Invalid Whisper output format: missing segments');
  }
  
  // First pass: collect all segments
  for (const segment of whisperOutput.segments) {
    if (segment.start !== undefined && segment.end !== undefined && segment.text) {
      rawSubtitles.push({
        start: segment.start,
        end: segment.end,
        text: segment.text.trim()
      });
    }
  }
  
  // Second pass: filter hallucinations
  const filteredSubtitles = filterHallucinations(rawSubtitles);
  
  // Third pass: assign IDs
  const subtitles = filteredSubtitles.map((sub, index) => ({
    id: index + 1,
    ...sub
  }));
  
  const detectedLanguage = (whisperOutput.language || '').toLowerCase() || 'unknown';
  
  return {
    metadata: {
      language: detectedLanguage,
      originalLanguage: detectedLanguage,
      model: config.WHISPER_MODEL || 'small',
      generatedAt: new Date().toISOString(),
      filtered: rawSubtitles.length - subtitles.length
    },
    subtitles: subtitles
  };
}

module.exports = {
  transcribeAudio,
  convertToSubtitleFormat
};

