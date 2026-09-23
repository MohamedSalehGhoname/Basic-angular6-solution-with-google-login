// Firebase web app config for the GhoClipboard project. These are public
// client identifiers (they ship inside the page of every Firebase site), not
// secrets: what protects an account is the Google sign-in itself, and what
// protects the data is the vault passphrase, which never leaves the device.
export const firebaseConfig = {
  apiKey: 'AIzaSyDMOjRPAnBqyDxMXM6rA0aK5SfJ_bTvI94',
  authDomain: 'ghoclipboard.firebaseapp.com',
  projectId: 'ghoclipboard',
  storageBucket: 'ghoclipboard.firebasestorage.app',
  messagingSenderId: '178287372678',
  appId: '1:178287372678:web:6eacd291d747509e87e407',

  // OAuth Web client id, used by the phone's native sign-in (Android hands
  // back an ID token issued for this id, which Firebase then accepts).
  // Firebase console ▸ Authentication ▸ Sign-in method ▸ Google ▸ Web SDK
  // configuration.
  googleWebClientId: '',
};
