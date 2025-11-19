const express = require('express');
const axios = require('axios');
const { pool } = require('../db');
const router = express.Router();

const SUBTITLE_SERVICE_URL = process.env.SUBTITLE_SERVICE_URL || 'http://catflix-subtitles:3006';

/**
 * Parse video src to extract relative path
 * Frontend sends: /videos/movies/Movie%20Name/Movie%20Name.m3u8
 * We need: movies/Movie Name/Movie Name.m3u8
 */
function parseVideoSrc(src) {
  try {
    // Remove /videos/ prefix and decode
    const decoded = decodeURIComponent(src);
    const relativePath = decoded.replace(/^\/videos\//, '');
    return relativePath;
  } catch (err) {
    console.error('[subtitles] Error parsing video src:', err);
    return null;
  }
}

/**
 * Find entry ID from manifest by relative path
 */
async function findEntryIdByPath(relativePath) {
  try {
    // Try movies first
    const movieResult = await pool.query(`
      SELECT 
        (part->>'id')::BIGINT AS entry_id,
        'movie' AS entity_type
      FROM media_manifest_entries mme
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(mme.payload->'parts', '[]'::jsonb)) part
      WHERE mme.entity_type = 'movie'
        AND part->>'relative' = $1
      LIMIT 1
    `, [relativePath]);

    if (movieResult.rows.length > 0) {
      return {
        entryId: movieResult.rows[0].entry_id,
        entityType: 'movie'
      };
    }

    // Try episodes
    const episodeResult = await pool.query(`
      SELECT 
        (episode->>'id')::BIGINT AS entry_id,
        'episode' AS entity_type
      FROM media_manifest_entries mme
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(mme.payload->'seasons', '[]'::jsonb)) season
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(season->'episodes', '[]'::jsonb)) episode
      WHERE mme.entity_type = 'show'
        AND episode->>'relative' = $1
      LIMIT 1
    `, [relativePath]);

    if (episodeResult.rows.length > 0) {
      return {
        entryId: episodeResult.rows[0].entry_id,
        entityType: 'episode'
      };
    }

    return null;
  } catch (err) {
    console.error('[subtitles] Database error:', err);
    return null;
  }
}

/**
 * GET/HEAD /api/subtitles?src=<video_src>
 * Proxy to subtitle service, converting video src to entry ID
 * HEAD is used to check if subtitle exists without downloading it
 */
const handleSubtitleRequest = async (req, res) => {
  try {
    const { src } = req.query;

    if (!src) {
      return res.status(400).json({ error: 'Missing src parameter' });
    }

    // Parse src to get relative path
    const relativePath = parseVideoSrc(src);
    if (!relativePath) {
      return res.status(400).json({ error: 'Invalid src format' });
    }

    // Find entry ID from manifest
    const entry = await findEntryIdByPath(relativePath);
    if (!entry) {
      // No subtitle available (might not be generated yet)
      return res.status(404).json({ error: 'Subtitle not found' });
    }

    // Proxy request to subtitle service VTT endpoint
    const subtitleUrl = `${SUBTITLE_SERVICE_URL}/api/subtitles/${entry.entityType}/${entry.entryId}/vtt`;
    
    try {
      const response = await axios.get(subtitleUrl, {
        responseType: 'text',
        timeout: 5000
      });

      // Return VTT file with proper headers
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(response.data);
    } catch (proxyErr) {
      if (proxyErr.response?.status === 404) {
        return res.status(404).json({ error: 'Subtitle not found' });
      }
      throw proxyErr;
    }
  } catch (error) {
    console.error('[subtitles] Error fetching subtitle:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

router.get('/', handleSubtitleRequest);
router.head('/', handleSubtitleRequest);

module.exports = router;

