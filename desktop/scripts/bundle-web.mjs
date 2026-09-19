// Builds the web client and copies it next to the compiled main process so the
// packaged desktop app is self-contained (main.ts loads ../web/index.html).
import { execSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(desktopDir, '..', 'web');
const builtWeb = join(webDir, 'dist', 'web', 'browser');
const target = join(desktopDir, 'web');

console.log('Building web client…');
execSync('npm run build', { cwd: webDir, stdio: 'inherit' });

console.log(`Copying ${builtWeb} → ${target}`);
rmSync(target, { recursive: true, force: true });
cpSync(builtWeb, target, { recursive: true });
console.log('Web client bundled.');
