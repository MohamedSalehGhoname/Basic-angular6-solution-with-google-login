import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ClipboardCopyService } from '../../core/clipboard-copy.service';
import { GroupsStore } from '../../core/groups-store';
import { I18nService } from '../../core/i18n/i18n.service';
import { SecretsStore, type SecretEntry } from '../../core/secrets-store';
import { TotpService } from '../../core/totp.service';

/** How long a row stays marked as copied. */
const COPIED_FLASH_MS = 2000;

/**
 * Every two-factor code in one place, the way an authenticator app shows them:
 * the codes are what the user came for, so they are the biggest thing on the
 * row and a single tap anywhere on it copies one. The passwords they belong to
 * stay on the secrets page; nothing here reveals one.
 */
@Component({
  selector: 'app-codes',
  imports: [FormsModule, RouterLink],
  templateUrl: './codes.html',
  styleUrl: './codes.css',
})
export class Codes {
  private readonly store = inject(SecretsStore);
  private readonly groups = inject(GroupsStore);
  private readonly totp = inject(TotpService);
  protected readonly clipboard = inject(ClipboardCopyService);
  protected readonly i18n = inject(I18nService);

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly search = signal('');
  /** Entry whose code was just copied, for the tick on its row. */
  protected readonly copiedId = signal<string | null>(null);
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  /** Everything that has a key, in the store's alphabetical order. */
  protected readonly withCodes = computed(() => this.store.items().filter((entry) => !!entry.totp));

  protected readonly filtered = computed(() => {
    const query = this.search().trim().toLowerCase();
    const entries = this.withCodes();
    if (!query) {
      return entries;
    }
    return entries.filter((entry) =>
      [entry.title, entry.username, entry.url, this.groups.path(entry.groupId)]
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
      await Promise.all([this.store.load(), this.groups.load()]);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not load your codes.');
    } finally {
      this.loading.set(false);
    }
  }

  protected codeOf(entry: SecretEntry): string {
    return this.totp.liveCode(entry.id, entry);
  }

  protected secondsLeft(entry: SecretEntry): number {
    return this.totp.secondsLeft(entry);
  }

  /** How much of the current code's life is left, for the countdown ring. */
  protected fractionLeft(entry: SecretEntry): number {
    const period = this.totp.config(entry)?.period ?? 0;
    return period > 0 ? this.secondsLeft(entry) / period : 0;
  }

  /** The countdown ring: filled for the part of the period still to run. */
  protected ringBackground(entry: SecretEntry): string {
    const degrees = Math.round(this.fractionLeft(entry) * 360);
    const colour = this.secondsLeft(entry) <= 5 ? 'var(--danger)' : 'var(--primary)';
    return `conic-gradient(${colour} ${degrees}deg, var(--border) 0)`;
  }

  protected groupPath(entry: SecretEntry): string {
    return this.groups.path(entry.groupId);
  }

  /**
   * Copies the code without the space that makes it readable. It goes through
   * the same auto-clearing copy as a password: a code is short-lived anyway,
   * but leaving it in the clipboard helps nobody.
   */
  protected async copy(entry: SecretEntry): Promise<void> {
    this.error.set(null);
    try {
      const code = await this.totp.codeFor(entry);
      if (!code) {
        return;
      }
      await this.clipboard.copyEphemeral(
        code,
        `${this.i18n.t('secrets.field.totp')} · ${entry.title}`,
      );
      this.copiedId.set(entry.id);
      if (this.copiedTimer) {
        clearTimeout(this.copiedTimer);
      }
      this.copiedTimer = setTimeout(() => this.copiedId.set(null), COPIED_FLASH_MS);
    } catch {
      this.error.set('Could not copy to the clipboard.');
    }
  }
}
