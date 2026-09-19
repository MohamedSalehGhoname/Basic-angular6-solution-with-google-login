import { TestBed } from '@angular/core/testing';
import sodium from 'libsodium-wrappers-sumo';
import { CryptoService, type KdfParams } from './crypto.service';

describe('CryptoService', () => {
  let service: CryptoService;
  // INTERACTIVE keeps Argon2id fast in tests; production defaults are MODERATE.
  let fastKdf: KdfParams;

  beforeEach(async () => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(CryptoService);
    await service.ready;
    fastKdf = {
      opsLimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      memLimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    };
  });

  it('round-trips an encrypted item', async () => {
    const key = await service.generateVaultKey();
    const blob = await service.encryptItem('hello clipboard 📋', key);

    expect(blob.startsWith('xcv1:')).toBe(true);
    expect(blob).not.toContain('hello');
    expect(await service.decryptItem(blob, key)).toBe('hello clipboard 📋');
  });

  it('produces a different blob for each encryption of the same plaintext', async () => {
    const key = await service.generateVaultKey();
    const first = await service.encryptItem('same text', key);
    const second = await service.encryptItem('same text', key);
    expect(first).not.toBe(second);
  });

  it('rejects decryption with the wrong key', async () => {
    const blob = await service.encryptItem('secret', await service.generateVaultKey());
    const wrongKey = await service.generateVaultKey();
    await expect(service.decryptItem(blob, wrongKey)).rejects.toThrowError(
      /wrong key or tampered/,
    );
  });

  it('rejects tampered ciphertext', async () => {
    const key = await service.generateVaultKey();
    const blob = await service.encryptItem('secret', key);
    const tampered =
      blob.slice(0, -1) + (blob.endsWith('A') ? 'B' : 'A');
    await expect(service.decryptItem(tampered, key)).rejects.toThrow();
  });

  it('rejects blobs without the expected format prefix', async () => {
    const key = await service.generateVaultKey();
    await expect(service.decryptItem('bogus', key)).rejects.toThrowError(
      /Unrecognized ciphertext format/,
    );
  });

  it('derives the same master key for the same passphrase and salt', async () => {
    const salt = await service.generateSalt();
    const a = await service.deriveMasterKey('correct horse battery', salt, fastKdf);
    const b = await service.deriveMasterKey('correct horse battery', salt, fastKdf);
    expect(a).toEqual(b);
    expect(a.length).toBe(32);
  });

  it('derives different keys for different salts or passphrases', async () => {
    const salt = await service.generateSalt();
    const otherSalt = await service.generateSalt();
    const base = await service.deriveMasterKey('passphrase', salt, fastKdf);
    expect(await service.deriveMasterKey('passphrase', otherSalt, fastKdf)).not.toEqual(base);
    expect(await service.deriveMasterKey('other phrase', salt, fastKdf)).not.toEqual(base);
  });

  it('wraps and unwraps the vault key with a derived master key', async () => {
    const masterKey = await service.deriveMasterKey(
      'passphrase',
      await service.generateSalt(),
      fastKdf,
    );
    const vaultKey = await service.generateVaultKey();

    const wrapped = await service.wrapKey(vaultKey, masterKey);
    expect(await service.unwrapKey(wrapped, masterKey)).toEqual(vaultKey);

    const wrongMaster = await service.generateVaultKey();
    await expect(service.unwrapKey(wrapped, wrongMaster)).rejects.toThrow();
  });

  it('zeroizes key material in place', async () => {
    const key = await service.generateVaultKey();
    await service.zeroize(key);
    expect(key.every((byte) => byte === 0)).toBe(true);
  });
});
