const path = require('path');
const fs = require('fs').promises;
const config = require('./config');
const db = require('./db');
const audioExtractor = require('./audioExtractor');
const transcriber = require('./transcriber');
const subtitleGenerator = require('./subtitleGenerator');
const translator = require('./translator');

let isProcessing = false;
let shouldStop = false;

async function translateSubtitleData(subtitleData) {
  const sourceLanguage = (subtitleData?.metadata?.language || '').toLowerCase();
  if (!sourceLanguage || sourceLanguage === 'en') {
    return subtitleData;
  }

  try {
    const texts = subtitleData.subtitles.map((entry) => entry.text);
    const translatedTexts = await translator.translateTexts({
      texts,
      sourceLanguage,
      targetLanguage: 'en'
    });

    subtitleData.subtitles = subtitleData.subtitles.map((entry, idx) => ({
      ...entry,
      text: translatedTexts[idx] || entry.text
    }));

    subtitleData.metadata.sourceLanguage = sourceLanguage;
    subtitleData.metadata.language = 'en';
    subtitleData.metadata.translated = true;
  } catch (error) {
    console.error('[translator] Failed to translate subtitles:', error);
  }

  return subtitleData;
}

/**
 * Process a single movie
 */
async function processMovie(movieData) {
  const movieTitle = movieData.part_title || movieData.manifest_title || 'Movie';
  console.log(`[processor] Processing movie: ${movieTitle}`);
  console.log(`[processor] HLS path: ${movieData.relative_path}`);
  
  const tempAudioPath = path.join(config.TEMP_DIR, 'audio', `movie_${movieData.entry_id}_${Date.now()}.wav`);
  
  try {
    // Ensure temp directory exists
    await fs.mkdir(path.dirname(tempAudioPath), { recursive: true });
    
    // Step 1: Extract audio from HLS
    console.log(`[processor] Step 1: Extracting audio...`);
    await audioExtractor.extractAudioFromHLS(movieData.relative_path, tempAudioPath);
    
    // Step 2: Transcribe with Whisper
    console.log(`[processor] Step 2: Transcribing audio...`);
    const whisperOutput = await transcriber.transcribeAudio(tempAudioPath);
    
    // Step 3: Convert to subtitle format
    console.log(`[processor] Step 3: Converting to subtitle format...`);
    let subtitleData = transcriber.convertToSubtitleFormat(whisperOutput);
    
    // Step 3b: Translate to English if needed
    subtitleData = await translateSubtitleData(subtitleData);
    
    // Step 4: Generate subtitle file path and save
    console.log(`[processor] Step 4: Saving subtitle file...`);
    const subtitlePath = subtitleGenerator.getMovieSubtitlePath(movieTitle);
    await subtitleGenerator.saveSubtitleFile(subtitlePath, subtitleData);
    
    // Step 5: Update database
    console.log(`[processor] Step 5: Updating database...`);
    await db.recordSubtitle({
      entityType: 'movie',
      entryId: movieData.entry_id,
      manifestId: movieData.manifest_id,
      title: movieTitle,
      relativePath: movieData.relative_path,
      subtitlePath
    });
    
    // Clean up temp audio file
    await fs.unlink(tempAudioPath).catch(() => {});
    
    console.log(`[processor] Movie processing complete: ${movieTitle}`);
    return true;
  } catch (error) {
    console.error(`[processor] Error processing movie ${movieTitle}:`, error);
    // Clean up temp audio file on error
    await fs.unlink(tempAudioPath).catch(() => {});
    throw error;
  }
}

/**
 * Process a single episode
 */
async function processEpisode(episodeData) {
  const episodeTitle = episodeData.episode_title || episodeData.display_name || 'Episode';
  console.log(`[processor] Processing episode: ${episodeTitle} (${episodeData.show_title || 'Unknown Show'})`);
  console.log(`[processor] HLS path: ${episodeData.relative_path}`);
  
  const tempAudioPath = path.join(config.TEMP_DIR, 'audio', `episode_${episodeData.entry_id}_${Date.now()}.wav`);
  
  try {
    // Ensure temp directory exists
    await fs.mkdir(path.dirname(tempAudioPath), { recursive: true });
    
    // Step 1: Extract audio from HLS
    console.log(`[processor] Step 1: Extracting audio...`);
    await audioExtractor.extractAudioFromHLS(episodeData.relative_path, tempAudioPath);
    
    // Step 2: Transcribe with Whisper
    console.log(`[processor] Step 2: Transcribing audio...`);
    const whisperOutput = await transcriber.transcribeAudio(tempAudioPath);
    
    // Step 3: Convert to subtitle format
    console.log(`[processor] Step 3: Converting to subtitle format...`);
    let subtitleData = transcriber.convertToSubtitleFormat(whisperOutput);
    
    // Step 3b: Translate to English if needed
    subtitleData = await translateSubtitleData(subtitleData);
    
    // Step 4: Generate subtitle file path and save
    console.log(`[processor] Step 4: Saving subtitle file...`);
    const subtitlePath = subtitleGenerator.getEpisodeSubtitlePath(
      episodeData.show_title || 'Show',
      episodeData.season_label || null,
      episodeTitle
    );
    await subtitleGenerator.saveSubtitleFile(subtitlePath, subtitleData);
    
    // Step 5: Update database
    console.log(`[processor] Step 5: Updating database...`);
    await db.recordSubtitle({
      entityType: 'episode',
      entryId: episodeData.entry_id,
      manifestId: episodeData.manifest_id,
      title: episodeTitle,
      showTitle: episodeData.show_title || null,
      relativePath: episodeData.relative_path,
      subtitlePath
    });
    
    // Clean up temp audio file
    await fs.unlink(tempAudioPath).catch(() => {});
    
    console.log(`[processor] Episode processing complete: ${episodeTitle}`);
    return true;
  } catch (error) {
    console.error(`[processor] Error processing episode ${episodeTitle}:`, error);
    // Clean up temp audio file on error
    await fs.unlink(tempAudioPath).catch(() => {});
    throw error;
  }
}

/**
 * Main processing loop - processes one item at a time in alphabetical order
 */
async function processNext() {
  if (isProcessing || shouldStop) {
    return;
  }
  
  isProcessing = true;
  
  try {
    // Find next item (movie or episode) in alphabetical order
    let item = await db.findNextItemWithoutSubtitles();
    
    if (item) {
      if (item.type === 'movie') {
        await processMovie(item);
      } else {
        await processEpisode(item);
      }
      isProcessing = false;
      // Continue processing
      setTimeout(processNext, 1000);
      return;
    }
    
    // No more items to process
    console.log('[processor] No more items to process. Waiting 30 seconds before checking again...');
    isProcessing = false;
    setTimeout(processNext, 30000); // Check again in 30 seconds
    
  } catch (error) {
    console.error('[processor] Error in processing loop:', error);
    isProcessing = false;
    // Wait a bit before retrying
    setTimeout(processNext, 10000);
  }
}

/**
 * Start the processing loop
 */
function start() {
  console.log('[processor] Starting subtitle processing service...');
  shouldStop = false;
  processNext();
}

/**
 * Stop the processing loop
 */
function stop() {
  console.log('[processor] Stopping subtitle processing service...');
  shouldStop = true;
}

module.exports = {
  start,
  stop,
  processNext
};

