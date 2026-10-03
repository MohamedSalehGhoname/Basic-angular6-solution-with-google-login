import type { ImportEntry, ParsedKeePass } from './keepass-import';
import { TOTP_DEFAULTS, parseTotp } from './totp';

/**
 * Import from a browser's exported password file: Chrome's
 * (Settings ▸ Autofill ▸ Google Password Manager ▸ Settings ▸ Export), which
 * Edge, Brave and Opera copy, and the same shape from Firefox, Bitwarden and
 * the rest — the columns are read by name, so one parser covers them all.
 *
 * Read on the device like every other import; the file never leaves it. Such
 * an export holds every password in the clear, which is why the screen that
 * uses this tells the user to delete it afterwards.
 */

/** A browser export has no folders, so everything lands at the top level. */
export type ParsedCsv = ParsedKeePass & {
  /** Rows that carried nothing worth keeping (no password and no username). */
  emptyRowsSkipped: number;
  /** Entries that also brought a two-factor key. */
  withTotp: number;
};

/** Header names each field is known by, lowercased. */
const COLUMNS = {
  title: ['name', 'title', 'account', 'account name', 'item name', 'display name'],
  url: [
    'url',
    'urls',
    'website',
    'web site',
    'site',
    'login_uri',
    'login uri',
    'hostname',
    'origin',
  ],
  username: [
    'username',
    'user name',
    'login_username',
    'login username',
    'login',
    'user',
    'email',
    'e-mail',
  ],
  password: ['password', 'login_password', 'login password', 'pass'],
  notes: ['note', 'notes', 'comment', 'comments', 'extra'],
  totp: ['totp', 'login_totp', 'otpauth', 'otp', 'two-factor', 'authenticator key', 'totpauth'],
} as const;

type Field = keyof typeof COLUMNS;

/**
 * Splits CSV text into rows of fields, following RFC 4180: a quoted field may
 * hold the delimiter, line breaks, and doubled quotes. Exports carry notes
 * with newlines in them, so a line-by-line split would corrupt the file.
 */
export function parseCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  // A byte-order mark would otherwise become part of the first header.
  const input = text.replace(/^﻿/, '');

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') {
        i += 1;
      }
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // A trailing newline leaves one empty row behind.
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/** Whichever separator the header line uses; Excel in some locales writes ';'. */
function sniffDelimiter(text: string): string {
  const firstLine = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', ';', '\t'].map((candidate) => ({
    candidate,
    count: firstLine.split(candidate).length - 1,
  }));
  counts.sort((a, b) => b.count - a.count);
  return counts[0].count > 0 ? counts[0].candidate : ',';
}

function mapColumns(header: string[]): Partial<Record<Field, number>> {
  const found: Partial<Record<Field, number>> = {};
  header.forEach((raw, index) => {
    const name = raw.trim().toLowerCase().replace(/^"|"$/g, '');
    for (const field of Object.keys(COLUMNS) as Field[]) {
      if (found[field] === undefined && (COLUMNS[field] as readonly string[]).includes(name)) {
        found[field] = index;
      }
    }
  });
  return found;
}

/** The site's name, for a row whose export left the name column out. */
function hostOf(url: string): string {
  const text = url.trim();
  if (!text) {
    return '';
  }
  try {
    return new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`).hostname.replace(
      /^www\./,
      '',
    );
  } catch {
    return text;
  }
}

export function parseCsvPasswords(text: string): ParsedCsv {
  const rows = parseCsvRows(text, sniffDelimiter(text));
  if (rows.length === 0) {
    throw new Error('not-csv');
  }
  const columns = mapColumns(rows[0]);
  // A password file has to have somewhere to read a password or a username
  // from; anything else is a different CSV that would import as noise.
  if (columns.password === undefined && columns.username === undefined) {
    throw new Error('not-csv');
  }

  const entries: ImportEntry[] = [];
  let emptyRowsSkipped = 0;
  let withTotp = 0;

  for (const cells of rows.slice(1)) {
    const at = (field: Field): string => {
      const index = columns[field];
      return index === undefined ? '' : (cells[index] ?? '').trim();
    };
    const username = at('username');
    const password = at('password');
    if (!username && !password) {
      emptyRowsSkipped += 1;
      continue;
    }
    const url = at('url');
    const entry: ImportEntry = {
      title: at('title') || hostOf(url) || username || 'Untitled',
      username,
      password,
      url,
      notes: at('notes'),
    };
    // Some managers export the two-factor key beside the password; keeping it
    // saves the user from re-scanning every QR code they ever set up.
    const totp = at('totp') ? parseTotp(at('totp')) : null;
    if (totp) {
      entry.totp = totp.secret;
      entry.totpDigits = totp.digits === TOTP_DEFAULTS.digits ? null : totp.digits;
      entry.totpPeriod = totp.period === TOTP_DEFAULTS.period ? null : totp.period;
      entry.totpAlgorithm = totp.algorithm === TOTP_DEFAULTS.algorithm ? null : totp.algorithm;
      withTotp += 1;
    }
    entries.push(entry);
  }

  if (entries.length === 0) {
    throw new Error('not-csv');
  }
  return {
    root: { name: '', icon: '', entries, children: [] },
    groupCount: 0,
    entryCount: entries.length,
    withAttachments: 0,
    emptyRowsSkipped,
    withTotp,
  };
}
