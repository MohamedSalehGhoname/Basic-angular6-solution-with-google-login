// Base URL of the sync server (see server/). The app works offline against
// its local mirror when the server is unreachable.
export const syncConfig = {
  apiBaseUrl: 'http://localhost:8787',

  // Local dev mode: skip Google/Firebase and sign in as a fixed local user, so
  // you can try the whole app without setting up Firebase. The sync server must
  // run with INSECURE_DEV_AUTH=1 to accept the dev identity. NEVER enable in
  // production â€” it grants access without real authentication.
  // Where a shared link points. It has to be the public web app, not whatever
  // origin this build runs on: the phone app's own origin is https://localhost,
  // which is nobody else's.
  shareBaseUrl: 'http://localhost:8787',

  devAuth: false,

  // Ask for the shared access key a deployment sets with ACCESS_KEY.
  accessKeyRequired: false,
};
