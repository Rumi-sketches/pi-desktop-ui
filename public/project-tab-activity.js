// Per-chat activity shared by project tabs. A completed response remains unread
// until that chat is actually viewed, even if another chat in its project is open.
/**
 * @param {{ cwdForKey: (key: string) => string | null | undefined }} options
 */
export function createProjectTabActivity({ cwdForKey }) {
  const runningKeys = new Set();
  const unseenKeys = new Set();

  return {
    runningKeys,
    /** @param {string[]} keys */
    replaceRunning(keys) {
      runningKeys.clear();
      for (const key of keys) runningKeys.add(key);
    },
    /** @param {string} key @param {boolean} running @param {boolean} viewed */
    recordRunning(key, running, viewed = false) {
      const wasRunning = runningKeys.has(key);
      if (running) {
        runningKeys.add(key);
        unseenKeys.delete(key);
      } else {
        runningKeys.delete(key);
        if (wasRunning && !viewed) unseenKeys.add(key);
      }
      return wasRunning;
    },
    /** @param {string} key */
    viewed(key) { return unseenKeys.delete(key); },
    /** @param {string} oldKey @param {string} newKey */
    rekey(oldKey, newKey) {
      if (runningKeys.delete(oldKey)) runningKeys.add(newKey);
      if (unseenKeys.delete(oldKey)) unseenKeys.add(newKey);
    },
    /** @param {string | null} cwd */
    status(cwd) {
      const belongs = (key) => cwd === null || cwdForKey(key)?.toLowerCase() === cwd.toLowerCase();
      if ([...runningKeys].some(belongs)) return 'working';
      if ([...unseenKeys].some(belongs)) return 'unseen';
      return 'idle';
    },
  };
}
