import { TOTP_DEFAULTS, type TotpConfig } from './totp';

/**
 * Import from Google Authenticator's "Transfer accounts ▸ Export accounts".
 *
 * That screen shows QR codes holding `otpauth-migration://offline?data=…`,
 * where the data is a base64 protobuf — not the plain otpauth:// link a site
 * gives you, so it has to be decoded field by field. Google publishes no
 * schema for it; the fields below are the ones the app writes, and anything
 * else in the payload is stepped over rather than guessed at.
 *
 * A long list is split over several QR codes ("2 of 3"), so a caller scans
 * until every batch is in.
 */

export interface MigrationAccount extends TotpConfig {
  /** What Authenticator showed for it, used to name the entry. */
  label: string;
  issuer: string;
}

export interface MigrationBatch {
  accounts: MigrationAccount[];
  /** 1-based position of this QR code, and how many there are in total. */
  index: number;
  count: number;
  /** Identifies the export these codes belong to, so two are not mixed up. */
  batchId: number;
  /** Counter-based (HOTP) accounts, which this app cannot take over. */
  hotpSkipped: number;
}

/** Wire types we can read; anything else means the payload is not ours. */
const VARINT = 0;
const FIXED64 = 1;
const LENGTH_DELIMITED = 2;
const FIXED32 = 5;

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.done) {
        throw new Error('not-migration');
      }
      const byte = this.bytes[this.offset++];
      // These numbers are small (digit counts, indexes); multiplying rather
      // than shifting keeps them right past 32 bits all the same.
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        return result;
      }
      shift += 7;
      if (shift > 56) {
        throw new Error('not-migration');
      }
    }
  }

  bytesField(): Uint8Array {
    const length = this.varint();
    if (this.offset + length > this.bytes.length) {
      throw new Error('not-migration');
    }
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  skip(wireType: number): void {
    switch (wireType) {
      case VARINT:
        this.varint();
        return;
      case LENGTH_DELIMITED:
        this.bytesField();
        return;
      case FIXED64:
        this.offset += 8;
        return;
      case FIXED32:
        this.offset += 4;
        return;
      default:
        throw new Error('not-migration');
    }
  }
}

/** Walks the top-level fields as {field number, wire type, reader}. */
function* fields(bytes: Uint8Array): Generator<{ field: number; wire: number; reader: Reader }> {
  const reader = new Reader(bytes);
  while (!reader.done) {
    const tag = reader.varint();
    yield { field: tag >>> 3, wire: tag & 0x07, reader };
  }
}

const ALGORITHMS: Record<number, TotpConfig['algorithm']> = {
  0: 'SHA-1', // unspecified
  1: 'SHA-1',
  2: 'SHA-256',
  3: 'SHA-512',
};

const DIGITS: Record<number, number> = { 0: 6, 1: 6, 2: 8 };

const OTP_TOTP = 2;

/** base32 as every authenticator writes a secret, unpadded. */
export function toBase32(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += alphabet[(value << (5 - bits)) & 31];
  }
  return out;
}

function fromBase64Url(text: string): Uint8Array {
  const normalised = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function parseAccount(bytes: Uint8Array): { account: MigrationAccount | null; hotp: boolean } {
  let secret: Uint8Array | null = null;
  let label = '';
  let issuer = '';
  let algorithm: TotpConfig['algorithm'] = TOTP_DEFAULTS.algorithm;
  let digits: number = TOTP_DEFAULTS.digits;
  let type = OTP_TOTP;
  const text = new TextDecoder();

  for (const { field, wire, reader } of fields(bytes)) {
    if (field === 1 && wire === LENGTH_DELIMITED) {
      secret = reader.bytesField();
    } else if (field === 2 && wire === LENGTH_DELIMITED) {
      label = text.decode(reader.bytesField());
    } else if (field === 3 && wire === LENGTH_DELIMITED) {
      issuer = text.decode(reader.bytesField());
    } else if (field === 4 && wire === VARINT) {
      algorithm = ALGORITHMS[reader.varint()] ?? TOTP_DEFAULTS.algorithm;
    } else if (field === 5 && wire === VARINT) {
      digits = DIGITS[reader.varint()] ?? TOTP_DEFAULTS.digits;
    } else if (field === 6 && wire === VARINT) {
      type = reader.varint();
    } else {
      reader.skip(wire);
    }
  }

  if (!secret || secret.length === 0) {
    return { account: null, hotp: false };
  }
  if (type !== OTP_TOTP) {
    // A counter-based code has to stay in step with the server's counter,
    // which is a different promise from the one this app keeps.
    return { account: null, hotp: true };
  }
  // Authenticator has no interval field: every code it makes runs on 30s.
  return {
    account: {
      secret: toBase32(secret),
      label: label.trim(),
      issuer: issuer.trim(),
      digits,
      period: TOTP_DEFAULTS.period,
      algorithm,
    },
    hotp: false,
  };
}

/**
 * Reads one exported QR code. Throws 'not-migration' for anything that is not
 * one of Authenticator's export codes — a plain otpauth:// link included,
 * since the caller already knows what to do with one of those.
 */
export function parseMigration(uri: string): MigrationBatch {
  const text = uri.trim();
  if (!/^otpauth-migration:\/\//i.test(text)) {
    throw new Error('not-migration');
  }
  let data: string | null;
  try {
    data = new URL(text).searchParams.get('data');
  } catch {
    throw new Error('not-migration');
  }
  if (!data) {
    throw new Error('not-migration');
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(data);
  } catch {
    throw new Error('not-migration');
  }

  const accounts: MigrationAccount[] = [];
  let hotpSkipped = 0;
  let count = 1;
  let index = 1;
  let batchId = 0;
  for (const { field, wire, reader } of fields(bytes)) {
    if (field === 1 && wire === LENGTH_DELIMITED) {
      const { account, hotp } = parseAccount(reader.bytesField());
      if (account) {
        accounts.push(account);
      } else if (hotp) {
        hotpSkipped += 1;
      }
    } else if (field === 3 && wire === VARINT) {
      count = reader.varint();
    } else if (field === 4 && wire === VARINT) {
      // Stored from zero; people count QR codes from one.
      index = reader.varint() + 1;
    } else if (field === 5 && wire === VARINT) {
      batchId = reader.varint();
    } else {
      reader.skip(wire);
    }
  }

  if (accounts.length === 0 && hotpSkipped === 0) {
    throw new Error('not-migration');
  }
  return { accounts, index, count: Math.max(count, index), batchId, hotpSkipped };
}

/** The name an imported account gets: "Issuer (account)" reads best. */
export function accountTitle(account: MigrationAccount): string {
  // Authenticator writes the label as "Issuer:account" when it knows both.
  const [first, ...rest] = account.label.split(':');
  const bare = rest.length > 0 ? rest.join(':').trim() : account.label.trim();
  const issuer = account.issuer || (rest.length > 0 ? first.trim() : '');
  if (issuer && bare && issuer.toLowerCase() !== bare.toLowerCase()) {
    return `${issuer} (${bare})`;
  }
  return issuer || bare || 'Authenticator';
}
