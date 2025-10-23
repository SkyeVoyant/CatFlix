const express = require('express');
const router = express.Router();
const {
  getMediaCache,
  fetchMetadata,
  getCacheInfo,
  registerMediaAsset
} = require('../services/mediaCache');

router.get('/media', async (_req, res) => {
  try {
    const media = await getMediaCache();
    const info = getCacheInfo();
    res.json({
      lastUpdatedAt: info.lastUpdatedAt,
      ...media
    });
  } catch (err) {
    console.error('[api/media] Failed to load media cache', err);
    res.status(500).json({ error: 'Failed to load media list' });
  }
});

router.post('/media/notify', async (req, res) => {
  const {
    type,
    masterRelative,
    descriptor,
    movieTitle,
    showTitle,
    seasonLabel,
    episodeTitle
  } = req.body || {};

  if (!type || !masterRelative) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const result = await registerMediaAsset({
      type,
      masterRelative,
      descriptor,
      movieTitle,
      showTitle,
      seasonLabel,
      episodeTitle
    });
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'Failed to register asset' });
    }
    res.json({ ok: true, ...getCacheInfo() });
  } catch (err) {
    console.error('[api/media notify] failed', err);
    res.status(500).json({ error: 'Failed to register asset' });
  }
});

router.get('/metadata', async (req, res) => {
  const title = (req.query.title || '').trim();
  const typeParam = (req.query.type || '').toLowerCase();
  const type = typeParam === 'tv' || typeParam === 'show' ? 'show' : 'movie';
  if (!title) {
    return res.status(400).json({ error: 'Missing title parameter' });
  }
  try {
    const metadata = await fetchMetadata(title, type);
    if (!metadata) {
      return res.status(404).json({ error: 'Metadata not found' });
    }
    return res.json(metadata);
  } catch (err) {
    console.error('[api/metadata] Failed', err);
    return res.status(500).json({ error: 'Failed to fetch metadata' });
  }
});

module.exports = router;
