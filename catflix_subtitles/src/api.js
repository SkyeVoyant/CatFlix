const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const config = require('./config');
const db = require('./db');
const { convertToVTT } = require('./vttConverter');

const router = express.Router();

async function loadSubtitle(entityType, entryId) {
  const record = await db.getSubtitleRecord(entityType, entryId);
  if (!record || !record.subtitle_path) {
    return null;
  }
  const fullPath = path.join(config.SUBTITLES_DIR, record.subtitle_path);
  const raw = await fs.readFile(fullPath, 'utf-8');
  return JSON.parse(raw);
}

async function getSubtitlePath(entityType, entryId) {
  const record = await db.getSubtitleRecord(entityType, entryId);
  if (!record || !record.subtitle_path) return null;
  const fullPath = path.join(config.SUBTITLES_DIR, record.subtitle_path);
  try {
    await fs.access(fullPath);
    return record.subtitle_path;
  } catch {
    return null;
  }
}

function parseEntryId(value) {
  const entryId = parseInt(value, 10);
  if (Number.isNaN(entryId)) return null;
  return entryId;
}

router.get('/movie/:entryId', async (req, res) => {
  try {
    const entryId = parseEntryId(req.params.entryId);
    if (entryId === null) {
      return res.status(400).json({ error: 'Invalid movie entry ID' });
    }

    const subtitle = await loadSubtitle('movie', entryId);
    if (!subtitle) {
      return res.status(404).json({ error: 'Subtitle not found' });
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.json(subtitle);
  } catch (error) {
    console.error('[api] Error getting movie subtitle:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/episode/:entryId', async (req, res) => {
  try {
    const entryId = parseEntryId(req.params.entryId);
    if (entryId === null) {
      return res.status(400).json({ error: 'Invalid episode entry ID' });
    }

    const subtitle = await loadSubtitle('episode', entryId);
    if (!subtitle) {
      return res.status(404).json({ error: 'Subtitle not found' });
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.json(subtitle);
  } catch (error) {
    console.error('[api] Error getting episode subtitle:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/status/movie/:entryId', async (req, res) => {
  try {
    const entryId = parseEntryId(req.params.entryId);
    if (entryId === null) {
      return res.status(400).json({ error: 'Invalid movie entry ID' });
    }

    const subtitlePath = await getSubtitlePath('movie', entryId);
    if (!subtitlePath) {
      return res.json({ status: 'not_found' });
    }
    return res.json({ status: 'ready', path: subtitlePath });
  } catch (error) {
    console.error('[api] Error checking movie subtitle status:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/status/episode/:entryId', async (req, res) => {
  try {
    const entryId = parseEntryId(req.params.entryId);
    if (entryId === null) {
      return res.status(400).json({ error: 'Invalid episode entry ID' });
    }

    const subtitlePath = await getSubtitlePath('episode', entryId);
    if (!subtitlePath) {
      return res.json({ status: 'not_found' });
    }
    return res.json({ status: 'ready', path: subtitlePath });
  } catch (error) {
    console.error('[api] Error checking episode subtitle status:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// WebVTT endpoints for browser compatibility
router.get('/movie/:entryId/vtt', async (req, res) => {
  try {
    const entryId = parseEntryId(req.params.entryId);
    if (entryId === null) {
      return res.status(400).send('Invalid movie entry ID');
    }

    const subtitle = await loadSubtitle('movie', entryId);
    if (!subtitle) {
      return res.status(404).send('Subtitle not found');
    }

    const vtt = convertToVTT(subtitle);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(vtt);
  } catch (error) {
    console.error('[api] Error converting movie subtitle to VTT:', error);
    return res.status(500).send('Internal server error');
  }
});

router.get('/episode/:entryId/vtt', async (req, res) => {
  try {
    const entryId = parseEntryId(req.params.entryId);
    if (entryId === null) {
      return res.status(400).send('Invalid episode entry ID');
    }

    const subtitle = await loadSubtitle('episode', entryId);
    if (!subtitle) {
      return res.status(404).send('Subtitle not found');
    }

    const vtt = convertToVTT(subtitle);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(vtt);
  } catch (error) {
    console.error('[api] Error converting episode subtitle to VTT:', error);
    return res.status(500).send('Internal server error');
  }
});

module.exports = router;

