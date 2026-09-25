/**
 * Removes one account's entries from local storage and leaves the device's own
 * preferences (theme, language, capture settings) in place. Every per-account
 * key ends in the uid, so they are found by suffix rather than by listing the
 * prefixes — one added elsewhere is covered without touching this.
 */
export function forgetLocalData(uid: string): void {
  try {
    const suffix = `.${uid}`;
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.endsWith(suffix)) {
        doomed.push(key);
      }
    }
    for (const key of doomed) {
      localStorage.removeItem(key);
    }
  } catch {
    // Private browsing, or storage the browser refuses: nothing was kept, so
    // there is nothing to remove.
  }
}
