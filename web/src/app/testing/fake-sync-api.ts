import type { Collection, RemoteItem, RemoteVault, SyncEvent } from '../core/sync-api';

/**
 * In-memory stand-in for SyncApi in specs: mimics the server's per-collection
 * behavior, can be flipped offline, and lets tests emit WebSocket events.
 */
export class FakeSyncApi {
  vault: RemoteVault | null = null;
  readonly collections = new Map<Collection, Map<string, { blob: string; createdAt: number }>>();
  offline = false;

  private clock = 0;
  private onEvent: ((event: SyncEvent) => void) | null = null;
  private onStatus: ((online: boolean) => void) | null = null;

  private fail(): void {
    if (this.offline) {
      throw new Error('offline');
    }
  }

  private store(collection: Collection): Map<string, { blob: string; createdAt: number }> {
    let map = this.collections.get(collection);
    if (!map) {
      map = new Map();
      this.collections.set(collection, map);
    }
    return map;
  }

  /** Convenience accessor for the clipboard collection used by older specs. */
  get items(): Map<string, { blob: string; createdAt: number }> {
    return this.store('clipboard');
  }

  async getVault(): Promise<RemoteVault | null> {
    this.fail();
    return this.vault;
  }

  async putVault(vault: RemoteVault): Promise<void> {
    this.fail();
    this.vault = vault;
  }

  async listItems(collection: Collection): Promise<RemoteItem[]> {
    this.fail();
    return [...this.store(collection).entries()]
      .map(([id, item]) => ({ id, ...item }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async putItem(collection: Collection, id: string, blob: string): Promise<void> {
    this.fail();
    const map = this.store(collection);
    const existing = map.get(id);
    map.set(id, { blob, createdAt: existing?.createdAt ?? ++this.clock });
  }

  async deleteItem(collection: Collection, id: string): Promise<void> {
    this.fail();
    this.store(collection).delete(id);
  }

  async clearItems(collection: Collection): Promise<void> {
    this.fail();
    this.store(collection).clear();
  }

  connect(
    onEvent: (event: SyncEvent) => void,
    onStatus?: (online: boolean) => void,
  ): () => void {
    this.onEvent = onEvent;
    this.onStatus = onStatus ?? null;
    onStatus?.(!this.offline);
    return () => {
      this.onEvent = null;
      this.onStatus = null;
    };
  }

  get connected(): boolean {
    return this.onEvent !== null;
  }

  emit(event: SyncEvent): void {
    this.onEvent?.(event);
  }

  setOnline(online: boolean): void {
    this.offline = !online;
    this.onStatus?.(online);
  }
}
