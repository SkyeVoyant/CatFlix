import { useState } from 'react';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function useDownloads() {
  const [movieDownloadStatus, setMovieDownloadStatus] = useState({});
  const [seasonDownloadStatus, setSeasonDownloadStatus] = useState({});

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

  return {
    movieDownloadStatus,
    seasonDownloadStatus,
    runMovieDownload,
    runSeasonDownload,
    getMovieId,
    getSeasonId
  };
}

