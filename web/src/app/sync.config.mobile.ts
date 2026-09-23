// Build bundled into the phone app (angular.json "mobile" configuration).
// Google blocks its sign-in page inside an app's WebView, so the phone keeps
// the dev identity — which the server maps onto the owner's real account —
// plus the access key, until native Google sign-in is added.
export const syncConfig = {
  apiBaseUrl: 'https://ghoclipboard.ghonameservices.com',
  devAuth: true,
  accessKeyRequired: true,
};
