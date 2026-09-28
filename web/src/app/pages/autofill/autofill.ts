import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AutofillService, matchScore } from '../../core/autofill.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { SecretsStore, type SecretEntry } from '../../core/secrets-store';
import { VaultService } from '../../core/vault.service';

/**
 * The screen Android opens on top of another app: pick the account to fill,
 * or agree to save one it just saw you type.
 *
 * It exists because the autofill service cannot decrypt anything on its own.
 * Everything here is the ordinary app — same vault, same unlock — so nothing
 * about the secrets leaves the one place that understands them.
 */
@Component({
  selector: 'app-autofill',
  imports: [FormsModule],
  templateUrl: './autofill.html',
  styleUrl: './autofill.css',
})
export class Autofill {
  protected readonly i18n = inject(I18nService);
  protected readonly autofill = inject(AutofillService);
  protected readonly secrets = inject(SecretsStore);
  private readonly vault = inject(VaultService);
  private readonly router = inject(Router);

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected search = '';
  protected saveTitle = '';

  protected readonly request = this.autofill.request;

  /**
   * Matches first, then everything else, so the account you want is usually
   * the top row — but the whole vault stays reachable, because the guess is
   * only a guess.
   */
  protected readonly matches = computed(() => {
    const identity = this.request()?.identity ?? '';
    const query = this.search.trim().toLowerCase();
    return this.secrets
      .items()
      .map((secret) => ({ secret, score: identity ? matchScore(secret, identity) : 0 }))
      .filter(({ secret }) =>
        query
          ? `${secret.title} ${secret.username} ${secret.url}`.toLowerCase().includes(query)
          : true,
      )
      .sort((a, b) => b.score - a.score || a.secret.title.localeCompare(b.secret.title));
  });

  protected readonly suggested = computed(() => this.matches().filter((row) => row.score > 0));

  constructor() {
    void this.start();
  }

  private async start(): Promise<void> {
    const request = await this.autofill.ready;
    if (!request) {
      // Opened without a request: nothing to answer, go to the app.
      await this.router.navigateByUrl('/');
      return;
    }
    if (this.vault.status() !== 'unlocked') {
      await this.router.navigate(['/unlock'], { queryParams: { returnUrl: '/autofill' } });
      return;
    }
    this.saveTitle = defaultTitle(request.identity);
    // load(), not refresh(): this screen is usually the first thing the app
    // opens, so nothing has loaded the secrets yet — and refresh() is a no-op
    // until something has.
    await this.secrets.load();
  }

  /**
   * Hands one entry's values back to Android. The password is sealed until
   * here: picking the entry (after the fingerprint check that opened this
   * screen) is what opens it, and nothing else on this screen needed it.
   */
  protected async fill(secret: SecretEntry): Promise<void> {
    this.error.set(null);
    this.busy.set(true);
    try {
      const { password } = await this.secrets.open(secret.id);
      await this.autofill.respond({ title: secret.title, username: secret.username, password });
    } catch {
      this.error.set(this.i18n.t('autofill.failed'));
      this.busy.set(false);
    }
  }

  protected async saveNew(): Promise<void> {
    const request = this.request();
    // A sign-in that only ever sends a code to an address has no password to
    // keep, but remembering the address is still worth something.
    if (!request?.password && !request?.username) {
      return;
    }
    this.error.set(null);
    this.busy.set(true);
    try {
      await this.secrets.add({
        title: this.saveTitle.trim() || defaultTitle(request.identity),
        username: request.username ?? '',
        password: request.password ?? '',
        url: request.webDomain ? `https://${request.webDomain}` : '',
        notes: request.packageName && !request.webDomain ? request.packageName : '',
        attachments: [],
      });
      await this.autofill.cancel();
    } catch {
      this.error.set(this.i18n.t('autofill.saveFailed'));
      this.busy.set(false);
    }
  }

  protected async dismiss(): Promise<void> {
    await this.autofill.cancel();
  }
}

/** A readable name for a site or app when the user has not given one. */
function defaultTitle(identity: string | null): string {
  if (!identity) {
    return '';
  }
  const host = identity.replace(/^www\./, '');
  if (host.includes('.') && !host.startsWith('com.')) {
    return host.split('.')[0]!.replace(/^./, (c) => c.toUpperCase());
  }
  const parts = identity.split('.');
  const word = parts.length > 1 ? parts[1]! : parts[0]!;
  return word.replace(/^./, (c) => c.toUpperCase());
}
