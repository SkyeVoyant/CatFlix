import React from 'react';
import { MediaCard } from '../cards/MediaCard';

export function RecentlyAddedSection({ 
  movies, 
  shows, 
  passesFilters, 
  isFavorite, 
  toggleFavorite, 
  onShowDetail 
}) {
  const withAdded = [
    ...movies.filter(m => Number.isFinite(m.addedAt)).map(m => ({...m, _t: m.addedAt})),
    ...shows.filter(s => Number.isFinite(s.addedAt)).map(s => ({...s, _t: s.addedAt}))
  ].filter(item => passesFilters(item));
  
  withAdded.sort((a,b) => (b._t||0) - (a._t||0));
  const recent10 = withAdded.slice(0, 10);

  if (recent10.length === 0) return null;

  return (
    <>
      <div className="section-title">Recently Added</div>
      <section className="section">
        <div className="row">
          {recent10.map(item => (
            <MediaCard
              key={`added-${item.type}-${item.title}`}
              item={item}
              isFavorite={isFavorite(item)}
              onToggleFavorite={(e) => toggleFavorite(item, e)}
              onClick={() => onShowDetail(item)}
            />
          ))}
        </div>
      </section>
    </>
  );
}

