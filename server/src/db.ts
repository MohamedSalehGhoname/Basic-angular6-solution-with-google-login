import Database from 'better-sqlite3';

export interface VaultRecord {
  salt: string;
  opsLimit: number;
  memLimit: number;
  wrappedKey: string;
  /** Optional recovery-code-wrapped copy of the vault key, stored opaquely. */
  recovery?: unknown;
  updatedAt: number;
}

export interface ItemRecord {
  id: string;
  blob: string;
  createdAt: number;
}

/**
 * All values stored here are either identifiers or ciphertext produced by
 * the client; the server never holds plaintext or key material.
 */
export class SyncDb {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vaults (
        uid         TEXT PRIMARY KEY,
        salt        TEXT NOT NULL,
        ops_limit   INTEGER NOT NULL,
        mem_limit   INTEGER NOT NULL,
        wrapped_key TEXT NOT NULL,
        recovery    TEXT,
        updated_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS items (
        uid        TEXT NOT NULL,
        collection TEXT NOT NULL,
        id         TEXT NOT NULL,
        blob       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (uid, collection, id)
      );
      CREATE INDEX IF NOT EXISTS items_by_collection_time
        ON items (uid, collection, created_at DESC);
      CREATE TABLE IF NOT EXISTS files (
        file_id    TEXT PRIMARY KEY,
        uid        TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  /** Records which user a stored file belongs to; storage ids are global. */
  addFile(uid: string, fileId: string, sizeBytes: number): void {
    this.db
      .prepare('INSERT INTO files (file_id, uid, size_bytes, created_at) VALUES (?, ?, ?, ?)')
      .run(fileId, uid, sizeBytes, Date.now());
  }

  fileOwner(fileId: string): string | null {
    const row = this.db.prepare('SELECT uid FROM files WHERE file_id = ?').get(fileId) as
      | { uid: string }
      | undefined;
    return row?.uid ?? null;
  }

  getVault(uid: string): VaultRecord | null {
    const row = this.db
      .prepare(
        'SELECT salt, ops_limit, mem_limit, wrapped_key, recovery, updated_at FROM vaults WHERE uid = ?',
      )
      .get(uid) as
      | {
          salt: string;
          ops_limit: number;
          mem_limit: number;
          wrapped_key: string;
          recovery: string | null;
          updated_at: number;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      salt: row.salt,
      opsLimit: row.ops_limit,
      memLimit: row.mem_limit,
      wrappedKey: row.wrapped_key,
      recovery: row.recovery ? JSON.parse(row.recovery) : undefined,
      updatedAt: row.updated_at,
    };
  }

  putVault(uid: string, vault: Omit<VaultRecord, 'updatedAt'>): VaultRecord {
    const updatedAt = Date.now();
    const recovery = vault.recovery === undefined ? null : JSON.stringify(vault.recovery);
    this.db
      .prepare(
        `INSERT INTO vaults (uid, salt, ops_limit, mem_limit, wrapped_key, recovery, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (uid) DO UPDATE SET
           salt = excluded.salt,
           ops_limit = excluded.ops_limit,
           mem_limit = excluded.mem_limit,
           wrapped_key = excluded.wrapped_key,
           recovery = excluded.recovery,
           updated_at = excluded.updated_at`,
      )
      .run(uid, vault.salt, vault.opsLimit, vault.memLimit, vault.wrappedKey, recovery, updatedAt);
    return { ...vault, updatedAt };
  }

  listItems(uid: string, collection: string): ItemRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, blob, created_at FROM items
         WHERE uid = ? AND collection = ? ORDER BY created_at DESC, id`,
      )
      .all(uid, collection) as { id: string; blob: string; created_at: number }[];
    return rows.map((row) => ({ id: row.id, blob: row.blob, createdAt: row.created_at }));
  }

  putItem(
    uid: string,
    collection: string,
    id: string,
    blob: string,
    maxItems: number,
  ): ItemRecord {
    const existing = this.db
      .prepare('SELECT created_at FROM items WHERE uid = ? AND collection = ? AND id = ?')
      .get(uid, collection, id) as { created_at: number } | undefined;
    // Preserve the original timestamp on update so an edit does not reorder
    // the entry (secrets keep their place; clipboard items are immutable).
    const createdAt = existing?.created_at ?? Date.now();
    const insert = this.db.prepare(
      `INSERT INTO items (uid, collection, id, blob, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (uid, collection, id) DO UPDATE SET blob = excluded.blob`,
    );
    const trim = this.db.prepare(
      `DELETE FROM items WHERE uid = ? AND collection = ? AND id NOT IN (
         SELECT id FROM items WHERE uid = ? AND collection = ?
         ORDER BY created_at DESC, id LIMIT ?
       )`,
    );
    this.db.transaction(() => {
      insert.run(uid, collection, id, blob, createdAt);
      trim.run(uid, collection, uid, collection, maxItems);
    })();
    return { id, blob, createdAt };
  }

  deleteItem(uid: string, collection: string, id: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM items WHERE uid = ? AND collection = ? AND id = ?')
        .run(uid, collection, id).changes > 0
    );
  }

  clearItems(uid: string, collection: string): void {
    this.db.prepare('DELETE FROM items WHERE uid = ? AND collection = ?').run(uid, collection);
  }

  close(): void {
    this.db.close();
  }
}
