import readline from 'node:readline/promises';
import process from 'node:process';
import { openDatabase, ensureHousehold } from './db.js';
import { hashPassword } from './auth.js';

const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) => value.startsWith('--') ? [[value.slice(2), all[index + 1]]] : []));
if (!args.email || !args.name) {
  console.error('Usage: npm run bootstrap -- --email adult@example.com --name "Adult Name"');
  process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question('Password (12+ characters): ', { hideEchoBack: true });
rl.close();
const db = openDatabase();
const household = ensureHousehold(db);
try {
  db.prepare('INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?,?)')
    .run(household.id, args.email.trim().toLowerCase(), args.name.trim(), await hashPassword(password), 'adult');
  console.log(`Adult account created for ${args.email}.`);
} catch (error) {
  console.error(error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'That account already exists.' : error.message);
  process.exitCode = 1;
} finally { db.close(); }
