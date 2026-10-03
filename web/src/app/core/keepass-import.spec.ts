import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import sodium from 'libsodium-wrappers-sumo';
import { FakeSyncApi } from '../testing/fake-sync-api';
import { AuthService } from './auth.service';
import { GroupsStore } from './groups-store';
import { importKeePass, parseKeePassXml } from './keepass-import';
import { SecretsStore } from './secrets-store';
import { SyncApi } from './sync-api';
import { VaultService } from './vault.service';

const entry = (fields: Record<string, string>, extra = '') => `
  <Entry>
    <UUID>AAAA</UUID><IconID>0</IconID>
    ${Object.entries(fields)
      .map(([k, v]) => `<String><Key>${k}</Key><Value ProtectInMemory="True">${v}</Value></String>`)
      .join('')}
    ${extra}
  </Entry>`;

// Shaped like a KeePass 2.x "KeePass XML (2.x)" export.
const XML = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<KeePassFile>
  <Meta>
    <Generator>KeePass</Generator>
    <RecycleBinEnabled>True</RecycleBinEnabled>
    <RecycleBinUUID>BIN=</RecycleBinUUID>
  </Meta>
  <Root>
    <Group>
      <UUID>ROOT=</UUID><Name>Database</Name><IconID>49</IconID>
      ${entry({ Title: 'Wi-Fi', UserName: '', Password: 'home-wifi', URL: '', Notes: '' })}
      <Group>
        <UUID>G1=</UUID><Name>Windows</Name><IconID>38</IconID>
        ${entry({ Title: 'Laptop', UserName: 'me', Password: 'p1', URL: '', Notes: 'office' })}
      </Group>
      <Group>
        <UUID>G2=</UUID><Name>Hosting</Name><IconID>48</IconID>
        <Group>
          <UUID>G3=</UUID><Name>CloudFlare</Name><IconID>48</IconID>
          ${entry(
            { Title: 'CF', UserName: 'owner@x.com', Password: 'new-pass', URL: 'https://dash.cloudflare.com', Notes: '', 'API Token': 'tok_123' },
            `<Binary><Key>backup-codes.txt</Key><Value Ref="0" /></Binary>
             <History>
               ${entry({ Title: 'CF', UserName: 'owner@x.com', Password: 'OLD-pass', URL: '', Notes: '' })}
             </History>`,
          )}
        </Group>
        <Group>
          <UUID>G4=</UUID><Name>contabo</Name><IconID>48</IconID>
          ${entry({ Title: '', UserName: 'root', Password: 'vps', URL: 'https://my.contabo.com', Notes: '' })}
        </Group>
      </Group>
      <Group>
        <UUID>BIN=</UUID><Name>Recycle Bin</Name><IconID>43</IconID>
        ${entry({ Title: 'Deleted thing', UserName: '', Password: 'gone', URL: '', Notes: '' })}
      </Group>
    </Group>
    <DeletedObjects />
  </Root>
</KeePassFile>`;

describe('KeePass import', () => {
  it('parses groups and entries, skipping the Recycle Bin and old versions', () => {
    const parsed = parseKeePassXml(XML);
    expect(parsed.groupCount).toBe(4);
    expect(parsed.entryCount).toBe(4);
    expect(parsed.withAttachments).toBe(1);

    const root = parsed.root;
    expect(root.entries.map((e) => e.title)).toEqual(['Wi-Fi']);
    expect(root.children.map((g) => [g.name, g.icon])).toEqual([
      ['Windows', '🪟'],
      ['Hosting', '📁'],
    ]);
    const cf = root.children[1]!.children[0]!.entries[0]!;
    expect(cf.password).toBe('new-pass');
    expect(cf.notes).toBe('API Token: tok_123');
    // An entry with no title falls back to its URL.
    expect(root.children[1]!.children[1]!.entries[0]!.title).toBe('https://my.contabo.com');
    expect(JSON.stringify(parsed)).not.toContain('OLD-pass');
    expect(JSON.stringify(parsed)).not.toContain('Deleted thing');
  });

  it('rejects files that are not KeePass XML', () => {
    expect(() => parseKeePassXml('<html><body>hi</body></html>')).toThrow('not-keepass');
    expect(() => parseKeePassXml('Account,Login Name,Password')).toThrow('not-keepass');
  });

  describe('into the vault', () => {
    const user = signal<{ uid: string } | null>({ uid: 'test-uid' });
    let groups: GroupsStore;
    let secrets: SecretsStore;
    let syncApi: FakeSyncApi;

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

    it('recreates the tree, files entries in their groups, and stores only ciphertext', async () => {
      const progress: number[] = [];
      const result = await importKeePass(parseKeePassXml(XML), groups, secrets, (done) =>
        progress.push(done),
      );
      expect(result).toEqual({ groupsCreated: 4, groupsReused: 0, entriesAdded: 4, duplicatesSkipped: 0 });
      expect(progress.at(-1)).toBe(8);

      expect(groups.flat().map((node) => `${'-'.repeat(node.depth)}${node.group.name}`)).toEqual([
        'Hosting',
        '-CloudFlare',
        '-contabo',
        'Windows',
      ]);
      const cf = secrets.items().find((s) => s.title === 'CF')!;
      expect(groups.path(cf.groupId)).toBe('Hosting › CloudFlare');
      expect(secrets.items().find((s) => s.title === 'Wi-Fi')!.groupId).toBeNull();

      const stored = JSON.stringify([...syncApi.collections.values()].map((c) => [...c.values()]));
      expect(stored).not.toContain('new-pass');
      expect(stored).not.toContain('CloudFlare');
    });

    it('does not duplicate anything when the same file is imported again', async () => {
      await importKeePass(parseKeePassXml(XML), groups, secrets);
      const again = await importKeePass(parseKeePassXml(XML), groups, secrets);
      expect(again).toEqual({ groupsCreated: 0, groupsReused: 4, entriesAdded: 0, duplicatesSkipped: 4 });
      expect(groups.items()).toHaveLength(4);
      expect(secrets.items()).toHaveLength(4);
    });

    it('merges into a group that already exists with the same name', async () => {
      const hosting = (await groups.addGroup('hosting', null, '☁️'))!;
      await importKeePass(parseKeePassXml(XML), groups, secrets);
      expect(groups.items().filter((g) => g.name.toLowerCase() === 'hosting')).toHaveLength(1);
      expect(groups.items().find((g) => g.name === 'CloudFlare')!.parentId).toBe(hosting.id);
    });
  });
});
