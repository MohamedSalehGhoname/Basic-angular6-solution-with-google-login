import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecryptStream, EncryptStream, encryptedSize } from '../src/file-crypto.js';
import { downloadFile, uniquePath, uploadFile } from '../src/file-transfer.js';
import { contextMenuCommands, filesFromArgv, sendToShortcut } from '../src/shell-menu.js';

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) {
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts);
}

/** Feeds `data` in awkward slices so chunk boundaries never line up with writes. */
function feed(data: Buffer, slice = 7): Readable {
  const pieces: Buffer[] = [];
  for (let i = 0; i < data.length; i += slice) {
    pieces.push(data.subarray(i, i + slice));
  }
  return Readable.from(pieces);
}

const encrypt = (data: Buffer, key: Buffer, chunk: number) =>
  collect(feed(data).pipe(new EncryptStream(key, chunk)));
const decrypt = (data: Buffer, key: Buffer) => collect(feed(data).pipe(new DecryptStream(key)));

describe('file encryption', () => {
  const key = randomBytes(32);

  for (const size of [1, 15, 16, 17, 48, 100]) {
    it(`round-trips ${size} bytes and matches the predicted size`, async () => {
      const plain = randomBytes(size);
      const sealed = await encrypt(plain, key, 16);
      expect(sealed.length).toBe(encryptedSize(size, 16));
      expect(await decrypt(sealed, key)).toEqual(plain);
    });
  }

  it('uses a fresh nonce every time', async () => {
    const plain = Buffer.from('same input');
    expect(await encrypt(plain, key, 16)).not.toEqual(await encrypt(plain, key, 16));
  });

  it('rejects the wrong key', async () => {
    const sealed = await encrypt(randomBytes(40), key, 16);
    await expect(decrypt(sealed, randomBytes(32))).rejects.toThrow(/decrypt/);
  });

  it('rejects a flipped bit', async () => {
    const sealed = await encrypt(randomBytes(40), key, 16);
    sealed[30] ^= 1;
    await expect(decrypt(sealed, key)).rejects.toThrow();
  });

  it('rejects a file cut at a chunk boundary', async () => {
    // 3 chunks of 16; drop the last one entirely. The second chunk was sealed
    // as "not last", so it must not pass as the end of the file.
    const sealed = await encrypt(randomBytes(48), key, 16);
    const cut = sealed.subarray(0, 16 + 2 * (16 + 16));
    await expect(decrypt(cut, key)).rejects.toThrow();
  });

  it('rejects swapped chunks', async () => {
    const sealed = await encrypt(randomBytes(48), key, 16);
    const a = sealed.subarray(16, 48);
    const b = sealed.subarray(48, 80);
    const swapped = Buffer.concat([sealed.subarray(0, 16), b, a, sealed.subarray(80)]);
    await expect(decrypt(swapped, key)).rejects.toThrow();
  });

  it('rejects something that is not an encrypted file', async () => {
    await expect(decrypt(randomBytes(64), key)).rejects.toThrow(/Not an encrypted/);
  });

  it('decrypts the shared test vector the web client also checks', async () => {
    // Keep in sync with web/src/app/core/file-crypto.spec.ts.
    const vectorKey = Buffer.alloc(32, 7);
    const sealed = Buffer.from(VECTOR, 'base64');
    expect((await decrypt(sealed, vectorKey)).toString()).toBe(VECTOR_PLAIN);
  });
});

// Encrypted with EncryptStream(key = 32×0x07, chunk 16, prefix 01..08).
const VECTOR_PLAIN = 'Clipboard Sync shared test vector, three chunks!';
const VECTOR =
  'Q1NGMQAAABABAgMEBQYHCL6d/6qTGlqozzdwam5xukw+4a5O+YKLFFqmA4qa3Q6EboTlgCv+kgwzfoB16bde1oK+ajnEnSpXoikj+fUS4/jkkcVaJkZiNPlctDQA+F2Oq+KYl5f41SC5YUZvRU4ivQ==';

