const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const config = require('../config');
const { pool } = require('../db');
const { refreshMetadataForMedia, refreshMetadataForTitles, setGetMediaCache } = require('./metadataUpdater');
const manifestStore = require('./manifestStore');
const { ENTITY_TYPES } = manifestStore;
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
    episodeTitle: decodeSegment(path.basename(fileName, path.extname(fileName))),
    showFolderRelative: segments.slice(0, idx + 2).join('/')
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

async function collectVideoFiles(dirPath) {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const results = [];
    const videoExtensions = ['.mp4', '.mkv', '.mov', '.avi', '.m4v', '.webm'];
    
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!videoExtensions.includes(ext)) continue;
      
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

function minTimestamp(items) {
  let result = null;
  for (const item of items || []) {
    const candidate = item?.mtimeMs ?? item?.addedAt ?? null;
    if (!Number.isFinite(candidate)) continue;
    result = result == null ? candidate : Math.min(result, candidate);
  }
  return result;
}

function extractBirthtimeMs(stat) {
  if (!stat) return null;
  if (Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0) {
    return Math.round(stat.birthtimeMs);
  }
  if (stat.birthtime instanceof Date) {
    const ts = stat.birthtime.getTime();
    if (Number.isFinite(ts) && ts > 0) {
      return ts;
    }
  }
  return null;
}

async function getDirectoryBirthtimeMs(dirPath) {
  if (!dirPath) return null;
  try {
    const stat = await fsp.stat(dirPath);
    return extractBirthtimeMs(stat);
  } catch (_) {
    return null;
  }
}

function getDirectoryBirthtimeMsSync(dirPath) {
  if (!dirPath) return null;
  try {
    const stat = fs.statSync(dirPath);
    return extractBirthtimeMs(stat);
  } catch (_) {
    return null;
  }
}

function folderRelativeToAbsolute(folderRelative) {
  if (!folderRelative) return null;
  return path.join(config.MEDIA_DIR, fromPosix(folderRelative));
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
          addedAt: playlist.mtimeMs,
          sourceType: 'hls'
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
    const folderBirthtime = await getDirectoryBirthtimeMs(moviePath);
    const fallbackAddedAt = minTimestamp(playlists);
    movies.push({
      title: entry.name,
      folderRelative: toPosix(path.relative(config.MEDIA_DIR, moviePath)),
      parts,
      addedAt: Number.isFinite(folderBirthtime) ? folderBirthtime : fallbackAddedAt
    });
  }
  movies.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  return movies;
}

