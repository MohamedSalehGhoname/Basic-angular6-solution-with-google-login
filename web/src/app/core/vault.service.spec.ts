import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import sodium from 'libsodium-wrappers-sumo';
import { FakeSyncApi } from '../testing/fake-sync-api';
import { AuthService } from './auth.service';
import { type KdfParams } from './crypto.service';
import { SyncApi } from './sync-api';
import { VaultService } from './vault.service';

describe('VaultService', () => {
  const user = signal<{ uid: string } | null>({ uid: 'test-uid' });
  let syncApi: FakeSyncApi;
  let service: VaultService;
  // INTERACTIVE keeps Argon2id fast in tests; production defaults are MODERATE.
  let fastKdf: KdfParams;

  const configure = () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { user } },
        { provide: SyncApi, useValue: syncApi },
      ],
    });
    service = TestBed.inject(VaultService);
  };

  beforeEach(async () => {
    localStorage.clear();
    user.set({ uid: 'test-uid' });
    syncApi = new FakeSyncApi();
    configure();
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

  it('pushes the vault record to the server on creation', async () => {
    await service.createVault('a long passphrase', fastKdf);
    expect(syncApi.vault).not.toBeNull();
    expect(syncApi.vault!.wrappedKey.startsWith('xcv1:')).toBe(true);
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
    configure();

    expect(service.status()).toBe('locked');
    await service.unlock('a long passphrase');
    expect(service.status()).toBe('unlocked');
  });

  it('lets a new device unlock from the server-stored record', async () => {
    await service.createVault('a long passphrase', fastKdf);

    // New device: no local state at all, but the same server.
    localStorage.clear();
    TestBed.resetTestingModule();
    configure();
    expect(service.status()).toBe('uninitialized');

    await service.ensureMetadata();
    expect(service.status()).toBe('locked');
    await service.unlock('a long passphrase');
    expect(service.status()).toBe('unlocked');
  });

  it('creates offline and pushes the record once the server is reachable', async () => {
    syncApi.offline = true;
    await service.createVault('a long passphrase', fastKdf);
    expect(service.status()).toBe('unlocked');
    expect(syncApi.vault).toBeNull();

    syncApi.offline = false;
    await service.ensureMetadata();
    expect(syncApi.vault).not.toBeNull();
  });

  it('keeps vaults separate per account', async () => {
    await service.createVault('a long passphrase', fastKdf);
    user.set({ uid: 'other-uid' });
    expect(service.status()).toBe('uninitialized');
  });
});
