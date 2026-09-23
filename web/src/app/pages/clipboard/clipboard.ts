import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClipboardStore, TTL_OPTIONS, type ClipboardEntry } from '../../core/clipboard-store';
import { DesktopCaptureService } from '../../core/desktop-capture.service';
import { FileShareService } from '../../core/file-share.service';
import { I18nService } from '../../core/i18n/i18n.service';
import type { TranslationKey } from '../../core/i18n/translations';
import { NativeBridge } from '../../core/native-bridge.service';

@Component({
  selector: 'app-clipboard',
  imports: [DatePipe, FormsModule],
  templateUrl: './clipboard.html',
  styleUrl: './clipboard.css',
})
export class Clipboard {
  protected readonly store = inject(ClipboardStore);
  protected readonly desktop = inject(DesktopCaptureService);
  protected readonly i18n = inject(I18nService);
  protected readonly native = inject(NativeBridge);
  protected readonly files = inject(FileShareService);

  protected formatSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toFixed(unit === 0 || value >= 10 ? 0 : 1)} ${units[unit]}`;
  }

  protected percent(done: number, total: number): number {
    return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  }

  protected readonly ttlOptions = TTL_OPTIONS;

  protected ttlLabel(ms: number | null): string {
    const key: TranslationKey =
      ms === null
        ? 'ttl.forever'
        : ms <= 3_600_000
          ? 'ttl.1h'
          : ms <= 86_400_000
            ? 'ttl.1d'
            : 'ttl.1w';
    return this.i18n.t(key);
  }
  protected draft = '';
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly copiedId = signal<string | null>(null);
  protected readonly search = signal('');

  protected readonly filtered = computed(() => {
    const query = this.search().trim().toLowerCase();
    const items = this.store.items();
    if (!query) {
      return items;
    }
    return items.filter((item) => item.text.toLowerCase().includes(query));
  });

  constructor() {
    void this.init();
  }

  private async init(): Promise<void> {
    try {
      await this.store.load();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not load your clipboard.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async add(): Promise<void> {
    if (!this.draft.trim()) {
      return;
    }
    this.error.set(null);
    try {
      await this.store.add(this.draft);
      this.draft = '';
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not save the item.');
    }
  }

  protected async pasteFromClipboard(): Promise<void> {
    this.error.set(null);
    try {
      const text = await this.native.readText();
      if (text.trim()) {
        await this.store.add(text);
      }
    } catch {
      this.error.set('Could not read your clipboard — paste into the box instead.');
    }
  }

  protected async copy(entry: ClipboardEntry): Promise<void> {
    this.error.set(null);
    if (entry.file) {
      await this.files.download(entry.file);
      return;
    }
    try {
      if (entry.image) {
        await this.native.copyImage(entry.image);
      } else {
        await this.native.copy(entry.text);
      }
      this.copiedId.set(entry.id);
      setTimeout(() => {
        if (this.copiedId() === entry.id) {
          this.copiedId.set(null);
        }
      }, 1500);
    } catch {
      this.error.set('Could not write to your clipboard.');
    }
  }

  protected async share(entry: ClipboardEntry): Promise<void> {
    this.error.set(null);
    try {
      await this.native.share(entry.text);
    } catch {
      // User dismissed the share sheet, or sharing is unavailable.
    }
  }

  protected onTtlChange(value: string): void {
    this.store.setTtl(value === 'null' ? null : Number(value));
  }

  protected remove(id: string): void {
    this.error.set(null);
    try {
      this.store.remove(id);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not delete the item.');
    }
  }

  protected clear(): void {
    if (!confirm(this.i18n.t('clipboard.confirmClear'))) {
      return;
    }
    this.error.set(null);
    try {
      this.store.clear();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not clear the clipboard.');
    }
  }
}
