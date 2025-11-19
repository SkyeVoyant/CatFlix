/**
 * Parse video source URL to extract media information
 */
export function parseFromSrc(src, title) {
  try {
    const parts = src.split('/').map(decodeURIComponent);
    if (parts[2] === 'movies') {
      const movieTitle = parts[3];
      return { type: 'movie', movieTitle };
    }
    if (parts[2] === 'shows') {
      const showTitle = parts[3];
      const season = parts[4];
      const episodeSegments = parts.slice(5).filter(Boolean);
      let episodeTitle = title || '';
      if (!episodeTitle) {
        const base = episodeSegments[0] || '';
        episodeTitle = base.replace(/hls files.*/i, '').trim() || base;
      }
      return { type: 'show', showTitle, season, episodeTitle };
    }
  } catch {}
  return { type: 'movie', movieTitle: title || src };
}

/**
 * Generate a unique key for favorites/recents
 */
export function favoriteKeyFor(itemOrType, maybeTitle) {
  if (typeof itemOrType === 'string') {
    // given type and title
    return itemOrType === 'show' ? `show:${maybeTitle}` : `movie:${maybeTitle}`;
  }
  const item = itemOrType;
  return item.type === 'show' ? `show:${item.title}` : `movie:${item.title}`;
}

