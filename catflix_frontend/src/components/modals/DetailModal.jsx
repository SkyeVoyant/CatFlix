import React, { useEffect, useRef } from 'react';

export function DetailModal({
  showDetail,
  movieDownloadStatus,
  seasonDownloadStatus,
  getMovieId,
  getSeasonId,
  onClose,
  onPlayMovie,
  onDownloadMovie,
  onDownloadSeason,
  onPlayEpisode
}) {
  const modalContentRef = useRef(null);
  const touchStartRef = useRef(null);

  useEffect(() => {
    if (showDetail) {
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
      // Focus element for TV navigation
      if (modalContentRef.current) {
        modalContentRef.current.focus();
      }
    } else {
      document.body.style.overflow = 'unset';
      document.documentElement.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
      document.documentElement.style.overflow = 'unset';
    };
  }, [showDetail]);

  if (!showDetail) return null;

  const formatRating = (rating) => {
    if (!rating || rating === 'N/A' || rating === 'NA' || rating === '') {
      return 'N/A';
    }

    // First, convert TV ratings to movie ratings
    const tvToMovie = {
      'TV-Y': 'G',
      'TV-Y7': 'G',
      'TV-G': 'G',
      'TV-PG': 'PG',
      'TV-14': 'PG-13',
      'TV-MA': 'R'
    };

    // Normalize the rating (handle TV ratings)
    let normalizedRating = rating;
    if (tvToMovie[rating]) {
      normalizedRating = tvToMovie[rating];
    }

    // Format all ratings in the standard format
    const ratingFormats = {
      'G': 'G (General Audiences)',
      'PG': 'PG (Parental Guidance Suggested)',
      'PG-13': 'PG-13 (Parents Strongly Cautioned)',
      'R': 'R (Restricted)',
      'NC-17': 'NC-17 (Adults Only)',
      'NR': 'NR (Not Rated)'
    };

    return ratingFormats[normalizedRating] || rating;
  };

  const getCertification = () => {
    let rating = null;

    // First check the direct certification field (from database)
    if (showDetail.meta?.certification) {
      rating = showDetail.meta.certification;
    }
    // Fall back to nested structure if direct field is not available
    else if (showDetail.type === 'movie') {
      const usRelease = showDetail.meta?.release_dates?.results.find(r => r.iso_3166_1 === 'US');
      if (usRelease?.release_dates) {
        // Try type 3 (theatrical) first, then type 2 (limited), then type 4 (digital)
        const type3 = usRelease.release_dates.find(rd => rd.type === 3)?.certification;
        const type2 = usRelease.release_dates.find(rd => rd.type === 2)?.certification;
        const type4 = usRelease.release_dates.find(rd => rd.type === 4)?.certification;
        rating = type3 || type2 || type4 || usRelease.release_dates[0]?.certification;
      }
    } else {
      rating = showDetail.meta?.content_ratings?.results.find(r => r.iso_3166_1 === 'US')?.rating;
    }

    return formatRating(rating);
  };

  const getCast = () => {
    const cast = Array.isArray(showDetail.meta?.credits?.cast)
      ? showDetail.meta.credits.cast
        .filter((member) => member && member.name)
        .sort((a, b) => {
          const orderA = Number.isFinite(a.order) ? a.order : 999;
          const orderB = Number.isFinite(b.order) ? b.order : 999;
          return orderA - orderB;
        })
        .slice(0, 12)
      : [];
    return cast;
  };

  const cast = getCast();

  const handleWheel = (e) => {
    if (modalContentRef.current && e.target === e.currentTarget) {
      modalContentRef.current.scrollTop += e.deltaY;
    }
  };

  const handleTouchStart = (e) => {
    if (e.target === e.currentTarget) {
      touchStartRef.current = e.touches[0].clientY;
    }
  };

  const handleTouchMove = (e) => {
    if (modalContentRef.current && e.target === e.currentTarget && touchStartRef.current !== null) {
      const touchY = e.touches[0].clientY;
      const deltaY = touchStartRef.current - touchY;
      modalContentRef.current.scrollTop += deltaY;
      touchStartRef.current = touchY;
    }
  };

  return (
    <div
      className="modal"
      onClick={onClose}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
    >

      <div
        className="modal-content"
        onClick={e => e.stopPropagation()}
        ref={modalContentRef}
        tabIndex="-1"
        style={{ outline: 'none' }}
      >
        <button className="modal-close-btn" onClick={onClose}>X</button>
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
                <p><strong>Certification:</strong> {getCertification()}</p>
              </div>
            )}
            {cast.length > 0 && (
              <div className="cast-section">
                <h3>Cast</h3>
                <ul>
                  {cast.map((member) => (
                    <li key={member.credit_id || member.id || member.name}>
                      <span className="cast-name-text">{member.name}</span>
                      {member.character && (
                        <span className="cast-character-text"> as {member.character}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {showDetail.type === 'movie' && (
              <div className="movie-actions">
                <button
                  className="play-button"
                  onClick={() => onPlayMovie(showDetail)}
                >
                  Play Movie
                </button>
                <button
                  className="play-button download"
                  disabled={movieDownloadStatus[getMovieId(showDetail)] === 'loading'}
                  onClick={() => onDownloadMovie(showDetail)}
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
                      onDownloadSeason(showDetail, season);
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
                        onClick={() => onPlayEpisode(showDetail, ep)}
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
  );
}

