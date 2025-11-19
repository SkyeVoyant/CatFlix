require('dotenv').config();

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const host = process.env.PGHOST || 'localhost';
  const port = process.env.PGPORT || '5434';
  const dbName = process.env.PGDATABASE || 'CatFlixDB';
  const user = process.env.PGUSER || 'catflix';
  const password = process.env.PGPASSWORD || 'catflix';
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(dbName)}`;
}

module.exports = {
  MEDIA_DIR: process.env.MEDIA_DIR_CONTAINER || process.env.MEDIA_DIR || '/media',
  PORT: parseInt(process.env.PORT || '3006', 10),
  WHISPER_MODEL: process.env.WHISPER_MODEL || 'small', // small for accuracy/speed balance; options: tiny, base, small, medium, large-v3
  DATABASE_URL: resolveDatabaseUrl(),
  SUBTITLES_DIR: process.env.SUBTITLES_DIR || '/app/subtitles',
  TEMP_DIR: process.env.TEMP_DIR || '/app/temp'
};

