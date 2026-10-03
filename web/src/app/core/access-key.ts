import { signal } from '@angular/core';

const STORAGE_KEY = 'clipsync.accessKey';

/**
 * The shared access key a deployment may require while sign-in is still the
 * insecure dev mode (see syncConfig.accessKeyRequired). Entered once per
 * device on the login page and sent with every sync request.
 */
export function getAccessKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setAccessKey(key: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, key.trim());
  } catch {
    // Without storage the key lasts only until the page reloads.
  }
  accessKeyRejected.set(false);
}

/** Set when the server turned the stored key away; the login page asks again. */
export const accessKeyRejected = signal(false);

export function rejectAccessKey(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored.
  }
  accessKeyRejected.set(true);
}
