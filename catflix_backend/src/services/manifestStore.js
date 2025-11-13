const { pool } = require('../db');
const { broadcastManifestEvents } = require('./manifestEvents');

const ENTITY_TYPES = {
  MOVIE: 'movie',
  SHOW: 'show'
};

function normalizeTitleKey(value) {
  return (value || '').trim().toLowerCase();
}

function clonePayload(payload = {}) {
  return JSON.parse(JSON.stringify(payload));
}

function ensurePayloadType(entityType, payload = {}) {
  const cloned = clonePayload(payload);
  cloned.type = entityType;
  return cloned;
}

function rowToManifestPayload(row) {
  if (!row) return null;
  const payload = ensurePayloadType(row.entity_type, row.payload || {});
  if (!Number.isFinite(payload.addedAt) && row.added_at) {
    const ts = new Date(row.added_at).getTime();
    if (Number.isFinite(ts)) {
      payload.addedAt = ts;
    }
  }
  return payload;
}

function buildEntryKey(entityType, title) {
  return `${entityType}::${normalizeTitleKey(title)}`;
}

function flattenManifest(manifest = {}) {
  const entries = [];
  for (const movie of manifest.movies || []) {
    if (!movie || !movie.title) continue;
    entries.push({
      entityType: ENTITY_TYPES.MOVIE,
      title: movie.title,
      payload: movie,
      addedAt: movie.addedAt
    });
  }
  for (const show of manifest.shows || []) {
    if (!show || !show.title) continue;
    entries.push({
      entityType: ENTITY_TYPES.SHOW,
      title: show.title,
      payload: show,
      addedAt: show.addedAt
    });
  }
  return entries;
}

async function writeEntry({ entityType, title, payload, addedAt }, client = pool) {
  if (!entityType || !title) {
    throw new Error('manifest entry missing entity type or title');
  }
  const normalizedPayload = ensurePayloadType(entityType, payload || {});
  const addedAtDate = Number.isFinite(addedAt ?? normalizedPayload.addedAt)
    ? new Date(addedAt ?? normalizedPayload.addedAt)
    : new Date();
  const { rows } = await client.query(
    `INSERT INTO media_manifest_entries (entity_type, title, payload, added_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (entity_type, title)
     DO UPDATE SET payload = EXCLUDED.payload,
                   added_at = EXCLUDED.added_at,
                   updated_at = NOW()
     RETURNING entity_type, title, payload, added_at`,
    [entityType, title, normalizedPayload, addedAtDate]
  );
  const row = rows[0];
  return {
    entityType: row.entity_type,
    title: row.title,
    payload: rowToManifestPayload(row)
  };
}

async function deleteEntry({ entityType, title }, client = pool) {
  if (!entityType || !title) return false;
  const res = await client.query(
    'DELETE FROM media_manifest_entries WHERE entity_type = $1 AND LOWER(title) = LOWER($2)',
    [entityType, title]
  );
  return res.rowCount > 0;
}

async function getManifestSnapshot() {
  const { rows } = await pool.query(
    'SELECT entity_type, title, payload, added_at FROM media_manifest_entries ORDER BY entity_type, title'
  );
  const movies = [];
  const shows = [];
  for (const row of rows) {
    const payload = rowToManifestPayload(row);
    if (!payload) continue;
    if (row.entity_type === ENTITY_TYPES.MOVIE) {
      movies.push(payload);
    } else if (row.entity_type === ENTITY_TYPES.SHOW) {
      shows.push(payload);
    }
  }
  movies.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  shows.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  return { movies, shows };
}

async function getManifestEntry(entityType, title) {
  if (!entityType || !title) return null;
  const { rows } = await pool.query(
    `SELECT entity_type, title, payload, added_at
     FROM media_manifest_entries
     WHERE entity_type = $1 AND LOWER(title) = LOWER($2)
     LIMIT 1`,
    [entityType, title]
  );
  return rows[0] ? rowToManifestPayload(rows[0]) : null;
}

async function saveManifestEntry({ entityType, payload }) {
  const stored = await writeEntry({
    entityType,
    title: payload?.title,
    payload,
    addedAt: payload?.addedAt
  });
  broadcastManifestEvents([
    { action: 'upsert', entityType: stored.entityType, payload: stored.payload }
  ]);
  return stored.payload;
}

async function removeManifestEntry({ entityType, title }) {
  const removed = await deleteEntry({ entityType, title });
  if (removed) {
    broadcastManifestEvents([
      { action: 'delete', entityType, title }
    ]);
  }
  return removed;
}

function payloadsDiffer(a, b) {
  return JSON.stringify(a || null) !== JSON.stringify(b || null);
}

async function syncManifest(manifest) {
  const desiredEntries = flattenManifest(manifest);
  const desiredMap = new Map();
  for (const entry of desiredEntries) {
    desiredMap.set(buildEntryKey(entry.entityType, entry.title), entry);
  }

  const client = await pool.connect();
  const events = [];
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT entity_type, title, payload FROM media_manifest_entries'
    );
    const existingMap = new Map();
    for (const row of rows) {
      existingMap.set(buildEntryKey(row.entity_type, row.title), row);
    }

    for (const entry of desiredEntries) {
      const key = buildEntryKey(entry.entityType, entry.title);
      const existing = existingMap.get(key);
      if (!existing || payloadsDiffer(existing.payload, entry.payload)) {
        const stored = await writeEntry(entry, client);
        events.push({ action: 'upsert', entityType: stored.entityType, payload: stored.payload });
      }
    }

    for (const [key, row] of existingMap.entries()) {
      if (!desiredMap.has(key)) {
        await deleteEntry({ entityType: row.entity_type, title: row.title }, client);
        events.push({ action: 'delete', entityType: row.entity_type, title: row.title });
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (events.length > 0) {
    broadcastManifestEvents(events);
  }
  return {
    upserts: events.filter((e) => e.action === 'upsert').length,
    deletes: events.filter((e) => e.action === 'delete').length
  };
}

module.exports = {
  ENTITY_TYPES,
  getManifestSnapshot,
  getManifestEntry,
  saveManifestEntry,
  removeManifestEntry,
  syncManifest
};
