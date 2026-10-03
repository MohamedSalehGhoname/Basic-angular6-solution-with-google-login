import { Injectable, effect, signal } from '@angular/core';

export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'clipsync.theme';

/**
 * Owns the light/dark theme. 'system' follows the OS; an explicit choice sets
 * `data-theme` on the document, which the token stylesheet keys off. The
 * preference is per-device (localStorage), not synced.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _preference = signal<ThemePreference>(this.read());
  readonly preference = this._preference.asReadonly();

  constructor() {
    effect(() => this.apply(this._preference()));
  }

  set(preference: ThemePreference): void {
    this._preference.set(preference);
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Preference only.
    }
  }

  /** Cycles system → light → dark → system for a single toggle button. */
  cycle(): void {
    const order: ThemePreference[] = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(this._preference()) + 1) % order.length]!;
    this.set(next);
  }

  private apply(preference: ThemePreference): void {
    const root = document.documentElement;
    if (preference === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', preference);
    }
  }

  private read(): ThemePreference {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
    } catch {
      return 'system';
    }
  }
}
