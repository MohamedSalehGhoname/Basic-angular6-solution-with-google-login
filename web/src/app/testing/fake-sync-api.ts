import type { RemoteItem, RemoteVault, SyncEvent } from '../core/sync-api';

/**
 * In-memory stand-in for SyncApi in specs: mimics the server's behavior,
 * can be flipped offline, and lets tests emit WebSocket events.
 */
export class FakeSyncApi {
  vault: RemoteVault | null = null;
  readonly items = new Map<string, { blob: string; createdAt: number }>();
  offline = false;

  private clock = 0;
  private onEvent: ((event: SyncEvent) => void) | null = null;
  private onStatus: ((online: boolean) => void) | null = null;

  private fail(): void {
    if (this.offline) {
      throw new Error('offline');
    }
  }

  async getVault(): Promise<RemoteVault | null> {
    this.fail();
    return this.vault;
  }

  async putVault(vault: RemoteVault): Promise<void> {
    this.fail();
    this.vault = vault;
  }

  async listItems(): Promise<RemoteItem[]> {
    this.fail();
    return [...this.items.entries()]
      .map(([id, item]) => ({ id, ...item }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async putItem(id: string, blob: string): Promise<void> {
    this.fail();
    this.items.set(id, { blob, createdAt: ++this.clock });
  }

  async deleteItem(id: string): Promise<void> {
    this.fail();
    this.items.delete(id);
  }

  async clearItems(): Promise<void> {
    this.fail();
    this.items.clear();
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
