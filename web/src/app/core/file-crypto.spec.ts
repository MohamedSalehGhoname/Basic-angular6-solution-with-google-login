import { describe, expect, it } from 'vitest';
import { decryptFile, encryptedSize, fromBase64, newFileKey, toBase64 } from './file-crypto';

// Produced by the desktop app's EncryptStream(key = 32×0x07, chunk 16,
// prefix 01..08); keep in sync with desktop/test/file-sharing.spec.ts.
const VECTOR_PLAIN = 'Clipboard Sync shared test vector, three chunks!';
const VECTOR =
  'Q1NGMQAAABABAgMEBQYHCL6d/6qTGlqozzdwam5xukw+4a5O+YKLFFqmA4qa3Q6EboTlgCv+kgwzfoB16bde1oK+ajnEnSpXoikj+fUS4/jkkcVaJkZiNPlctDQA+F2Oq+KYl5f41SC5YUZvRU4ivQ==';
const VECTOR_KEY = new Uint8Array(32).fill(7);

describe('file crypto', () => {
  it('decrypts what the desktop app encrypted', async () => {
    const plain = await decryptFile(fromBase64(VECTOR), VECTOR_KEY);
    expect(new TextDecoder().decode(plain)).toBe(VECTOR_PLAIN);
  });

  it('predicts the encrypted size the desktop app produces', () => {
    expect(encryptedSize(VECTOR_PLAIN.length, 16)).toBe(fromBase64(VECTOR).length);
    expect(encryptedSize(1)).toBe(33);
    expect(encryptedSize(1024 * 1024)).toBe(16 + 1024 * 1024 + 16);
    expect(encryptedSize(1024 * 1024 + 1)).toBe(16 + 1024 * 1024 + 1 + 32);
  });

  it('rejects the wrong key', async () => {
    await expect(decryptFile(fromBase64(VECTOR), new Uint8Array(32))).rejects.toThrow(/decrypt/);
  });

  it('rejects a truncated file', async () => {
    const sealed = fromBase64(VECTOR);
    // Drop the final chunk: the one before it was sealed as "not last".
    await expect(decryptFile(sealed.subarray(0, 16 + 2 * 32), VECTOR_KEY)).rejects.toThrow();
  });

  it('rejects data that is not an encrypted file', async () => {
    await expect(decryptFile(new Uint8Array(40), VECTOR_KEY)).rejects.toThrow(/Not an encrypted/);
  });

  it('makes distinct 32-byte keys that survive base64', () => {
    const a = newFileKey();
    expect(fromBase64(a)).toHaveLength(32);
    expect(a).not.toBe(newFileKey());
    expect(toBase64(fromBase64(a))).toBe(a);
  });
});
