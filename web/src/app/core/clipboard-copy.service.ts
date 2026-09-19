import { Injectable, inject, signal } from '@angular/core';
import { NativeBridge } from './native-bridge.service';

const DEFAULT_CLEAR_SECONDS = 12;

/**
 * Copies a value to the OS clipboard and, KeePass-style, clears it again after
 * a short delay so a copied password does not linger. The clear only wipes the
 * clipboard if it still holds the copied value (best-effort — if the browser
 * denies reading it back, it clears anyway, matching KeePass). Uses the native
 * clipboard on mobile via NativeBridge.
 */
@Injectable({ providedIn: 'root' })
export class ClipboardCopyService {
  private readonly native = inject(NativeBridge);

  private readonly _secondsLeft = signal(0);
  /** Seconds until the clipboard is wiped; 0 when idle. */
  readonly secondsLeft = this._secondsLeft.asReadonly();

  private readonly _activeLabel = signal<string | null>(null);
  /** Label of the field currently counting down, or null. */
  readonly activeLabel = this._activeLabel.asReadonly();

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCopied: string | null = null;

  /** Copies without auto-clear (for non-sensitive fields like a username). */
  async copy(text: string): Promise<void> {
    await this.native.copy(text);
  }

  /** Copies and schedules an auto-clear after `seconds`. */
  async copyEphemeral(
    text: string,
    label: string,
    seconds = DEFAULT_CLEAR_SECONDS,
  ): Promise<void> {
    await this.native.copy(text);
    this.lastCopied = text;
    this._activeLabel.set(label);
    this._secondsLeft.set(seconds);

    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = setInterval(() => {
      const remaining = this._secondsLeft() - 1;
      if (remaining <= 0) {
        void this.clearNow();
      } else {
        this._secondsLeft.set(remaining);
      }
    }, 1000);
  }

  /** Wipes the clipboard immediately if it still holds the copied value. */
  async clearNow(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._secondsLeft.set(0);
    this._activeLabel.set(null);

    const copied = this.lastCopied;
    this.lastCopied = null;
    if (copied === null) {
      return;
    }
    try {
      const current = await this.native.readText();
      if (current !== copied) {
        return; // The user copied something else; leave it alone.
      }
    } catch {
      // Read denied — clear anyway, as KeePass does.
    }
    try {
      await this.native.copy('');
    } catch {
      // Nothing more we can do if writing is denied.
    }
  }
}
