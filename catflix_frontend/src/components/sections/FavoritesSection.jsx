import React from 'react';
import { MediaCard } from '../cards/MediaCard';
import { favoriteKeyFor } from '../../utils/parsers';

export function FavoritesSection({ 
  favorites, 
  movies, 
  shows, 
  passesFilters, 
  isFavorite, 
  toggleFavorite, 
  onShowDetail 
}) {
  const favItems = [];
  for (const key of favorites) {
    const [type, title] = key.split(':');
    let base;
    if (type === 'movie') base = movies.find(m => m.title === title);
    if (type === 'show') base = shows.find(s => s.title === title);
    if (!base) continue;
    if (!passesFilters(base)) continue;
    favItems.push(base);
  }
  favItems.sort((a, b) => a.title.localeCompare(b.title));

  if (favItems.length === 0) return null;

  return (
    <>
      <div className="section-title">Favorites</div>
      <section className="section">
        <div className="row">
          {favItems.map(item => (
            <MediaCard
              key={`fav-${item.type}-${item.title}`}
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

