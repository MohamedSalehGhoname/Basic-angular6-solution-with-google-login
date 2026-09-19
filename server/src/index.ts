import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { firebaseTokenVerifier, insecureDevVerifier } from './auth.js';
import { buildApp } from './app.js';
import { gtdriveFileStore } from './gtdrive.js';

const port = Number(process.env['PORT'] ?? 8787);
const host = process.env['HOST'] ?? '0.0.0.0';
const dbPath = process.env['DATABASE_PATH'] ?? 'clipsync.db';
const projectId = process.env['FIREBASE_PROJECT_ID'];
const insecureDev = process.env['INSECURE_DEV_AUTH'] === '1';

if (!projectId && !insecureDev) {
  console.error(
    'Set FIREBASE_PROJECT_ID to verify Google sign-in tokens ' +
      '(or INSECURE_DEV_AUTH=1 for local development only).',
  );
  process.exit(1);
}

const corsOrigin = process.env['CORS_ORIGIN'];

// Files sent to the clipboard go to GTDrive; without a key the feature is off.
const gtdriveUrl = process.env['GTDRIVE_URL'] ?? 'https://drive.ghonameservices.com';
const gtdriveKey = process.env['GTDRIVE_API_KEY'];
// Until real sign-in is configured, a public deployment is closed with this.
const accessKey = process.env['ACCESS_KEY'] || undefined;
// Optional: the built web app, served from the same origin as the API.
const staticDir = process.env['STATIC_DIR'];

const { fastify } = buildApp({
  dbPath,
  verifyToken: insecureDev ? insecureDevVerifier() : firebaseTokenVerifier(projectId!),
  corsOrigin: corsOrigin ? corsOrigin.split(',') : true,
  logger: true,
  files: gtdriveKey ? gtdriveFileStore(gtdriveUrl, gtdriveKey) : undefined,
  accessKey,
});

if (staticDir) {
  const root = resolve(staticDir);
  if (!existsSync(`${root}/index.html`)) {
    console.error(`STATIC_DIR ${root} has no index.html`);
    process.exit(1);
  }
  fastify.register(fastifyStatic, { root, wildcard: false });
  // Deep links (/secrets, /settings…) load the app shell; unknown API paths
  // stay 404s.
  fastify.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Not found' });
  });
}

if (insecureDev) {
  fastify.log.warn('INSECURE_DEV_AUTH is enabled: bearer tokens are trusted as uids.');
  if (!accessKey) {
    fastify.log.warn('No ACCESS_KEY: anyone who can reach this server can act as any user.');
  }
}
if (!gtdriveKey) {
  fastify.log.warn('GTDRIVE_API_KEY is not set: sending files to the clipboard is disabled.');
}

fastify.listen({ port, host }).catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});
