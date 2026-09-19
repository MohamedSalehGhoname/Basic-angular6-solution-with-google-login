import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import sodium from 'libsodium-wrappers-sumo';
import { FakeSyncApi } from '../testing/fake-sync-api';
import { AuthService } from './auth.service';
import { ClipboardStore } from './clipboard-store';
import { type KdfParams } from './crypto.service';
import { SyncApi } from './sync-api';
import { VaultService } from './vault.service';

describe('ClipboardStore', () => {
  const user = signal<{ uid: string } | null>({ uid: 'test-uid' });
  let syncApi: FakeSyncApi;
  let store: ClipboardStore;
  let vault: VaultService;
  let fastKdf: KdfParams;

  const configure = () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { user } },
        { provide: SyncApi, useValue: syncApi },
      ],
    });
    store = TestBed.inject(ClipboardStore);
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

  it('adds items newest-first, round-trips them, and pushes them to the server', async () => {
    await store.add('first');
    await store.add('second');

    const items = store.items();
    expect(items.map((item) => item.text)).toEqual(['second', 'first']);
    expect(items[0].device).toBe('Web');
    expect(syncApi.items.size).toBe(2);
  });

  it('keeps new items forever by default', async () => {
    const entry = await store.add('keep me');
    expect(store.ttlMs()).toBeNull();
    expect(entry!.expiresAt).toBeNull();
  });

  it('picks up items that reached the server without a live event on refresh', async () => {
    await store.load();
    await store.add('mine');
    // Another device's write whose WebSocket event never arrived.
    const blob = await vault.encryptItem(
      JSON.stringify({ text: 'from phone', device: 'Phone', copiedAt: Date.now() + 1000, expiresAt: null }),
    );
    syncApi.items.set('remote-1', { blob, createdAt: Date.now() + 1000 });
    expect(store.items().map((item) => item.text)).toEqual(['mine']);

    await store.refresh();
    expect(store.items().map((item) => item.text)).toEqual(['from phone', 'mine']);
  });

  it('ignores empty input', async () => {
    expect(await store.add('   ')).toBeNull();
    expect(store.items()).toEqual([]);
  });

  it('adds and round-trips an image item', async () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KAAAA';
    const entry = await store.addImage(dataUrl, { device: 'Desktop' });
    expect(entry!.image).toBe(dataUrl);
    expect(entry!.device).toBe('Desktop');
    // Rejects non-image data and de-dupes the newest image.
    expect(await store.addImage('not-a-data-url')).toBeNull();
    expect(await store.addImage(dataUrl)).toBeNull();
    // Stored as ciphertext, not the raw data URL.
    for (const item of syncApi.items.values()) {
      expect(item.blob).not.toContain('iVBORw0K');
    }
  });

  it('stores only ciphertext locally and on the server', async () => {
    await store.add('super secret text');
    const raw = localStorage.getItem('clipsync.clipboard.test-uid')!;
    expect(raw).not.toContain('super secret');
    expect(raw).toContain('xcv1:');
    for (const item of syncApi.items.values()) {
      expect(item.blob.startsWith('xcv1:')).toBe(true);
      expect(item.blob).not.toContain('super secret');
    }
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

  it('falls back to the local mirror when the server is unreachable', async () => {
    await store.add('kept offline');

    TestBed.resetTestingModule();
    configure();
    syncApi.offline = true;
    await vault.unlock('a long passphrase');
    await store.load();

    expect(store.items().map((item) => item.text)).toEqual(['kept offline']);
    expect(store.online()).toBe(false);
  });

  it('pushes local-only items to the server on the next online load', async () => {
    syncApi.offline = true;
    const offlineItem = await store.add('made offline');
    expect(syncApi.items.size).toBe(0);

    // Another device added an item while this one was offline.
    syncApi.offline = false;
    const remoteBlob = await vault.encryptItem(
      JSON.stringify({ text: 'from another device', device: 'Phone', copiedAt: Date.now() + 1 }),
    );
    await syncApi.putItem('clipboard', 'remote-1', remoteBlob);

    TestBed.resetTestingModule();
    configure();
    await vault.unlock('a long passphrase');
    await store.load();

    expect(store.items().map((item) => item.text)).toEqual([
      'from another device',
      'made offline',
    ]);
    expect(syncApi.items.has(offlineItem!.id)).toBe(true);
    expect(store.online()).toBe(true);
  });

  it('applies live events from other devices', async () => {
    await store.load();
    expect(syncApi.connected).toBe(true);

    const blob = await vault.encryptItem(
      JSON.stringify({ text: 'pushed via ws', device: 'Phone', copiedAt: Date.now() }),
    );
    syncApi.emit({ type: 'item-added', collection: 'clipboard', item: { id: 'ws-1', blob, createdAt: 1 } });
    await waitFor(() => store.items().some((item) => item.id === 'ws-1'));
    expect(store.items()[0].text).toBe('pushed via ws');

    syncApi.emit({ type: 'item-removed', collection: 'clipboard', id: 'ws-1' });
    await waitFor(() => !store.items().some((item) => item.id === 'ws-1'));

    await store.add('to be cleared');
    syncApi.emit({ type: 'items-cleared', collection: 'clipboard' });
    await waitFor(() => store.items().length === 0);
  });

  it('removes a single item and clears the list everywhere', async () => {
    const kept = await store.add('keep me');
    const dropped = await store.add('drop me');

    store.remove(dropped!.id);
    expect(store.items().map((item) => item.id)).toEqual([kept!.id]);
    await waitFor(() => !syncApi.items.has(dropped!.id));

    store.clear();
    expect(store.items()).toEqual([]);
    expect(localStorage.getItem('clipsync.clipboard.test-uid')).toContain('"items":[]');
    await waitFor(() => syncApi.items.size === 0);
  });

  it('replays offline deletions on the next online load instead of resurrecting items', async () => {
    const doomed = await store.add('delete me offline');
    await store.add('keep me');
    expect(syncApi.items.size).toBe(2);

    syncApi.offline = true;
    store.remove(doomed!.id);
    await waitFor(() => store.online() === false);
    expect(syncApi.items.has(doomed!.id)).toBe(true);

    syncApi.offline = false;
    TestBed.resetTestingModule();
    configure();
    await vault.unlock('a long passphrase');
    await store.load();

    expect(store.items().map((item) => item.text)).toEqual(['keep me']);
    expect(syncApi.items.has(doomed!.id)).toBe(false);
    expect(store.online()).toBe(true);
    // Tombstone is consumed once replayed.
    expect(JSON.parse(localStorage.getItem('clipsync.clipboard.test-uid')!).deleted).toEqual([]);
  });

  it('does not resurrect items cleared while offline', async () => {
    await store.add('one');
    await store.add('two');
    expect(syncApi.items.size).toBe(2);

    syncApi.offline = true;
    store.clear();
    await waitFor(() => store.online() === false);
    expect(syncApi.items.size).toBe(2);

    syncApi.offline = false;
    TestBed.resetTestingModule();
    configure();
    await vault.unlock('a long passphrase');
    await store.load();

    expect(store.items()).toEqual([]);
    expect(syncApi.items.size).toBe(0);
  });

  it('ignores a live item-added event for a tombstoned id', async () => {
    const doomed = await store.add('delete me offline');
    const blob = syncApi.items.get(doomed!.id)!.blob;

    syncApi.offline = true;
    store.remove(doomed!.id);
    await waitFor(() => store.online() === false);

    await store.load();
    syncApi.emit({ type: 'item-added', collection: 'clipboard', item: { id: doomed!.id, blob, createdAt: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.items().some((item) => item.id === doomed!.id)).toBe(false);
  });

  it('skips blobs it cannot decrypt instead of failing the load', async () => {
    await store.add('good item');
    const key = 'clipsync.clipboard.test-uid';
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

  it('stamps new items with the configured TTL', async () => {
    store.setTtl(60 * 60 * 1000);
    const before = Date.now();
    const entry = await store.add('short-lived');
    expect(entry!.expiresAt).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);

    store.setTtl(null);
    const forever = await store.add('kept forever');
    expect(forever!.expiresAt).toBeNull();
  });

  it('drops expired items on load and deletes them from the server', async () => {
    const expiredBlob = await vault.encryptItem(
      JSON.stringify({ text: 'stale', device: 'Phone', copiedAt: 1, expiresAt: Date.now() - 1000 }),
    );
    await syncApi.putItem('clipboard', 'stale-1', expiredBlob);
    await store.add('still fresh');

    TestBed.resetTestingModule();
    configure();
    await vault.unlock('a long passphrase');
    await store.load();

    expect(store.items().map((item) => item.text)).toEqual(['still fresh']);
    await waitFor(() => !syncApi.items.has('stale-1'));
  });

  it('sweeps items that expire while the app is open', async () => {
    store.setTtl(1);
    await store.add('about to expire');
    await new Promise((resolve) => setTimeout(resolve, 10));

    store.sweepExpired();
    expect(store.items()).toEqual([]);
    await waitFor(() => syncApi.items.size === 0);
  });

  it('ignores live events for already-expired items', async () => {
    await store.load();
    const blob = await vault.encryptItem(
      JSON.stringify({ text: 'dead on arrival', device: 'Phone', copiedAt: 1, expiresAt: Date.now() - 1 }),
    );
    syncApi.emit({ type: 'item-added', collection: 'clipboard', item: { id: 'dead-1', blob, createdAt: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.items()).toEqual([]);
  });

  it('drops decrypted items from memory and disconnects when the vault locks', async () => {
    await store.load();
    await store.add('sensitive');
    vault.lock();
    await Promise.resolve();
    TestBed.tick();

    expect(store.items()).toEqual([]);
    expect(syncApi.connected).toBe(false);
  });
});
