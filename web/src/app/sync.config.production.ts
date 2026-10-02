// Production build (swapped in for sync.config.ts by angular.json).
export const syncConfig = {
  apiBaseUrl: 'https://ghoclipboard.ghonameservices.com',

  // Where a shared link points. It has to be the public web app, not whatever
  // origin this build runs on: the phone app's own origin is https://localhost,
  // which is nobody else's.
  shareBaseUrl: 'https://ghoclipboard.ghonameservices.com',

  // Real Google sign-in everywhere; the server accepts nothing else.
  devAuth: false,
  accessKeyRequired: false,
};
