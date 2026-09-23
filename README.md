# Clipboard Sync

An end-to-end encrypted, cross-device clipboard manager — a hybrid of a clipboard
history tool (like Ditto) and a password vault (like KeePass). Devices sync
clipboard items through a zero-knowledge server that only ever stores ciphertext;
encryption keys are derived from the user's passphrase and never leave their
devices. This repository currently contains the web client scaffold with Google
sign-in; the sync server, E2EE layer, and mobile clients come later.

## Repository layout

| Path       | Contents                                                  |
| ---------- | --------------------------------------------------------- |
| `web/`     | Angular web client (latest Angular, standalone, signals)  |
| `server/`  | Zero-knowledge sync server (Fastify + SQLite + WebSocket) |
| `desktop/` | Electron desktop client with OS clipboard capture         |
| `mobile/`  | Capacitor iOS/Android client (receive-first)              |

## Try it locally in 2 minutes (no Firebase)

Requires Node.js ≥ 22.22.3. This runs the whole app with a built-in local
dev login, so you do not need a Firebase project to click around.

1. In `web/src/app/sync.config.ts`, set `devAuth: true`.
2. Start the sync server in dev-auth mode:
   ```bash
   cd server && npm install && INSECURE_DEV_AUTH=1 npm run dev
   ```
3. In another terminal, start the web app:
   ```bash
   cd web && npm install && npm start
   ```
4. Open <http://localhost:4200>, click **Sign in with Google** (it signs you in
   as a local dev user), then create a vault passphrase. Everything — clipboard,
   secrets, sync, settings — works. Open a second browser/tab to see live sync.

Set `devAuth` back to `false` before using real Google sign-in. Never enable it
in production: it grants access without real authentication.

## Web client setup (real Google sign-in)

Requires Node.js ≥ 22.22.3.

1. Create a project in the [Firebase console](https://console.firebase.google.com/),
   add a **web app**, and enable the **Google** provider under
   *Authentication → Sign-in method*.
2. Copy the web app's config object into `web/src/app/firebase.config.ts`,
   replacing the placeholder values. (These are client identifiers, not secrets,
   but no real project config is committed here.)
3. Run it:

```bash
cd web
npm install
npm start        # dev server on http://localhost:4200
npm run build    # production build
npm test         # unit tests
```

Signed-out visitors are redirected to `/login`. After Google sign-in you set up
(first visit) or enter your vault passphrase on `/unlock` — it derives the
encryption keys client-side and is unrecoverable by design — and then land on
the clipboard page. The vault relocks on reload, on the header's Lock button,
and on sign-out.

Two vaults share the one encryption key, reachable from the header once
unlocked:

- **Clipboard** (`/`): free-text items with a per-item TTL (1 hour / 1 day /
  1 week / forever), search, copy, paste-from-clipboard, and delete.
- **Secrets** (`/secrets`): KeePass-style structured entries (title, username,
  password, URL, notes) that are editable, searchable, and never expire, with
  a built-in strong-password generator. Copying a password auto-clears it from
  the OS clipboard after 12 seconds (a plain username copy does not), matching
  KeePass.
- **Settings** (`/settings`): light/dark/system theme, English/Arabic language
  (the UI mirrors to RTL in Arabic), passphrase change (re-wraps the vault key;
  items are not re-encrypted), and a recovery code — a second way to unlock if
  the passphrase is forgotten, shown once and stored only as a wrapped key.

## Sync server

The server stores and relays ciphertext only: `xcv1:` blobs, the wrapped vault
key, and KDF salt/params. It authenticates users by verifying Firebase ID
tokens against Google's public keys (no Firebase SDK or service account
needed) and can never derive encryption keys.

```bash
cd server
npm install
FIREBASE_PROJECT_ID=your-project npm run dev   # or INSECURE_DEV_AUTH=1 for local dev
npm test
```

Environment: `PORT` (default 8787), `HOST`, `DATABASE_PATH` (SQLite file,
default `clipsync.db`), `FIREBASE_PROJECT_ID`, `INSECURE_DEV_AUTH=1` (dev
only: bearer token is trusted as the uid).

