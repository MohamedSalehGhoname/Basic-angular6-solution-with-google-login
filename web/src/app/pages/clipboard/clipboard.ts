import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClipboardStore, TTL_OPTIONS, type ClipboardEntry } from '../../core/clipboard-store';
import { DesktopCaptureService } from '../../core/desktop-capture.service';

@Component({
  selector: 'app-clipboard',
  imports: [DatePipe, FormsModule],
  templateUrl: './clipboard.html',
  styleUrl: './clipboard.css',
})
export class Clipboard {
  protected readonly store = inject(ClipboardStore);
  protected readonly desktop = inject(DesktopCaptureService);

  protected readonly ttlOptions = TTL_OPTIONS;
  protected draft = '';
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly copiedId = signal<string | null>(null);

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
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        await this.store.add(text);
      }
    } catch {
      this.error.set('Could not read your clipboard — paste into the box instead.');
    }
  }

  protected async copy(entry: ClipboardEntry): Promise<void> {
    this.error.set(null);
    try {
      await navigator.clipboard.writeText(entry.text);
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
    if (!confirm('Delete all clipboard items? This cannot be undone.')) {
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
