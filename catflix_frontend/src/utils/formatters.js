/**
 * Format seconds to human-readable time string (H:MM:SS or M:SS)
 */
export function formatTime(sec) {
  if (!isFinite(sec) || sec <= 0) return '0:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = m.toString().padStart(2, '0');
  const ss = r.toString().padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/**
 * Extract episode number from episode title string
 */
export function extractEpisodeNumber(text) {
  if (!text) return null;
  const m = text.match(/\d+/);
  return m ? `Episode ${m[0]}` : null;
}

