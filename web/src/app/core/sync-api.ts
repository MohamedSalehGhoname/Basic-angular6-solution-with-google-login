import { Injectable, inject } from '@angular/core';
import { syncConfig } from '../sync.config';
import { AuthService } from './auth.service';

export interface WrappedKeyRecord {
  salt: string;
  opsLimit: number;
  memLimit: number;
  wrappedKey: string;
}

export interface RemoteVault extends WrappedKeyRecord {
  /** Optional recovery-code-wrapped copy of the vault key. */
  recovery?: WrappedKeyRecord;
}

export interface RemoteItem {
  id: string;
  blob: string;
  createdAt: number;
}

export type Collection = 'clipboard' | 'secrets';

export type SyncEvent =
  | { type: 'vault-updated' }
  | { type: 'item-added'; collection: Collection; item: RemoteItem }
  | { type: 'item-removed'; collection: Collection; id: string }
  | { type: 'items-cleared'; collection: Collection };

/**
 * Identifies this tab to the server so its own writes are not echoed back
 * over the WebSocket.
 */
export const CLIENT_ID = crypto.randomUUID();

/**
 * Thin transport to the sync server. Everything sent through here is
 * ciphertext or key-derivation metadata — plaintext never leaves the app.
 */
@Injectable({ providedIn: 'root' })
export class SyncApi {
  private readonly auth = inject(AuthService);
  private readonly base = syncConfig.apiBaseUrl.replace(/\/+$/, '');

  async getVault(): Promise<RemoteVault | null> {
    const res = await this.request('GET', '/api/vault');
    if (res.status === 404) {
      return null;
    }
    this.assertOk(res);
    return (await res.json()) as RemoteVault;
  }

  async putVault(vault: RemoteVault): Promise<void> {
    this.assertOk(await this.request('PUT', '/api/vault', vault));
  }

  async listItems(collection: Collection): Promise<RemoteItem[]> {
    const res = await this.request('GET', `/api/${collection}/items`);
    this.assertOk(res);
    return ((await res.json()) as { items: RemoteItem[] }).items;
  }

  async putItem(collection: Collection, id: string, blob: string): Promise<void> {
    this.assertOk(
      await this.request('PUT', `/api/${collection}/items/${encodeURIComponent(id)}`, { blob }),
    );
  }

  async deleteItem(collection: Collection, id: string): Promise<void> {
    this.assertOk(
      await this.request('DELETE', `/api/${collection}/items/${encodeURIComponent(id)}`),
    );
  }

  async clearItems(collection: Collection): Promise<void> {
    this.assertOk(await this.request('DELETE', `/api/${collection}/items`));
  }

  /**
   * Opens the event stream, reconnecting with backoff until the returned
   * disconnect function is called. `onStatus` reports live connectivity.
   */
  connect(
    onEvent: (event: SyncEvent) => void,
    onStatus?: (online: boolean) => void,
  ): () => void {
    let closed = false;
    let socket: WebSocket | null = null;
    let attempt = 0;

    const scheduleRetry = () => {
      onStatus?.(false);
      if (closed) {
        return;
      }
      attempt += 1;
      setTimeout(open, Math.min(30_000, 1000 * 2 ** attempt));
    };

    const open = async () => {
      if (closed) {
        return;
      }
      try {
        const token = await this.auth.idToken();
        const url =
          this.base.replace(/^http/, 'ws') +
          `/api/sync?token=${encodeURIComponent(token)}&clientId=${CLIENT_ID}`;
        socket = new WebSocket(url);
        socket.onopen = () => {
          attempt = 0;
          onStatus?.(true);
        };
        socket.onmessage = (message) => {
          try {
            onEvent(JSON.parse(String(message.data)) as SyncEvent);
          } catch {
            // Ignore malformed frames.
          }
        };
        socket.onclose = scheduleRetry;
      } catch {
        scheduleRetry();
      }
    };

    void open();
    return () => {
      closed = true;
      socket?.close();
    };
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.auth.idToken();
    return fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-client-id': CLIENT_ID,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private assertOk(res: Response): void {
    if (!res.ok) {
      throw new Error(`Sync request failed with status ${res.status}`);
    }
  }
}
