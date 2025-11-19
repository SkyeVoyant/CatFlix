const fs = require('fs').promises;
const path = require('path');
const config = require('./config');

/**
 * Generate subtitle file path for a movie
 * Structure: movies/moviename.json
 */
function sanitizeSegment(value, fallback = 'Unknown', options = {}) {
  const base = (value && value.toString().trim()) || fallback;
  let sanitized = base
    .replace(/[<>:"/\\|?*]/g, '')
    .trim()
    .replace(/\s+/g, ' ');

  if (!sanitized) {
    sanitized = fallback;
  }

  if (options.toLowerCase) {
    sanitized = sanitized.toLowerCase();
  }

  return sanitized;
}

function getMovieSubtitlePath(movieTitle) {
  // Create a safe filename from the movie title
  // Remove special characters, keep spaces, make it filesystem-safe
  const safeTitle = sanitizeSegment(movieTitle, 'Movie');
  
  // Structure: movies/moviename.json
  const subtitlePath = `movies/${safeTitle}.json`;
  
  return subtitlePath;
}

/**
 * Generate subtitle file path for an episode
 * Structure: shows/showname/season <n>/episodename.json
 */
function getEpisodeSubtitlePath(showTitle, seasonLabel, episodeDisplayName) {
  const safeShowTitle = sanitizeSegment(showTitle, 'Show');

  const defaultSeason = 'season 1';
  const seasonBase = (() => {
    if (!seasonLabel) return defaultSeason;
    const trimmed = seasonLabel.toString().trim();
    if (!trimmed) return defaultSeason;
    const numeric = trimmed.match(/\d+/);
    if (numeric) {
      return `season ${numeric[0]}`;
    }
    return trimmed;
  })();
  const safeSeason = sanitizeSegment(seasonBase, defaultSeason, { toLowerCase: true });

  const safeEpisodeName = sanitizeSegment(episodeDisplayName, 'Episode');
  
  // Structure: shows/showname/season n/episodename.json
  const subtitlePath = `shows/${safeShowTitle}/${safeSeason}/${safeEpisodeName}.json`;
  
  return subtitlePath;
}

/**
 * Save subtitle file to disk
 */
async function saveSubtitleFile(subtitlePath, subtitleData) {
  const fullPath = path.join(config.SUBTITLES_DIR, subtitlePath);
  const dir = path.dirname(fullPath);
  
  // Ensure directory exists
  await fs.mkdir(dir, { recursive: true });
  
  // Write JSON file with pretty formatting (2 spaces indent)
  const jsonContent = JSON.stringify(subtitleData, null, 2);
  await fs.writeFile(fullPath, jsonContent, 'utf-8');
  
  console.log(`[subtitle-generator] Saved subtitle file: ${fullPath}`);
  
  return subtitlePath;
}

module.exports = {
  getMovieSubtitlePath,
  getEpisodeSubtitlePath,
  saveSubtitleFile
};

