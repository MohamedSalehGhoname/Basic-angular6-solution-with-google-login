import { Injectable, inject } from '@angular/core';
import { AuthService } from './auth.service';
import { BiometricUnlockService } from './biometric-unlock.service';
import { forgetLocalData } from './local-data';
import { SyncApi } from './sync-api';
import { VaultService } from './vault.service';

/**
 * Deleting the account, which Google Play requires an app with sign-in to
 * offer from inside the app.
 *
 * The server erases the vault, every item and every file record. Because the
 * vault holds the only copy of the wrapped key, the ciphertext left in any
 * backup is unreadable from that moment on — there is nothing to undo.
 */
@Injectable({ providedIn: 'root' })
export class AccountService {
  private readonly api = inject(SyncApi);
  private readonly auth = inject(AuthService);
  private readonly vault = inject(VaultService);
  private readonly biometric = inject(BiometricUnlockService);

  /**
   * Erases the account on the server, then everything this device kept for it,
   * and signs out. The server call goes first: if it fails the local copy is
   * left alone and the caller can show the error, rather than leaving the user
   * signed out of an account that still exists.
   */
  async deleteAccount(): Promise<void> {
    const uid = this.auth.user()?.uid;
    await this.api.deleteAccount();
    // A fingerprint key that can no longer open anything is still a key; drop
    // it from the phone's keystore before the account's traces go.
    await this.biometric.disable().catch(() => undefined);
    if (uid) {
      forgetLocalData(uid);
    }
    this.vault.lock();
    await this.auth.logout();
  }
}
