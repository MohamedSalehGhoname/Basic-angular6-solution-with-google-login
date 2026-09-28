import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import type { Locale } from '../../core/i18n/translations';
import type { TranslationKey } from '../../core/i18n/translations';
import { AccountService } from '../../core/account.service';
import {
  AUTO_LOCK_CHOICES,
  AutoLockService,
  type AutoLockMinutes,
} from '../../core/auto-lock.service';
import { AutofillService } from '../../core/autofill.service';
import { BiometricUnlockService } from '../../core/biometric-unlock.service';
import { SecretsStore } from '../../core/secrets-store';
import { DesktopCaptureService } from '../../core/desktop-capture.service';
import { FileShareService } from '../../core/file-share.service';
import { ThemeService, type ThemePreference } from '../../core/theme.service';
import { VaultService } from '../../core/vault.service';

@Component({
  selector: 'app-settings',
  imports: [FormsModule],
  templateUrl: './settings.html',
  styleUrl: './settings.css',
})
export class Settings {
  protected readonly vault = inject(VaultService);
  protected readonly theme = inject(ThemeService);
  protected readonly i18n = inject(I18nService);
  protected readonly files = inject(FileShareService);
  protected readonly capture = inject(DesktopCaptureService);
  protected readonly biometric = inject(BiometricUnlockService);
  protected readonly biometricBusy = signal(false);
  protected readonly biometricError = signal<string | null>(null);
  protected readonly autofill = inject(AutofillService);
  protected readonly autoLock = inject(AutoLockService);
  protected readonly secrets = inject(SecretsStore);
  protected readonly sealing = signal<{ done: number; total: number } | null>(null);
  protected readonly sealed = signal<number | null>(null);
  protected readonly sealError = signal<string | null>(null);

  /**
   * Rewrites entries saved before passwords were sealed away from the rest of
   * the entry. They are read either way, so this is housekeeping the user can
   * run when it suits them.
   */
  protected async sealOldEntries(): Promise<void> {
    if (this.sealing()) {
      return;
    }
    this.sealError.set(null);
    this.sealed.set(null);
    this.sealing.set({ done: 0, total: this.secrets.legacyCount() });
    try {
      const done = await this.secrets.migrateLegacy((d, total) =>
        this.sealing.set({ done: d, total }),
      );
      this.sealed.set(done);
    } catch (err) {
      this.sealError.set(err instanceof Error ? err.message : 'Could not finish.');
    } finally {
      this.sealing.set(null);
    }
  }
  protected readonly autoLockChoices = AUTO_LOCK_CHOICES;

  protected setAutoLock(minutes: string): void {
    this.autoLock.set(Number(minutes) as AutoLockMinutes);
  }

  /**
   * The picker's <option> values are strings, so the model has to be one too
   * or nothing matches and the box shows the first choice whatever is set.
   */
  protected autoLockValue(): string {
    return String(this.autoLock.minutes());
  }

  /** "Never", or how long — Arabic counts 3–10 differently from 11 up. */
  protected autoLockLabel(minutes: number): string {
    if (minutes === 0) {
      return this.i18n.t('settings.autoLockNever');
    }
    if (minutes === 1) {
      return this.i18n.t('settings.autoLockOne');
    }
    return this.i18n.t(minutes <= 10 ? 'settings.autoLockFew' : 'settings.autoLockMany', {
      n: minutes,
    });
  }

  constructor() {
    void this.biometric.refreshStatus();
    void this.autofill.refreshStatus();
  }

  protected async toggleBiometric(on: boolean): Promise<void> {
    this.biometricError.set(null);
    this.biometricBusy.set(true);
    try {
      if (on) {
        await this.biometric.enable();
      } else {
        await this.biometric.disable();
      }
    } catch {
      this.biometricError.set(this.i18n.t('biometric.enableFailed'));
    } finally {
      this.biometricBusy.set(false);
    }
  }

