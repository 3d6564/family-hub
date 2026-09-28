import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { budgetSummary, chorePeriod, isChoreDue, monthKey } from '../src/domain.js';
import { assertSafeRemoteUrl, parseFeedEvents, validateFeedUrl } from '../src/ical.js';
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

test('calendar feed CRUD is adult-only, household-scoped, and never returns URLs', async (t) => {
  const previous = process.env.APP_ORIGIN; process.env.APP_ORIGIN = 'http://127.0.0.1';
  t.after(() => previous === undefined ? delete process.env.APP_ORIGIN : process.env.APP_ORIGIN = previous);
  const db = database(), home = household(db, 'Home'), password = await hashPassword('a secure password');
  const otherHome = household(db, 'Other');
  const adult = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'adult')").run(home, 'adult-feed@example.test', 'Adult', password).lastInsertRowid);
  const child = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'child')").run(home, 'child-feed@example.test', 'Child', password).lastInsertRowid);
  const adultToken = createSession(db, { householdId: home, userId: adult }), childToken = createSession(db, { householdId: home, userId: child });
  const server = createApp(db).listen(0); t.after(() => { server.close(); db.close(); });
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, route = `${base}/api/calendar/feeds`;
  const headers = { cookie: `family_user_session=${adultToken}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' };
  assert.equal((await fetch(route)).status, 401);
  assert.equal((await fetch(route, { headers: { cookie: `family_user_session=${childToken}` } })).status, 403);
  let response = await fetch(route, { method: 'POST', headers, body: JSON.stringify({ name: 'Family', url: 'https://calendar.example.test/private.ics', color: '#4285f4' }) });
  assert.equal(response.status, 201); const created = await response.json(); assert.equal(JSON.stringify(created).includes('private.ics'), false);
  db.prepare("INSERT INTO calendar_feeds(household_id,name,url,color) VALUES (?,?,?,?)").run(otherHome, 'Other private', 'https://other.example/secret.ics', '#ffffff');
  const list = await (await fetch(route, { headers })).json();
  assert.equal(list.length, 1); assert.equal(list[0].configured, 1); assert.equal(JSON.stringify(list).includes('private.ics'), false); assert.equal(JSON.stringify(list).includes('secret.ics'), false);
  assert.equal((await fetch(`${route}/${created.id}`, { method: 'PATCH', headers, body: JSON.stringify({ enabled: false }) })).status, 200);
  assert.equal((await fetch(`${route}/${created.id}`, { method: 'DELETE', headers })).status, 204);
});

test('calendar feed URL validation and production address checks block unsafe targets', async () => {
  assert.equal(validateFeedUrl('https://calendar.example/feed.ics').valid, true);
  assert.equal(validateFeedUrl('http://192.168.1.20/feed.ics').valid, true);
  assert.equal(validateFeedUrl('http://calendar.example/feed.ics').valid, false);
  assert.equal(validateFeedUrl('https://user:pass@calendar.example/feed.ics').valid, false);
  assert.equal(validateFeedUrl(`https://example.test/${'x'.repeat(4096)}`).valid, false);
  await assert.rejects(assertSafeRemoteUrl('https://calendar.example/feed.ics', async () => [{ address: '127.0.0.1' }]), /not allowed/);
  await assert.doesNotReject(assertSafeRemoteUrl('https://calendar.example/feed.ics', async () => [{ address: '203.0.113.10' }]));
});

test('iCal parsing expands recurring events and preserves all-day dates', () => {
  const source = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:daily\r\nDTSTART:20260901T090000Z\r\nDTEND:20260901T100000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Standup\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:day\r\nDTSTART;VALUE=DATE:20260902\r\nDTEND;VALUE=DATE:20260903\r\nSUMMARY:Day off\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  const events = parseFeedEvents(source, { id: 1, name: 'Work', color: '#123456' }, new Date('2026-09-01T00:00:00Z'), new Date('2026-09-05T00:00:00Z'));
  assert.equal(events.filter((event) => event.title === 'Standup').length, 3);
  assert.deepEqual(events.find((event) => event.title === 'Day off').start, { date: '2026-09-02' });
});

test('one feed failure does not hide local reminders or other feed events', async (t) => {
  const previous = process.env.APP_ORIGIN; process.env.APP_ORIGIN = 'http://127.0.0.1';
  t.after(() => previous === undefined ? delete process.env.APP_ORIGIN : process.env.APP_ORIGIN = previous);
  const db = database(), home = household(db, 'Home'), password = await hashPassword('a secure password');
  const adult = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'adult')").run(home, 'events@example.test', 'Adult', password).lastInsertRowid);
  db.prepare("INSERT INTO calendar_feeds(household_id,name,url,color) VALUES (?,?,?,?)").run(home, 'Broken', 'https://broken.example/feed.ics', '#111111');
  db.prepare("INSERT INTO calendar_feeds(household_id,name,url,color) VALUES (?,?,?,?)").run(home, 'Working', 'https://working.example/feed.ics', '#222222');
  db.prepare('INSERT INTO local_reminders(household_id,title,starts_at,created_by) VALUES (?,?,?,?)').run(home, 'Local', '2026-09-10T12:00:00.000Z', adult);
  const feedFetcher = async (feed) => {
    if (feed.name === 'Broken') throw new Error('invalid calendar data');
    return [{ id: 'feed:event', title: 'Remote', start: { date: '2026-09-11' }, end: { date: '2026-09-12' }, color: feed.color, calendar: feed.name, source: 'ical' }];
  };
  const token = createSession(db, { householdId: home, userId: adult }), server = createApp(db, { fetchFeedEvents: feedFetcher }).listen(0);
  t.after(() => { server.close(); db.close(); }); await new Promise((resolve) => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/calendar/events?from=2026-09-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z`, { headers: { cookie: `family_user_session=${token}` } });
  const body = await response.json();
  assert.deepEqual(body.events.map((event) => event.title), ['Local', 'Remote']);
  assert.deepEqual(body.errors, [{ feedId: 1, calendar: 'Broken', message: 'Could not load Broken: invalid calendar data' }]);
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
