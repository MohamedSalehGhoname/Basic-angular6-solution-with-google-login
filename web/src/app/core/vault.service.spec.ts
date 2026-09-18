import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import sodium from 'libsodium-wrappers-sumo';
import { AuthService } from './auth.service';
import { type KdfParams } from './crypto.service';
import { VaultService } from './vault.service';

describe('VaultService', () => {
  const user = signal<{ uid: string } | null>({ uid: 'test-uid' });
  let service: VaultService;
  // INTERACTIVE keeps Argon2id fast in tests; production defaults are MODERATE.
  let fastKdf: KdfParams;

  beforeEach(async () => {
    localStorage.clear();
    user.set({ uid: 'test-uid' });
    TestBed.configureTestingModule({
      providers: [{ provide: AuthService, useValue: { user } }],
    });
    service = TestBed.inject(VaultService);
    await sodium.ready;
    fastKdf = {
      opsLimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      memLimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    };
  });

  it('reports uninitialized for an account without a vault', () => {
    expect(service.status()).toBe('uninitialized');
  });

  it('creates a vault, unlocks it, and encrypts items', async () => {
    await service.createVault('a long passphrase', fastKdf);
    expect(service.status()).toBe('unlocked');

    const blob = await service.encryptItem('copied text');
    expect(await service.decryptItem(blob)).toBe('copied text');
  });

  it('locks and refuses to encrypt while locked', async () => {
    await service.createVault('a long passphrase', fastKdf);
    service.lock();

    expect(service.status()).toBe('locked');
    await expect(service.encryptItem('nope')).rejects.toThrowError(/Vault is locked/);
  });

  it('unlocks again with the right passphrase and rejects the wrong one', async () => {
    await service.createVault('a long passphrase', fastKdf);
    const blob = await service.encryptItem('survives relock');
    service.lock();

    await expect(service.unlock('wrong passphrase')).rejects.toThrowError(
      /Incorrect passphrase/,
    );
    expect(service.status()).toBe('locked');

    await service.unlock('a long passphrase');
    expect(service.status()).toBe('unlocked');
    expect(await service.decryptItem(blob)).toBe('survives relock');
  });

  it('sees an existing vault as locked from a fresh service instance', async () => {
    await service.createVault('a long passphrase', fastKdf);

    // New injector simulates a page reload: metadata persists, the key does not.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: AuthService, useValue: { user } }],
    });
    const fresh = TestBed.inject(VaultService);

    expect(fresh.status()).toBe('locked');
    await fresh.unlock('a long passphrase');
    expect(fresh.status()).toBe('unlocked');
  });

  it('keeps vaults separate per account', async () => {
    await service.createVault('a long passphrase', fastKdf);
    user.set({ uid: 'other-uid' });
    expect(service.status()).toBe('uninitialized');
  });
});