  protected readonly themeOptions: { value: ThemePreference; labelKey: TranslationKey }[] = [
    { value: 'system', labelKey: 'settings.theme.system' },
    { value: 'light', labelKey: 'settings.theme.light' },
    { value: 'dark', labelKey: 'settings.theme.dark' },
  ];
  protected readonly localeOptions: { value: Locale; label: string }[] = [
    { value: 'en', label: 'English' },
    { value: 'ar', label: 'العربية' },
  ];

  // Passphrase change
  protected current = '';
  protected next = '';
  protected confirm = '';
  protected readonly ppBusy = signal(false);
  protected readonly ppError = signal<string | null>(null);
  protected readonly ppDone = signal(false);
  protected readonly showPassphrase = signal(false);

  // Recovery code
  protected readonly recoveryBusy = signal(false);
  protected readonly recoveryError = signal<string | null>(null);
  protected readonly newRecoveryCode = signal<string | null>(null);

  protected async changePassphrase(): Promise<void> {
    this.ppError.set(null);
    this.ppDone.set(false);
    if (this.next.length < 10) {
      this.ppError.set(this.i18n.t('settings.ppTooShort'));
      return;
    }
    if (this.next !== this.confirm) {
      this.ppError.set(this.i18n.t('settings.ppMismatch'));
      return;
    }
    this.ppBusy.set(true);
    try {
      await this.vault.changePassphrase(this.current, this.next);
      this.current = this.next = this.confirm = '';
      this.ppDone.set(true);
    } catch (err) {
      this.ppError.set(err instanceof Error ? err.message : 'Could not change the passphrase.');
    } finally {
      this.ppBusy.set(false);
    }
  }

  protected async generateRecoveryCode(): Promise<void> {
    this.recoveryError.set(null);
    if (this.vault.hasRecovery() && !confirm(this.i18n.t('settings.replaceConfirm'))) {
      return;
    }
    this.recoveryBusy.set(true);
    try {
      this.newRecoveryCode.set(await this.vault.addRecoveryCode());
    } catch (err) {
      this.recoveryError.set(
        err instanceof Error ? err.message : 'Could not create a recovery code.',
      );
    } finally {
      this.recoveryBusy.set(false);
    }
  }

  protected async removeRecoveryCode(): Promise<void> {
    if (!confirm(this.i18n.t('settings.removeConfirm'))) {
      return;
    }
    this.recoveryError.set(null);
    try {
      await this.vault.removeRecoveryCode();
      this.newRecoveryCode.set(null);
    } catch (err) {
      this.recoveryError.set(
        err instanceof Error ? err.message : 'Could not remove the recovery code.',
      );
    }
  }

  protected dismissCode(): void {
    this.newRecoveryCode.set(null);
  }

  // Account deletion. Two deliberate steps: open the panel, then type the word
  // — a misplaced tap cannot get past either.
  private readonly account = inject(AccountService);
  protected readonly deleteOpen = signal(false);
  protected readonly deleteBusy = signal(false);
  protected readonly deleteError = signal<string | null>(null);
  protected deleteWord = '';

  /** The typed confirmation, matched loosely on case and stray spaces only. */
  protected get deleteArmed(): boolean {
    return this.deleteWord.trim().toLowerCase() === 'delete';
  }

  protected openDelete(): void {
    this.deleteError.set(null);
    this.deleteWord = '';
    this.deleteOpen.set(true);
  }

  protected cancelDelete(): void {
    this.deleteOpen.set(false);
    this.deleteWord = '';
  }

  protected async deleteAccount(): Promise<void> {
    if (!this.deleteArmed) {
      return;
    }
    this.deleteError.set(null);
    this.deleteBusy.set(true);
    try {
      await this.account.deleteAccount();
      // Signing out sends the app back to the login page; nothing to reset.
    } catch {
      this.deleteError.set(this.i18n.t('settings.deleteFailed'));
      this.deleteBusy.set(false);
    }
  }
}
