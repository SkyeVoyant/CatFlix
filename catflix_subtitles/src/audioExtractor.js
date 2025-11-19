const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const config = require('./config');

const execAsync = promisify(exec);

/**
 * Parse an M3U8 playlist file to extract segment URLs
 */
async function parseM3U8(playlistPath) {
  const content = await fs.readFile(playlistPath, 'utf-8');
  const lines = content.split('\n').map(line => line.trim()).filter(line => line);
  
  const segments = [];
  let isVariantPlaylist = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check if this is a variant playlist (contains #EXT-X-STREAM-INF)
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      isVariantPlaylist = true;
      // Next line should be the variant playlist URL
      if (i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
        const variantPath = lines[i + 1];
        const variantFullPath = path.resolve(path.dirname(playlistPath), variantPath);
        // Recursively parse the variant playlist
        const variantSegments = await parseM3U8(variantFullPath);
        segments.push(...variantSegments);
        i++; // Skip the variant URL line
      }
      continue;
    }
    
    // Regular segment line (not a comment)
    if (!line.startsWith('#') && line.endsWith('.ts')) {
      const segmentPath = path.resolve(path.dirname(playlistPath), line);
      segments.push(segmentPath);
    }
  }
  
  // If no segments found and not a variant playlist, try direct parsing
  if (segments.length === 0 && !isVariantPlaylist) {
    for (const line of lines) {
      if (!line.startsWith('#') && line.endsWith('.ts')) {
        const segmentPath = path.resolve(path.dirname(playlistPath), line);
        segments.push(segmentPath);
      }
    }
  }
  
  return segments;
}

/**
 * Extract audio from a single .ts segment
 */
async function extractAudioFromSegment(segmentPath, outputPath) {
  try {
    // Use FFmpeg to extract audio from the segment
    const command = `ffmpeg -i "${segmentPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${outputPath}" -y -loglevel error`;
    await execAsync(command);
    return true;
  } catch (error) {
    console.error(`[audio-extractor] Failed to extract audio from ${segmentPath}:`, error.message);
    return false;
  }
}

/**
 * Merge multiple audio files into one
 */
async function mergeAudioFiles(audioFiles, outputPath) {
  try {
    // Create a concat file for FFmpeg
    const concatFile = path.join(path.dirname(outputPath), 'concat_list.txt');
    const concatContent = audioFiles.map(file => `file '${file}'`).join('\n');
    await fs.writeFile(concatFile, concatContent);
    
    // Merge using FFmpeg concat demuxer
    const command = `ffmpeg -f concat -safe 0 -i "${concatFile}" -c copy "${outputPath}" -y -loglevel error`;
    await execAsync(command);
    
    // Clean up concat file
    await fs.unlink(concatFile).catch(() => {});
    
    return true;
  } catch (error) {
    console.error('[audio-extractor] Failed to merge audio files:', error.message);
    return false;
  }
}

/**
 * Extract and merge audio from all HLS segments
 */
async function extractAudioFromHLS(hlsPath, outputAudioPath) {
  const mediaDir = config.MEDIA_DIR;
  // hlsPath from DB is already relative (e.g., "movies/Movie Title/movie.m3u8")
  // Remove leading slash if present, then join with media dir
  const normalizedHlsPath = hlsPath.replace(/^\/+/, '');
  const fullHlsPath = path.join(mediaDir, normalizedHlsPath);
  
  console.log(`[audio-extractor] Processing HLS: ${fullHlsPath}`);
  console.log(`[audio-extractor] Media dir: ${mediaDir}, HLS path: ${hlsPath}`);
  
  // Check if the m3u8 file exists
  try {
    await fs.access(fullHlsPath);
  } catch (error) {
    throw new Error(`HLS playlist not found: ${fullHlsPath}`);
  }
  
  // Parse the playlist to get all segments
  const segments = await parseM3U8(fullHlsPath);
  
  if (segments.length === 0) {
    throw new Error('No segments found in HLS playlist');
  }
  
  console.log(`[audio-extractor] Found ${segments.length} segments`);
  
  // Create temp directory for individual audio files
  const tempDir = path.join(config.TEMP_DIR, 'audio', `extract_${Date.now()}`);
  await fs.mkdir(tempDir, { recursive: true });
  
  const audioFiles = [];
  
  try {
    // Extract audio from each segment
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const audioFile = path.join(tempDir, `segment_${i.toString().padStart(5, '0')}.wav`);
      
      console.log(`[audio-extractor] Extracting audio from segment ${i + 1}/${segments.length}`);
      
      const success = await extractAudioFromSegment(segment, audioFile);
      if (success) {
        // Check if file was created and has content
        try {
          const stats = await fs.stat(audioFile);
          if (stats.size > 0) {
            audioFiles.push(audioFile);
          }
        } catch {
          // File doesn't exist or is empty, skip it
        }
      }
    }
    
    if (audioFiles.length === 0) {
      throw new Error('No audio files were successfully extracted');
    }
    
    console.log(`[audio-extractor] Merging ${audioFiles.length} audio files`);
    
    // Merge all audio files
    const success = await mergeAudioFiles(audioFiles, outputAudioPath);
    
    if (!success) {
      throw new Error('Failed to merge audio files');
    }
    
    // Clean up individual segment audio files
    for (const audioFile of audioFiles) {
      await fs.unlink(audioFile).catch(() => {});
    }
    await fs.rmdir(tempDir).catch(() => {});
    
    console.log(`[audio-extractor] Audio extraction complete: ${outputAudioPath}`);
    return true;
  } catch (error) {
    // Clean up on error
    for (const audioFile of audioFiles) {
      await fs.unlink(audioFile).catch(() => {});
    }
    await fs.rmdir(tempDir).catch(() => {});
    throw error;
  }
}

module.exports = {
  extractAudioFromHLS
};

