/**
 * Browser side of the "CSF1" chunked AES-256-GCM file format that the desktop
 * app encrypts with (desktop/src/file-crypto.ts — the format is documented
 * there; keep the two in step).
 *
 * Files are always encrypted on the desktop, which streams from disk; the
 * browser only decrypts, and does it in memory.
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
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

export async function decryptFile(data: Uint8Array, rawKey: Uint8Array): Promise<Uint8Array> {
  if (data.length < HEADER_BYTES || MAGIC.some((byte, i) => data[i] !== byte)) {
    throw new Error('Not an encrypted clipboard file');
  }
  const chunkBytes = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4);
  if (chunkBytes < 1 || chunkBytes > 64 * 1024 * 1024) {
    throw new Error('Encrypted file has an invalid header');
  }
  const prefix = data.slice(8, HEADER_BYTES);
  const body = data.subarray(HEADER_BYTES);
  const pieceBytes = chunkBytes + TAG_BYTES;
  const count = Math.max(1, Math.ceil(body.length / pieceBytes));
  if (body.length < count * TAG_BYTES) {
    throw new Error('Encrypted file is truncated');
  }

  const key = await crypto.subtle.importKey('raw', copy(rawKey), 'AES-GCM', false, ['decrypt']);
  const out = new Uint8Array(body.length - count * TAG_BYTES);
  let offset = 0;
  for (let i = 0; i < count; i += 1) {
    const iv = new Uint8Array(12);
    iv.set(prefix);
    new DataView(iv.buffer).setUint32(8, i);
    const last = i === count - 1;
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: new Uint8Array([last ? 1 : 0]) },
        key,
        copy(body.subarray(i * pieceBytes, Math.min((i + 1) * pieceBytes, body.length))),
      );
    } catch {
      throw new Error('Could not decrypt the file: wrong key or damaged data');
    }
    out.set(new Uint8Array(plain), offset);
    offset += plain.byteLength;
  }
  return out;
}

/** WebCrypto wants a plain ArrayBuffer of exactly the bytes to use. */
function copy(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
