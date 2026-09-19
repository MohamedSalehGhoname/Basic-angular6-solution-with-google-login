import { Injectable, effect, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { ClipboardStore } from './clipboard-store';
import { NativeBridge } from './native-bridge.service';
import { VaultService } from './vault.service';

type CapturedPayload =
  | { kind: 'text'; text: string; potentialSecret: boolean }
  | { kind: 'image'; image: string };

/** A clipboard entry preview handed to the compact picker overlay. */
interface PickerItem {
  id: string;
  kind: 'text' | 'image';
  /** Truncated text, or an image data URL for image items. */
  preview: string;
}

/** The API the Electron preload exposes on the window; absent in a browser. */
interface ClipsyncDesktopApi {
  isDesktop: true;
  onCaptured(callback: (payload: CapturedPayload) => void): () => void;
  onToggleCaptureRequested?(callback: () => void): () => void;
  updatePickerItems?(items: PickerItem[]): void;
  onPickerCopy?(callback: (id: string) => void): () => void;
  writeClipboard?(payload: { text?: string; image?: string; paste?: boolean }): void;
  setCaptureEnabled(enabled: boolean): void;
  setCaptureSecrets(enabled: boolean): void;
  // File sending (see FileShareService); absent on older desktop builds.
  onFileSend?(callback: (request: FileSendRequest) => void): Promise<() => void>;
  uploadFile?(requestId: string, uploadUrl: string, key: string | null): Promise<void>;
  forgetFile?(requestId: string): void;
  downloadFile?(args: {
    id: string;
    downloadUrl: string;
    name: string;
    key: string | null;
  }): Promise<string>;
  onFileProgress?(callback: (progress: FileProgress) => void): () => void;
  showWindow?(): void;
}

/** A file the user sent from Explorer's right-click menu. */
export interface FileSendRequest {
  requestId: string;
  name: string;
  sizeBytes: number;
}

export interface FileProgress {
  id: string;
  done: number;
  total: number;
}

declare global {
  interface Window {
    clipsyncDesktop?: ClipsyncDesktopApi;
  }
}

const ENABLED_KEY = 'clipsync.desktop.capture';
const MAX_BUFFER = 20;
/** How many items the overlay lists, and how long each text preview runs. */
const PICKER_MAX_ITEMS = 60;
const PICKER_PREVIEW_CHARS = 200;

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
  private readonly native = inject(NativeBridge);

  private readonly desktop = window.clipsyncDesktop;
  readonly available = !!this.desktop;

  private readonly _enabled = signal(this.readEnabled());
  readonly enabled = this._enabled.asReadonly();

  /** Captures that arrived while the vault was locked, flushed on unlock. */
  private buffer: CapturedPayload[] = [];

  constructor() {
    if (!this.desktop) {
      return;
    }
    this.desktop.setCaptureEnabled(this._enabled());

    this.desktop.onCaptured((payload) => void this.handleCapture(payload));
    // The tray menu can ask to toggle capture; keep our state authoritative.
    this.desktop.onToggleCaptureRequested?.(() => this.setEnabled(!this._enabled()));
    // Global hotkey overlay: it asks us (the unlocked renderer) to copy an id,
    // so the picker never has to decrypt anything or prompt for the passphrase.
    this.desktop.onPickerCopy?.((id) => void this.copyById(id));

    // Feed the overlay previews of the current clipboard list. The previews
    // are already-decrypted in-memory items; nothing is re-decrypted, and when
    // the vault is locked the list is empty so the overlay shows an unlock hint.
    effect(() => {
      this.desktop?.updatePickerItems?.(this.pickerItems());
    });

    // Flush anything captured while locked, once the vault is unlocked again.
    effect(() => {
      if (this.vault.status() === 'unlocked' && this.buffer.length > 0) {
        const pending = this.buffer;
        this.buffer = [];
        void this.flush(pending);
      }
    });
  }

  /** Truncated previews of the newest items for the picker overlay. */
  private pickerItems(): PickerItem[] {
    return this.clipboard
      .items()
      .filter((entry) => !entry.file)
      .slice(0, PICKER_MAX_ITEMS)
      .map((entry) =>
        entry.image
          ? { id: entry.id, kind: 'image' as const, preview: entry.image }
          : {
              id: entry.id,
              kind: 'text' as const,
              preview: entry.text.slice(0, PICKER_PREVIEW_CHARS),
            },
      );
  }

  /**
   * Copy the chosen clipboard entry to the OS clipboard. We hand the decrypted
   * value to the Electron main process, which writes it without needing a
   * focused document — the main window is hidden while the overlay is up, so
   * the renderer's own Clipboard API would be rejected. Falls back to the
   * browser path only if the desktop bridge is somehow unavailable.
   */
  private async copyById(id: string): Promise<void> {
    const entry = this.clipboard.items().find((item) => item.id === id);
    if (!entry) {
      return;
    }
    try {
      if (this.desktop?.writeClipboard) {
        // paste: true asks the shell to send Ctrl/Cmd+V to the active app.
        this.desktop.writeClipboard(
          entry.image
            ? { image: entry.image, paste: true }
            : { text: entry.text, paste: true },
        );
      } else if (entry.image) {
        await this.native.copyImage(entry.image);
      } else {
        await this.native.copy(entry.text);
      }
    } catch {
      // Nothing to surface from the background; the item stays in the list.
    }
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
      this.buffer = [...this.buffer, payload].slice(-MAX_BUFFER);
      return;
    }
    await this.store(payload);
  }

  private async flush(pending: CapturedPayload[]): Promise<void> {
    for (const payload of pending) {
      await this.store(payload);
    }
  }

  private async store(payload: CapturedPayload): Promise<void> {
    try {
      if (payload.kind === 'image') {
        await this.clipboard.addImage(payload.image, { device: 'Desktop' });
      } else {
        await this.clipboard.add(payload.text, { device: 'Desktop' });
      }
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
