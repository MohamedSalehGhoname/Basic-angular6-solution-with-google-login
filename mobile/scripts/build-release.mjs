// Builds a signed release APK, or the app bundle Play wants.
//
//   npm run release        -> ClipboardSync-release.apk  (sideloading, testing)
//   npm run bundle         -> ClipboardSync-release.aab  (Google Play upload)
//
// The signing key is deliberately outside the repository and never
// committed: point KEY_CONFIG (or the CLIPSYNC_ANDROID_KEY env var) at a JSON
// file holding { keystore, alias, storePassword, keyPassword }. Signing
// happens here rather than in Gradle so it survives `cap add android`
// regenerating the native project.
//
// The release APK is signed with a different key than the debug ones, so a
// phone with a debug build installed must uninstall it first.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = join(mobileDir, 'android');
const KEY_CONFIG = process.env['CLIPSYNC_ANDROID_KEY'] ?? 'C:/Users/bslsm/keys/ghoclipboard-release.json';
const ANDROID_HOME = process.env['ANDROID_HOME'] ?? 'C:/d/tools/android-sdk';
const JAVA_HOME = process.env['JAVA_HOME'] ?? 'C:/d/tools/java/jdk-21.0.12.1+1';

if (!existsSync(KEY_CONFIG)) {
  console.error(`No signing key config at ${KEY_CONFIG}. Set CLIPSYNC_ANDROID_KEY.`);
  process.exit(1);
}
const key = JSON.parse(readFileSync(KEY_CONFIG, 'utf8'));

/** The newest build-tools version installed (zipalign and apksigner live there). */
function buildTools() {
  const dir = join(ANDROID_HOME, 'build-tools');
  const versions = readdirSync(dir).sort();
  return join(dir, versions[versions.length - 1]);
}

// Windows needs a shell for .bat wrappers (gradlew, apksigner); quote the
// paths because they contain spaces on some machines.
const run = (command, args, options = {}) =>
  execFileSync(command.endsWith('.bat') ? `"${command}"` : command, args, {
    stdio: 'inherit',
    shell: command.endsWith('.bat'),
    env: { ...process.env, JAVA_HOME, ANDROID_HOME },
    ...options,
  });

// Play's automatic protection needs minSdk 24; the native project is
// regenerated from Capacitor's template (which says 23), so enforce it here.
const variables = join(androidDir, 'variables.gradle');
const gradleVars = readFileSync(variables, 'utf8');
if (/minSdkVersion\s*=\s*2[0-3]/.test(gradleVars)) {
  writeFileSync(variables, gradleVars.replace(/minSdkVersion\s*=\s*2[0-3]/, 'minSdkVersion = 24'));
  console.log('==> Raised minSdkVersion to 24 (Play automatic protection)');
}

console.log('==> Bundling the web app');
run('npm', ['run', 'bundle:web'], { cwd: mobileDir, shell: true });

// bundle:web only fills mobile/www; the native project gets its copy here.
console.log('==> Syncing the native project');
run('npx', ['cap', 'sync', 'android'], { cwd: mobileDir, shell: true });

const wantsBundle = process.argv.includes('--bundle');

if (wantsBundle) {
  console.log('==> Building the app bundle');
  run(join(androidDir, 'gradlew.bat'), ['bundleRelease'], { cwd: androidDir });
  const aab = join(androidDir, 'app/build/outputs/bundle/release/app-release.aab');
  const signedAab = join(androidDir, 'app/build/outputs/bundle/release/ClipboardSync-release.aab');
  copyFileSync(aab, signedAab);
  // An .aab is a jar, so it is signed with jarsigner rather than apksigner.
  // Play re-signs it with the app signing key; this key is the upload key.
  console.log('==> Signing the bundle');
  run(join(JAVA_HOME, 'bin/jarsigner.exe'), [
    '-keystore', key.keystore,
    '-storepass', key.storePassword,
    '-keypass', key.keyPassword,
    '-digestalg', 'SHA-256',
    '-sigalg', 'SHA256withRSA',
    signedAab,
    key.alias,
  ]);
  console.log(`
==> ${signedAab}`);
  process.exit(0);
}

console.log('==> Building the release APK');
run(join(androidDir, 'gradlew.bat'), ['assembleRelease'], { cwd: androidDir });

const unsigned = join(androidDir, 'app/build/outputs/apk/release/app-release-unsigned.apk');
const aligned = join(androidDir, 'app/build/outputs/apk/release/app-release-aligned.apk');
const signed = join(androidDir, 'app/build/outputs/apk/release/ClipboardSync-release.apk');
const tools = buildTools();

console.log('==> Aligning and signing');
run(join(tools, 'zipalign.exe'), ['-p', '-f', '4', unsigned, aligned]);
run(join(tools, 'apksigner.bat'), [
  'sign',
  '--ks', key.keystore,
  '--ks-key-alias', key.alias,
  '--ks-pass', `pass:${key.storePassword}`,
  '--key-pass', `pass:${key.keyPassword}`,
  '--out', signed,
  aligned,
]);
run(join(tools, 'apksigner.bat'), ['verify', '--print-certs', signed]);

console.log(`\n==> ${signed}`);
