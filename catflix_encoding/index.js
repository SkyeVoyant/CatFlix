const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const dotenv = (() => {
  try {
    return require('dotenv');
  } catch (err) {
    try {
      return require('../catflix_backend/node_modules/dotenv');
    } catch (fallbackErr) {
      err.message = `${err.message}. Install backend dependencies so the encoder can reuse them.`;
      throw err;
    }
  }
})();
const { spawn } = require('child_process');

const pathPosix = path.posix;

function firstExistingPath(paths) {
  for (const candidate of paths) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return null;
}

function determineRootDir() {
  const candidates = [
    path.resolve(__dirname),
    path.resolve(__dirname, '..')
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'catflix_backend'))) {
      return dir;
    }
  }
  return path.resolve(__dirname, '..');
}

const ROOT_DIR = determineRootDir();
const envFile = process.env.ENV_FILE
  ? path.resolve(process.env.ENV_FILE)
  : firstExistingPath([
      path.join(ROOT_DIR, '.env'),
      path.join(__dirname, '.env')
    ]);
if (envFile) {
  dotenv.config({ path: envFile });
} else {
  dotenv.config();
}

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const HLS_SEGMENT_DURATION = Number(process.env.HLS_SEGMENT_DURATION || 6);
const HLS_PLAYLIST_TYPE = process.env.HLS_PLAYLIST_TYPE || 'vod';
const HLS_MASTER_PLAYLIST_NAME = process.env.HLS_MASTER_PLAYLIST_NAME || '%b.m3u8';
const HLS_VARIANT_PLAYLIST_TEMPLATE = process.env.HLS_VARIANT_PLAYLIST_TEMPLATE || '%b.m3u8';
const HLS_SEGMENT_TEMPLATE = process.env.HLS_SEGMENT_TEMPLATE || '%b_%05d.ts';
const HLS_CONCURRENCY = Math.max(1, Number(process.env.HLS_MAX_CONCURRENCY || 1));
const HLS_HIGH_VIDEO_BITRATE = process.env.HLS_HIGH_VIDEO_BITRATE || '6000k';
const HLS_HIGH_MAX_BITRATE = process.env.HLS_HIGH_MAX_BITRATE || '7500k';
const HLS_HIGH_AUDIO_BITRATE = process.env.HLS_HIGH_AUDIO_BITRATE || '320k';
const HLS_AUDIO_CHANNELS_HIGH = Number(process.env.HLS_HIGH_AUDIO_CHANNELS || 2);
const HLS_HIGH_RESOLUTION = process.env.HLS_HIGH_RESOLUTION || '1920x1080';
const HLS_HIGH_BUF_SIZE = process.env.HLS_HIGH_BUF_SIZE || '';
const HLS_KEYFRAME_INTERVAL = Number(process.env.HLS_KEYFRAME_INTERVAL || 60);
const HLS_FFMPEG_PRESET = process.env.HLS_FFMPEG_PRESET || 'slow';
const HLS_FFMPEG_TUNE = process.env.HLS_FFMPEG_TUNE || '';
const HLS_FFMPEG_THREADS = process.env.HLS_FFMPEG_THREADS || '';
const HLS_RESCAN_DEBOUNCE_MS = Number(process.env.HLS_RESCAN_DEBOUNCE_MS || 2000);
const HLS_FFMPEG_THREADS_TOTAL = Number(process.env.HLS_FFMPEG_THREADS || 0);
const HLS_FFMPEG_THREADS_PER_JOB_OVERRIDE = Number(process.env.HLS_FFMPEG_THREADS_PER_JOB || 0);
const HLS_THREADS_PER_JOB = (() => {
  if (HLS_FFMPEG_THREADS_PER_JOB_OVERRIDE > 0) {
    return Math.max(1, Math.floor(HLS_FFMPEG_THREADS_PER_JOB_OVERRIDE));
  }
  if (HLS_FFMPEG_THREADS_TOTAL > 0) {
    return Math.max(1, Math.floor(HLS_FFMPEG_THREADS_TOTAL / HLS_CONCURRENCY));
  }
  return 1;
})();

const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || process.env.CATFLIX_INTERNAL_KEY || '').trim();
const NOTIFY_URL = (process.env.CATFLIX_NOTIFY_URL || '').trim() || 'http://catflix-app:3004/api/media/notify';

