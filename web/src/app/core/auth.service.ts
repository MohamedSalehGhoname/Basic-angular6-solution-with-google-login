import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from 'firebase/auth';
import { syncConfig } from '../sync.config';
import { firebaseAuth } from './firebase';
import { NativeBridge } from './native-bridge.service';

const DEV_UID = 'local-dev-user';
const DEV_FLAG = 'clipsync.devSignedIn';

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
      if (this.native.isNative) {
        // Popups do not work inside a mobile WebView; use a full-page redirect.
        // Firebase restores the session on return and onAuthStateChanged fires.
        await signInWithRedirect(firebaseAuth, provider);
        return;
      }
      await signInWithPopup(firebaseAuth, provider);
      await this.router.navigateByUrl(returnUrl);
    } catch (err) {
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
