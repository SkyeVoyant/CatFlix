const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const config = require('../config');
const { pool } = require('../db');
const { refreshMetadataForMedia, refreshMetadataForTitles, setGetMediaCache } = require('./metadataUpdater');
const { toPosix, fromPosix } = require('../utils/path');
const { safeReaddir, pathExists } = require('../utils/fs');

function toVideoSrc(relativePosixPath) {
  const segments = relativePosixPath.split('/').map(encodeURIComponent);
  return `/videos/${segments.join('/')}`;
}

function normalizeTitle(value) {
  return (value || '').trim().toLowerCase();
}

function normalizeSeasonLabel(value) {
  return normalizeTitle(value);
}

function normalizePathKey(value) {
  if (!value) return null;
  let normalized = toPosix(String(value).trim());
  normalized = normalized.replace(/^[./]+/, '').replace(/^\/+/, '');
  return normalized.toLowerCase();
}

function inferEpisodeNumber(title) {
  const match = String(title || '').match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function computeHashBase(parts) {
  const source = (parts || [])
    .filter((part) => part != null)
    .map((part) => {
      if (typeof part === 'string') return normalizeTitle(part);
      if (typeof part === 'number') return String(part);
      return normalizeTitle(JSON.stringify(part));
    })
    .join('|');
  if (!source) return Math.floor(Date.now() % 100000000);
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash * 33) ^ source.charCodeAt(i)) >>> 0;
  }
  return hash % 100000000;
}

const MOVIE_ID_OFFSET = 200000000;
const SHOW_ID_OFFSET = 300000000;
const SEASON_ID_OFFSET = 400000000;
const EPISODE_ID_OFFSET = 500000000;

function generateMovieId(movieTitle) {
  return MOVIE_ID_OFFSET + computeHashBase([movieTitle]);
}

function generateShowId(showTitle) {
  return SHOW_ID_OFFSET + computeHashBase([showTitle]);
}

function generateSeasonId(showId, seasonLabel) {
  return SEASON_ID_OFFSET + computeHashBase([showId, seasonLabel]);
}

function generateEpisodeId(seasonId, relativePath, descriptor) {
  return EPISODE_ID_OFFSET + computeHashBase([seasonId, relativePath || descriptor]);
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch (_) {
    return segment;
  }
}

function sanitizeRelativeInput(value) {
  if (!value) return null;
  const posix = toPosix(String(value).trim());
  const cleaned = posix.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  return cleaned.length > 0 ? cleaned : null;
}

async function resolveRelativeAgainstDisk(candidate) {
  const sanitized = sanitizeRelativeInput(candidate);
  if (!sanitized) return null;
  const absolute = path.join(config.MEDIA_DIR, fromPosix(sanitized));
  if (await pathExists(absolute)) {
    return sanitized;
  }
  const decoded = sanitized
    .split('/')
    .map((segment) => decodeSegment(segment))
    .join('/');
  if (decoded !== sanitized) {
    const decodedAbsolute = path.join(config.MEDIA_DIR, fromPosix(decoded));
    if (await pathExists(decodedAbsolute)) {
      return decoded;
    }
  }
  return null;
}

function deriveMovieInfoFromRelative(relativePosix) {
  const segments = relativePosix.split('/');
  const idx = segments.indexOf('movies');
  if (idx === -1) return null;
  const movieTitleSegment = segments[idx + 1];
  if (!movieTitleSegment) return null;
  return {
    movieTitle: decodeSegment(movieTitleSegment),
    folderRelative: segments.slice(0, idx + 2).join('/')
  };
}

function deriveEpisodeInfoFromRelative(relativePosix) {
  const segments = relativePosix.split('/');
  const idx = segments.indexOf('shows');
  if (idx === -1) return null;
  const showSegment = segments[idx + 1];
  const seasonSegment = segments[idx + 2];
  if (!showSegment || !seasonSegment) return null;
  const fileName = segments[segments.length - 1] || '';
  return {
    showTitle: decodeSegment(showSegment),
    seasonLabel: decodeSegment(seasonSegment),
    episodeTitle: decodeSegment(path.basename(fileName, path.extname(fileName)))
  };
}

function isVariantPlaylist(fileName) {
  return /_v\d+\.m3u8$/i.test(fileName) || fileName.toLowerCase().includes('variant');
}

