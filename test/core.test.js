import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { chorePeriod, isChoreDue, isDimTime, monthKey, parseDays } from '../src/domain.js';
import { assertSafeRemoteUrl, parseFeedEvents, validateFeedUrl } from '../src/ical.js';
import { createApp } from '../src/app.js';
import { createPairingCode, createSession, digest, hashPassword, verifyPassword } from '../src/auth.js';

function database() { return openDatabase(':memory:'); }
function household(db, name) { return Number(db.prepare('INSERT INTO households(name,timezone) VALUES (?,?)').run(name, 'UTC').lastInsertRowid); }

test('month keys use the household timezone', () => {
  assert.equal(monthKey(new Date('2026-10-01T00:30:00Z'), 'America/Los_Angeles'), '2026-09');
});

test('display dim follows the daily window, including overnight', () => {
  assert.equal(isDimTime('21:00', '07:00', new Date('2026-09-29T02:30:00Z'), 'UTC'), true);
  assert.equal(isDimTime('21:00', '07:00', new Date('2026-09-29T12:00:00Z'), 'UTC'), false);
  assert.equal(isDimTime('09:00', '17:00', new Date('2026-09-29T16:59:00Z'), 'UTC'), true);
  assert.equal(isDimTime('09:00', '09:00', new Date('2026-09-29T09:00:00Z'), 'UTC'), false);
});

test('recurring chore keys reset daily and weekly', () => {
  assert.equal(chorePeriod('daily', new Date('2026-09-28T20:00:00Z')), '2026-09-28');
  assert.equal(chorePeriod('daily', new Date('2026-09-29T20:00:00Z')), '2026-09-29');
  assert.equal(chorePeriod('weekly', new Date('2026-09-28T12:00:00Z')), '2026-09-28');
  assert.equal(chorePeriod('weekly', new Date('2026-10-04T12:00:00Z')), '2026-10-04');
  assert.equal(chorePeriod('weekly', new Date('2026-10-05T12:00:00Z')), '2026-10-05');
  assert.equal(chorePeriod('once', new Date()), 'once');
});

test('chores become due only on their scheduled local days', () => {
  const on = (recurrence, dueOn, now) => isChoreDue({ recurrence, due_on: dueOn }, new Date(`${now}T12:00:00Z`), 'UTC');
  assert.equal(on('once', '2026-09-29', '2026-09-28'), true);
  assert.equal(on('once', '2026-09-29', '2026-09-29'), true);
  assert.equal(on('once', '2026-09-29', '2026-09-30'), true);
  assert.equal(on('daily', '2026-09-29', '2026-09-28'), false);
  assert.equal(on('daily', '2026-09-29', '2026-09-30'), true);
  assert.equal(on('weekly', '2026-09-29', '2026-10-05'), false);
  assert.equal(on('weekly', '2026-09-29', '2026-10-06'), true);
});

