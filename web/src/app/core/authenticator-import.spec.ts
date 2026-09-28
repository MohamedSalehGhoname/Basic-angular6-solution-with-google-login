import { describe, expect, it } from 'vitest';
import { accountTitle, parseMigration, toBase32 } from './authenticator-import';

// A protobuf writer built from the schema Authenticator's export follows,
// independent of the reader under test, so a shared mistake cannot pass.
const varint = (value: number): number[] => {
  const out: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
};
const tag = (field: number, wire: number): number[] => varint((field << 3) | wire);
const bytesField = (field: number, value: Uint8Array | string): number[] => {
  const bytes = typeof value === 'string' ? [...new TextEncoder().encode(value)] : [...value];
  return [...tag(field, 2), ...varint(bytes.length), ...bytes];
};
const varintField = (field: number, value: number): number[] => [
  ...tag(field, 0),
  ...varint(value),
];

interface AccountInput {
  secret: Uint8Array;
  label?: string;
  issuer?: string;
  /** 1 = SHA-1, 2 = SHA-256, 3 = SHA-512 */
  algorithm?: number;
  /** 1 = six digits, 2 = eight */
  digits?: number;
  /** 1 = HOTP, 2 = TOTP */
  type?: number;
}

const account = (input: AccountInput): number[] => [
  ...bytesField(1, input.secret),
  ...(input.label === undefined ? [] : bytesField(2, input.label)),
  ...(input.issuer === undefined ? [] : bytesField(3, input.issuer)),
  ...(input.algorithm === undefined ? [] : varintField(4, input.algorithm)),
  ...(input.digits === undefined ? [] : varintField(5, input.digits)),
  ...varintField(6, input.type ?? 2),
];

const migrationUri = (
  accounts: AccountInput[],
  batch?: { count?: number; index?: number; id?: number; extra?: number[] },
): string => {
  const payload = [
    ...accounts.flatMap((input) => bytesField(1, new Uint8Array(account(input)))),
    ...varintField(2, 1),
    ...varintField(3, batch?.count ?? 1),
    ...varintField(4, batch?.index ?? 0),
    ...varintField(5, batch?.id ?? 12345),
    ...(batch?.extra ?? []),
  ];
  const base64 = btoa(String.fromCharCode(...payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `otpauth-migration://offline?data=${encodeURIComponent(base64)}`;
};

/** The bytes behind the secret every Authenticator guide uses as its example. */
const HELLO = new Uint8Array([...new TextEncoder().encode('Hello!'), 0xde, 0xad, 0xbe, 0xef]);

describe('toBase32', () => {
  it('matches the known encoding of the Authenticator example secret', () => {
    expect(toBase32(HELLO)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('matches the RFC 6238 seed', () => {
    expect(toBase32(new TextEncoder().encode('12345678901234567890'))).toBe(
      'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    );
  });

  it('pads the last group of an odd-length secret', () => {
    expect(toBase32(new Uint8Array([0x61]))).toBe('ME');
  });
});

describe('parseMigration', () => {
  it('reads one exported account with its defaults', () => {
    const batch = parseMigration(migrationUri([{ secret: HELLO, label: 'me@example.com' }]));
    expect(batch.accounts).toEqual([
      {
        secret: 'JBSWY3DPEHPK3PXP',
        label: 'me@example.com',
        issuer: '',
        digits: 6,
        period: 30,
        algorithm: 'SHA-1',
      },
    ]);
    expect(batch.hotpSkipped).toBe(0);
  });

  it('keeps eight-digit and SHA-256 settings', () => {
    const batch = parseMigration(
      migrationUri([{ secret: HELLO, label: 'a', algorithm: 2, digits: 2 }]),
    );
    expect(batch.accounts[0].digits).toBe(8);
    expect(batch.accounts[0].algorithm).toBe('SHA-256');
  });

  it('reads several accounts from one code', () => {
    const batch = parseMigration(
      migrationUri([
        { secret: HELLO, label: 'GitHub:octocat' },
        { secret: HELLO, label: 'Bank:me', issuer: 'Bank' },
      ]),
    );
    expect(batch.accounts.length).toBe(2);
  });

  it('counts counter-based accounts as skipped instead of importing them', () => {
    const batch = parseMigration(
      migrationUri([
        { secret: HELLO, label: 'timed' },
        { secret: HELLO, label: 'counter', type: 1 },
      ]),
    );
    expect(batch.accounts.length).toBe(1);
    expect(batch.hotpSkipped).toBe(1);
  });

  it('reports which of how many QR codes this is, counting from one', () => {
    const batch = parseMigration(
      migrationUri([{ secret: HELLO, label: 'a' }], { count: 3, index: 1, id: 777 }),
    );
    expect(batch.index).toBe(2);
    expect(batch.count).toBe(3);
    expect(batch.batchId).toBe(777);
  });

  it('steps over fields it does not know', () => {
    // A future version adding a field must not break the import.
    const extra = [...varintField(9, 42), ...bytesField(10, 'whatever')];
    const batch = parseMigration(migrationUri([{ secret: HELLO, label: 'a' }], { extra }));
    expect(batch.accounts.length).toBe(1);
  });

  it('refuses a plain otpauth link, junk, and an empty payload', () => {
    expect(() => parseMigration('otpauth://totp/A?secret=JBSWY3DPEHPK3PXP')).toThrow(
      'not-migration',
    );
    expect(() => parseMigration('otpauth-migration://offline?data=%%%')).toThrow('not-migration');
    expect(() => parseMigration('otpauth-migration://offline')).toThrow('not-migration');
    expect(() => parseMigration(migrationUri([]))).toThrow('not-migration');
  });
});

describe('accountTitle', () => {
  const base = { secret: 'X', digits: 6, period: 30, algorithm: 'SHA-1' } as const;

  it('reads the issuer out of an "Issuer:account" label', () => {
    expect(accountTitle({ ...base, label: 'GitHub:octocat', issuer: '' })).toBe('GitHub (octocat)');
  });

  it('prefers the issuer field when the export carries one', () => {
    expect(accountTitle({ ...base, label: 'Bank:me', issuer: 'Northbank' })).toBe('Northbank (me)');
  });

  it('does not repeat a name that is its own issuer', () => {
    expect(accountTitle({ ...base, label: 'Dropbox', issuer: 'Dropbox' })).toBe('Dropbox');
  });

  it('falls back to something rather than an empty name', () => {
    expect(accountTitle({ ...base, label: '', issuer: '' })).toBe('Authenticator');
  });
});
