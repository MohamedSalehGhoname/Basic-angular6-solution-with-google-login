import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithCredential,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from 'firebase/auth';
import { firebaseConfig } from '../firebase.config';
import { syncConfig } from '../sync.config';
import { firebaseAuth } from './firebase';
import { NativeBridge } from './native-bridge.service';

const DEV_UID = 'local-dev-user';
const DEV_FLAG = 'clipsync.devSignedIn';

/**
 * The phone app's native sign-in (mobile/plugins/google-signin). Google
 * refuses to show its sign-in page inside an app's WebView, so the phone
 * uses Android's own account picker and hands back an ID token.
 */
interface GoogleSignInPlugin {
  signIn(options: { serverClientId: string }): Promise<{ idToken: string }>;
  signOut(): Promise<void>;
}

function nativeGoogle(): GoogleSignInPlugin | undefined {
  return (window as unknown as { Capacitor?: { Plugins?: { GoogleSignIn?: GoogleSignInPlugin } } })
    .Capacitor?.Plugins?.GoogleSignIn;
}

/** Fixed identity used when syncConfig.devAuth is on (no Firebase). */
function devUser(): User {
  return {
    uid: DEV_UID,
    displayName: 'Local Dev',
    email: 'dev@localhost',
    photoURL: null,
  } as unknown as User;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly router = inject(Router);
  private readonly native = inject(NativeBridge);
  private readonly devMode = syncConfig.devAuth === true;

  /** null = signed out, undefined = initial auth state not yet restored. */
  readonly user = signal<User | null | undefined>(undefined);
  readonly error = signal<string | null>(null);

  /** Resolves once the auth state has been restored (or cleared). */
  readonly ready: Promise<void>;

  constructor() {
    if (this.devMode) {
      this.user.set(this.readDevFlag() ? devUser() : null);
      this.ready = Promise.resolve();
      return;
    }
    // Complete a redirect sign-in if one is pending (mobile/WebView flow).
    void getRedirectResult(firebaseAuth).catch((err) => {
      this.error.set(err instanceof Error ? err.message : 'Sign-in failed.');
    });
    this.ready = new Promise((resolve) => {
      onAuthStateChanged(firebaseAuth, (user) => {
        this.user.set(user);
        resolve();
      });
    });
  }

  async loginWithGoogle(returnUrl = '/'): Promise<void> {
    this.error.set(null);
    if (this.devMode) {
      this.writeDevFlag(true);
      this.user.set(devUser());
      await this.router.navigateByUrl(returnUrl);
      return;
    }
    const provider = new GoogleAuthProvider();
    try {
      const google = nativeGoogle();
      if (google) {
        // The phone: Android's account picker, then the same Firebase session
        // the website and desktop app get.
        const { idToken } = await google.signIn({ serverClientId: firebaseConfig.googleWebClientId });
        await signInWithCredential(firebaseAuth, GoogleAuthProvider.credential(idToken));
        await this.router.navigateByUrl(returnUrl);
        return;
      }
      if (this.native.isNative) {
        // An older phone build without the plugin: a full-page redirect is the
        // only WebView-compatible flow Firebase offers.
        await signInWithRedirect(firebaseAuth, provider);
        return;
      }
      await signInWithPopup(firebaseAuth, provider);
      await this.router.navigateByUrl(returnUrl);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'cancelled') {
        return;
      }
      this.error.set(err instanceof Error ? err.message : 'Sign-in failed.');
    }
  }

  /** Bearer token for the sync server: the dev uid, or the Firebase ID token. */
  async idToken(): Promise<string> {
    if (this.devMode) {
      return DEV_UID;
    }
    const user = firebaseAuth.currentUser;
    if (!user) {
      throw new Error('Not signed in.');
    }
    return user.getIdToken();
  }

  async logout(): Promise<void> {
    if (this.devMode) {
      this.writeDevFlag(false);
      this.user.set(null);
      await this.router.navigateByUrl('/login');
      return;
    }
    await signOut(firebaseAuth);
    // Forget the chosen account so the picker asks again next time.
    await nativeGoogle()?.signOut().catch(() => undefined);
    await this.router.navigateByUrl('/login');
  }

  private readDevFlag(): boolean {
    try {
      return localStorage.getItem(DEV_FLAG) === '1';
    } catch {
      return false;
    }
  }

  private writeDevFlag(signedIn: boolean): void {
    try {
      if (signedIn) {
        localStorage.setItem(DEV_FLAG, '1');
      } else {
        localStorage.removeItem(DEV_FLAG);
      }
    } catch {
      // Best effort; dev mode still works for the current session.
    }
  }
}
