/**
 * Live HLS remuxing helpers.
 * Converts transport stream segments to fMP4 and caches generated payloads in memory.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

// In-memory cache for remuxed segment payloads.
const segmentCache = new Map();
const playlistCache = new Map();

// Segment payloads are immutable, so they can be cached for longer.
const SEGMENT_CACHE_TTL = 30 * 60 * 1000;
const PLAYLIST_CACHE_TTL = 5 * 1000;

// Periodically evict expired cache entries.
setInterval(() => {
  const now = Date.now();
  
  // Remove expired segment entries.
  for (const [key, entry] of segmentCache.entries()) {
    if (now - entry.timestamp > SEGMENT_CACHE_TTL) {
      segmentCache.delete(key);
    }
  }
  
  // Remove expired playlist entries.
  for (const [key, entry] of playlistCache.entries()) {
    if (now - entry.timestamp > PLAYLIST_CACHE_TTL) {
      playlistCache.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Build a stable cache key from source content metadata.
 */
function getCacheKey(filePath) {
  return crypto.createHash('md5').update(filePath).digest('hex');
}

/**
 * Remux a .ts segment into fMP4 bytes.
 */
async function remuxSegment(tsFilePath) {
  const cacheKey = getCacheKey(tsFilePath);
  
  // Serve from cache when possible.
  const cached = segmentCache.get(cacheKey);
  if (cached) {
    return cached.data;
  }
  
  return new Promise((resolve, reject) => {
    const chunks = [];
    
    const ffmpeg = spawn('ffmpeg', [
      '-i', tsFilePath,
      '-c', 'copy',
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
        
        // Cache the generated fMP4 payload.
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
 * Convert a transport-stream playlist to fMP4 segment references.
 */
async function convertPlaylist(playlistPath, playlistContent) {
  const cacheKey = getCacheKey(playlistPath + playlistContent);
  
  // Serve from cache when possible.
  const cached = playlistCache.get(cacheKey);
  if (cached) {
    return cached.data;
  }
  
  // Rewrite segment references to use remuxed fMP4 endpoints.
  let converted = playlistContent.replace(/(\S+)\.ts(\s|$)/gm, '$1.m4s?remux=fmp4$2');
  
  // Drop unsupported directives for less-capable players.
  converted = converted.replace(/#EXT-X-INDEPENDENT-SEGMENTS\s*\n?/g, '');
  
  // Add an init-segment map for fMP4 playlists when missing.
  if (converted.includes('.m4s') && !converted.includes('#EXT-X-MAP')) {
    // Find the first segment so the init path can be derived.
    const firstSegmentMatch = converted.match(/([^\s\n?]+\.m4s)/);
    if (firstSegmentMatch) {
      const firstSegment = firstSegmentMatch[1];
      const initSegmentName = firstSegment.replace(/\d+\.m4s$/, 'init.mp4');
      
      // Insert EXT-X-MAP near the playlist header directives.
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
  
  // Version 7 advertises fMP4 support.
  converted = converted.replace(/#EXT-X-VERSION:\d+/, '#EXT-X-VERSION:7');
  
  // Cache the rewritten playlist body.
  playlistCache.set(cacheKey, {
    data: converted,
    timestamp: Date.now()
  });
  
  return converted;
}

/**
 * Generate an fMP4 init segment from a source TS segment.
 */
async function generateInitSegment(tsFilePath) {
  const cacheKey = getCacheKey(tsFilePath + '_init');
  
  // Serve from cache when possible.
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
      '-t', '0.1',
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
        
        // Cache the generated init segment.
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
