import { Injectable, effect, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { ClipboardStore, type ClipboardFile } from './clipboard-store';
import type { FileSendRequest } from './desktop-capture.service';
import { decryptFile, encryptedSize, fromBase64, newFileKey } from './file-crypto';
import { desktopSender, mobileSender } from './file-senders';
import { I18nService } from './i18n/i18n.service';
import { NativeBridge } from './native-bridge.service';
import type { TranslationKey } from './i18n/translations';
import { FileRequestError, SyncApi } from './sync-api';
import { VaultService } from './vault.service';

/** An upload or download in progress, or one that just failed. */
export interface FileTransfer {
  id: string;
  name: string;
  direction: 'up' | 'down';
  done: number;
  total: number;
  /** Held until the vault is unlocked. */
  waiting?: boolean;
  /** Translation key describing the failure. */
  error?: TranslationKey;
}

const ENCRYPT_KEY = 'clipsync.files.encrypt';
// Browsers decrypt in memory; past this, point people at the desktop app.
const BROWSER_DECRYPT_LIMIT = 512 * 1024 * 1024;
// The phone app moves the whole file through the native bridge as base64.
const PHONE_FILE_LIMIT = 150 * 1024 * 1024;
const FAILED_VISIBLE_MS = 8000;

/**
 * Files sent to the clipboard. The desktop app's Explorer menu, or the
 * phone's share sheet, hands us a file (name + size only); we get a storage
 * URL from the sync server, the native shell streams the file there — encrypted with a fresh per-file key
 * unless the user chose to send files as-is — and the file then becomes an
 * ordinary (encrypted, synced) clipboard item that carries the key. Every
 * signed-in device can download it; storage never sees the key.
 */
@Injectable({ providedIn: 'root' })
export class FileShareService {
  private readonly api = inject(SyncApi);
  private readonly clipboard = inject(ClipboardStore);
  private readonly vault = inject(VaultService);
  private readonly auth = inject(AuthService);
  private readonly i18n = inject(I18nService);
  private readonly native = inject(NativeBridge);

  private readonly desktop = window.clipsyncDesktop;
  private readonly sender = desktopSender() ?? mobileSender();
  /** Whether this app can send files (desktop "Send to", or the phone's share sheet). */
  readonly canSend = !!this.sender;

  private readonly _encrypt = signal(this.readEncrypt());
  /** Encrypt files before upload (slower, zero-knowledge) or send as-is (faster). */
  readonly encrypt = this._encrypt.asReadonly();

  private readonly _transfers = signal<FileTransfer[]>([]);
  readonly transfers = this._transfers.asReadonly();

  /** Sends (and shared text) that arrived while the vault was locked. */
  private waiting: FileSendRequest[] = [];
  private waitingTexts: string[] = [];

  constructor() {
    if (!this.sender) {
      return;
    }
    this.sender.start({
      file: (request) => this.receive(request),
      text: (text) => this.receiveText(text),
      progress: (progress) =>
        this.patch(progress.id, { done: progress.done, total: progress.total }),
    });

    effect(() => {
      if (this.vault.status() !== 'unlocked' || !this.auth.user()) {
        return;
      }
      if (this.waiting.length > 0) {
        const pending = this.waiting;
        this.waiting = [];
        pending.forEach((request) => void this.send(request));
      }
      if (this.waitingTexts.length > 0) {
        const texts = this.waitingTexts;
        this.waitingTexts = [];
        texts.forEach((text) => void this.addText(text));
      }
    });
  }

  setEncrypt(encrypt: boolean): void {
    this._encrypt.set(encrypt);
    try {
      localStorage.setItem(ENCRYPT_KEY, JSON.stringify(encrypt));
    } catch {
      // Preference only.
    }
  }

  private receive(request: FileSendRequest): void {
    if (this.vault.status() === 'unlocked' && this.auth.user()) {
      void this.send(request);
      return;
    }
    // The key has to go into the encrypted clipboard, so ask for an unlock.
    this.waiting.push(request);
    this.track({
      id: request.requestId,
      name: request.name,
      direction: 'up',
      done: 0,
      total: request.sizeBytes,
      waiting: true,
    });
    this.sender?.reveal?.();
  }

  /** Text shared from another app (phone) becomes an ordinary clipboard item. */
  private receiveText(text: string): void {
    if (this.vault.status() === 'unlocked' && this.auth.user()) {
      void this.addText(text);
    } else {
      this.waitingTexts.push(text);
    }
  }

  private async addText(text: string): Promise<void> {
    try {
      await this.clipboard.add(text, { device: this.sender?.device ?? 'Web' });
    } catch {
      // Stays shareable again from the source app.
    }
  }

  private async send(request: FileSendRequest): Promise<void> {
    const sender = this.sender;
    if (!sender) {
      return;
    }
    const encrypt = this._encrypt();
    const key = encrypt ? newFileKey() : null;
    const sizeBytes = encrypt ? encryptedSize(request.sizeBytes) : request.sizeBytes;
    this.track({ id: request.requestId, name: request.name, direction: 'up', done: 0, total: sizeBytes });

    try {
      if (request.sizeBytes === 0) {
        throw new Error('empty');
      }
      const created = await this.api.createFile({
        sizeBytes,
        encrypted: encrypt,
        name: encrypt ? undefined : request.name,
      });
      await sender.upload(request.requestId, created.uploadUrl, key);
      await this.api.confirmFile(created.fileId);
      const file: ClipboardFile = { id: created.fileId, name: request.name, size: request.sizeBytes };
      if (key) {
        file.key = key;
      }
      await this.clipboard.addFile(file, { device: sender.device });
      this.untrack(request.requestId);
      notify(this.i18n.t('files.sent', { name: request.name }));
    } catch (err) {
      sender.forget(request.requestId);
      this.fail(request.requestId, describe(err));
    }
  }

  /**
   * Saves a file item. The desktop app streams it into Downloads (and shows
   * it in the folder); a browser downloads a plain file directly, or fetches
   * and decrypts an encrypted one in memory.
   */
  async download(file: ClipboardFile): Promise<void> {
    const id = `down-${file.id}`;
    if (this._transfers().some((t) => t.id === id && !t.error)) {
      return;
    }
    this.track({ id, name: file.name, direction: 'down', done: 0, total: file.size });
    try {
      if (this.desktop?.downloadFile) {
        await this.desktop.downloadFile({
          id,
          downloadUrl: await this.api.fileDownloadUrl(file.id),
          name: file.name,
          key: file.key ?? null,
        });
      } else if (this.native.canSaveFile) {
        // Phone: fetch through the server (the WebView cannot fetch storage
        // cross-origin), decrypt if needed, then hand it to the share sheet.
        if (file.size > PHONE_FILE_LIMIT) {
          throw new Error('too-large-phone');
        }
        const stored = await this.api.fileContent(file.id);
        const bytes = file.key ? await decryptFile(stored, fromBase64(file.key)) : stored;
        await this.native.saveFile(file.name, bytes);
      } else if (!file.key) {
        // Opened, not fetched: storage URLs are cross-origin.
        const link = document.createElement('a');
        link.href = await this.api.fileDownloadUrl(file.id);
        link.rel = 'noopener';
        link.click();
      } else {
        if (file.size > BROWSER_DECRYPT_LIMIT) {
          throw new Error('too-large');
        }
        const plain = await decryptFile(await this.api.fileContent(file.id), fromBase64(file.key));
        saveBlob(new Blob([plain as BlobPart]), file.name);
      }
      this.untrack(id);
    } catch (err) {
      this.fail(id, describe(err));
    }
  }

  dismiss(id: string): void {
    this.untrack(id);
  }

  private track(transfer: FileTransfer): void {
    this._transfers.update((list) => [...list.filter((t) => t.id !== transfer.id), transfer]);
  }

  private patch(id: string, changes: Partial<FileTransfer>): void {
    this._transfers.update((list) => list.map((t) => (t.id === id ? { ...t, ...changes } : t)));
  }

  private untrack(id: string): void {
    this._transfers.update((list) => list.filter((t) => t.id !== id));
  }

  private fail(id: string, error: TranslationKey): void {
    this.patch(id, { error });
    setTimeout(() => {
      if (this._transfers().find((t) => t.id === id)?.error) {
        this.untrack(id);
      }
    }, FAILED_VISIBLE_MS);
  }

  private readEncrypt(): boolean {
    try {
      return localStorage.getItem(ENCRYPT_KEY) !== 'false';
    } catch {
      return true;
    }
  }
}

/** A translation key for what went wrong. */
function describe(err: unknown): TranslationKey {
  if (err instanceof FileRequestError) {
    return err.status === 503 ? 'files.error.notConfigured' : 'files.error.server';
  }
  if (err instanceof Error && err.message === 'empty') {
    return 'files.error.empty';
  }
  if (err instanceof Error && err.message === 'too-large') {
    return 'files.error.tooLarge';
  }
  if (err instanceof Error && err.message === 'too-large-phone') {
    return 'files.error.tooLargePhone';
  }
  if (err instanceof Error && /decrypt/i.test(err.message)) {
    return 'files.error.decrypt';
  }
  return 'files.error.transfer';
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** A system notification, since the window is usually hidden while sending. */
function notify(body: string): void {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission !== 'denied') {
      new Notification('Clipboard Sync', { body, silent: true });
    }
  } catch {
    // Notifications are a nicety.
  }
}
