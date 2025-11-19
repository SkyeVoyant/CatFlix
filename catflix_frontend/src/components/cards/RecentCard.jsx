import React from 'react';
import { formatTime, extractEpisodeNumber } from '../../utils/formatters';

export function RecentCard({ item, isFavorite, onToggleFavorite, onHide, onClick, onResume }) {
  const { recent } = item;

  return (
    <div className="card recent-card" onClick={onClick}>
      <button
        className="hide-btn"
        title="Remove from Recently Watched"
        onClick={(e) => { e.stopPropagation(); onHide(); }}
      >
        🛑
      </button>
      <button
        className={`favorite-btn ${isFavorite ? 'active' : ''}`}
        title={isFavorite ? 'Unfavorite' : 'Favorite'}
        onClick={onToggleFavorite}
      >
        {isFavorite ? '★' : '☆'}
      </button>
      {item.meta?.poster_path ? (
        <img src={item.meta.poster_path} alt={item.title} />
      ) : (
        <div className="placeholder">No Image</div>
      )}
      <div className="title">{item.title}</div>
      <div className="subtitle">
        {recent.type === 'show' ? (
          <>
            {recent.season ? `${recent.season} • ` : ''}
            {extractEpisodeNumber(recent.episodeTitle) || recent.episodeTitle || 'Episode'} • {formatTime(recent.stoppedAt)}
          </>
        ) : (
          <>{formatTime(recent.stoppedAt)}</>
        )}
      </div>
      <button
        className="resume-btn"
        onClick={(e) => { e.stopPropagation(); onResume(); }}
      >
        Resume Video
      </button>
    </div>
  );
}

