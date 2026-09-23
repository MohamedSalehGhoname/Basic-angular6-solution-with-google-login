// Moves one account's rows to another uid, for the switch from the temporary
// dev identity to a real Google account. Everything stays encrypted; only the
// owner column changes.
//
//   node scripts/migrate-uid.mjs --from local-dev-user --to <firebase-uid> [--db /data/clipsync.db]
//
// Refuses to merge into an account that already has a vault, and writes a
// timestamped copy of the database next to it first.
import { copyFileSync } from 'node:fs';
import Database from 'better-sqlite3';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const from = args.get('from');
const to = args.get('to');
const dbPath = args.get('db') ?? '/data/clipsync.db';
const force = args.has('force');

if (!from || !to || from === to) {
  console.error('usage: migrate-uid.mjs --from <uid> --to <uid> [--db <path>] [--force]');
  process.exit(1);
}

const backup = `${dbPath}.before-migrate-${new Date().toISOString().replace(/[:.]/g, '-')}`;
copyFileSync(dbPath, backup);
console.log(`backup: ${backup}`);

const db = new Database(dbPath);
const count = (table, uid) =>
  db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE uid = ?`).get(uid).n;

console.log(
  `from ${from}: vault ${count('vaults', from)}, items ${count('items', from)}, files ${count('files', from)}`,
);
console.log(
  `to   ${to}: vault ${count('vaults', to)}, items ${count('items', to)}, files ${count('files', to)}`,
);

if (count('vaults', to) > 0 && !force) {
  console.error(`${to} already has a vault; refusing to merge (pass --force to override)`);
  process.exit(1);
}

const move = db.transaction(() => {
  db.prepare('UPDATE vaults SET uid = ? WHERE uid = ?').run(to, from);
  db.prepare('UPDATE items SET uid = ? WHERE uid = ?').run(to, from);
  db.prepare('UPDATE files SET uid = ? WHERE uid = ?').run(to, from);
});
move();

console.log(
  `moved. now ${to}: vault ${count('vaults', to)}, items ${count('items', to)}, files ${count('files', to)}`,
);
db.close();
