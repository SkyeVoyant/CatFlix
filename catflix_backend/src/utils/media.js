const path = require('path');
const { computeHlsLayout } = require('./hls');
const { toPosix, fromPosix } = require('./path');
const { pathExists } = require('./fs');

function toVideoSrc(relativePosixPath) {
  const normalized = relativePosixPath.replace(/\\/g, '/');
  const segments = normalized.split('/').map(encodeURIComponent);
  return `/videos/${segments.join('/')}`;
}

function deriveAddedAt(value) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

async function buildMoviesManifest({ pool, config }) {
  const moviesRes = await pool.query('SELECT id, title, added_at FROM movies ORDER BY title ASC');
  const movieFilesRes = await pool.query('SELECT id, movie_id, display_name, relative_path, hls_path, added_at FROM movie_files');

  const filesByMovie = new Map();
  for (const file of movieFilesRes.rows) {
    if (!filesByMovie.has(file.movie_id)) filesByMovie.set(file.movie_id, []);
    filesByMovie.get(file.movie_id).push(file);
  }

  const movies = [];
  for (const movie of moviesRes.rows) {
    const files = filesByMovie.get(movie.id) || [];
    const parts = [];
    for (const file of files) {
      const candidate = computeHlsLayout({
        type: 'movie',
        sourceRelativePath: toPosix(file.relative_path),
        hlsRelativePath: file.hls_path ? toPosix(file.hls_path) : null,
        hlsMasterTemplate: config.HLS_MASTER_PLAYLIST_NAME,
        hlsVariantTemplate: config.HLS_VARIANT_PLAYLIST_TEMPLATE,
        hlsSegmentTemplate: config.HLS_SEGMENT_TEMPLATE
      }).masterRelative;
      if (!candidate) continue;
      const absolute = path.join(config.MEDIA_DIR, fromPosix(candidate));
      if (!(await pathExists(absolute))) continue;
      parts.push({
        id: file.id,
        title: file.display_name,
        relative: candidate,
        src: toVideoSrc(candidate),
        addedAt: deriveAddedAt(file.added_at)
      });
    }
    if (parts.length === 0) continue;
    parts.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
    movies.push({
      id: movie.id,
      title: movie.title,
      parts: parts.map(({ id, title, src }) => ({ id, title, src })),
      addedAt: deriveAddedAt(movie.added_at)
    });
  }
  movies.sort((a, b) => a.title.localeCompare(b.title));
  return movies;
}

async function buildShowsManifest({ pool, config }) {
  const showsRes = await pool.query('SELECT id, title, added_at FROM shows ORDER BY title ASC');
  const seasonsRes = await pool.query('SELECT id, show_id, season_label, season_number, added_at FROM seasons ORDER BY season_number NULLS LAST, season_label ASC');
  const episodesRes = await pool.query('SELECT id, season_id, display_name, relative_path, hls_path, episode_number, added_at FROM episodes');

  const seasonsByShow = new Map();
  for (const season of seasonsRes.rows) {
    if (!seasonsByShow.has(season.show_id)) seasonsByShow.set(season.show_id, []);
    seasonsByShow.get(season.show_id).push(season);
  }

  const episodesBySeason = new Map();
  for (const episode of episodesRes.rows) {
    if (!episodesBySeason.has(episode.season_id)) episodesBySeason.set(episode.season_id, []);
    episodesBySeason.get(episode.season_id).push(episode);
  }

  const shows = [];
  for (const show of showsRes.rows) {
    const seasons = seasonsByShow.get(show.id) || [];
    const normalizedSeasons = [];
    for (const season of seasons) {
      const episodes = episodesBySeason.get(season.id) || [];
      const readyEpisodes = [];
      for (const episode of episodes) {
        const candidate = computeHlsLayout({
          type: 'episode',
          sourceRelativePath: toPosix(episode.relative_path),
          hlsRelativePath: episode.hls_path ? toPosix(episode.hls_path) : null,
          hlsMasterTemplate: config.HLS_MASTER_PLAYLIST_NAME,
          hlsVariantTemplate: config.HLS_VARIANT_PLAYLIST_TEMPLATE,
          hlsSegmentTemplate: config.HLS_SEGMENT_TEMPLATE
        }).masterRelative;
        if (!candidate) continue;
        const absolute = path.join(config.MEDIA_DIR, fromPosix(candidate));
        if (!(await pathExists(absolute))) continue;
        readyEpisodes.push({
          id: episode.id,
          title: episode.display_name,
          relative: candidate,
          src: toVideoSrc(candidate),
          previewSrc: null,
          episodeNumber: episode.episode_number,
          addedAt: deriveAddedAt(episode.added_at)
        });
      }
      if (readyEpisodes.length === 0) continue;
      readyEpisodes.sort((a, b) => {
        const numA = Number.isFinite(a.episodeNumber) ? a.episodeNumber : Number.MAX_SAFE_INTEGER;
        const numB = Number.isFinite(b.episodeNumber) ? b.episodeNumber : Number.MAX_SAFE_INTEGER;
        if (numA !== numB) return numA - numB;
        return a.title.localeCompare(b.title, undefined, { numeric: true });
      });
      normalizedSeasons.push({
        id: season.id,
        season: season.season_label,
        episodes: readyEpisodes.map(({ id, title, src, previewSrc }) => ({ id, title, src, previewSrc })),
        addedAt: deriveAddedAt(season.added_at)
      });
    }
    if (normalizedSeasons.length === 0) continue;
    normalizedSeasons.sort((a, b) => a.season.localeCompare(b.season, undefined, { numeric: true }));
    shows.push({
      id: show.id,
      title: show.title,
      seasons: normalizedSeasons,
      addedAt: deriveAddedAt(show.added_at)
    });
  }
  shows.sort((a, b) => a.title.localeCompare(b.title));
  return shows;
}

module.exports = {
  buildMoviesManifest,
  buildShowsManifest
};
