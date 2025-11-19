import React, { useState, useEffect } from 'react';
import './App.css';
import { parseFromSrc } from './utils/parsers';
import { useAuth } from './hooks/useAuth';
import { useMediaData } from './hooks/useMediaData';
import { useRecentWatched } from './hooks/useRecentWatched';
import { useFavorites } from './hooks/useFavorites';
import { useDownloads } from './hooks/useDownloads';
import { useFilters } from './hooks/useFilters';
import { useVideoPlayer } from './hooks/useVideoPlayer';
import { Navbar } from './components/layout/Navbar';
import { FilterBar } from './components/layout/FilterBar';
import { VideoPlayer } from './components/video/VideoPlayer';
import { NextEpisodeOverlay } from './components/video/NextEpisodeOverlay';
import { DetailModal } from './components/modals/DetailModal';
import { RecentlyWatchedSection } from './components/sections/RecentlyWatchedSection';
import { FavoritesSection } from './components/sections/FavoritesSection';
import { RecentlyAddedSection } from './components/sections/RecentlyAddedSection';
import { AllResultsSection } from './components/sections/AllResultsSection';

function App() {
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [showDetail, setShowDetail] = useState(null);
  const [subtitleUrl, setSubtitleUrl] = useState(null);
  const [nextUp, setNextUp] = useState(null);
  const [showNextOverlay, setShowNextOverlay] = useState(false);

  // Custom hooks
  const { handleLogout } = useAuth();
  const { movies, shows, genres, releaseOptions, loading } = useMediaData();
  const { recent, hiddenRecents, loadRecent, loadHiddenRecents, upsertRecent, hideRecentByKey, unhideRecentByKey } = useRecentWatched();
  const { favorites, loadFavorites, isFavorite, toggleFavorite } = useFavorites();
  const { movieDownloadStatus, seasonDownloadStatus, runMovieDownload, runSeasonDownload, getMovieId, getSeasonId } = useDownloads();
  const {
    typeFilter,
    genreFilter,
    releaseFilter,
    sortOption,
    searchInput,
    openDropdown,
    filteredMedia,
    passesFilters,
    toggleType,
    toggleGenre,
    setReleaseFilter,
    setSortOption,
    setSearchInput,
    setSearchTerm,
    toggleDropdown,
    closeAllDropdowns,
    clearFilters
  } = useFilters(movies, shows);

  const { videoRef } = useVideoPlayer(selectedVideo, {
    onProgress: { upsertRecent, parseFromSrc, setSelectedVideo },
    shows,
    nextUp,
    hiddenRecents,
    unhideRecentByKey
  });


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

  // Load recent/favorites on mount
  useEffect(() => {
    loadRecent();
    loadFavorites();
    loadHiddenRecents();
  }, []);

  // Update subtitle URL when selectedVideo changes
  useEffect(() => {
    if (!selectedVideo) {
      setSubtitleUrl(null);
      return;
    }
    
    // Check if subtitle exists before setting URL
    const checkSubtitle = async () => {
      try {
        const subtitlePath = `/api/subtitles?src=${encodeURIComponent(selectedVideo.src)}`;
        const response = await fetch(subtitlePath, { method: 'HEAD', credentials: 'include' });
        
        if (response.ok) {
          setSubtitleUrl(subtitlePath);
        } else {
          // Subtitle not available, don't set URL
          setSubtitleUrl(null);
        }
      } catch (error) {
        // Error checking subtitle, don't set URL
        setSubtitleUrl(null);
      }
    };
    
    checkSubtitle();
  }, [selectedVideo]);

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

  // Compute next episode for overlay
  useEffect(() => {
    if (!selectedVideo) {
      setNextUp(null);
      return;
    }
    try {
      const info = parseFromSrc(selectedVideo.src, selectedVideo.title);
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
    } catch {
      setNextUp(null);
    }
  }, [selectedVideo, shows]);

  // Show next overlay with 30s left
  useEffect(() => {
    if (!videoRef.current || !nextUp || !selectedVideo) return;
    const v = videoRef.current;
    const checkOverlay = () => {
      try {
        if (isFinite(v.duration) && v.duration - v.currentTime <= 30) {
          setShowNextOverlay(true);
        } else {
          setShowNextOverlay(false);
        }
      } catch {}
    };
    v.addEventListener('timeupdate', checkOverlay);
    return () => v.removeEventListener('timeupdate', checkOverlay);
  }, [nextUp, selectedVideo]);

  return (
    <div className="App" onClick={() => closeAllDropdowns()}>
      <Navbar onLogoClick={goHome} onLogout={handleLogout} />
      {selectedVideo && (
        <div className="video-page">
          <Navbar 
            isVideoPage 
            onLogoClick={goHome} 
            videoTitle={getVideoHeaderTitle()} 
            onClose={goHome} 
          />
          <div className="video-wrapper">
            <VideoPlayer videoRef={videoRef} subtitleUrl={subtitleUrl} />
            <NextEpisodeOverlay 
              show={showNextOverlay} 
              nextUp={nextUp} 
              onPlayNext={() => setSelectedVideo(nextUp)} 
            />
          </div>
        </div>
      )}
      <DetailModal
        showDetail={showDetail}
        movieDownloadStatus={movieDownloadStatus}
        seasonDownloadStatus={seasonDownloadStatus}
        getMovieId={getMovieId}
        getSeasonId={getSeasonId}
        onClose={() => setShowDetail(null)}
        onPlayMovie={(item) => {
          setShowDetail(null);
          setSelectedVideo(item.parts[0]);
        }}
        onDownloadMovie={runMovieDownload}
        onDownloadSeason={runSeasonDownload}
        onPlayEpisode={(show, ep) => {
          setShowDetail(null);
          setSelectedVideo({ src: ep.src, title: `${show.title} - ${ep.title}` });
        }}
      />
      {loading ? (
        <p>Loading...</p>
      ) : (
        <>
          <FilterBar
            typeFilter={typeFilter}
            genreFilter={genreFilter}
            genres={genres}
            releaseFilter={releaseFilter}
            releaseOptions={releaseOptions}
            sortOption={sortOption}
            searchInput={searchInput}
            openDropdown={openDropdown}
            onToggleType={toggleType}
            onToggleGenre={toggleGenre}
            onSetReleaseFilter={(value) => {
              setReleaseFilter(value);
              closeAllDropdowns();
            }}
            onSetSortOption={(value) => {
              setSortOption(value);
              closeAllDropdowns();
            }}
            onSearchInputChange={setSearchInput}
            onSearchSubmit={() => setSearchTerm(searchInput)}
            onToggleDropdown={toggleDropdown}
            onClearFilters={clearFilters}
            onStopPropagation={(e) => e.stopPropagation()}
          />
          <RecentlyWatchedSection
            recent={recent}
            movies={movies}
            shows={shows}
            hiddenRecents={hiddenRecents}
            passesFilters={passesFilters}
            isFavorite={isFavorite}
            toggleFavorite={toggleFavorite}
            hideRecentByKey={hideRecentByKey}
            onShowDetail={setShowDetail}
            onResumeVideo={(item) => {
              // Resume video from recently watched
              if (item.recent.type === 'movie' && item.parts?.[0]) {
                setSelectedVideo(item.parts[0]);
              } else if (item.recent.type === 'show') {
                setSelectedVideo({ src: item.recent.src, title: `${item.recent.showTitle} - ${item.recent.episodeTitle}` });
              }
            }}
          />

          <FavoritesSection
            favorites={favorites}
            movies={movies}
            shows={shows}
            passesFilters={passesFilters}
            isFavorite={isFavorite}
            toggleFavorite={toggleFavorite}
            onShowDetail={setShowDetail}
          />

          <RecentlyAddedSection
            movies={movies}
            shows={shows}
            passesFilters={passesFilters}
            isFavorite={isFavorite}
            toggleFavorite={toggleFavorite}
            onShowDetail={setShowDetail}
          />

          <AllResultsSection
            filteredMedia={filteredMedia}
            isFavorite={isFavorite}
            toggleFavorite={toggleFavorite}
            onShowDetail={setShowDetail}
          />
        </>
      )}
    </div>
  );
}

export default App;
