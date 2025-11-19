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
    // --initial_prompt: Discourages filler words
    // --no_speech_threshold 0.6: Higher threshold to ignore silence (default is 0.6, we use 0.6)
    // --logprob_threshold -1.0: Filters out low-confidence segments
    // --compression_ratio_threshold 2.4: Rejects repetitive text
    const initialPrompt = "This is a movie dialogue with clear speech. Avoid filler words.";
    const command = `whisper "${audioPath}" --model ${model} --output_format json --output_dir "${outputDir}" --task transcribe --temperature 0.0 --beam_size 5 --best_of 5 --condition_on_previous_text False --initial_prompt "${initialPrompt}" --no_speech_threshold 0.6 --logprob_threshold -1.0 --compression_ratio_threshold 2.4`;
    
    console.log(`[transcriber] Running: ${command}`);
    console.log(`[transcriber] Anti-hallucination settings enabled`);
    console.log(`[transcriber] This may take ~15-30 minutes for a 2-hour movie with the small model...`);
    
    const { stdout, stderr } = await execAsync(command, {
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large outputs
      timeout: 3600000 // 1 hour timeout (transcription can take a while)
    });
    
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
      const stderrLines = stderr.split('\n').filter(line => line.trim());
      if (stderrLines.length > 0 && !stderrLines[0].includes('CUDA') && !stderrLines[0].includes('warning')) {
        console.log(`[transcriber] Whisper output:`, stderrLines.slice(0, 5).join(' | '));
      }
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
    /this is a movie dialogue with clear speech/i,
    /avoid filler words/i,
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