const MEDIA_DIR = resolveMediaDir();
console.log('[encoder] Media directory:', MEDIA_DIR);
console.log('[encoder] Worker started');
console.log('[encoder] Threads per job:', HLS_THREADS_PER_JOB);

const jobs = new Map();
const resumeQueue = [];
const freshQueue = [];
const queuedKeys = new Set();
const activeJobs = new Map();
const watchers = new Map();
let activeTranscodes = 0;
let pendingRescanTimer = null;

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mkv',
  '.mov',
  '.avi',
  '.m4v',
  '.webm'
]);

scheduleInitialScan();

function scheduleInitialScan() {
  scanAndQueue('startup').catch((err) => {
    console.error('[encoder] Initial scan failed', err);
    process.exit(1);
  });
}

function scheduleRescan(reason) {
  if (pendingRescanTimer) return;
  pendingRescanTimer = setTimeout(() => {
    pendingRescanTimer = null;
    scanAndQueue(reason).catch((err) => {
      console.error('[encoder] Rescan failed', err);
    });
  }, HLS_RESCAN_DEBOUNCE_MS).unref();
}

async function scanAndQueue(reason) {
  try {
    const { discoveredJobs, watchDirs } = await discoverJobs();
    syncWatchers(watchDirs);

    const activeCopies = new Map();
    for (const [key, active] of activeJobs.entries()) {
      activeCopies.set(key, active.job);
    }

    jobs.clear();
    resumeQueue.length = 0;
    freshQueue.length = 0;
    queuedKeys.clear();

    for (const [key, activeJob] of activeCopies) {
      jobs.set(key, activeJob);
    }

    for (const job of discoveredJobs) {
      if (activeJobs.has(job.key)) {
        Object.assign(activeJobs.get(job.key).job, job);
        continue;
      }
      jobs.set(job.key, job);
      queueJob(job);
    }

    drainQueues();
  } catch (err) {
    console.error('[encoder] Scan failed', err);
  }
}

function queueJob(job) {
  if (queuedKeys.has(job.key)) return;
  if (job.nextIndex >= 0) {
    resumeQueue.push(job);
  } else {
    freshQueue.push(job);
  }
  queuedKeys.add(job.key);
}

function drainQueues() {
  while (activeTranscodes < HLS_CONCURRENCY) {
    const job = resumeQueue.shift() || freshQueue.shift();
    if (!job) break;
    queuedKeys.delete(job.key);
    startJob(job);
  }
}

async function startJob(job) {
  const descriptor = describeJob(job);
  activeTranscodes += 1;
  job.status = 'running';
  activeJobs.set(job.key, { job });

  try {
    const prep = await prepareJobEnvironment(job);
    if (prep.skip) {
      console.log(`[encoder] Skip ${descriptor}: ${prep.reason}`);
      return;
    }
    if (prep.resumeInfo) {
      job.resumeInfo = prep.resumeInfo;
    }
    if (job.resumeInfo && Number.isFinite(job.resumeInfo.seekSeconds) && job.resumeInfo.seekSeconds > 0) {
      console.log(`[encoder] Resume offset ${descriptor}: segment ${job.resumeInfo.startNumber} (~${job.resumeInfo.seekSeconds.toFixed(2)}s)`);
    }
    const ffmpegArgs = buildFfmpegArgs({ ...job, resumeInfo: job.resumeInfo || {} });
    console.log(`[encoder] Starting ${job.type}: ${descriptor}`);
    await runFfmpeg(ffmpegArgs);
    console.log(`[encoder] Completed ${job.type}: ${descriptor}`);
    await notifyManifestUpdate(job);
  } catch (err) {
    const message = (err && err.message) ? err.message.slice(-4000) : 'ffmpeg_failed';
    console.error(`[encoder] Failed ${job.type}: ${descriptor}`, message);
  } finally {
    activeTranscodes -= 1;
    activeJobs.delete(job.key);
    scheduleRescan('job-complete');
    drainQueues();
  }
}

function describeJob(job) {
  if (job.type === 'movie') {
    return job.displayName;
  }
  const season = job.seasonLabel ? `${job.seasonLabel} ` : '';
  return `${job.showTitle} ${season}- ${job.displayName}`;
}

