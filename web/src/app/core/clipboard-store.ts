import { Injectable, effect, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { SyncApi, type SyncEvent } from './sync-api';
import { VaultService } from './vault.service';

export interface ClipboardEntry {
  id: string;
  text: string;
  device: string;
  copiedAt: number;
  /** Epoch ms after which the item self-destructs; null/absent = keep forever. */
  expiresAt?: number | null;
}

/** Selectable defaults for how long new items live. */
export const TTL_OPTIONS = [
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '1 day', ms: 24 * 60 * 60 * 1000 },
  { label: '1 week', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: 'Forever', ms: null },
] as const;

const DEFAULT_TTL_MS: number | null = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30_000;

/**
 * Mirror shape, also what the server stores: everything but the item id is
 * inside the encrypted blob, so neither storage nor server learns more than
 * item count and order.
 */
interface StoredItem {
  id: string;
  blob: string;
}

interface StoredList {
  version: 1;
  items: StoredItem[];
  /** Tombstones: ids deleted while offline, replayed on the next online load. */
  deleted: string[];
}

const MAX_ITEMS = 200;

/**
 * Clipboard history, decrypted in memory while the vault is unlocked.
 * The sync server is the source of truth; localStorage keeps an encrypted
 * mirror so the app works offline, and local-only items are pushed up on
 * the next online load. Remote changes arrive over the WebSocket and are
 * applied live. Locking the vault drops all plaintext and the connection.
 */
@Injectable({ providedIn: 'root' })
export class ClipboardStore {
  private readonly auth = inject(AuthService);
  private readonly vault = inject(VaultService);
  private readonly syncApi = inject(SyncApi);

  private readonly _items = signal<ClipboardEntry[]>([]);
  readonly items = this._items.asReadonly();

  /** Stored items that failed to decrypt on the last load (corrupt or foreign blobs). */
  private readonly _skipped = signal(0);
  readonly skipped = this._skipped.asReadonly();

  /** Live connectivity to the sync server. */
  private readonly _online = signal(false);
  readonly online = this._online.asReadonly();

  /** TTL applied to newly added items; per device, not synced. */
  private readonly _ttlMs = signal<number | null>(DEFAULT_TTL_MS);
  readonly ttlMs = this._ttlMs.asReadonly();

  private loadedUid: string | null = null;
  private disconnect: (() => void) | null = null;

