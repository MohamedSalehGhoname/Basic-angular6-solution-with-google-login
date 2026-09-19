import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
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

  protected readonly themeOptions: ThemePreference[] = ['system', 'light', 'dark'];

  // Passphrase change
  protected current = '';
  protected next = '';
  protected confirm = '';
  protected readonly ppBusy = signal(false);
  protected readonly ppError = signal<string | null>(null);
  protected readonly ppDone = signal(false);

  // Recovery code
  protected readonly recoveryBusy = signal(false);
  protected readonly recoveryError = signal<string | null>(null);
  protected readonly newRecoveryCode = signal<string | null>(null);

  protected async changePassphrase(): Promise<void> {
    this.ppError.set(null);
    this.ppDone.set(false);
    if (this.next.length < 10) {
      this.ppError.set('New passphrase must be at least 10 characters.');
      return;
    }
    if (this.next !== this.confirm) {
      this.ppError.set('New passphrases do not match.');
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
    if (
      this.vault.hasRecovery() &&
      !confirm('This replaces your existing recovery code. The old one will stop working. Continue?')
    ) {
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
    if (!confirm('Remove the recovery code? You will only be able to unlock with your passphrase.')) {
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
