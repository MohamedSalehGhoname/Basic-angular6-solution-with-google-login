/**
 * Time-based one-time passwords (RFC 6238), the six-digit codes an
 * authenticator app shows.
 *
 * Keeping them beside the password they belong to is the point: one place to
 * look, one thing to back up, and the code is encrypted with everything else.
 * That also means the secret is as sensitive as the password — anyone holding
 * it can mint codes forever — so it never leaves the vault in clear text.
 */

export interface TotpConfig {
  /** The shared secret, base32 as every authenticator writes it. */
  secret: string;
  /** Shown beside the code; taken from an otpauth:// link when there is one. */
  label?: string;
  issuer?: string;
  digits: number;
  /** Seconds each code is valid for. */
  period: number;
  algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512';
}

export const TOTP_DEFAULTS = {
  digits: 6,
  period: 30,
  algorithm: 'SHA-1',
} as const;

/**
 * Reads what the user pasted: either an otpauth:// link (what a QR code
 * holds) or a bare base32 secret, with or without the spaces sites like to
 * print. Returns null when it is neither.
 */
export function parseTotp(input: string): TotpConfig | null {
  const text = input.trim();
  if (!text) {
    return null;
  }
  if (/^otpauth:\/\//i.test(text)) {
    return parseOtpAuthUri(text);
  }
  const secret = normaliseSecret(text);
  return isBase32(secret) ? { secret, ...TOTP_DEFAULTS } : null;
}

function parseOtpAuthUri(uri: string): TotpConfig | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  // otpauth://totp/Issuer:account?secret=...&issuer=...&digits=6&period=30
  if (parsed.host.toLowerCase() !== 'totp') {
    // hotp and anything else counts differently and is not supported.
    return null;
  }
  const secret = normaliseSecret(parsed.searchParams.get('secret') ?? '');
  if (!isBase32(secret)) {
    return null;
  }
  const path = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const [maybeIssuer, maybeLabel] = path.includes(':') ? path.split(':', 2) : [undefined, path];
  const digits = positiveInt(parsed.searchParams.get('digits'), TOTP_DEFAULTS.digits);
  const period = positiveInt(parsed.searchParams.get('period'), TOTP_DEFAULTS.period);
  return {
    secret,
    label: maybeLabel?.trim() || undefined,
    issuer: (parsed.searchParams.get('issuer') ?? maybeIssuer)?.trim() || undefined,
    digits: digits >= 6 && digits <= 10 ? digits : TOTP_DEFAULTS.digits,
    period: period > 0 ? period : TOTP_DEFAULTS.period,
    algorithm: algorithmOf(parsed.searchParams.get('algorithm')),
  };
}

function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function algorithmOf(value: string | null): TotpConfig['algorithm'] {
  switch ((value ?? '').toUpperCase()) {
    case 'SHA256':
    case 'SHA-256':
      return 'SHA-256';
    case 'SHA512':
    case 'SHA-512':
      return 'SHA-512';
    default:
      return 'SHA-1';
  }
}

/** Uppercases and drops the spaces and padding people paste along with it. */
export function normaliseSecret(secret: string): string {
  return secret.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function isBase32(secret: string): boolean {
  return secret.length > 0 && [...secret].every((char) => BASE32_ALPHABET.includes(char));
}

function base32Decode(secret: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of secret) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error('Not base32');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/**
 * The code for a moment in time. `atMs` is injectable so tests can stand on
 * the RFC's vectors instead of the clock.
 */
export async function totpCode(config: TotpConfig, atMs: number = Date.now()): Promise<string> {
  const counter = Math.floor(atMs / 1000 / config.period);
  const key = base32Decode(normaliseSecret(config.secret));

  // The counter goes in as eight bytes, big-endian.
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as unknown as ArrayBuffer,
    { name: 'HMAC', hash: config.algorithm },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, message as unknown as ArrayBuffer));

  // Dynamic truncation: the last nibble picks where to read four bytes from.
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);

  return (binary % 10 ** config.digits).toString().padStart(config.digits, '0');
}

/** How long the current code has left, in whole seconds. */
export function secondsRemaining(period: number, atMs: number = Date.now()): number {
  return period - (Math.floor(atMs / 1000) % period);
}

/** Groups a code for reading: 123456 -> "123 456". */
export function formatCode(code: string): string {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)} ${code.slice(half)}`;
}
