# Clipboard Sync

An end-to-end encrypted, cross-device clipboard manager — a hybrid of a clipboard
history tool (like Ditto) and a password vault (like KeePass). Devices sync
clipboard items through a zero-knowledge server that only ever stores ciphertext;
encryption keys are derived from the user's passphrase and never leave their
devices. This repository currently contains the web client scaffold with Google
sign-in; the sync server, E2EE layer, and mobile clients come later.

## Repository layout

| Path      | Contents                                                 |
| --------- | -------------------------------------------------------- |
| `web/`    | Angular web client (latest Angular, standalone, signals) |
| `server/` | Zero-knowledge sync server (Fastify + SQLite + WebSocket) |

## Web client setup

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
the (currently empty) clipboard page. The vault relocks on reload, on the
header's Lock button, and on sign-out.

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

API (bearer-token auth): `GET/PUT /api/vault` for the vault record,
`GET /api/items`, `PUT/DELETE /api/items/:id`, `DELETE /api/items`, and
`GET /api/sync?token=…&clientId=…` — a WebSocket that pushes
`vault-updated` / `item-added` / `item-removed` / `items-cleared` events to
the user's other devices, skipping the originating `clientId`. History is
capped at 200 items per user.

The web client talks to this server (base URL in `web/src/app/sync.config.ts`,
default `http://localhost:8787`): the vault record and items live on the
server, localStorage keeps an encrypted mirror for offline use, local-only
changes are pushed on the next online load, and remote changes stream in over
the WebSocket. A brand-new device only needs the Google login and the
passphrase — it pulls the vault record from the server and unlocks.

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
- **Capture model**: desktop clients/extension auto-capture; mobile apps are
  receive-first (OS restrictions block background clipboard reads).

## History

This repo previously held an Angular 6 + Firebase Google-login starter; that
code remains on the `master` branch history and served as the reference for the
auth flow here.
