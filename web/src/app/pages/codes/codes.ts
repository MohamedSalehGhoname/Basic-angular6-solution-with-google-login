import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  type MigrationAccount,
  accountTitle,
  parseMigration,
} from '../../core/authenticator-import';
import { ClipboardCopyService } from '../../core/clipboard-copy.service';
import { GroupsStore } from '../../core/groups-store';
import { I18nService } from '../../core/i18n/i18n.service';
import { QrScannerService } from '../../core/qr-scanner.service';
import { SecretsStore, type SecretEntry, type SecretSecrets } from '../../core/secrets-store';
import { TOTP_DEFAULTS, parseTotp } from '../../core/totp';
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
  protected readonly qr = inject(QrScannerService);

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly search = signal('');
  /** Entry whose code was just copied, for the tick on its row. */
  protected readonly copiedId = signal<string | null>(null);
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  /** Everything that has a key, in the store's alphabetical order. */
  protected readonly withCodes = computed(() =>
    this.store.items().filter((entry) => this.store.hasCode(entry)),
  );

  /**
   * The keys this screen has opened. Only entries that have a code are opened,
   * and only while this screen is up — the rest of the vault stays sealed.
   */
  private readonly configs = signal<Map<string, SecretSecrets>>(new Map());
  private opening = new Set<string>();

  private configOf(entry: SecretEntry): SecretSecrets | null {
    const known = this.configs().get(entry.id);
    if (known) {
      return known;
    }
    if (!this.opening.has(entry.id)) {
      this.opening.add(entry.id);
      void this.store
        .open(entry.id)
        .then((secrets) => this.configs.update((map) => new Map(map).set(entry.id, secrets)))
        .catch(() => this.error.set(this.i18n.t('secrets.openFailed')))
        .finally(() => this.opening.delete(entry.id));
    }
    return null;
  }

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

  // --- Import from Google Authenticator --------------------------------------
  // Its export is a set of QR codes rather than one, so the scanner is opened
  // again until every code in the set has been read, and what they hold is
  // gathered up before anything is written to the vault.

  protected readonly scanning = signal(false);
  protected readonly scanned = signal<MigrationAccount[]>([]);
  /** How many QR codes the export said it has, and which ones were read. */
  protected readonly batchCount = signal(1);
  private readonly batchesSeen = signal<Set<number>>(new Set());
  /**
   * Counter-based accounts per QR code. Kept per code rather than added up as
   * they arrive: scanning the same code twice is easy to do and used to count
   * its skipped accounts twice over.
   */
  private readonly hotpByBatch = signal<Map<number, number>>(new Map());
  protected readonly hotpSkipped = computed(() =>
    [...this.hotpByBatch().values()].reduce((total, n) => total + n, 0),
  );
  protected readonly importing = signal(false);
  protected readonly importResult = signal<{ added: number; existing: number } | null>(null);

  protected readonly batchesLeft = computed(() => this.batchCount() - this.batchesSeen().size);

  /**
   * Keys already in the vault, so an import does not add one twice. Only the
   * entries that have a code are opened, and only while the import card is up.
   */
  private readonly knownSecrets = signal<Set<string>>(new Set());

  private async loadKnownSecrets(): Promise<void> {
    const keys = new Set<string>();
    for (const entry of this.withCodes()) {
      const secrets = this.configs().get(entry.id) ?? (await this.store.open(entry.id));
      if (secrets.totp) {
        keys.add(secrets.totp);
      }
    }
    this.knownSecrets.set(keys);
  }

  protected alreadyHave(account: MigrationAccount): boolean {
    return this.knownSecrets().has(account.secret);
  }

  protected title(account: MigrationAccount): string {
    return accountTitle(account);
  }

  protected async scanExport(): Promise<void> {
    this.error.set(null);
    this.importResult.set(null);
    this.scanning.set(true);
    try {
      const value = await this.qr.scan();
      if (value === null) {
        return;
      }
      await this.loadKnownSecrets();
      this.readScan(value);
    } catch {
      this.error.set(this.i18n.t('codes.import.scanFailed'));
    } finally {
      this.scanning.set(false);
    }
  }

  /** Takes an export code, or a single otpauth:// link scanned by mistake. */
  private readScan(value: string): void {
    let accounts: MigrationAccount[];
    try {
      const batch = parseMigration(value);
      accounts = batch.accounts;
      this.batchCount.set(batch.count);
      this.batchesSeen.update((seen) => new Set(seen).add(batch.index));
      this.hotpByBatch.update((counts) => new Map(counts).set(batch.index, batch.hotpSkipped));
    } catch {
      const single = parseTotp(value);
      if (!single) {
        this.error.set(this.i18n.t('codes.import.notExport'));
        return;
      }
      accounts = [{ ...single, label: single.label ?? '', issuer: single.issuer ?? '' }];
      this.batchesSeen.update((seen) => new Set(seen).add(1));
    }
    // Scanning the same code twice should not list everything twice.
    this.scanned.update((list) => {
      const bySecret = new Map(list.map((account) => [account.secret, account]));
      for (const account of accounts) {
        bySecret.set(account.secret, account);
      }
      return [...bySecret.values()];
    });
  }

  protected cancelImport(): void {
    this.scanned.set([]);
    this.batchCount.set(1);
    this.batchesSeen.set(new Set());
    this.hotpByBatch.set(new Map());
  }

  /** Writes what was scanned into the vault, one entry per account. */
  protected async runImport(): Promise<void> {
    if (this.importing()) {
      return;
    }
    this.importing.set(true);
    this.error.set(null);
    let added = 0;
    let existing = 0;
    try {
      for (const account of this.scanned()) {
        if (this.alreadyHave(account)) {
          existing += 1;
          continue;
        }
        await this.store.add({
          title: accountTitle(account),
          username: account.label.includes(':')
            ? account.label.slice(account.label.indexOf(':') + 1).trim()
            : account.label,
          password: '',
          url: '',
          notes: '',
          attachments: [],
          groupId: null,
          totp: account.secret,
          totpDigits: account.digits === TOTP_DEFAULTS.digits ? null : account.digits,
          totpPeriod: account.period === TOTP_DEFAULTS.period ? null : account.period,
          totpAlgorithm: account.algorithm === TOTP_DEFAULTS.algorithm ? null : account.algorithm,
        });
        added += 1;
      }
      this.importResult.set({ added, existing });
      this.cancelImport();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not import the codes.');
    } finally {
      this.importing.set(false);
    }
  }

  // --- Codes on screen -------------------------------------------------------

  protected codeOf(entry: SecretEntry): string {
    const secrets = this.configOf(entry);
    return secrets ? this.totp.liveCode(entry.id, secrets) : '······';
  }

  protected secondsLeft(entry: SecretEntry): number {
    const secrets = this.configOf(entry);
    return secrets ? this.totp.secondsLeft(secrets) : 0;
  }

  /** How much of the current code's life is left, for the countdown ring. */
  protected fractionLeft(entry: SecretEntry): number {
    const secrets = this.configOf(entry);
    const period = secrets ? (this.totp.config(secrets)?.period ?? 0) : 0;
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
      const code = await this.totp.codeFor(await this.store.open(entry.id));
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
