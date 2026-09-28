import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { budgetSummary, chorePeriod, isChoreDue, monthKey } from '../src/domain.js';
import { classifyGoogleError, decryptTokens, encryptTokens, googleOAuthConfig } from '../src/google.js';
import { createApp } from '../src/app.js';
import { createPairingCode, createSession, digest, hashPassword, verifyPassword } from '../src/auth.js';

function database() { return openDatabase(':memory:'); }
function household(db, name) { return Number(db.prepare('INSERT INTO households(name,timezone) VALUES (?,?)').run(name, 'UTC').lastInsertRowid); }

test('budget totals include only the selected household and calendar month', () => {
  const db = database(), first = household(db, 'First'), second = household(db, 'Second');
  db.prepare('INSERT INTO grocery_budgets VALUES (?,?,?)').run(first, '2026-09', 50000);
  const add = db.prepare('INSERT INTO grocery_trips(household_id,amount_cents,occurred_on) VALUES (?,?,?)');
  add.run(first, 1200, '2026-09-01'); add.run(first, 3000, '2026-09-30'); add.run(first, 9000, '2026-10-01'); add.run(second, 8000, '2026-09-15');
  assert.deepEqual(budgetSummary(db, first, '2026-09'), { month: '2026-09', budgetCents: 50000, spentCents: 4200, remainingCents: 45800 });
  assert.equal(monthKey(new Date('2026-10-01T00:30:00Z'), 'America/Los_Angeles'), '2026-09'); db.close();
});

test('recurring chore keys reset daily and weekly', () => {
  assert.equal(chorePeriod('daily', new Date('2026-09-28T20:00:00Z')), '2026-09-28');
  assert.equal(chorePeriod('daily', new Date('2026-09-29T20:00:00Z')), '2026-09-29');
  assert.equal(chorePeriod('weekly', new Date('2026-09-28T12:00:00Z')), '2026-09-28');
  assert.equal(chorePeriod('weekly', new Date('2026-10-04T12:00:00Z')), '2026-09-28');
  assert.equal(chorePeriod('weekly', new Date('2026-10-05T12:00:00Z')), '2026-10-05');
  assert.equal(chorePeriod('once', new Date()), 'once');
});

test('chores become due only on their scheduled local days', () => {
  const on = (recurrence, dueOn, now) => isChoreDue({ recurrence, due_on: dueOn }, new Date(`${now}T12:00:00Z`), 'UTC');
  assert.equal(on('once', '2026-09-29', '2026-09-28'), false);
  assert.equal(on('once', '2026-09-29', '2026-09-29'), true);
  assert.equal(on('once', '2026-09-29', '2026-09-30'), false);
  assert.equal(on('daily', '2026-09-29', '2026-09-28'), false);
  assert.equal(on('daily', '2026-09-29', '2026-09-30'), true);
  assert.equal(on('weekly', '2026-09-29', '2026-10-05'), false);
  assert.equal(on('weekly', '2026-09-29', '2026-10-06'), true);
});

test('Google tokens encrypt at rest and errors expose useful states', () => {
  const key = Buffer.alloc(32, 7).toString('base64'), tokens = { access_token: 'private', refresh_token: 'refresh' };
  const encrypted = encryptTokens(tokens, key); assert.equal(encrypted.includes('private'), false); assert.deepEqual(decryptTokens(encrypted, key), tokens);
  assert.equal(classifyGoogleError({ response: { status: 401 } }).status, 'revoked');
  assert.equal(classifyGoogleError({ response: { status: 403 } }).status, 'unavailable');
  assert.match(classifyGoogleError(new Error('network')).message, /temporarily/);
});

