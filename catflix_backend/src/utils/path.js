const fs = require('fs');
const path = require('path');

function firstExistingPath(paths) {
  for (const candidate of paths) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (err) {
      // ignore permission/ENOENT errors
    }
  }
  return null;
}

function determineRootDir(baseDir) {
  const candidates = [
    path.resolve(baseDir),
    path.resolve(baseDir, '..'),
    path.resolve(baseDir, '../..')
  ];
  for (const dir of candidates) {
    const frontendDir = path.join(dir, 'frontend');
    if (fs.existsSync(frontendDir)) {
      return dir;
    }
  }
  return path.resolve(baseDir);
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function fromPosix(p) {
  return p.split('/').join(path.sep);
}

module.exports = {
  firstExistingPath,
  determineRootDir,
  toPosix,
  fromPosix
};
