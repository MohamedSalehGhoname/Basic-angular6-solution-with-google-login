import { DestroyRef, Injectable, effect, inject, signal } from '@angular/core';
import { VaultService } from './vault.service';

/** Minutes of being left alone before the vault locks; 0 = never. */
export type AutoLockMinutes = 0 | 1 | 5 | 15 | 60;

export const AUTO_LOCK_CHOICES: AutoLockMinutes[] = [0, 1, 5, 15, 60];

const STORAGE_KEY = 'clipsync.autolock';
const DEFAULT_MINUTES: AutoLockMinutes = 15;

/**
 * Locks the vault after it has been left alone.
 *
 * An unlocked vault keeps the key — and everything decrypted with it — in
 * memory, so the longer it stays open the more a lost or borrowed phone is
 * worth. Both kinds of idleness count: the app sitting in the background, and
 * the app on screen with nobody touching it.
 *
 * The clock is wall time, not a timer left to run: a phone sleeps its timers,
 * so the elapsed time is compared on the way back instead. The preference is
 * per-device, like the theme.
 */
@Injectable({ providedIn: 'root' })
export class AutoLockService {
  private readonly vault = inject(VaultService);

  private readonly _minutes = signal<AutoLockMinutes>(this.read());
  readonly minutes = this._minutes.asReadonly();

  /** When the user (or the app) was last seen; null while locked. */
  private lastSeen = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const activity = () => this.touch();
    const visibility = () => {
      if (document.visibilityState === 'visible') {
        // Back from the background: the time away counts as idle.
        this.lockIfIdle();
        this.touch();
      } else {
        this.touch();
      }
    };

    for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
      document.addEventListener(event, activity, { passive: true, capture: true });
    }
    document.addEventListener('visibilitychange', visibility);
    // While the app is on screen, a minute's resolution is enough to notice.
    this.timer = setInterval(() => this.lockIfIdle(), 15_000);

    // Re-arm whenever the vault is opened, so unlocking starts the clock over.
    effect(() => {
      if (this.vault.status() === 'unlocked') {
        this.touch();
      }
    });

    inject(DestroyRef).onDestroy(() => {
      for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
        document.removeEventListener(event, activity, { capture: true });
      }
      document.removeEventListener('visibilitychange', visibility);
      if (this.timer) {
        clearInterval(this.timer);
      }
    });
  }

  set(minutes: AutoLockMinutes): void {
    this._minutes.set(minutes);
    this.touch();
    try {
      localStorage.setItem(STORAGE_KEY, String(minutes));
    } catch {
      // Preference only.
    }
  }

  /** Marks the vault as in use right now. */
  touch(): void {
    this.lastSeen = Date.now();
  }

  /** Locks if the vault has been left alone for longer than the setting. */
  lockIfIdle(atMs: number = Date.now()): boolean {
    const minutes = this._minutes();
    if (minutes === 0 || this.vault.status() !== 'unlocked') {
      return false;
    }
    if (atMs - this.lastSeen < minutes * 60_000) {
      return false;
    }
    this.vault.lock();
    return true;
  }

  private read(): AutoLockMinutes {
    // Nothing stored means the user has never chosen, which is not the same as
    // choosing never: Number(null) is 0, and 0 is "never".
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_MINUTES;
    }
    const stored = Number(raw);
    return (AUTO_LOCK_CHOICES as number[]).includes(stored)
      ? (stored as AutoLockMinutes)
      : DEFAULT_MINUTES;
  }
}
