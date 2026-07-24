import { Injectable } from '@angular/core';

/**
 * Seam for the end-to-end encryption layer. The server must only ever see
 * ciphertext: the master key is derived client-side from the user's
 * passphrase and never leaves the device.
 *
 * Planned design:
 * - Argon2id (via libsodium) stretches the passphrase into a master key.
 * - The master key wraps a random symmetric vault key.
 * - Each clipboard/secret item is an independent XChaCha20-Poly1305 blob.
 * - New devices are enrolled by wrapping the vault key to their device
 *   keypair, approved from an already-enrolled device.
 */
@Injectable({ providedIn: 'root' })
export class CryptoService {
  async deriveMasterKey(passphrase: string): Promise<CryptoKey> {
    throw new Error('Not implemented: Argon2id key derivation');
  }

  async encryptItem(plaintext: string): Promise<ArrayBuffer> {
    throw new Error('Not implemented: XChaCha20-Poly1305 encryption');
  }

  async decryptItem(ciphertext: ArrayBuffer): Promise<string> {
    throw new Error('Not implemented: XChaCha20-Poly1305 decryption');
  }
}
