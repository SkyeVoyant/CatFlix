import React from 'react';

export function VideoPlayer({ videoRef, subtitleUrl }) {
  return (
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
  );
}

