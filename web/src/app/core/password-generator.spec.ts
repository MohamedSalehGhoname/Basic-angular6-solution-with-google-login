import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PASSWORD_OPTIONS,
  generatePassword,
  type PasswordOptions,
} from './password-generator';

const opts = (over: Partial<PasswordOptions> = {}): PasswordOptions => ({
  ...DEFAULT_PASSWORD_OPTIONS,
  ...over,
});

describe('generatePassword', () => {
  it('produces a password of the requested length', () => {
    expect(generatePassword(opts({ length: 24 }))).toHaveLength(24);
    expect(generatePassword(opts({ length: 12 }))).toHaveLength(12);
  });

  it('includes at least one of each selected class', () => {
    const pw = generatePassword(opts({ length: 20 }));
    expect(pw).toMatch(/[a-z]/);
    expect(pw).toMatch(/[A-Z]/);
    expect(pw).toMatch(/[0-9]/);
    expect(pw).toMatch(/[^A-Za-z0-9]/);
  });

  it('only uses the selected classes', () => {
    const pw = generatePassword(opts({ length: 40, symbols: false, uppercase: false }));
    expect(pw).toMatch(/^[a-z0-9]+$/);
  });

  it('avoids ambiguous characters', () => {
    const pw = generatePassword(opts({ length: 200 }));
    expect(pw).not.toMatch(/[lo0O1I]/);
  });

  it('throws when no character class is selected', () => {
    expect(() =>
      generatePassword(opts({ lowercase: false, uppercase: false, digits: false, symbols: false })),
    ).toThrowError(/at least one/);
  });

  it('is effectively always unique', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generatePassword(opts())));
    expect(seen.size).toBe(50);
  });

  it('never returns fewer characters than the number of required classes', () => {
    // Length 2 but 4 classes required → bumped to 4.
    expect(generatePassword(opts({ length: 2 })).length).toBe(4);
  });
});
