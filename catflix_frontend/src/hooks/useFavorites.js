import { useState } from 'react';
import { FAVORITES_KEY } from '../constants';
import { favoriteKeyFor } from '../utils/parsers';
import { loadFromStorage, saveToStorage } from '../utils/storage';

export function useFavorites() {
  const [favorites, setFavorites] = useState([]);

  const loadFavorites = () => {
    const list = loadFromStorage(FAVORITES_KEY, []);
    if (Array.isArray(list)) setFavorites(list);
  };

  const saveFavorites = (list) => {
    saveToStorage(FAVORITES_KEY, list);
  };

  const isFavorite = (item) => favorites.includes(favoriteKeyFor(item));

  const toggleFavorite = (item, e) => {
    if (e) e.stopPropagation();
    const key = favoriteKeyFor(item);
    setFavorites(prev => {
      const has = prev.includes(key);
      const next = has ? prev.filter(k => k !== key) : [key, ...prev];
      saveFavorites(next);
      return next;
    });
  };

  return {
    favorites,
    loadFavorites,
    isFavorite,
    toggleFavorite
  };
}

