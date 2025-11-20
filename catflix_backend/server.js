const express = require('express');
const http = require('http');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const config = require('./src/config');
const { schemaReady } = require('./src/db');
const remuxUtils = require('./src/utils/remux');
const authRoutes = require('./src/routes/auth');
const mediaRoutes = require('./src/routes/media');
const downloadRoutes = require('./src/routes/downloads');
const subtitleRoutes = require('./src/routes/subtitles');
const mediaCache = require('./src/services/mediaCache');
const { setupManifestSocket, setSnapshotProvider } = require('./src/services/manifestEvents');

const app = express();
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

remuxUtils.ensureCacheDir()
  .then(() => remuxUtils.wipeCacheDir())
  .then(() => {
    console.log('[remux] cache ready at', config.REMUX_CACHE_DIR);
  })
  .catch((err) => {
    console.error('[remux] Failed to prepare cache directory', err);
  });

const cleanupTimer = setInterval(() => {
  remuxUtils.cleanupExpiredSessions().catch((err) => {
    console.error('[remux] cleanup failed', err);
  });
}, config.REMUX_CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

process.on('exit', () => {
  clearInterval(cleanupTimer);
});

app.use('/auth', authRoutes);

app.use((req, res, next) => {
  if (req.path === '/auth/login' || (req.path === '/auth/login' && req.method === 'POST')) {
    return next();
  }
  if (
    config.INTERNAL_API_KEY &&
    req.headers['x-internal-key'] &&
    req.headers['x-internal-key'] === config.INTERNAL_API_KEY
  ) {
    return next();
  }
  if (req.cookies && req.cookies.loggedIn === '1') {
    return next();
  }
  return res.redirect('/auth/login');
});

app.use('/api', mediaRoutes);
app.use('/api/downloads', downloadRoutes);
app.use('/api/subtitles', subtitleRoutes);

// Live remux service for Samsung Browser and Apple devices
const liveRemux = require('./services/liveRemux');

app.use('/videos', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  if (req.path.toLowerCase().endsWith('.m3u8')) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  } else if (req.path.toLowerCase().endsWith('.ts')) {
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (req.path.toLowerCase().endsWith('.m4s') || req.path.toLowerCase().endsWith('.mp4')) {
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  
  next();
});

// Live remux middleware - intercepts requests with remux=fmp4 parameter
app.use('/videos', async (req, res, next) => {
  const needsRemux = req.query.remux === 'fmp4';
  
  if (!needsRemux) {
    return next();
  }
  
  const path = require('path');
  const fs = require('fs').promises;
  const filePath = path.join(config.MEDIA_DIR, req.path);
  
  try {
    // Handle .m3u8 playlist requests
    if (req.path.toLowerCase().endsWith('.m3u8')) {
      const originalContent = await fs.readFile(filePath, 'utf8');
      const convertedPlaylist = await liveRemux.convertPlaylist(filePath, originalContent);
      
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      return res.send(convertedPlaylist);
    }
    
    // Handle init segment requests (generated from first .ts segment)
    if (req.path.toLowerCase().endsWith('_init.mp4')) {
      // Find the first .ts segment in the same directory
      const dirPath = path.dirname(filePath);
      const baseName = path.basename(req.path, '_init.mp4');
      const files = await fs.readdir(dirPath);
      
      // Find first segment (usually ends with _00000.ts or similar)
      const firstSegment = files
        .filter(f => f.startsWith(baseName) && f.endsWith('.ts'))
        .sort()[0];
      
      if (!firstSegment) {
        return res.status(404).send('Init segment source not found');
      }
      
      const firstSegmentPath = path.join(dirPath, firstSegment);
      const initSegment = await liveRemux.generateInitSegment(firstSegmentPath);
      
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.send(initSegment);
    }
    
    // Handle .m4s segment requests (remux from .ts on-the-fly)
    if (req.path.toLowerCase().endsWith('.m4s')) {
      // Convert .m4s path back to .ts path
      const tsPath = filePath.replace(/\.m4s$/i, '.ts');
      
      // Check if .ts file exists
      try {
        await fs.access(tsPath);
      } catch {
        return res.status(404).send('Source segment not found');
      }
      
      const remuxedSegment = await liveRemux.remuxSegment(tsPath);
      
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.send(remuxedSegment);
    }
    
    // For other files, pass through
    next();
  } catch (err) {
    console.error('[liveRemux] Error:', err);
    return res.status(500).send('Remux error');
  }
});

app.use('/videos', express.static(config.MEDIA_DIR));

const server = http.createServer(app);
setSnapshotProvider(() => mediaCache.getMediaCache());
setupManifestSocket(server);

if (fs.existsSync(config.CLIENT_BUILD_DIR)) {
  app.use(express.static(config.CLIENT_BUILD_DIR));
  app.use((req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(`${config.CLIENT_BUILD_DIR}/index.html`);
  });
} else {
  app.get('/', (_req, res) => {
    res.send('Catflix backend running (no frontend build found).');
  });
  app.use((req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
    res.redirect('/');
  });
}

async function startServer() {
  try {
    await schemaReady;
  } catch (err) {
    console.error('[startup] Database schema initialisation failed', err);
    process.exit(1);
  }

  server.listen(config.PORT, async () => {
    console.log(`Catflix backend listening on port ${config.PORT}`);
    console.log(`[config] Media directory: ${config.MEDIA_DIR}`);
    mediaCache
      .refreshMediaCache('startup', { background: true })
      .catch((err) => {
        console.error('[media-cache] Startup refresh failed', err);
      });
  });
}

startServer();
