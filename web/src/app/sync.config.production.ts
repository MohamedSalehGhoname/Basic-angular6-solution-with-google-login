// Production build (swapped in for sync.config.ts by angular.json).
export const syncConfig = {
  apiBaseUrl: 'https://ghoclipboard.ghonameservices.com',

  // Real Google sign-in everywhere; the server accepts nothing else.
  devAuth: false,
  accessKeyRequired: false,
};
