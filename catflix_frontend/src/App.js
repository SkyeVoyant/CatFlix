import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import Hls from 'hls.js';
import './App.css';

const SESSION_KEY = 'catflix_session_token_v1';

// Translate TV and movie ratings to standardized format with full descriptions
function translateRating(rating) {
  if (!rating) return null;
  
  const ratingMap = {
    // TV Ratings
    'TV-Y': { short: 'G', full: 'General Audiences' },
    'TV-Y7': { short: 'G', full: 'General Audiences' },
    'TV-G': { short: 'G', full: 'General Audiences' },
    'TV-PG': { short: 'PG', full: 'Parental Guidance Suggested' },
    'TV-14': { short: 'PG-13', full: 'Parents Strongly Cautioned' },
    'TV-MA': { short: 'R', full: 'Restricted' },
    
    // Movie Ratings (pass through with descriptions)
    'G': { short: 'G', full: 'General Audiences' },
    'PG': { short: 'PG', full: 'Parental Guidance Suggested' },
    'PG-13': { short: 'PG-13', full: 'Parents Strongly Cautioned' },
    'R': { short: 'R', full: 'Restricted' },
    'NC-17': { short: 'NC-17', full: 'Adults Only' },
    'NR': { short: 'NR', full: 'Not Rated' },
    'UR': { short: 'UR', full: 'Unrated' }
  };
  
  const translated = ratingMap[rating];
  if (translated) {
    return `${translated.short} (${translated.full})`;
  }
  
  // If not in map, return as-is
  return rating;
}

