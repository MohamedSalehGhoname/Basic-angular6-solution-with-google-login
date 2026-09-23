// Production build (swapped in for sync.config.ts by angular.json).
export const syncConfig = {
  apiBaseUrl: 'https://ghoclipboard.ghonameservices.com',

  // Real Google sign-in. The shared access key stays until the phone app can
  // sign in natively too, because the server still accepts the old dev
  // identity for it (see DEV_UID_ALIAS) and the key is what shields that.
  devAuth: false,
  accessKeyRequired: true,
};
