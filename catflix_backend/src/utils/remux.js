const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const config = require('../config');

const remuxSessions = new Map();
const remuxQueue = [];
let activeRemuxCount = 0;

function sanitizeFilename(input) {
  if (!input) return 'download';
  const stripped = input
    .replace(/[\/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return 'download';
  return stripped.length > config.MAX_DOWNLOAD_FILENAME_LENGTH
    ? stripped.slice(0, config.MAX_DOWNLOAD_FILENAME_LENGTH)
    : stripped;
}

function cacheFilePath(id, extension = '.mp4') {
  return path.join(config.REMUX_CACHE_DIR, `${id}${extension}`);
}

async function ensureCacheDir() {
  return fsp.mkdir(config.REMUX_CACHE_DIR, { recursive: true });
}

async function wipeCacheDir() {
  try {
    const entries = await fsp.readdir(config.REMUX_CACHE_DIR, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(config.REMUX_CACHE_DIR, entry.name);
      if (entry.isDirectory()) {
        await fsp.rm(fullPath, { recursive: true, force: true });
      } else {
        await fsp.unlink(fullPath).catch(() => {});
      }
    }));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await ensureCacheDir();
}

function rememberRemuxSession(id, info) {
  remuxSessions.set(id, { ...info, touchedAt: Date.now() });
}

function touchRemuxSession(id) {
  const existing = remuxSessions.get(id);
  if (existing) {
    existing.touchedAt = Date.now();
    remuxSessions.set(id, existing);
  }
}

function dropRemuxSession(id) {
  remuxSessions.delete(id);
}

function scheduleRemuxJob(job) {
  remuxQueue.push(job);
  processNextRemux();
}

function processNextRemux() {
  if (activeRemuxCount >= config.REMUX_MAX_PARALLEL) return;
  const job = remuxQueue.shift();
  if (!job) return;
  activeRemuxCount += 1;
  job()
    .catch((err) => {
      console.error('[remux] job failed', err);
    })
    .finally(() => {
      activeRemuxCount -= 1;
      if (remuxQueue.length > 0) {
        setImmediate(processNextRemux);
      }
    });
}

async function removeFileQuietly(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[remux] Failed to remove temp file', filePath, err.message || err);
    }
  }
}

async function cleanupExpiredSessions() {
  const now = Date.now();
  const expiredIds = [];
  const deletionPromises = [];
  for (const [id, info] of remuxSessions.entries()) {
    if (now - info.touchedAt > config.REMUX_SESSION_TTL_MS) {
      expiredIds.push(id);
      if (info.filePath) {
        deletionPromises.push(removeFileQuietly(info.filePath));
      }
    }
  }
  expiredIds.forEach((id) => remuxSessions.delete(id));
  if (deletionPromises.length > 0) {
    await Promise.allSettled(deletionPromises);
  }
}

function runFfmpegRemux(inputPath, outputPath, titleForLogs = 'remux') {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-c', 'copy',
      '-movflags', 'faststart',
      '-f', 'mp4',
      outputPath
    ];
    const child = spawn(config.FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrBuf = '';
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
    });
    child.on('error', (err) => {
      reject(err);
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const err = new Error(`ffmpeg remux failed for ${titleForLogs} (code ${code})`);
        err.stderr = stderrBuf.trim();
        reject(err);
      }
    });
  });
}

async function streamFileAsDownload(res, filePath, options = {}) {
  const stat = await fsp.stat(filePath);
  const filename = options.filename || path.basename(filePath);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  const stream = fs.createReadStream(filePath);
  await pipeline(stream, res);
}

async function ensureRemuxedFile({ type, descriptor, sourceRelative, hlsRelative, cacheKey }) {
  const { computeHlsLayout } = require('./hls');
  const { toPosix, fromPosix } = require('./path');
  const MEDIA_DIR = config.MEDIA_DIR;

  const layout = computeHlsLayout({
    type,
    sourceRelativePath: sourceRelative ? toPosix(sourceRelative) : null,
    hlsRelativePath: hlsRelative ? toPosix(hlsRelative) : null,
    hlsMasterTemplate: config.HLS_MASTER_PLAYLIST_NAME,
    hlsVariantTemplate: config.HLS_VARIANT_PLAYLIST_TEMPLATE,
    hlsSegmentTemplate: config.HLS_SEGMENT_TEMPLATE
  });
  const masterRelative = layout.masterRelative;
  if (!masterRelative) {
    throw new Error('No HLS master playlist available');
  }
  const masterAbsolute = path.join(MEDIA_DIR, fromPosix(masterRelative));
  const { pathExists } = require('./fs');
  if (!(await pathExists(masterAbsolute))) {
    throw new Error('HLS playlist missing on disk');
  }

  await ensureCacheDir();

  const sessionId = cacheKey || randomUUID();
  const filename = `${sanitizeFilename(descriptor)}.mp4`;
  const cachedPath = cacheFilePath(sessionId);

  let session = remuxSessions.get(sessionId);
  if (session && await pathExists(session.filePath)) {
    touchRemuxSession(sessionId);
    return { filePath: session.filePath, filename, sessionId };
  }

  if (!session) {
    session = {
      filePath: cachedPath,
      filename,
      type,
      promise: null
    };
    remuxSessions.set(sessionId, session);
  }

  if (!session.promise) {
    session.promise = new Promise((resolve, reject) => {
      scheduleRemuxJob(async () => {
        try {
          await runFfmpegRemux(masterAbsolute, cachedPath, descriptor);
          rememberRemuxSession(sessionId, { filePath: cachedPath, filename, type });
          resolve();
        } catch (err) {
          await removeFileQuietly(cachedPath);
          dropRemuxSession(sessionId);
          reject(err);
        }
      });
    });
  }

  await session.promise;
  const entry = remuxSessions.get(sessionId);
  if (!entry || !(await pathExists(entry.filePath))) {
    throw new Error('Remux output missing after completion');
  }
  touchRemuxSession(sessionId);
  return { filePath: entry.filePath, filename, sessionId };
}

async function streamRemuxResult(res, remuxInfo, { deleteAfter = false } = {}) {
  try {
    await streamFileAsDownload(res, remuxInfo.filePath, { filename: remuxInfo.filename });
  } finally {
    if (deleteAfter) {
      await removeFileQuietly(remuxInfo.filePath);
      dropRemuxSession(remuxInfo.sessionId);
    } else {
      touchRemuxSession(remuxInfo.sessionId);
    }
  }
}

module.exports = {
  sanitizeFilename,
  ensureCacheDir,
  wipeCacheDir,
  rememberRemuxSession,
  touchRemuxSession,
  dropRemuxSession,
  scheduleRemuxJob,
  cleanupExpiredSessions,
  ensureRemuxedFile,
  streamRemuxResult
};
