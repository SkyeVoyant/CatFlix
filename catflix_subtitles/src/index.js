const express = require('express');
const config = require('./config');
const db = require('./db');
const processor = require('./processor');
const apiRouter = require('./api');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS headers (for frontend requests)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// API routes
app.use('/api/subtitles', apiRouter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'catflix-subtitles' });
});

// Start server and processing
async function start() {
  try {
    // Ensure database schema is ready
    console.log('[index] Ensuring database schema...');
    await db.ensureSchema();
    
    // Start Express server
    app.listen(config.PORT, () => {
      console.log(`[index] Subtitle service API listening on port ${config.PORT}`);
    });
    
    // Start the processing loop
    console.log('[index] Starting subtitle processor...');
    processor.start();
    
  } catch (error) {
    console.error('[index] Failed to start service:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[index] SIGTERM received, shutting down gracefully...');
  processor.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[index] SIGINT received, shutting down gracefully...');
  processor.stop();
  process.exit(0);
});

// Start the service
start();

