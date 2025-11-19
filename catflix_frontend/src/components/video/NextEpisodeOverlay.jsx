import React from 'react';

export function NextEpisodeOverlay({ show, nextUp, onPlayNext }) {
  if (!show || !nextUp) return null;

  return (
    <button className="next-overlay" onClick={onPlayNext}>
      Next Episode
    </button>
  );
}

