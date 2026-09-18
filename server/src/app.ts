import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { TokenVerifier } from './auth.js';
import { SyncDb } from './db.js';
import { SyncHub } from './hub.js';

export interface AppOptions {
  dbPath: string;
  verifyToken: TokenVerifier;
  /** Per-user history cap; oldest items beyond it are dropped. */
  maxItems?: number;
  logger?: boolean;
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
const MAX_BLOB_LENGTH = 256 * 1024;

const vaultBodySchema = {
  type: 'object',
  required: ['salt', 'opsLimit', 'memLimit', 'wrappedKey'],
  additionalProperties: false,
  properties: {
    salt: { type: 'string', pattern: BASE64URL_PATTERN, maxLength: 128 },
    opsLimit: { type: 'integer', minimum: 1 },
    memLimit: { type: 'integer', minimum: 1 },
    wrappedKey: { type: 'string', pattern: BLOB_PATTERN, maxLength: 1024 },
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

const itemParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
  },
} as const;

export interface App {
  fastify: FastifyInstance;
  db: SyncDb;
  hub: SyncHub;
}

export function buildApp(options: AppOptions): App {
  const db = new SyncDb(options.dbPath);
  const hub = new SyncHub();
  const maxItems = options.maxItems ?? 200;
  const fastify = Fastify({ logger: options.logger ?? false });

  const clientId = (request: FastifyRequest): string | null => {
    const value = request.headers['x-client-id'];
    return typeof value === 'string' && value.length <= 64 ? value : null;
  };

  fastify.register(websocket);

  fastify.get('/healthz', async () => ({ ok: true }));

  fastify.register(async (api) => {
    api.addHook('preHandler', async (request, reply) => {
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

    api.get('/items', async (request) => ({ items: db.listItems(request.uid) }));

    api.put(
      '/items/:id',
      { schema: { body: itemBodySchema, params: itemParamsSchema } },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const { blob } = request.body as { blob: string };
        const item = db.putItem(request.uid, id, blob, maxItems);
        hub.broadcast(request.uid, { type: 'item-added', item }, clientId(request));
        return reply.code(204).send();
      },
    );

    api.delete(
      '/items/:id',
      { schema: { params: itemParamsSchema } },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        db.deleteItem(request.uid, id);
        hub.broadcast(request.uid, { type: 'item-removed', id }, clientId(request));
        return reply.code(204).send();
      },
    );

    api.delete('/items', async (request, reply) => {
      db.clearItems(request.uid);
      hub.broadcast(request.uid, { type: 'items-cleared' }, clientId(request));
      return reply.code(204).send();
    });
  }, { prefix: '/api' });

  // Browsers cannot set headers on WebSocket upgrades, so auth rides the
  // query string here instead of the Authorization header.
  fastify.register(async (ws) => {
    ws.get('/api/sync', { websocket: true }, async (socket, request) => {
      const query = request.query as { token?: string; clientId?: string };
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
