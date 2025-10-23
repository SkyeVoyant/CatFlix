const path = require('path');

class DirectoryTracker {
  constructor({ initialState = new Map(), initialScanCompleted = false } = {}) {
    this.state = initialState;
    this.initialScanCompleted = initialScanCompleted;
  }

  static key(absPath) {
    return path.resolve(absPath);
  }

  noteChange(absPath, mtimeMs) {
    if (mtimeMs == null) return;
    const key = DirectoryTracker.key(absPath);
    this.state.set(key, mtimeMs);
  }

  hasChanged(absPath, mtimeMs) {
    if (mtimeMs == null) return false;
    const key = DirectoryTracker.key(absPath);
    const previous = this.state.get(key);
    if (!this.initialScanCompleted && previous === undefined) {
      this.state.set(key, mtimeMs);
      return false;
    }
    this.state.set(key, mtimeMs);
    return previous === undefined || previous !== mtimeMs;
  }

  markInitialScanComplete() {
    this.initialScanCompleted = true;
  }
}

module.exports = {
  DirectoryTracker
};
