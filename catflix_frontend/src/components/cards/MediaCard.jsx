import React from 'react';

export function MediaCard({ item, isFavorite, onToggleFavorite, onClick }) {
  return (
    <div className="card" onClick={onClick}>
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
    </div>
  );
}

