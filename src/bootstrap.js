import readline from 'node:readline/promises';
import process from 'node:process';
import { openDatabase, ensureHousehold } from './db.js';
import { hashPassword } from './auth.js';

const values = process.argv.slice(2);
const args = Object.fromEntries(values.flatMap((value, index) => value.startsWith('--') ? [[value.slice(2), values[index + 1]]] : []));
const allowTemporaryPassword = values.includes('--allow-temporary-password');
if (!args.email || !args.name) {
  console.error('Usage: npm run bootstrap -- --email adult@example.com --name "Adult Name" [--allow-temporary-password]');
  process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question(`Password (${allowTemporaryPassword ? 'temporary, 8+' : '12+'} characters): `, { hideEchoBack: true });
rl.close();
const db = openDatabase();
const household = ensureHousehold(db);
try {
  db.prepare('INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?,?)')
    .run(household.id, args.email.trim().toLowerCase(), args.name.trim(), await hashPassword(password, { allowTemporaryPassword }), 'adult');
  console.log(`Adult account created for ${args.email}.`);
} catch (error) {
  console.error(error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'That account already exists.' : error.message);
  process.exitCode = 1;
} finally { db.close(); }
