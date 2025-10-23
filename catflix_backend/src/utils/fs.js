const fs = require('fs');
const path = require('path');

async function safeReaddir(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function safeStat(filePath) {
  try {
    return await fs.promises.stat(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function pathExists(targetPath) {
  if (!targetPath) return false;
  try {
    await fs.promises.access(targetPath, fs.constants.F_OK);
    return true;
  } catch (err) {
    return false;
  }
}

async function findM3u8Files(dir, maxDepth = 1) {
  const results = [];
  async function walk(currentDir, depth) {
    if (depth > maxDepth) return;
    const entries = await safeReaddir(currentDir);
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const stat = await safeStat(fullPath);
      if (!stat) continue;
      if (stat.isDirectory()) {
        if (depth < maxDepth) {
          await walk(fullPath, depth + 1);
        }
        continue;
      }
      if (!stat.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.m3u8')) continue;
      results.push({
        path: fullPath,
        mtimeMs: Math.round(stat.mtimeMs)
      });
    }
  }
  await walk(dir, 0);
  return results;
}

module.exports = {
  safeReaddir,
  safeStat,
  pathExists,
  findM3u8Files
};
