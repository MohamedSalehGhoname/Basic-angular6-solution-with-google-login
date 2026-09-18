import { Injectable } from '@angular/core';
import sodium from 'libsodium-wrappers-sumo';

/**
 * Key-derivation cost parameters. Stored alongside the salt so existing
 * vaults keep decrypting when the defaults are raised later.
 */
export interface KdfParams {
  opsLimit: number;
  memLimit: number;
}

/**
 * Zero-knowledge encryption layer. The server must only ever see the
 * ciphertext blobs produced here: the master key is derived client-side
 * from the user's passphrase and never leaves the device.
 *
 * Scheme:
 * - Argon2id stretches the passphrase (+ per-user random salt) into a
 *   32-byte master key.
 * - The master key only wraps a random vault key (`wrapKey`/`unwrapKey`),
 *   so a passphrase change re-wraps one key instead of re-encrypting
 *   every item.
 * - Each clipboard/secret item is an independent XChaCha20-Poly1305 blob
 *   with a fresh random nonce, serialized as `xcv1:<base64url(nonce ‖
 *   ciphertext)>`.
 * - Device enrollment (wrapping the vault key to another device's keypair)
 *   comes with the sync layer.
 */
@Injectable({ providedIn: 'root' })
export class CryptoService {
  /** Resolves when the WASM module is loaded; all methods await it. */
  readonly ready: Promise<void> = sodium.ready;

  private static readonly BLOB_PREFIX = 'xcv1:';

  async generateSalt(): Promise<Uint8Array> {
    await this.ready;
    return sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  }

  /** Argon2id defaults for new vaults (libsodium MODERATE: 256 MiB, 3 passes). */
  async defaultKdfParams(): Promise<KdfParams> {
    await this.ready;
    return {
      opsLimit: sodium.crypto_pwhash_OPSLIMIT_MODERATE,
      memLimit: sodium.crypto_pwhash_MEMLIMIT_MODERATE,
    };
  }

  async deriveMasterKey(
    passphrase: string,
    salt: Uint8Array,
    params?: KdfParams,
  ): Promise<Uint8Array> {
    await this.ready;
    const { opsLimit, memLimit } = params ?? (await this.defaultKdfParams());
    return sodium.crypto_pwhash(
      sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
      passphrase,
      salt,
      opsLimit,
      memLimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
  }

  async generateVaultKey(): Promise<Uint8Array> {
    await this.ready;
    return sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  }

  async wrapKey(key: Uint8Array, wrappingKey: Uint8Array): Promise<string> {
    return this.encryptBytes(key, wrappingKey);
  }

  async unwrapKey(blob: string, wrappingKey: Uint8Array): Promise<Uint8Array> {
    return this.decryptBytes(blob, wrappingKey);
  }

  async encryptItem(plaintext: string, key: Uint8Array): Promise<string> {
    return this.encryptBytes(plaintext, key);
  }

  async decryptItem(blob: string, key: Uint8Array): Promise<string> {
    return sodium.to_string(await this.decryptBytes(blob, key));
  }

  /** Best-effort scrubbing of key material once it is no longer needed. */
  async zeroize(key: Uint8Array): Promise<void> {
    await this.ready;
    sodium.memzero(key);
  }

  // A string message is passed through so libsodium does the UTF-8 encoding
  // itself; converting here can produce a foreign-realm Uint8Array that its
  // input check rejects (seen under jsdom in tests).
  private async encryptBytes(plaintext: Uint8Array | string, key: Uint8Array): Promise<string> {
    await this.ready;
    const nonce = sodium.randombytes_buf(
      sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
    );
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      null,
      null,
      nonce,
      key,
    );
    const packed = new Uint8Array(nonce.length + ciphertext.length);
    packed.set(nonce);
    packed.set(ciphertext, nonce.length);
    return (
      CryptoService.BLOB_PREFIX +
      sodium.to_base64(packed, sodium.base64_variants.URLSAFE_NO_PADDING)
    );
  }

  private async decryptBytes(blob: string, key: Uint8Array): Promise<Uint8Array> {
    await this.ready;
    if (!blob.startsWith(CryptoService.BLOB_PREFIX)) {
      throw new Error('Unrecognized ciphertext format');
    }
    const nonceBytes = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    let packed: Uint8Array;
    try {
      packed = sodium.from_base64(
        blob.slice(CryptoService.BLOB_PREFIX.length),
        sodium.base64_variants.URLSAFE_NO_PADDING,
      );
    } catch {
      throw new Error('Corrupted ciphertext encoding');
    }
    if (packed.length <= nonceBytes) {
      throw new Error('Ciphertext too short');
    }
    try {
      return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        packed.subarray(nonceBytes),
        null,
        packed.subarray(0, nonceBytes),
        key,
      );
    } catch {
      throw new Error('Decryption failed: wrong key or tampered data');
    }
  }
}
