import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileLinkService } from './file-link.service';
import { NativeBridge } from './native-bridge.service';
import { type ShareLink, SyncApi } from './sync-api';
import { syncConfig } from '../sync.config';

const file = { id: 'fil_1', name: 'tax return.pdf', size: 1000, key: 'a2V5LWJ5dGVzLWhlcmU=' };

const link = (over: Partial<ShareLink> = {}): ShareLink => ({
  token: 'a'.repeat(40),
  fileId: 'fil_1',
  createdAt: 1,
  expiresAt: 2,
  maxDownloads: 50,
  downloads: 0,
  ...over,
});

describe('FileLinkService', () => {
  let api: {
    createShare: ReturnType<typeof vi.fn>;
    listShares: ReturnType<typeof vi.fn>;
    revokeShare: ReturnType<typeof vi.fn>;
  };
  let native: { canShare: boolean; share: ReturnType<typeof vi.fn>; copy: ReturnType<typeof vi.fn> };
  let service: FileLinkService;

  beforeEach(() => {
    api = {
      createShare: vi.fn(async () => link()),
      listShares: vi.fn(async () => [link(), link({ token: 'b'.repeat(40), fileId: 'fil_2' })]),
      revokeShare: vi.fn(async () => undefined),
    };
    native = { canShare: false, share: vi.fn(), copy: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        { provide: SyncApi, useValue: api },
        { provide: NativeBridge, useValue: native },
      ],
    });
    service = TestBed.inject(FileLinkService);
  });

  it('puts the key and the name after the #, where no server sees them', async () => {
    const url = await service.create(file);
    const parsed = new URL(url);

    // The path and query are what the server receives: a token, nothing else.
    expect(parsed.pathname).toBe(`/s/${'a'.repeat(40)}`);
    expect(parsed.search).toBe('');
    expect(`${parsed.origin}${parsed.pathname}${parsed.search}`).not.toContain(file.key);
    expect(`${parsed.origin}${parsed.pathname}${parsed.search}`).not.toContain('tax');

    const fragment = new URLSearchParams(parsed.hash.slice(1));
    expect(fragment.get('k')).toBe(file.key);
    expect(fragment.get('n')).toBe('tax return.pdf');
  });

  it('points at the public site rather than wherever this build runs', async () => {
    const url = await service.create(file);
    expect(url.startsWith(syncConfig.shareBaseUrl)).toBe(true);
  });

  it('leaves the key out for a file that was sent unencrypted', async () => {
    const url = await service.create({ id: 'fil_1', name: 'plain.txt', size: 10 });
    expect(new URLSearchParams(new URL(url).hash.slice(1)).has('k')).toBe(false);
  });

  it('asks for a day and fifty downloads unless told otherwise', async () => {
    await service.create(file);
    expect(api.createShare).toHaveBeenCalledWith('fil_1', {
      expiresInMs: 24 * 60 * 60 * 1000,
      maxDownloads: 50,
    });

    await service.create(file, { expiresInMs: 60_000, maxDownloads: 1 });
    expect(api.createShare).toHaveBeenLastCalledWith('fil_1', {
      expiresInMs: 60_000,
      maxDownloads: 1,
    });
  });

  it('marks which files have a live link, and unmarks a revoked one', async () => {
    await service.refresh();
    expect([...service.sharedFileIds()].sort()).toEqual(['fil_1', 'fil_2']);

    await service.revoke('a'.repeat(40));
    expect(api.revokeShare).toHaveBeenCalledWith('a'.repeat(40));
    expect([...service.sharedFileIds()]).toEqual(['fil_2']);
    expect(service.links()).toHaveLength(1);
  });

  it('uses the share sheet when there is one, and the clipboard otherwise', async () => {
    expect(await service.send('https://example.test/s/x')).toBe('copied');
    expect(native.copy).toHaveBeenCalledWith('https://example.test/s/x');

    native.canShare = true;
    expect(await service.send('https://example.test/s/x')).toBe('shared');
    expect(native.share).toHaveBeenCalledWith('https://example.test/s/x');
  });
});