async function loadMoviesFromVideoFiles() {
  const moviesDir = path.join(config.MEDIA_DIR, 'movies');
  const entries = await safeReaddir(moviesDir);
  const movies = [];
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const moviePath = path.join(moviesDir, entry.name);
    const videoFiles = await collectVideoFiles(moviePath);
    if (videoFiles.length === 0) continue;
    
    const parts = videoFiles
      .map((video, idx) => {
        const relativePosix = toPosix(path.relative(config.MEDIA_DIR, video.fullPath));
        return {
          id: idx,
          title: video.baseTitle,
          relative: relativePosix,
          src: toVideoSrc(relativePosix),
          addedAt: video.mtimeMs,
          sourceType: 'direct'
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
    const folderBirthtime = await getDirectoryBirthtimeMs(moviePath);
    const fallbackAddedAt = minTimestamp(videoFiles);
    
    movies.push({
      title: entry.name,
      folderRelative: toPosix(path.relative(config.MEDIA_DIR, moviePath)),
      parts,
      addedAt: Number.isFinite(folderBirthtime) ? folderBirthtime : fallbackAddedAt
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
      episodeNumber: inferEpisodeNumber(playlist.baseTitle),
      sourceType: 'hls'
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
        episodeNumber: inferEpisodeNumber(displayTitle),
        sourceType: 'hls'
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

async function loadSeasonEpisodesFromVideoFiles(seasonPath) {
  const episodes = [];

  const videoFiles = await collectVideoFiles(seasonPath);
  for (const video of videoFiles) {
    const relativePosix = toPosix(path.relative(config.MEDIA_DIR, video.fullPath));
    episodes.push({
      title: video.baseTitle,
      relative: relativePosix,
      src: toVideoSrc(relativePosix),
      addedAt: video.mtimeMs,
      episodeNumber: inferEpisodeNumber(video.baseTitle),
      sourceType: 'direct'
    });
  }

  const entries = await safeReaddir(seasonPath);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const episodeDir = path.join(seasonPath, entry.name);
    const videoFiles = await collectVideoFiles(episodeDir);
    if (videoFiles.length === 0) continue;
    for (const video of videoFiles) {
      const relativePosix = toPosix(path.relative(config.MEDIA_DIR, video.fullPath));
      const displayTitle = video.baseTitle || entry.name;
      episodes.push({
        title: displayTitle,
        relative: relativePosix,
        src: toVideoSrc(relativePosix),
        addedAt: video.mtimeMs,
        episodeNumber: inferEpisodeNumber(displayTitle),
        sourceType: 'direct'
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
    const allEpisodes = seasons.flatMap((season) => season.episodes || []);
    const fallbackAddedAt = minTimestamp(allEpisodes);
    const folderBirthtime = await getDirectoryBirthtimeMs(showPath);
    shows.push({
      title: showEntry.name,
      seasons,
      addedAt: Number.isFinite(folderBirthtime) ? folderBirthtime : fallbackAddedAt
    });
  }
  shows.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  return shows;
}

async function loadShowsFromVideoFiles() {
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
      const episodes = await loadSeasonEpisodesFromVideoFiles(seasonPath);
      if (episodes.length === 0) continue;
      seasons.push({
        season: seasonEntry.name,
        episodes,
        addedAt: maxTimestamp(episodes)
      });
    }
    
    if (seasons.length === 0) continue;
    seasons.sort((a, b) => a.season.localeCompare(b.season, undefined, { numeric: true }));
    const allEpisodes = seasons.flatMap((season) => season.episodes || []);
    const fallbackAddedAt = minTimestamp(allEpisodes);
    const folderBirthtime = await getDirectoryBirthtimeMs(showPath);
    shows.push({
      title: showEntry.name,
      seasons,
      addedAt: Number.isFinite(folderBirthtime) ? folderBirthtime : fallbackAddedAt
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

function ensureMovieEntry(movieTitle, folderRelative) {
  const absoluteFolder = folderRelativeToAbsolute(folderRelative);
  const folderBirthtime = getDirectoryBirthtimeMsSync(absoluteFolder);
  return {
    id: generateMovieId(movieTitle),
    title: movieTitle,
    folderRelative,
    parts: [],
    addedAt: Number.isFinite(folderBirthtime) ? folderBirthtime : Date.now(),
    type: 'movie'
  };
}

function ensureShowEntry(showTitle, showFolderRelative) {
  const absoluteFolder = folderRelativeToAbsolute(showFolderRelative);
  const folderBirthtime = getDirectoryBirthtimeMsSync(absoluteFolder);
  return {
    id: generateShowId(showTitle),
    title: showTitle,
    seasons: [],
    addedAt: Number.isFinite(folderBirthtime) ? folderBirthtime : Date.now(),
    folderRelative: showFolderRelative || null,
    type: 'show'
  };
}

function ensureMoviePartEntry(movie, {
  movieTitle,
  folderRelative,
  relative,
  descriptor,
  sourceType
}) {
  const target = movie || ensureMovieEntry(movieTitle, folderRelative);
  target.type = 'movie';
  target.title = target.title || movieTitle;
  if (!target.folderRelative && folderRelative) {
    target.folderRelative = folderRelative;
  }
  if (!Array.isArray(target.parts)) {
    target.parts = [];
  }

  if (sourceType === 'hls') {
    const normalizedDescriptor = normalizeForComparison(descriptor);
    target.parts = target.parts.filter((part) => {
      if (part.sourceType === 'direct' && normalizeForComparison(part.title) === normalizedDescriptor) {
        return false;
      }
      return true;
    });
  }

  let part = target.parts.find((p) => p.relative === relative);
  if (!part) {
    part = {
      id: generateEpisodeId(target.id, relative, descriptor),
      title: descriptor,
      relative,
      src: toVideoSrc(relative),
      addedAt: Date.now(),
      sourceType: sourceType || 'hls'
    };
    target.parts.push(part);
  } else {
    part.title = descriptor;
    part.addedAt = Date.now();
    part.sourceType = sourceType || part.sourceType || 'hls';
    part.src = toVideoSrc(relative);
  }
  if (!Number.isFinite(target.addedAt) && target.folderRelative) {
    const absolute = folderRelativeToAbsolute(target.folderRelative);
    const folderBirthtime = getDirectoryBirthtimeMsSync(absolute);
    if (Number.isFinite(folderBirthtime)) {
      target.addedAt = folderBirthtime;
    }
  }
  sortMovieParts(target);
  return target;
}

function ensureShowEpisodeEntry(show, {
  showTitle,
  seasonLabel,
  relative,
  descriptor,
  episodeNumber,
  sourceType,
  showFolderRelative
}) {
  const target = show || ensureShowEntry(showTitle, showFolderRelative);
  target.type = 'show';
  target.title = target.title || showTitle;
  if (!target.folderRelative && showFolderRelative) {
    target.folderRelative = showFolderRelative;
  }
  if (!Array.isArray(target.seasons)) {
    target.seasons = [];
  }
  if (!Number.isFinite(target.addedAt) && target.folderRelative) {
    const absolute = folderRelativeToAbsolute(target.folderRelative);
    const folderBirthtime = getDirectoryBirthtimeMsSync(absolute);
    if (Number.isFinite(folderBirthtime)) {
      target.addedAt = folderBirthtime;
    }
  }
  const normalizedSeason = normalizeTitle(seasonLabel);
  let season = target.seasons.find((s) => normalizeTitle(s.season) === normalizedSeason);
  if (!season) {
    season = {
      id: generateSeasonId(target.id, seasonLabel),
      season: seasonLabel,
      episodes: [],
      addedAt: Date.now()
    };
    target.seasons.push(season);
  }
  if (!Array.isArray(season.episodes)) {
    season.episodes = [];
  }
  if (sourceType === 'hls') {
    const normalizedDescriptor = normalizeForComparison(descriptor);
    season.episodes = season.episodes.filter((episode) => {
      if (episode.sourceType === 'direct' && normalizeForComparison(episode.title) === normalizedDescriptor) {
        return false;
      }
      return true;
    });
  }
  let episode = season.episodes.find((ep) => ep.relative === relative);
  if (!episode) {
    episode = {
      id: generateEpisodeId(season.id, relative, descriptor),
      title: descriptor,
      relative,
      src: toVideoSrc(relative),
      episodeNumber: Number.isFinite(episodeNumber) ? episodeNumber : inferEpisodeNumber(descriptor),
      addedAt: Date.now(),
      previewSrc: null,
      sourceType: sourceType || 'hls'
    };
    season.episodes.push(episode);
  } else {
    episode.title = descriptor;
    episode.episodeNumber = Number.isFinite(episodeNumber) ? episodeNumber : episode.episodeNumber;
    episode.addedAt = Date.now();
    episode.sourceType = sourceType || episode.sourceType || 'hls';
    episode.src = toVideoSrc(relative);
  }
  sortSeasonEpisodes(season);
  sortShowSeasons(target);
  return target;
}

function normalizeForComparison(str) {
  return (str || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

function mergeMovieManifests(hlsMovies, backupMovies) {
  const result = [];
  const hlsMoviesByTitle = new Map();
  
  for (const hlsMovie of hlsMovies) {
    const key = normalizeForComparison(hlsMovie.title);
    hlsMoviesByTitle.set(key, hlsMovie);
    result.push(hlsMovie);
  }
  
  for (const backupMovie of backupMovies) {
    const key = normalizeForComparison(backupMovie.title);
    const existingHls = hlsMoviesByTitle.get(key);
    
    if (existingHls) {
      const existingHlsPaths = new Set(existingHls.parts.map(p => normalizePathKey(p.relative)));
      const backupParts = backupMovie.parts.filter(part => {
        const backupBaseName = normalizeForComparison(part.title);
        const matchExists = existingHls.parts.some(hlsPart => 
          normalizeForComparison(hlsPart.title) === backupBaseName
        );
        return !matchExists;
      });
      
      if (backupParts.length > 0) {
        existingHls.parts.push(...backupParts);
        sortMovieParts(existingHls);
      }
      
      if (Number.isFinite(backupMovie.addedAt)) {
        if (!Number.isFinite(existingHls.addedAt) || backupMovie.addedAt < existingHls.addedAt) {
          existingHls.addedAt = backupMovie.addedAt;
        }
      }
    } else {
      result.push(backupMovie);
      hlsMoviesByTitle.set(key, backupMovie);
    }
  }
  
  result.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  return result;
}

function mergeShowManifests(hlsShows, backupShows) {
  const result = [];
  const hlsShowsByTitle = new Map();
  
  for (const hlsShow of hlsShows) {
    const key = normalizeForComparison(hlsShow.title);
    hlsShowsByTitle.set(key, hlsShow);
    result.push(hlsShow);
  }
  
  for (const backupShow of backupShows) {
    const key = normalizeForComparison(backupShow.title);
    const existingHls = hlsShowsByTitle.get(key);
    
    if (existingHls) {
      const hlsSeasonsByLabel = new Map();
      for (const season of existingHls.seasons) {
        hlsSeasonsByLabel.set(normalizeForComparison(season.season), season);
      }
      
      for (const backupSeason of backupShow.seasons) {
        const seasonKey = normalizeForComparison(backupSeason.season);
        const existingSeason = hlsSeasonsByLabel.get(seasonKey);
        
        if (existingSeason) {
          const existingEpisodeTitles = new Set(
            existingSeason.episodes.map(ep => normalizeForComparison(ep.title))
          );
          
          const backupEpisodes = backupSeason.episodes.filter(ep => 
            !existingEpisodeTitles.has(normalizeForComparison(ep.title))
          );
          
          if (backupEpisodes.length > 0) {
            existingSeason.episodes.push(...backupEpisodes);
            sortSeasonEpisodes(existingSeason);
          }
        } else {
          existingHls.seasons.push(backupSeason);
          hlsSeasonsByLabel.set(seasonKey, backupSeason);
        }
      }
      
      sortShowSeasons(existingHls);
      
      if (Number.isFinite(backupShow.addedAt)) {
        if (!Number.isFinite(existingHls.addedAt) || backupShow.addedAt < existingHls.addedAt) {
          existingHls.addedAt = backupShow.addedAt;
        }
      }
    } else {
      result.push(backupShow);
      hlsShowsByTitle.set(key, backupShow);
    }
  }
  
  result.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  return result;
}

async function buildManifest() {
  const [moviesHls, showsHls, moviesBackup, showsBackup, dbIndex] = await Promise.all([
    loadMoviesFromFs(),
    loadShowsFromFs(),
    loadMoviesFromVideoFiles(),
    loadShowsFromVideoFiles(),
    loadDbIndexes()
  ]);
  
  const mergedMoviesFs = mergeMovieManifests(moviesHls, moviesBackup);
  const mergedShowsFs = mergeShowManifests(showsHls, showsBackup);
  
  const movies = attachMovieDbData(mergedMoviesFs, dbIndex);
  const shows = attachShowDbData(mergedShowsFs, dbIndex);
  
  const hlsCount = moviesHls.length + showsHls.reduce((sum, s) => sum + s.seasons.reduce((sum2, season) => sum2 + season.episodes.length, 0), 0);
  const backupCount = moviesBackup.length + showsBackup.reduce((sum, s) => sum + s.seasons.reduce((sum2, season) => sum2 + season.episodes.length, 0), 0);
  const totalCount = movies.length + shows.reduce((sum, s) => sum + s.seasons.reduce((sum2, season) => sum2 + season.episodes.length, 0), 0);
  
  console.log(`[media-cache] Manifest built: HLS=${hlsCount}, Backup=${backupCount}, Total=${totalCount}`);
  
  return { movies, shows };
}

async function fetchMetadata(title, type) {
  const table = type === 'movie' ? 'movies' : 'shows';
  const { rows } = await pool.query(`SELECT metadata FROM ${table} WHERE title ILIKE $1 LIMIT 1`, [title]);
  return rows[0]?.metadata || null;
}

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
      const diff = await manifestStore.syncManifest(manifest);
      lastUpdatedAt = Date.now();
      console.log(
        `[media-cache] Refresh complete (${label}): movies=${manifest.movies.length}, shows=${manifest.shows.length}, upserts=${diff.upserts}, deletes=${diff.deletes}`
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

async function getMediaCache() {
  return manifestStore.getManifestSnapshot();
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
  episodeNumber,
  sourceType
}) {
  const resolvedRelative = await resolveRelativeAgainstDisk(masterRelative);
  if (!resolvedRelative) {
    return { ok: false, error: 'file_not_found' };
  }
  const relativePosix = resolvedRelative;
  const displayName = descriptor || path.basename(relativePosix, path.extname(relativePosix));
  const finalSourceType = sourceType || (relativePosix.endsWith('.m3u8') ? 'hls' : 'direct');
  
  if (type === 'movie') {
    const movieInfo = deriveMovieInfoFromRelative(relativePosix);
    const resolvedTitle = movieTitle || movieInfo?.movieTitle;
    if (!resolvedTitle) {
      return { ok: false, error: 'missing_movie_title' };
    }
    const folderRelative = movieInfo?.folderRelative || toPosix(path.dirname(relativePosix));
    const existingMovie = await manifestStore.getManifestEntry(ENTITY_TYPES.MOVIE, resolvedTitle);
    const updatedMovie = ensureMoviePartEntry(existingMovie, {
      movieTitle: resolvedTitle,
      folderRelative,
      relative: relativePosix,
      descriptor: displayName,
      sourceType: finalSourceType
    });
    await manifestStore.saveManifestEntry({ entityType: ENTITY_TYPES.MOVIE, payload: updatedMovie });
    await refreshMetadataForTitles({ movies: [resolvedTitle] });
  } else {
    const episodeInfo = deriveEpisodeInfoFromRelative(relativePosix);
    const resolvedShowTitle = showTitle || episodeInfo?.showTitle;
    const resolvedSeasonLabel = seasonLabel || episodeInfo?.seasonLabel;
    const resolvedEpisodeTitle = episodeTitle || episodeInfo?.episodeTitle || displayName;
    const resolvedShowFolderRelative = episodeInfo?.showFolderRelative;
    if (!resolvedShowTitle || !resolvedSeasonLabel) {
      return { ok: false, error: 'missing_episode_info' };
    }
    const existingShow = await manifestStore.getManifestEntry(ENTITY_TYPES.SHOW, resolvedShowTitle);
    const updatedShow = ensureShowEpisodeEntry(existingShow, {
      showTitle: resolvedShowTitle,
      seasonLabel: resolvedSeasonLabel,
      relative: relativePosix,
      descriptor: resolvedEpisodeTitle,
      episodeNumber,
      sourceType: finalSourceType,
      showFolderRelative: resolvedShowFolderRelative
    });
    await manifestStore.saveManifestEntry({ entityType: ENTITY_TYPES.SHOW, payload: updatedShow });
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

setGetMediaCache(() => manifestStore.getManifestSnapshot());

module.exports = {
  refreshMediaCache,
  getMediaCache,
  fetchMetadata,
  getCacheInfo,
  registerMediaAsset
};
