import React from 'react';

export function VideoPlayer({ videoRef, subtitleUrl }) {
  return (
    <video
      ref={videoRef}
      className="video-player"
      controls
      playsInline
      preload="auto"
      crossOrigin="anonymous"
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
  );
}

