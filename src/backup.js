import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const header = Buffer.from('SQLite format 3\0');

/** Write a consistent copy of the open database. */
export async function writeBackup(db, destination) {
  await db.backup(destination);
  fs.chmodSync(destination, 0o600);
}

/** Reject a file that is not a usable Family Hub database. */
export function validateFamilyHubDatabase(filename) {
  let bytes;
  try { bytes = fs.readFileSync(filename); } catch { throw new Error('Choose a Family Hub backup file.'); }
  if (bytes.length < header.length || !bytes.subarray(0, header.length).equals(header)) throw new Error('Choose a Family Hub backup file.');
  let incoming;
  try {
    incoming = new Database(filename, { readonly: true, fileMustExist: true });
    const integrity = incoming.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error('This backup failed its integrity check. Choose another file.');
    const tables = new Set(incoming.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    for (const name of ['households', 'users', 'schema_migrations']) {
      if (!tables.has(name)) throw new Error('Choose a Family Hub backup file.');
    }
  } catch (error) {
    if (error.message.startsWith('Choose') || error.message.startsWith('This backup')) throw error;
    throw new Error('Choose a Family Hub backup file.');
  } finally {
    incoming?.close();
  }
}

/** Replace the live database file with a validated backup. The caller must restart afterward. */
export async function restoreDatabase(db, databasePath, upload, workDir = path.dirname(databasePath)) {
  if (!databasePath || databasePath === ':memory:') throw Object.assign(new Error('Restore is available only for a saved database file.'), { status: 400 });
  fs.mkdirSync(workDir, { recursive: true });
  const incoming = path.join(workDir, `.family-hub-incoming-${process.pid}.sqlite`);
  const staged = path.join(workDir, `.family-hub-restore-${process.pid}.sqlite`);
  fs.writeFileSync(incoming, upload, { mode: 0o600 });
  try {
    validateFamilyHubDatabase(incoming);
    const source = new Database(incoming, { readonly: true, fileMustExist: true });
    try { await source.backup(staged); } finally { source.close(); }
    fs.chmodSync(staged, 0o600);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    fs.rmSync(`${databasePath}-wal`, { force: true });
    fs.rmSync(`${databasePath}-shm`, { force: true });
    fs.renameSync(staged, databasePath);
  } catch (error) {
    fs.rmSync(staged, { force: true });
    throw error;
  } finally {
    fs.rmSync(incoming, { force: true });
  }
}
