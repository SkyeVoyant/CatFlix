/**
 * Device detection utilities for HLS compatibility
 */

export function isSamsungBrowser() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // Samsung Browser has "SamsungBrowser" in user agent
  return /SamsungBrowser/i.test(ua);
}

export function isAppleDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  
  // Check for iOS devices
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  
  // Check for macOS Safari (not Chrome on Mac)
  const isMacSafari = /Macintosh/i.test(ua) && /Safari/i.test(ua) && !/Chrome/i.test(ua);
  
  return isIOS || isMacSafari;
}

export function needsFMP4Remux() {
  // Force remux if URL has ?forceRemux=true (for testing)
  if (typeof window !== 'undefined' && window.location.search.includes('forceRemux=true')) {
    return true;
  }
  
  // Samsung Browser and Apple devices need fMP4 format
  return isSamsungBrowser() || isAppleDevice();
}

export function getDeviceInfo() {
  return {
    isSamsung: isSamsungBrowser(),
    isApple: isAppleDevice(),
    needsRemux: needsFMP4Remux(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'
  };
}

