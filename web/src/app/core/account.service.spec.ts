import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import sodium from 'libsodium-wrappers-sumo';
import { FakeSyncApi } from '../testing/fake-sync-api';
import { AccountService } from './account.service';
import { AuthService } from './auth.service';
import { SyncApi } from './sync-api';
import { VaultService } from './vault.service';

describe('AccountService', () => {
  const uid = 'delete-me-uid';
  const user = signal<{ uid: string } | null>({ uid });
  let api: FakeSyncApi;
  let vault: VaultService;
  let loggedOut: number;

  beforeEach(async () => {
    localStorage.clear();
    // The signal is shared between tests and the first one signs out of it.
    user.set({ uid });
    api = new FakeSyncApi();
    loggedOut = 0;
    TestBed.configureTestingModule({
      providers: [
        {
          provide: AuthService,
          useValue: {
            user,
            logout: async () => {
              loggedOut += 1;
              user.set(null);
            },
          },
        },
        { provide: SyncApi, useValue: api },
      ],
    });
    vault = TestBed.inject(VaultService);
    await sodium.ready;
    await vault.createVault('a long passphrase', {
      opsLimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      memLimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    });
    // Stand-ins for what other parts of the app keep per account, plus one
    // device-wide preference that must survive.
    localStorage.setItem(`clipsync.clipboard.${uid}`, '{"items":[],"deleted":[]}');
    localStorage.setItem(`clipsync.ttl.${uid}`, '86400000');
    localStorage.setItem('clipsync.locale', 'ar');
  });

  it('erases the server, the local copy and the session, and keeps device preferences', async () => {
    expect(vault.status()).toBe('unlocked');

    await TestBed.inject(AccountService).deleteAccount();

    expect(api.vault).toBeNull();
    expect(localStorage.getItem(`clipsync.vault.${uid}`)).toBeNull();
    expect(localStorage.getItem(`clipsync.clipboard.${uid}`)).toBeNull();
    expect(localStorage.getItem(`clipsync.ttl.${uid}`)).toBeNull();
    expect(localStorage.getItem('clipsync.locale')).toBe('ar');
    expect(vault.status()).not.toBe('unlocked');
    expect(loggedOut).toBe(1);
  });

  it('keeps everything when the server call fails', async () => {
    api.offline = true;

    await expect(TestBed.inject(AccountService).deleteAccount()).rejects.toThrow();

    expect(localStorage.getItem(`clipsync.vault.${uid}`)).not.toBeNull();
    expect(localStorage.getItem(`clipsync.clipboard.${uid}`)).not.toBeNull();
    expect(vault.status()).toBe('unlocked');
    expect(loggedOut).toBe(0);
  });
});
