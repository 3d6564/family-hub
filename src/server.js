import { openDatabase, ensureHousehold } from './db.js';
import { createApp } from './app.js';

const db = openDatabase();
ensureHousehold(db);
const port = +(process.env.PORT || 3000);
const server = createApp(db).listen(port, () => console.log(`Family Hub listening on http://localhost:${port}`));
function close() { server.close(() => { db.close(); process.exit(0); }); }
process.on('SIGTERM', close);
process.on('SIGINT', close);
