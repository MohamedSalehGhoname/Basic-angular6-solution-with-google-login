import { Injectable, inject, signal } from '@angular/core';
import type { ClipboardFile } from './clipboard-store';
import { NativeBridge } from './native-bridge.service';
import { syncConfig } from '../sync.config';
import { type ShareLink, SyncApi } from './sync-api';

/** A day, which is what a link lasts unless the caller says otherwise. */
export const SHARE_DEFAULT_MS = 24 * 60 * 60 * 1000;
export const SHARE_DEFAULT_DOWNLOADS = 50;

/**
 * Public links to a file in the clipboard.
 *
 * A file in the clipboard is encrypted with a key of its own, and that key
 * lives inside the (encrypted) clipboard item — which is why only the user's
 * own devices can open it. To let somebody else open one, the link carries
 * the key itself, after the `#`:
 *
 *   https://host/s/<token>#k=<key>&n=<name>
 *
 * Browsers never send the part after `#` to a server, so the sync server and
 * the storage behind it still cannot read the file, and never learn its name:
 * they serve ciphertext to whoever has a live token. Anyone holding the whole
 * link can read the file — that is what an open link means — so links expire,
 * stop after a number of downloads, and can be pulled back at any time.
 */
@Injectable({ providedIn: 'root' })
export class FileLinkService {
  private readonly api = inject(SyncApi);
  private readonly native = inject(NativeBridge);

  /** Live links, newest first; loaded on demand. */
  private readonly _links = signal<ShareLink[]>([]);
  readonly links = this._links.asReadonly();

  /** File ids that have at least one live link, for the badge on a row. */
  readonly sharedFileIds = signal<Set<string>>(new Set());

  async refresh(): Promise<void> {
    const links = await this.api.listShares();
    this._links.set(links);
    this.sharedFileIds.set(new Set(links.map((link) => link.fileId)));
  }

  /**
   * Creates a link for a file and returns the whole thing, key included.
   * A file sent as-is has no key, and the link simply has none either.
   */
  async create(
    file: ClipboardFile,
    options: { expiresInMs?: number; maxDownloads?: number } = {},
  ): Promise<string> {
    const link = await this.api.createShare(file.id, {
      expiresInMs: options.expiresInMs ?? SHARE_DEFAULT_MS,
      maxDownloads: options.maxDownloads ?? SHARE_DEFAULT_DOWNLOADS,
    });
    this._links.update((links) => [link, ...links]);
    this.sharedFileIds.update((ids) => new Set(ids).add(file.id));
    return this.url(link.token, file);
  }

  async revoke(token: string): Promise<void> {
    await this.api.revokeShare(token);
    const left = this._links().filter((link) => link.token !== token);
    this._links.set(left);
    this.sharedFileIds.set(new Set(left.map((link) => link.fileId)));
  }

  /** Hands the link to the phone's share sheet, or copies it. */
  async send(url: string): Promise<'shared' | 'copied'> {
    if (this.native.canShare) {
      await this.native.share(url);
      return 'shared';
    }
    await this.native.copy(url);
    return 'copied';
  }

  /** Builds the link; the key and the name go after the `#`. */
  url(token: string, file: ClipboardFile): string {
    const base = syncConfig.shareBaseUrl.replace(/\/+$/, '');
    const fragment = new URLSearchParams();
    if (file.key) {
      fragment.set('k', file.key);
    }
    fragment.set('n', file.name);
    return `${base}/s/${token}#${fragment.toString()}`;
  }
}