async function prepareJobEnvironment(job) {
  const sourceExists = await pathExists(job.sourceAbsolute);
  if (!sourceExists) {
    return { skip: true, reason: 'source missing' };
  }

  const masterExists = await pathExists(job.masterAbsolute);
  if (masterExists) {
    return { skip: true, reason: 'master already present' };
  }

  await fsPromises.mkdir(job.segmentDirAbsolute, { recursive: true });

  const segments = await listSegments(job.segmentDirAbsolute, job.segmentRegex, job.baseName);
  if (segments.highestIndex >= 0) {
    const resumeInfo = buildResumeInfoFromSegments(segments);
    if (resumeInfo) {
      return { resumeInfo };
    }
  }

  await removeHlsArtifacts(job);
  return { resumeInfo: {} };
}

async function discoverJobs() {
  const watchDirs = new Set();
  watchDirs.add(MEDIA_DIR);

  const jobs = [];
  const moviesDir = path.join(MEDIA_DIR, 'movies');
  if (await pathExists(moviesDir)) {
    watchDirs.add(moviesDir);
    await collectMovieJobs(moviesDir, jobs, watchDirs);
  }

  const showsDir = path.join(MEDIA_DIR, 'shows');
  if (await pathExists(showsDir)) {
    watchDirs.add(showsDir);
    await collectShowJobs(showsDir, jobs, watchDirs);
  }

  return { discoveredJobs: jobs, watchDirs };
}

async function collectMovieJobs(root, jobList, watchDirs) {
  const entries = await safeReadDir(root);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      watchDirs.add(fullPath);
      await collectMovieJobs(fullPath, jobList, watchDirs);
      continue;
    }
    if (!entry.isFile() || !isVideoSource(entry.name)) continue;
    const job = await buildMovieJob(root, entry.name);
    if (job) {
      jobList.push(job);
    }
  }
}

async function buildMovieJob(directory, fileName) {
  const sourceAbsolute = path.join(directory, fileName);
  const sourceRelative = toPosix(path.relative(MEDIA_DIR, sourceAbsolute));
  const layout = computeHlsLayout('movie', sourceRelative, null);
  if (!layout || !layout.masterRelative) return null;

  const masterAbsolute = path.join(MEDIA_DIR, fromPosix(layout.masterRelative));
  if (await pathExists(masterAbsolute)) {
    return null;
  }

  const segmentDirAbsolute = path.join(MEDIA_DIR, fromPosix(layout.outputDirRelative || pathPosix.dirname(layout.masterRelative)));
  const segmentRegex = buildSegmentRegex(layout.segmentTemplateRelative, layout.baseName);
  const segments = await listSegments(segmentDirAbsolute, segmentRegex, layout.baseName);

  return {
    key: layout.masterRelative,
    type: 'movie',
    displayName: layout.baseName,
    sourceAbsolute,
    sourceRelative,
    masterAbsolute,
    segmentDirAbsolute,
    layout,
    segmentRegex,
    baseName: layout.baseName,
    nextIndex: segments.highestIndex
  };
}

async function collectShowJobs(root, jobList, watchDirs) {
  const showEntries = await safeReadDir(root);
  for (const showEntry of showEntries) {
    if (!showEntry.isDirectory()) continue;
    const showDir = path.join(root, showEntry.name);
    watchDirs.add(showDir);
    const seasonEntries = await safeReadDir(showDir);
    for (const seasonEntry of seasonEntries) {
      if (!seasonEntry.isDirectory()) continue;
      const seasonDir = path.join(showDir, seasonEntry.name);
      watchDirs.add(seasonDir);
      const items = await safeReadDir(seasonDir);
      for (const item of items) {
        if (!item.isFile() || !isVideoSource(item.name)) continue;
        const job = await buildEpisodeJob(showEntry.name, seasonEntry.name, seasonDir, item.name, watchDirs);
        if (job) {
          jobList.push(job);
        }
      }
    }
  }
}

