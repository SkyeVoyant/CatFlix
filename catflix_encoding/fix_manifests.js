#!/usr/bin/env node

/**
 * One-time script to rebuild all variant manifests (*.m3u8) from existing segments
 * without re-encoding. This fixes manifests that were cut off due to resume bugs.
 * 
 * Usage: node fix_manifests.js [--dry-run] [--media-dir /path/to/media]
 */

const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const mediaDirIndex = args.indexOf('--media-dir');
const customMediaDir = mediaDirIndex >= 0 && args[mediaDirIndex + 1] 
  ? args[mediaDirIndex + 1] 
  : null;

// Load environment if available
try {
  const dotenv = require('dotenv');
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
} catch (e) {
  // dotenv not required for this script
}

const HLS_SEGMENT_DURATION = Number(process.env.HLS_SEGMENT_DURATION || 6);

// Determine media directory
function getMediaDir() {
  if (customMediaDir) return customMediaDir;
  const envMediaDir = process.env.MEDIA_DIR_OUT || process.env.MEDIA_DIR;
  if (envMediaDir) return envMediaDir;
  return path.join(__dirname, '..', 'media');
}

const MEDIA_DIR = getMediaDir();

console.log('='.repeat(80));
console.log('Catflix Manifest Rebuild Script');
console.log('='.repeat(80));
console.log(`Media Directory: ${MEDIA_DIR}`);
console.log(`Dry Run: ${dryRun ? 'YES (no changes will be made)' : 'NO (will modify files)'}`);
console.log('='.repeat(80));
console.log('');

/**
 * Find all HLS variant playlists and their associated segments
 */
async function findAllPlaylists(dir, results = []) {
  const entries = await fsPromises.readdir(dir, { withFileTypes: true }).catch(() => []);
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      await findAllPlaylists(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith('.m3u8') && !entry.name.includes('master')) {
      // This is likely a variant playlist (not a master playlist)
      results.push(fullPath);
    }
  }
  
  return results;
}

/**
 * Find all segment files that belong to a playlist
 */
async function findSegmentsForPlaylist(playlistPath) {
  const dir = path.dirname(playlistPath);
  const playlistName = path.basename(playlistPath, '.m3u8');
  
  // Try to determine the segment pattern from playlist name
  // Typical pattern: basename.m3u8 -> basename_00000.ts
  const segmentPattern = new RegExp(`^${escapeRegex(playlistName)}_(\\d+)\\.ts$`, 'i');
  
  const entries = await fsPromises.readdir(dir).catch(() => []);
  const segments = [];
  
  for (const name of entries) {
    const match = segmentPattern.exec(name);
    if (match) {
      const index = parseInt(match[1], 10);
      const fullPath = path.join(dir, name);
      const stats = await fsPromises.stat(fullPath).catch(() => null);
      if (stats && stats.isFile()) {
        segments.push({ name, index, path: fullPath });
      }
    }
  }
  
  return segments.sort((a, b) => a.index - b.index);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Read and parse an existing m3u8 file
 */
async function parsePlaylist(playlistPath) {
  try {
    const content = await fsPromises.readFile(playlistPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    
    const segments = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXTINF:')) {
        // Next line should be the segment filename
        if (i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
          segments.push(lines[i + 1]);
        }
      }
    }
    
    return { segments, lineCount: lines.length };
  } catch (err) {
    return null;
  }
}

/**
 * Rebuild a variant playlist from scratch based on segments
 */
async function rebuildPlaylist(playlistPath, segments) {
  if (segments.length === 0) {
    console.log(`  ⚠️  No segments found for ${path.basename(playlistPath)}`);
    return false;
  }
  
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.ceil(HLS_SEGMENT_DURATION)}`,
    '#EXT-X-MEDIA-SEQUENCE:0'
  ];
  
  // Add each segment
  for (const seg of segments) {
    lines.push(`#EXTINF:${HLS_SEGMENT_DURATION.toFixed(6)},`);
    lines.push(seg.name);
  }
  
  // Check if this is a complete video by looking for a master playlist
  const dir = path.dirname(playlistPath);
  const playlistBaseName = path.basename(playlistPath, '.m3u8');
  const masterPath = path.join(dir, `${playlistBaseName}.m3u8`);
  
  // If playlist path doesn't contain stream or variant indicators, it's likely the master
  // In that case, look for actual master playlists
  const hasMasterPlaylist = await fsPromises.access(masterPath).then(() => true).catch(() => false);
  
  // For now, always add EXT-X-ENDLIST since we're fixing completed encodes
  lines.push('#EXT-X-ENDLIST');
  
  const content = lines.join('\n') + '\n';
  
  if (dryRun) {
    console.log(`  [DRY RUN] Would write ${lines.length} lines to ${playlistPath}`);
    return true;
  } else {
    await fsPromises.writeFile(playlistPath, content, 'utf8');
    return true;
  }
}