  constructor() {
    effect(() => {
      if (this.vault.status() !== 'unlocked') {
        this._items.set([]);
        this._skipped.set(0);
        this.loadedUid = null;
        this.disconnect?.();
        this.disconnect = null;
        this._online.set(false);
      }
    });
    setInterval(() => {
      if (this.vault.status() === 'unlocked' && this.loadedUid) {
        this.sweepExpired();
      }
    }, SWEEP_INTERVAL_MS);
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

  /** Deletes every expired item locally and on the server. */
  sweepExpired(): void {
    const now = Date.now();
    for (const item of this._items()) {
      if (item.expiresAt != null && item.expiresAt <= now) {
        this.remove(item.id);
      }
    }
  }

  async load(): Promise<void> {
    const uid = this.requireUid();
    if (this.loadedUid === uid) {
      return;
    }
    this._ttlMs.set(this.readTtl(uid));

    const stored = this.readStored(uid);
    let storedItems = stored.items;
    let tombstones = [...stored.deleted];
    try {
      const replayed = new Set<string>();
      for (const id of tombstones) {
        try {
          await this.syncApi.deleteItem(id);
          replayed.add(id);
        } catch {
          // Replayed again on a later load.
        }
      }
      tombstones = tombstones.filter((id) => !replayed.has(id));

      const remote = (await this.syncApi.listItems()).filter(
        (item) => !tombstones.includes(item.id),
      );
      const remoteIds = new Set(remote.map((item) => item.id));
      const localOnly = storedItems.filter((item) => !remoteIds.has(item.id));
      for (const item of localOnly) {
        try {
          await this.syncApi.putItem(item.id, item.blob);
        } catch {
          // Pushed again on a later load.
        }
      }
      storedItems = [
        ...localOnly,
        ...remote.map(({ id, blob }) => ({ id, blob })),
      ];
      this._online.set(true);
    } catch {
      this._online.set(false);
    }

    const entries: ClipboardEntry[] = [];
    const blobsById = new Map<string, string>();
    let skipped = 0;
    for (const item of storedItems) {
      try {
        const payload = JSON.parse(await this.vault.decryptItem(item.blob)) as Omit<
          ClipboardEntry,
          'id'
        >;
        entries.push({ id: item.id, ...payload });
        blobsById.set(item.id, item.blob);
      } catch {
        skipped += 1;
      }
    }
    entries.sort((a, b) => b.copiedAt - a.copiedAt);
    const capped = entries.slice(0, MAX_ITEMS);

    // Expired items are dropped here and deleted on the server (tombstoned
    // until that delete goes through).
    const now = Date.now();
    const isExpired = (entry: ClipboardEntry) =>
      entry.expiresAt != null && entry.expiresAt <= now;
    const live = capped.filter((entry) => !isExpired(entry));
    const expired = capped.filter(isExpired);
    tombstones = [...new Set([...tombstones, ...expired.map((entry) => entry.id)])];

    this.writeStored(uid, {
      version: 1,
      items: live.map((entry) => ({ id: entry.id, blob: blobsById.get(entry.id)! })),
      deleted: tombstones,
    });
    this._items.set(live);
    this._skipped.set(skipped);
    this.loadedUid = uid;
    for (const entry of expired) {
      this.syncApi.deleteItem(entry.id).then(
        () => this.dropTombstones(uid, [entry.id]),
        () => {},
      );
    }
    this.connectSocket();
  }

  async add(text: string): Promise<ClipboardEntry | null> {
    if (!text.trim()) {
      return null;
    }
    const uid = this.requireUid();
    const ttl = this._ttlMs();
    const entry: ClipboardEntry = {
      id: crypto.randomUUID(),
      text,
      device: 'Web',
      copiedAt: Date.now(),
      expiresAt: ttl === null ? null : Date.now() + ttl,
    };
    const blob = await this.vault.encryptItem(
      JSON.stringify({
        text: entry.text,
        device: entry.device,
        copiedAt: entry.copiedAt,
        expiresAt: entry.expiresAt,
      }),
    );

    const stored = this.readStored(uid);
    stored.items = [{ id: entry.id, blob }, ...stored.items].slice(0, MAX_ITEMS);
    this.writeStored(uid, stored);
    this._items.update((items) => [entry, ...items].slice(0, MAX_ITEMS));

    try {
      await this.syncApi.putItem(entry.id, blob);
      this._online.set(true);
    } catch {
      this._online.set(false);
    }
    return entry;
  }

  remove(id: string): void {
    const uid = this.requireUid();
    this.removeLocally(uid, id, true);
    this.syncApi.deleteItem(id).then(
      () => {
        this.dropTombstones(uid, [id]);
        this._online.set(true);
      },
      () => this._online.set(false),
    );
  }

  clear(): void {
    const uid = this.requireUid();
    const ids = this.readStored(uid).items.map((item) => item.id);
    this.clearLocally(uid, ids);
    this.syncApi.clearItems().then(
      () => {
        this.dropTombstones(uid, ids);
        this._online.set(true);
      },
      () => this._online.set(false),
    );
  }

  private connectSocket(): void {
    if (this.disconnect) {
      return;
    }
    this.disconnect = this.syncApi.connect(
      (event) => void this.applyEvent(event),
      (online) => this._online.set(online),
    );
  }

  private async applyEvent(event: SyncEvent): Promise<void> {
    const uid = this.auth.user()?.uid;
    if (!uid || this.vault.status() !== 'unlocked') {
      return;
    }
    switch (event.type) {
      case 'item-added': {
        if (
          this._items().some((item) => item.id === event.item.id) ||
          this.readStored(uid).deleted.includes(event.item.id)
        ) {
          return;
        }
        try {
          const payload = JSON.parse(await this.vault.decryptItem(event.item.blob)) as Omit<
            ClipboardEntry,
            'id'
          >;
          const entry: ClipboardEntry = { id: event.item.id, ...payload };
          if (entry.expiresAt != null && entry.expiresAt <= Date.now()) {
            return;
          }
          const stored = this.readStored(uid);
          stored.items = [
            { id: entry.id, blob: event.item.blob },
            ...stored.items.filter((item) => item.id !== entry.id),
          ].slice(0, MAX_ITEMS);
          this.writeStored(uid, stored);
          this._items.update((items) => [entry, ...items].slice(0, MAX_ITEMS));
        } catch {
          this._skipped.update((count) => count + 1);
        }
        break;
      }
      case 'item-removed':
        // Already deleted on the server; no tombstone needed.
        this.removeLocally(uid, event.id, false);
        break;
      case 'items-cleared':
        this.clearLocally(uid);
        break;
      case 'vault-updated':
        // The vault record changed on another device (e.g. passphrase
        // change); nothing to do while this session stays unlocked.
        break;
    }
  }

  private removeLocally(uid: string, id: string, tombstone: boolean): void {
    const stored = this.readStored(uid);
    stored.items = stored.items.filter((item) => item.id !== id);
    if (tombstone && !stored.deleted.includes(id)) {
      stored.deleted.push(id);
    }
    this.writeStored(uid, stored);
    this._items.update((items) => items.filter((item) => item.id !== id));
  }

  private clearLocally(uid: string, tombstoneIds: string[] = []): void {
    const stored = this.readStored(uid);
    this.writeStored(uid, {
      version: 1,
      items: [],
      deleted: [...new Set([...stored.deleted, ...tombstoneIds])],
    });
    this._items.set([]);
    this._skipped.set(0);
  }

  private dropTombstones(uid: string, ids: string[]): void {
    const stored = this.readStored(uid);
    stored.deleted = stored.deleted.filter((id) => !ids.includes(id));
    this.writeStored(uid, stored);
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

  private readStored(uid: string): StoredList {
    try {
      const raw = localStorage.getItem(this.storageKey(uid));
      if (!raw) {
        return { version: 1, items: [], deleted: [] };
      }
      const parsed = JSON.parse(raw) as Partial<StoredList>;
      if (parsed.version !== 1 || !Array.isArray(parsed.items)) {
        return { version: 1, items: [], deleted: [] };
      }
      return {
        version: 1,
        items: parsed.items,
        deleted: Array.isArray(parsed.deleted) ? parsed.deleted : [],
      };
    } catch {
      return { version: 1, items: [], deleted: [] };
    }
  }

  private writeStored(uid: string, list: StoredList): void {
    localStorage.setItem(this.storageKey(uid), JSON.stringify(list));
  }
}
