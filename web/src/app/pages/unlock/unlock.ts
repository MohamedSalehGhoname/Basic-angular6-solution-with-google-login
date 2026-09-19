import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { I18nService } from '../../core/i18n/i18n.service';
import { VaultService } from '../../core/vault.service';

const MIN_PASSPHRASE_LENGTH = 10;

@Component({
  selector: 'app-unlock',
  imports: [FormsModule],
  templateUrl: './unlock.html',
  styleUrl: './unlock.css',
})
export class Unlock {
  protected readonly vault = inject(VaultService);
  protected readonly i18n = inject(I18nService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected passphrase = '';
  protected confirmation = '';
  protected recoveryCode = '';
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** False until the vault record has been reconciled with the server. */
  protected readonly ready = signal(false);
  /** Whether the recovery-code form is shown instead of the passphrase form. */
  protected readonly usingRecovery = signal(false);
  /** Reveals what was typed, e.g. to spot the wrong keyboard language or Caps Lock. */
  protected readonly showPassphrase = signal(false);

  protected readonly creating = computed(() => this.vault.status() === 'uninitialized');
  protected readonly minLength = MIN_PASSPHRASE_LENGTH;

  protected toggleRecovery(): void {
    this.error.set(null);
    this.usingRecovery.update((v) => !v);
  }

  constructor() {
    if (this.vault.status() === 'unlocked') {
      this.router.navigateByUrl(this.returnUrl());
      return;
    }
    void this.vault.ensureMetadata().finally(() => this.ready.set(true));
  }

  protected async submit(): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.error.set(null);

    if (this.creating()) {
      if (this.passphrase.length < MIN_PASSPHRASE_LENGTH) {
        this.error.set(this.i18n.t('unlock.tooShort', { n: MIN_PASSPHRASE_LENGTH }));
        return;
      }
      if (this.passphrase !== this.confirmation) {
        this.error.set(this.i18n.t('unlock.mismatch'));
        return;
      }
    }

    this.busy.set(true);
    try {
      if (this.usingRecovery()) {
        await this.vault.unlockWithRecoveryCode(this.recoveryCode);
      } else if (this.creating()) {
        await this.vault.createVault(this.passphrase);
      } else {
        await this.vault.unlock(this.passphrase);
      }
      this.passphrase = '';
      this.confirmation = '';
      this.showPassphrase.set(false);
      this.recoveryCode = '';
      await this.router.navigateByUrl(this.returnUrl());
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : this.i18n.t('unlock.generic'));
    } finally {
      this.busy.set(false);
    }
  }

  private returnUrl(): string {
    return this.route.snapshot.queryParamMap.get('returnUrl') ?? '/';
  }
}
