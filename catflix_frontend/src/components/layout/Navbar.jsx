import React from 'react';

export function Navbar({ onLogoClick, onLogout, isVideoPage, videoTitle, onClose }) {
  if (isVideoPage) {
    return (
      <header className="navbar">
        <h1 className="logo" onClick={onLogoClick}>Catflix</h1>
        <span className="video-nav-title">{videoTitle}</span>
        <button className="video-close-btn" onClick={onClose}>X</button>
      </header>
    );
  }

  return (
    <header className="navbar">
      <h1 className="logo" onClick={onLogoClick}>Catflix</h1>
      <button className="logout-btn" onClick={onLogout}>Logout</button>
    </header>
  );
}

