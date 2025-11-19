import { useState, useEffect, useCallback, useRef } from 'react';

export function useMediaData() {
  const [movies, setMovies] = useState([]);
  const [shows, setShows] = useState([]);
  const [genres, setGenres] = useState([]);
  const [releaseOptions, setReleaseOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const wsRef = useRef(null);

  const normalizeItem = useCallback((entityType, payload) => {
    return entityType === 'movie'
      ? {
          ...payload,
          type: 'movie',
          parts: Array.isArray(payload.parts)
            ? payload.parts.map((part, idx) => ({
                id: part.id ?? idx,
                title: part.title,
                src: part.src
              }))
            : []
        }
      : {
          ...payload,
          type: 'show',
          seasons: Array.isArray(payload.seasons)
            ? payload.seasons.map((season, sIdx) => ({
                id: season.id ?? sIdx,
                season: season.season,
                episodes: Array.isArray(season.episodes)
                  ? season.episodes.map((ep, eIdx) => ({
                      id: ep.id ?? eIdx,
                      title: ep.title,
                      src: ep.src,
                      previewSrc: ep.previewSrc
                    }))
                  : []
              }))
            : []
        };
  }, []);

  const updateGenresAndReleases = useCallback((moviesList, showsList) => {
    const all = [...moviesList, ...showsList];
    
    // Build genre list
    const genreSet = new Set();
    all.forEach(item => {
      if (item.meta?.genres) item.meta.genres.forEach(g => genreSet.add(g.name));
    });
    setGenres([...genreSet].sort());
    
    // Build release decade options
    const yearsSet = new Set();
    all.forEach(item => {
      if (item.meta) {
        const dateStr = item.meta.release_date || item.meta.first_air_date;
        if (dateStr) {
          const yearNum = parseInt(dateStr.slice(0, 4), 10);
          if (!isNaN(yearNum)) yearsSet.add(Math.floor(yearNum / 10) * 10);
        }
      }
    });
    const decades = [...yearsSet].sort((a, b) => b - a).map(d => `${d}s`);
    setReleaseOptions(decades);
  }, []);

  const fetchMetadata = useCallback(async (item, metaType) => {
    try {
      const metaRes = await fetch(`/api/metadata?title=${encodeURIComponent(item.title)}&type=${metaType}`, { credentials: 'include' });
      if (metaRes.ok) {
        const meta = await metaRes.json();
        return { ...item, meta };
      }
    } catch (err) {
      console.error(`[meta] Failed to fetch metadata for ${item.title}`);
    }
    return { ...item, meta: null };
  }, []);

  useEffect(() => {
    // Connect to WebSocket and stream items one by one
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/manifest`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    
    ws.onopen = () => {
      console.log('[ws] Connected - streaming items...');
    };
    
    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        
        if (msg.type === 'sync') {
          if (msg.phase === 'start') {
            console.log('[ws] Loading from DB...');
            setLoading(true);
          } else if (msg.phase === 'complete') {
            console.log('[ws] Stream complete');
            setLoading(false);
          } else if (msg.phase === 'error') {
            console.error('[ws] Sync error:', msg.error);
            setLoading(false);
          }
        } else if (msg.type === 'event') {
          // Item received - display immediately
          const { action, entityType, payload } = msg.event;
          
          if (action === 'upsert') {
            const normalized = normalizeItem(entityType, payload);
            const metaType = entityType === 'movie' ? 'movie' : 'tv';
            const withMeta = await fetchMetadata(normalized, metaType);
            
            if (entityType === 'movie') {
              setMovies(prev => {
                const newMovies = [...prev.filter(m => m.id !== withMeta.id), withMeta];
                setShows(currentShows => {
                  updateGenresAndReleases(newMovies, currentShows);
                  return currentShows;
                });
                return newMovies;
              });
            } else {
              setShows(prev => {
                const newShows = [...prev.filter(s => s.id !== withMeta.id), withMeta];
                setMovies(currentMovies => {
                  updateGenresAndReleases(currentMovies, newShows);
                  return currentMovies;
                });
                return newShows;
              });
            }
          } else if (action === 'delete') {
            const itemId = payload.id;
            const delEntityType = payload.entityType;
            
            if (delEntityType === 'movie') {
              setMovies(prev => {
                const newMovies = prev.filter(m => m.id !== itemId);
                setShows(currentShows => {
                  updateGenresAndReleases(newMovies, currentShows);
                  return currentShows;
                });
                return newMovies;
              });
            } else {
              setShows(prev => {
                const newShows = prev.filter(s => s.id !== itemId);
                setMovies(currentMovies => {
                  updateGenresAndReleases(currentMovies, newShows);
                  return currentMovies;
                });
                return newShows;
              });
            }
          }
        }
      } catch (err) {
        console.error('[ws] Failed to process message:', err);
      }
    };
    
    ws.onerror = (err) => {
      console.error('[ws] WebSocket error:', err);
      setLoading(false);
    };
    
    ws.onclose = () => {
      console.log('[ws] Disconnected');
      setLoading(false);
    };
    
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [normalizeItem, updateGenresAndReleases, fetchMetadata]);

  return {
    movies,
    shows,
    genres,
    releaseOptions,
    loading
  };
}