async function buildEpisodeJob(showTitle, seasonLabel, seasonDir, fileName, watchDirs) {
  const sourceAbsolute = path.join(seasonDir, fileName);
  const sourceRelative = toPosix(path.relative(MEDIA_DIR, sourceAbsolute));
  const layout = computeHlsLayout('episode', sourceRelative, null);
  if (!layout || !layout.masterRelative) return null;

  const episodeDirAbsolute = path.join(MEDIA_DIR, fromPosix(layout.outputDirRelative || ''));
  if (!(await pathExists(episodeDirAbsolute))) {
    await fsPromises.mkdir(episodeDirAbsolute, { recursive: true });
  }
  watchDirs.add(episodeDirAbsolute);

  const masterAbsolute = path.join(MEDIA_DIR, fromPosix(layout.masterRelative));
  if (await pathExists(masterAbsolute)) {
    return null;
  }

  const segmentRegex = buildSegmentRegex(layout.segmentTemplateRelative, layout.baseName);
  const segments = await listSegments(episodeDirAbsolute, segmentRegex, layout.baseName);

  return {
    key: layout.masterRelative,
    type: 'episode',
    showTitle,
    seasonLabel,
    displayName: layout.baseName,
    sourceAbsolute,
    sourceRelative,
    masterAbsolute,
    segmentDirAbsolute: episodeDirAbsolute,
    layout,
    segmentRegex,
    baseName: layout.baseName,
    nextIndex: segments.highestIndex
  };
}

async function listSegments(directory, regex, baseName) {
  const names = await fsPromises.readdir(directory).catch(() => []);
  let highestIndex = -1;
  let lowestIndex = Number.POSITIVE_INFINITY;
  const seenIndices = new Set();

  for (const name of names) {
    let index = null;
    if (regex instanceof RegExp) {
      if (regex.global || regex.sticky) {
        regex.lastIndex = 0;
      }
      const match = regex.exec(name);
      if (match) {
        const groupIndex = Number.isInteger(regex.segmentIndexGroup)
          ? regex.segmentIndexGroup
          : match.length - 1;
        const value = match[groupIndex] ?? match[match.length - 1];
        if (value !== undefined) {
          index = parseInt(value, 10);
        }
      }
    } else if (baseName && name.toLowerCase().startsWith(`${baseName.toLowerCase()}_`) && name.toLowerCase().endsWith('.ts')) {
      const trailing = extractTrailingNumber(name);
      if (trailing !== null) {
        index = parseInt(trailing, 10);
      }
    }

    if (!Number.isFinite(index)) continue;
    if (seenIndices.has(index)) continue;
    seenIndices.add(index);
    if (index > highestIndex) highestIndex = index;
    if (index < lowestIndex) lowestIndex = index;
  }

  if (seenIndices.size === 0) {
    return { highestIndex: -1, lowestIndex: -1, count: 0 };
  }

  return {
    highestIndex,
    lowestIndex: lowestIndex === Number.POSITIVE_INFINITY ? -1 : lowestIndex,
    count: seenIndices.size
  };
}

function buildResumeInfoFromSegments(segments) {
  if (!segments || typeof segments.highestIndex !== 'number' || segments.highestIndex < 0) {
    return null;
  }
  const highestIndex = segments.highestIndex;
  const lowestIndex = typeof segments.lowestIndex === 'number' && segments.lowestIndex >= 0
    ? segments.lowestIndex
    : 0;
  const contiguousCount = highestIndex >= lowestIndex ? (highestIndex - lowestIndex + 1) : 0;
  const segmentCount = Math.max(
    0,
    Number.isFinite(segments.count) ? segments.count : 0,
    contiguousCount
  );
  const resumeInfo = {
    appendList: true,
    startNumber: highestIndex + 1
  };
  const seekSeconds = segmentCount * HLS_SEGMENT_DURATION;
  if (Number.isFinite(seekSeconds) && seekSeconds > 0) {
    resumeInfo.seekSeconds = seekSeconds;
    resumeInfo.discontStart = true;
  }
  return resumeInfo;
}

function extractTrailingNumber(name) {
  const m = name.match(/(\d+)(?=\.[^.]+$)/);
  return m ? m[1] : null;
}

