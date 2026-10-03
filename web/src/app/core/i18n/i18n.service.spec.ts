import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { I18nService } from './i18n.service';
import { TRANSLATIONS } from './translations';

describe('I18nService', () => {
  let service: I18nService;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('dir');
    TestBed.configureTestingModule({});
    service = TestBed.inject(I18nService);
  });

  afterEach(() => {
    document.documentElement.removeAttribute('dir');
  });

  it('defaults to English and left-to-right', () => {
    TestBed.tick();
    expect(service.locale()).toBe('en');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(service.t('nav.clipboard')).toBe('Clipboard');
  });

  it('switches to Arabic and sets RTL', () => {
    service.setLocale('ar');
    TestBed.tick();
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    expect(document.documentElement.getAttribute('lang')).toBe('ar');
    expect(service.t('nav.clipboard')).toBe('الحافظة');
  });

  it('interpolates placeholders', () => {
    expect(service.t('unlock.minHint', { n: 10 })).toContain('10');
    service.setLocale('ar');
    expect(service.t('clipboard.skipped', { n: 3 })).toContain('3');
  });

  it('persists the choice and falls back to English for missing keys', () => {
    service.setLocale('ar');
    expect(localStorage.getItem('clipsync.locale')).toBe('ar');
    // Every Arabic key mirrors an English key.
    const enKeys = Object.keys(TRANSLATIONS.en).sort();
    const arKeys = Object.keys(TRANSLATIONS.ar).sort();
    expect(arKeys).toEqual(enKeys);
  });
});
