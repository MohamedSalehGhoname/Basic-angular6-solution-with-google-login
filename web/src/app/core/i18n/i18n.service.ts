import { Injectable, effect, signal } from '@angular/core';
import { TRANSLATIONS, type Locale, type TranslationKey } from './translations';

const STORAGE_KEY = 'clipsync.locale';

/**
 * Runtime localization. `t()` reads the `locale` signal, so template bindings
 * that call it re-render when the language changes. Arabic switches the
 * document to RTL.
 */
@Injectable({ providedIn: 'root' })
export class I18nService {
  private readonly _locale = signal<Locale>(this.read());
  readonly locale = this._locale.asReadonly();

  constructor() {
    effect(() => {
      const locale = this._locale();
      const root = document.documentElement;
      root.setAttribute('lang', locale);
      root.setAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    });
  }

  setLocale(locale: Locale): void {
    this._locale.set(locale);
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // Preference only.
    }
  }

  /** Translates a key, interpolating {name} placeholders from `params`. */
  t(key: TranslationKey, params?: Record<string, string | number>): string {
    const table = TRANSLATIONS[this._locale()] as Record<string, string>;
    let text = table[key] ?? (TRANSLATIONS.en as Record<string, string>)[key] ?? key;
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
    }
    return text;
  }

  private read(): Locale {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'ar' ? 'ar' : 'en';
    } catch {
      return 'en';
    }
  }
}
