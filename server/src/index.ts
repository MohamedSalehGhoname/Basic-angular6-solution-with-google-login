import { firebaseTokenVerifier, insecureDevVerifier } from './auth.js';
import { buildApp } from './app.js';

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

const { fastify } = buildApp({
  dbPath,
  verifyToken: insecureDev ? insecureDevVerifier() : firebaseTokenVerifier(projectId!),
  logger: true,
});

if (insecureDev) {
  fastify.log.warn('INSECURE_DEV_AUTH is enabled: bearer tokens are trusted as uids.');
}

fastify.listen({ port, host }).catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});
