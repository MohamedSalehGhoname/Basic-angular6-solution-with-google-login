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
    expect(stored.password).toBe('hunter2');
    expect(stored.url).toBe('https://github.com');
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
    expect(entry!.attachments).toEqual([attachment]);

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
    expect(store.items()[0].attachments).toEqual([attachment]);
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
    expect(edited.password).toBe('rotated-pw');
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

    await waitFor(() => store.items()[0]?.password === 'new-from-phone');
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
