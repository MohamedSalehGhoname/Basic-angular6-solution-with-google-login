import { Injectable } from '@angular/core';
import { type Entry, SyncedCollection } from './synced-collection';

/** An image attached to a secret, stored inline (base64 data URL) and thus
 * encrypted with the rest of the entry. */
export interface Attachment {
  name: string;
  type: string;
  /** `data:<mime>;base64,…` */
  data: string;
}

export interface SecretFields {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  attachments: Attachment[];
  /** Group (folder) id; null/absent = top level. */
  groupId?: string | null;
  /**
   * The shared secret for this entry's two-factor codes, base32, absent when
   * there are none. As sensitive as the password — it mints codes forever —
   * so it lives in the encrypted payload like everything else here.
   */
  totp?: string | null;
  /** Non-default code settings; absent means six digits every 30s, SHA-1. */
  totpDigits?: number | null;
  totpPeriod?: number | null;
  totpAlgorithm?: 'SHA-1' | 'SHA-256' | 'SHA-512' | null;
}

interface SecretPayload extends SecretFields {
  createdAt: number;
  updatedAt: number;
}

export type SecretEntry = Entry<SecretPayload>;

/**
 * The same ceiling the server enforces for this collection. It has to be the
 * same number: a lower one here makes the client quietly drop entries the
 * server happily stored, which is how an import of a thousand passwords ended
 * up showing only some of them.
 */
const MAX_SECRETS = 5000;

/**
 * KeePass-style secrets: deliberate, structured, editable entries in the same
 * end-to-end-encrypted, synced store as the clipboard. Entries never expire
 * and are ordered alphabetically by title.
 */
@Injectable({ providedIn: 'root' })
export class SecretsStore extends SyncedCollection<SecretPayload> {
  constructor() {
    super('secrets', MAX_SECRETS);
  }

  async add(fields: SecretFields): Promise<SecretEntry | null> {
    if (!fields.title.trim()) {
      return null;
    }
    // Refuse rather than silently push the last entry out of the list: losing
    // a password without being told is worse than being unable to add one.
    if (this.items().length >= MAX_SECRETS) {
      throw new Error(`This vault is full: it holds the maximum of ${MAX_SECRETS} passwords.`);
    }
    const now = Date.now();
    return this.create({ ...this.normalize(fields), createdAt: now, updatedAt: now });
  }

  async save(id: string, fields: SecretFields): Promise<void> {
    const existing = this.items().find((entry) => entry.id === id);
    if (!existing) {
      throw new Error('Secret not found.');
    }
    await this.update(id, {
      ...this.normalize(fields),
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    });
  }

  /** Moves a secret into a group (null = top level), keeping everything else. */
  async move(id: string, groupId: string | null): Promise<void> {
    const existing = this.items().find((entry) => entry.id === id);
    if (!existing || (existing.groupId ?? null) === groupId) {
      return;
    }
    const { id: _id, ...payload } = existing;
    await this.update(id, { ...payload, groupId });
  }

  protected override compare(a: SecretEntry, b: SecretEntry): number {
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  }

  private normalize(fields: SecretFields): SecretFields {
    return {
      title: fields.title.trim(),
      username: fields.username.trim(),
      password: fields.password,
      url: fields.url.trim(),
      notes: fields.notes,
      attachments: Array.isArray(fields.attachments) ? fields.attachments : [],
      groupId: fields.groupId ?? null,
      // Two-factor settings. Only the ones that differ from the usual are
      // kept, so an ordinary entry stays as small as it was.
      totp: fields.totp ? fields.totp : null,
      totpDigits: fields.totp ? (fields.totpDigits ?? null) : null,
      totpPeriod: fields.totp ? (fields.totpPeriod ?? null) : null,
      totpAlgorithm: fields.totp ? (fields.totpAlgorithm ?? null) : null,
    };
  }
}