async function collectM3u8Files(dirPath) {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const results = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.m3u8')) continue;
      if (isVariantPlaylist(entry.name)) continue;
      const fullPath = path.join(dirPath, entry.name);
      const stat = await fsp.stat(fullPath).catch(() => null);
      results.push({
        fullPath,
        baseTitle: path.basename(entry.name, path.extname(entry.name)),
        mtimeMs: stat ? Math.round(stat.mtimeMs) : null
      });
    }
    return results;
  } catch (_) {
    return [];
  }
}

function maxTimestamp(items) {
  return items.reduce((max, item) => {
    const candidate = item?.mtimeMs ?? item?.addedAt ?? 0;
    return Math.max(max, candidate || 0);
  }, 0) || null;
}

async function loadMoviesFromFs() {
  const moviesDir = path.join(config.MEDIA_DIR, 'movies');
  const entries = await safeReaddir(moviesDir);
  const movies = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const moviePath = path.join(moviesDir, entry.name);
    const playlists = await collectM3u8Files(moviePath);
    if (playlists.length === 0) continue;
    const parts = playlists
      .map((playlist, idx) => {
        const relativePosix = toPosix(path.relative(config.MEDIA_DIR, playlist.fullPath));
        return {
          id: idx,
          title: playlist.baseTitle,
          relative: relativePosix,
          src: toVideoSrc(relativePosix),
          addedAt: playlist.mtimeMs
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
    movies.push({
      title: entry.name,
      folderRelative: toPosix(path.relative(config.MEDIA_DIR, moviePath)),
      parts,
      addedAt: maxTimestamp(playlists)
    });
  }
  movies.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  return movies;
}

async function loadSeasonEpisodes(seasonPath) {
  const episodes = [];

  const directPlaylists = await collectM3u8Files(seasonPath);
  for (const playlist of directPlaylists) {
    const relativePosix = toPosix(path.relative(config.MEDIA_DIR, playlist.fullPath));
    episodes.push({
      title: playlist.baseTitle,
      relative: relativePosix,
      src: toVideoSrc(relativePosix),
      addedAt: playlist.mtimeMs,
      episodeNumber: inferEpisodeNumber(playlist.baseTitle)
    });
  }

  const entries = await safeReaddir(seasonPath);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const episodeDir = path.join(seasonPath, entry.name);
    const playlists = await collectM3u8Files(episodeDir);
    if (playlists.length === 0) continue;
    for (const playlist of playlists) {
      const relativePosix = toPosix(path.relative(config.MEDIA_DIR, playlist.fullPath));
      const displayTitle = playlist.baseTitle || entry.name;
      episodes.push({
        title: displayTitle,
        relative: relativePosix,
        src: toVideoSrc(relativePosix),
        addedAt: playlist.mtimeMs,
        episodeNumber: inferEpisodeNumber(displayTitle)
      });
    }
  }

  episodes.sort((a, b) => {
    const numA = Number.isFinite(a.episodeNumber) ? a.episodeNumber : Number.MAX_SAFE_INTEGER;
    const numB = Number.isFinite(b.episodeNumber) ? b.episodeNumber : Number.MAX_SAFE_INTEGER;
    if (numA !== numB) return numA - numB;
    return a.title.localeCompare(b.title, undefined, { numeric: true });
  });

  return episodes;
}

async function loadShowsFromFs() {
  const showsDir = path.join(config.MEDIA_DIR, 'shows');
  const showEntries = await safeReaddir(showsDir);
  const shows = [];
  for (const showEntry of showEntries) {
    if (!showEntry.isDirectory()) continue;
    const showPath = path.join(showsDir, showEntry.name);
    const seasonEntries = await safeReaddir(showPath);
    const seasons = [];
    for (const seasonEntry of seasonEntries) {
      if (!seasonEntry.isDirectory()) continue;
      const seasonPath = path.join(showPath, seasonEntry.name);
      const episodes = await loadSeasonEpisodes(seasonPath);
      if (episodes.length === 0) continue;
      seasons.push({
        season: seasonEntry.name,
        episodes,
        addedAt: maxTimestamp(episodes)
      });
    }
    if (seasons.length === 0) continue;
    seasons.sort((a, b) => a.season.localeCompare(b.season, undefined, { numeric: true }));
    shows.push({
      title: showEntry.name,
      seasons,
      addedAt: maxTimestamp(seasons)
    });
  }
  shows.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  return shows;
}

let dbIndexWarningLogged = false;

async function loadDbIndexes() {
  try {
    const [
      moviesRes,
      movieFilesRes,
      showsRes,
      seasonsRes,
      episodesRes
    ] = await Promise.all([
      pool.query('SELECT id, title FROM movies'),
      pool.query('SELECT id, movie_id, display_name, relative_path, hls_path FROM movie_files'),
      pool.query('SELECT id, title FROM shows'),
      pool.query('SELECT id, show_id, season_label FROM seasons'),
      pool.query('SELECT id, season_id, display_name, relative_path, hls_path, episode_number FROM episodes')
    ]);

    const moviesByTitle = new Map();
    for (const row of moviesRes.rows) {
      moviesByTitle.set(normalizeTitle(row.title), row);
    }

    const movieFilesByPath = new Map();
    for (const row of movieFilesRes.rows) {
      const candidates = [row.hls_path, row.relative_path];
      for (const candidate of candidates) {
        const key = normalizePathKey(candidate);
        if (key && !movieFilesByPath.has(key)) {
          movieFilesByPath.set(key, row);
        }
      }
    }

    const showsByTitle = new Map();
    for (const row of showsRes.rows) {
      showsByTitle.set(normalizeTitle(row.title), row);
    }

    const seasonsById = new Map();
    const seasonsByKey = new Map();
    for (const row of seasonsRes.rows) {
      seasonsById.set(row.id, row);
      if (row.show_id != null) {
        const key = `${row.show_id}::${normalizeSeasonLabel(row.season_label)}`;
        if (!seasonsByKey.has(key)) {
          seasonsByKey.set(key, row);
        }
      }
    }

    const episodesByPath = new Map();
    for (const row of episodesRes.rows) {
      const candidates = [row.hls_path, row.relative_path];
      for (const candidate of candidates) {
        const key = normalizePathKey(candidate);
        if (key && !episodesByPath.has(key)) {
          episodesByPath.set(key, row);
        }
      }
    }

    return {
      moviesByTitle,
      movieFilesByPath,
      showsByTitle,
      seasonsById,
      seasonsByKey,
      episodesByPath
    };
  } catch (err) {
    if (!dbIndexWarningLogged) {
      console.warn('[media-cache] Database metadata unavailable:', err.message || err);
      dbIndexWarningLogged = true;
    }
    return null;
  }
}

function attachMovieDbData(movies, db) {
  return movies.map((movie) => {
    const dbMovie = db?.moviesByTitle.get(normalizeTitle(movie.title)) || null;
    const fallbackMovieId = generateMovieId(dbMovie?.title || movie.title);
    const parts = (movie.parts || []).map((part, partIdx) => {
      const key = normalizePathKey(part.relative);
      const dbFile = key && db ? db.movieFilesByPath.get(key) : null;
      const fallbackPartId = part.id ?? (fallbackMovieId * 1000 + partIdx + 1);
      return {
        ...part,
        id: dbFile?.id ?? fallbackPartId,
        title: dbFile?.display_name || part.title
      };
    });
    sortMovieParts({ parts });
    return {
      ...movie,
      id: dbMovie?.id ?? fallbackMovieId,
      title: dbMovie?.title || movie.title,
      parts
    };
  });
}

function attachShowDbData(shows, db) {
  return shows.map((show) => {
    const dbShow = db?.showsByTitle.get(normalizeTitle(show.title)) || null;
    const fallbackShowId = show.id ?? generateShowId(dbShow?.title || show.title);
    const showDbId = dbShow?.id ?? fallbackShowId;
    const seasons = (show.seasons || []).map((season, seasonIdx) => {
      const key = showDbId != null ? `${showDbId}::${normalizeSeasonLabel(season.season)}` : null;
      const dbSeason = key && db ? db.seasonsByKey.get(key) : null;
      const fallbackSeasonId = season.id ?? generateSeasonId(showDbId, dbSeason?.season_label || season.season);
      const episodes = (season.episodes || []).map((episode, epIdx) => {
        const pathKey = normalizePathKey(episode.relative);
        const dbEpisode = pathKey && db ? db.episodesByPath.get(pathKey) : null;
        const episodeNumber = dbEpisode?.episode_number ?? episode.episodeNumber ?? inferEpisodeNumber(episode.title);
        const fallbackEpisodeId = episode.id ?? generateEpisodeId(fallbackSeasonId, episode.relative, episode.title);
        return {
          ...episode,
          id: dbEpisode?.id ?? fallbackEpisodeId,
          title: dbEpisode?.display_name || episode.title,
          episodeNumber
        };
      });
      sortSeasonEpisodes({ episodes });
      return {
        ...season,
        id: dbSeason?.id ?? fallbackSeasonId,
        season: dbSeason?.season_label || season.season,
        episodes
      };
    });
    sortShowSeasons({ seasons });
    return {
      ...show,
      id: dbShow?.id ?? fallbackShowId,
      title: dbShow?.title || show.title,
      seasons
    };
  });
}

function sortMovieParts(movie) {
  movie.parts.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
}

function sortMoviesList() {
  cachedMedia.movies.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
}

function sortShowSeasons(show) {
  show.seasons.sort((a, b) => a.season.localeCompare(b.season, undefined, { numeric: true }));
}

function sortSeasonEpisodes(season) {
  season.episodes.sort((a, b) => {
    const numA = Number.isFinite(a.episodeNumber) ? a.episodeNumber : Number.MAX_SAFE_INTEGER;
    const numB = Number.isFinite(b.episodeNumber) ? b.episodeNumber : Number.MAX_SAFE_INTEGER;
    if (numA !== numB) return numA - numB;
    return a.title.localeCompare(b.title, undefined, { numeric: true });
  });
}

function ensureMoviePartInCache({ movieTitle, folderRelative, relative, descriptor }) {
  const normalizedTitle = normalizeTitle(movieTitle);
  let movie = cachedMedia.movies.find((m) => normalizeTitle(m.title) === normalizedTitle);
  if (!movie) {
    movie = {
      id: generateMovieId(movieTitle),
      title: movieTitle,
      folderRelative,
      parts: [],
      addedAt: Date.now()
    };
    cachedMedia.movies.push(movie);
  }
  movie.id = movie.id ?? generateMovieId(movieTitle);
  let part = movie.parts.find((p) => p.relative === relative);
  if (!part) {
    part = {
      id: generateEpisodeId(movie.id, relative, descriptor),
      title: descriptor,
      relative,
      src: toVideoSrc(relative),
      addedAt: Date.now()
    };
    movie.parts.push(part);
  } else {
    part.title = descriptor;
    part.addedAt = Date.now();
  }
  movie.folderRelative = folderRelative || movie.folderRelative;
  movie.addedAt = Date.now();
  sortMovieParts(movie);
  sortMoviesList();
}

function ensureShowEpisodeInCache({ showTitle, seasonLabel, relative, descriptor, episodeNumber }) {
  const normalizedShow = normalizeTitle(showTitle);
  let show = cachedMedia.shows.find((s) => normalizeTitle(s.title) === normalizedShow);
  if (!show) {
    show = {
      id: generateShowId(showTitle),
      title: showTitle,
      seasons: [],
      addedAt: Date.now()
    };
    cachedMedia.shows.push(show);
  }
  show.id = show.id ?? generateShowId(showTitle);
  const normalizedSeason = normalizeTitle(seasonLabel);
  let season = show.seasons.find((seasonItem) => normalizeTitle(seasonItem.season) === normalizedSeason);
  if (!season) {
    season = {
      id: generateSeasonId(show.id, seasonLabel),
      season: seasonLabel,
      episodes: [],
      addedAt: Date.now()
    };
    show.seasons.push(season);
  }
  season.id = season.id ?? generateSeasonId(show.id, seasonLabel);
  let episode = season.episodes.find((ep) => ep.relative === relative);
  if (!episode) {
    episode = {
      id: generateEpisodeId(season.id, relative, descriptor),
      title: descriptor,
      relative,
      src: toVideoSrc(relative),
      episodeNumber: Number.isFinite(episodeNumber) ? episodeNumber : inferEpisodeNumber(descriptor),
      addedAt: Date.now(),
      previewSrc: null
    };
    season.episodes.push(episode);
  } else {
    episode.title = descriptor;
    episode.episodeNumber = Number.isFinite(episodeNumber) ? episodeNumber : episode.episodeNumber;
    episode.addedAt = Date.now();
  }
  season.addedAt = Date.now();
  show.addedAt = Date.now();
  sortSeasonEpisodes(season);
  sortShowSeasons(show);
  cachedMedia.shows.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
}

async function buildManifest() {
  const [moviesFs, showsFs, dbIndex] = await Promise.all([
    loadMoviesFromFs(),
    loadShowsFromFs(),
    loadDbIndexes()
  ]);
  const movies = attachMovieDbData(moviesFs, dbIndex);
  const shows = attachShowDbData(showsFs, dbIndex);
  return { movies, shows };
}

async function fetchMetadata(title, type) {
  const table = type === 'movie' ? 'movies' : 'shows';
  const { rows } = await pool.query(`SELECT metadata FROM ${table} WHERE title ILIKE $1 LIMIT 1`, [title]);
  return rows[0]?.metadata || null;
}

let cachedMedia = { movies: [], shows: [] };
let lastUpdatedAt = null;
let refreshing = null;

async function refreshMediaCache(label = 'manual', { background = false } = {}) {
  if (refreshing) {
    if (!background) {
      try {
        await refreshing;
      } catch (_) {
        // ignore; a new refresh will be triggered below if needed
      }
    }
    return refreshing;
  }
  const task = (async () => {
    try {
      const manifest = await buildManifest();
      cachedMedia = manifest;
      lastUpdatedAt = Date.now();
      console.log(
        `[media-cache] Refresh complete (${label}): movies=${manifest.movies.length}, shows=${manifest.shows.length}`
      );
      await refreshMetadataForMedia();
    } catch (err) {
      console.error(`[media-cache] Refresh failed (${label})`, err);
    } finally {
      refreshing = null;
    }
  })();
  refreshing = task;
  if (background) {
    task.catch(() => {});
    return task;
  }
  await task;
  return task;
}

async function ensureCacheReady() {
  if (!lastUpdatedAt) {
    if (refreshing) {
      try {
        await refreshing;
      } catch (_) {
        // ignore and try again below
      }
    }
    if (!lastUpdatedAt) {
      await refreshMediaCache('startup');
    }
  }
}

async function getMediaCache() {
  await ensureCacheReady();
  return cachedMedia;
}

function extractRelativeFromSrc(src) {
  if (!src || typeof src !== 'string') return null;
  const prefix = '/videos/';
  if (!src.startsWith(prefix)) return null;
  const rest = src.slice(prefix.length);
  try {
    return rest
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch (_) {
    return rest;
  }
}

async function registerMediaAsset({
  type,
  masterRelative,
  descriptor,
  movieTitle,
  showTitle,
  seasonLabel,
  episodeTitle,
  episodeNumber
}) {
  await ensureCacheReady();
  const resolvedRelative = await resolveRelativeAgainstDisk(masterRelative);
  if (!resolvedRelative) {
    return { ok: false, error: 'file_not_found' };
  }
  const relativePosix = resolvedRelative;
  const displayName = descriptor || path.basename(relativePosix, path.extname(relativePosix));
  if (type === 'movie') {
    const movieInfo = deriveMovieInfoFromRelative(relativePosix);
    const resolvedTitle = movieTitle || movieInfo?.movieTitle;
    if (!resolvedTitle) {
      return { ok: false, error: 'missing_movie_title' };
    }
    const folderRelative = movieInfo?.folderRelative || toPosix(path.dirname(relativePosix));
    ensureMoviePartInCache({
      movieTitle: resolvedTitle,
      folderRelative,
      relative: relativePosix,
      descriptor: displayName
    });
    await refreshMetadataForTitles({ movies: [resolvedTitle] });
  } else {
    const episodeInfo = deriveEpisodeInfoFromRelative(relativePosix);
    const resolvedShowTitle = showTitle || episodeInfo?.showTitle;
    const resolvedSeasonLabel = seasonLabel || episodeInfo?.seasonLabel;
    const resolvedEpisodeTitle = episodeTitle || episodeInfo?.episodeTitle || displayName;
    if (!resolvedShowTitle || !resolvedSeasonLabel) {
      return { ok: false, error: 'missing_episode_info' };
    }
    ensureShowEpisodeInCache({
      showTitle: resolvedShowTitle,
      seasonLabel: resolvedSeasonLabel,
      relative: relativePosix,
      descriptor: resolvedEpisodeTitle,
      episodeNumber
    });
    await refreshMetadataForTitles({ shows: [resolvedShowTitle] });
  }
  lastUpdatedAt = Date.now();
  return { ok: true };
}

function getCacheInfo() {
  return {
    lastUpdatedAt
  };
}

setGetMediaCache(() => cachedMedia);

module.exports = {
  refreshMediaCache,
  getMediaCache,
  fetchMetadata,
  getCacheInfo,
  registerMediaAsset
};
