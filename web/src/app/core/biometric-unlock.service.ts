import { Injectable, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { I18nService } from './i18n/i18n.service';
import { VaultService } from './vault.service';

/** The BiometricVault Capacitor plugin (mobile/plugins/biometric-vault). */
interface BiometricVaultPlugin {
  status(): Promise<{ available: boolean; reason: string; enrolled: boolean }>;
  enroll(options: { secret: string; title?: string; cancel?: string }): Promise<void>;
  unlock(options: { title?: string; cancel?: string }): Promise<{ secret: string }>;
  disable(): Promise<void>;
}

/** Why a fingerprint unlock did not happen. */
export type BiometricError = 'cancelled' | 'invalidated' | 'failed';

function plugin(): BiometricVaultPlugin | undefined {
  return (window as unknown as { Capacitor?: { Plugins?: { BiometricVault?: BiometricVaultPlugin } } })
    .Capacitor?.Plugins?.BiometricVault;
}

/**
 * Fingerprint unlock on the phone app. The vault key is sealed by an Android
 * Keystore key that only a strong biometric check can use, so the
 * fingerprint is what releases the key; the passphrase always still works.
 * Next to it we keep a small check blob (encrypted with the vault key, so
 * not secret) to refuse a stale key if the vault was ever recreated.
 */
@Injectable({ providedIn: 'root' })
export class BiometricUnlockService {
  private readonly vault = inject(VaultService);
  private readonly auth = inject(AuthService);
  private readonly i18n = inject(I18nService);
  private readonly native = plugin();

  /** The phone has a strong biometric set up. */
  readonly available = signal(false);
  private readonly _enabled = signal(false);
  /** Fingerprint unlock is set up for the signed-in account on this phone. */
  readonly enabled = this._enabled.asReadonly();
  /** Resolves once availability is known. */
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.refreshStatus();
  }

  async refreshStatus(): Promise<void> {
    if (!this.native) {
      return;
    }
    try {
      const status = await this.native.status();
      this.available.set(status.available);
      this._enabled.set(status.available && status.enrolled && !!this.readCheck());
    } catch {
      this.available.set(false);
      this._enabled.set(false);
    }
  }

  /** Seals the unlocked vault key behind the fingerprint (shows the prompt). */
  async enable(): Promise<void> {
    if (!this.native) {
      throw new Error('unavailable');
    }
    const secret = await this.vault.exportVaultKey();
    await this.native.enroll({
      secret,
      title: this.i18n.t('biometric.enrollTitle'),
      cancel: this.i18n.t('secrets.cancel'),
    });
    this.writeCheck(await this.vault.keyCheck());
    this._enabled.set(true);
  }

  /** Unlocks the vault with a fingerprint; throws a BiometricError reason. */
  async unlock(): Promise<void> {
    const check = this.readCheck();
    if (!this.native || !check) {
      throw new Error('failed' satisfies BiometricError);
    }
    let secret: string;
    try {
      secret = (
        await this.native.unlock({
          title: this.i18n.t('biometric.unlockTitle'),
          cancel: this.i18n.t('biometric.usePassphrase'),
        })
      ).secret;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'invalidated' || code === 'not_enrolled') {
        this.forget();
        throw new Error('invalidated' satisfies BiometricError);
      }
      throw new Error((code === 'cancelled' ? 'cancelled' : 'failed') satisfies BiometricError);
    }
    try {
      await this.vault.unlockWithVaultKey(secret, check);
    } catch {
      await this.disable();
      throw new Error('invalidated' satisfies BiometricError);
    }
  }

  async disable(): Promise<void> {
    try {
      await this.native?.disable();
    } finally {
      this.forget();
    }
  }

  private forget(): void {
    const uid = this.auth.user()?.uid;
    if (uid) {
      try {
        localStorage.removeItem(this.checkKey(uid));
      } catch {
        // Nothing stored.
      }
    }
    this._enabled.set(false);
  }

  private checkKey(uid: string): string {
    return `clipsync.biometric.${uid}`;
  }

  private readCheck(): string | null {
    const uid = this.auth.user()?.uid;
    try {
      return uid ? localStorage.getItem(this.checkKey(uid)) : null;
    } catch {
      return null;
    }
  }

  private writeCheck(check: string): void {
    const uid = this.auth.user()?.uid;
    if (uid) {
      localStorage.setItem(this.checkKey(uid), check);
    }
  }
}
