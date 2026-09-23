/**
 * Browser side of the "CSF1" chunked AES-256-GCM file format that the desktop
 * app encrypts with (desktop/src/file-crypto.ts — the format is documented
 * there; keep the two in step).
 *
 * Files are always encrypted on a device that streams from disk; here we only
 * decrypt, piece by piece, so a large file never has to sit in memory.
 */
const MAGIC = [0x43, 0x53, 0x46, 0x31]; // "CSF1"
const HEADER_BYTES = 16;
const TAG_BYTES = 16;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;

/** Size of the encrypted form of a file of `plainBytes` (≥ 1) bytes. */
export function encryptedSize(plainBytes: number, chunkBytes = DEFAULT_CHUNK_BYTES): number {
  return HEADER_BYTES + plainBytes + TAG_BYTES * Math.max(1, Math.ceil(plainBytes / chunkBytes));
}

/** A fresh random 256-bit file key, base64 (standard alphabet). */
export function newFileKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // In slices: one String.fromCharCode call per byte is slow, and spreading
  // a whole file at once overflows the argument stack.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/**
 * Decrypts a CSF1 stream as it arrives. Feed it the bytes in any sizes;
 * every call returns the plaintext that could be authenticated so far. A
 * chunk is held back until more data proves it is not the last one, which is
 * what makes a truncated file fail instead of decrypting short.
 */
export class Csf1Decryptor {
  private pending = new Uint8Array(0);
  private key: CryptoKey | null = null;
  private prefix: Uint8Array | null = null;
  private pieceBytes = 0;
  private index = 0;

  constructor(private readonly rawKey: Uint8Array) {}

  async push(data: Uint8Array): Promise<Uint8Array[]> {
    this.append(data);
    const out: Uint8Array[] = [];
    if (!(await this.readHeader())) {
      return out;
    }
    while (this.pending.length > this.pieceBytes) {
      out.push(await this.open(this.take(this.pieceBytes), false));
    }
    return out;
  }

  /** Finishes the stream: the remainder is the last chunk. */
  async finish(): Promise<Uint8Array> {
    if (!(await this.readHeader())) {
      throw new Error('Encrypted file is truncated');
    }
    return this.open(this.take(this.pending.length), true);
  }

  private append(data: Uint8Array): void {
    const merged = new Uint8Array(this.pending.length + data.length);
    merged.set(this.pending);
    merged.set(data, this.pending.length);
    this.pending = merged;
  }

  private take(bytes: number): Uint8Array {
    const piece = this.pending.subarray(0, bytes);
    this.pending = this.pending.subarray(bytes);
    return piece;
  }

  private async readHeader(): Promise<boolean> {
    if (this.key) {
      return true;
    }
    if (this.pending.length < HEADER_BYTES) {
      return false;
    }
    const header = this.take(HEADER_BYTES);
    if (MAGIC.some((byte, i) => header[i] !== byte)) {
      throw new Error('Not an encrypted clipboard file');
    }
    const chunkBytes = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(4);
    if (chunkBytes < 1 || chunkBytes > 64 * 1024 * 1024) {
      throw new Error('Encrypted file has an invalid header');
    }
    this.pieceBytes = chunkBytes + TAG_BYTES;
    this.prefix = header.slice(8, HEADER_BYTES);
    this.key = await crypto.subtle.importKey('raw', copy(this.rawKey), 'AES-GCM', false, ['decrypt']);
    return true;
  }

  private async open(sealed: Uint8Array, last: boolean): Promise<Uint8Array> {
    if (sealed.length < TAG_BYTES) {
      throw new Error('Encrypted file is truncated');
    }
    const iv = new Uint8Array(12);
    iv.set(this.prefix!);
    new DataView(iv.buffer).setUint32(8, this.index);
    this.index += 1;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: new Uint8Array([last ? 1 : 0]) },
        this.key!,
        copy(sealed),
      );
      return new Uint8Array(plain);
    } catch {
      throw new Error('Could not decrypt the file: wrong key or damaged data');
    }
  }
}

/** Decrypts a whole file held in memory (small files, and the tests). */
export async function decryptFile(data: Uint8Array, rawKey: Uint8Array): Promise<Uint8Array> {
  const decryptor = new Csf1Decryptor(rawKey);
  const pieces = await decryptor.push(data);
  pieces.push(await decryptor.finish());
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.length;
  }
  return out;
}

/** WebCrypto wants a plain ArrayBuffer of exactly the bytes to use. */
function copy(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
