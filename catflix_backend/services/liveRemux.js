/**
 * Live HLS Remux Service
 * Converts .ts segments to .m4s (fMP4) on-the-fly for Samsung Browser and Apple devices
 * Uses in-memory cache with TTL for performance
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

// In-memory cache for remuxed segments
const segmentCache = new Map();
const playlistCache = new Map();

// Cache TTL: 30 minutes (segments are immutable once created)
const SEGMENT_CACHE_TTL = 30 * 60 * 1000;
const PLAYLIST_CACHE_TTL = 5 * 1000; // 5 seconds for playlists

// Cleanup interval: every 5 minutes
setInterval(() => {
  const now = Date.now();
  
  // Clean up expired segments
  for (const [key, entry] of segmentCache.entries()) {
    if (now - entry.timestamp > SEGMENT_CACHE_TTL) {
      segmentCache.delete(key);
    }
  }
  
  // Clean up expired playlists
  for (const [key, entry] of playlistCache.entries()) {
    if (now - entry.timestamp > PLAYLIST_CACHE_TTL) {
      playlistCache.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Generate cache key for a file
 */
function getCacheKey(filePath) {
  return crypto.createHash('md5').update(filePath).digest('hex');
}

/**
 * Remux a .ts segment to .m4s (fMP4) format
 */
async function remuxSegment(tsFilePath) {
  const cacheKey = getCacheKey(tsFilePath);
  
  // Check cache first
  const cached = segmentCache.get(cacheKey);
  if (cached) {
    return cached.data;
  }
  
  return new Promise((resolve, reject) => {
    const chunks = [];
    
    const ffmpeg = spawn('ffmpeg', [
      '-i', tsFilePath,
      '-c', 'copy', // No re-encoding
      '-map', '0',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      'pipe:1'
    ]);
    
    ffmpeg.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });
    
    ffmpeg.stderr.on('data', () => {
      // Ignore stderr output
    });
    
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        const buffer = Buffer.concat(chunks);
        
        // Cache the result
        segmentCache.set(cacheKey, {
          data: buffer,
          timestamp: Date.now()
        });
        
        resolve(buffer);
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });
    
    ffmpeg.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Convert .m3u8 playlist to reference .m4s segments instead of .ts
 */
async function convertPlaylist(playlistPath, playlistContent) {
  const cacheKey = getCacheKey(playlistPath + playlistContent);
  
  // Check cache first
  const cached = playlistCache.get(cacheKey);
  if (cached) {
    return cached.data;
  }
  
  // Replace .ts references with .m4s and add remux parameter
  let converted = playlistContent.replace(/(\S+)\.ts(\s|$)/gm, '$1.m4s?remux=fmp4$2');
  
  // Remove #EXT-X-INDEPENDENT-SEGMENTS (Samsung devices don't support this)
  converted = converted.replace(/#EXT-X-INDEPENDENT-SEGMENTS\s*\n?/g, '');
  
  // Add #EXT-X-MAP for fMP4 init segment if not present
  // (We'll generate init segment on-the-fly from first segment)
  if (converted.includes('.m4s') && !converted.includes('#EXT-X-MAP')) {
    // Find first segment reference
    const firstSegmentMatch = converted.match(/([^\s\n?]+\.m4s)/);
    if (firstSegmentMatch) {
      const firstSegment = firstSegmentMatch[1];
      const initSegmentName = firstSegment.replace(/\d+\.m4s$/, 'init.mp4');
      
      // Insert #EXT-X-MAP after #EXT-X-MEDIA-SEQUENCE or #EXT-X-VERSION
      const lines = converted.split('\n');
      const insertIndex = lines.findIndex(line => 
        line.startsWith('#EXT-X-MEDIA-SEQUENCE') || 
        line.startsWith('#EXT-X-VERSION')
      );
      
      if (insertIndex !== -1) {
        lines.splice(insertIndex + 1, 0, `#EXT-X-MAP:URI="${initSegmentName}?remux=fmp4"`);
        converted = lines.join('\n');
      }
    }
  }
  
  // Update version to 7 for fMP4 support
  converted = converted.replace(/#EXT-X-VERSION:\d+/, '#EXT-X-VERSION:7');
  
  // Cache the result
  playlistCache.set(cacheKey, {
    data: converted,
    timestamp: Date.now()
  });
  
  return converted;
}

/**
 * Generate fMP4 init segment from first .ts segment
 */
async function generateInitSegment(tsFilePath) {
  const cacheKey = getCacheKey(tsFilePath + '_init');
  
  // Check cache first
  const cached = segmentCache.get(cacheKey);
  if (cached) {
    return cached.data;
  }
  
  return new Promise((resolve, reject) => {
    const chunks = [];
    
    const ffmpeg = spawn('ffmpeg', [
      '-i', tsFilePath,
      '-map', '0:v:0',
      '-map', '0:a:0',
      '-c', 'copy',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-t', '0.1', // Just need header info
      'pipe:1'
    ]);
    
    ffmpeg.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });
    
    ffmpeg.stderr.on('data', () => {
      // Ignore stderr
    });
    
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        const buffer = Buffer.concat(chunks);
        
        // Cache the result
        segmentCache.set(cacheKey, {
          data: buffer,
          timestamp: Date.now()
        });
        
        resolve(buffer);
      } else {
        reject(new Error(`FFmpeg init segment generation failed with code ${code}`));
      }
    });
    
    ffmpeg.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Get cache statistics
 */
function getCacheStats() {
  return {
    segments: segmentCache.size,
    playlists: playlistCache.size,
    memoryEstimate: Array.from(segmentCache.values())
      .reduce((sum, entry) => sum + entry.data.length, 0)
  };
}

module.exports = {
  remuxSegment,
  convertPlaylist,
  generateInitSegment,
  getCacheStats
};