API (bearer-token auth): `GET/PUT /api/vault` for the vault record, and
per-collection item routes where `:collection` is `clipboard` or `secrets` —
`GET /api/:collection/items`, `PUT/DELETE /api/:collection/items/:id`,
`DELETE /api/:collection/items` — plus
`GET /api/sync?token=…&clientId=…`, a WebSocket that pushes
`vault-updated` / `item-added` / `item-removed` / `items-cleared` events
(each carrying its `collection`) to the user's other devices, skipping the
originating `clientId`. History is
capped at 200 items per user.

The web client talks to this server (base URL in `web/src/app/sync.config.ts`,
default `http://localhost:8787`): the vault record and items live on the
server, localStorage keeps an encrypted mirror for offline use, local-only
changes are pushed on the next online load, and remote changes stream in over
the WebSocket. A brand-new device only needs the Google login and the
passphrase — it pulls the vault record from the server and unlocks.

## Desktop client

The Electron app in `desktop/` loads the same web client and adds a
main-process **clipboard watcher**. Captured text is handed to the renderer
over a context-isolated bridge and stored through the ordinary (encrypted,
synced) clipboard path — the vault key never leaves the renderer, so the
desktop shell adds no new crypto. Turn capture on with the "Capture copies"
toggle on the clipboard page (off by default).

The capture policy (`desktop/src/policy.ts`, fully unit-tested) skips:

- unchanged and empty clipboard values;
- values the OS/password managers mark private
  (`ExcludeClipboardContentFromMonitorProcessing` and
  `CanIncludeInClipboardHistory` on Windows, `org.nspasteboard.ConcealedType`
  on macOS);
- values that look like secrets (TOTP codes, high-entropy tokens, known key
  prefixes, private-key blocks) — unless secret capture is explicitly enabled.

It runs in the background from a system-tray icon (open the window, toggle
capture, toggle launch-at-login, or quit), keeps running when the window is
closed so capture continues, and is single-instance. Captured items can be text
**or images** (copy a screenshot and it is stored, encrypted, as an image
item). A global hotkey — `Ctrl/Cmd+Shift+V` by default, overridable with
`CLIPSYNC_HOTKEY` — pops up a compact Ditto-style overlay at the cursor to
search, pick (↑↓/Enter or click), and paste an item without opening the main
window. The overlay needs no passphrase: it only shows previews the already
-unlocked main window pushes to it and asks that window to copy your choice, so
it never decrypts anything itself. While the vault is locked it shows an unlock
hint and nothing else.

On a pick, the item is placed on the OS clipboard (written from the main
process, which needs no focused window) and a paste keystroke is sent to the
app you were in — like Ditto. Auto-paste uses each OS's built-in scripting with
no native module (SendKeys on Windows, System Events on macOS — which needs
Accessibility permission — and `xdotool` on Linux); toggle it with the tray's
"Paste on pick", or disable it with `CLIPSYNC_NO_AUTOPASTE=1`. With it off, the
item still lands on the clipboard for a manual paste.

```bash
cd desktop
npm install
npm test
# Run the shell against the dev web server:
CLIPSYNC_WEB_URL=http://localhost:4200 npm start
# Build the Windows installer (x64; dist:arm64 for ARM PCs):
npm run dist        # → release/ClipboardSync-Setup-<version>-x64.exe
```

The installed app loads the web client from the hosted server
(https://ghoclipboard.ghonameservices.com), so it always runs the current
version and shares the site's saved settings; without a connection it shows
an offline notice and retries. `CLIPSYNC_WEB_URL` points it at a dev server
instead. It installs per user (no admin), is unsigned (SmartScreen asks once),
and keeps its data apart from a development run.

Runtime note: the capture decision logic and the renderer bridge are covered
by unit tests, but launching the Electron GUI and producing installers require
a desktop session with platform build tools and are not exercised in CI.

## Sending files to the clipboard

On Windows, right-click any file(s) → **Send to ▸ Clipboard Sync** (the new
Windows 11 menu only shows classic entries under "Show more options", so the
app also installs a *Send to* shortcut). The file becomes a clipboard item on
every signed-in device, with a **Download** button.

- Files live in GTDrive's append-only files API; the sync server holds the
  GTDrive key (`GTDRIVE_URL`, `GTDRIVE_API_KEY`) and hands devices short-lived
  upload/download URLs. Bytes go device ↔ storage directly.
- **Encrypt files before sending** (Settings, on by default): each file gets a
  fresh AES-256 key, is encrypted on the device in 1 MiB chunks (`CSF1`, see
  `desktop/src/file-crypto.ts`), and storage sees only a random name and
  ciphertext. The key rides inside the (already encrypted) clipboard item.
  Turned off, files are sent as-is — faster, but storage can read them.
- Deleting the item does not delete the stored file (the API is
  append-only); the GTDrive client's retention removes it.

## Deployment

Hosted at <https://ghoclipboard.ghonameservices.com>: one Docker container
(sync server + built web app from the same origin) on the Education VPS,
bound to `127.0.0.1:5780` behind the Cloudflare tunnel. Redeploy with
`bash deploy/deploy.sh`.

Server settings live only in `/opt/ghoclipboard/.env` on the VPS:
`FIREBASE_PROJECT_ID`, `GTDRIVE_URL` and `GTDRIVE_API_KEY`. Every client signs
in with Google — the website and desktop app through Firebase's popup, the
phone through Android's account picker (`mobile/plugins/google-signin`, since
Google refuses its sign-in page inside a WebView) — and the server accepts
nothing else.

