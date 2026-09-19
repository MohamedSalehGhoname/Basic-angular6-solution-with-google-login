import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClipboardCopyService } from '../../core/clipboard-copy.service';
import { SecretsStore, type SecretEntry, type SecretFields } from '../../core/secrets-store';

const EMPTY_FORM: SecretFields = { title: '', username: '', password: '', url: '', notes: '' };

@Component({
  selector: 'app-secrets',
  imports: [FormsModule],
  templateUrl: './secrets.html',
  styleUrl: './secrets.css',
})
export class Secrets {
  protected readonly store = inject(SecretsStore);
  protected readonly clipboard = inject(ClipboardCopyService);

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  /** null = closed, '' = adding, id = editing that entry. */
  protected readonly editingId = signal<string | null>(null);
  protected readonly formOpen = signal(false);
  protected readonly revealed = signal<Set<string>>(new Set());
  protected readonly search = signal('');
  protected form: SecretFields = { ...EMPTY_FORM };

  protected readonly editingTitle = computed(() => {
    const id = this.editingId();
    return id ? (this.store.items().find((entry) => entry.id === id)?.title ?? '') : '';
  });

  protected readonly filtered = computed(() => {
    const query = this.search().trim().toLowerCase();
    const items = this.store.items();
    if (!query) {
      return items;
    }
    return items.filter((entry) =>
      [entry.title, entry.username, entry.url, entry.notes]
        .join('\n')
        .toLowerCase()
        .includes(query),
    );
  });

  constructor() {
    void this.init();
  }

  private async init(): Promise<void> {
    try {
      await this.store.load();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not load your secrets.');
    } finally {
      this.loading.set(false);
    }
  }

  protected startAdd(): void {
    this.form = { ...EMPTY_FORM };
    this.editingId.set('');
    this.formOpen.set(true);
  }

  protected startEdit(entry: SecretEntry): void {
    this.form = {
      title: entry.title,
      username: entry.username,
      password: entry.password,
      url: entry.url,
      notes: entry.notes,
    };
    this.editingId.set(entry.id);
    this.formOpen.set(true);
  }

  protected cancel(): void {
    this.formOpen.set(false);
    this.editingId.set(null);
    this.form = { ...EMPTY_FORM };
  }

  protected async submit(): Promise<void> {
    if (!this.form.title.trim()) {
      this.error.set('A title is required.');
      return;
    }
    this.error.set(null);
    try {
      const id = this.editingId();
      if (id) {
        await this.store.save(id, this.form);
      } else {
        await this.store.add(this.form);
      }
      this.cancel();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not save the secret.');
    }
  }

  protected async remove(entry: SecretEntry): Promise<void> {
    if (!confirm(`Delete "${entry.title}"? This cannot be undone.`)) {
      return;
    }
    this.error.set(null);
    try {
      this.store.remove(entry.id);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not delete the secret.');
    }
  }

  protected toggleReveal(id: string): void {
    this.revealed.update((set) => {
      const next = new Set(set);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  protected isRevealed(id: string): boolean {
    return this.revealed().has(id);
  }

  protected async copyUsername(entry: SecretEntry): Promise<void> {
    this.error.set(null);
    try {
      await this.clipboard.copy(entry.username);
    } catch {
      this.error.set('Could not copy to the clipboard.');
    }
  }

  protected async copyPassword(entry: SecretEntry): Promise<void> {
    this.error.set(null);
    try {
      await this.clipboard.copyEphemeral(entry.password, `password for ${entry.title}`);
    } catch {
      this.error.set('Could not copy to the clipboard.');
    }
  }
}
