import React from 'react';

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
  if (!showDetail) return null;

  const getRatingDescription = (certification) => {
    const ratingDescriptions = {
      'G': 'General Audiences - All ages admitted',
      'PG': 'Parental Guidance Suggested - Some material may not be suitable for children',
      'PG-13': 'Parents Strongly Cautioned - Some material may be inappropriate for children under 13',
      'R': 'Restricted - Under 17 requires accompanying parent or adult guardian',
      'NC-17': 'Adults Only - No one 17 and under admitted',
      'TV-Y': 'General Audiences - All children',
      'TV-Y7': 'General Audiences - Directed to older children',
      'TV-G': 'General Audiences - Most parents would find this suitable for all ages',
      'TV-PG': 'Parental Guidance Suggested - May contain material parents might find unsuitable for younger children',
      'TV-14': 'Parents Strongly Cautioned - May be unsuitable for children under 14',
      'TV-MA': 'Restricted - Specifically designed to be viewed by adults'
    };
    return ratingDescriptions[certification] || certification;
  };

  const translateTVRating = (tvRating) => {
    const translations = {
      'TV-Y': 'G (General Audiences)',
      'TV-Y7': 'G (General Audiences)',
      'TV-G': 'G (General Audiences)',
      'TV-PG': 'PG (Parental Guidance Suggested)',
      'TV-14': 'PG-13 (Parents Strongly Cautioned)',
      'TV-MA': 'R (Restricted)'
    };
    return translations[tvRating] || tvRating;
  };

  const getCertification = () => {
    if (showDetail.type === 'movie') {
      const cert = showDetail.meta?.release_dates?.results.find(r => r.iso_3166_1 === 'US')?.release_dates[0].certification;
      return cert || 'N/A';
    } else {
      const tvRating = showDetail.meta?.content_ratings?.results.find(r => r.iso_3166_1 === 'US')?.rating;
      return tvRating ? translateTVRating(tvRating) : 'N/A';
    }
  };

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
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
                {(showDetail.meta.release_dates || showDetail.meta.content_ratings) && (
                  <p><strong>Certification:</strong> {getCertification()}</p>
                )}
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

