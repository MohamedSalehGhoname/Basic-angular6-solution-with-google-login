import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import type { FileStore } from '../src/gtdrive.js';

const verifyToken = async (token: string) => {
  const match = /^token-(\w+)$/.exec(token);
  if (!match) {
    throw new Error('bad token');
  }
  return { uid: match[1]! };
};
const auth = (uid: string) => ({ authorization: `Bearer token-${uid}` });

function fakeStore() {
  let next = 1;
  const store: FileStore = {
    create: async () => ({
      fileId: `fil_${next++}`,
      uploadUrl: 'https://storage.example/put',
      uploadExpiresAt: '2026-01-01T00:00:00Z',
    }),
    confirm: async (fileId) => ({ fileId, sizeBytes: 42, expiresAt: '2026-01-08T00:00:00Z' }),
    downloadUrl: async () => ({
      downloadUrl: 'https://storage.example/get',
      expiresAt: '2026-01-01T00:15:00Z',
    }),
  };
  return store;
}

describe('public share links', () => {
  let app: App;

  beforeEach(() => {
    app = buildApp({ dbPath: ':memory:', verifyToken, files: fakeStore() });
    // The public content route streams whatever storage returns.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob(['ciphertext-bytes']), { status: 200 })),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.fastify.close();
  });

  const ownFile = async (uid = 'alice') => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/files',
      headers: auth(uid),
      payload: { sizeBytes: 100, encrypted: true },
    });
    return res.json().fileId as string;
  };

  const share = (fileId: string, uid = 'alice', payload: object = {}) =>
    app.fastify.inject({
      method: 'POST',
      url: `/api/files/${fileId}/share`,
      headers: auth(uid),
      payload,
    });

  it('creates a link that lasts a day and fifty downloads by default', async () => {
    const before = Date.now();
    const res = await share(await ownFile());
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toMatch(/^[a-f0-9]{40}$/);
    expect(body.maxDownloads).toBe(50);
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
    expect(body.expiresAt).toBeLessThan(before + 25 * 60 * 60 * 1000);
  });

  it('will not share somebody else’s file', async () => {
    const fileId = await ownFile('alice');
    expect((await share(fileId, 'mallory')).statusCode).toBe(404);
  });

  it('serves the file to whoever holds the link, with no account at all', async () => {
    const { token } = (await share(await ownFile())).json();

    const meta = await app.fastify.inject({ method: 'GET', url: `/api/public/shares/${token}` });
    expect(meta.statusCode).toBe(200);
    // Size and limits, and nothing that says what the file is.
    expect(meta.json()).toMatchObject({ sizeBytes: 100, downloadsLeft: 50 });
    expect(JSON.stringify(meta.json())).not.toContain('name');

    const content = await app.fastify.inject({
      method: 'GET',
      url: `/api/public/shares/${token}/content`,
    });
    expect(content.statusCode).toBe(200);
    expect(content.headers['x-robots-tag']).toContain('noindex');
    expect(content.body).toBe('ciphertext-bytes');
  });

  it('counts every download and stops at the limit', async () => {
    const { token } = (await share(await ownFile(), 'alice', { maxDownloads: 2 })).json();
    const get = () =>
      app.fastify.inject({ method: 'GET', url: `/api/public/shares/${token}/content` });

    expect((await get()).statusCode).toBe(200);
    expect((await get()).statusCode).toBe(200);
    // The third asks for a slot that is not there.
    expect((await get()).statusCode).toBe(404);
    const meta = await app.fastify.inject({ method: 'GET', url: `/api/public/shares/${token}` });
    expect(meta.statusCode).toBe(404);
  });

  it('stops serving once the link has expired', async () => {
    const { token } = (await share(await ownFile(), 'alice', { expiresInMs: 60_000 })).json();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 61_000);
      expect(
        (await app.fastify.inject({ method: 'GET', url: `/api/public/shares/${token}` })).statusCode,
      ).toBe(404);
      expect(
        (await app.fastify.inject({ method: 'GET', url: `/api/public/shares/${token}/content` }))
          .statusCode,
      ).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists the owner’s links and revokes one on request', async () => {
    const { token } = (await share(await ownFile())).json();
    const list = await app.fastify.inject({ method: 'GET', url: '/api/shares', headers: auth('alice') });
    expect(list.json().shares).toHaveLength(1);
    // Someone else's list is their own.
    const theirs = await app.fastify.inject({ method: 'GET', url: '/api/shares', headers: auth('bob') });
    expect(theirs.json().shares).toHaveLength(0);

    // And only the owner can pull the link down.
    const notYours = await app.fastify.inject({
      method: 'DELETE',
      url: `/api/shares/${token}`,
      headers: auth('bob'),
    });
    expect(notYours.statusCode).toBe(404);

    const revoked = await app.fastify.inject({
      method: 'DELETE',
      url: `/api/shares/${token}`,
      headers: auth('alice'),
    });
    expect(revoked.statusCode).toBe(204);
    expect(
      (await app.fastify.inject({ method: 'GET', url: `/api/public/shares/${token}/content` }))
        .statusCode,
    ).toBe(404);
  });

  it('refuses a token that was never issued', async () => {
    const res = await app.fastify.inject({
      method: 'GET',
      url: `/api/public/shares/${'0'.repeat(40)}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('needs no access key or sign-in on the recipient side', async () => {
    const guarded = buildApp({
      dbPath: ':memory:',
      verifyToken,
      files: fakeStore(),
      accessKey: 'let-me-in',
    });
    try {
      const created = await guarded.fastify.inject({
        method: 'POST',
        url: '/api/files',
        headers: { ...auth('alice'), 'x-access-key': 'let-me-in' },
        payload: { sizeBytes: 10, encrypted: true },
      });
      const { token } = (
        await guarded.fastify.inject({
          method: 'POST',
          url: `/api/files/${created.json().fileId}/share`,
          headers: { ...auth('alice'), 'x-access-key': 'let-me-in' },
          payload: {},
        })
      ).json();
      // The recipient has neither the key nor an account.
      const meta = await guarded.fastify.inject({
        method: 'GET',
        url: `/api/public/shares/${token}`,
      });
      expect(meta.statusCode).toBe(200);
    } finally {
      await guarded.fastify.close();
    }
  });
});