describe('file transfer', () => {
  let server: Server;
  let base: string;
  let stored: Buffer = Buffer.alloc(0);
  let seenLength: string | undefined;
  let seenEncoding: string | undefined;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'clipsync-'));
    server = createServer(async (req, res) => {
      if (req.method === 'PUT') {
        seenLength = req.headers['content-length'];
        seenEncoding = req.headers['transfer-encoding'];
        stored = await collect(req);
        res.writeHead(200).end();
      } else if (req.url === '/missing') {
        res.writeHead(404).end();
      } else {
        res.writeHead(200, { 'content-length': stored.length }).end(stored);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('uploads encrypted with an exact length, then downloads and decrypts', async () => {
    const plain = randomBytes(3 * 1024 * 1024 + 5);
    const source = join(dir, 'report.pdf');
    await writeFile(source, plain);
    const key = randomBytes(32);

    const progress: number[] = [];
    await uploadFile(source, `${base}/put`, key, (done) => progress.push(done));
    expect(seenEncoding).toBeUndefined();
    expect(Number(seenLength)).toBe(encryptedSize(plain.length));
    expect(stored.length).toBe(encryptedSize(plain.length));
    expect(stored.includes(plain.subarray(0, 64))).toBe(false);
    expect(progress.at(-1)).toBe(stored.length);

    const out = await mkdtemp(join(tmpdir(), 'clipsync-out-'));
    const saved = await downloadFile(`${base}/get`, out, 'report.pdf', key);
    expect(saved).toBe(join(out, 'report.pdf'));
    expect((await readFile(saved)).equals(plain)).toBe(true);
  });

  it('sends a file as-is when no key is given', async () => {
    const source = join(dir, 'notes.txt');
    await writeFile(source, 'plain words');
    await uploadFile(source, `${base}/put`, null);
    expect(stored.toString()).toBe('plain words');
  });

  it('leaves no partial file behind when decryption fails', async () => {
    const source = join(dir, 'a.bin');
    await writeFile(source, randomBytes(100));
    await uploadFile(source, `${base}/put`, randomBytes(32));
    const out = await mkdtemp(join(tmpdir(), 'clipsync-out-'));
    await expect(downloadFile(`${base}/get`, out, 'a.bin', randomBytes(32))).rejects.toThrow();
    expect(await readdir(out)).toEqual([]);
  });

  it('fails on an error status', async () => {
    const out = await mkdtemp(join(tmpdir(), 'clipsync-out-'));
    await expect(downloadFile(`${base}/missing`, out, 'x', null)).rejects.toThrow(/404/);
  });

  it('never overwrites an existing download and strips path tricks from names', async () => {
    const out = await mkdtemp(join(tmpdir(), 'clipsync-out-'));
    await writeFile(join(out, 'photo.png'), 'old');
    expect(await uniquePath(out, 'photo.png')).toBe(join(out, 'photo (2).png'));
    expect(await uniquePath(out, '..\\..\\evil:name.png')).toBe(join(out, 'evil_name.png'));
  });
});

describe('Explorer menu', () => {
  it('reads every sent file from a command line', () => {
    expect(
      filesFromArgv(['electron.exe', '.', '--send-file', 'C:\\a b\\x.txt', '--send-file', 'y']),
    ).toEqual(['C:\\a b\\x.txt', 'y']);
    expect(filesFromArgv(['app.exe'])).toEqual([]);
    expect(filesFromArgv(['app.exe', '--send-file'])).toEqual([]);
  });

  it('takes every file "Send to" appends, ignoring switches Chromium adds', () => {
    expect(
      filesFromArgv([
        'electron.exe',
        'C:\\src\\desktop',
        '--send-files',
        'C:\\a.txt',
        '--allow-file-access-from-files',
        'D:\\b c.pdf',
      ]),
    ).toEqual(['C:\\a.txt', 'D:\\b c.pdf']);
  });

  it('points the Send to shortcut at the app with the multi-file switch', () => {
    const dev = sendToShortcut('C:\\AppData', 'C:\\e\\electron.exe', 'C:\\src\\desktop');
    expect(dev.path).toBe('C:\\AppData\\Microsoft\\Windows\\SendTo\\Clipboard Sync.lnk');
    expect(dev.args).toBe('"C:\\src\\desktop" --send-files');
    expect(sendToShortcut('C:\\AppData', 'C:\\app.exe', null).args).toBe('--send-files');
  });

  it('launches the packaged exe directly and the dev binary with the app folder', () => {
    const packaged = contextMenuCommands('C:\\Apps\\Clipboard Sync.exe', null);
    expect(packaged.at(-1)).toContain('"C:\\Apps\\Clipboard Sync.exe" --send-file "%1"');
    const dev = contextMenuCommands('C:\\e\\electron.exe', 'C:\\src\\desktop');
    expect(dev.at(-1)).toContain('"C:\\e\\electron.exe" "C:\\src\\desktop" --send-file "%1"');
  });
});
