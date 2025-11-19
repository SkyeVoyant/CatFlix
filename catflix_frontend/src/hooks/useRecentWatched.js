import { useState, useCallback } from 'react';
import { RECENT_KEY, HIDDEN_RECENTS_KEY } from '../constants';
import { loadFromStorage, saveToStorage } from '../utils/storage';

export function useRecentWatched() {
  const [recent, setRecent] = useState([]);
  const [hiddenRecents, setHiddenRecents] = useState([]);

  const loadRecent = () => {
    const list = loadFromStorage(RECENT_KEY, []);
    if (Array.isArray(list)) {
      setRecent(list);
    }
  };

  const loadHiddenRecents = () => {
    const list = loadFromStorage(HIDDEN_RECENTS_KEY, []);
    if (Array.isArray(list)) setHiddenRecents(list);
  };

  const saveHiddenRecents = (list) => {
    saveToStorage(HIDDEN_RECENTS_KEY, list);
  };

  const upsertRecent = useCallback(({ src, info, stoppedAt }) => {
    const updatedAt = Date.now();
    const key = info.type === 'show' ? `show:${info.showTitle}` : `movie:${info.movieTitle}`;
    setRecent(prev => {
      const base = Array.isArray(prev) ? prev : [];
      const next = base.filter(e => e.key !== key);
      next.unshift({ key, src, ...info, stoppedAt, updatedAt });
      const trimmed = next.slice(0, 100);
      saveToStorage(RECENT_KEY, trimmed);
      return trimmed;
    });
  }, []);

  const hideRecentByKey = (key) => {
    setHiddenRecents(prev => {
      if (prev.includes(key)) return prev;
      const next = [key, ...prev].slice(0, 500);
      saveHiddenRecents(next);
      return next;
    });
  };

  const unhideRecentByKey = useCallback((key) => {
    setHiddenRecents(prev => {
      if (!prev.includes(key)) return prev;
      const next = prev.filter(k => k !== key);
      saveHiddenRecents(next);
      return next;
    });
  }, []);

  return {
    recent,
    hiddenRecents,
    loadRecent,
    loadHiddenRecents,
    upsertRecent,
    hideRecentByKey,
    unhideRecentByKey
  };
}