function App() {
  const [movies, setMovies] = useState([]);
  const [shows, setShows] = useState([]);
  const [genres, setGenres] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [showDetail, setShowDetail] = useState(null);
  const [typeFilter, setTypeFilter] = useState({ movie: false, show: false });
  const [genreFilter, setGenreFilter] = useState([]);
  const [releaseOptions, setReleaseOptions] = useState([]);
  const [releaseFilter, setReleaseFilter] = useState('');
  const [sortOption, setSortOption] = useState('Title A-Z');
  const [searchTerm, setSearchTerm] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [openDropdown, setOpenDropdown] = useState(null);
  const [subtitleUrl, setSubtitleUrl] = useState(null);
  const [recent, setRecent] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [hiddenRecents, setHiddenRecents] = useState([]);
  const [nextUp, setNextUp] = useState(null);
  const [movieDownloadStatus, setMovieDownloadStatus] = useState({});
  const [seasonDownloadStatus, setSeasonDownloadStatus] = useState({});
  const [showNextOverlay, setShowNextOverlay] = useState(false);
  const videoRef = useRef(null);
  const hlsInstanceRef = useRef(null);
  const lastRecentSaveRef = useRef(0);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const moviesMapRef = useRef(new Map());
  const showsMapRef = useRef(new Map());
  const metaCacheRef = useRef(new Map());
  const pendingMetaRef = useRef(new Set());
  const sortOptions = [
    'Title A-Z',
    'Title Z-A',
    'Release Date (Newest)',
    'Release Date (Oldest)'
  ];

  const RECENT_KEY = 'recently_watched_v1';
  const FAVORITES_KEY = 'favorites_v1';
  const HIDDEN_RECENTS_KEY = 'recent_hidden_v1';

  const loadRecent = () => {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const list = raw ? JSON.parse(raw) : [];
      if (Array.isArray(list)) {
        setRecent(list);
      }
    } catch {}
  };

  

  const loadFavorites = () => {
    try {
      const raw = localStorage.getItem(FAVORITES_KEY);
      const list = raw ? JSON.parse(raw) : [];
      if (Array.isArray(list)) setFavorites(list);
    } catch {}
  };

  const saveFavorites = (list) => {
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(list)); } catch {}
  };

  const loadHiddenRecents = () => {
    try {
      const raw = localStorage.getItem(HIDDEN_RECENTS_KEY);
      const list = raw ? JSON.parse(raw) : [];
      if (Array.isArray(list)) setHiddenRecents(list);
    } catch {}
  };

  const saveHiddenRecents = (list) => {
    try { localStorage.setItem(HIDDEN_RECENTS_KEY, JSON.stringify(list)); } catch {}
  };

  const favoriteKeyFor = (itemOrType, maybeTitle) => {
    if (typeof itemOrType === 'string') {
      // given type and title
      return itemOrType === 'show' ? `show:${maybeTitle}` : `movie:${maybeTitle}`;
    }
    const item = itemOrType;
    return item.type === 'show' ? `show:${item.title}` : `movie:${item.title}`;
  };
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

  const alphaSort = useCallback(
    (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }),
    []
  );

  const syncStateFromMaps = useCallback(() => {
    const sortedMovies = Array.from(moviesMapRef.current.values()).sort(alphaSort);
    const sortedShows = Array.from(showsMapRef.current.values()).sort(alphaSort);
    setMovies(sortedMovies);
    setShows(sortedShows);
  }, [alphaSort]);

  const parseFromSrc = (src, title) => {
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
  };

  const ensureMetadata = useCallback((item) => {
    if (!item?.title) return;
    const key = `${item.type}:${item.title}`;
    if (metaCacheRef.current.has(key) || pendingMetaRef.current.has(key)) return;
    pendingMetaRef.current.add(key);
    const typeParam = item.type === 'show' ? 'tv' : 'movie';
    fetch(`/api/metadata?title=${encodeURIComponent(item.title)}&type=${typeParam}`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((meta) => {
        pendingMetaRef.current.delete(key);
        metaCacheRef.current.set(key, meta);
        const map = item.type === 'show' ? showsMapRef.current : moviesMapRef.current;
        if (map.has(item.title)) {
          map.set(item.title, { ...map.get(item.title), meta });
          syncStateFromMaps();
        }
      });
  }, [syncStateFromMaps]);

  const applyUpsertEvent = useCallback((payload, entityType) => {
    if (!payload?.title) return;
    const normalizedType = entityType === 'show' || payload.type === 'show' ? 'show' : 'movie';
    const normalized = {
      ...payload,
      type: normalizedType
    };
    if (normalizedType === 'movie') {
      normalized.parts = Array.isArray(normalized.parts) ? normalized.parts : [];
    } else {
      normalized.seasons = Array.isArray(normalized.seasons) ? normalized.seasons : [];
    }
    const metaKey = `${normalized.type}:${normalized.title}`;
    if (metaCacheRef.current.has(metaKey)) {
      normalized.meta = metaCacheRef.current.get(metaKey);
    }
    const map = normalizedType === 'show' ? showsMapRef.current : moviesMapRef.current;
    map.set(normalized.title, normalized);
    syncStateFromMaps();
    ensureMetadata(normalized);
  }, [ensureMetadata, syncStateFromMaps]);

  const applyDeleteEvent = useCallback((title, entityType) => {
    if (!title) return;
    const normalizedType = entityType === 'show' ? 'show' : 'movie';
    const map = normalizedType === 'show' ? showsMapRef.current : moviesMapRef.current;
    if (map.delete(title)) {
      syncStateFromMaps();
    }
  }, [syncStateFromMaps]);

  const handleManifestEvent = useCallback((event) => {
    if (!event) return;
    if (event.action === 'upsert') {
      applyUpsertEvent(event.payload, event.entityType);
    } else if (event.action === 'delete') {
      applyDeleteEvent(event.title, event.entityType);
    }
  }, [applyUpsertEvent, applyDeleteEvent]);

  const upsertRecent = useCallback(({ src, info, stoppedAt }) => {
    const updatedAt = Date.now();
    const key = info.type === 'show' ? `show:${info.showTitle}` : `movie:${info.movieTitle}`;
    setRecent(prev => {
      const base = Array.isArray(prev) ? prev : [];
      const next = base.filter(e => e.key !== key);
      next.unshift({ key, src, ...info, stoppedAt, updatedAt });
      const trimmed = next.slice(0, 100);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(trimmed)); } catch {}
      return trimmed;
    });
  }, []);

  const passesFilters = (item) => {
    if ((typeFilter.movie || typeFilter.show) && !typeFilter[item.type]) return false;
    if (genreFilter.length > 0 && !item.meta?.genres?.some(g => genreFilter.includes(g.name))) return false;
    if (releaseFilter) {
      const dateStr = item.meta?.release_date || item.meta?.first_air_date;
      if (!dateStr) return false;
      const year = parseInt(dateStr.slice(0, 4), 10) || 0;
      if (`${Math.floor(year / 10) * 10}s` !== releaseFilter) return false;
    }
    if (searchTerm && !item.title.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    return true;
  };

  const formatTime = (sec) => {
    if (!isFinite(sec) || sec <= 0) return '0:00';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const mm = m.toString().padStart(2, '0');
    const ss = r.toString().padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  };

  const extractEpisodeNumber = (text) => {
    if (!text) return null;
    const m = text.match(/\d+/);
    return m ? `Episode ${m[0]}` : null;
  };

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const getMovieId = (movie) => movie?.id ?? null;
  const getSeasonId = (season) => season?.id ?? null;
  const getMovieDownloadLabel = (movie, part) => `${movie?.title || part?.title || 'Movie'}.mp4`;
  const getEpisodeDownloadLabel = (descriptor, fallbackId) => `${descriptor || `Episode-${fallbackId || ''}`}.mp4`;

  const runMovieDownload = async (movie) => {
    if (!movie || !movie.id || !Array.isArray(movie.parts) || movie.parts.length === 0) return;
    const movieId = getMovieId(movie);
    const part = movie.parts[0];
    setMovieDownloadStatus((prev) => ({ ...prev, [movieId]: 'loading' }));
    try {
      const prepareRes = await fetch(`/api/downloads/movies/${movieId}/prepare`, {
        method: 'POST',
        credentials: 'include'
      });
      if (!prepareRes.ok) throw new Error('Failed to prepare movie download');
      setMovieDownloadStatus((prev) => ({ ...prev, [movieId]: 'downloading' }));
      const link = document.createElement('a');
      link.href = `/api/downloads/movies/${movieId}/file`;
      link.download = getMovieDownloadLabel(movie, part);
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => {
        setMovieDownloadStatus((prev) => ({ ...prev, [movieId]: 'idle' }));
      }, 2000);
    } catch (err) {
      console.error('[movie download] failed', err);
      alert('Failed to download movie. Please try again.');
      setMovieDownloadStatus((prev) => ({ ...prev, [movieId]: 'idle' }));
    }
  };

  const runSeasonDownload = async (show, seasonObj) => {
    if (!show || !show.id || !seasonObj || !seasonObj.id) return;
    const seasonId = getSeasonId(seasonObj);
    const episodes = Array.isArray(seasonObj.episodes) ? seasonObj.episodes : [];
    if (episodes.length === 0) return;

    setSeasonDownloadStatus((prev) => ({ ...prev, [seasonId]: 'loading' }));
    try {
      setSeasonDownloadStatus((prev) => ({ ...prev, [seasonId]: 'downloading' }));
      for (const episode of episodes) {
        if (!episode || episode.id == null) continue;
        try {
          const prepareEpisode = await fetch(`/api/downloads/episodes/${episode.id}/prepare`, {
            method: 'POST',
            credentials: 'include'
          });
          if (!prepareEpisode.ok) throw new Error('prepare_failed');
          const link = document.createElement('a');
          link.href = `/api/downloads/episodes/${episode.id}/file`;
          link.download = getEpisodeDownloadLabel(episode.descriptor || episode.title, episode.id);
          link.style.display = 'none';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          await delay(800);
        } catch (episodeErr) {
          console.error('[season download episode] failed', episodeErr);
        }
      }
      setTimeout(() => {
        setSeasonDownloadStatus((prev) => ({ ...prev, [seasonId]: 'idle' }));
      }, 2000);
    } catch (err) {
      console.error('[season download] failed', err);
      alert('Failed to download season. Please try again.');
      setSeasonDownloadStatus((prev) => ({ ...prev, [seasonId]: 'idle' }));
    }
  };

  const renderCastList = (meta) => {
    const cast = Array.isArray(meta?.credits?.cast)
      ? meta.credits.cast
          .filter((member) => member && member.name)
          .sort((a, b) => {
            const orderA = Number.isFinite(a.order) ? a.order : 999;
            const orderB = Number.isFinite(b.order) ? b.order : 999;
            return orderA - orderB;
          })
          .slice(0, 12)
      : [];
    if (!cast.length) return null;
    return (
      <div className="cast-section">
        <h3>Cast:</h3>
        <ul>
          {cast.map((member) => (
            <li key={member.credit_id || member.id || member.name}>
              <strong>{member.name}</strong>
              {member.character ? ` as ${member.character}` : ''}
            </li>
          ))}
        </ul>
      </div>
    );
  };

  const getVideoHeaderTitle = () => {
    try {
      if (!selectedVideo) return 'Catflix';
      const info = parseFromSrc(selectedVideo.src, selectedVideo.title);
      if (info.type === 'show') return `${info.showTitle} - ${info.season} - ${info.episodeTitle}`;
      if (info.type === 'movie') return info.movieTitle;
    } catch {}
    return 'Catflix';
  };

  // Navigate to home (close video or detail popups) and capture progress
  const goHome = () => {
    try {
      if (selectedVideo && videoRef.current) {
        const info = parseFromSrc(selectedVideo.src, selectedVideo.title);
        const t = videoRef.current.currentTime || 0;
        upsertRecent({ src: selectedVideo.src, info, stoppedAt: t });
      }
    } catch {}
    setSelectedVideo(null);
    setShowDetail(null);
  };

  const handleLogout = useCallback(() => {
    try { localStorage.removeItem(SESSION_KEY); } catch {}
    fetch('/auth/logout', { method: 'POST', credentials: 'include' })
      .finally(() => {
        window.location.reload();
      });
  }, []);

  useEffect(() => {
    loadRecent();
    loadFavorites();
    loadHiddenRecents();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const handleSocketMessage = (data) => {
      if (!data) return;
      if (data.type === 'sync') {
        if (data.phase === 'start') {
          moviesMapRef.current = new Map();
          showsMapRef.current = new Map();
          syncStateFromMaps();
          setLoading(true);
        } else if (data.phase === 'complete' || data.phase === 'error') {
          setLoading(false);
        }
        return;
      }
      const events = [];
      if (data.type === 'batch' && Array.isArray(data.events)) {
        events.push(...data.events);
      } else if (data.type === 'event' && data.event) {
        events.push(data.event);
      }
      events.forEach(handleManifestEvent);
    };

    function connect() {
      if (cancelled) return;
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${protocol}://${window.location.host}/ws/manifest`);
      wsRef.current = socket;
      socket.onopen = () => {
        if (!cancelled) {
          setLoading(true);
        }
      };
      socket.onmessage = (event) => {
        if (cancelled) return;
        try {
          const payload = JSON.parse(event.data);
          handleSocketMessage(payload);
        } catch (err) {
          console.error('[ws] failed to parse message', err);
        }
      };
      socket.onerror = () => {
        socket.close();
      };
      socket.onclose = () => {
        if (cancelled) return;
        setLoading(false);
        reconnectTimerRef.current = setTimeout(connect, 3000);
      };
    }

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        try { wsRef.current.close(); } catch (_) {}
      }
    };
  }, [handleManifestEvent, syncStateFromMaps]);

  useEffect(() => {
    const allItems = [...movies, ...shows];
    const genreSet = new Set();
    allItems.forEach(item => {
      if (item.meta?.genres) {
        item.meta.genres.forEach(g => genreSet.add(g.name));
      }
    });
    setGenres([...genreSet].sort());
    const yearsSet = new Set();
    allItems.forEach(item => {
      const dateStr = item.meta?.release_date || item.meta?.first_air_date;
      if (!dateStr) return;
      const yearNum = parseInt(dateStr.slice(0, 4), 10);
      if (!isNaN(yearNum)) {
        yearsSet.add(Math.floor(yearNum / 10) * 10);
      }
    });
    const decades = [...yearsSet].sort((a, b) => b - a).map(d => `${d}s`);
    setReleaseOptions(decades);
  }, [movies, shows]);

  // Configure video element for MP4/HLS playback
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    if (!selectedVideo || !selectedVideo.src) {
      if (hlsInstanceRef.current) {
        try { hlsInstanceRef.current.destroy(); } catch {}
        hlsInstanceRef.current = null;
      }
      videoEl.removeAttribute('src');
      videoEl.load();
      return;
    }
    const src = selectedVideo.src;
    const isHls = /\.m3u8(\?|$)/i.test(src);
    if (hlsInstanceRef.current) {
      try { hlsInstanceRef.current.destroy(); } catch {}
      hlsInstanceRef.current = null;
    }
    if (isHls && !videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true });
        hlsInstanceRef.current = hls;
        hls.loadSource(src);
        hls.attachMedia(videoEl);
        hls.on(Hls.Events.ERROR, (event, data) => {
          if (data?.fatal) {
            console.error('[HLS] Fatal error', data);
            try { hls.destroy(); } catch {}
            hlsInstanceRef.current = null;
          }
        });
      } else {
        videoEl.src = src;
      }
    } else {
      videoEl.src = src;
      videoEl.load();
    }
    return () => {
      if (hlsInstanceRef.current) {
        try { hlsInstanceRef.current.destroy(); } catch {}
        hlsInstanceRef.current = null;
      }
    };
  }, [selectedVideo]);

  // Update subtitle URL when selectedVideo changes
  useEffect(() => {
    if (!selectedVideo) {
      setSubtitleUrl(null);
      return;
    }
    axios.get(`/api/subtitle-file?src=${encodeURIComponent(selectedVideo.src)}`, { withCredentials: true })
      .then(res => setSubtitleUrl(res.data.url))
      .catch(() => setSubtitleUrl(null));
  }, [selectedVideo, upsertRecent]);

  // Capture progress when page/tab is hidden or about to unload
  useEffect(() => {
    const handler = () => {
      try {
        if (document.visibilityState === 'hidden' && selectedVideo && videoRef.current) {
          const info = parseFromSrc(selectedVideo.src, selectedVideo.title);
          const t = videoRef.current.currentTime || 0;
          upsertRecent({ src: selectedVideo.src, info, stoppedAt: t });
        }
      } catch {}
    };
    document.addEventListener('visibilitychange', handler);
    window.addEventListener('pagehide', handler);
    return () => {
      document.removeEventListener('visibilitychange', handler);
      window.removeEventListener('pagehide', handler);
    };
  }, [selectedVideo, upsertRecent]);

  // Persist volume & resume position, and autoplay when video loads
  useEffect(() => {
    if (!selectedVideo) return;
    const v = videoRef.current;
    if (!v) return;
    // Load stored volume
    const storedVol = parseFloat(localStorage.getItem('volume') || '1');
    v.volume = storedVol;
    // Load stored resume position
    const resumeKey = `resume_${selectedVideo.src}`;
    const storedTime = parseFloat(localStorage.getItem(resumeKey) || '0');
    const onLoaded = () => {
      if (!isNaN(storedTime) && storedTime > 0 && storedTime < v.duration) {
        v.currentTime = storedTime;
      }
      // Ensure captions option appears in native controls by loading text track as hidden
      const tracks = v.textTracks;
      for (let i = 0; i < tracks.length; i++) {
        tracks[i].mode = 'hidden';
      }
      v.play();
      // Precompute next episode for overlay/autoplay
      try {
        const info = parseFromSrc(selectedVideo.src, selectedVideo.title);
        // If user is re-watching an item hidden from recents, unhide it
        const key = info.type === 'show' ? `show:${info.showTitle}` : `movie:${info.movieTitle}`;
        if (hiddenRecents.includes(key)) {
          unhideRecentByKey(key);
        }
        if (info.type === 'show') {
          const show = shows.find(s => s.title === info.showTitle);
          const seasonObj = show?.seasons?.find(se => se.season === info.season);
          if (seasonObj && Array.isArray(seasonObj.episodes)) {
            const sorted = [...seasonObj.episodes].sort((a, b) => {
              const getNum = t => { const m = (t || '').match(/\d+/); return m ? parseInt(m[0], 10) : 0; };
              return getNum(a.title) - getNum(b.title);
            });
            const idx = sorted.findIndex(e => e.src === selectedVideo.src);
            if (idx >= 0 && idx + 1 < sorted.length) {
              const nxt = sorted[idx + 1];
              setNextUp({ src: nxt.src, title: `${show.title} - ${nxt.title}` });
            } else {
              setNextUp(null);
            }
          }
        } else {
          setNextUp(null);
        }
      } catch { setNextUp(null); }
    };
    lastRecentSaveRef.current = 0;
    const onTimeUpdate = () => {
      localStorage.setItem(resumeKey, v.currentTime);
      const now = Date.now();
      if (!lastRecentSaveRef.current || now - lastRecentSaveRef.current > 5000) {
        try {
          const info = parseFromSrc(selectedVideo.src, selectedVideo.title);
          const t = v.currentTime || 0;
          upsertRecent({ src: selectedVideo.src, info, stoppedAt: t });
          lastRecentSaveRef.current = now;
        } catch {}
      }
      // Show next overlay with 30s left
      try {
        if (nextUp && isFinite(v.duration) && v.duration - v.currentTime <= 30) {
          if (!showNextOverlay) setShowNextOverlay(true);
        } else if (showNextOverlay) {
          setShowNextOverlay(false);
        }
      } catch {}
    };
    const onCapture = () => {
      const info = parseFromSrc(selectedVideo.src, selectedVideo.title);
      const t = v.currentTime || 0;
      upsertRecent({ src: selectedVideo.src, info, stoppedAt: t });
    };
    const onEnded = () => {
      onCapture();
      try {
        if (nextUp) setSelectedVideo(nextUp);
      } catch {}
    };
    const onVolumeChange = () => localStorage.setItem('volume', v.volume);

    const getBufferedAhead = () => {
      try {
        const ct = v.currentTime || 0;
        for (let i = 0; i < v.buffered.length; i++) {
          const start = v.buffered.start(i);
          const end = v.buffered.end(i);
          if (ct >= start && ct <= end) {
            return Math.max(0, end - ct);
          }
        }
      } catch {}
      return 0;
    };
    const nudgePlayback = () => {
      try {
        const ahead = getBufferedAhead();
        if (ahead > 1) {
          if (v.paused) {
            v.play().catch(() => {});
          } else {
            // Gentle rate wobble to kick decoder without seeking (avoids control popup)
            const original = v.playbackRate;
            if (Math.abs(original - 1) < 0.02) {
              v.playbackRate = 1.01;
              setTimeout(() => { try { v.playbackRate = original; } catch {} }, 200);
            }
          }
        }
      } catch {}
    };
    const onWaiting = () => nudgePlayback();
    const onStalled = () => nudgePlayback();
    const watchdog = setInterval(() => {
      if (!v.paused && v.readyState >= 2) {
        // If we have buffered data ahead but are stuck, nudge
        nudgePlayback();
      }
    }, 4000);
    v.addEventListener('loadedmetadata', onLoaded);
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('pause', onCapture);
    v.addEventListener('ended', onEnded);
    v.addEventListener('volumechange', onVolumeChange);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('stalled', onStalled);
    return () => {
      v.removeEventListener('loadedmetadata', onLoaded);
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('pause', onCapture);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('volumechange', onVolumeChange);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('stalled', onStalled);
      clearInterval(watchdog);
    };
  }, [selectedVideo, upsertRecent, shows, nextUp, showNextOverlay, hiddenRecents, unhideRecentByKey]);

  const toggleType = t => setTypeFilter(prev => ({ ...prev, [t]: !prev[t] }));
  const toggleGenre = g => setGenreFilter(prev => prev.includes(g) ? [] : [g]);
  const toggleDropdown = name => setOpenDropdown(prev => prev === name ? null : name);
  const closeAllDropdowns = () => setOpenDropdown(null);

  const clearFilters = () => {
    setTypeFilter({ movie: false, show: false });
    setGenreFilter([]);
    setReleaseFilter('');
    setSortOption('Title A-Z');
    setSearchTerm('');
    setSearchInput('');
    closeAllDropdowns();
  };

  const filteredMedia = [...movies, ...shows]
    .filter(item => (!typeFilter.movie && !typeFilter.show) || typeFilter[item.type])
    .filter(item => genreFilter.length === 0 || item.meta?.genres?.some(g => genreFilter.includes(g.name)))
    .filter(item => {
      if (!releaseFilter) return true;
      const dateStr = item.meta?.release_date || item.meta?.first_air_date;
      if (!dateStr) return false;
      const year = parseInt(dateStr.slice(0, 4), 10) || 0;
      return `${Math.floor(year / 10) * 10}s` === releaseFilter;
    })
    .filter(item => !searchTerm || item.title.toLowerCase().includes(searchTerm.toLowerCase()))
    .sort((a, b) => {
      switch (sortOption) {
        case 'Title Z-A':
          return b.title.localeCompare(a.title);
        case 'Release Date (Newest)': {
          const aYear = parseInt((a.meta?.release_date || a.meta?.first_air_date || '').slice(0, 4), 10) || 0;
          const bYear = parseInt((b.meta?.release_date || b.meta?.first_air_date || '').slice(0, 4), 10) || 0;
          return bYear - aYear;
        }
        case 'Release Date (Oldest)': {
          const aYear = parseInt((a.meta?.release_date || a.meta?.first_air_date || '').slice(0, 4), 10) || 0;
          const bYear = parseInt((b.meta?.release_date || b.meta?.first_air_date || '').slice(0, 4), 10) || 0;
          return aYear - bYear;
        }
        default:
          return a.title.localeCompare(b.title);
      }
    });

  return (
    <div className="App" onClick={closeAllDropdowns}>
      <header className="navbar">
        <h1 className="logo" onClick={goHome}>Catflix</h1>
        <button className="logout-btn" onClick={handleLogout}>Logout</button>
      </header>
      {selectedVideo && (
        <div className="video-page">
          <header className="navbar">
            <h1 className="logo" onClick={goHome}>Catflix</h1>
            <span className="video-nav-title">{getVideoHeaderTitle()}</span>
            <button className="video-close-btn" onClick={goHome}>X</button>
          </header>
          <div className="video-wrapper">
            <video
              ref={videoRef}
              className="video-player"
              controls
              autoPlay
              playsInline
              webkit-playsinline="true"
              preload="auto"
            >
              {subtitleUrl && (
                <track
                  kind="subtitles"
                  srclang="en"
                  label="English"
                  src={subtitleUrl}
                  default
                />
              )}
            </video>
            {showNextOverlay && nextUp && (
              <button
                className="next-overlay"
                onClick={() => setSelectedVideo(nextUp)}
              >
                Next Episode
              </button>
            )}
          </div>
        </div>
      )}
      {showDetail && (
        <div className="modal" onClick={() => setShowDetail(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <button className="modal-close-btn" onClick={() => setShowDetail(null)}>X</button>
            <div className="detail-top">
              {showDetail.meta?.poster_path && (
                <img className="detail-poster" src={showDetail.meta.poster_path} alt={showDetail.title} />
              )}
              <div className="detail-body">
                {showDetail.meta && (
                  <div className="details">
                    <h2>{showDetail.title}</h2>
                    <p>{showDetail.meta.overview}</p>
                    {showDetail.meta.genres && (
                      <p><strong>Genres:</strong> {showDetail.meta.genres.map(g => g.name).join(', ')}</p>
                    )}
                    {showDetail.meta.release_date && (
                      <p><strong>Release Date:</strong> {showDetail.meta.release_date}</p>
                    )}
                    {showDetail.meta.vote_average && (
                      <p><strong>Rating:</strong> {showDetail.meta.vote_average}/10</p>
                    )}
                    {(showDetail.meta.content_ratings || showDetail.meta.release_dates) && (
                      <p><strong>Age Rating:</strong> {
                        translateRating(
                          showDetail.meta.content_ratings?.results.find(r => r.iso_3166_1 === 'US')?.rating ||
                          showDetail.meta.release_dates?.results.find(r => r.iso_3166_1 === 'US')?.release_dates[0].certification
                        ) || 'N/A'
                      }</p>
                    )}
                    {renderCastList(showDetail.meta)}
                  </div>
                )}
                {showDetail.type === 'movie' && (
                  <div className="movie-actions">
                    <button
                      className="play-button"
                      onClick={() => {
                        setShowDetail(null);
                        setSelectedVideo(showDetail.parts[0]);
                      }}
                    >
                      Play Movie
                    </button>
                    <button
                      className="play-button download"
                      disabled={movieDownloadStatus[getMovieId(showDetail)] === 'loading'}
                      onClick={() => runMovieDownload(showDetail)}
                    >
                      {movieDownloadStatus[getMovieId(showDetail)] === 'loading'
                        ? 'Preparing...'
                        : movieDownloadStatus[getMovieId(showDetail)] === 'downloading'
                          ? 'Downloading...'
                          : 'Download Movie'}
                    </button>
                  </div>
                )}
              </div>
              {showDetail.meta?.trailers?.length > 0 && (
                <div className="iframe-container">
                  <iframe
                    src={showDetail.meta.trailers[0].replace('watch?v=', 'embed/')}
                    frameBorder="0"
                    allow="autoplay; encrypted-media"
                    title="Trailer"
                    allowFullScreen
                  />
                </div>
              )}
            </div>
            {showDetail.type !== 'movie' && (
              // after embed, render seasons
              [...showDetail.seasons]
                .sort((a, b) => {
                  const getNum = s => { const m = s.match(/\d+/); return m ? parseInt(m[0], 10) : null; };
                  const numA = getNum(a.season);
                  const numB = getNum(b.season);
                  if (numA !== null && numB !== null) return numA - numB;
                  if (numA !== null) return -1;
                  if (numB !== null) return 1;
                  const order = ["Featurettes", "Specials", "Deleted Scenes"];
                  const idxA = order.indexOf(a.season);
                  const idxB = order.indexOf(b.season);
                  if (idxA !== -1 || idxB !== -1) {
                    if (idxA === -1) return 1;
                    if (idxB === -1) return -1;
                    return idxA - idxB;
                  }
                  return a.season.localeCompare(b.season);
                })
                .map(season => (
                  <div key={season.season} className="season-list">
                    <div className="season-header">
                    <h3>{season.season}</h3>
                      <button
                        className="download-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          runSeasonDownload(showDetail, season);
                        }}
                        disabled={seasonDownloadStatus[getSeasonId(season)] === 'loading'}
                      >
                        {seasonDownloadStatus[getSeasonId(season)] === 'loading'
                          ? 'Preparing...'
                          : seasonDownloadStatus[getSeasonId(season)] === 'downloading'
                            ? 'Downloading...'
                            : 'Download Season'}
                      </button>
                    </div>
                    <div className="episodes-grid">
                      {season.episodes
                        .sort((a, b) => {
                          const getNum = t => { const m = t.match(/\d+/); return m ? parseInt(m[0], 10) : 0; };
                          return getNum(a.title) - getNum(b.title);
                        })
                        .map(ep => (
                          <div
                            key={`${season.season}-${ep.title}`}
                            className="episode-card"
                            onClick={() => {
                              setShowDetail(null);
                              setSelectedVideo({ src: ep.src, title: `${showDetail.title} - ${ep.title}` });
                            }}
                          >
                            {ep.previewSrc && (
                              <video
                                className="episode-thumb"
                                src={ep.previewSrc}
                                muted
                                loop
                                playsInline
                                preload="metadata"
                                onMouseEnter={e => e.currentTarget.play()}
                                onMouseLeave={e => { e.currentTarget.pause(); e.currentTarget.currentTime = 0; }}
                                onError={e => { e.currentTarget.style.display = 'none'; }}
                              />
                            )}
                            <div className="episode-title">{ep.title}</div>
                          </div>
                        ))}
                    </div>
                  </div>
                ))
            )}
          </div>
        </div>
      )}
      {loading ? (
        <p>Loading...</p>
      ) : (
        <>
          <div className="filter-bar" onClick={e => e.stopPropagation()}>
            <div className="filter-group" onClick={e => e.stopPropagation()}>
              <button
                className={`filter-pill ${typeFilter.movie ? 'active' : ''}`}
                onClick={() => toggleType('movie')}
              >
                Movies
              </button>
              <button
                className={`filter-pill ${typeFilter.show ? 'active' : ''}`}
                onClick={() => toggleType('show')}
              >
                Shows
              </button>
              <div
                className={`dropdown ${openDropdown==='genres'?'open':''}`}
                onClick={e => e.stopPropagation()}
              >
                <button
                  className="filter-pill dropbtn"
                  onClick={() => toggleDropdown('genres')}
                >
                  {genreFilter.length > 0 ? genreFilter.join(', ') : 'Genres'}
                </button>
                <div className="dropdown-content">
                  {genres.map(g => (
                    <label
                      key={g}
                      className={`dropdown-item ${genreFilter.includes(g) ? 'active' : ''}`}
                      onClick={() => { toggleGenre(g); closeAllDropdowns(); }}
                    >
                      <input
                        type="checkbox"
                        checked={genreFilter.includes(g)}
                        onChange={() => { toggleGenre(g); closeAllDropdowns(); }}
                      />
                      {g}
                    </label>
                  ))}
                </div>
              </div>
              <div
                className={`dropdown release-dropdown ${openDropdown==='release'?'open':''}`}
                onClick={e => e.stopPropagation()}
              >
                <button
                  className="filter-pill dropbtn"
                  onClick={() => toggleDropdown('release')}
                >
                  {releaseFilter || 'Release Date'}
                </button>
                <div className="dropdown-content">
                  {releaseOptions.map(d => (
                    <div
                      key={d}
                      className={`dropdown-item ${releaseFilter === d ? 'active' : ''}`}
                      onClick={() => { setReleaseFilter(releaseFilter === d ? '' : d); closeAllDropdowns(); }}
                    >
                      {d}
                    </div>
                  ))}
                </div>
              </div>
              <div
                className={`dropdown sort-dropdown ${openDropdown==='sort'?'open':''}`}
                onClick={e => e.stopPropagation()}
              >
                <button
                  className="filter-pill dropbtn"
                  onClick={() => toggleDropdown('sort')}
                >
                  {sortOption}
                </button>
                <div className="dropdown-content">
                  {sortOptions.map(o => (
                    <div
                      key={o}
                      className={`dropdown-item ${sortOption === o ? 'active' : ''}`}
                      onClick={() => { setSortOption(o); closeAllDropdowns(); }}
                    >
                      {o}
                    </div>
                  ))}
                </div>
              </div>
              <button
                className="filter-pill clearbtn"
                onClick={clearFilters}
              >
                Clear Filters
              </button>
              <div className="search-container">
                <input
                  type="text"
                  className="search-input"
                  placeholder="Search"
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); setSearchTerm(searchInput); } }}
                />
                <button className="search-btn" onClick={() => setSearchTerm(searchInput)}>🔍</button>
              </div>
            </div>
          </div>
          {(() => {
            // Build Recently Watched list enriched with metadata and filtered, hide tagged entries
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
            return recentItems.length > 0 ? (
              <>
                <div className="section-title">Recently Watched</div>
                <section className="section">
                  <div className="row">
                    {recentItems.map(item => (
                      <div
                        key={`recent-${item.recent.key}`}
                        className="card recent-card"
                        onClick={() => { setShowDetail(item); }}
                      >
                        <button
                          className="hide-btn"
                          title="Remove from Recently Watched"
                          onClick={(e) => { e.stopPropagation(); hideRecentByKey(item.recent.key); }}
                        >
                          🛑
                        </button>
                        <button
                          className={`favorite-btn ${isFavorite(item) ? 'active' : ''}`}
                          title={isFavorite(item) ? 'Unfavorite' : 'Favorite'}
                          onClick={(e) => toggleFavorite(item, e)}
                        >
                          {isFavorite(item) ? '★' : '☆'}
                        </button>
                        {item.meta?.poster_path ? (
                          <img src={item.meta.poster_path} alt={item.title} />
                        ) : (
                          <div className="placeholder">No Image</div>
                        )}
                        <div className="title">{item.title}</div>
                        <div className="subtitle">
                          {item.recent.type === 'show' ? (
                            <>
                              {item.recent.season ? `${item.recent.season} • ` : ''}
                              {extractEpisodeNumber(item.recent.episodeTitle) || item.recent.episodeTitle || 'Episode'} • {formatTime(item.recent.stoppedAt)}
                            </>
                          ) : (
                            <>{formatTime(item.recent.stoppedAt)}</>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            ) : null;
          })()}

          {(() => {
            // Build Favorites list
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
            return favItems.length > 0 ? (
              <>
                <div className="section-title">Favorites</div>
                <section className="section">
                  <div className="row">
                    {favItems.map(item => (
                      <div
                        key={`fav-${item.type}-${item.title}`}
                        className="card"
                        onClick={() => { setShowDetail(item); }}
                      >
                        <button
                          className={`favorite-btn ${isFavorite(item) ? 'active' : ''}`}
                          title={isFavorite(item) ? 'Unfavorite' : 'Favorite'}
                          onClick={(e) => toggleFavorite(item, e)}
                        >
                          {isFavorite(item) ? '★' : '☆'}
                        </button>
                        {item.meta?.poster_path ? (
                          <img src={item.meta.poster_path} alt={item.title} />
                        ) : (
                          <div className="placeholder">No Image</div>
                        )}
                        <div className="title">{item.title}</div>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            ) : null;
          })()}

          {(() => {
            // Recently Added: pick latest by addedAt descending, across movies and shows
            const withAdded = [
              ...movies.filter(m => Number.isFinite(m.addedAt)).map(m => ({...m, _t: m.addedAt})),
              ...shows.filter(s => Number.isFinite(s.addedAt)).map(s => ({...s, _t: s.addedAt}))
            ].filter(item => passesFilters(item));
            withAdded.sort((a,b) => (b._t||0) - (a._t||0));
            const recent10 = withAdded.slice(0, 10);
            return recent10.length > 0 ? (
              <>
                <div className="section-title">Recently Added</div>
                <section className="section">
                  <div className="row">
                    {recent10.map(item => (
                      <div
                        key={`added-${item.type}-${item.title}`}
                        className="card"
                        onClick={() => { setShowDetail(item); }}
                      >
                        <button
                          className={`favorite-btn ${isFavorite(item) ? 'active' : ''}`}
                          title={isFavorite(item) ? 'Unfavorite' : 'Favorite'}
                          onClick={(e) => toggleFavorite(item, e)}
                        >
                          {isFavorite(item) ? '★' : '☆'}
                        </button>
                        {item.meta?.poster_path ? (
                          <img src={item.meta.poster_path} alt={item.title} />
                        ) : (
                          <div className="placeholder">No Image</div>
                        )}
                        <div className="title">{item.title}</div>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            ) : null;
          })()}

          <div className="section-title">All Results</div>
          <section className="section">
            <div className="row">
              {filteredMedia.map(item => (
                <div
                  key={item.title}
                  className="card"
                  onClick={() => { setShowDetail(item); }}
                >
                  <button
                    className={`favorite-btn ${isFavorite(item) ? 'active' : ''}`}
                    title={isFavorite(item) ? 'Unfavorite' : 'Favorite'}
                    onClick={(e) => toggleFavorite(item, e)}
                  >
                    {isFavorite(item) ? '★' : '☆'}
                  </button>
                  {item.meta?.poster_path ? (
                    <img src={item.meta.poster_path} alt={item.title} />
                  ) : (
                    <div className="placeholder">No Image</div>
                  )}
                  <div className="title">{item.title}</div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export default App;