test('a completed one-time chore leaves the list and yesterday does not count today', async (t) => {
  const previous = process.env.APP_ORIGIN; process.env.APP_ORIGIN = 'http://127.0.0.1';
  t.after(() => previous === undefined ? delete process.env.APP_ORIGIN : process.env.APP_ORIGIN = previous);
  const db = database(), home = household(db, 'Home'), password = await hashPassword('a secure password');
  db.prepare('UPDATE households SET timezone=? WHERE id=?').run('UTC', home);
  const adult = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'adult')").run(home, 'tasks@example.test', 'Adult', password).lastInsertRowid);
  const once = Number(db.prepare("INSERT INTO chores(household_id,title,recurrence,due_on) VALUES (?,?,'once','2026-09-29')").run(home, 'One poster').lastInsertRowid);
  const daily = Number(db.prepare("INSERT INTO chores(household_id,title,recurrence,due_on,days) VALUES (?,?,'daily','2026-09-28','1,2,3,4,5')").run(home, 'Make bed').lastInsertRowid);
  db.prepare('INSERT INTO chore_completions(chore_id,period_key) VALUES (?,?)').run(daily, '2026-09-28');
  const token = createSession(db, { householdId: home, userId: adult });
  const server = createApp(db).listen(0); t.after(() => { server.close(); db.close(); });
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, headers = { cookie: `family_user_session=${token}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1' };
  assert.equal((await fetch(`${base}/api/chores/${once}/toggle`, { method: 'POST', headers })).status, 200);
  const body = await (await fetch(`${base}/api/dashboard`, { headers })).json();
  assert.equal(body.chores.some((chore) => chore.id === once), false);
  assert.equal(body.chores.find((chore) => chore.id === daily)?.completed, false);
  assert.equal(db.prepare('SELECT active FROM chores WHERE id=?').get(once).active, 0);
});

test('one routine can be completed separately by each assigned child', async (t) => {
  const previous = process.env.APP_ORIGIN; process.env.APP_ORIGIN = 'http://127.0.0.1';
  t.after(() => previous === undefined ? delete process.env.APP_ORIGIN : process.env.APP_ORIGIN = previous);
  const db = database(), home = household(db, 'Home'), password = await hashPassword('a secure password');
  const adult = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'adult')").run(home, 'adult-routine@example.test', 'Adult', password).lastInsertRowid);
  const first = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'child')").run(home, 'one@example.test', 'Sydney', password).lastInsertRowid);
  const second = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'child')").run(home, 'two@example.test', 'Alex', password).lastInsertRowid);
  const server = createApp(db).listen(0); t.after(() => { server.close(); db.close(); });
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, headers = { cookie: `family_user_session=${createSession(db, { householdId: home, userId: adult })}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/routines`, { method: 'POST', headers, body: JSON.stringify({ title: 'Brush teeth', days: '0-6', period: 'morning', childIds: [first, second] }) })).status, 201);
  const dashboard = await (await fetch(`${base}/api/dashboard`, { headers })).json();
  const rows = dashboard.routines.filter((routine) => routine.title === 'Brush teeth');
  assert.deepEqual(rows.map((routine) => routine.child_name).sort(), ['Alex', 'Sydney']);
  assert.equal(rows[0].period, 'morning');
  assert.equal((await fetch(`${base}/api/routines/${rows[0].id}/toggle`, { method: 'POST', headers, body: JSON.stringify({ childId: first }) })).status, 200);
  const after = await (await fetch(`${base}/api/dashboard`, { headers })).json();
  assert.equal(after.routines.find((routine) => routine.child_id === first).completed, 1);
  assert.equal(after.routines.find((routine) => routine.child_id === second).completed, 0);
});

test('day patterns accept names, numbers, and ranges', () => {
  assert.equal(parseDays('0-6'), '0,1,2,3,4,5,6');
  assert.equal(parseDays('m-f'), '1,2,3,4,5');
  assert.equal(parseDays('m,tu,th,f'), '1,2,4,5');
  assert.equal(parseDays('fri-mon'), null);
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
  response = await fetch(`${route}/${created.id}`, { method: 'PATCH', headers, body: JSON.stringify({ name: 'Updated family', url: 'https://calendar.example.test/updated.ics', color: '#123456' }) });
  assert.equal(response.status, 200); assert.deepEqual(db.prepare('SELECT name,url,color FROM calendar_feeds WHERE id=?').get(created.id), { name: 'Updated family', url: 'https://calendar.example.test/updated.ics', color: '#123456' });
  assert.equal((await fetch(`${route}/${created.id}`, { method: 'DELETE', headers })).status, 204);
});

test('children can be added without login details and adults cannot', async (t) => {
  const previous = process.env.APP_ORIGIN; process.env.APP_ORIGIN = 'http://127.0.0.1';
  t.after(() => previous === undefined ? delete process.env.APP_ORIGIN : process.env.APP_ORIGIN = previous);
  const db = database(), home = household(db, 'Home'), password = await hashPassword('a secure password');
  const adult = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'adult')").run(home, 'adult@example.test', 'Adult', password).lastInsertRowid);
  const server = createApp(db).listen(0); t.after(() => { server.close(); db.close(); }); await new Promise((resolve) => server.once('listening', resolve));
  const headers = { cookie: `family_user_session=${createSession(db, { householdId: home, userId: adult })}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' }, base = `http://127.0.0.1:${server.address().port}`, route = `${base}/api/members`;
  const childResponse = await fetch(route, { method: 'POST', headers, body: JSON.stringify({ name: 'Child', role: 'child' }) });
  assert.equal(childResponse.status, 201); const child = await childResponse.json();
  assert.match(db.prepare("SELECT email FROM users WHERE name='Child'").get().email, /^child-[\w-]+@family-hub\.invalid$/);
  assert.equal((await fetch(`${route}/${child.id}`, { method: 'PATCH', headers, body: JSON.stringify({ name: 'Updated child', role: 'child' }) })).status, 200);
  assert.equal(db.prepare('SELECT name FROM users WHERE id=?').get(child.id).name, 'Updated child');
  const listedChild = (await (await fetch(route, { headers })).json()).find((member) => member.id === child.id);
  assert.equal(listedChild.has_email, 0);
  assert.equal((await fetch(route, { method: 'POST', headers, body: JSON.stringify({ name: 'Adult two', role: 'adult' }) })).status, 400);
  assert.equal((await fetch(`${base}/api/household/week-start`, { method: 'PUT', headers, body: JSON.stringify({ weekStartsOn: 0 }) })).status, 200);
  assert.equal(db.prepare('SELECT week_starts_on FROM households WHERE id=?').get(home).week_starts_on, 0);
  assert.equal((await fetch(`${base}/api/household/dim`, { method: 'PUT', headers, body: JSON.stringify({ dimEnabled: true, dimStart: '21:00', dimEnd: '07:00' }) })).status, 200);
  assert.equal(db.prepare('SELECT dim_enabled FROM households WHERE id=?').get(home).dim_enabled, 1);
  assert.equal((await fetch(`${base}/api/household/dim`, { method: 'PUT', headers, body: JSON.stringify({ dimEnabled: true, dimStart: '21:00', dimEnd: '21:00' }) })).status, 400);
  assert.equal((await fetch(`${base}/api/household/theme`, { method: 'PUT', headers, body: JSON.stringify({ theme: 'slate' }) })).status, 200);
  assert.equal(db.prepare('SELECT theme FROM households WHERE id=?').get(home).theme, 'slate');
  assert.equal((await fetch(`${base}/api/household/theme`, { method: 'PUT', headers, body: JSON.stringify({ theme: 'purple' }) })).status, 400);
});

