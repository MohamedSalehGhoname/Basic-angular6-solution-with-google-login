import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { formatCode, totpCode } from './totp';
import { TotpService } from './totp.service';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQ';

describe('TotpService', () => {
  let service: TotpService;

  /** Waits for the code of `id` to be derived (WebCrypto, so asynchronous). */
  const waitForCode = async (id: string, digits = 6): Promise<string> => {
    const dots = '·'.repeat(digits);
    for (let i = 0; i < 100; i++) {
      const code = service.liveCode(id, { totp: RFC_SECRET, totpDigits: digits });
      if (code !== dots) {
        return code;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('The code was never derived.');
  };

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(TotpService);
  });

  it('has nothing to show for an entry without a key', () => {
    expect(service.liveCode('id', { totp: null })).toBe('');
    expect(service.secondsLeft({ totp: null })).toBe(0);
  });

  it('shows placeholder dots first, then the real code', async () => {
    // Templates read codes synchronously, so the first read cannot have one
    // yet — it must return something the same width and fill in after.
    const first = service.liveCode('id', { totp: RFC_SECRET });
    expect(first).toBe('······');

    const expected = formatCode(
      await totpCode({ secret: RFC_SECRET, digits: 6, period: 30, algorithm: 'SHA-1' }),
    );
    expect(await waitForCode('id')).toBe(expected);
  });

  it('sizes the placeholder to the digit count', () => {
    expect(service.liveCode('id', { totp: RFC_SECRET, totpDigits: 8 })).toBe('········');
  });

  it('keeps two entries on the same key apart', async () => {
    await waitForCode('a');
    // 'b' has never been computed, so it is still waiting even though 'a' holds
    // a code for the very same secret.
    expect(service.liveCode('b', { totp: RFC_SECRET })).toBe('······');
  });

  it('counts down within the period', () => {
    const left = service.secondsLeft({ totp: RFC_SECRET });
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(30);
  });

  it('reads the settings off an entry, defaulting the rest', () => {
    expect(service.config({ totp: RFC_SECRET })).toEqual({
      secret: RFC_SECRET,
      digits: 6,
      period: 30,
      algorithm: 'SHA-1',
    });
    expect(service.config({ totp: RFC_SECRET, totpPeriod: 60, totpAlgorithm: 'SHA-256' })).toEqual({
      secret: RFC_SECRET,
      digits: 6,
      period: 60,
      algorithm: 'SHA-256',
    });
  });
});
