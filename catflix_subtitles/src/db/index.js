const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({ connectionString: config.DATABASE_URL });
pool.on('error', (err) => {
  console.error('[pg] Unexpected error', err);
});

const FIND_MOVIE_SQL = `
  SELECT 
    mme.id AS manifest_id,
    mme.title AS manifest_title,
    (part->>'id')::BIGINT AS entry_id,
    COALESCE(NULLIF(part->>'title', ''), mme.title) AS part_title,
    part->>'relative' AS relative_path,
    (part->>'addedAt')::BIGINT AS added_at
  FROM media_manifest_entries mme
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(mme.payload->'parts', '[]'::jsonb)) part
  LEFT JOIN subtitles s 
    ON s.entity_type = 'movie' 
   AND s.relative_path = part->>'relative'
  WHERE mme.entity_type = 'movie'
    AND (part->>'id') IS NOT NULL
    AND COALESCE(part->>'sourceType', '') ILIKE 'hls'
    AND COALESCE(part->>'relative', '') <> ''
    AND s.id IS NULL
  ORDER BY LOWER(mme.title) ASC
  LIMIT 1;
`;

const FIND_EPISODE_SQL = `
  SELECT 
    mme.id AS manifest_id,
    mme.title AS show_title,
    season->>'season' AS season_label,
    (episode->>'id')::BIGINT AS entry_id,
    COALESCE(NULLIF(episode->>'title', ''), 'Episode') AS episode_title,
    episode->>'relative' AS relative_path,
    (episode->>'addedAt')::BIGINT AS added_at
  FROM media_manifest_entries mme
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(mme.payload->'seasons', '[]'::jsonb)) season
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(season->'episodes', '[]'::jsonb)) episode
  LEFT JOIN subtitles s 
    ON s.entity_type = 'episode' 
   AND s.relative_path = episode->>'relative'
  WHERE mme.entity_type = 'show'
    AND (episode->>'id') IS NOT NULL
    AND COALESCE(episode->>'sourceType', '') ILIKE 'hls'
    AND COALESCE(episode->>'relative', '') <> ''
    AND s.id IS NULL
  ORDER BY 
    LOWER(mme.title) ASC,
    COALESCE((SELECT NULLIF(regexp_replace(season->>'season', '[^0-9]', '', 'g'), '')::INT), 999999) ASC,
    COALESCE((episode->>'episodeNumber')::INT, 999999) ASC
  LIMIT 1;
`;

async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name='movie_files' AND column_name='subtitle_path'
        ) THEN
          ALTER TABLE movie_files ADD COLUMN subtitle_path TEXT;
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name='episodes' AND column_name='subtitle_path'
        ) THEN
          ALTER TABLE episodes ADD COLUMN subtitle_path TEXT;
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS subtitles (
        id BIGSERIAL PRIMARY KEY,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('movie','episode')),
        entry_id BIGINT NOT NULL,
        manifest_id BIGINT,
        title TEXT,
        show_title TEXT,
        relative_path TEXT NOT NULL,
        subtitle_path TEXT,
        status TEXT NOT NULL DEFAULT 'ready',
        generated_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(entity_type, relative_path)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_subtitles_entity_relative 
      ON subtitles (entity_type, relative_path);
    `);
  } finally {
    client.release();
  }
}

async function findMovieWithoutSubtitles() {
  const result = await pool.query(FIND_MOVIE_SQL);
  return result.rows[0] || null;
}

async function findEpisodeWithoutSubtitles() {
  const result = await pool.query(FIND_EPISODE_SQL);
  return result.rows[0] || null;
}

async function recordSubtitle({
  entityType,
  entryId,
  manifestId,
  title,
  showTitle = null,
  relativePath,
  subtitlePath
}) {
  await pool.query(
    `
      INSERT INTO subtitles (entity_type, entry_id, manifest_id, title, show_title, relative_path, subtitle_path, status, generated_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'ready', NOW(), NOW())
      ON CONFLICT (entity_type, relative_path)
      DO UPDATE SET 
        entry_id = EXCLUDED.entry_id,
        manifest_id = EXCLUDED.manifest_id,
        title = EXCLUDED.title,
        show_title = EXCLUDED.show_title,
        subtitle_path = EXCLUDED.subtitle_path,
        status = 'ready',
        updated_at = NOW();
    `,
    [entityType, entryId, manifestId, title, showTitle, relativePath, subtitlePath]
  );
}

async function getSubtitleRecord(entityType, entryId) {
  const result = await pool.query(
    'SELECT subtitle_path, title, show_title FROM subtitles WHERE entity_type = $1 AND entry_id = $2 LIMIT 1',
    [entityType, entryId]
  );
  return result.rows[0] || null;
}

async function getSubtitleRecordByPath(entityType, relativePath) {
  const result = await pool.query(
    'SELECT subtitle_path, title, show_title FROM subtitles WHERE entity_type = $1 AND relative_path = $2 LIMIT 1',
    [entityType, relativePath]
  );
  return result.rows[0] || null;
}

module.exports = {
  pool,
  ensureSchema,
  findMovieWithoutSubtitles,
  findEpisodeWithoutSubtitles,
  recordSubtitle,
  getSubtitleRecord,
  getSubtitleRecordByPath
};

