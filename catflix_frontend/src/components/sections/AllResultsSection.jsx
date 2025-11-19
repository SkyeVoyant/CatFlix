import React from 'react';
import { MediaCard } from '../cards/MediaCard';

export function AllResultsSection({ 
  filteredMedia, 
  isFavorite, 
  toggleFavorite, 
  onShowDetail 
}) {
  return (
    <>
      <div className="section-title">All Results</div>
      <section className="section">
        <div className="row">
          {filteredMedia.map(item => (
            <MediaCard
              key={item.title}
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

