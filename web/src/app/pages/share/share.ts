import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Csf1Decryptor, fromBase64 } from '../../core/file-crypto';
import { I18nService } from '../../core/i18n/i18n.service';
import { SyncApi, type SharedFileInfo } from '../../core/sync-api';

/** Shown inline rather than only offered for download. */
const PREVIEWABLE = /^(image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)|application\/pdf)$/;

/** Past this, the browser would be holding too much at once. */
const BROWSER_LIMIT = 512 * 1024 * 1024;

/** Guessed from the name, since the type is not stored anywhere. */
function mimeOf(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const types: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
  };
  return types[ext] ?? 'application/octet-stream';
}

/**
 * What a shared link opens, for somebody who has no account here.
 *
 * The page is given a token in its path and, after the `#`, the file's name
 * and the key to open it. The part after the `#` never leaves the browser, so
 * the server hands over ciphertext and this page is where it becomes a file
 * again. Nothing here touches the vault, and nothing is kept afterwards.
 */
@Component({
  selector: 'app-share',
  imports: [],
  templateUrl: './share.html',
  styleUrl: './share.css',
})
export class Share {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(SyncApi);
  protected readonly i18n = inject(I18nService);

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly info = signal<SharedFileInfo | null>(null);
  protected readonly name = signal('');
  protected readonly fetching = signal(false);
  protected readonly progress = signal(0);
  /** The decrypted file, once it has been fetched. */
  protected readonly blobUrl = signal<string | null>(null);

  private key: string | null = null;

  protected readonly previewable = computed(() => PREVIEWABLE.test(mimeOf(this.name())));
  protected readonly isPdf = computed(() => mimeOf(this.name()) === 'application/pdf');

  constructor() {
    void this.start();
  }

  private get token(): string {
    return this.route.snapshot.paramMap.get('token') ?? '';
  }

  private async start(): Promise<void> {
    // The fragment is the part the server never sees: the key and the name.
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
    this.key = fragment.get('k');
    this.name.set(fragment.get('n') ?? '');
    try {
      const info = await this.api.sharedFileInfo(this.token);
      this.info.set(info);
      if (info.sizeBytes > BROWSER_LIMIT) {
        this.error.set(this.i18n.t('share.tooBig'));
      }
    } catch {
      this.error.set(this.i18n.t('share.gone'));
    } finally {
      this.loading.set(false);
    }
  }

  /** Fetches the ciphertext and turns it back into the file, in memory. */
  protected async fetchFile(): Promise<void> {
    if (this.fetching() || this.blobUrl()) {
      return;
    }
    this.fetching.set(true);
    this.error.set(null);
    try {
      const res = await this.api.sharedFileContent(this.token);
      const total = Number(res.headers.get('content-length') ?? 0);
      const parts: Uint8Array[] = [];
      let read = 0;

      if (this.key) {
        const decryptor = new Csf1Decryptor(fromBase64(this.key));
        const reader = res.body!.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          read += value.length;
          this.progress.set(total ? Math.round((read / total) * 100) : 0);
          parts.push(...(await decryptor.push(value)));
        }
        parts.push(await decryptor.finish());
      } else {
        // Sent as-is: there is nothing to open, only to hand over.
        parts.push(new Uint8Array(await res.arrayBuffer()));
      }

      const blob = new Blob(parts as BlobPart[], { type: mimeOf(this.name()) });
      this.blobUrl.set(URL.createObjectURL(blob));
    } catch {
      this.error.set(this.i18n.t('share.failed'));
    } finally {
      this.fetching.set(false);
    }
  }

  protected formatSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
  }

  protected expiryText(at: number): string {
    const hours = Math.max(0, Math.round((at - Date.now()) / (60 * 60 * 1000)));
    return hours >= 1
      ? this.i18n.t('share.expiresHours', { n: hours })
      : this.i18n.t('share.expiresSoon');
  }
}
