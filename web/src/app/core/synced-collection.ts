import { type Signal, effect, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { type Collection, SyncApi, type SyncEvent } from './sync-api';
import { VaultService } from './vault.service';

export type Entry<T> = T & { id: string };

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

/**
 * Shared engine for an end-to-end-encrypted, server-synced collection of
 * items. Each item's payload is encrypted into an `xcv1:` blob, so neither
 * localStorage nor the server sees plaintext. The server is the source of
 * truth; localStorage is an encrypted offline mirror; changes stream in over
 * the WebSocket. Locking the vault drops all plaintext and the connection.
 *
 * Subclasses fix the collection name and payload shape and may override
 * ordering and expiry; the clipboard and secrets vaults are both built on
 * this.
 */
export abstract class SyncedCollection<T extends object> {
  protected readonly auth = inject(AuthService);
  protected readonly vault = inject(VaultService);
  protected readonly syncApi = inject(SyncApi);

  private readonly _items = signal<Entry<T>[]>([]);
  readonly items: Signal<Entry<T>[]> = this._items.asReadonly();

  private readonly _skipped = signal(0);
  /** Items that failed to decrypt on the last load (corrupt or foreign blobs). */
  readonly skipped = this._skipped.asReadonly();
  /** Their ids, so the user can clear them out (see removeSkipped). */
  private skippedIds: string[] = [];

  private readonly _online = signal(false);
  /** Live connectivity to the sync server. */
  readonly online = this._online.asReadonly();

  private loadedUid: string | null = null;
  private disconnect: (() => void) | null = null;

  protected constructor(
    private readonly collection: Collection,
    private readonly maxItems: number,
  ) {
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
  }

  /** Order items for display. Default: most recently created first. */
  protected compare(a: Entry<T>, b: Entry<T>): number {
    return (this.createdAt(b) ?? 0) - (this.createdAt(a) ?? 0);
  }

  /** Sort key for the default ordering; overridden implicitly via compare(). */
  protected createdAt(_entry: Entry<T>): number | null {
    return null;
  }

  /** Whether an entry has expired and should be purged. Default: never. */
  protected isExpired(_entry: Entry<T>): boolean {
    return false;
  }

  async load(): Promise<void> {
    const uid = this.requireUid();
    if (this.loadedUid === uid) {
      return;
    }
    await this.onBeforeLoad(uid);

    const stored = this.readStored(uid);
    let storedItems = stored.items;
    let tombstones = [...stored.deleted];
    try {
      const replayed = new Set<string>();
      for (const id of tombstones) {
        try {
          await this.syncApi.deleteItem(this.collection, id);
          replayed.add(id);
        } catch {
          // Replayed again on a later load.
        }
      }
      tombstones = tombstones.filter((id) => !replayed.has(id));

      const remote = (await this.syncApi.listItems(this.collection)).filter(
        (item) => !tombstones.includes(item.id),
      );
      const remoteIds = new Set(remote.map((item) => item.id));
      const localOnly = storedItems.filter((item) => !remoteIds.has(item.id));
      for (const item of localOnly) {
        // Only what this vault can read goes up: a mirror left by a different
        // vault (another account, or one that was replaced) would otherwise
        // be uploaded as items nobody can ever decrypt. Unreadable blobs are
        // still counted below, so the user hears about them once.
        if (!(await this.canDecrypt(item.blob))) {
          continue;
        }
        try {
          await this.syncApi.putItem(this.collection, item.id, item.blob);
        } catch {
          // Pushed again on a later load.
        }
      }
      storedItems = [...localOnly, ...remote.map(({ id, blob }) => ({ id, blob }))];
      this._online.set(true);
    } catch {
      this._online.set(false);
    }

    const entries: Entry<T>[] = [];
    const blobsById = new Map<string, string>();
    const skippedIds: string[] = [];
    let skipped = 0;
    for (const item of storedItems) {
      try {
        const payload = JSON.parse(await this.vault.decryptItem(item.blob)) as T;
        entries.push({ ...payload, id: item.id });
        blobsById.set(item.id, item.blob);
      } catch {
        skipped += 1;
        skippedIds.push(item.id);
      }
    }
    entries.sort((a, b) => this.compare(a, b));
    const capped = entries.slice(0, this.maxItems);

    // Expired items are dropped and deleted server-side (tombstoned until the
    // delete lands).
    const live = capped.filter((entry) => !this.isExpired(entry));
    const expired = capped.filter((entry) => this.isExpired(entry));
    tombstones = [...new Set([...tombstones, ...expired.map((entry) => entry.id)])];

    this.writeStored(uid, {
      version: 1,
      items: live.map((entry) => ({ id: entry.id, blob: blobsById.get(entry.id)! })),
      deleted: tombstones,
    });
    this._items.set(live);
    this._skipped.set(skipped);
    this.skippedIds = skippedIds;
    this.loadedUid = uid;
    for (const entry of expired) {
      this.syncApi.deleteItem(this.collection, entry.id).then(
        () => this.dropTombstones(uid, [entry.id]),
        () => {},
      );
    }
    this.connectSocket();
  }

  /**
   * Deletes the items that could not be decrypted — left behind when a vault
   * is replaced while another device is still writing with the old key. They
   * are unreadable to every device, so nothing is lost.
   */
  removeSkipped(): void {
    const ids = this.skippedIds;
    this.skippedIds = [];
    this._skipped.set(0);
    for (const id of ids) {
      this.remove(id);
    }
  }

  /** Whether this collection has been loaded for the current user. */
  get isLoaded(): boolean {
    return this.loadedUid !== null;
  }

  /**
   * Re-reads everything from the server and reconnects live updates, for a
   * manual refresh or when the app comes back to the foreground. Collections
   * that were never loaded are left alone.
   */
  async refresh(): Promise<void> {
    if (this.loadedUid === null) {
      return;
    }
    this.disconnect?.();
    this.disconnect = null;
    this.loadedUid = null;
    await this.load();
  }

  /** Whether the unlocked vault can read this blob. */
  private async canDecrypt(blob: string): Promise<boolean> {
    try {
      await this.vault.decryptItem(blob);
      return true;
    } catch {
      return false;
    }
  }

  /** Hook for per-collection preferences to load before items. */
  protected async onBeforeLoad(_uid: string): Promise<void> {}

  /** Creates a new item from a fully-formed payload. */
  protected async create(payload: T): Promise<Entry<T>> {
    const uid = this.requireUid();
    const id = crypto.randomUUID();
    const entry: Entry<T> = { ...payload, id };
    const blob = await this.vault.encryptItem(JSON.stringify(payload));

    const stored = this.readStored(uid);
    stored.items = [{ id, blob }, ...stored.items].slice(0, this.maxItems);
    this.writeStored(uid, stored);
    this._items.update((items) => this.sorted([entry, ...items]).slice(0, this.maxItems));

    await this.push(id, blob);
    return entry;
  }

  /** Replaces an existing item's payload in place (keeps its position). */
  protected async update(id: string, payload: T): Promise<void> {
    const uid = this.requireUid();
    const blob = await this.vault.encryptItem(JSON.stringify(payload));
    const stored = this.readStored(uid);
    stored.items = stored.items.map((item) => (item.id === id ? { id, blob } : item));
    this.writeStored(uid, stored);
    this._items.update((items) =>
      this.sorted(items.map((item) => (item.id === id ? { ...payload, id } : item))),
    );
    await this.push(id, blob);
  }

  remove(id: string): void {
    const uid = this.requireUid();
    this.removeLocally(uid, id, true);
    this.syncApi.deleteItem(this.collection, id).then(
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
    this.syncApi.clearItems(this.collection).then(
      () => {
        this.dropTombstones(uid, ids);
        this._online.set(true);
      },
      () => this._online.set(false),
    );
  }

  /** Deletes every currently-expired item locally and on the server. */
  sweepExpired(): void {
    for (const entry of this._items()) {
      if (this.isExpired(entry)) {
        this.remove(entry.id);
      }
    }
  }

  private async push(id: string, blob: string): Promise<void> {
    try {
      await this.syncApi.putItem(this.collection, id, blob);
      this._online.set(true);
    } catch {
      this._online.set(false);
    }
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
    // Ignore events for other collections; one socket carries all of them.
    if (event.type !== 'vault-updated' && event.collection !== this.collection) {
      return;
    }
    switch (event.type) {
      case 'item-added': {
        if (
          this._items().some((item) => item.id === event.item.id) ||
          this.readStored(uid).deleted.includes(event.item.id)
        ) {
          // Update in place if the payload changed (an edit on another device).
          await this.applyPossibleUpdate(uid, event.item.id, event.item.blob);
          return;
        }
        try {
          const payload = JSON.parse(await this.vault.decryptItem(event.item.blob)) as T;
          const entry: Entry<T> = { ...payload, id: event.item.id };
          if (this.isExpired(entry)) {
            return;
          }
          const stored = this.readStored(uid);
          stored.items = [
            { id: entry.id, blob: event.item.blob },
            ...stored.items.filter((item) => item.id !== entry.id),
          ].slice(0, this.maxItems);
          this.writeStored(uid, stored);
          this._items.update((items) =>
            this.sorted([entry, ...items]).slice(0, this.maxItems),
          );
        } catch {
          this._skipped.update((count) => count + 1);
        }
        break;
      }
      case 'item-removed':
        this.removeLocally(uid, event.id, false);
        break;
      case 'items-cleared':
        this.clearLocally(uid);
        break;
      case 'vault-updated':
        // A passphrase change is harmless, but a replaced vault leaves this
        // session holding a key nobody else can read; the vault locks itself
        // in that case.
        await this.vault.onRemoteVaultChanged();
        break;
    }
  }

  private async applyPossibleUpdate(uid: string, id: string, blob: string): Promise<void> {
    const current = this.readStored(uid).items.find((item) => item.id === id);
    if (!current || current.blob === blob) {
      return;
    }
    try {
      const payload = JSON.parse(await this.vault.decryptItem(blob)) as T;
      const stored = this.readStored(uid);
      stored.items = stored.items.map((item) => (item.id === id ? { id, blob } : item));
      this.writeStored(uid, stored);
      this._items.update((items) =>
        this.sorted(
          items.map((item) => (item.id === id ? { ...payload, id } : item)),
        ),
      );
    } catch {
      // Leave the existing entry in place if the update cannot be decrypted.
    }
  }

  private sorted(entries: Entry<T>[]): Entry<T>[] {
    return [...entries].sort((a, b) => this.compare(a, b));
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

  protected requireUid(): string {
    const uid = this.auth.user()?.uid;
    if (!uid) {
      throw new Error('Not signed in.');
    }
    return uid;
  }

  private storageKey(uid: string): string {
    return `clipsync.${this.collection}.${uid}`;
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
