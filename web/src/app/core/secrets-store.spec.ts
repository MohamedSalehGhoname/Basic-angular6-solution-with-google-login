import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import sodium from 'libsodium-wrappers-sumo';
import { FakeSyncApi } from '../testing/fake-sync-api';
import { AuthService } from './auth.service';
import { type KdfParams } from './crypto.service';
import { SecretsStore, type SecretFields } from './secrets-store';
import { SyncApi } from './sync-api';
import { VaultService } from './vault.service';

const fields = (over: Partial<SecretFields> = {}): SecretFields => ({
  title: 'GitHub',
  username: 'octocat',
  password: 'hunter2',
  url: 'https://github.com',
  notes: '',
  attachments: [],
  ...over,
});

describe('SecretsStore', () => {
  const user = signal<{ uid: string } | null>({ uid: 'test-uid' });
  let syncApi: FakeSyncApi;
  let store: SecretsStore;
  let vault: VaultService;
  let fastKdf: KdfParams;

  const configure = () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { user } },
        { provide: SyncApi, useValue: syncApi },
      ],
    });
    store = TestBed.inject(SecretsStore);
    vault = TestBed.inject(VaultService);
  };

  const waitFor = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(predicate()).toBe(true);
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
    await vault.createVault('a long passphrase', fastKdf);
  });

  it('adds a secret and round-trips its fields', async () => {
    const entry = await store.add(fields());
    expect(entry).not.toBeNull();
    const stored = store.items()[0];
    expect(stored.title).toBe('GitHub');
    expect(stored.username).toBe('octocat');
    expect(stored.url).toBe('https://github.com');
    // The password is not part of the row; it has to be asked for.
    expect((await store.open(stored.id)).password).toBe('hunter2');
  });

  it('keeps the password out of the half that is decrypted on unlock', async () => {
    const entry = await store.add(fields({ password: 'sealed-pw', notes: 'private note' }));
    // What the list reads when the vault opens: the outer layer only.
    const outer = store.items()[0] as unknown as Record<string, unknown>;
    expect(JSON.stringify(outer)).not.toContain('sealed-pw');
    expect(JSON.stringify(outer)).not.toContain('private note');
    expect(outer['sealed']).toMatch(/^xcv1:/);
    // And it says what is inside without saying what it is.
    expect(store.hasPassword(entry!)).toBe(true);
    expect(store.hasNotes(entry!)).toBe(true);
    expect(store.hasCode(entry!)).toBe(false);
  });

  it('reads an entry written before the split, and seals it when saved', async () => {
    // Live events only apply to a collection that has loaded.
    await store.load();
    // A device on an older build writes its secrets in the open.
    const legacy = await vault.encryptItem(
      JSON.stringify({
        title: 'Old entry',
        username: 'me',
        password: 'old-pw',
        url: '',
        notes: 'old note',
        attachments: [],
        totp: 'GEZDGNBVGY3TQOJQ',
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    syncApi.emit({
      type: 'item-added',
      collection: 'secrets',
      item: { id: 'legacy-1', blob: legacy, createdAt: 1 },
    });
    await waitFor(() => store.items().some((entry) => entry.id === 'legacy-1'));

    const entry = store.items().find((item) => item.id === 'legacy-1')!;
    expect(store.hasPassword(entry)).toBe(true);
    expect(store.hasCode(entry)).toBe(true);
    expect((await store.open('legacy-1')).password).toBe('old-pw');
    expect(store.legacyCount()).toBe(1);

    expect(await store.migrateLegacy()).toBe(1);
    expect(store.legacyCount()).toBe(0);
    const sealed = store.items().find((item) => item.id === 'legacy-1')!;
    expect(JSON.stringify(sealed)).not.toContain('old-pw');
    expect((await store.open('legacy-1')).password).toBe('old-pw');
    expect((await store.open('legacy-1')).totp).toBe('GEZDGNBVGY3TQOJQ');
  });

  it('keeps the two-factor key and its settings through a save', async () => {
    // normalize() rebuilds the entry field by field, so anything it forgets is
    // dropped silently on the way to storage — which is exactly what happened
    // when these were added.
    await store.add(
      fields({ totp: 'GEZDGNBVGY3TQOJQ', totpDigits: 8, totpPeriod: 60, totpAlgorithm: 'SHA-256' }),
    );
    const stored = store.items()[0]!;
    const secrets = await store.open(stored.id);
    expect(secrets.totp).toBe('GEZDGNBVGY3TQOJQ');
    expect(secrets.totpDigits).toBe(8);
    expect(secrets.totpPeriod).toBe(60);
    expect(secrets.totpAlgorithm).toBe('SHA-256');

    await store.save(stored.id, { ...(await store.fields(stored.id)), title: 'Renamed' });
    const edited = store.items()[0]!;
    expect(edited.title).toBe('Renamed');
    expect((await store.open(edited.id)).totp).toBe('GEZDGNBVGY3TQOJQ');
  });

  it('drops the two-factor settings when the key is removed', async () => {
    await store.add(fields({ totp: 'GEZDGNBVGY3TQOJQ', totpDigits: 8 }));
    const stored = store.items()[0]!;
    await store.save(stored.id, { ...(await store.fields(stored.id)), totp: null });
    const cleared = await store.open(store.items()[0]!.id);
    expect(cleared.totp).toBeNull();
    expect(cleared.totpDigits).toBeNull();
    expect(store.hasCode(store.items()[0]!)).toBe(false);
  });

  it('keeps every entry of a large import instead of dropping the overflow', async () => {
    // A browser export of a thousand passwords used to come out short: the
    // client's own ceiling was below the server's, and each entry past it
    // pushed another one out of the list without a word.
    for (let i = 0; i < 1100; i++) {
      await store.add(fields({ title: `Entry ${String(i).padStart(4, '0')}` }));
    }
    expect(store.items().length).toBe(1100);
    expect(store.items()[0].title).toBe('Entry 0000');
    expect(store.items().at(-1)!.title).toBe('Entry 1099');
    // Each one reached the server too, not just the list on screen.
    expect(syncApi.collections.get('secrets')!.size).toBe(1100);
  }, 120_000);

  it('carries on when the device has no room for the offline copy', async () => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    try {
      const entry = await store.add(fields({ title: 'Saved anyway' }));
      // On screen and on its way to the server, with the device saying why
      // its offline copy is behind.
      expect(entry).not.toBeNull();
      expect(store.items()[0].title).toBe('Saved anyway');
      expect(store.mirrorFull()).toBe(true);
    } finally {
      Storage.prototype.setItem = setItem;
    }
    await waitFor(() => (syncApi.collections.get('secrets')?.size ?? 0) === 1);
  });

  it('requires a title', async () => {
    expect(await store.add(fields({ title: '   ' }))).toBeNull();
    expect(store.items()).toEqual([]);
  });

  it('round-trips image attachments inside the encrypted entry', async () => {
    const attachment = {
      name: 'photo.jpg',
      type: 'image/jpeg',
      data: 'data:image/jpeg;base64,/9j/AAAA',
    };
    const entry = await store.add(fields({ title: 'With image', attachments: [attachment] }));
    expect((await store.open(entry!.id)).attachments).toEqual([attachment]);
    expect(store.attachmentCount(entry!)).toBe(1);

    // Nothing about the image leaks into the stored ciphertext.
    for (const item of syncApi.collections.get('secrets')!.values()) {
      expect(item.blob).not.toContain('base64');
      expect(item.blob.startsWith('xcv1:')).toBe(true);
    }

    // Survives a reload/decrypt.
    TestBed.resetTestingModule();
    configure();
    await vault.unlock('a long passphrase');
    await store.load();
    expect((await store.open(store.items()[0].id)).attachments).toEqual([attachment]);
  });

  it('stores only ciphertext, never the password, in its own collection', async () => {
    await store.add(fields({ password: 'super-secret-pw' }));
    const raw = localStorage.getItem('clipsync.secrets.test-uid')!;
    expect(raw).not.toContain('super-secret-pw');
    expect(raw).toContain('xcv1:');
    expect(syncApi.collections.get('secrets')!.size).toBe(1);
    // Nothing leaked into the clipboard collection.
    expect(syncApi.collections.get('clipboard')?.size ?? 0).toBe(0);
    for (const item of syncApi.collections.get('secrets')!.values()) {
      expect(item.blob).not.toContain('super-secret-pw');
    }
  });

  it('orders entries alphabetically by title', async () => {
    await store.add(fields({ title: 'Zulip' }));
    await store.add(fields({ title: 'Amazon' }));
    await store.add(fields({ title: 'Google' }));
    expect(store.items().map((entry) => entry.title)).toEqual(['Amazon', 'Google', 'Zulip']);
  });

  it('edits a secret in place, keeping its id and order', async () => {
    await store.add(fields({ title: 'Bank' }));
    const github = await store.add(fields({ title: 'GitHub' }));

    await store.save(github!.id, fields({ title: 'GitHub', password: 'rotated-pw' }));

    const edited = store.items().find((entry) => entry.id === github!.id)!;
    expect((await store.open(edited.id)).password).toBe('rotated-pw');
    expect(store.items().map((entry) => entry.title)).toEqual(['Bank', 'GitHub']);
    expect(edited.updatedAt).toBeGreaterThanOrEqual(edited.createdAt);
  });

  it('reloads secrets after unlock in a fresh injector', async () => {
    await store.add(fields({ title: 'Persisted' }));

    TestBed.resetTestingModule();
    configure();
    await vault.unlock('a long passphrase');
    await store.load();

    expect(store.items().map((entry) => entry.title)).toEqual(['Persisted']);
  });

  it('applies a live edit from another device', async () => {
    const entry = await store.add(fields({ title: 'Shared', password: 'old' }));
    await store.load();

    const updatedBlob = await vault.encryptItem(
      JSON.stringify({
        title: 'Shared',
        username: 'octocat',
        password: 'new-from-phone',
        url: '',
        notes: '',
        createdAt: entry!.createdAt,
        updatedAt: Date.now(),
      }),
    );
    syncApi.emit({
      type: 'item-added',
      collection: 'secrets',
      item: { id: entry!.id, blob: updatedBlob, createdAt: entry!.createdAt },
    });

    await waitFor(() => store.items()[0]?.updatedAt !== entry!.updatedAt);
    expect((await store.open(entry!.id)).password).toBe('new-from-phone');
  });

  it('ignores events for the clipboard collection', async () => {
    await store.load();
    syncApi.emit({
      type: 'item-added',
      collection: 'clipboard',
      item: { id: 'other', blob: 'xcv1:whatever', createdAt: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.items()).toEqual([]);
  });

  it('removes a secret everywhere', async () => {
    const entry = await store.add(fields());
    store.remove(entry!.id);
    expect(store.items()).toEqual([]);
    await waitFor(() => (syncApi.collections.get('secrets')?.size ?? 0) === 0);
  });
});
