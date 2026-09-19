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
}

interface SecretPayload extends SecretFields {
  createdAt: number;
  updatedAt: number;
}

export type SecretEntry = Entry<SecretPayload>;

const MAX_SECRETS = 1000;

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
    };
  }
}