test('adults can reorder every routine in their household', async (t) => {
  const previous = process.env.APP_ORIGIN; process.env.APP_ORIGIN = 'http://127.0.0.1';
  t.after(() => previous === undefined ? delete process.env.APP_ORIGIN : process.env.APP_ORIGIN = previous);
  const db = database(), home = household(db, 'Home'), other = household(db, 'Other'), password = await hashPassword('a secure password');
  const adult = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'adult')").run(home, 'adult@example.test', 'Adult', password).lastInsertRowid);
  const child = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'child')").run(home, 'child@example.test', 'Child', password).lastInsertRowid);
  const first = Number(db.prepare('INSERT INTO routines(household_id,child_id,title,sort_order) VALUES (?,?,?,?)').run(home, child, 'First', 0).lastInsertRowid);
  const second = Number(db.prepare('INSERT INTO routines(household_id,child_id,title,sort_order) VALUES (?,?,?,?)').run(home, child, 'Second', 1).lastInsertRowid);
  db.prepare('INSERT INTO routines(household_id,child_id,title,sort_order) VALUES (?,?,?,?)').run(other, child, 'Private', 0);
  const server = createApp(db).listen(0); t.after(() => { server.close(); db.close(); }); await new Promise((resolve) => server.once('listening', resolve));
  const headers = { cookie: `family_user_session=${createSession(db, { householdId: home, userId: adult })}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' };
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/routine-order`, { method: 'PUT', headers, body: JSON.stringify({ ids: [second, first] }) })).status, 200);
  assert.deepEqual(db.prepare('SELECT id FROM routines WHERE household_id=? ORDER BY sort_order').all(home).map((row) => row.id), [second, first]);
});