test('Google OAuth config is adult-only, validated, encrypted, and preferred over environment fallback', async (t) => {
  const previous = {
    APP_ORIGIN: process.env.APP_ORIGIN,
    TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI
  };
  Object.assign(process.env, {
    APP_ORIGIN: 'http://127.0.0.1',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    GOOGLE_CLIENT_ID: 'environment-id',
    GOOGLE_CLIENT_SECRET: 'environment-secret',
    GOOGLE_REDIRECT_URI: 'https://environment.example.test/api/google/callback'
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  });

  const db = database(), home = household(db, 'Home'), password = await hashPassword('a secure password');
  const adult = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'adult')").run(home, 'adult-config@example.test', 'Adult', password).lastInsertRowid);
  const child = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'child')").run(home, 'child-config@example.test', 'Child', password).lastInsertRowid);
  const adultToken = createSession(db, { householdId: home, userId: adult }), childToken = createSession(db, { householdId: home, userId: child });
  const server = createApp(db).listen(0); t.after(() => { server.close(); db.close(); });
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, route = `${base}/api/google/config`;
  const headers = { cookie: `family_user_session=${adultToken}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' };

  assert.equal((await fetch(route)).status, 401);
  assert.equal((await fetch(route, { headers: { cookie: `family_user_session=${childToken}` } })).status, 403);
  assert.equal((await fetch(route, { method: 'PUT', headers: { ...headers, 'x-csrf-token': undefined }, body: '{}' })).status, 403);
  let response = await fetch(route, { method: 'PUT', headers, body: JSON.stringify({ clientId: 'id', clientSecret: 'secret', redirectUri: 'http://example.test/callback' }) });
  assert.equal(response.status, 400);
  response = await fetch(route, { method: 'PUT', headers, body: JSON.stringify({ clientId: 'database-id', clientSecret: 'database-secret', redirectUri: 'https://calendar.example.test/api/google/callback' }) });
  assert.equal(response.status, 200);

  const stored = db.prepare('SELECT * FROM deployment_settings WHERE id=1').get();
  assert.equal(stored.encrypted_google_client_secret.includes('database-secret'), false);
  assert.equal(decryptTokens(stored.encrypted_google_client_secret).clientSecret, 'database-secret');
  const status = await (await fetch(route, { headers: { cookie: `family_user_session=${adultToken}` } })).json();
  assert.deepEqual(status, { configured: true, clientId: 'database-id', redirectUri: 'https://calendar.example.test/api/google/callback', source: 'database', clientSecretConfigured: true });
  assert.equal(JSON.stringify(status).includes('database-secret'), false);
  assert.equal(googleOAuthConfig(db).clientId, 'database-id');
  db.prepare('DELETE FROM deployment_settings').run();
  assert.equal(googleOAuthConfig(db).clientId, 'environment-id');
});

test('household APIs do not allow cross-household item changes', async (t) => {
  const db = database(), first = household(db, 'First'), second = household(db, 'Second');
  const password = await hashPassword('a secure password');
  db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'adult')").run(first, 'one@example.test', 'One', password);
  const item = Number(db.prepare('INSERT INTO groceries(household_id,name) VALUES (?,?)').run(second, 'Private item').lastInsertRowid);
  process.env.APP_ORIGIN = 'http://127.0.0.1';
  const server = createApp(db).listen(0); t.after(() => { server.close(); db.close(); });
  await new Promise((resolve) => server.once('listening', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1', 'x-csrf-token': '1' }, body: JSON.stringify({ email: 'one@example.test', password: 'a secure password' }) });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /^family_user_session=/); const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${base}/api/groceries/${item}`, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1', 'x-csrf-token': '1', cookie }, body: JSON.stringify({ checked: true }) });
  assert.equal(response.status, 404); assert.equal(db.prepare('SELECT checked FROM groceries WHERE id=?').get(item).checked, 0);
});

test('completion history is adult-only and scoped to the household', async (t) => {
  const db = database(), first = household(db, 'First'), second = household(db, 'Second');
  const password = await hashPassword('a secure password');
  const adult = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'adult')").run(first, 'adult@example.test', 'Adult', password).lastInsertRowid);
  const other = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'child')").run(second, 'child@example.test', 'Other child', password).lastInsertRowid);
  const routine = Number(db.prepare('INSERT INTO routines(household_id,child_id,title) VALUES (?,?,?)').run(second, other, 'Private routine').lastInsertRowid);
  db.prepare('INSERT INTO routine_completions(routine_id,completed_on) VALUES (?,?)').run(routine, '2026-09-28');
  process.env.APP_ORIGIN = 'http://127.0.0.1'; const server = createApp(db).listen(0); t.after(() => { server.close(); db.close(); });
  await new Promise((resolve) => server.once('listening', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  const token = createSession(db, { householdId: first, userId: adult });
  const response = await fetch(`${base}/api/routines/history`, { headers: { cookie: `family_user_session=${token}` } });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), []);
});

