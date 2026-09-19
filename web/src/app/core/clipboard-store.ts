import { Injectable, signal } from '@angular/core';
import { type Entry, SyncedCollection } from './synced-collection';

interface ClipboardPayload {
  /** For a text item, the text; for an image item, a short label. */
  text: string;
  /** Present for image items: a `data:image/…;base64,…` URL. */
  image?: string;
  /** Present for file items (then `text` is the file name). */
  file?: ClipboardFile;
  device: string;
  copiedAt: number;
  /** Epoch ms after which the item self-destructs; null/absent = keep forever. */
  expiresAt?: number | null;
}

/** A file sent to the clipboard, stored in GTDrive. */
export interface ClipboardFile {
  /** Storage id (`fil_…`). */
  id: string;
  name: string;
  /** Original size in bytes. */
  size: number;
  /** Base64 AES-256 key when the file was encrypted; absent when sent as-is. */
  key?: string;
}

export type ClipboardEntry = Entry<ClipboardPayload>;

/** Selectable defaults for how long new items live. */
export const TTL_OPTIONS = [
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '1 day', ms: 24 * 60 * 60 * 1000 },
  { label: '1 week', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: 'Forever', ms: null },
] as const;

const DEFAULT_TTL_MS: number | null = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30_000;
const MAX_ITEMS = 200;

/**
 * Clipboard history: an auto-expiring, newest-first synced collection.
 */
@Injectable({ providedIn: 'root' })
export class ClipboardStore extends SyncedCollection<ClipboardPayload> {
  /** TTL applied to newly added items; per device, not synced. */
  private readonly _ttlMs = signal<number | null>(DEFAULT_TTL_MS);
  readonly ttlMs = this._ttlMs.asReadonly();

  constructor() {
    super('clipboard', MAX_ITEMS);
    setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
  }

  async add(text: string, options: { device?: string } = {}): Promise<ClipboardEntry | null> {
    if (!text.trim()) {
      return null;
    }
    // Skip if this exact text is already the newest item (e.g. desktop capture
    // of something just added here), so a copy is not duplicated.
    if (this.items()[0]?.text === text) {
      return null;
    }
    const ttl = this._ttlMs();
    const now = Date.now();
    return this.create({
      text,
      device: options.device ?? 'Web',
      copiedAt: now,
      expiresAt: ttl === null ? null : now + ttl,
    });
  }

  /** Adds a captured image (a data URL) as a clipboard item. */
  async addImage(
    image: string,
    options: { device?: string; label?: string } = {},
  ): Promise<ClipboardEntry | null> {
    if (!image.startsWith('data:image/')) {
      return null;
    }
    // Skip if this exact image is already the newest item (avoid duplicates).
    if (this.items()[0]?.image === image) {
      return null;
    }
    const ttl = this._ttlMs();
    const now = Date.now();
    return this.create({
      text: options.label ?? 'Image',
      image,
      device: options.device ?? 'Web',
      copiedAt: now,
      expiresAt: ttl === null ? null : now + ttl,
    });
  }

  /** Adds a file that has been uploaded to storage. */
  async addFile(file: ClipboardFile, options: { device?: string } = {}): Promise<ClipboardEntry> {
    const ttl = this._ttlMs();
    const now = Date.now();
    return this.create({
      text: file.name,
      file,
      device: options.device ?? 'Web',
      copiedAt: now,
      expiresAt: ttl === null ? null : now + ttl,
    });
  }

  setTtl(ms: number | null): void {
    this._ttlMs.set(ms);
    const uid = this.auth.user()?.uid;
    if (uid) {
      try {
        localStorage.setItem(this.ttlKey(uid), JSON.stringify(ms));
      } catch {
        // Preference only; losing it is harmless.
      }
    }
  }

  protected override async onBeforeLoad(uid: string): Promise<void> {
    this._ttlMs.set(this.readTtl(uid));
  }

  protected override createdAt(entry: ClipboardEntry): number {
    return entry.copiedAt;
  }

  protected override isExpired(entry: ClipboardEntry): boolean {
    return entry.expiresAt != null && entry.expiresAt <= Date.now();
  }

  private ttlKey(uid: string): string {
    return `clipsync.ttl.${uid}`;
  }

  private readTtl(uid: string): number | null {
    try {
      const raw = localStorage.getItem(this.ttlKey(uid));
      if (raw === null) {
        return DEFAULT_TTL_MS;
      }
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === 'number' && parsed > 0 ? parsed : null;
    } catch {
      return DEFAULT_TTL_MS;
    }
  }
}
