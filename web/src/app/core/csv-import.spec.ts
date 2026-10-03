import { describe, expect, it } from 'vitest';
import { parseCsvPasswords, parseCsvRows } from './csv-import';

/** What Chrome writes today (Google Password Manager ▸ Export passwords). */
const CHROME = `name,url,username,password,note
github.com,https://github.com/login,octocat,hunter2,
example.com,https://example.com/,me@example.com,"pa,ss""word",a note
`;

describe('parseCsvRows', () => {
  it('keeps a delimiter, a quote and a line break inside a quoted field', () => {
    const rows = parseCsvRows('a,b\n"x,y","he said ""hi""","line1\nline2"\n', ',');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x,y', 'he said "hi"', 'line1\nline2'],
    ]);
  });

  it('reads CRLF files and drops the empty last line', () => {
    expect(parseCsvRows('a,b\r\n1,2\r\n', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('parseCsvPasswords', () => {
  it('reads a Chrome export', () => {
    const parsed = parseCsvPasswords(CHROME);
    expect(parsed.entryCount).toBe(2);
    expect(parsed.groupCount).toBe(0);
    expect(parsed.root.entries[0]).toEqual({
      title: 'github.com',
      username: 'octocat',
      password: 'hunter2',
      url: 'https://github.com/login',
      notes: '',
    });
    // The password had both a comma and an escaped quote in it.
    expect(parsed.root.entries[1].password).toBe('pa,ss"word');
    expect(parsed.root.entries[1].notes).toBe('a note');
  });

  it('strips a byte-order mark before reading the header', () => {
    expect(parseCsvPasswords(`﻿${CHROME}`).entryCount).toBe(2);
  });

  it('reads a semicolon-separated export', () => {
    const parsed = parseCsvPasswords('name;url;username;password\nBank;https://bank.test;me;pw\n');
    expect(parsed.root.entries[0].username).toBe('me');
    expect(parsed.root.entries[0].password).toBe('pw');
  });

  it('names an entry after its site when the export has no name column', () => {
    const parsed = parseCsvPasswords(
      '"url","username","password"\n"https://www.mozilla.org/en/","me","pw"\n',
    );
    expect(parsed.root.entries[0].title).toBe('mozilla.org');
  });

  it('falls back to the username when there is no name and no url', () => {
    const parsed = parseCsvPasswords('username,password\nsolo,pw\n');
    expect(parsed.root.entries[0].title).toBe('solo');
  });

  it('skips rows with neither a username nor a password', () => {
    const parsed = parseCsvPasswords(`${CHROME}empty.test,https://empty.test,,,\n`);
    expect(parsed.entryCount).toBe(2);
    expect(parsed.emptyRowsSkipped).toBe(1);
  });

  it('keeps a two-factor key that came with the row', () => {
    const parsed = parseCsvPasswords(
      'name,username,password,login_totp\n' +
        'Work,me,pw,otpauth://totp/Work:me?secret=GEZDGNBVGY3TQOJQ&digits=8&period=60\n',
    );
    expect(parsed.withTotp).toBe(1);
    const entry = parsed.root.entries[0];
    expect(entry.totp).toBe('GEZDGNBVGY3TQOJQ');
    expect(entry.totpDigits).toBe(8);
    expect(entry.totpPeriod).toBe(60);
  });

  it('leaves the defaults off a plain base32 key', () => {
    const parsed = parseCsvPasswords('name,username,password,totp\nA,me,pw,GEZDGNBVGY3TQOJQ\n');
    const entry = parsed.root.entries[0];
    expect(entry.totp).toBe('GEZDGNBVGY3TQOJQ');
    expect(entry.totpDigits).toBeNull();
    expect(entry.totpPeriod).toBeNull();
  });

  it('ignores a two-factor column that holds something else', () => {
    const parsed = parseCsvPasswords('name,username,password,totp\nA,me,pw,not-a-key!\n');
    expect(parsed.withTotp).toBe(0);
    expect(parsed.root.entries[0].totp).toBeUndefined();
  });

  it('refuses a CSV that is not a password file', () => {
    expect(() => parseCsvPasswords('date,amount,payee\n2026-01-01,5,Shop\n')).toThrow('not-csv');
  });

  it('refuses a file with a header and nothing else', () => {
    expect(() => parseCsvPasswords('name,url,username,password,note\n')).toThrow('not-csv');
  });
});
