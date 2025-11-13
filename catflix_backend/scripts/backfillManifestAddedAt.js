#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { pool } = require('../src/db');
const config = require('../src/config');
const { fromPosix } = require('../src/utils/path');

async function statBirthtimeMs(absPath) {
  if (!absPath) return null;
  try {
    const stat = await fs.promises.stat(absPath);
    if (Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0) {
      return Math.round(stat.birthtimeMs);
    }
    const fallback = stat.birthtime?.getTime?.() || null;
    return Number.isFinite(fallback) ? fallback : null;
  } catch (_) {
    return null;
  }
}

function folderRelativeToAbsolute(folderRelative) {
  if (!folderRelative) return null;
  return path.join(config.MEDIA_DIR, fromPosix(folderRelative));
}

async function backfill() {
  const { rows } = await pool.query(
    'SELECT id, entity_type, title, payload FROM media_manifest_entries'
  );
  let updated = 0;
  for (const row of rows) {
    const payload = row.payload || {};
    const folderRelative = payload.folderRelative;
    const birthtimeMs = await statBirthtimeMs(folderRelativeToAbsolute(folderRelative));
    if (!Number.isFinite(birthtimeMs)) {
      continue;
    }
    await pool.query(
      'UPDATE media_manifest_entries SET added_at = $1 WHERE id = $2',
      [new Date(birthtimeMs), row.id]
    );
    updated += 1;
  }
  console.log(`[manifest-backfill] updated ${updated} entries`);
}

backfill()
  .catch((err) => {
    console.error('[manifest-backfill] failed', err);
    process.exitCode = 1;
  })
  .finally(() => {
    pool.end().catch(() => {});
  });
