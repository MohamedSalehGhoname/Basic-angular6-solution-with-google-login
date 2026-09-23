// Build bundled into the phone app (angular.json "mobile" configuration).
// The phone signs in with the real Google account through Android's account
// picker (mobile/plugins/google-signin). The access key stays only until the
// server stops accepting the old dev identity.
export const syncConfig = {
  apiBaseUrl: 'https://ghoclipboard.ghonameservices.com',
  devAuth: false,
  accessKeyRequired: true,
};