async function removeHlsArtifacts(job) {
  const masterFileName = pathPosix.basename(job.layout.masterRelative || '');
  const variantFileName = job.layout.variantTemplateRelative
    ? pathPosix.basename(formatTemplate(job.layout.variantTemplateRelative, job.baseName))
    : null;
  const names = await fsPromises.readdir(job.segmentDirAbsolute).catch(() => []);
  await Promise.all(names.map(async (name) => {
    const target = path.join(job.segmentDirAbsolute, name);
    if (name === masterFileName || (variantFileName && name === variantFileName)) {
      await fsPromises.unlink(target).catch(() => {});
      return;
    }
    if (job.segmentRegex && job.segmentRegex.test(name)) {
      await fsPromises.unlink(target).catch(() => {});
    }
  }));
}

function buildSegmentRegex(templateRelative, baseName) {
  if (!templateRelative) return null;
  const formatted = formatTemplate(templateRelative, baseName || '');
  const fileName = pathPosix.basename(formatted);
  const placeholderPattern = /%0\d+d|%d|%v/g;
  let pattern = '';
  let lastIndex = 0;
  let groupCounter = 0;
  let segmentIndexGroup = null;
  let match;

  while ((match = placeholderPattern.exec(fileName)) !== null) {
    const [placeholder] = match;
    pattern += escapeRegex(fileName.slice(lastIndex, match.index));
    pattern += '(\\d+)';
    groupCounter += 1;
    if (placeholder === '%d' || /^%0\d+d$/.test(placeholder)) {
      segmentIndexGroup = groupCounter;
    }
    lastIndex = match.index + placeholder.length;
  }

  pattern += escapeRegex(fileName.slice(lastIndex));

  if (groupCounter === 0) {
    return null;
  }

  const resolvedSegmentIndexGroup = segmentIndexGroup || groupCounter;
  const regex = new RegExp(`^${pattern}$`, 'i');
  regex.segmentIndexGroup = resolvedSegmentIndexGroup;
  return regex;
}

function syncWatchers(directories) {
  for (const dir of directories) {
    if (watchers.has(dir)) continue;
    try {
      const watcher = fs.watch(dir, { persistent: true }, () => {
        scheduleRescan(`watch:${dir}`);
      });
      watchers.set(dir, watcher);
    } catch (err) {
      console.warn('[encoder] Failed to watch directory', dir, err.message);
    }
  }

  for (const [dir, watcher] of watchers.entries()) {
    if (!directories.has(dir)) {
      watcher.close();
      watchers.delete(dir);
    }
  }
}

function isVideoSource(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) return false;
  if (fileName.endsWith('.m3u8')) return false;
  return true;
}

