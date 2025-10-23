const path = require('path');

function isVideoFile(name) {
  const ext = path.extname(name).toLowerCase();
  return [
    '.mp4',
    '.mkv',
    '.mov',
    '.avi',
    '.m4v',
    '.webm',
    '.mpg',
    '.mpeg',
    '.ts'
  ].includes(ext);
}

function stripExtension(name) {
  return name.replace(/\.[^.]+$/, '');
}

function inferEpisodeNumber(name) {
  const lower = name.toLowerCase();
  const seasonEpisode = lower.match(/s(\d+)[ ._-]*e(\d+)/);
  if (seasonEpisode) return parseInt(seasonEpisode[2], 10);
  const epMatch = lower.match(/episode[ ._-]*(\d+)/);
  if (epMatch) return parseInt(epMatch[1], 10);
  const digits = lower.match(/(\d+)/);
  return digits ? parseInt(digits[1], 10) : null;
}

function inferSeasonNumber(label) {
  const match = label.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

module.exports = {
  isVideoFile,
  stripExtension,
  inferEpisodeNumber,
  inferSeasonNumber
};
