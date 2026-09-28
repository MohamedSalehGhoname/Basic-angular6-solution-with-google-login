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

/** Everything about one entry, as a form or an import hands it over. */
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
   * so it is sealed away with it.
   */
  totp?: string | null;
  /** Non-default code settings; absent means six digits every 30s, SHA-1. */
  totpDigits?: number | null;
  totpPeriod?: number | null;
  totpAlgorithm?: 'SHA-1' | 'SHA-256' | 'SHA-512' | null;
}

/** The parts that stay sealed until the user asks for one of them. */
export interface SecretSecrets {
  password: string;
  notes: string;
  attachments: Attachment[];
  totp?: string | null;
  totpDigits?: number | null;
  totpPeriod?: number | null;
  totpAlgorithm?: 'SHA-1' | 'SHA-256' | 'SHA-512' | null;
}

/**
 * What a list needs to draw a row, decrypted as soon as the vault opens.
 * Deliberately nothing anyone could sign in with.
 */
interface SecretPayload {
  title: string;
  username: string;
  url: string;
  groupId?: string | null;
  createdAt: number;
  updatedAt: number;
  /** The sealed half: an `xcv1:` blob holding a {@link SecretSecrets}. */
  sealed?: string;
  /**
   * What is inside, without saying what it is: enough for a row to show the
   * right buttons ("copy password", "show notes") without opening anything.
   */
  hasTotp?: boolean;
  hasPassword?: boolean;
  hasNotes?: boolean;
  attachmentCount?: number;
  /**
   * Entries written before the split keep their secrets out here. They are
   * still read (and rewritten sealed when saved or migrated), so upgrading
   * does not need every device to move at once.
   */
  password?: string;
  notes?: string;
  attachments?: Attachment[];
  totp?: string | null;
  totpDigits?: number | null;
  totpPeriod?: number | null;
  totpAlgorithm?: 'SHA-1' | 'SHA-256' | 'SHA-512' | null;
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
 *
 * Each entry is stored in two layers. The outer one — name, username, address,
 * group — is what the list draws and is opened for every entry when the vault
 * unlocks. The inner one — password, notes, two-factor key, images — is a
 * separate ciphertext that is opened only when the user reveals, copies, edits
 * or fills it. A vault with a thousand entries therefore keeps a thousand
 * names in memory rather than a thousand passwords.
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
    return this.create(await this.pack(fields, now, now));
  }

  async save(id: string, fields: SecretFields): Promise<void> {
    const existing = this.items().find((entry) => entry.id === id);
    if (!existing) {
      throw new Error('Secret not found.');
    }
    await this.update(id, await this.pack(fields, existing.createdAt, Date.now()));
  }

  /** Moves a secret into a group (null = top level), keeping everything else. */
  async move(id: string, groupId: string | null): Promise<void> {
    const existing = this.items().find((entry) => entry.id === id);
    if (!existing || (existing.groupId ?? null) === groupId) {
      return;
    }
    // The sealed half travels as it is: moving a password is not a reason to
    // open it.
    const { id: _id, ...payload } = existing;
    await this.update(id, { ...payload, groupId });
  }

  /**
   * Opens one entry's sealed half. Every caller that shows, copies, fills or
   * edits a password goes through here, which is what keeps the rest of them
   * sealed.
   */
  async open(id: string): Promise<SecretSecrets> {
    const entry = this.items().find((item) => item.id === id);
    if (!entry) {
      throw new Error('Secret not found.');
    }
    return this.unseal(entry);
  }

  /** The whole entry, index and secrets together, ready for the edit form. */
  async fields(id: string): Promise<SecretFields> {
    const entry = this.items().find((item) => item.id === id);
    if (!entry) {
      throw new Error('Secret not found.');
    }
    const secrets = await this.unseal(entry);
    return {
      title: entry.title,
      username: entry.username,
      url: entry.url,
      groupId: entry.groupId ?? null,
      ...secrets,
    };
  }

  // What a row can tell without opening anything. An entry written before the
  // split says it the old way, by carrying the thing itself.

  hasCode(entry: SecretEntry): boolean {
    return entry.hasTotp ?? !!entry.totp;
  }

  hasPassword(entry: SecretEntry): boolean {
    return entry.hasPassword ?? !!entry.password;
  }

  hasNotes(entry: SecretEntry): boolean {
    return entry.hasNotes ?? !!entry.notes;
  }

  attachmentCount(entry: SecretEntry): number {
    return entry.attachmentCount ?? entry.attachments?.length ?? 0;
  }

  /** Entries still stored the old way, with their secrets in the open. */
  legacyCount(): number {
    return this.items().filter((entry) => !entry.sealed).length;
  }

  /**
   * Rewrites entries written before the split. Saving one is enough to seal
   * it, so this is the same work the user would do by opening each entry and
   * pressing save.
   */
  async migrateLegacy(onProgress?: (done: number, total: number) => void): Promise<number> {
    const stale = this.items().filter((entry) => !entry.sealed);
    let done = 0;
    for (const entry of stale) {
      await this.save(entry.id, await this.fields(entry.id));
      // Counted on its own line: `onProgress?.(++done)` never increments when
      // nobody passed a callback, because the whole call short-circuits.
      done += 1;
      onProgress?.(done, stale.length);
    }
    return done;
  }

  protected override compare(a: SecretEntry, b: SecretEntry): number {
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  }

  /** Splits the fields in two and seals the half that has to stay shut. */
  private async pack(
    fields: SecretFields,
    createdAt: number,
    updatedAt: number,
  ): Promise<SecretPayload> {
    const attachments = Array.isArray(fields.attachments) ? fields.attachments : [];
    const secrets: SecretSecrets = {
      password: fields.password,
      notes: fields.notes,
      attachments,
      // Two-factor settings. Only the ones that differ from the usual are
      // kept, so an ordinary entry stays as small as it was.
      totp: fields.totp ? fields.totp : null,
      totpDigits: fields.totp ? (fields.totpDigits ?? null) : null,
      totpPeriod: fields.totp ? (fields.totpPeriod ?? null) : null,
      totpAlgorithm: fields.totp ? (fields.totpAlgorithm ?? null) : null,
    };
    return {
      title: fields.title.trim(),
      username: fields.username.trim(),
      url: fields.url.trim(),
      groupId: fields.groupId ?? null,
      createdAt,
      updatedAt,
      sealed: await this.vault.encryptItem(JSON.stringify(secrets)),
      hasTotp: !!fields.totp,
      hasPassword: !!fields.password,
      hasNotes: !!fields.notes.trim(),
      attachmentCount: attachments.length,
    };
  }

  private async unseal(entry: SecretEntry): Promise<SecretSecrets> {
    if (entry.sealed) {
      return JSON.parse(await this.vault.decryptItem(entry.sealed)) as SecretSecrets;
    }
    // Written before the split, or by a device that has not been updated yet.
    return {
      password: entry.password ?? '',
      notes: entry.notes ?? '',
      attachments: entry.attachments ?? [],
      totp: entry.totp ?? null,
      totpDigits: entry.totpDigits ?? null,
      totpPeriod: entry.totpPeriod ?? null,
      totpAlgorithm: entry.totpAlgorithm ?? null,
    };
  }
}
