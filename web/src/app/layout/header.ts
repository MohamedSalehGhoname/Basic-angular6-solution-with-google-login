import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { ClipboardStore } from '../core/clipboard-store';
import { GroupsStore } from '../core/groups-store';
import { SecretsStore } from '../core/secrets-store';
import { I18nService } from '../core/i18n/i18n.service';
import { ThemeService } from '../core/theme.service';
import { VaultService } from '../core/vault.service';

@Component({
  selector: 'app-header',
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './header.html',
  styleUrl: './header.css',
})
export class Header {
  protected readonly auth = inject(AuthService);
  protected readonly vault = inject(VaultService);
  protected readonly theme = inject(ThemeService);
  protected readonly i18n = inject(I18nService);
  private readonly router = inject(Router);
  private readonly collections = [inject(ClipboardStore), inject(SecretsStore), inject(GroupsStore)];

  protected readonly refreshing = signal(false);

  constructor() {
    // The phone app: re-sync when brought back to the foreground, since the
    // live connection may have been dropped while it was in the background.
    const app = (
      window as unknown as {
        Capacitor?: { Plugins?: { App?: { addListener(e: 'resume', cb: () => void): unknown } } };
      }
    ).Capacitor?.Plugins?.App;
    app?.addListener('resume', () => void this.refresh());
  }

  /** Re-reads the clipboard, secrets and groups from the server. */
  protected async refresh(): Promise<void> {
    if (this.refreshing() || this.vault.status() !== 'unlocked') {
      return;
    }
    this.refreshing.set(true);
    try {
      await Promise.allSettled(this.collections.map((collection) => collection.refresh()));
    } finally {
      this.refreshing.set(false);
    }
  }

  protected readonly themeIcon = computed(() => {
    switch (this.theme.preference()) {
      case 'light':
        return '☀';
      case 'dark':
        return '☾';
      default:
        return '◐';
    }
  });

  protected readonly themeLabel = computed(() => `Theme: ${this.theme.preference()}`);

  protected lockVault(): void {
    this.vault.lock();
    this.router.navigate(['/unlock']);
  }

  protected signOut(): void {
    this.vault.lock();
    this.auth.logout();
  }
}
