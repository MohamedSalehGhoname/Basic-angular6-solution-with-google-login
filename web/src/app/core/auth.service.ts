import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import { firebaseAuth } from './firebase';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly router = inject(Router);

  /** null = signed out, undefined = initial auth state not yet restored. */
  readonly user = signal<User | null | undefined>(undefined);
  readonly error = signal<string | null>(null);

  /** Resolves once Firebase has restored (or cleared) the persisted session. */
  readonly ready: Promise<void>;

  constructor() {
    this.ready = new Promise((resolve) => {
      onAuthStateChanged(firebaseAuth, (user) => {
        this.user.set(user);
        resolve();
      });
    });
  }

  async loginWithGoogle(returnUrl = '/'): Promise<void> {
    this.error.set(null);
    try {
      await signInWithPopup(firebaseAuth, new GoogleAuthProvider());
      await this.router.navigateByUrl(returnUrl);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Sign-in failed.');
    }
  }

  async logout(): Promise<void> {
    await signOut(firebaseAuth);
    await this.router.navigateByUrl('/login');
  }
}
