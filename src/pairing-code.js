import { createPairingCode } from './auth.js';
import { ensureHousehold, openDatabase } from './db.js';

const db = openDatabase();
try {
  const household = ensureHousehold(db);
  console.log(createPairingCode(db, household.id));
} finally {
  db.close();
}