`INSECURE_DEV_AUTH` (optionally with `DEV_UID_ALIAS`, which maps that identity
onto a real account) and `ACCESS_KEY`, a shared secret each device enters once,
exist for local development and for keeping a deployment closed before sign-in
is configured. Neither is set in production.

## Mobile client

The `mobile/` package wraps the same web client as a native iOS/Android app
with [Capacitor](https://capacitorjs.com/). It is **receive-first**: mobile
OSes block background clipboard capture, so the app shows your synced clipboard
and secrets, copies with one tap, and lets you send with the native share
sheet — the desktop app does the auto-capturing.

The web app is platform-aware through `web/src/app/core/native-bridge.service.ts`:
copy/read/share use the native Capacitor plugins when present and fall back to
the browser APIs otherwise, and Google sign-in uses a redirect (not a popup)
inside the mobile WebView.

```bash
cd mobile
npm install
npm run sync          # builds the web client into www/ and runs `cap sync`
npm run add:android   # or add:ios — generate the native project
npm run open:android  # open in Android Studio / Xcode to run on a device
```

The production web build (which `npm run sync` bundles) already points at
<https://ghoclipboard.ghonameservices.com>, so the app works against the hosted
server; enter the access key once on its login page. Package id:
`com.ghonametech.ghoclipboard`. **Download** on a phone fetches the file through
the sync server, decrypts it, and opens the share sheet to save or open it
(150 MB max). Build a debug APK on Windows with:

```bash
cd mobile && npm run sync && cd android
JAVA_HOME=<jdk-21> ANDROID_HOME=<android-sdk> ./gradlew.bat assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

Release builds are signed outside Gradle so the signing setup survives
`cap add android` regenerating the native project:

```bash
cd mobile && npm run release     # -> android/app/build/outputs/apk/release/ClipboardSync-release.apk
```

It reads the key from a JSON file outside the repository
(`{ keystore, alias, storePassword, keyPassword }`), by default
`C:/Users/bslsm/keys/ghoclipboard-release.json`, overridable with
`CLIPSYNC_ANDROID_KEY`. **Back that keystore up**: without it the app can never
be updated under the same identity. Every signing key used to build the app
(debug and release) needs its SHA-1 added to the Firebase Android app, or
Google sign-in fails in builds signed with it. Building and
running on a device needs Android Studio / Xcode and is not exercised in CI;
the `cap` config, the web bundling, and native-project generation with all
plugins were verified here.

## Architecture direction

- **Two vaults, different policies**: an auto-captured clipboard vault with
  per-item TTL that skips content marked `ExcludeClipboardMonitoring` by
  password managers, and a deliberate KeePass-style secrets vault whose copies
  bypass capture and auto-clear.
- **Zero-knowledge crypto**: Argon2id passphrase stretching → master key →
  wrapped random vault key; per-item XChaCha20-Poly1305 blobs (libsodium).
  Implemented in `web/src/app/core/crypto.service.ts`; device enrollment and
  the sync layer that uses it come next.
- **Auth ≠ encryption**: Google login authenticates the account; it can never
  derive the decryption keys.
- **Capture model**: the desktop client auto-captures (see above); mobile apps
  are receive-first (OS restrictions block background clipboard reads).

## History

This repo previously held an Angular 6 + Firebase Google-login starter; that
code remains on the `master` branch history and served as the reference for the
auth flow here.
