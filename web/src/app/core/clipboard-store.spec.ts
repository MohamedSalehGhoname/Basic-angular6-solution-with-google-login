import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import sodium from 'libsodium-wrappers-sumo';
import { AuthService } from './auth.service';
import { ClipboardStore } from './clipboard-store';
import { type KdfParams } from './crypto.service';
import { VaultService } from './vault.service';

describe('ClipboardStore', () => {
  const user = signal<{ uid: string } | null>({ uid: 'test-uid' });
  let store: ClipboardStore;
  let vault: VaultService;
  let fastKdf: KdfParams;

  const configure = () => {
    TestBed.configureTestingModule({
      providers: [{ provide: AuthService, useValue: { user } }],
    });
    store = TestBed.inject(ClipboardStore);
    vault = TestBed.inject(VaultService);
  };

  beforeEach(async () => {
    localStorage.clear();
    user.set({ uid: 'test-uid' });
    configure();
    await sodium.ready;
    fastKdf = {
      opsLimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      memLimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    };
    await vault.createVault('a long passphrase', fastKdf);
  });

  it('adds items newest-first and round-trips them', async () => {
    await store.add('first');
    await store.add('second');

    const items = store.items();
    expect(items.map((item) => item.text)).toEqual(['second', 'first']);
    expect(items[0].device).toBe('Web');
  });

  it('ignores empty input', async () => {
    expect(await store.add('   ')).toBeNull();
    expect(store.items()).toEqual([]);
  });

  it('stores only ciphertext on disk', async () => {
    await store.add('super secret text');
    const raw = localStorage.getItem('clipsync.items.test-uid')!;
    expect(raw).not.toContain('super secret');
    expect(raw).toContain('xcv1:');
  });

  it('reloads persisted items after unlock in a fresh injector', async () => {
    await store.add('persisted');

    TestBed.resetTestingModule();
    configure();
    await vault.unlock('a long passphrase');
    await store.load();

    expect(store.items().map((item) => item.text)).toEqual(['persisted']);
    expect(store.skipped()).toBe(0);
  });

  it('removes a single item and clears the list', async () => {
    const kept = await store.add('keep me');
    const dropped = await store.add('drop me');

    store.remove(dropped!.id);
    expect(store.items().map((item) => item.id)).toEqual([kept!.id]);

    store.clear();
    expect(store.items()).toEqual([]);
    expect(localStorage.getItem('clipsync.items.test-uid')).toContain('"items":[]');
  });

  it('skips blobs it cannot decrypt instead of failing the load', async () => {
    await store.add('good item');
    const key = 'clipsync.items.test-uid';
    const stored = JSON.parse(localStorage.getItem(key)!);
    stored.items.push({ id: 'bad', blob: 'xcv1:not-really-ciphertext' });
    localStorage.setItem(key, JSON.stringify(stored));

    TestBed.resetTestingModule();
    configure();
    await vault.unlock('a long passphrase');
    await store.load();

    expect(store.items().map((item) => item.text)).toEqual(['good item']);
    expect(store.skipped()).toBe(1);
  });

  it('drops decrypted items from memory when the vault locks', async () => {
    await store.add('sensitive');
    vault.lock();
    await Promise.resolve();
    TestBed.tick();

    expect(store.items()).toEqual([]);
  });
});
