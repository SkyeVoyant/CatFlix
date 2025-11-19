/**
 * Convert JSON subtitle format to WebVTT format
 * WebVTT is the standard format supported by all browsers
 */

function convertToVTT(jsonSubtitle) {
  if (!jsonSubtitle || !Array.isArray(jsonSubtitle.subtitles)) {
    throw new Error('Invalid subtitle format');
  }

  const lines = ['WEBVTT', ''];  // VTT header with blank line

  for (const entry of jsonSubtitle.subtitles) {
    if (!entry || typeof entry.start !== 'number' || typeof entry.end !== 'number') {
      continue;
    }

    // Format timestamps as HH:MM:SS.mmm
    const startTime = formatVTTTime(entry.start);
    const endTime = formatVTTTime(entry.end);
    const text = (entry.text || '').trim();

    if (!text) continue;

    // Add cue (optional cue identifier, then timestamp, then text)
    lines.push(`${entry.id || ''}`);
    lines.push(`${startTime} --> ${endTime}`);
    lines.push(text);
    lines.push('');  // Blank line between cues
  }

  return lines.join('\n');
}

function formatVTTTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) {
    return '00:00:00.000';
  }

  const totalMs = Math.floor(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);

  const hh = h.toString().padStart(2, '0');
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  const mmm = ms.toString().padStart(3, '0');

  return `${hh}:${mm}:${ss}.${mmm}`;
}

module.exports = {
  convertToVTT
};