test('paired devices can toggle tasks but cannot mutate household records', async (t) => {
  const db = database(), home = household(db, 'Home');
  const password = await hashPassword('a secure password');
  const child = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'child')").run(home, 'child@example.test', 'Child', password).lastInsertRowid);
  const routine = Number(db.prepare('INSERT INTO routines(household_id,child_id,title) VALUES (?,?,?)').run(home, child, 'Brush teeth').lastInsertRowid);
  process.env.APP_ORIGIN = 'http://127.0.0.1'; const server = createApp(db).listen(0); t.after(() => { server.close(); db.close(); });
  await new Promise((resolve) => server.once('listening', resolve)); const base = `http://127.0.0.1:${server.address().port}`, token = createSession(db, { householdId: home, kind: 'device', deviceName: 'Wall' });
  const headers = { cookie: `family_device_session=${token}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/routines/${routine}/toggle`, { method: 'POST', headers })).status, 200);
  for (const [path, method, body] of [['/api/groceries','POST',{name:'Milk'}],['/api/reminders','POST',{title:'No',startsAt:new Date().toISOString()}],['/api/trips','POST',{amountCents:1,occurredOn:'2026-09-28'}],['/api/plans','PUT',{plans:[]}],['/api/members','POST',{}]]) {
    assert.equal((await fetch(base + path, { method, headers, body: JSON.stringify(body) })).status, 403, `${method} ${path}`);
  }
});

test('adult sessions take priority and logout falls back to the paired device', async (t) => {
  const db = database(), home = household(db, 'Home');
  const password = await hashPassword('a secure password');
  const adult = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'adult')").run(home, 'adult@example.test', 'Adult', password).lastInsertRowid);
  const userToken = createSession(db, { householdId: home, userId: adult });
  const deviceToken = createSession(db, { householdId: home, kind: 'device', deviceName: 'Wall' });
  process.env.APP_ORIGIN = 'http://127.0.0.1'; const server = createApp(db).listen(0); t.after(() => { server.close(); db.close(); });
  await new Promise((resolve) => server.once('listening', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `family_device_session=${deviceToken}; family_user_session=${userToken}`;
  let response = await fetch(`${base}/api/me`, { headers: { cookie } });
  assert.equal((await response.json()).user.name, 'Adult');
  response = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie, origin: 'http://127.0.0.1', 'x-csrf-token': '1' } });
  assert.match(response.headers.get('set-cookie'), /^family_user_session=;/);
  assert.equal(db.prepare('SELECT 1 FROM sessions WHERE token_hash=?').get(digest(userToken)), undefined);
  assert.ok(db.prepare('SELECT 1 FROM sessions WHERE token_hash=?').get(digest(deviceToken)));
  response = await fetch(`${base}/api/me`, { headers: { cookie: `family_device_session=${deviceToken}` } });
  assert.deepEqual((await response.json()).device, 'Wall');
  const code = createPairingCode(db, home);
  response = await fetch(`${base}/api/pair`, { method: 'POST', headers: { origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Second wall' }) });
  assert.match(response.headers.get('set-cookie'), /^family_device_session=/);
});

test('password change keeps the current and device sessions and revokes other user sessions', async (t) => {
  const db = database(), home = household(db, 'Home');
  const oldPassword = await hashPassword('a secure password');
  const adult = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'adult')").run(home, 'adult@example.test', 'Adult', oldPassword).lastInsertRowid);
  const current = createSession(db, { householdId: home, userId: adult });
  const other = createSession(db, { householdId: home, userId: adult });
  const device = createSession(db, { householdId: home, kind: 'device', deviceName: 'Wall' });
  process.env.APP_ORIGIN = 'http://127.0.0.1'; const server = createApp(db).listen(0); t.after(() => { server.close(); db.close(); });
  await new Promise((resolve) => server.once('listening', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/password`, { method: 'POST', headers: { cookie: `family_user_session=${current}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: 'a secure password', newPassword: 'a newer secure password' }) });
  assert.equal(response.status, 200);
  assert.ok(db.prepare('SELECT 1 FROM sessions WHERE token_hash=?').get(digest(current)));
  assert.equal(db.prepare('SELECT 1 FROM sessions WHERE token_hash=?').get(digest(other)), undefined);
  assert.ok(db.prepare('SELECT 1 FROM sessions WHERE token_hash=?').get(digest(device)));
  assert.equal(await verifyPassword('a newer secure password', db.prepare('SELECT password_hash FROM users WHERE id=?').get(adult).password_hash), true);
  assert.equal((await fetch(`${base}/api/dashboard`)).status, 401);
});

test('temporary password exception and pairing codes stay limited to explicit helpers', async () => {
  await assert.rejects(hashPassword('password'), /12 characters/);
  assert.ok(await hashPassword('password', { allowTemporaryPassword: true }));
  const db = database(), home = household(db, 'Home');
  const code = createPairingCode(db, home);
  const pairing = db.prepare('SELECT * FROM pairing_codes WHERE code_hash=?').get(digest(code));
  assert.equal(code.length, 8); assert.equal(pairing.household_id, home); assert.equal(pairing.used_at, null);
  db.close();
});
