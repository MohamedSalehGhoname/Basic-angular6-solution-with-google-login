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
import { firebaseAuth } from './firebase';
import { NativeBridge } from './native-bridge.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly router = inject(Router);
  private readonly native = inject(NativeBridge);

  /** null = signed out, undefined = initial auth state not yet restored. */
  readonly user = signal<User | null | undefined>(undefined);
  readonly error = signal<string | null>(null);

  /** Resolves once Firebase has restored (or cleared) the persisted session. */
  readonly ready: Promise<void>;

  constructor() {
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

  /** Fresh Firebase ID token for authenticating against the sync server. */
  async idToken(): Promise<string> {
    const user = firebaseAuth.currentUser;
    if (!user) {
      throw new Error('Not signed in.');
    }
    return user.getIdToken();
  }

  async logout(): Promise<void> {
    await signOut(firebaseAuth);
    await this.router.navigateByUrl('/login');
  }
}
