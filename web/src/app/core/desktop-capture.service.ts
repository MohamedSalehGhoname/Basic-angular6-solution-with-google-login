import { Injectable, effect, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { ClipboardStore } from './clipboard-store';
import { VaultService } from './vault.service';

interface CapturedPayload {
  text: string;
  potentialSecret: boolean;
}

/** The API the Electron preload exposes on the window; absent in a browser. */
interface ClipsyncDesktopApi {
  isDesktop: true;
  onCaptured(callback: (payload: CapturedPayload) => void): () => void;
  setCaptureEnabled(enabled: boolean): void;
  setCaptureSecrets(enabled: boolean): void;
}

declare global {
  interface Window {
    clipsyncDesktop?: ClipsyncDesktopApi;
  }
}

const ENABLED_KEY = 'clipsync.desktop.capture';
const MAX_BUFFER = 20;

/**
 * Bridges OS clipboard captures from the Electron shell into the encrypted
 * clipboard vault. Captured text is added through the normal ClipboardStore
 * path (encrypted, synced) tagged as coming from the desktop. In a plain
 * browser this is inert (`available` is false).
 */
@Injectable({ providedIn: 'root' })
export class DesktopCaptureService {
  private readonly clipboard = inject(ClipboardStore);
  private readonly vault = inject(VaultService);
  private readonly auth = inject(AuthService);

  private readonly desktop = window.clipsyncDesktop;
  readonly available = !!this.desktop;

  private readonly _enabled = signal(this.readEnabled());
  readonly enabled = this._enabled.asReadonly();

  /** Captures that arrived while the vault was locked, flushed on unlock. */
  private buffer: string[] = [];

  constructor() {
    if (!this.desktop) {
      return;
    }
    this.desktop.setCaptureEnabled(this._enabled());

    this.desktop.onCaptured((payload) => void this.handleCapture(payload));

    // Flush anything captured while locked, once the vault is unlocked again.
    effect(() => {
      if (this.vault.status() === 'unlocked' && this.buffer.length > 0) {
        const pending = this.buffer;
        this.buffer = [];
        void this.flush(pending);
      }
    });
  }

  setEnabled(enabled: boolean): void {
    this._enabled.set(enabled);
    this.desktop?.setCaptureEnabled(enabled);
    if (!enabled) {
      this.buffer = [];
    }
    try {
      localStorage.setItem(ENABLED_KEY, JSON.stringify(enabled));
    } catch {
      // Preference only.
    }
  }

  private async handleCapture(payload: CapturedPayload): Promise<void> {
    if (!this._enabled() || !this.auth.user()) {
      return;
    }
    if (this.vault.status() !== 'unlocked') {
      // Hold a bounded number until the vault is unlocked.
      this.buffer = [...this.buffer, payload.text].slice(-MAX_BUFFER);
      return;
    }
    await this.store(payload.text);
  }

  private async flush(pending: string[]): Promise<void> {
    for (const text of pending) {
      await this.store(text);
    }
  }

  private async store(text: string): Promise<void> {
    try {
      await this.clipboard.add(text, { device: 'Desktop' });
    } catch {
      // Drop on failure; the value stays on the OS clipboard regardless.
    }
  }

  private readEnabled(): boolean {
    try {
      return localStorage.getItem(ENABLED_KEY) === 'true';
    } catch {
      return false;
    }
  }
}
