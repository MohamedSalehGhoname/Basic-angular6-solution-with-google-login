import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { CryptoService, type KdfParams } from './crypto.service';
import { SyncApi } from './sync-api';

export type VaultStatus = 'uninitialized' | 'locked' | 'unlocked';

/**
 * Persisted per account. None of this is secret: the wrapped vault key is
 * only recoverable with the passphrase, and the salt + KDF params must be
 * readable to attempt an unlock. The sync server holds the same record;
 * localStorage acts as the offline cache.
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
  private readonly syncApi = inject(SyncApi);

  private vaultKey: Uint8Array | null = null;
  private readonly unlockedUid = signal<string | null>(null);
  /** Bumped whenever the cached metadata changes, so `status` re-evaluates. */
  private readonly metadataVersion = signal(0);
  private readonly metadataSynced = new Set<string>();

  readonly status = computed<VaultStatus>(() => {
    this.metadataVersion();
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

  /**
   * Reconciles the cached vault record with the server once per account and
   * session: pulls the server's record (how a new device learns about an
   * existing vault), or pushes a local-only record up. Offline, the cache
   * stands alone.
   */
  async ensureMetadata(): Promise<void> {
    const uid = this.auth.user()?.uid;
    if (!uid || this.metadataSynced.has(uid)) {
      return;
    }
    try {
      const remote = await this.syncApi.getVault();
      if (remote) {
        this.writeMetadata(uid, {
          version: 1,
          salt: remote.salt,
          opsLimit: remote.opsLimit,
          memLimit: remote.memLimit,
          wrappedKey: remote.wrappedKey,
        });
      } else {
        const local = this.readMetadata(uid);
        if (local) {
          await this.syncApi.putVault({
            salt: local.salt,
            opsLimit: local.opsLimit,
            memLimit: local.memLimit,
            wrappedKey: local.wrappedKey,
          });
        }
      }
      this.metadataSynced.add(uid);
    } catch {
      // Offline: the local cache is authoritative until the server is back.
    }
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
      try {
        await this.syncApi.putVault({
          salt: metadata.salt,
          opsLimit: metadata.opsLimit,
          memLimit: metadata.memLimit,
          wrappedKey: metadata.wrappedKey,
        });
        this.metadataSynced.add(uid);
      } catch {
        // Offline: ensureMetadata pushes the record on a later session.
      }
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
    this.metadataVersion.update((version) => version + 1);
  }
}
