import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import sodium from 'libsodium-wrappers-sumo';
import { FakeSyncApi } from '../testing/fake-sync-api';
import { AuthService } from './auth.service';
import { BiometricUnlockService } from './biometric-unlock.service';
import { SyncApi } from './sync-api';
import { VaultService } from './vault.service';

/** Stands in for the Keystore-backed plugin: holds the sealed secret. */
class FakeBiometricVault {
  available = true;
  sealed: string | null = null;
  unlockError: { code: string } | null = null;
  returnSecret: string | null = null;
  disabled = 0;

  async status() {
    return { available: this.available, reason: 'ok', enrolled: this.sealed !== null };
  }
  async enroll({ secret }: { secret: string }) {
    this.sealed = secret;
  }
  async unlock() {
    if (this.unlockError) {
      throw Object.assign(new Error('x'), this.unlockError);
    }
    return { secret: this.returnSecret ?? this.sealed! };
  }
  async disable() {
    this.sealed = null;
    this.disabled += 1;
  }
}

describe('BiometricUnlockService', () => {
  const user = signal<{ uid: string } | null>({ uid: 'test-uid' });
  let native: FakeBiometricVault;
  let vault: VaultService;

  const inject = () => TestBed.inject(BiometricUnlockService);

  beforeEach(async () => {
    localStorage.clear();
    native = new FakeBiometricVault();
    (window as unknown as { Capacitor?: unknown }).Capacitor = { Plugins: { BiometricVault: native } };
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { user } },
        { provide: SyncApi, useValue: new FakeSyncApi() },
      ],
    });
    vault = TestBed.inject(VaultService);
    await sodium.ready;
    await vault.createVault('a long passphrase', {
      opsLimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      memLimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    });
  });

  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it('is unavailable outside the phone app', async () => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    const service = inject();
    await service.ready;
    expect(service.available()).toBe(false);
    expect(service.enabled()).toBe(false);
  });

  it('seals the vault key and unlocks with it after a fingerprint', async () => {
    const service = inject();
    await service.ready;
    expect(service.available()).toBe(true);
    const blob = await vault.encryptItem('still readable');

    await service.enable();
    expect(service.enabled()).toBe(true);
    expect(native.sealed).toBe(await vault.exportVaultKey());

    vault.lock();
    expect(vault.status()).toBe('locked');
    await service.unlock();
    expect(vault.status()).toBe('unlocked');
    expect(await vault.decryptItem(blob)).toBe('still readable');
  });

  it('gives an older vault its key check after a fingerprint unlock', async () => {
    const service = inject();
    await service.enable();
    // A vault made before key checks existed.
    const stored = JSON.parse(localStorage.getItem('clipsync.vault.test-uid')!);
    delete stored.keyCheck;
    localStorage.setItem('clipsync.vault.test-uid', JSON.stringify(stored));
    vault.lock();

    await service.unlock();
    expect(vault.status()).toBe('unlocked');
    const after = JSON.parse(localStorage.getItem('clipsync.vault.test-uid')!);
    expect(after.keyCheck).toMatch(/^xcv1:/);
  });

  it('stays set up when the prompt is cancelled', async () => {
    const service = inject();
    await service.enable();
    vault.lock();
    native.unlockError = { code: 'cancelled' };
    await expect(service.unlock()).rejects.toThrow('cancelled');
    expect(service.enabled()).toBe(true);
    expect(vault.status()).toBe('locked');
  });

  it('turns itself off when the phone’s fingerprints changed', async () => {
    const service = inject();
    await service.enable();
    vault.lock();
    native.unlockError = { code: 'invalidated' };
    await expect(service.unlock()).rejects.toThrow('invalidated');
    expect(service.enabled()).toBe(false);
  });

  it('refuses a key that does not open this vault', async () => {
    const service = inject();
    await service.enable();
    vault.lock();
    native.returnSecret = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    await expect(service.unlock()).rejects.toThrow('invalidated');
    expect(vault.status()).toBe('locked');
    expect(service.enabled()).toBe(false);
    expect(native.disabled).toBe(1);
  });
});