function formatTemplate(template, baseName) {
  if (!template) return '';
  return template.replace(/%b/g, baseName || '');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function fromPosix(p) {
  return p.split('/').join(path.sep);
}

async function pathExists(targetPath) {
  try {
    await fsPromises.access(targetPath, fs.constants.F_OK);
    return true;
  } catch (_) {
    return false;
  }
}

async function safeReadDir(target) {
  try {
    return await fsPromises.readdir(target, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[encoder] Failed to read directory', target, err.message);
    }
    return [];
  }
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

function buildFfmpegArgs(job) {
  const masterRelative = toPosix(job.layout.masterRelative || '');
  const variantTemplateRelative = toPosix(job.layout.variantTemplateRelative || '');
  const segmentTemplateRelative = toPosix(job.layout.segmentTemplateRelative || '');
  const masterFileName = masterRelative ? pathPosix.basename(masterRelative) : 'master.m3u8';
  const variantPlaylistPath = path.join(MEDIA_DIR, fromPosix(variantTemplateRelative || masterRelative || 'stream_v%v.m3u8'));
  const segmentTemplatePath = path.join(MEDIA_DIR, fromPosix(segmentTemplateRelative || 'segment_v%v_%05d.ts'));
  const resumeInfo = job.resumeInfo || {};
  const hasVariantIndexToken = typeof variantTemplateRelative === 'string' && variantTemplateRelative.includes('%v');
  const hasSegmentIndexToken = typeof segmentTemplateRelative === 'string' && segmentTemplateRelative.includes('%v');
  const useVariantStreamMap = hasVariantIndexToken || hasSegmentIndexToken;
  const bufSize = resolveBufSize(HLS_HIGH_MAX_BITRATE, HLS_HIGH_BUF_SIZE);
  const keyframeInterval = Number.isFinite(HLS_KEYFRAME_INTERVAL) && HLS_KEYFRAME_INTERVAL > 0
    ? Math.floor(HLS_KEYFRAME_INTERVAL)
    : Math.max(1, Math.round(HLS_SEGMENT_DURATION * 2));
  const filterParts = [];
  const { width, height } = parseResolution(HLS_HIGH_RESOLUTION, null);
  if (width && height) {
    filterParts.push(`scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`);
  } else if (width) {
    filterParts.push(`scale=w=${width}:h=-2:force_original_aspect_ratio=decrease:force_divisible_by=2`);
  } else if (height) {
    filterParts.push(`scale=w=-2:h=${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`);
  }
  if (filterParts.length > 0) {
    filterParts.push('setsar=1');
  }
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y'
  ];
  const resumeSeconds = Number(resumeInfo.seekSeconds);
  if (Number.isFinite(resumeSeconds) && resumeSeconds > 0) {
    args.push('-ss', formatSeekSeconds(resumeSeconds));
  }
  args.push('-i', job.sourceAbsolute);
  if (filterParts.length > 0) {
    args.push('-vf', filterParts.join(','));
  }
  args.push(
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-c:v',
    'libx264',
    '-preset',
    HLS_FFMPEG_PRESET
  );
  if (HLS_FFMPEG_TUNE) {
    args.push('-tune', HLS_FFMPEG_TUNE);
  }
  args.push(
    '-pix_fmt',
    'yuv420p',
    '-profile:v',
    'high',
    '-b:v',
    HLS_HIGH_VIDEO_BITRATE,
    '-maxrate',
    HLS_HIGH_MAX_BITRATE
  );
  if (bufSize) {
    args.push('-bufsize', bufSize);
  }
  args.push(
    '-g',
    String(keyframeInterval),
    '-keyint_min',
    String(keyframeInterval),
    '-sc_threshold',
    '0'
  );
  if (HLS_FFMPEG_THREADS) {
    args.push('-threads', String(HLS_FFMPEG_THREADS));
  }
  args.push(
    '-c:a',
    'aac'
  );
  if (HLS_HIGH_AUDIO_BITRATE) {
    args.push('-b:a', HLS_HIGH_AUDIO_BITRATE);
  }
  args.push(
    '-ac',
    String(HLS_AUDIO_CHANNELS_HIGH),
    '-hls_time',
    String(HLS_SEGMENT_DURATION),
    '-hls_playlist_type',
    HLS_PLAYLIST_TYPE,
    '-hls_segment_filename',
    toFfmpegPath(segmentTemplatePath)
  );
  if (HLS_THREADS_PER_JOB > 0) {
    args.push('-threads', String(HLS_THREADS_PER_JOB));
  }
  if (useVariantStreamMap) {
    args.push(
      '-master_pl_name',
      masterFileName,
      '-var_stream_map',
      'v:0,a:0 name:high'
    );
  }
  args.push(
    '-hls_flags',
    buildHlsFlags(resumeInfo)
  );
  if (resumeInfo.startNumber) {
    args.push('-start_number', String(resumeInfo.startNumber));
  }
  args.push(
    '-f',
    'hls',
    toFfmpegPath(variantPlaylistPath)
  );
  return args;
}

function buildHlsFlags(resumeInfo) {
  const flags = ['independent_segments'];
  if (resumeInfo.appendList) {
    flags.push('append_list');
  }
  if (resumeInfo.discontStart) {
    flags.push('discont_start');
  }
  return flags.join('+');
}

function parseResolution(value, fallbackHeight) {
  if (!value) return { width: null, height: fallbackHeight };
  const match = String(value).match(/(\d+)[x:](\d+)/i);
  if (!match) return { width: null, height: fallbackHeight };
  const width = parseInt(match[1], 10);
  const height = parseInt(match[2], 10);
  return {
    width: Number.isFinite(width) ? width : null,
    height: Number.isFinite(height) ? height : fallbackHeight
  };
}

function parseBitrateKbps(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)([kKmMgG])?$/);
  if (!match) return null;
  const numeric = parseFloat(match[1]);
  if (!Number.isFinite(numeric)) return null;
  const unit = match[2] ? match[2].toLowerCase() : 'k';
  const factor = unit === 'm' ? 1000 : 1;
  return numeric * factor;
}

