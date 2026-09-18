import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
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
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected passphrase = '';
  protected confirmation = '';
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** False until the vault record has been reconciled with the server. */
  protected readonly ready = signal(false);

  protected readonly creating = computed(() => this.vault.status() === 'uninitialized');
  protected readonly minLength = MIN_PASSPHRASE_LENGTH;

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
        this.error.set(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`);
        return;
      }
      if (this.passphrase !== this.confirmation) {
        this.error.set('Passphrases do not match.');
        return;
      }
    }

    this.busy.set(true);
    try {
      if (this.creating()) {
        await this.vault.createVault(this.passphrase);
      } else {
        await this.vault.unlock(this.passphrase);
      }
      this.passphrase = '';
      this.confirmation = '';
      await this.router.navigateByUrl(this.returnUrl());
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      this.busy.set(false);
    }
  }

  private returnUrl(): string {
    return this.route.snapshot.queryParamMap.get('returnUrl') ?? '/';
  }
}
