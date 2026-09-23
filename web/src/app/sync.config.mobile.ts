// Build bundled into the phone app (angular.json "mobile" configuration).
// It differs from the production build only in how sign-in starts: the phone
// uses Android's account picker (mobile/plugins/google-signin), since Google
// refuses its sign-in page inside an app's WebView.
export const syncConfig = {
  apiBaseUrl: 'https://ghoclipboard.ghonameservices.com',
  devAuth: false,
  accessKeyRequired: false,
};
