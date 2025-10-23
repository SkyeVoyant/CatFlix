const express = require('express');
const path = require('path');
const config = require('../config');
const { pool } = require('../db');
const { ensureRemuxedFile, streamRemuxResult } = require('../utils/remux');
const { getMediaCache } = require('../services/mediaCache');
const { toPosix, fromPosix } = require('../utils/path');
const { pathExists } = require('../utils/fs');

const router = express.Router();

function formatEpisodeDescriptor(row) {
  const showTitle = (row.show_title || 'Show').trim();
  const seasonLabel = (row.season_label || '').trim();
  const fallbackEpisodeId = row.episode_id || row.id;
  const episodeTitle = (row.display_name || (fallbackEpisodeId ? `Episode-${fallbackEpisodeId}` : 'Episode')).trim();
  return [showTitle, seasonLabel, episodeTitle].filter(Boolean).join(' ');
}

function sanitizeRelativePath(candidate) {
  if (!candidate) return null;
  const posix = toPosix(String(candidate).trim());
  const cleaned = posix.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  return cleaned.length > 0 ? cleaned : null;
}

function sanitizeCacheKey(input) {
  return String(input || '')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .slice(0, 120);
}

async function resolveExistingRelative(...candidates) {
  for (const candidate of candidates) {
    const relative = sanitizeRelativePath(candidate);
    if (!relative) continue;
    const absolute = path.join(config.MEDIA_DIR, fromPosix(relative));
    if (await pathExists(absolute)) {
      return relative;
    }
  }
  return null;
}

