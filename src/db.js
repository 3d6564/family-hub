import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Open SQLite and apply pending numbered migrations. */
export function openDatabase(filename = process.env.DATABASE_PATH || path.join(root, 'data/family-hub.sqlite')) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const applied = db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version);
  for (const file of fs.readdirSync(path.join(root, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    if (applied.includes(file)) continue;
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(file);
    })();
  }
  return db;
}

export function ensureHousehold(db, name = process.env.HOUSEHOLD_NAME || 'Our Home') {
  let household = db.prepare('SELECT * FROM households ORDER BY id LIMIT 1').get();
  if (!household) {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const result = db.prepare('INSERT INTO households(name,timezone) VALUES (?,?)').run(name, zone);
    household = db.prepare('SELECT * FROM households WHERE id=?').get(result.lastInsertRowid);
  }
  return household;
}
