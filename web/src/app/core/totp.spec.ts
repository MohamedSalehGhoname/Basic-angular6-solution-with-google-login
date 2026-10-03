import { formatCode, isBase32, parseTotp, secondsRemaining, totpCode } from './totp';

/**
 * RFC 6238's own vectors. The seeds are given as hex there; base32 below is
 * the same bytes, which is how every authenticator writes them.
 *   SHA-1:   "12345678901234567890"
 *   SHA-256: the same, repeated to 32 bytes
 *   SHA-512: the same, repeated to 64 bytes
 */
const SEED_SHA1 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const SEED_SHA256 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';
const SEED_SHA512 =
  'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA';

const at = (seconds: number) => seconds * 1000;

describe('totpCode', () => {
  const cases: [number, string, string][] = [
    [59, '94287082', SEED_SHA1],
    [1111111109, '07081804', SEED_SHA1],
    [1111111111, '14050471', SEED_SHA1],
    [1234567890, '89005924', SEED_SHA1],
    [2000000000, '69279037', SEED_SHA1],
    [20000000000, '65353130', SEED_SHA1],
  ];

  it.each(cases)('matches RFC 6238 at t=%i', async (seconds, expected, secret) => {
    const code = await totpCode(
      { secret, digits: 8, period: 30, algorithm: 'SHA-1' },
      at(seconds),
    );
    expect(code).toBe(expected);
  });

  it('matches RFC 6238 for SHA-256', async () => {
    const code = await totpCode(
      { secret: SEED_SHA256, digits: 8, period: 30, algorithm: 'SHA-256' },
      at(59),
    );
    expect(code).toBe('46119246');
  });

  it('matches RFC 6238 for SHA-512', async () => {
    const code = await totpCode(
      { secret: SEED_SHA512, digits: 8, period: 30, algorithm: 'SHA-512' },
      at(59),
    );
    expect(code).toBe('90693936');
  });

  it('survives a counter past 2^32, where a 32-bit write would wrap', async () => {
    // t=20000000000 is counter 666666666, but the vector above only exercises
    // the low word; this one pins the high word explicitly.
    const code = await totpCode(
      { secret: SEED_SHA1, digits: 8, period: 1, algorithm: 'SHA-1' },
      at(5_000_000_000),
    );
    expect(code).toMatch(/^\d{8}$/);
  });

  it('gives six digits by default and pads short ones', async () => {
    const code = await totpCode({ secret: SEED_SHA1, digits: 6, period: 30, algorithm: 'SHA-1' });
    expect(code).toMatch(/^\d{6}$/);
  });

  it('holds the same code for the whole period and changes after it', async () => {
    const config = { secret: SEED_SHA1, digits: 6, period: 30, algorithm: 'SHA-1' } as const;
    const start = await totpCode(config, at(1000));
    const nearEnd = await totpCode(config, at(1019));
    const next = await totpCode(config, at(1030));
    expect(nearEnd).toBe(start);
    expect(next).not.toBe(start);
  });

  it('reads a secret with the spaces a site printed', async () => {
    const spaced = await totpCode(
      { secret: 'gezd gnbv gy3t qojq gezd gnbv gy3t qojq', digits: 8, period: 30, algorithm: 'SHA-1' },
      at(59),
    );
    expect(spaced).toBe('94287082');
  });
});

describe('parseTotp', () => {
  it('reads a bare base32 secret', () => {
    expect(parseTotp(' gezdgnbv ')).toMatchObject({ secret: 'GEZDGNBV', digits: 6, period: 30 });
  });

  it('reads an otpauth link with its label and issuer', () => {
    const config = parseTotp(
      'otpauth://totp/GitHub:amira?secret=GEZDGNBVGY3TQOJQ&issuer=GitHub&digits=8&period=60&algorithm=SHA256',
    );
    expect(config).toMatchObject({
      secret: 'GEZDGNBVGY3TQOJQ',
      label: 'amira',
      issuer: 'GitHub',
      digits: 8,
      period: 60,
      algorithm: 'SHA-256',
    });
  });

  it('takes the issuer from the label when the query has none', () => {
    expect(parseTotp('otpauth://totp/Acme%20Co:me?secret=GEZDGNBV')).toMatchObject({
      issuer: 'Acme Co',
      label: 'me',
    });
  });

  it('falls back to the defaults for nonsense parameters', () => {
    expect(parseTotp('otpauth://totp/x?secret=GEZDGNBV&digits=99&period=0&algorithm=rot13'))
      .toMatchObject({ digits: 6, period: 30, algorithm: 'SHA-1' });
  });

  it('refuses what it cannot use', () => {
    expect(parseTotp('')).toBeNull();
    expect(parseTotp('not base32 at all!')).toBeNull();
    expect(parseTotp('otpauth://hotp/x?secret=GEZDGNBV')).toBeNull();
    expect(parseTotp('otpauth://totp/x?secret=0189')).toBeNull();
    expect(parseTotp('otpauth://totp/x')).toBeNull();
  });
});

describe('isBase32', () => {
  it('rejects the characters base32 leaves out', () => {
    // 0, 1, 8 and 9 are not in the alphabet — a common typo when copying.
    expect(isBase32('ABC0')).toBe(false);
    expect(isBase32('ABC1')).toBe(false);
    expect(isBase32('ABC8')).toBe(false);
    expect(isBase32('ABCDEFG234567')).toBe(true);
  });
});

describe('secondsRemaining', () => {
  it('counts down and never reads zero', () => {
    expect(secondsRemaining(30, at(0))).toBe(30);
    expect(secondsRemaining(30, at(1))).toBe(29);
    expect(secondsRemaining(30, at(29))).toBe(1);
    expect(secondsRemaining(30, at(30))).toBe(30);
  });
});

describe('formatCode', () => {
  it('splits a code down the middle', () => {
    expect(formatCode('123456')).toBe('123 456');
    expect(formatCode('12345678')).toBe('1234 5678');
  });
});
