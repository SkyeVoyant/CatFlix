const { Pool } = require('pg');

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const host = process.env.PGHOST || 'localhost';
  const port = process.env.PGPORT || '5434';
  const dbName = process.env.PGDATABASE || 'CatFlixDB';
  const user = process.env.PGUSER || 'catflix';
  const password = process.env.PGPASSWORD || 'catflix';
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(dbName)}`;
}

const pool = new Pool({ connectionString: resolveDatabaseUrl() });
pool.on('error', (err) => {
  console.error('[pg] Unexpected error', err);
});

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS movies (
      id BIGSERIAL PRIMARY KEY,
      title TEXT UNIQUE NOT NULL,
      metadata JSONB,
      added_at TIMESTAMPTZ DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_movies_title_lower ON movies (LOWER(title))`,
  `CREATE TABLE IF NOT EXISTS movie_files (
      id BIGSERIAL PRIMARY KEY,
      movie_id BIGINT REFERENCES movies(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      hls_path TEXT,
      added_at TIMESTAMPTZ DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_movie_files_movie_id ON movie_files (movie_id)`,
  `CREATE INDEX IF NOT EXISTS idx_movie_files_relative_path ON movie_files (relative_path)`,
  `CREATE TABLE IF NOT EXISTS shows (
      id BIGSERIAL PRIMARY KEY,
      title TEXT UNIQUE NOT NULL,
      metadata JSONB,
      added_at TIMESTAMPTZ DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_shows_title_lower ON shows (LOWER(title))`,
  `CREATE TABLE IF NOT EXISTS seasons (
      id BIGSERIAL PRIMARY KEY,
      show_id BIGINT REFERENCES shows(id) ON DELETE CASCADE,
      season_label TEXT NOT NULL,
      season_number INTEGER,
      added_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (show_id, season_label)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_seasons_show_id ON seasons (show_id)`,
  `CREATE TABLE IF NOT EXISTS episodes (
      id BIGSERIAL PRIMARY KEY,
      season_id BIGINT REFERENCES seasons(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      hls_path TEXT,
      episode_number INTEGER,
      added_at TIMESTAMPTZ DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_episodes_season_id ON episodes (season_id)`,
  `CREATE INDEX IF NOT EXISTS idx_episodes_relative_path ON episodes (relative_path)`,
  `CREATE TABLE IF NOT EXISTS media_manifest_entries (
      id BIGSERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('movie','show')),
      title TEXT NOT NULL,
      payload JSONB NOT NULL,
      added_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (entity_type, title)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_manifest_entity_type ON media_manifest_entries (entity_type)`,
  `CREATE INDEX IF NOT EXISTS idx_manifest_title_lower ON media_manifest_entries (entity_type, LOWER(title))`,
  `CREATE INDEX IF NOT EXISTS idx_manifest_added_at ON media_manifest_entries (added_at DESC)`
];

async function ensureDatabaseSchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const statement of SCHEMA_STATEMENTS) {
      await client.query(statement);
    }
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // ignore rollback errors
    }
    throw err;
  } finally {
    client.release();
  }
}

let schemaPromise;

function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = ensureDatabaseSchema().catch((err) => {
      console.error('[pg] Failed to initialise schema', err);
      throw err;
    });
  }
  return schemaPromise;
}

const schemaReady = ensureSchema();

module.exports = {
  pool,
  resolveDatabaseUrl,
  ensureSchema,
  schemaReady
};
