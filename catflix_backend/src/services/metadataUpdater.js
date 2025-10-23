const fetch = require('node-fetch');
const config = require('../config');
const { pool } = require('../db');

let getMediaCacheFn = null;

function setGetMediaCache(fn) {
  getMediaCacheFn = fn;
}

const TMDB_API_KEY = process.env.TMDB_API_KEY || config.TMDB_API_KEY;
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const LANGUAGE = process.env.TMDB_LANGUAGE || 'en-US';
const RATE_LIMIT_MS = Number(process.env.TMDB_RATE_LIMIT_MS || 1000);
const MAX_RETRIES = 3;

let lastFetchAt = 0;

async function tmdbFetch(path, params = {}) {
  if (!TMDB_API_KEY) {
    throw new Error('TMDB API key is not configured');
  }
  const now = Date.now();
  const waitFor = lastFetchAt + RATE_LIMIT_MS - now;
  if (waitFor > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitFor));
  }
  const url = new URL(`${TMDB_BASE_URL}/${path}`);
  url.searchParams.set('api_key', TMDB_API_KEY);
  url.searchParams.set('language', LANGUAGE);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') {
      url.searchParams.set(key, value);
    }
  }
  lastFetchAt = Date.now();
  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TMDB request failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function tmdbFetchWithRetry(path, params) {
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      return await tmdbFetch(path, params);
    } catch (err) {
      attempt += 1;
      if (attempt >= MAX_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS * attempt));
    }
  }
  return null;
}

async function fetchMovieMetadata(title) {
  const search = await tmdbFetchWithRetry('search/movie', { query: title, include_adult: 'false' });
  const match = search?.results?.[0];
  if (!match) return null;
  const details = await tmdbFetchWithRetry(`movie/${match.id}`, { append_to_response: 'videos,release_dates,credits' });
  return details || null;
}

async function fetchShowMetadata(title) {
  const search = await tmdbFetchWithRetry('search/tv', { query: title, include_adult: 'false' });
  const match = search?.results?.[0];
  if (!match) return null;
  const details = await tmdbFetchWithRetry(`tv/${match.id}`, { append_to_response: 'videos,content_ratings,credits' });
  return details || null;
}

async function upsertMetadata({ table, title, metadata }) {
  if (!metadata) return;
  await pool.query(
    `INSERT INTO ${table} (title, metadata)
     VALUES ($1, $2)
     ON CONFLICT (title)
     DO UPDATE SET metadata = EXCLUDED.metadata`,
    [title, metadata]
  );
}

