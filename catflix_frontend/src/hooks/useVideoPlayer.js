import { useRef, useEffect } from 'react';
import Hls from 'hls.js';
import { needsFMP4Remux } from '../utils/deviceDetection';

export function useVideoPlayer(selectedVideo, { onProgress, shows, nextUp, hiddenRecents, unhideRecentByKey }) {
  const videoRef = useRef(null);
  const hlsInstanceRef = useRef(null);
  const lastRecentSaveRef = useRef(0);

  // Configure video element for MP4/HLS playback
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    if (!selectedVideo || !selectedVideo.src) {
      if (hlsInstanceRef.current) {
        try { hlsInstanceRef.current.destroy(); } catch {}
        hlsInstanceRef.current = null;
      }
      videoEl.removeAttribute('src');
      videoEl.load();
      return;
    }
    let src = selectedVideo.src;
    const isHls = /\.m3u8(\?|$)/i.test(src);
    
    // For Samsung Browser and Apple devices, use live remux endpoint
    if (isHls && needsFMP4Remux()) {
      // Add remux parameter to trigger backend live remux
      src = src.includes('?') ? `${src}&remux=fmp4` : `${src}?remux=fmp4`;
    }
    
    // Clean up existing HLS instance
    if (hlsInstanceRef.current) {
      try { hlsInstanceRef.current.destroy(); } catch {}
      hlsInstanceRef.current = null;
    }
    
    if (isHls) {
      // Check for native HLS support (Safari, iOS)
      const canPlayNatively = videoEl.canPlayType('application/vnd.apple.mpegurl') !== '';
      
      if (canPlayNatively) {
        // Use native HLS playback (iOS Safari, macOS Safari)
        console.log('[HLS] Using native HLS playback');
        videoEl.src = src;
        videoEl.load();
      } else if (Hls.isSupported()) {
        // Use hls.js for browsers without native support but with MSE
        console.log('[HLS] Using hls.js for playback');
        const hls = new Hls({
          enableWorker: false,
          debug: false,
          lowLatencyMode: false,
          backBufferLength: 90,
          maxBufferLength: 30,
          maxMaxBufferLength: 600,
          maxBufferSize: 60 * 1000 * 1000,
          maxBufferHole: 0.5,
          highBufferWatchdogPeriod: 2,
          nudgeOffset: 0.1,
          nudgeMaxRetry: 3,
          maxFragLookUpTolerance: 0.25,
          enableSoftwareAES: true,
          startLevel: -1,
          manifestLoadingTimeOut: 20000,
          manifestLoadingMaxRetry: 4,
          manifestLoadingRetryDelay: 1000,
          levelLoadingTimeOut: 20000,
          levelLoadingMaxRetry: 4,
          fragLoadingTimeOut: 20000,
          fragLoadingMaxRetry: 6
        });
        
        hlsInstanceRef.current = hls;
        
        // Enhanced error handling with logging
        hls.on(Hls.Events.ERROR, (event, data) => {
          console.error('[HLS] Error event:', {
            type: data.type,
            details: data.details,
            fatal: data.fatal,
            url: data.url,
            response: data.response?.code
          });
          
          if (data.fatal) {
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                console.error('[HLS] Fatal network error, attempting recovery');
                hls.startLoad();
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                console.error('[HLS] Fatal media error, attempting recovery');
                hls.recoverMediaError();
                break;
              default:
                console.error('[HLS] Unrecoverable error, destroying player');
                try { hls.destroy(); } catch {}
                hlsInstanceRef.current = null;
                // Fallback to direct source (won't work but shows error)
                videoEl.src = src;
                break;
            }
          }
        });
        
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          console.log('[HLS] Manifest parsed successfully');
        });
        
        hls.loadSource(src);
        hls.attachMedia(videoEl);
      } else {
        // No native support and hls.js not supported
        console.error('[HLS] Neither native HLS nor hls.js is supported on this device');
        console.error('[HLS] MSE supported:', 'MediaSource' in window);
        console.error('[HLS] User Agent:', navigator.userAgent);
        
        // Try direct source as last resort (likely won't work)
        videoEl.src = src;
        videoEl.load();
      }
    } else {
      // Regular MP4 playback
      videoEl.src = src;
      videoEl.load();
    }
    
    return () => {
      if (hlsInstanceRef.current) {
        try { hlsInstanceRef.current.destroy(); } catch {}
        hlsInstanceRef.current = null;
      }
    };
  }, [selectedVideo]);

  // Persist volume & resume position, and autoplay when video loads
  useEffect(() => {
    if (!selectedVideo) return;
    const v = videoRef.current;
    if (!v) return;
    
    // Load stored volume
    const storedVol = parseFloat(localStorage.getItem('volume') || '1');
    v.volume = storedVol;
    
    // Load stored resume position
    const resumeKey = `resume_${selectedVideo.src}`;
    const storedTime = parseFloat(localStorage.getItem(resumeKey) || '0');
    
    const onLoaded = () => {
      if (!isNaN(storedTime) && storedTime > 0 && storedTime < v.duration) {
        v.currentTime = storedTime;
      }
      // Enable subtitle tracks so CC button appears in all browsers
      const tracks = v.textTracks;
      if (tracks.length > 0) {
        // Set first track to 'showing' to make CC button visible
        tracks[0].mode = 'showing';
      }
      // Handle autoplay restrictions on mobile browsers
      const playPromise = v.play();
      if (playPromise !== undefined) {
        playPromise.catch(err => {
          console.log('[VideoPlayer] Autoplay prevented (mobile browser restriction):', err.message);
        });
      }
      
      // If user is re-watching an item hidden from recents, unhide it
      if (onProgress) {
        try {
          const info = onProgress.parseFromSrc(selectedVideo.src, selectedVideo.title);
          const key = info.type === 'show' ? `show:${info.showTitle}` : `movie:${info.movieTitle}`;
          if (hiddenRecents && hiddenRecents.includes(key) && unhideRecentByKey) {
            unhideRecentByKey(key);
          }
        } catch {}
      }
    };
    
    lastRecentSaveRef.current = 0;
    
    const onTimeUpdate = () => {
      localStorage.setItem(resumeKey, v.currentTime);
      const now = Date.now();
      if (onProgress && (!lastRecentSaveRef.current || now - lastRecentSaveRef.current > 5000)) {
        try {
          onProgress.upsertRecent({
            src: selectedVideo.src,
            info: onProgress.parseFromSrc(selectedVideo.src, selectedVideo.title),
            stoppedAt: v.currentTime || 0
          });
          lastRecentSaveRef.current = now;
        } catch {}
      }
    };
    
    const onCapture = () => {
      if (onProgress) {
        try {
          onProgress.upsertRecent({
            src: selectedVideo.src,
            info: onProgress.parseFromSrc(selectedVideo.src, selectedVideo.title),
            stoppedAt: v.currentTime || 0
          });
        } catch {}
      }
    };
    
    const onEnded = () => {
      onCapture();
      if (nextUp && onProgress?.setSelectedVideo) {
        onProgress.setSelectedVideo(nextUp);
      }
    };
    
    const onVolumeChange = () => localStorage.setItem('volume', v.volume);

    const getBufferedAhead = () => {
      try {
        const ct = v.currentTime || 0;
        for (let i = 0; i < v.buffered.length; i++) {
          const start = v.buffered.start(i);
          const end = v.buffered.end(i);
          if (ct >= start && ct <= end) {
            return Math.max(0, end - ct);
          }
        }
      } catch {}
      return 0;
    };
    
    const nudgePlayback = () => {
      try {
        const ahead = getBufferedAhead();
        if (ahead > 1) {
          if (v.paused) {
            const playPromise = v.play();
            if (playPromise !== undefined) {
              playPromise.catch(() => {});
            }
          } else {
            // Gentle rate wobble to kick decoder without seeking (avoids control popup)
            const original = v.playbackRate;
            if (Math.abs(original - 1) < 0.02) {
              v.playbackRate = 1.01;
              setTimeout(() => { try { v.playbackRate = original; } catch {} }, 200);
            }
          }
        }
      } catch {}
    };
    
    const onWaiting = () => nudgePlayback();
    const onStalled = () => nudgePlayback();
    
    const watchdog = setInterval(() => {
      if (!v.paused && v.readyState >= 2) {
        // If we have buffered data ahead but are stuck, nudge
        nudgePlayback();
      }
    }, 4000);
    
    v.addEventListener('loadedmetadata', onLoaded);
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('pause', onCapture);
    v.addEventListener('ended', onEnded);
    v.addEventListener('volumechange', onVolumeChange);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('stalled', onStalled);
    
    return () => {
      v.removeEventListener('loadedmetadata', onLoaded);
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('pause', onCapture);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('volumechange', onVolumeChange);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('stalled', onStalled);
      clearInterval(watchdog);
    };
  }, [selectedVideo, onProgress, shows, nextUp, hiddenRecents, unhideRecentByKey]);

  return { videoRef };
}
