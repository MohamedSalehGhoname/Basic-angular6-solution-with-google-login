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

// Play requires minSdk 24 (automatic protection) and target/compile SDK 36
// (Android 16) for new apps. The native project is regenerated from
// Capacitor's template, which is behind on both, so enforce them here.
const variables = join(androidDir, 'variables.gradle');
const required = { minSdkVersion: 24, compileSdkVersion: 36, targetSdkVersion: 36 };
let gradleVars = readFileSync(variables, 'utf8');
let raised = false;
for (const [name, floor] of Object.entries(required)) {
  const match = new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(gradleVars);
  if (match && Number(match[1]) < floor) {
    gradleVars = gradleVars.replace(match[0], `${name} = ${floor}`);
    raised = true;
  }
}
if (raised) {
  writeFileSync(variables, gradleVars);
  console.log('==> Raised SDK levels to the minimums Play requires (24 / 36 / 36)');
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