function buildImageUrl(path, size = 'w500') {
  if (!path) return null;
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

function extractTrailerUrls(videos, mode = 'watch') {
  const results = [];
  for (const video of videos?.results || []) {
    if (video.site !== 'YouTube' || !video.key) continue;
    if (video.type !== 'Trailer') continue;
    const url = mode === 'embed'
      ? `https://www.youtube.com/embed/${video.key}`
      : `https://www.youtube.com/watch?v=${video.key}`;
    results.push(url);
  }
  return results;
}

function mapContentRatingsToReleaseDates(contentRatings) {
  const results = (contentRatings?.results || []).map((rating) => ({
    iso_3166_1: rating.iso_3166_1,
    release_dates: [
      {
        certification: rating.rating || '',
        note: rating.descriptor || null,
        release_date: null,
        type: null,
        iso_639_1: ''
      }
    ]
  }));
  return results.length > 0 ? { results } : null;
}

function normalizeMovieMetadata(details) {
  if (!details) return null;
  const normalized = { ...details };
  normalized.poster_path = buildImageUrl(details.poster_path, 'w500');
  normalized.backdrop_path = buildImageUrl(details.backdrop_path, 'original');
  if (details.belongs_to_collection) {
    normalized.belongs_to_collection = {
      ...details.belongs_to_collection,
      poster_path: buildImageUrl(details.belongs_to_collection.poster_path, 'w500'),
      backdrop_path: buildImageUrl(details.belongs_to_collection.backdrop_path, 'original')
    };
  }
  const trailerWatches = extractTrailerUrls(details.videos, 'watch');
  const trailerEmbeds = extractTrailerUrls(details.videos, 'embed');
  normalized.trailers = trailerWatches;
  normalized.trailerEmbeds = trailerEmbeds;
  normalized.embedUrl = trailerEmbeds[0] || null;
  return normalized;
}

function normalizeShowMetadata(details) {
  if (!details) return null;
  const normalized = { ...details };
  normalized.poster_path = buildImageUrl(details.poster_path, 'w500');
  normalized.backdrop_path = buildImageUrl(details.backdrop_path, 'original');
  normalized.title = details.name || details.title;
  normalized.release_date = details.first_air_date || details.release_date;
  if (!normalized.release_dates) {
    const mapped = mapContentRatingsToReleaseDates(details.content_ratings);
    if (mapped) {
      normalized.release_dates = mapped;
    }
  }
  const trailerWatches = extractTrailerUrls(details.videos, 'watch');
  const trailerEmbeds = extractTrailerUrls(details.videos, 'embed');
  normalized.trailers = trailerWatches;
  normalized.trailerEmbeds = trailerEmbeds;
  normalized.embedUrl = trailerEmbeds[0] || null;
  return normalized;
}

async function refreshMetadataForTitles({ movies = [], shows = [] } = {}) {
  const movieTitles = Array.from(new Set(movies.map((t) => t && t.trim()).filter(Boolean)));
  const showTitles = Array.from(new Set(shows.map((t) => t && t.trim()).filter(Boolean)));

  for (const movieTitle of movieTitles) {
    const existing = await pool.query('SELECT metadata FROM movies WHERE title = $1 LIMIT 1', [movieTitle]);
    if (existing.rows.length && existing.rows[0].metadata) continue;
    try {
      const metadata = normalizeMovieMetadata(await fetchMovieMetadata(movieTitle));
      if (metadata) {
        await upsertMetadata({ table: 'movies', title: movieTitle, metadata });
      }
    } catch (err) {
      console.warn('[metadata] movie fetch failed', movieTitle, err.message || err);
    }
  }

  for (const showTitle of showTitles) {
    const existing = await pool.query('SELECT metadata FROM shows WHERE title = $1 LIMIT 1', [showTitle]);
    if (existing.rows.length && existing.rows[0].metadata) continue;
    try {
      const metadata = normalizeShowMetadata(await fetchShowMetadata(showTitle));
      if (metadata) {
        await upsertMetadata({ table: 'shows', title: showTitle, metadata });
      }
    } catch (err) {
      console.warn('[metadata] show fetch failed', showTitle, err.message || err);
    }
  }
}

async function refreshMetadataForMedia() {
  if (!getMediaCacheFn) {
    console.warn('[metadata] getMediaCache function not set; skipping refresh');
    return;
  }
  try {
    const manifest = await getMediaCacheFn();
    const moviesToFetch = [];
    const showsToFetch = [];

    for (const movie of manifest.movies || []) {
      const title = movie.title?.trim();
      if (!title) continue;
      const existing = await pool.query('SELECT metadata FROM movies WHERE title = $1 LIMIT 1', [title]);
      if (!existing.rows.length || !existing.rows[0].metadata) {
        moviesToFetch.push(title);
      }
    }

    for (const show of manifest.shows || []) {
      const title = show.title?.trim();
      if (!title) continue;
      const existing = await pool.query('SELECT metadata FROM shows WHERE title = $1 LIMIT 1', [title]);
      if (!existing.rows.length || !existing.rows[0].metadata) {
        showsToFetch.push(title);
      }
    }

    if (moviesToFetch.length || showsToFetch.length) {
      await refreshMetadataForTitles({ movies: moviesToFetch, shows: showsToFetch });
    }
  } catch (err) {
    console.error('[metadata] refresh failed', err);
  }
}

module.exports = {
  refreshMetadataForMedia,
  refreshMetadataForTitles,
  setGetMediaCache
};
