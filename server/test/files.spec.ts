import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { FileStoreError, gtdriveFileStore, type FileStore } from '../src/gtdrive.js';

const verifyToken = async (token: string) => {
  const match = /^token-(\w+)$/.exec(token);
  if (!match) {
    throw new Error('bad token');
  }
  return { uid: match[1]! };
};
const auth = (uid: string) => ({ authorization: `Bearer token-${uid}` });

/** In-memory stand-in for GTDrive's files API. */
function fakeStore() {
  const created: { fileName: string; path: string; sizeBytes: number }[] = [];
  let next = 1;
  const store: FileStore = {
    create: async (input) => {
      created.push(input);
      return {
        fileId: `fil_${next++}`,
        uploadUrl: 'https://storage.example/put',
        uploadExpiresAt: '2026-01-01T00:00:00Z',
      };
    },
    confirm: async (fileId) => ({ fileId, sizeBytes: 42, expiresAt: '2026-01-08T00:00:00Z' }),
    downloadUrl: async () => ({
      downloadUrl: 'https://storage.example/get',
      expiresAt: '2026-01-01T00:15:00Z',
    }),
  };
  return { store, created };
}

describe('file routes', () => {
  let app: App;
  let fake: ReturnType<typeof fakeStore>;

  beforeEach(() => {
    fake = fakeStore();
    app = buildApp({ dbPath: ':memory:', verifyToken, files: fake.store });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.fastify.close();
  });

  const createFile = (uid: string, body: object) =>
    app.fastify.inject({ method: 'POST', url: '/api/files', headers: auth(uid), payload: body });

  it('gives an encrypted file a random storage name under an opaque per-user folder', async () => {
    const res = await createFile('alice', { sizeBytes: 100, encrypted: true, name: 'tax.pdf' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ fileId: 'fil_1', uploadUrl: 'https://storage.example/put' });
    const [sent] = fake.created;
    expect(sent!.fileName).toMatch(/^[0-9a-f]{32}\.bin$/);
    expect(sent!.fileName).not.toContain('tax');
    expect(sent!.path).toMatch(/^u\/[0-9a-f]{24}$/);
    expect(sent!.path).not.toContain('alice');
    expect(sent!.sizeBytes).toBe(100);
  });

  it('keeps a readable, storage-safe name for a file sent as-is', async () => {
    await createFile('alice', { sizeBytes: 5, encrypted: false, name: 'تقرير final (v2).pdf' });
    expect(fake.created[0]!.fileName).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(fake.created[0]!.fileName.endsWith('final_v2_.pdf')).toBe(true);
  });

  it('separates users into different folders', async () => {
    await createFile('alice', { sizeBytes: 1, encrypted: true });
    await createFile('bob', { sizeBytes: 1, encrypted: true });
    expect(fake.created[0]!.path).not.toBe(fake.created[1]!.path);
  });

  it('rejects files that are empty or over the storage limit', async () => {
    expect((await createFile('alice', { sizeBytes: 0, encrypted: true })).statusCode).toBe(400);
    const tooBig = await createFile('alice', { sizeBytes: 5 * 1024 ** 3 + 1, encrypted: true });
    expect(tooBig.statusCode).toBe(400);
  });

  it('confirms and hands out download links only to the owner', async () => {
    await createFile('alice', { sizeBytes: 42, encrypted: true });

    const confirm = (uid: string) =>
      app.fastify.inject({
        method: 'POST',
        url: '/api/files/fil_1/uploaded',
        headers: auth(uid),
        payload: {},
      });
    expect((await confirm('bob')).statusCode).toBe(404);
    const ok = await confirm('alice');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      fileId: 'fil_1',
      sizeBytes: 42,
      expiresAt: '2026-01-08T00:00:00Z',
    });

    const download = (uid: string) =>
      app.fastify.inject({ method: 'GET', url: '/api/files/fil_1/download', headers: auth(uid) });
    expect((await download('bob')).statusCode).toBe(404);
    expect((await download('alice')).json()).toMatchObject({
      downloadUrl: 'https://storage.example/get',
    });
  });

  it('relays the stored bytes to the owner for in-browser decryption', async () => {
    await createFile('alice', { sizeBytes: 3, encrypted: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    );
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/files/fil_1/content',
      headers: auth('alice'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect([...res.rawPayload]).toEqual([1, 2, 3]);

    const other = await app.fastify.inject({
      method: 'GET',
      url: '/api/files/fil_1/content',
      headers: auth('bob'),
    });
    expect(other.statusCode).toBe(404);
  });

  it('maps storage failures without leaking details', async () => {
    fake.store.create = async () => {
      throw new FileStoreError('File storage returned 403', 403);
    };
    const res = await createFile('alice', { sizeBytes: 1, encrypted: true });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'File storage request failed' });
  });

  it('answers 503 when no file storage is configured', async () => {
    const bare = buildApp({ dbPath: ':memory:', verifyToken });
    const res = await bare.fastify.inject({
      method: 'POST',
      url: '/api/files',
      headers: auth('alice'),
      payload: { sizeBytes: 1, encrypted: true },
    });
    expect(res.statusCode).toBe(503);
    await bare.fastify.close();
  });

  it('allows POST in CORS preflights', async () => {
    const res = await app.fastify.inject({
      method: 'OPTIONS',
      url: '/api/files',
      headers: {
        origin: 'http://localhost:4200',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });
});

describe('gtdriveFileStore', () => {
  it('calls the files API with the key and a body on every POST', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ fileId: 'fil_9', sizeBytes: 1, expiresAt: null }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const store = gtdriveFileStore('https://drive.example/', 'sk_test', fetchImpl);

    await store.confirm('fil_9');
    expect(calls[0]!.url).toBe('https://drive.example/api/v1/files/fil_9/uploaded');
    expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer sk_test',
    );
    expect(calls[0]!.init.body).toBe('{}');
  });

  it('turns an error status into a FileStoreError', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    const store = gtdriveFileStore('https://drive.example', 'sk', fetchImpl);
    await expect(store.downloadUrl('fil_1')).rejects.toMatchObject({ status: 403 });
  });
});

describe('access key', () => {
  let app: App;

  beforeEach(() => {
    app = buildApp({ dbPath: ':memory:', verifyToken, accessKey: 'let-me-in' });
  });

  afterEach(async () => {
    await app.fastify.close();
  });

  const list = (headers: Record<string, string>) =>
    app.fastify.inject({ method: 'GET', url: '/api/clipboard/items', headers });

  it('turns away requests without the right key, before any auth', async () => {
    const missing = await list(auth('alice'));
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toMatchObject({ code: 'access_key' });
    expect((await list({ ...auth('alice'), 'x-access-key': 'nope' })).statusCode).toBe(403);
  });

  it('lets the right key through to normal auth', async () => {
    expect((await list({ ...auth('alice'), 'x-access-key': 'let-me-in' })).statusCode).toBe(200);
    expect((await list({ 'x-access-key': 'let-me-in' })).statusCode).toBe(401);
  });

  it('keeps the health check open', async () => {
    expect((await app.fastify.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('allows the header in CORS preflights', async () => {
    const res = await app.fastify.inject({
      method: 'OPTIONS',
      url: '/api/files',
      headers: {
        origin: 'https://example.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-access-key',
      },
    });
    expect(String(res.headers['access-control-allow-headers'])).toContain('x-access-key');
  });

  it('closes a WebSocket without the key', async () => {
    await app.fastify.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.fastify.server.address() as { port: number }).port;
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=token-alice`);
      ws.onclose = (event) => resolve(event.code);
    });
    expect(code).toBe(4403);
  });
});