function resolveBufSize(maxBitrate, override) {
  if (override) return override;
  const kbps = parseBitrateKbps(maxBitrate);
  if (!kbps) return null;
  return `${Math.round(kbps * 2)}k`;
}

function toFfmpegPath(p) {
  return p.replace(/\\/g, '/');
}

function formatSeekSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '0';
  }
  const rounded = Number(seconds);
  if (Math.abs(rounded - Math.round(rounded)) < 1e-3) {
    return String(Math.round(rounded));
  }
  return rounded.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function computeHlsLayout(type, sourceRelativePath, hlsRelativePath) {
  let masterRelative = null;
  let baseDir = null;
  let baseName = null;
  let variantTemplateRelative = null;
  let segmentTemplateRelative = null;

  const formatTemplateValue = (template, name) => {
    if (!template) return '';
    return template.replace(/%b/g, name);
  };

  const combine = (dir, relativePath) => {
    if (!relativePath) return null;
    if (relativePath.startsWith('/')) return pathPosix.normalize(relativePath);
    if (!dir || dir === '.') return pathPosix.normalize(relativePath);
    return pathPosix.normalize(pathPosix.join(dir, relativePath));
  };

  if (sourceRelativePath) {
    const sourcePosix = toPosix(sourceRelativePath);
    baseDir = pathPosix.dirname(sourcePosix);
    baseName = pathPosix.basename(sourcePosix, pathPosix.extname(sourcePosix));
  }
  if ((!baseDir || baseDir === '.') && sourceRelativePath) {
    baseDir = pathPosix.dirname(toPosix(sourceRelativePath));
  }
  if (!baseName && hlsRelativePath) {
    const hlsPosix = toPosix(hlsRelativePath);
    const hlsDir = pathPosix.dirname(hlsPosix);
    const hlsFile = pathPosix.basename(hlsPosix, pathPosix.extname(hlsPosix));
    baseDir = hlsDir;
    baseName = hlsFile;
  }
  if (!baseName || baseName.trim().length === 0) {
    baseName = 'stream';
  }
  let outputDirRelative;
  if (type === 'episode') {
    outputDirRelative = combine(baseDir, baseName);
  } else {
    outputDirRelative = baseDir && baseDir !== '.' ? baseDir : '';
  }
  const targetDir = outputDirRelative && outputDirRelative !== '.' ? outputDirRelative : '';
  masterRelative = combine(targetDir, formatTemplateValue(HLS_MASTER_PLAYLIST_NAME, baseName));
  variantTemplateRelative = combine(targetDir, formatTemplateValue(HLS_VARIANT_PLAYLIST_TEMPLATE, baseName));
  segmentTemplateRelative = combine(targetDir, formatTemplateValue(HLS_SEGMENT_TEMPLATE, baseName));
  return {
    masterRelative,
    outputDirRelative,
    baseDir: outputDirRelative,
    baseName,
    variantTemplateRelative,
    segmentTemplateRelative
  };
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG_PATH, args, { stdio: 'inherit' });
    ff.on('error', (err) => reject(err));
    ff.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}

async function notifyManifestUpdate(job) {
  if (!NOTIFY_URL) return;
  const layout = job.layout || {};
  const masterRelative = layout.masterRelative ? toPosix(layout.masterRelative) : null;
  if (!masterRelative) return;
  const payload = {
    type: job.type,
    masterRelative,
    descriptor: job.displayName || layout.baseName || job.baseName || 'stream'
  };
  if (job.type === 'movie') {
    payload.movieTitle = job.displayName || layout.baseName || job.baseName;
  } else {
    payload.showTitle = job.showTitle || layout.showTitle;
    payload.seasonLabel = job.seasonLabel || layout.seasonLabel;
    payload.episodeTitle = job.displayName || layout.baseName || job.baseName;
    if (Number.isFinite(job.episodeNumber)) {
      payload.episodeNumber = job.episodeNumber;
    }
  }
  try {
    const res = await fetch(NOTIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_API_KEY ? { 'x-internal-key': INTERNAL_API_KEY } : {})
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn('[encoder] manifest notify failed', res.status, text);
    }
  } catch (err) {
    console.warn('[encoder] manifest notify error', err.message || err);
  }
}

process.on('SIGINT', () => {
  for (const watcher of watchers.values()) {
    watcher.close();
  }
  process.exit(0);
});
