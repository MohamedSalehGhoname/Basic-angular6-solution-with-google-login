import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { firstMatching, insecureDevVerifier } from '../src/auth.js';

// Stub verifier: tokens look like "token-<uid>".
const verifyToken = async (token: string) => {
  const match = /^token-(\w+)$/.exec(token);
  if (!match) {
    throw new Error('bad token');
  }
  return { uid: match[1]! };
};

const auth = (uid: string) => ({ authorization: `Bearer token-${uid}` });
const blob = (suffix: string) => `xcv1:${suffix}`;

describe('sync API', () => {
  let app: App;

  beforeEach(() => {
    app = buildApp({ dbPath: ':memory:', verifyToken, maxItems: 3 });
  });

  afterEach(async () => {
    await app.fastify.close();
  });

  it('responds on the health check without auth', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('allows the write methods and headers the browser preflights', async () => {
    const res = await app.fastify.inject({
      method: 'OPTIONS',
      url: '/api/clipboard/items/abc',
      // preflight path is illustrative; any item route shares the CORS config
      headers: {
        origin: 'http://localhost:4200',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'authorization,content-type,x-client-id',
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    const allowMethods = res.headers['access-control-allow-methods'] as string;
    expect(allowMethods).toContain('PUT');
    expect(allowMethods).toContain('DELETE');
    const allowHeaders = res.headers['access-control-allow-headers'] as string;
    expect(allowHeaders.toLowerCase()).toContain('x-client-id');
  });

  it('rejects missing and invalid tokens', async () => {
    const missing = await app.fastify.inject({ method: 'GET', url: '/api/clipboard/items' });
    expect(missing.statusCode).toBe(401);

    const invalid = await app.fastify.inject({
      method: 'GET',
      url: '/api/clipboard/items',
      headers: { authorization: 'Bearer nope!' },
    });
    expect(invalid.statusCode).toBe(401);
  });

  it('round-trips the vault record', async () => {
    const before = await app.fastify.inject({
      method: 'GET',
      url: '/api/vault',
      headers: auth('alice'),
    });
    expect(before.statusCode).toBe(404);

    const put = await app.fastify.inject({
      method: 'PUT',
      url: '/api/vault',
      headers: auth('alice'),
      payload: { salt: 'c2FsdA', opsLimit: 3, memLimit: 268435456, wrappedKey: blob('wrapped') },
    });
    expect(put.statusCode).toBe(204);

    const after = await app.fastify.inject({
      method: 'GET',
      url: '/api/vault',
      headers: auth('alice'),
    });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject({
      salt: 'c2FsdA',
      opsLimit: 3,
      memLimit: 268435456,
      wrappedKey: blob('wrapped'),
    });
  });

  it('round-trips a vault record with a recovery blob', async () => {
    const put = await app.fastify.inject({
      method: 'PUT',
      url: '/api/vault',
      headers: auth('alice'),
      payload: {
        salt: 'c2FsdA',
        opsLimit: 3,
        memLimit: 268435456,
        wrappedKey: blob('wrapped'),
        recovery: {
          salt: 'cmVjb3Zlcg',
          opsLimit: 3,
          memLimit: 268435456,
          wrappedKey: blob('recoverywrap'),
        },
      },
    });
    expect(put.statusCode).toBe(204);

    const after = await app.fastify.inject({
      method: 'GET',
      url: '/api/vault',
      headers: auth('alice'),
    });
    expect(after.json().recovery).toMatchObject({
      salt: 'cmVjb3Zlcg',
      wrappedKey: blob('recoverywrap'),
    });
  });

  it('rejects payloads that are not ciphertext-shaped', async () => {
    const badVault = await app.fastify.inject({
      method: 'PUT',
      url: '/api/vault',
      headers: auth('alice'),
      payload: { salt: 'c2FsdA', opsLimit: 3, memLimit: 1, wrappedKey: 'plaintext-key' },
    });
    expect(badVault.statusCode).toBe(400);

    const badItem = await app.fastify.inject({
      method: 'PUT',
      url: '/api/clipboard/items/a1',
      headers: auth('alice'),
      payload: { blob: 'not encrypted at all' },
    });
    expect(badItem.statusCode).toBe(400);
  });

  it('stores, lists, deletes, and clears items', async () => {
    for (const [id, suffix] of [
      ['a1', 'first'],
      ['a2', 'second'],
    ] as const) {
      const res = await app.fastify.inject({
        method: 'PUT',
        url: `/api/clipboard/items/${id}`,
        headers: auth('alice'),
        payload: { blob: blob(suffix) },
      });
      expect(res.statusCode).toBe(204);
    }

    const list = await app.fastify.inject({
      method: 'GET',
      url: '/api/clipboard/items',
      headers: auth('alice'),
    });
    const ids = list.json().items.map((item: { id: string }) => item.id);
    expect(ids).toContain('a1');
    expect(ids).toContain('a2');

    await app.fastify.inject({
      method: 'DELETE',
      url: '/api/clipboard/items/a1',
      headers: auth('alice'),
    });
    const afterDelete = await app.fastify.inject({
      method: 'GET',
      url: '/api/clipboard/items',
      headers: auth('alice'),
    });
    expect(afterDelete.json().items.map((item: { id: string }) => item.id)).toEqual(['a2']);

    await app.fastify.inject({ method: 'DELETE', url: '/api/clipboard/items', headers: auth('alice') });
    const afterClear = await app.fastify.inject({
      method: 'GET',
      url: '/api/clipboard/items',
      headers: auth('alice'),
    });
    expect(afterClear.json().items).toEqual([]);
  });

  it('caps history at maxItems, dropping the oldest', async () => {
    for (let i = 1; i <= 5; i++) {
      await app.fastify.inject({
        method: 'PUT',
        url: `/api/clipboard/items/item${i}`,
        headers: auth('alice'),
        payload: { blob: blob(`payload${i}`) },
      });
      // created_at has millisecond resolution; keep insert order unambiguous.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const list = await app.fastify.inject({
      method: 'GET',
      url: '/api/clipboard/items',
      headers: auth('alice'),
    });
    expect(list.json().items.map((item: { id: string }) => item.id)).toEqual([
      'item5',
      'item4',
      'item3',
    ]);
  });

  it('never trims secrets or groups by the clipboard history cap', async () => {
    for (const collection of ['secrets', 'groups']) {
      for (let i = 1; i <= 5; i++) {
        await app.fastify.inject({
          method: 'PUT',
          url: `/api/${collection}/items/item${i}`,
          headers: auth('alice'),
          payload: { blob: blob(`payload${i}`) },
        });
      }
      const list = await app.fastify.inject({
        method: 'GET',
        url: `/api/${collection}/items`,
        headers: auth('alice'),
      });
      expect(list.json().items).toHaveLength(5);
    }
  });

  it('isolates users from each other', async () => {
    await app.fastify.inject({
      method: 'PUT',
      url: '/api/clipboard/items/a1',
      headers: auth('alice'),
      payload: { blob: blob('alicedata') },
    });

    const bob = await app.fastify.inject({
      method: 'GET',
      url: '/api/clipboard/items',
      headers: auth('bob'),
    });
    expect(bob.json().items).toEqual([]);
  });

  it('keeps collections separate and rejects unknown ones', async () => {
    await app.fastify.inject({
      method: 'PUT',
      url: '/api/clipboard/items/c1',
      headers: auth('alice'),
      payload: { blob: blob('clip') },
    });
    await app.fastify.inject({
      method: 'PUT',
      url: '/api/secrets/items/s1',
      headers: auth('alice'),
      payload: { blob: blob('secret') },
    });

    const clip = await app.fastify.inject({
      method: 'GET',
      url: '/api/clipboard/items',
      headers: auth('alice'),
    });
    const secrets = await app.fastify.inject({
      method: 'GET',
      url: '/api/secrets/items',
      headers: auth('alice'),
    });
    expect(clip.json().items.map((i: { id: string }) => i.id)).toEqual(['c1']);
    expect(secrets.json().items.map((i: { id: string }) => i.id)).toEqual(['s1']);

    const unknown = await app.fastify.inject({
      method: 'GET',
      url: '/api/passwords/items',
      headers: auth('alice'),
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('preserves an item timestamp across updates so edits do not reorder', async () => {
    await app.fastify.inject({
      method: 'PUT',
      url: '/api/secrets/items/s1',
      headers: auth('alice'),
      payload: { blob: blob('v1') },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await app.fastify.inject({
      method: 'PUT',
      url: '/api/secrets/items/s2',
      headers: auth('alice'),
      payload: { blob: blob('v2') },
    });
    // Edit the older entry; it must keep its place, not jump to the top.
    await app.fastify.inject({
      method: 'PUT',
      url: '/api/secrets/items/s1',
      headers: auth('alice'),
      payload: { blob: blob('v1-edited') },
    });

    const list = await app.fastify.inject({
      method: 'GET',
      url: '/api/secrets/items',
      headers: auth('alice'),
    });
    expect(list.json().items.map((i: { id: string }) => i.id)).toEqual(['s2', 's1']);
  });
});

describe('vault key check', () => {
  let app: App;

  beforeEach(() => {
    app = buildApp({ dbPath: ':memory:', verifyToken });
  });

  afterEach(async () => {
    await app.fastify.close();
  });

  it('stores and returns it, and survives a vault without one', async () => {
    const put = (body: object) =>
      app.fastify.inject({ method: 'PUT', url: '/api/vault', headers: auth('alice'), payload: body });
    const base = { salt: 'c2FsdA', opsLimit: 2, memLimit: 1024, wrappedKey: blob('wrapped') };

    expect((await put({ ...base, keyCheck: blob('check') })).statusCode).toBe(204);
    const withCheck = await app.fastify.inject({
      method: 'GET',
      url: '/api/vault',
      headers: auth('alice'),
    });
    expect(withCheck.json().keyCheck).toBe(blob('check'));

    // A client that does not send one leaves the record without it.
    expect((await put(base)).statusCode).toBe(204);
    const without = await app.fastify.inject({
      method: 'GET',
      url: '/api/vault',
      headers: auth('alice'),
    });
    expect(without.json().keyCheck).toBeUndefined();
  });

  it('rejects a key check that is not ciphertext', async () => {
    const res = await app.fastify.inject({
      method: 'PUT',
      url: '/api/vault',
      headers: auth('alice'),
      payload: {
        salt: 'c2FsdA',
        opsLimit: 2,
        memLimit: 1024,
        wrappedKey: blob('wrapped'),
        keyCheck: 'plaintext',
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('mixed sign-in during the changeover', () => {
  const real = async (token: string) => {
    if (token !== 'google-token') {
      throw new Error('not a Google token');
    }
    return { uid: 'firebase-uid-1' };
  };

  it('accepts real tokens and maps the dev identity onto the same account', async () => {
    const app = buildApp({
      dbPath: ':memory:',
      verifyToken: firstMatching(real, insecureDevVerifier('firebase-uid-1')),
    });
    const put = (token: string, id: string) =>
      app.fastify.inject({
        method: 'PUT',
        url: `/api/clipboard/items/${id}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { blob: blob(id) },
      });

    expect((await put('google-token', 'from-web')).statusCode).toBe(204);
    expect((await put('local-dev-user', 'from-phone')).statusCode).toBe(204);

    // Both clients see one vault, not two.
    const list = await app.fastify.inject({
      method: 'GET',
      url: '/api/clipboard/items',
      headers: { authorization: 'Bearer google-token' },
    });
    expect(list.json().items.map((item: { id: string }) => item.id).sort()).toEqual([
      'from-phone',
      'from-web',
    ]);
    await app.fastify.close();
  });

  it('still rejects a token no verifier accepts', async () => {
    const app = buildApp({ dbPath: ':memory:', verifyToken: firstMatching(real) });
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/clipboard/items',
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.statusCode).toBe(401);
    await app.fastify.close();
  });
});

describe('requests that declare JSON but send no body', () => {
  let app: App;

  beforeEach(async () => {
    app = buildApp({ dbPath: ':memory:', verifyToken });
    await app.fastify.inject({
      method: 'PUT',
      url: '/api/clipboard/items/doomed',
      headers: { ...auth('alice'), 'content-type': 'application/json' },
      payload: { blob: blob('doomed') },
    });
  });

  afterEach(async () => {
    await app.fastify.close();
  });

  // Every client sets content-type on all requests; the default parser
  // rejects that with 400 when there is no body, which silently broke every
  // delete (the item vanished locally and came back on the next load).
  it('deletes an item anyway', async () => {
    const res = await app.fastify.inject({
      method: 'DELETE',
      url: '/api/clipboard/items/doomed',
      headers: { ...auth('alice'), 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(204);
    const list = await app.fastify.inject({
      method: 'GET',
      url: '/api/clipboard/items',
      headers: auth('alice'),
    });
    expect(list.json().items).toEqual([]);
  });

  it('clears a collection anyway', async () => {
    const res = await app.fastify.inject({
      method: 'DELETE',
      url: '/api/clipboard/items',
      headers: { ...auth('alice'), 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(204);
  });

  it('still rejects a body that is not valid JSON', async () => {
    const res = await app.fastify.inject({
      method: 'PUT',
      url: '/api/clipboard/items/broken',
      headers: { ...auth('alice'), 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
  });
});
