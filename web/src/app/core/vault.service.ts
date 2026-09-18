import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { CryptoService, type KdfParams } from './crypto.service';

export type VaultStatus = 'uninitialized' | 'locked' | 'unlocked';

/**
 * Persisted per account. None of this is secret: the wrapped vault key is
 * only recoverable with the passphrase, and the salt + KDF params must be
 * readable to attempt an unlock. Stored in localStorage until the sync
 * server exists, which will hold the same record.
 */
interface VaultMetadata {
  version: 1;
  salt: string;
  opsLimit: number;
  memLimit: number;
  wrappedKey: string;
}

/**
 * Owns the unlocked vault key, which lives only in memory: navigating away
 * or reloading locks the vault. Pages encrypt/decrypt through this service
 * and never see key material.
 */
@Injectable({ providedIn: 'root' })
export class VaultService {
  private readonly crypto = inject(CryptoService);
  private readonly auth = inject(AuthService);

  private vaultKey: Uint8Array | null = null;
  private readonly unlockedUid = signal<string | null>(null);

  readonly status = computed<VaultStatus>(() => {
    const user = this.auth.user();
    if (!user) {
      return 'locked';
    }
    if (this.unlockedUid() === user.uid) {
      return 'unlocked';
    }
    return this.readMetadata(user.uid) ? 'locked' : 'uninitialized';
  });

  constructor() {
    // Account switch or sign-out must not leave the previous user's key in memory.
    effect(() => {
      const uid = this.auth.user()?.uid ?? null;
      if (this.unlockedUid() !== null && this.unlockedUid() !== uid) {
        this.lock();
      }
    });
  }

  async createVault(passphrase: string, params?: KdfParams): Promise<void> {
    const uid = this.requireUid();
    const salt = await this.crypto.generateSalt();
    const kdf = params ?? (await this.crypto.defaultKdfParams());
    const masterKey = await this.crypto.deriveMasterKey(passphrase, salt, kdf);
    try {
      const vaultKey = await this.crypto.generateVaultKey();
      const metadata: VaultMetadata = {
        version: 1,
        salt: await this.crypto.toBase64(salt),
        opsLimit: kdf.opsLimit,
        memLimit: kdf.memLimit,
        wrappedKey: await this.crypto.wrapKey(vaultKey, masterKey),
      };
      this.writeMetadata(uid, metadata);
      this.setUnlocked(uid, vaultKey);
    } finally {
      await this.crypto.zeroize(masterKey);
    }
  }

  async unlock(passphrase: string): Promise<void> {
    const uid = this.requireUid();
    const metadata = this.readMetadata(uid);
    if (!metadata) {
      throw new Error('No vault exists for this account yet.');
    }
    const masterKey = await this.crypto.deriveMasterKey(
      passphrase,
      await this.crypto.fromBase64(metadata.salt),
      { opsLimit: metadata.opsLimit, memLimit: metadata.memLimit },
    );
    try {
      const vaultKey = await this.crypto.unwrapKey(metadata.wrappedKey, masterKey);
      this.setUnlocked(uid, vaultKey);
    } catch {
      throw new Error('Incorrect passphrase.');
    } finally {
      await this.crypto.zeroize(masterKey);
    }
  }

  lock(): void {
    if (this.vaultKey) {
      // Fire-and-forget: zeroize only awaits the already-resolved sodium.ready.
      void this.crypto.zeroize(this.vaultKey);
      this.vaultKey = null;
    }
    this.unlockedUid.set(null);
  }

  async encryptItem(plaintext: string): Promise<string> {
    return this.crypto.encryptItem(plaintext, this.requireVaultKey());
  }

  async decryptItem(blob: string): Promise<string> {
    return this.crypto.decryptItem(blob, this.requireVaultKey());
  }

  private setUnlocked(uid: string, vaultKey: Uint8Array): void {
    if (this.vaultKey) {
      void this.crypto.zeroize(this.vaultKey);
    }
    this.vaultKey = vaultKey;
    this.unlockedUid.set(uid);
  }

  private requireUid(): string {
    const uid = this.auth.user()?.uid;
    if (!uid) {
      throw new Error('Not signed in.');
    }
    return uid;
  }

  private requireVaultKey(): Uint8Array {
    if (!this.vaultKey || this.status() !== 'unlocked') {
      throw new Error('Vault is locked.');
    }
    return this.vaultKey;
  }

  private storageKey(uid: string): string {
    return `clipsync.vault.${uid}`;
  }

  private readMetadata(uid: string): VaultMetadata | null {
    try {
      const raw = localStorage.getItem(this.storageKey(uid));
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as VaultMetadata;
      return parsed.version === 1 ? parsed : null;
    } catch {
      return null;
    }
  }

  private writeMetadata(uid: string, metadata: VaultMetadata): void {
    localStorage.setItem(this.storageKey(uid), JSON.stringify(metadata));
  }
}
