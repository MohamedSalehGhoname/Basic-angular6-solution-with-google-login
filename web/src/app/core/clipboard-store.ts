import { Injectable, effect, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { VaultService } from './vault.service';

export interface ClipboardEntry {
  id: string;
  text: string;
  device: string;
  copiedAt: number;
}

/**
 * On-disk shape: everything but the item id is inside the encrypted blob,
 * so storage (and later the sync server) learns only how many items exist
 * and their order.
 */
interface StoredItem {
  id: string;
  blob: string;
}

interface StoredList {
  version: 1;
  items: StoredItem[];
}

const MAX_ITEMS = 200;

/**
 * Clipboard history, decrypted in memory while the vault is unlocked.
 * Persisted per account in localStorage until the sync server exists;
 * locking the vault drops all plaintext.
 */
@Injectable({ providedIn: 'root' })
export class ClipboardStore {
  private readonly auth = inject(AuthService);
  private readonly vault = inject(VaultService);

  private readonly _items = signal<ClipboardEntry[]>([]);
  readonly items = this._items.asReadonly();

  /** Stored items that failed to decrypt on the last load (corrupt or foreign blobs). */
  private readonly _skipped = signal(0);
  readonly skipped = this._skipped.asReadonly();

  private loadedUid: string | null = null;

  constructor() {
    effect(() => {
      if (this.vault.status() !== 'unlocked') {
        this._items.set([]);
        this._skipped.set(0);
        this.loadedUid = null;
      }
    });
  }

  async load(): Promise<void> {
    const uid = this.requireUid();
    if (this.loadedUid === uid) {
      return;
    }
    const stored = this.readStored(uid);
    const entries: ClipboardEntry[] = [];
    let skipped = 0;
    for (const item of stored.items) {
      try {
        const payload = JSON.parse(await this.vault.decryptItem(item.blob)) as Omit<
          ClipboardEntry,
          'id'
        >;
        entries.push({ id: item.id, ...payload });
      } catch {
        skipped += 1;
      }
    }
    this._items.set(entries);
    this._skipped.set(skipped);
    this.loadedUid = uid;
  }

  async add(text: string): Promise<ClipboardEntry | null> {
    if (!text.trim()) {
      return null;
    }
    const uid = this.requireUid();
    const entry: ClipboardEntry = {
      id: crypto.randomUUID(),
      text,
      device: 'Web',
      copiedAt: Date.now(),
    };
    const blob = await this.vault.encryptItem(
      JSON.stringify({ text: entry.text, device: entry.device, copiedAt: entry.copiedAt }),
    );

    const stored = this.readStored(uid);
    stored.items = [{ id: entry.id, blob }, ...stored.items].slice(0, MAX_ITEMS);
    this.writeStored(uid, stored);
    this._items.update((items) => [entry, ...items].slice(0, MAX_ITEMS));
    return entry;
  }

  remove(id: string): void {
    const uid = this.requireUid();
    const stored = this.readStored(uid);
    stored.items = stored.items.filter((item) => item.id !== id);
    this.writeStored(uid, stored);
    this._items.update((items) => items.filter((item) => item.id !== id));
  }

  clear(): void {
    const uid = this.requireUid();
    this.writeStored(uid, { version: 1, items: [] });
    this._items.set([]);
    this._skipped.set(0);
  }

  private requireUid(): string {
    const uid = this.auth.user()?.uid;
    if (!uid) {
      throw new Error('Not signed in.');
    }
    return uid;
  }

  private storageKey(uid: string): string {
    return `clipsync.items.${uid}`;
  }

  private readStored(uid: string): StoredList {
    try {
      const raw = localStorage.getItem(this.storageKey(uid));
      if (!raw) {
        return { version: 1, items: [] };
      }
      const parsed = JSON.parse(raw) as StoredList;
      return parsed.version === 1 && Array.isArray(parsed.items)
        ? parsed
        : { version: 1, items: [] };
    } catch {
      return { version: 1, items: [] };
    }
  }

  private writeStored(uid: string, list: StoredList): void {
    localStorage.setItem(this.storageKey(uid), JSON.stringify(list));
  }
}