/**
 * Check if a playlist needs to be rebuilt
 */
async function needsRebuild(playlistPath, actualSegments) {
  const parsed = await parsePlaylist(playlistPath);
  if (!parsed) {
    return { needed: true, reason: 'Cannot read playlist' };
  }
  
  if (parsed.segments.length === 0) {
    return { needed: true, reason: 'Playlist is empty' };
  }
  
  if (parsed.segments.length !== actualSegments.length) {
    return { 
      needed: true, 
      reason: `Segment count mismatch (playlist: ${parsed.segments.length}, actual: ${actualSegments.length})` 
    };
  }
  
  // Check if segments start from 0
  const firstSegmentMatch = actualSegments[0].name.match(/_(\d+)\.ts$/);
  if (firstSegmentMatch && parseInt(firstSegmentMatch[1], 10) !== 0) {
    return { needed: false, reason: 'Not starting from segment 0 (likely incomplete encode)' };
  }
  
  // Check if playlist segments match actual segments
  const playlistSegmentSet = new Set(parsed.segments);
  const actualSegmentSet = new Set(actualSegments.map(s => s.name));
  
  for (const seg of actualSegments) {
    if (!playlistSegmentSet.has(seg.name)) {
      return { needed: true, reason: `Missing segment in playlist: ${seg.name}` };
    }
  }
  
  return { needed: false, reason: 'Playlist appears correct' };
}

/**
 * Main execution
 */
async function main() {
  try {
    // Check if media directory exists
    const mediaExists = await fsPromises.access(MEDIA_DIR).then(() => true).catch(() => false);
    if (!mediaExists) {
      console.error(`❌ Media directory does not exist: ${MEDIA_DIR}`);
      console.error('   Use --media-dir to specify a different location');
      process.exit(1);
    }
    
    console.log('🔍 Scanning for playlists...\n');
    
    const playlists = await findAllPlaylists(MEDIA_DIR);
    
    if (playlists.length === 0) {
      console.log('No playlists found.');
      return;
    }
    
    console.log(`Found ${playlists.length} playlists\n`);
    
    let processedCount = 0;
    let rebuiltCount = 0;
    let skippedCount = 0;
    
    for (const playlistPath of playlists) {
      const relativePath = path.relative(MEDIA_DIR, playlistPath);
      console.log(`\n📄 ${relativePath}`);
      
      const segments = await findSegmentsForPlaylist(playlistPath);
      console.log(`   Found ${segments.length} segments`);
      
      if (segments.length === 0) {
        console.log('   ⏭️  Skipping (no segments found)');
        skippedCount++;
        continue;
      }
      
      const check = await needsRebuild(playlistPath, segments);
      console.log(`   ${check.reason}`);
      
      if (check.needed) {
        const success = await rebuildPlaylist(playlistPath, segments);
        if (success) {
          console.log(`   ✅ ${dryRun ? 'Would rebuild' : 'Rebuilt'} playlist`);
          rebuiltCount++;
        }
      } else {
        console.log('   ⏭️  Skipping (no rebuild needed)');
        skippedCount++;
      }
      
      processedCount++;
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('Summary:');
    console.log(`  Total playlists: ${playlists.length}`);
    console.log(`  Processed: ${processedCount}`);
    console.log(`  ${dryRun ? 'Would rebuild' : 'Rebuilt'}: ${rebuiltCount}`);
    console.log(`  Skipped: ${skippedCount}`);
    console.log('='.repeat(80));
    
    if (dryRun) {
      console.log('\n💡 This was a dry run. Use without --dry-run to actually fix the manifests.');
    }
    
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

main();

