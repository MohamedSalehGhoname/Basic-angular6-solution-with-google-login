import { Injectable, inject } from '@angular/core';
import { syncConfig } from '../sync.config';
import { getAccessKey, rejectAccessKey } from './access-key';
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
  /** Ciphertext only the current vault key opens; see VaultService. */
  keyCheck?: string;
}

export interface RemoteItem {
  id: string;
  blob: string;
  createdAt: number;
}

export type Collection = 'clipboard' | 'secrets' | 'groups';

export interface CreatedFile {
  fileId: string;
  uploadUrl: string;
  uploadExpiresAt: string;
}

/** A file-route call failed; `status` lets callers tell "not set up" (503) apart. */
export class FileRequestError extends Error {
  constructor(readonly status: number) {
    super(`File request failed with status ${status}`);
  }
}

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
   * Registers a file sent to the clipboard and returns where to upload it.
   * `sizeBytes` is what will be uploaded (the encrypted size when encrypting);
   * `name` is only sent for files shared as-is.
   */
  async createFile(input: { sizeBytes: number; encrypted: boolean; name?: string }): Promise<CreatedFile> {
    return this.fileJson<CreatedFile>(await this.request('POST', '/api/files', input));
  }

  async confirmFile(fileId: string): Promise<void> {
    await this.fileJson(
      await this.request('POST', `/api/files/${encodeURIComponent(fileId)}/uploaded`, {}),
    );
  }

  /** A short-lived (15 min) direct link to the stored bytes. */
  async fileDownloadUrl(fileId: string): Promise<string> {
    const res = await this.request('GET', `/api/files/${encodeURIComponent(fileId)}/download`);
    return (await this.fileJson<{ downloadUrl: string }>(res)).downloadUrl;
  }

  /**
   * The stored bytes relayed by the sync server. The response is returned
   * unread so callers can stream it: a file is decrypted and written away
   * piece by piece instead of being held in memory.
   */
  async fileContent(fileId: string): Promise<Response> {
    const res = await this.request('GET', `/api/files/${encodeURIComponent(fileId)}/content`);
    if (!res.ok) {
      throw new FileRequestError(res.status);
    }
    return res;
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
          `/api/sync?token=${encodeURIComponent(token)}&clientId=${CLIENT_ID}` +
          (getAccessKey() ? `&accessKey=${encodeURIComponent(getAccessKey()!)}` : '');
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
        socket.onclose = (event) => {
          if (event.code === 4403) {
            // Wrong access key: retrying cannot help until it is re-entered.
            closed = true;
            onStatus?.(false);
            this.accessKeyFailed();
            return;
          }
          scheduleRetry();
        };
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
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-client-id': CLIENT_ID,
    };
    const accessKey = getAccessKey();
    if (accessKey) {
      headers['x-access-key'] = accessKey;
    }
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 403 && (await res.clone().json().catch(() => null))?.code === 'access_key') {
      this.accessKeyFailed();
    }
    return res;
  }

  /** The server refused our access key: forget it and go back to sign-in. */
  private accessKeyFailed(): void {
    rejectAccessKey();
    void this.auth.logout();
  }

  private async fileJson<T>(res: Response): Promise<T> {
    if (!res.ok) {
      throw new FileRequestError(res.status);
    }
    return (await res.json()) as T;
  }

  private assertOk(res: Response): void {
    if (!res.ok) {
      throw new Error(`Sync request failed with status ${res.status}`);
    }
  }
}
