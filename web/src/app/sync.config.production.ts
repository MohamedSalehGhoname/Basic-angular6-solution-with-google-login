// Production build (swapped in for sync.config.ts by angular.json).
export const syncConfig = {
  apiBaseUrl: 'https://ghoclipboard.ghonameservices.com',

  // TEMPORARY until Firebase sign-in is set up: the dev identity, with the
  // server closed by a shared access key (ACCESS_KEY) that every device
  // enters once. Turn both off together when real sign-in lands.
  devAuth: true,
  accessKeyRequired: true,
};
