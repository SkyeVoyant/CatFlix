import React from 'react';
import { RecentCard } from '../cards/RecentCard';

export function RecentlyWatchedSection({ 
  recent, 
  movies, 
  shows, 
  hiddenRecents, 
  passesFilters, 
  isFavorite, 
  toggleFavorite, 
  hideRecentByKey, 
  onShowDetail,
  onResumeVideo
}) {
  const recentItems = [];
  for (const entry of (recent || [])) {
    let base;
    if (entry.type === 'movie') {
      base = movies.find(m => m.title === entry.movieTitle);
    } else if (entry.type === 'show') {
      base = shows.find(s => s.title === entry.showTitle);
    }
    if (!base) continue;
    if (hiddenRecents.includes(entry.key)) continue;
    if (!passesFilters(base)) continue;
    recentItems.push({ ...base, recent: entry });
    if (recentItems.length >= 10) break;
  }

  if (recentItems.length === 0) return null;

  return (
    <>
      <div className="section-title">Recently Watched</div>
      <section className="section">
        <div className="row">
          {recentItems.map(item => (
            <RecentCard
              key={`recent-${item.recent.key}`}
              item={item}
              isFavorite={isFavorite(item)}
              onToggleFavorite={(e) => toggleFavorite(item, e)}
              onHide={() => hideRecentByKey(item.recent.key)}
              onClick={() => onShowDetail(item)}
              onResume={() => onResumeVideo(item)}
            />
          ))}
        </div>
      </section>
    </>
  );
}

