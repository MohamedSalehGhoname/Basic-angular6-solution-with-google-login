import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { CryptoService, type KdfParams } from './crypto.service';
import { SyncApi, type WrappedKeyRecord } from './sync-api';

export type VaultStatus = 'uninitialized' | 'locked' | 'unlocked';

/**
 * Persisted per account. None of this is secret: a wrapped vault key is only
 * recoverable with the passphrase (or recovery code), and the salt + KDF
 * params must be readable to attempt an unlock. The sync server holds the
 * same record; localStorage acts as the offline cache.
 */
interface VaultMetadata extends WrappedKeyRecord {
  version: 1;
  /** Optional recovery-code-wrapped copy of the same vault key. */
  recovery?: WrappedKeyRecord;
  /**
   * Ciphertext only this vault's key opens. It lets a device notice that the
   * vault was replaced elsewhere — its own key is then stale, and anything it
   * writes would be unreadable to every other device.
   */
  keyCheck?: string;
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
  /** Bumped whenever the cached metadata changes, so computeds re-evaluate. */
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

  /** Whether the current account's vault has a recovery code set. */
  readonly hasRecovery = computed<boolean>(() => {
    this.metadataVersion();
    const uid = this.auth.user()?.uid;
    return !!uid && !!this.readMetadata(uid)?.recovery;
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
          keyCheck: remote.keyCheck,
          recovery: remote.recovery,
        });
        await this.lockIfKeyIsStale(remote.keyCheck);
      } else {
        const local = this.readMetadata(uid);
        if (local) {
          await this.syncApi.putVault(this.toRemote(local));
        }
      }
      this.metadataSynced.add(uid);
    } catch {
      // Offline: the local cache is authoritative until the server is back.
    }
  }

  async createVault(passphrase: string, params?: KdfParams): Promise<void> {
    const uid = this.requireUid();
    const kdf = params ?? (await this.crypto.defaultKdfParams());
    const vaultKey = await this.crypto.generateVaultKey();
    const wrapped = await this.wrapWith(passphrase, vaultKey, kdf);
    const metadata: VaultMetadata = {
      version: 1,
      ...wrapped,
      keyCheck: await this.crypto.encryptItem(KEY_CHECK_TEXT, vaultKey),
    };

    this.writeMetadata(uid, metadata);
    this.setUnlocked(uid, vaultKey);
    await this.pushMetadata(uid, metadata);
  }

  /**
   * Called when another device changed the vault record: if the vault was
   * replaced, this session's key can no longer read it, so lock rather than
   * keep writing items nobody can decrypt.
   */
  async onRemoteVaultChanged(): Promise<void> {
    if (this.status() !== 'unlocked') {
      return;
    }
    try {
      const remote = await this.syncApi.getVault();
      if (!remote) {
        return;
      }
      const uid = this.requireUid();
      this.writeMetadata(uid, {
        version: 1,
        salt: remote.salt,
        opsLimit: remote.opsLimit,
        memLimit: remote.memLimit,
        wrappedKey: remote.wrappedKey,
        keyCheck: remote.keyCheck,
        recovery: remote.recovery,
      });
      await this.lockIfKeyIsStale(remote.keyCheck);
    } catch {
      // Offline: the local record stands until the server is reachable.
    }
  }

  /** Locks when the vault's check value no longer opens with our key. */
  private async lockIfKeyIsStale(keyCheck: string | undefined): Promise<void> {
    if (!keyCheck || !this.vaultKey || this.status() !== 'unlocked') {
      return;
    }
    try {
      if ((await this.crypto.decryptItem(keyCheck, this.vaultKey)) === KEY_CHECK_TEXT) {
        return;
      }
    } catch {
      // Falls through to locking.
    }
    this.lock();
  }

  async unlock(passphrase: string): Promise<void> {
    const uid = this.requireUid();
    const metadata = this.readMetadata(uid);
    if (!metadata) {
      throw new Error('No vault exists for this account yet.');
    }
    const vaultKey = await this.unwrapWith(passphrase, metadata).catch(() => {
      throw new Error('Incorrect passphrase.');
    });
    this.setUnlocked(uid, vaultKey);
    // Vaults made before the key check gain one on the next unlock.
    await this.ensureKeyCheck();
  }

  async unlockWithRecoveryCode(code: string): Promise<void> {
    const uid = this.requireUid();
    const metadata = this.readMetadata(uid);
    if (!metadata?.recovery) {
      throw new Error('No recovery code is set for this account.');
    }
    const vaultKey = await this.unwrapWith(normalizeCode(code), metadata.recovery).catch(() => {
      throw new Error('Incorrect recovery code.');
    });
    this.setUnlocked(uid, vaultKey);
    await this.ensureKeyCheck();
  }

  /** Adds the key check to a vault made before it existed. */
  async ensureKeyCheck(): Promise<void> {
    const uid = this.auth.user()?.uid;
    const metadata = uid ? this.readMetadata(uid) : null;
    if (!uid || !metadata || metadata.keyCheck || this.status() !== 'unlocked') {
      return;
    }
    const updated: VaultMetadata = {
      ...metadata,
      keyCheck: await this.encryptItem(KEY_CHECK_TEXT),
    };
    this.writeMetadata(uid, updated);
    await this.pushMetadata(uid, updated);
  }

  async changePassphrase(current: string, next: string): Promise<void> {
    const uid = this.requireUid();
    const metadata = this.readMetadata(uid);
    if (!metadata || this.status() !== 'unlocked') {
      throw new Error('Unlock the vault before changing the passphrase.');
    }
    // Verify the current passphrase before allowing a change.
    await this.unwrapWith(current, metadata).catch(() => {
      throw new Error('Current passphrase is incorrect.');
    });

    const kdf = await this.crypto.defaultKdfParams();
    const rewrapped = await this.wrapWith(next, this.requireVaultKey(), kdf);
    const updated: VaultMetadata = { version: 1, ...rewrapped, recovery: metadata.recovery };
    this.writeMetadata(uid, updated);
    await this.pushMetadata(uid, updated);
  }

  /**
   * Generates a recovery code, wraps the vault key with it, and returns the
   * code to show once. Requires the vault unlocked. Replaces any existing code.
   */
  async addRecoveryCode(): Promise<string> {
    const uid = this.requireUid();
    const metadata = this.readMetadata(uid);
    if (!metadata || this.status() !== 'unlocked') {
      throw new Error('Unlock the vault before creating a recovery code.');
    }
    const code = generateRecoveryCode();
    const kdf = await this.crypto.defaultKdfParams();
    const recovery = await this.wrapWith(normalizeCode(code), this.requireVaultKey(), kdf);
    const updated: VaultMetadata = { ...metadata, version: 1, recovery };
    this.writeMetadata(uid, updated);
    await this.pushMetadata(uid, updated);
    return code;
  }

  async removeRecoveryCode(): Promise<void> {
    const uid = this.requireUid();
    const metadata = this.readMetadata(uid);
    if (!metadata) {
      return;
    }
    const { recovery: _drop, ...rest } = metadata;
    const updated: VaultMetadata = { ...rest, version: 1 };
    this.writeMetadata(uid, updated);
    await this.pushMetadata(uid, updated);
  }

  /** The unlocked vault key (base64), to seal on this device for fingerprint unlock. */
  async exportVaultKey(): Promise<string> {
    return this.crypto.toBase64(this.requireVaultKey());
  }

  /** A small blob only the current vault key opens; lets a sealed key be checked later. */
  async keyCheck(): Promise<string> {
    return this.encryptItem(KEY_CHECK_TEXT);
  }

  /**
   * Unlocks with a vault key released by the device (fingerprint unlock),
   * after checking it against the blob from keyCheck(): a stale key (e.g. the
   * vault was recreated) is refused instead of silently failing every item.
   */
  async unlockWithVaultKey(keyBase64: string, check: string): Promise<void> {
    const uid = this.requireUid();
    const key = await this.crypto.fromBase64(keyBase64);
    let ok = false;
    try {
      ok = (await this.crypto.decryptItem(check, key)) === KEY_CHECK_TEXT;
    } catch {
      ok = false;
    }
    if (!ok) {
      await this.crypto.zeroize(key);
      throw new Error('stale-key');
    }
    this.setUnlocked(uid, key);
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

  /** Derives a key from `secret` and wraps `vaultKey` with it. */
  private async wrapWith(
    secret: string,
    vaultKey: Uint8Array,
    kdf: KdfParams,
  ): Promise<WrappedKeyRecord> {
    const salt = await this.crypto.generateSalt();
    const derived = await this.crypto.deriveMasterKey(secret, salt, kdf);
    try {
      return {
        salt: await this.crypto.toBase64(salt),
        opsLimit: kdf.opsLimit,
        memLimit: kdf.memLimit,
        wrappedKey: await this.crypto.wrapKey(vaultKey, derived),
      };
    } finally {
      await this.crypto.zeroize(derived);
    }
  }

  /** Derives a key from `secret` and unwraps the vault key from `record`. */
  private async unwrapWith(secret: string, record: WrappedKeyRecord): Promise<Uint8Array> {
    const derived = await this.crypto.deriveMasterKey(secret, await this.crypto.fromBase64(record.salt), {
      opsLimit: record.opsLimit,
      memLimit: record.memLimit,
    });
    try {
      return await this.crypto.unwrapKey(record.wrappedKey, derived);
    } finally {
      await this.crypto.zeroize(derived);
    }
  }

  private toRemote(metadata: VaultMetadata) {
    return {
      salt: metadata.salt,
      opsLimit: metadata.opsLimit,
      memLimit: metadata.memLimit,
      wrappedKey: metadata.wrappedKey,
      keyCheck: metadata.keyCheck,
      recovery: metadata.recovery,
    };
  }

  private async pushMetadata(uid: string, metadata: VaultMetadata): Promise<void> {
    try {
      await this.syncApi.putVault(this.toRemote(metadata));
      this.metadataSynced.add(uid);
    } catch {
      // Offline: ensureMetadata pushes the record on a later session.
    }
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

const KEY_CHECK_TEXT = 'clipsync-vault-key-check-v1';

/** Human-friendly recovery code: 5 groups of 5 unambiguous characters. */
function generateRecoveryCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buffer = new Uint32Array(25);
  crypto.getRandomValues(buffer);
  const chars = Array.from(buffer, (value) => alphabet[value % alphabet.length]);
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += 5) {
    groups.push(chars.slice(i, i + 5).join(''));
  }
  return groups.join('-');
}

/** Codes compare case-insensitively and ignore spaces/dashes. */
function normalizeCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}
