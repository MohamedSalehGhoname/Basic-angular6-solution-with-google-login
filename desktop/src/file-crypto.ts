import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

/**
 * Chunked AES-256-GCM for files sent to the clipboard ("CSF1"), streamed so a
 * large file never sits in memory. The web client decrypts the same format
 * with WebCrypto (web/src/app/core/file-crypto.ts); keep the two in step.
 *
 *   header  = "CSF1" ‖ chunkSize (u32 BE) ‖ noncePrefix (8 random bytes)
 *   chunk i = AES-256-GCM(key, iv = noncePrefix ‖ i (u32 BE), aad = [isLast])
 *             → ciphertext ‖ 16-byte tag
 *
 * Every chunk but the last holds exactly chunkSize plaintext bytes. The
 * last-chunk flag in the AAD makes truncation or appended chunks fail to
 * authenticate, and the index in the IV stops reordering.
 */
export const MAGIC = Buffer.from('CSF1', 'ascii');
export const HEADER_BYTES = 16;
export const TAG_BYTES = 16;
export const DEFAULT_CHUNK_BYTES = 1024 * 1024;

/** Size of the encrypted form of a file of `plainBytes` (≥ 1) bytes. */
export function encryptedSize(plainBytes: number, chunkBytes = DEFAULT_CHUNK_BYTES): number {
  return HEADER_BYTES + plainBytes + TAG_BYTES * Math.max(1, Math.ceil(plainBytes / chunkBytes));
}

function iv(prefix: Buffer, index: number): Buffer {
  const out = Buffer.alloc(12);
  prefix.copy(out, 0);
  out.writeUInt32BE(index, 8);
  return out;
}

function sealChunk(key: Buffer, prefix: Buffer, index: number, last: boolean, plain: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, iv(prefix, index));
  cipher.setAAD(Buffer.from([last ? 1 : 0]));
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function openChunk(key: Buffer, prefix: Buffer, index: number, last: boolean, sealed: Buffer): Buffer {
  if (sealed.length < TAG_BYTES) {
    throw new Error('Encrypted file is truncated');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv(prefix, index));
  decipher.setAAD(Buffer.from([last ? 1 : 0]));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new Error('Could not decrypt the file: wrong key or damaged data');
  }
}

/**
 * Buffers input and emits fixed-size pieces, holding the newest piece back
 * until more data proves it is not the last one.
 */
abstract class ChunkingTransform extends Transform {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  protected index = 0;

  protected abstract readonly pieceBytes: number;
  protected abstract process(piece: Buffer, last: boolean): Buffer;

  protected shift(bytes: number): Buffer {
    const all = Buffer.concat(this.pending);
    const piece = all.subarray(0, bytes);
    const rest = all.subarray(bytes);
    this.pending = rest.length ? [rest] : [];
    this.pendingBytes = rest.length;
    return piece;
  }

  protected get buffered(): number {
    return this.pendingBytes;
  }

  /** False while a prefix (the header) still has to be read. */
  protected ready(): boolean {
    return true;
  }

  override _transform(data: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    try {
      this.pending.push(data);
      this.pendingBytes += data.length;
      while (this.ready() && this.pendingBytes > this.pieceBytes) {
        this.push(this.process(this.shift(this.pieceBytes), false));
        this.index += 1;
      }
      done();
    } catch (err) {
      done(err as Error);
    }
  }

  override _flush(done: TransformCallback): void {
    try {
      if (!this.ready()) {
        throw new Error('Encrypted file is truncated');
      }
      this.push(this.process(this.shift(this.pendingBytes), true));
      done();
    } catch (err) {
      done(err as Error);
    }
  }
}

export class EncryptStream extends ChunkingTransform {
  protected readonly pieceBytes: number;
  private readonly prefix: Buffer;

  constructor(
    private readonly key: Buffer,
    chunkBytes = DEFAULT_CHUNK_BYTES,
    prefix: Buffer = randomBytes(8),
  ) {
    super();
    if (key.length !== 32) {
      throw new Error('File key must be 32 bytes');
    }
    this.pieceBytes = chunkBytes;
    this.prefix = prefix;
    const header = Buffer.alloc(HEADER_BYTES);
    MAGIC.copy(header, 0);
    header.writeUInt32BE(chunkBytes, 4);
    prefix.copy(header, 8);
    this.push(header);
  }

  protected process(piece: Buffer, last: boolean): Buffer {
    return sealChunk(this.key, this.prefix, this.index, last, piece);
  }
}

export class DecryptStream extends ChunkingTransform {
  protected pieceBytes = Number.MAX_SAFE_INTEGER;
  private prefix: Buffer | null = null;

  constructor(private readonly key: Buffer) {
    super();
    if (key.length !== 32) {
      throw new Error('File key must be 32 bytes');
    }
  }

  protected override ready(): boolean {
    if (this.prefix) {
      return true;
    }
    if (this.buffered < HEADER_BYTES) {
      return false;
    }
    const header = this.shift(HEADER_BYTES);
    if (!header.subarray(0, 4).equals(MAGIC)) {
      throw new Error('Not an encrypted clipboard file');
    }
    const chunkBytes = header.readUInt32BE(4);
    if (chunkBytes < 1 || chunkBytes > 64 * 1024 * 1024) {
      throw new Error('Encrypted file has an invalid header');
    }
    this.pieceBytes = chunkBytes + TAG_BYTES;
    this.prefix = Buffer.from(header.subarray(8, 16));
    return true;
  }

  protected process(piece: Buffer, last: boolean): Buffer {
    return openChunk(this.key, this.prefix!, this.index, last, piece);
  }
}
