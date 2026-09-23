import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import type { Locale } from '../../core/i18n/translations';
import type { TranslationKey } from '../../core/i18n/translations';
import { BiometricUnlockService } from '../../core/biometric-unlock.service';
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

  constructor() {
    void this.biometric.refreshStatus();
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
      this.recoveryError.set(err instanceof Error ? err.message : 'Could not create a recovery code.');
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
      this.recoveryError.set(err instanceof Error ? err.message : 'Could not remove the recovery code.');
    }
  }

  protected dismissCode(): void {
    this.newRecoveryCode.set(null);
  }
}
