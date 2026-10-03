import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { VaultService } from './vault.service';

/** Runs after authGuard, so the auth state is already resolved. */
export const unlockGuard: CanActivateFn = async (_route, state) => {
  const vault = inject(VaultService);
  const router = inject(Router);

  await vault.ensureMetadata();
  if (vault.status() === 'unlocked') {
    return true;
  }
  return router.createUrlTree(['/unlock'], { queryParams: { returnUrl: state.url } });
};
