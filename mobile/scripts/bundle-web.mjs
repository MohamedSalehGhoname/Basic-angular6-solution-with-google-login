// Builds the web client and copies it into the Capacitor webDir (www), so the
// mobile app ships the exact same UI, crypto, and sync as the web/desktop apps.
import { execSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(mobileDir, '..', 'web');
const builtWeb = join(webDir, 'dist', 'web', 'browser');
const target = join(mobileDir, 'www');

console.log('Building web client…');
// The "mobile" configuration keeps the dev sign-in the phone still needs.
execSync('npm run build -- --configuration mobile', { cwd: webDir, stdio: 'inherit' });

console.log(`Copying ${builtWeb} → ${target}`);
rmSync(target, { recursive: true, force: true });
cpSync(builtWeb, target, { recursive: true });
console.log('Web client bundled into www/.');