test('adults can edit routines, chores, and reminders in their household', async (t) => {
  const previous = process.env.APP_ORIGIN; process.env.APP_ORIGIN = 'http://127.0.0.1';
  t.after(() => previous === undefined ? delete process.env.APP_ORIGIN : process.env.APP_ORIGIN = previous);
  const db = database(), home = household(db, 'Home'), password = await hashPassword('a secure password');
  const adult = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'adult')").run(home, 'adult@example.test', 'Adult', password).lastInsertRowid);
  const child = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'child')").run(home, 'child@example.test', 'Child', password).lastInsertRowid);
  const routine = Number(db.prepare('INSERT INTO routines(household_id,child_id,title,days) VALUES (?,?,?,?)').run(home, child, 'Old routine', '1,2').lastInsertRowid);
  const chore = Number(db.prepare('INSERT INTO chores(household_id,assignee_id,title,recurrence,due_on) VALUES (?,?,?,?,?)').run(home, child, 'Old chore', 'once', '2026-09-28').lastInsertRowid);
  const reminder = Number(db.prepare('INSERT INTO local_reminders(household_id,title,starts_at,created_by) VALUES (?,?,?,?)').run(home, 'Old reminder', '2026-09-28T12:00:00.000Z', adult).lastInsertRowid);
  const server = createApp(db).listen(0); t.after(() => { server.close(); db.close(); }); await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, headers = { cookie: `family_user_session=${createSession(db, { householdId: home, userId: adult })}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/routines/${routine}`, { method: 'PATCH', headers, body: JSON.stringify({ title: 'New routine', days: '1,2,3' }) })).status, 200);
  assert.equal((await fetch(`${base}/api/chores/${chore}`, { method: 'PATCH', headers, body: JSON.stringify({ title: 'New chore', recurrence: 'scheduled', days: 'sat' }) })).status, 200);
  assert.equal((await fetch(`${base}/api/reminders/${reminder}`, { method: 'PATCH', headers, body: JSON.stringify({ title: 'New reminder', startsAt: '2026-09-29T12:00:00.000Z' }) })).status, 200);
  assert.equal(db.prepare('SELECT title FROM routines WHERE id=?').get(routine).title, 'New routine');
  assert.equal(db.prepare('SELECT recurrence FROM chores WHERE id=?').get(chore).recurrence, 'weekly');
  assert.equal(db.prepare('SELECT title FROM local_reminders WHERE id=?').get(reminder).title, 'New reminder');
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
  const item = Number(db.prepare("INSERT INTO chores(household_id,title,due_on) VALUES (?,?,?)").run(second, 'Private chore', '2026-09-28').lastInsertRowid);
  process.env.APP_ORIGIN = 'http://127.0.0.1';
  const server = createApp(db).listen(0); t.after(() => { server.close(); db.close(); });
  await new Promise((resolve) => server.once('listening', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1', 'x-csrf-token': '1' }, body: JSON.stringify({ email: 'one@example.test', password: 'a secure password' }) });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /^family_user_session=/); const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${base}/api/chores/${item}`, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1', 'x-csrf-token': '1', cookie }, body: JSON.stringify({ title: 'Changed' }) });
  assert.equal(response.status, 404); assert.equal(db.prepare('SELECT title FROM chores WHERE id=?').get(item).title, 'Private chore');
});

test('completion history is adult-only and scoped to the household', async (t) => {
  const db = database(), first = household(db, 'First'), second = household(db, 'Second');
  const password = await hashPassword('a secure password');
  const adult = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'adult')").run(first, 'adult@example.test', 'Adult', password).lastInsertRowid);
  const other = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'child')").run(second, 'child@example.test', 'Other child', password).lastInsertRowid);
  const routine = Number(db.prepare('INSERT INTO routines(household_id,child_id,title) VALUES (?,?,?)').run(second, other, 'Private routine').lastInsertRowid);
  db.prepare('INSERT INTO routine_assignees(routine_id,child_id) VALUES (?,?)').run(routine, other);
  db.prepare('INSERT INTO routine_completions(routine_id,child_id,completed_on) VALUES (?,?,?)').run(routine, other, '2026-09-28');
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
  for (const [path, method, body] of [['/api/reminders','POST',{title:'No',startsAt:new Date().toISOString()}],['/api/plans','PUT',{plans:[]}],['/api/members','POST',{}],['/api/routine-order','PUT',{ids:[]}]]) {
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
