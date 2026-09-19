import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { TokenVerifier } from './auth.js';
import { SyncDb } from './db.js';
import { FileStoreError, type FileStore } from './gtdrive.js';
import { SyncHub } from './hub.js';

export interface AppOptions {
  dbPath: string;
  verifyToken: TokenVerifier;
  /** Per-user clipboard history cap; oldest items beyond it are dropped. */
  maxItems?: number;
  /** Allowed CORS origin(s); defaults to reflecting the request origin. */
  corsOrigin?: string | string[] | boolean;
  logger?: boolean;
  /** Storage for files sent to the clipboard; the file routes 503 without it. */
  files?: FileStore;
  /**
   * Shared secret every client must present (x-access-key header, or the
   * accessKey query on the WebSocket). A stopgap that keeps a public
   * deployment closed while sign-in is still the insecure dev mode.
   */
  accessKey?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    uid: string;
  }
}

// Matches CryptoService's serialization; anything else is rejected so the
// store can only ever hold ciphertext-shaped strings.
const BLOB_PATTERN = '^xcv1:[A-Za-z0-9_-]+$';
const BASE64URL_PATTERN = '^[A-Za-z0-9_-]+$';
// Large enough to hold a secret with a few compressed image attachments (all
// ciphertext); the client downscales images so entries stay well under this.
const MAX_BLOB_LENGTH = 8 * 1024 * 1024;

const wrappedKeyProps = {
  salt: { type: 'string', pattern: BASE64URL_PATTERN, maxLength: 128 },
  opsLimit: { type: 'integer', minimum: 1 },
  memLimit: { type: 'integer', minimum: 1 },
  wrappedKey: { type: 'string', pattern: BLOB_PATTERN, maxLength: 1024 },
} as const;

const vaultBodySchema = {
  type: 'object',
  required: ['salt', 'opsLimit', 'memLimit', 'wrappedKey'],
  additionalProperties: false,
  properties: {
    ...wrappedKeyProps,
    // Optional recovery-code-wrapped copy of the vault key.
    recovery: {
      type: 'object',
      required: ['salt', 'opsLimit', 'memLimit', 'wrappedKey'],
      additionalProperties: false,
      properties: wrappedKeyProps,
    },
  },
} as const;

const itemBodySchema = {
  type: 'object',
  required: ['blob'],
  additionalProperties: false,
  properties: {
    blob: { type: 'string', pattern: BLOB_PATTERN, maxLength: MAX_BLOB_LENGTH },
  },
} as const;

// The server treats collections opaquely but allowlists the known ones so a
// typo or hostile client cannot spawn arbitrary namespaces.
const COLLECTIONS = ['clipboard', 'secrets', 'groups'] as const;

// Only the clipboard is a rolling history; secrets and their groups are kept
// records, so their caps are just abuse limits, far above real use.
const RECORD_CAPS: Record<string, number> = { secrets: 5000, groups: 1000 };

const collectionParamsSchema = {
  type: 'object',
  required: ['collection'],
  properties: {
    collection: { type: 'string', enum: COLLECTIONS },
  },
} as const;

// GTDrive's own upload limit.
const MAX_FILE_BYTES = 5 * 1024 ** 3;

const fileBodySchema = {
  type: 'object',
  required: ['sizeBytes', 'encrypted'],
  additionalProperties: false,
  properties: {
    sizeBytes: { type: 'integer', minimum: 1, maximum: MAX_FILE_BYTES },
    encrypted: { type: 'boolean' },
    // Only for files sent as-is; an encrypted file's name stays in the
    // encrypted clipboard item and storage sees a random one.
    name: { type: 'string', maxLength: 255 },
  },
} as const;

const fileParamsSchema = {
  type: 'object',
  required: ['fileId'],
  properties: {
    fileId: { type: 'string', pattern: '^fil_[A-Za-z0-9_-]{1,64}$' },
  },
} as const;

/** GTDrive accepts letters, digits, `.`, `_` and `-` in names. */
function storageName(name: string | undefined): string {
  const cleaned = (name ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-120);
  return cleaned || 'file';
}

/** Each user's files live under an opaque folder derived from the uid. */
function storagePath(uid: string): string {
  return `u/${createHash('sha256').update(uid).digest('hex').slice(0, 24)}`;
}

