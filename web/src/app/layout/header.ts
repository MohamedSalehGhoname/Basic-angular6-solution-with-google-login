import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../core/auth.service';
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
  private readonly router = inject(Router);

  protected lockVault(): void {
    this.vault.lock();
    this.router.navigate(['/unlock']);
  }

  protected signOut(): void {
    this.vault.lock();
    this.auth.logout();
  }
}
