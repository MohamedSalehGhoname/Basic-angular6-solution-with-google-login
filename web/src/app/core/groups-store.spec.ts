import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import sodium from 'libsodium-wrappers-sumo';
import { FakeSyncApi } from '../testing/fake-sync-api';
import { AuthService } from './auth.service';
import { GroupsStore } from './groups-store';
import { SecretsStore } from './secrets-store';
import { SyncApi } from './sync-api';
import { VaultService } from './vault.service';

describe('GroupsStore', () => {
  const user = signal<{ uid: string } | null>({ uid: 'test-uid' });
  let syncApi: FakeSyncApi;
  let groups: GroupsStore;
  let secrets: SecretsStore;

  beforeEach(async () => {
    localStorage.clear();
    syncApi = new FakeSyncApi();
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { user } },
        { provide: SyncApi, useValue: syncApi },
      ],
    });
    groups = TestBed.inject(GroupsStore);
    secrets = TestBed.inject(SecretsStore);
    await sodium.ready;
    await TestBed.inject(VaultService).createVault('a long passphrase', {
      opsLimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      memLimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    });
    await Promise.all([groups.load(), secrets.load()]);
  });

  it('builds a nested, alphabetical tree like the KeePass sidebar', async () => {
    const hosting = (await groups.addGroup('Hosting', null, '☁️'))!;
    await groups.addGroup('Zoom', hosting.id);
    await groups.addGroup('CloudFlare', hosting.id);
    await groups.addGroup('eMail', null, '✉️');

    const tree = groups.tree();
    expect(tree.map((node) => node.group.name)).toEqual(['eMail', 'Hosting']);
    expect(tree[1]!.children.map((node) => node.group.name)).toEqual(['CloudFlare', 'Zoom']);
    expect(tree[1]!.children[0]!.depth).toBe(1);
    expect(groups.flat().map((node) => node.group.name)).toEqual([
      'eMail',
      'Hosting',
      'CloudFlare',
      'Zoom',
    ]);
    expect(groups.path(tree[1]!.children[0]!.group.id)).toBe('Hosting › CloudFlare');
  });

  it('keeps groups encrypted on the server', async () => {
    await groups.addGroup('Homebanking', null, '🏦');
    const blobs = [...(syncApi.collections.get('groups')?.values() ?? [])].map((item) => item.blob);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]).toMatch(/^xcv1:/);
    expect(blobs[0]).not.toContain('Homebanking');
  });

  it('refuses to move a group inside itself or its descendants', async () => {
    const a = (await groups.addGroup('A', null))!;
    const b = (await groups.addGroup('B', a.id))!;
    await groups.saveGroup(a.id, { name: 'A', icon: '📁', parentId: b.id });
    expect(groups.byId(a.id)!.parentId).toBeNull();
    expect([...groups.descendantsOf(a.id)].sort()).toEqual([a.id, b.id].sort());
  });

  it('shows a group whose parent vanished at the top level', async () => {
    const parent = (await groups.addGroup('Parent', null))!;
    const child = (await groups.addGroup('Child', parent.id))!;
    groups.remove(parent.id);
    expect(groups.tree().map((node) => node.group.id)).toEqual([child.id]);
  });

  it('moves a secret between groups without touching its fields', async () => {
    const tools = (await groups.addGroup('Tools', null))!;
    const entry = (await secrets.add({
      title: 'Router',
      username: 'admin',
      password: 'pw',
      url: '',
      notes: 'n',
      attachments: [],
    }))!;
    expect(entry.groupId).toBeNull();

    await secrets.move(entry.id, tools.id);
    const moved = secrets.items().find((item) => item.id === entry.id)!;
    expect(moved.groupId).toBe(tools.id);
    expect(moved).toMatchObject({ title: 'Router', username: 'admin', password: 'pw', notes: 'n' });
    expect(moved.createdAt).toBe(entry.createdAt);
  });
});