const itemParamsSchema = {
  type: 'object',
  required: ['collection', 'id'],
  properties: {
    collection: { type: 'string', enum: COLLECTIONS },
    id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
  },
} as const;

export interface App {
  fastify: FastifyInstance;
  db: SyncDb;
  hub: SyncHub;
}

/** Constant-time check of a presented access key against the configured one. */
function accessKeyMatches(expected: string | undefined, presented: unknown): boolean {
  if (!expected) {
    return true;
  }
  if (typeof presented !== 'string') {
    return false;
  }
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(presented).digest();
  return timingSafeEqual(a, b);
}

export function buildApp(options: AppOptions): App {
  const db = new SyncDb(options.dbPath);
  const hub = new SyncHub();
  const clipboardCap = options.maxItems ?? 200;
  const capFor = (collection: string): number => RECORD_CAPS[collection] ?? clipboardCap;
  // Body limit above MAX_BLOB_LENGTH so image-bearing (ciphertext) items fit.
  const fastify = Fastify({ logger: options.logger ?? false, bodyLimit: 12 * 1024 * 1024 });

  const clientId = (request: FastifyRequest): string | null => {
    const value = request.headers['x-client-id'];
    return typeof value === 'string' && value.length <= 64 ? value : null;
  };

  // Auth is bearer-token only (no cookies), so reflecting the origin does not
  // enable credentialed cross-site requests; restrict via CORS_ORIGIN anyway
  // in production.
  fastify.register(cors, {
    origin: options.corsOrigin ?? true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'x-client-id', 'x-access-key'],
  });
  fastify.register(websocket);

  fastify.get('/healthz', async () => ({ ok: true }));

  fastify.register(async (api) => {
    api.addHook('preHandler', async (request, reply) => {
      if (!accessKeyMatches(options.accessKey, request.headers['x-access-key'])) {
        return reply.code(403).send({ error: 'Invalid access key', code: 'access_key' });
      }
      const header = request.headers.authorization;
      const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
      if (!token) {
        return reply.code(401).send({ error: 'Missing bearer token' });
      }
      try {
        request.uid = (await options.verifyToken(token)).uid;
      } catch {
        return reply.code(401).send({ error: 'Invalid token' });
      }
    });

    api.get('/vault', async (request, reply) => {
      const vault = db.getVault(request.uid);
      if (!vault) {
        return reply.code(404).send({ error: 'No vault' });
      }
      return vault;
    });

    api.put('/vault', { schema: { body: vaultBodySchema } }, async (request, reply) => {
      db.putVault(request.uid, request.body as never);
      hub.broadcast(request.uid, { type: 'vault-updated' }, clientId(request));
      return reply.code(204).send();
    });

    api.get(
      '/:collection/items',
      { schema: { params: collectionParamsSchema } },
      async (request) => {
        const { collection } = request.params as { collection: string };
        return { items: db.listItems(request.uid, collection) };
      },
    );

    api.put(
      '/:collection/items/:id',
      { schema: { body: itemBodySchema, params: itemParamsSchema } },
      async (request, reply) => {
        const { collection, id } = request.params as { collection: string; id: string };
        const { blob } = request.body as { blob: string };
        const item = db.putItem(request.uid, collection, id, blob, capFor(collection));
        hub.broadcast(request.uid, { type: 'item-added', collection, item }, clientId(request));
        return reply.code(204).send();
      },
    );

    api.delete(
      '/:collection/items/:id',
      { schema: { params: itemParamsSchema } },
      async (request, reply) => {
        const { collection, id } = request.params as { collection: string; id: string };
        db.deleteItem(request.uid, collection, id);
        hub.broadcast(request.uid, { type: 'item-removed', collection, id }, clientId(request));
        return reply.code(204).send();
      },
    );

    api.delete(
      '/:collection/items',
      { schema: { params: collectionParamsSchema } },
      async (request, reply) => {
        const { collection } = request.params as { collection: string };
        db.clearItems(request.uid, collection);
        hub.broadcast(request.uid, { type: 'items-cleared', collection }, clientId(request));
        return reply.code(204).send();
      },
    );

    // --- Files sent to the clipboard -------------------------------------
    // The server hands out storage URLs for the caller's own files only.
    const fileStore = (reply: FastifyReply): FileStore | null => {
      if (!options.files) {
        void reply.code(503).send({ error: 'File sharing is not configured' });
        return null;
      }
      return options.files;
    };
    const ownFile = (request: FastifyRequest, reply: FastifyReply): string | null => {
      const { fileId } = request.params as { fileId: string };
      if (db.fileOwner(fileId) !== request.uid) {
        void reply.code(404).send({ error: 'No such file' });
        return null;
      }
      return fileId;
    };
    const storageFailed = (reply: FastifyReply, err: unknown) => {
      fastify.log.warn({ err }, 'file storage call failed');
      const status = err instanceof FileStoreError && err.status === 403 ? 403 : 502;
      return reply.code(status).send({ error: 'File storage request failed' });
    };

    api.post('/files', { schema: { body: fileBodySchema } }, async (request, reply) => {
      const store = fileStore(reply);
      if (!store) {
        return reply;
      }
      const { sizeBytes, encrypted, name } = request.body as {
        sizeBytes: number;
        encrypted: boolean;
        name?: string;
      };
      const fileName = encrypted
        ? `${randomUUID().replaceAll('-', '')}.bin`
        : storageName(name);
      try {
        const created = await store.create({ fileName, path: storagePath(request.uid), sizeBytes });
        db.addFile(request.uid, created.fileId, sizeBytes);
        return {
          fileId: created.fileId,
          uploadUrl: created.uploadUrl,
          uploadExpiresAt: created.uploadExpiresAt,
        };
      } catch (err) {
        return storageFailed(reply, err);
      }
    });

    api.post(
      '/files/:fileId/uploaded',
      { schema: { params: fileParamsSchema } },
      async (request, reply) => {
        const store = fileStore(reply);
        const fileId = store && ownFile(request, reply);
        if (!store || !fileId) {
          return reply;
        }
        try {
          const confirmed = await store.confirm(fileId);
          return { fileId, sizeBytes: confirmed.sizeBytes, expiresAt: confirmed.expiresAt };
        } catch (err) {
          return storageFailed(reply, err);
        }
      },
    );

    api.get(
      '/files/:fileId/download',
      { schema: { params: fileParamsSchema } },
      async (request, reply) => {
        const store = fileStore(reply);
        const fileId = store && ownFile(request, reply);
        if (!store || !fileId) {
          return reply;
        }
        try {
          // Only the link: storage's own name and hash stay server-side.
          const { downloadUrl, expiresAt } = await store.downloadUrl(fileId);
          return { downloadUrl, expiresAt };
        } catch (err) {
          return storageFailed(reply, err);
        }
      },
    );

    // Relays the stored bytes for browsers, which cannot fetch the storage
    // URL cross-origin to decrypt it. Encrypted files are ciphertext here.
    api.get(
      '/files/:fileId/content',
      { schema: { params: fileParamsSchema } },
      async (request, reply) => {
        const store = fileStore(reply);
        const fileId = store && ownFile(request, reply);
        if (!store || !fileId) {
          return reply;
        }
        let upstream: Response;
        try {
          upstream = await fetch((await store.downloadUrl(fileId)).downloadUrl);
        } catch (err) {
          return storageFailed(reply, err);
        }
        if (!upstream.ok || !upstream.body) {
          return storageFailed(reply, new FileStoreError('download failed', upstream.status));
        }
        reply.header('content-type', 'application/octet-stream');
        const length = upstream.headers.get('content-length');
        if (length) {
          reply.header('content-length', length);
        }
        return reply.send(Readable.fromWeb(upstream.body as never));
      },
    );
  }, { prefix: '/api' });

  // Browsers cannot set headers on WebSocket upgrades, so auth rides the
  // query string here instead of the Authorization header.
  fastify.register(async (ws) => {
    ws.get('/api/sync', { websocket: true }, async (socket, request) => {
      const query = request.query as { token?: string; clientId?: string; accessKey?: string };
      if (!accessKeyMatches(options.accessKey, query.accessKey)) {
        socket.close(4403, 'Invalid access key');
        return;
      }
      if (!query.token) {
        socket.close(4401, 'Missing token');
        return;
      }
      let uid: string;
      try {
        uid = (await options.verifyToken(query.token)).uid;
      } catch {
        socket.close(4401, 'Invalid token');
        return;
      }
      hub.add(uid, socket, query.clientId?.slice(0, 64) ?? null);
    });
  });

  fastify.addHook('onClose', async () => {
    db.close();
  });

  return { fastify, db, hub };
}