function extractRelativeFromSrc(src) {
  if (!src || typeof src !== 'string') return null;
  const prefix = '/videos/';
  if (!src.startsWith(prefix)) return null;
  try {
    return src
      .slice(prefix.length)
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch (_) {
    return src.slice(prefix.length);
  }
}

function normalizeTitle(value) {
  return (value || '').trim().toLowerCase();
}

function identifiersMatch(candidate, ...comparisons) {
  if (candidate == null) return false;
  const candidateStr = String(candidate);
  for (const comp of comparisons) {
    if (comp == null) continue;
    if (candidateStr === String(comp)) {
      return true;
    }
  }
  return false;
}

function findMovieByIdOrIndex(manifest, candidate) {
  const movies = manifest.movies || [];
  const match = movies.find((movie) => identifiersMatch(movie.id, candidate));
  if (match) return match;
  const idx = Number(candidate);
  if (Number.isInteger(idx) && idx >= 0 && idx < movies.length) {
    return movies[idx];
  }
  return null;
}

function findShowByIdOrIndex(manifest, candidate) {
  const shows = manifest.shows || [];
  const match = shows.find((show) => identifiersMatch(show.id, candidate));
  if (match) return match;
  const idx = Number(candidate);
  if (Number.isInteger(idx) && idx >= 0 && idx < shows.length) {
    return shows[idx];
  }
  return null;
}

function findSeasonByIdOrIndex(show, candidate) {
  const seasons = show?.seasons || [];
  const match = seasons.find((season) => identifiersMatch(season.id, candidate));
  if (match) return match;
  const idx = Number(candidate);
  if (Number.isInteger(idx) && idx >= 0 && idx < seasons.length) {
    return seasons[idx];
  }
  return null;
}

async function findMovieInManifest({ requestId, dbMovieId, movieTitle }) {
  const manifest = await getMediaCache();
  const movie =
    findMovieByIdOrIndex(manifest, dbMovieId) ||
    findMovieByIdOrIndex(manifest, requestId);
  if (movie) return movie;
  const normalizedTitle = normalizeTitle(movieTitle);
  if (!normalizedTitle) return null;
  return (manifest.movies || []).find(
    (item) => normalizeTitle(item.title) === normalizedTitle
  ) || null;
}

async function findEpisodeInManifest({ requestId, dbEpisodeId }) {
  const manifest = await getMediaCache();
  const candidates = [requestId, dbEpisodeId].filter((v) => v != null);
  if (candidates.length === 0) return null;
  const candidateStrs = candidates.map((v) => String(v));
  for (const show of manifest.shows || []) {
    for (const season of show.seasons || []) {
      for (const episode of season.episodes || []) {
        if (episode.id != null && candidateStrs.includes(String(episode.id))) {
          return { show, season, episode };
        }
      }
    }
  }
  return null;
}

async function fetchMovieDownloadJob(movieIdParam) {
  const numericId = Number(movieIdParam);
  let row = null;
  if (Number.isFinite(numericId)) {
    const { rows } = await pool.query(
      `SELECT m.id AS movie_id, m.title AS movie_title, mf.id AS file_id, mf.display_name, mf.relative_path, mf.hls_path
       FROM movie_files mf
       JOIN movies m ON m.id = mf.movie_id
       WHERE m.id = $1
       ORDER BY mf.display_name ASC
       LIMIT 1`,
      [numericId]
    );
    row = rows[0] || null;
  }

  const resolvedRelative = await resolveExistingRelative(
    row?.hls_path,
    row?.relative_path && String(row.relative_path).toLowerCase().endsWith('.m3u8') ? row.relative_path : null
  );
  let descriptor = row?.display_name || row?.movie_title || null;
  let sourceRelative = sanitizeRelativePath(row?.relative_path);
  let cacheKeyBase = row?.file_id != null ? `movie-${row.file_id}` : null;

  if (!resolvedRelative) {
    const movie = await findMovieInManifest({ requestId: movieIdParam, dbMovieId: row?.movie_id, movieTitle: row?.movie_title });
    if (movie) {
      const part = (movie.parts || [])[0];
      const partRelative = part?.relative || extractRelativeFromSrc(part?.src);
      if (partRelative) {
        descriptor = descriptor || part?.title || movie.title;
        cacheKeyBase = cacheKeyBase || `movie-${sanitizeCacheKey(partRelative)}`;
        return {
          job: {
            type: 'movie',
            descriptor: descriptor || `movie-${movieIdParam}`,
            sourceRelative,
            hlsRelative: partRelative,
            cacheKey: cacheKeyBase
          },
          descriptor: descriptor || movie.title || `movie-${movieIdParam}`
        };
      }
    }
  }

  if (!resolvedRelative) {
    return null;
  }

  descriptor = descriptor || `movie-${row?.movie_id ?? movieIdParam}`;
  cacheKeyBase = cacheKeyBase || `movie-${sanitizeCacheKey(resolvedRelative)}`;
  return {
    job: {
      type: 'movie',
      descriptor,
      sourceRelative,
      hlsRelative: resolvedRelative,
      cacheKey: cacheKeyBase
    },
    descriptor
  };
}

async function fetchEpisodeDownloadJob(episodeIdParam) {
  const numericId = Number(episodeIdParam);
  let row = null;
  if (Number.isFinite(numericId)) {
    const { rows } = await pool.query(
      `SELECT e.id AS episode_id, e.display_name, e.relative_path, e.hls_path,
              s.season_label, sh.title AS show_title
       FROM episodes e
       JOIN seasons s ON s.id = e.season_id
       JOIN shows sh ON sh.id = s.show_id
       WHERE e.id = $1
       LIMIT 1`,
      [numericId]
    );
    row = rows[0] || null;
  }

  const resolvedRelative = await resolveExistingRelative(
    row?.hls_path,
    row?.relative_path && String(row.relative_path).toLowerCase().endsWith('.m3u8') ? row.relative_path : null
  );
  let descriptor = row ? formatEpisodeDescriptor(row) : null;
  let sourceRelative = sanitizeRelativePath(row?.relative_path);
  let cacheKeyBase = row?.episode_id != null ? `episode-${row.episode_id}` : null;

  if (!resolvedRelative) {
    const manifestMatch = await findEpisodeInManifest({ requestId: episodeIdParam, dbEpisodeId: row?.episode_id });
    if (manifestMatch?.episode) {
      const episode = manifestMatch.episode;
      const relFromManifest = episode.relative || extractRelativeFromSrc(episode.src);
      if (relFromManifest) {
        descriptor = descriptor || `${manifestMatch.show?.title || 'Show'} ${manifestMatch.season?.season || ''} ${episode.title || ''}`.trim() || `episode-${episodeIdParam}`;
        cacheKeyBase = cacheKeyBase || `episode-${sanitizeCacheKey(relFromManifest)}`;
        return {
          job: {
            type: 'episode',
            descriptor,
            sourceRelative,
            hlsRelative: relFromManifest,
            cacheKey: cacheKeyBase
          },
          descriptor
        };
      }
    }
  }

  if (!resolvedRelative) {
    return null;
  }

  descriptor = descriptor || `episode-${row?.episode_id ?? episodeIdParam}`;
  cacheKeyBase = cacheKeyBase || `episode-${sanitizeCacheKey(resolvedRelative)}`;
  return {
    job: {
      type: 'episode',
      descriptor,
      sourceRelative,
      hlsRelative: resolvedRelative,
      cacheKey: cacheKeyBase
    },
    descriptor
  };
}

async function fetchSeasonEpisodeDescriptors(showId, seasonId) {
  const { rows } = await pool.query(
    `SELECT e.id AS episode_id, e.display_name, e.relative_path, e.hls_path,
            s.season_label, sh.title AS show_title, sh.id AS show_id
     FROM episodes e
     JOIN seasons s ON s.id = e.season_id
     JOIN shows sh ON sh.id = s.show_id
     WHERE sh.id = $1 AND s.id = $2
     ORDER BY e.episode_number NULLS LAST, e.display_name ASC`,
    [showId, seasonId]
  );
  if (rows.length > 0) {
    return rows.map((row) => ({
      id: row.episode_id,
      descriptor: formatEpisodeDescriptor(row)
    }));
  }

  const manifest = await getMediaCache();
  const show = findShowByIdOrIndex(manifest, showId);
  if (!show) return [];
  const season = findSeasonByIdOrIndex(show, seasonId);
  if (!season) return [];
  return (season.episodes || [])
    .filter((episode) => episode.id != null)
    .map((episode) => ({
      id: episode.id,
      descriptor:
        `${show.title} ${season.season} ${episode.title}`.trim() ||
        episode.title ||
        `Episode-${episode.id}`
    }));
}

router.post('/movies/:movieId/prepare', async (req, res) => {
  try {
    const movieId = Number(req.params.movieId);
    if (!Number.isFinite(movieId)) {
      return res.status(400).json({ error: 'Invalid movie identifier' });
    }
    const result = await fetchMovieDownloadJob(movieId);
    if (!result) {
      return res.status(404).json({ error: 'Movie not found or unavailable for download' });
    }
    await ensureRemuxedFile(result.job);
    return res.json({ status: 'ready' });
  } catch (err) {
    console.error('[download movie prepare] failed', err);
    return res.status(500).json({ error: 'Failed to prepare movie download' });
  }
});

router.get('/movies/:movieId/file', async (req, res) => {
  try {
    const movieId = Number(req.params.movieId);
    if (!Number.isFinite(movieId)) {
      return res.status(400).json({ error: 'Invalid movie identifier' });
    }
    const result = await fetchMovieDownloadJob(movieId);
    if (!result) {
      return res.status(404).json({ error: 'Movie not found or unavailable for download' });
    }
    const remuxInfo = await ensureRemuxedFile(result.job);
    await streamRemuxResult(res, remuxInfo, { deleteAfter: true });
  } catch (err) {
    console.error('[download movie file] failed', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to stream movie download' });
    } else {
      res.end();
    }
  }
});

router.post('/shows/:showId/seasons/:seasonId/request', async (req, res) => {
  try {
    const showId = Number(req.params.showId);
    const seasonId = Number(req.params.seasonId);
    if (!Number.isFinite(showId) || !Number.isFinite(seasonId)) {
      return res.status(400).json({ error: 'Invalid identifiers' });
    }
    const episodes = await fetchSeasonEpisodeDescriptors(showId, seasonId);
    if (!episodes.length) {
      return res.status(404).json({ error: 'Season not found or has no downloadable episodes' });
    }
    return res.json({ episodes });
  } catch (err) {
    console.error('[download season request] failed', err);
    return res.status(500).json({ error: 'Failed to prepare season download manifest' });
  }
});

router.post('/episodes/:episodeId/prepare', async (req, res) => {
  try {
    const episodeId = Number(req.params.episodeId);
    if (!Number.isFinite(episodeId)) {
      return res.status(400).json({ error: 'Invalid episode identifier' });
    }
    const result = await fetchEpisodeDownloadJob(episodeId);
    if (!result) {
      return res.status(404).json({ error: 'Episode not found or unavailable for download' });
    }
    await ensureRemuxedFile(result.job);
    return res.json({ status: 'ready' });
  } catch (err) {
    console.error('[download episode prepare] failed', err);
    return res.status(500).json({ error: 'Failed to prepare episode download' });
  }
});

router.get('/episodes/:episodeId/file', async (req, res) => {
  try {
    const episodeId = Number(req.params.episodeId);
    if (!Number.isFinite(episodeId)) {
      return res.status(400).json({ error: 'Invalid episode identifier' });
    }
    const result = await fetchEpisodeDownloadJob(episodeId);
    if (!result) {
      return res.status(404).json({ error: 'Episode not found or unavailable for download' });
    }
    const remuxInfo = await ensureRemuxedFile(result.job);
    await streamRemuxResult(res, remuxInfo, { deleteAfter: true });
  } catch (err) {
    console.error('[download episode file] failed', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to stream episode download' });
    } else {
      res.end();
    }
  }
});

module.exports = router;
