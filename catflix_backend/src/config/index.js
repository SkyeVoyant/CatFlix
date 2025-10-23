const path = require('path');
const fs = require('fs');
const os = require('os');
const dotenv = require('dotenv');

function firstExistingPath(paths) {
  for (const candidate of paths) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      // ignore
    }
  }
  return null;
}

function isCatflixRoot(candidate) {
  const backendDir = path.join(candidate, 'catflix_backend');
  const frontendDir = path.join(candidate, 'catflix_frontend');
  return fs.existsSync(backendDir) && fs.existsSync(frontendDir);
}

function determineRootDir(baseDir) {
  let current = path.resolve(baseDir);
  for (let i = 0; i < 6; i += 1) {
    if (isCatflixRoot(current)) {
      return current;
    }
    const parent = path.resolve(current, '..');
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return path.resolve(baseDir, '../../..');
}

const ROOT_DIR = determineRootDir(__dirname);
const envFile = process.env.ENV_FILE
  ? path.resolve(process.env.ENV_FILE)
  : firstExistingPath([
      path.join(ROOT_DIR, '.env')
    ]);

if (envFile) {
  dotenv.config({ path: envFile });
} else {
  dotenv.config();
}

function resolveMediaDir() {
  const raw = (process.env.MEDIA_DIR || '').trim();
  const out = (process.env.MEDIA_DIR_OUT || '').trim();
  const container = (process.env.MEDIA_DIR_CONTAINER || '').trim();
  const fallback = path.join(ROOT_DIR, 'media');
  const isWindowsPath = (value) => /^[A-Za-z]:\\/.test(value || '');
  if (raw && isWindowsPath(raw)) {
    return container || out || '/media';
  }
  const candidate = raw || out || fallback;
  if (isWindowsPath(candidate)) return candidate;
  return path.isAbsolute(candidate) ? candidate : path.join(ROOT_DIR, candidate);
}

const CLIENT_BUILD_DIR = firstExistingPath([
  path.join(ROOT_DIR, 'catflix_frontend', 'build'),
  path.join(ROOT_DIR, 'frontend', 'build'),
  path.join(ROOT_DIR, 'catflix_backend', 'frontend', 'build')
]) || path.join(ROOT_DIR, 'catflix_frontend', 'build');

const config = {
  ROOT_DIR,
  PORT: Number(process.env.PORT || 3004),
  PASSWORD: (process.env.PASSWORD || '').trim(),
  HLS_MASTER_PLAYLIST_NAME: process.env.HLS_MASTER_PLAYLIST_NAME || '%b.m3u8',
  HLS_VARIANT_PLAYLIST_TEMPLATE: process.env.HLS_VARIANT_PLAYLIST_TEMPLATE || '%b_v%v.m3u8',
  HLS_SEGMENT_TEMPLATE: process.env.HLS_SEGMENT_TEMPLATE || '%b_v%v_%05d.ts',
  REMUX_CACHE_DIR: process.env.REMUX_CACHE_DIR || path.join(os.tmpdir(), 'catflix-remux-cache'),
  FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
  REMUX_SESSION_TTL_MS: Number(process.env.REMUX_SESSION_TTL_MS || 30 * 60 * 1000),
  MAX_DOWNLOAD_FILENAME_LENGTH: Number(process.env.REMUX_MAX_FILENAME_LENGTH || 140),
  REMUX_MAX_PARALLEL: Number.isFinite(Number(process.env.REMUX_MAX_PARALLEL))
    ? Math.max(1, Number(process.env.REMUX_MAX_PARALLEL))
    : os.cpus()?.length || 4,
  TMDB_API_KEY: process.env.TMDB_API_KEY || '',
  TMDB_POOL_SIZE: Number(process.env.TMDB_POOL_SIZE || 2),
  TMDB_BACKFILL_BATCH_SIZE: Number(process.env.TMDB_BACKFILL_BATCH_SIZE || 6),
  TMDB_BACKFILL_INTERVAL_MS: Number(process.env.TMDB_BACKFILL_INTERVAL_MS || 15 * 60 * 1000),
  MEDIA_DIR: resolveMediaDir(),
  CLIENT_BUILD_DIR,
  REMUX_CLEANUP_INTERVAL_MS: Math.max(
    Math.floor(Number(process.env.REMUX_SESSION_TTL_MS || 30 * 60 * 1000) / 2),
    60 * 1000
  ),
  INTERNAL_API_KEY: (process.env.INTERNAL_API_KEY || '').trim()
};

if (!config.PASSWORD) {
  throw new Error('PASSWORD environment variable is required');
}

module.exports = config;
