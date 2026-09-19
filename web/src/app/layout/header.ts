import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../core/auth.service';
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
