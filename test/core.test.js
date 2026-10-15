import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.js';
import { validateFamilyHubDatabase, writeBackup } from '../src/backup.js';
import { calendarGridWindow, eventSpanDays } from '../public/calendar-view.js';
import { routinePeriodGroups } from '../public/routine-view.js';
import { chorePeriod, isChoreDue, isDimTime, monthKey, parseDays } from '../src/domain.js';
import { assertSafeRemoteUrl, parseFeedEvents, validateFeedUrl } from '../src/ical.js';
import { createApp } from '../src/app.js';
import { forecastFromOpenWeather, locationQueries, openMeteoCondition, pirateCondition, publicForecast, weatherApiCondition, weatherCondition } from '../src/weather.js';
import { createPairingCode, createSession, digest, hashPassword, verifyPassword } from '../src/auth.js';

function database() { return openDatabase(':memory:'); }
function household(db, name) { return Number(db.prepare('INSERT INTO households(name,timezone) VALUES (?,?)').run(name, 'UTC').lastInsertRowid); }

test('readiness reports database availability without authentication', async (t) => {
  const db = database(), server = createApp(db).listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/health/ready`;
  let response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), 'ready');
  db.close();
  response = await fetch(url);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'unavailable');
});

test('month keys use the household timezone', () => {
  assert.equal(monthKey(new Date('2026-10-01T00:30:00Z'), 'America/Los_Angeles'), '2026-09');
});

test('multi-day events cover each inclusive day', () => {
  const allDay = eventSpanDays({ start: { date: '2026-10-05' }, end: { date: '2026-10-08' } });
  assert.deepEqual(allDay.map((day) => day.date), ['2026-10-05', '2026-10-06', '2026-10-07']);
  assert.deepEqual(allDay.map((day) => day.position), ['start', 'middle', 'end']);
  const timed = eventSpanDays({ start: { dateTime: '2026-10-05T21:00:00' }, end: { dateTime: '2026-10-07T08:00:00' } });
  assert.deepEqual(timed.map((day) => day.date), ['2026-10-05', '2026-10-06', '2026-10-07']);
  assert.equal(eventSpanDays({ start: { date: '2026-10-05' }, end: { date: '2026-10-06' } })[0].position, 'single');
});

test('ended routine periods hide finished items and keep unfinished items', () => {
  const routines = [
    { title: 'Brush', period: 'morning', completed: 1 },
    { title: 'Read', period: 'morning', completed: 0 },
    { title: 'Pack', period: 'after_school', completed: 0 },
    { title: 'Snack', period: 'after_school', completed: 1 },
    { title: 'Pajamas', period: 'bedtime', completed: 0 },
  ];
  const afternoon = routinePeriodGroups(routines, 'after_school', ['morning']);
  assert.deepEqual(afternoon.map((group) => [group.period, group.open, group.items.map((item) => item.title)]), [
    ['morning', true, ['Read']],
    ['after_school', true, ['Pack', 'Snack']],
    ['bedtime', false, ['Pajamas']],
  ]);
  const bedtime = routinePeriodGroups([{ title: 'Brush', period: 'morning', completed: 1 }], 'bedtime', ['morning', 'after_school']);
  assert.deepEqual(bedtime.map((group) => group.period), ['bedtime']);
  const overnight = routinePeriodGroups(routines, 'bedtime', []);
  assert.deepEqual(overnight.map((group) => group.period), ['bedtime', 'morning', 'after_school']);
  assert.equal(overnight[1].items.length, 2);
  assert.equal(overnight[1].open, false);
});

test('calendar rolls to the current week in the live month final week', () => {
  const month = new Date(2026, 8, 1), mondayStart = calendarGridWindow(month, new Date(2026, 8, 30), 1);
  assert.equal(mondayStart.rollingForward, true);
  assert.equal(mondayStart.gridStart.toDateString(), new Date(2026, 8, 28).toDateString());
  assert.equal(mondayStart.cellCount, 35);
  const beforeFinalWeek = calendarGridWindow(month, new Date(2026, 8, 27), 1);
  assert.equal(beforeFinalWeek.rollingForward, false);
  assert.equal(beforeFinalWeek.gridStart.toDateString(), new Date(2026, 7, 31).toDateString());
  assert.equal(calendarGridWindow(month, new Date(2026, 8, 30), 1, true).rollingForward, false);
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
  response = await fetch(route, { method: 'POST', headers, body: JSON.stringify({ name: 'Work', url: 'https://calendar.example.test/work.ics', color: '#123456' }) });
  assert.equal(response.status, 201); const second = await response.json();
  db.prepare("INSERT INTO calendar_feeds(household_id,name,url,color) VALUES (?,?,?,?)").run(otherHome, 'Other private', 'https://other.example/secret.ics', '#ffffff');
  const list = await (await fetch(route, { headers })).json();
  assert.equal(list.length, 2); assert.deepEqual(list.map((feed) => feed.id), [created.id, second.id]); assert.equal(list[0].configured, 1); assert.equal(JSON.stringify(list).includes('private.ics'), false); assert.equal(JSON.stringify(list).includes('secret.ics'), false);
  assert.equal((await fetch(`${base}/api/calendar/feed-order`, { method: 'PUT', headers, body: JSON.stringify({ ids: [second.id, created.id] }) })).status, 200);
  assert.deepEqual((await (await fetch(route, { headers })).json()).map((feed) => feed.id), [second.id, created.id]);
  assert.equal((await fetch(`${base}/api/calendar/feed-order`, { method: 'PUT', headers, body: JSON.stringify({ ids: [created.id] }) })).status, 400);
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
  assert.equal((await fetch(`${base}/api/household/display-title`, { method: 'PUT', headers, body: JSON.stringify({ displayTitle: 'Robinson Family' }) })).status, 200);
  assert.equal(db.prepare('SELECT display_title FROM households WHERE id=?').get(home).display_title, 'Robinson Family');
  assert.equal((await fetch(`${base}/api/household/display-title`, { method: 'PUT', headers, body: JSON.stringify({ displayTitle: 'x'.repeat(61) }) })).status, 400);
  assert.equal((await fetch(`${base}/api/household/display-title`, { method: 'PUT', headers, body: JSON.stringify({ displayTitle: '' }) })).status, 200);
  assert.equal(db.prepare('SELECT display_title FROM households WHERE id=?').get(home).display_title, null);
  assert.equal((await fetch(`${base}/api/household/dim`, { method: 'PUT', headers, body: JSON.stringify({ dimEnabled: true, dimStart: '21:00', dimEnd: '07:00' }) })).status, 200);
  assert.equal(db.prepare('SELECT dim_enabled FROM households WHERE id=?').get(home).dim_enabled, 1);
  assert.equal((await fetch(`${base}/api/household/dim`, { method: 'PUT', headers, body: JSON.stringify({ dimEnabled: true, dimStart: '21:00', dimEnd: '21:00' }) })).status, 400);
  assert.equal((await fetch(`${base}/api/household/routine-times`, { method: 'PUT', headers, body: JSON.stringify({ morningStart: '07:00', afternoonStart: '12:00', bedtimeStart: '18:00' }) })).status, 200);
  assert.deepEqual(db.prepare('SELECT routine_morning_start,routine_afternoon_start,routine_bedtime_start FROM households WHERE id=?').get(home), { routine_morning_start: '07:00', routine_afternoon_start: '12:00', routine_bedtime_start: '18:00' });
  assert.equal((await fetch(`${base}/api/household/routine-times`, { method: 'PUT', headers, body: JSON.stringify({ morningStart: '12:00', afternoonStart: '07:00', bedtimeStart: '18:00' }) })).status, 400);
  assert.equal((await fetch(`${base}/api/household/theme`, { method: 'PUT', headers, body: JSON.stringify({ theme: 'slate' }) })).status, 200);
  assert.equal(db.prepare('SELECT theme FROM households WHERE id=?').get(home).theme, 'slate');
  assert.equal((await fetch(`${base}/api/household/theme`, { method: 'PUT', headers, body: JSON.stringify({ theme: 'purple' }) })).status, 400);
});

test('OpenWeatherMap daily forecast keeps the midday condition and hides the API key', () => {
  assert.deepEqual(locationQueries('Decatur, IL'), ['Decatur,IL', 'Decatur,IL,US']);
  assert.equal(weatherCondition(800), 'clear');
  assert.equal(weatherCondition(500), 'rain');
  assert.equal(openMeteoCondition(95), 'storm');
  assert.equal(weatherApiCondition(1000), 'clear');
  assert.equal(pirateCondition('snow'), 'snow');
  const forecast = forecastFromOpenWeather({
    city: { timezone: 0, name: 'Chicago' },
    list: [12, 15, 18].flatMap((hour) => ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'].map((date) => ({
      dt: Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`) / 1000,
      main: { temp_min: 50 + hour / 10, temp_max: 70 },
      weather: [{ id: hour === 15 ? 800 : 500 }],
    }))),
  }, 'f', 'Chicago, IL');
  assert.equal(forecast.days.length, 5);
  assert.equal(forecast.days[0].condition, 'clear');
  assert.equal(forecast.days[0].high, 70);
  assert.equal(forecast.place, 'Chicago, IL');
});

test('weather settings hide the API key and use OpenWeatherMap', async (t) => {
  const previous = process.env.APP_ORIGIN; process.env.APP_ORIGIN = 'http://127.0.0.1';
  t.after(() => previous === undefined ? delete process.env.APP_ORIGIN : process.env.APP_ORIGIN = previous);
  const db = database(), home = household(db, 'Home'), password = await hashPassword('a secure password');
  const adult = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'adult')").run(home, 'weather@example.test', 'Adult', password).lastInsertRowid);
  const calls = [];
  const fetchForecast = async (settings) => {
    calls.push(settings.apiKey);
    return { place: settings.location, units: settings.units, apiKey: settings.apiKey, days: ['Fri', 'Sat', 'Sun', 'Mon', 'Tue'].map((label) => ({ label, condition: 'clear', high: 70.2, low: 51.4 })) };
  };
  const server = createApp(db, { fetchForecast }).listen(0); t.after(() => { server.close(); db.close(); });
  await new Promise((resolve) => server.once('listening', resolve));
  const headers = { cookie: `family_user_session=${createSession(db, { householdId: home, userId: adult })}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' };
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/household/weather`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true, units: 'f' }) })).status, 400);
  const saved = await (await fetch(`${base}/api/household/weather`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true, location: 'Chicago', units: 'f', apiKey: 'secret-weather-key' }) })).json();
  assert.equal(saved.hasKey.openweathermap, true);
  assert.equal(JSON.stringify(saved).includes('secret-weather-key'), false);
  const listed = await (await fetch(`${base}/api/household/weather`, { headers })).json();
  assert.equal(listed.provider, 'openweathermap');
  assert.equal(listed.keys.openweathermap, 'secret-weather-key');
  assert.equal(listed.days, 5);
  const shown = await (await fetch(`${base}/api/dashboard`, { headers })).json();
  assert.equal(shown.weather.days.length, 5);
  assert.equal(shown.weather.days[0].high, 70);
  assert.equal(JSON.stringify(shown).includes('secret-weather-key'), false);
  await fetch(`${base}/api/dashboard`, { headers });
  assert.equal(calls.length, 1);
  assert.equal((await fetch(`${base}/api/household/weather`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true, location: 'Chicago', units: 'c', apiKey: '' }) })).status, 200);
  assert.equal(db.prepare('SELECT weather_api_key FROM households WHERE id=?').get(home).weather_api_key, 'secret-weather-key');
  const swapped = await (await fetch(`${base}/api/household/weather`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true, location: 'Chicago', units: 'f', provider: 'pirateweather', days: 2, showPrecip: true, showCurrent: true, keys: { pirateweather: 'pirate-key' } }) })).json();
  assert.equal(swapped.provider, 'pirateweather');
  assert.equal(swapped.days, 2);
  assert.equal(JSON.stringify(swapped).includes('pirate-key'), false);
  const both = await (await fetch(`${base}/api/household/weather`, { headers })).json();
  assert.equal(both.keys.openweathermap, 'secret-weather-key');
  assert.equal(both.keys.pirateweather, 'pirate-key');
  const edited = await (await fetch(`${base}/api/household/weather`, { method: 'PUT', headers, body: JSON.stringify({ provider: 'pirateweather', keys: { pirateweather: 'pirate-key-2' } }) })).json();
  assert.equal(edited.hasKey.pirateweather, true);
  assert.equal((await (await fetch(`${base}/api/household/weather`, { headers })).json()).keys.pirateweather, 'pirate-key-2');
  assert.equal((await (await fetch(`${base}/api/household/weather`, { headers })).json()).keys.openweathermap, 'secret-weather-key');
  const short = await (await fetch(`${base}/api/dashboard`, { headers })).json();
  assert.equal(short.weather.days.length, 2);
  assert.equal(short.weather.show.precip, true);
  assert.equal(publicForecast({ place: 'Chicago', units: 'f', days: [{ label: 'Fri', condition: 'clear', high: 70, low: 50, precip: 12.4 }] }).days[0].precip, 12);
  assert.equal((await fetch(`${base}/api/household/weather`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true, provider: 'weatherapi', keys: { weatherapi: '' } }) })).status, 400);
  const deviceHeaders = { cookie: `family_device_session=${createSession(db, { householdId: home, kind: 'device', deviceName: 'Wall' })}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1' };
  assert.equal((await fetch(`${base}/api/household/weather`, { headers: deviceHeaders })).status, 403);
  const wall = await (await fetch(`${base}/api/dashboard`, { headers: deviceHeaders })).json();
  assert.equal(JSON.stringify(wall).includes('secret-weather-key'), false);
  assert.equal(JSON.stringify(wall).includes('pirate-key'), false);
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
  assert.equal((await fetch(`${base}/api/chores/${chore}`, { method: 'PATCH', headers, body: JSON.stringify({ title: 'New chore', recurrence: 'scheduled', days: 'sat', rewardAmount: 0.75, assigneeId: null }) })).status, 200);
  assert.equal((await fetch(`${base}/api/reminders/${reminder}`, { method: 'PATCH', headers, body: JSON.stringify({ title: 'New reminder', startsAt: '2026-09-29T12:00:00.000Z' }) })).status, 200);
  assert.equal(db.prepare('SELECT title FROM routines WHERE id=?').get(routine).title, 'New routine');
  assert.equal(db.prepare('SELECT recurrence FROM chores WHERE id=?').get(chore).recurrence, 'weekly');
  assert.equal(db.prepare('SELECT reward_quarters FROM chores WHERE id=?').get(chore).reward_quarters, 3);
  assert.equal(db.prepare('SELECT assignee_id FROM chores WHERE id=?').get(chore).assignee_id, null);
  assert.equal((await fetch(`${base}/api/chores/${chore}`, { method: 'PATCH', headers, body: JSON.stringify({ rewardAmount: 0.10 }) })).status, 400);
  assert.equal((await fetch(`${base}/api/chores`, { method: 'POST', headers, body: JSON.stringify({ title: 'Quarter chore', assigneeId: child, recurrence: 'scheduled', days: 'sat', rewardAmount: 0.25 }) })).status, 201);
  assert.equal(db.prepare("SELECT reward_quarters FROM chores WHERE title='Quarter chore'").get().reward_quarters, 1);
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
  db.prepare("INSERT INTO calendar_feeds(household_id,name,url,color) VALUES (?,?,?,?)").run(home, 'Also working', 'https://also.example/feed.ics', '#333333');
  db.prepare('INSERT INTO local_reminders(household_id,title,starts_at,created_by) VALUES (?,?,?,?)').run(home, 'Local', '2026-09-10T12:00:00.000Z', adult);
  const feedFetcher = async (feed) => {
    if (feed.name === 'Broken') throw new Error('invalid calendar data');
    const start = feed.name === 'Also working' ? '2026-09-11T18:00:00.000Z' : '2026-09-11T09:00:00.000Z';
    return [{ id: 'feed:event', title: feed.name, start: { dateTime: start }, end: null, color: feed.color, calendar: feed.name, source: 'ical' }];
  };
  const token = createSession(db, { householdId: home, userId: adult }), server = createApp(db, { fetchFeedEvents: feedFetcher }).listen(0);
  t.after(() => { server.close(); db.close(); }); await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, headers = { cookie: `family_user_session=${token}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/calendar/feed-order`, { method: 'PUT', headers, body: JSON.stringify({ ids: [1, 3, 2] }) })).status, 200);
  const response = await fetch(`${base}/api/calendar/events?from=2026-09-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z`, { headers });
  const body = await response.json();
  assert.deepEqual(body.events.map((event) => event.title), ['Local', 'Also working', 'Working']);
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

test('paired displays report screen dimensions for adult settings', async (t) => {
  const db = database(), home = household(db, 'Home');
  const password = await hashPassword('a secure password');
  const adult = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'adult')").run(home, 'screen@example.test', 'Adult', password).lastInsertRowid);
  const deviceToken = createSession(db, { householdId: home, kind: 'device', deviceName: 'Kitchen' });
  const adultToken = createSession(db, { householdId: home, userId: adult });
  process.env.APP_ORIGIN = 'http://127.0.0.1'; const server = createApp(db).listen(0); t.after(() => { server.close(); db.close(); });
  await new Promise((resolve) => server.once('listening', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/device/screen`, { method: 'POST', headers: { cookie: `family_device_session=${deviceToken}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' }, body: JSON.stringify({ screenWidth: 1920, screenHeight: 1080, viewportWidth: 1280, viewportHeight: 720, pixelRatio: 1.5 }) });
  assert.equal(response.status, 200);
  const devices = await (await fetch(`${base}/api/devices`, { headers: { cookie: `family_user_session=${adultToken}` } })).json();
  assert.equal(devices[0].device_name, 'Kitchen');
  assert.equal(devices[0].screen_width, 1920);
  assert.equal(devices[0].viewport_width, 1280);
  assert.equal(devices[0].pixel_ratio, 1.5);
  assert.ok(devices[0].last_seen_at);
});

test('paired displays report dimensions while an adult session is active', async (t) => {
  const db = database(), home = household(db, 'Home');
  const password = await hashPassword('a secure password');
  const adult = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'adult')").run(home, 'mixed-screen@example.test', 'Adult', password).lastInsertRowid);
  const deviceToken = createSession(db, { householdId: home, kind: 'device', deviceName: 'Phone' });
  const adultToken = createSession(db, { householdId: home, userId: adult });
  process.env.APP_ORIGIN = 'http://127.0.0.1'; const server = createApp(db).listen(0); t.after(() => { server.close(); db.close(); });
  await new Promise((resolve) => server.once('listening', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { cookie: `family_device_session=${deviceToken}; family_user_session=${adultToken}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' };
  const response = await fetch(`${base}/api/device/screen`, { method: 'POST', headers, body: JSON.stringify({ screenWidth: 1179, screenHeight: 2556, viewportWidth: 393, viewportHeight: 852, pixelRatio: 3 }) });
  assert.equal(response.status, 200);
  const device = db.prepare("SELECT screen_width,screen_height,viewport_width,viewport_height FROM sessions WHERE kind='device' AND device_name='Phone'").get();
  assert.deepEqual(device, { screen_width: 1179, screen_height: 2556, viewport_width: 393, viewport_height: 852 });
});

test('token board is off by default and can be enabled by an adult', async (t) => {
  const db = database(), home = household(db, 'Home');
  const password = await hashPassword('a secure password');
  const adult = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'adult')").run(home, 'board@example.test', 'Adult', password).lastInsertRowid);
  const token = createSession(db, { householdId: home, userId: adult });
  process.env.APP_ORIGIN = 'http://127.0.0.1'; const server = createApp(db).listen(0); t.after(() => { server.close(); db.close(); });
  await new Promise((resolve) => server.once('listening', resolve)); const base = `http://127.0.0.1:${server.address().port}`, headers = { cookie: `family_user_session=${token}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' };
  assert.equal((await (await fetch(`${base}/api/me`, { headers })).json()).household.tokenBoardEnabled, false);
  const saved = await (await fetch(`${base}/api/household/token-board`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) })).json();
  assert.equal(saved.tokenBoardEnabled, true);
  assert.equal((await (await fetch(`${base}/api/me`, { headers })).json()).household.tokenBoardEnabled, true);
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

test('token withdrawals keep the earned total and cannot spend more than is available', async (t) => {
  const previous = process.env.APP_ORIGIN; process.env.APP_ORIGIN = 'http://127.0.0.1';
  t.after(() => previous === undefined ? delete process.env.APP_ORIGIN : process.env.APP_ORIGIN = previous);
  const db = database(), home = household(db, 'Home'), other = household(db, 'Other'), password = await hashPassword('a secure password');
  const day = (offset) => { const date = new Date(); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); };
  const sydney = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'child')").run(home, 'sydney@example.test', 'Sydney', password).lastInsertRowid);
  const adult = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'adult')").run(home, 'tokens@example.test', 'Adult', password).lastInsertRowid);
  const otherChild = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'child')").run(other, 'other-child@example.test', 'Other', password).lastInsertRowid);
  const insertChore = (title, quarters) => Number(db.prepare('INSERT INTO chores(household_id,assignee_id,title,recurrence,due_on,days,reward_quarters) VALUES (?,?,?,?,?,?,?)').run(home, sydney, title, 'daily', day(0), '0,1,2,3,4,5,6', quarters).lastInsertRowid);
  const old = insertChore('Old', 4), recent = insertChore('Yesterday', 2), current = insertChore('Today', 1);
  db.prepare('INSERT INTO chore_completions(chore_id,period_key,completed_at) VALUES (?,?,?)').run(old, day(-3), `${day(-3)} 12:00:00`);
  db.prepare('INSERT INTO chore_completions(chore_id,period_key,completed_at) VALUES (?,?,?)').run(recent, day(-1), `${day(-1)} 12:00:00`);
  db.prepare('INSERT INTO chore_completions(chore_id,period_key,completed_at) VALUES (?,?,?)').run(current, day(0), `${day(0)} 12:00:00`);
  const server = createApp(db).listen(0); t.after(() => { server.close(); db.close(); });
  await new Promise((resolve) => server.once('listening', resolve));
  const headers = { cookie: `family_user_session=${createSession(db, { householdId: home, userId: adult })}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' };
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = await (await fetch(`${base}/api/tokens`, { headers })).json();
  const person = status.people.find((item) => item.name === 'Sydney');
  assert.equal(person.totalQuarters, 7);
  assert.equal(person.availableQuarters, 3);
  const ledger = await (await fetch(`${base}/api/tokens/ledger?userId=${sydney}`, { headers })).json();
  assert.equal(ledger.entries.find((item) => item.title === 'Old').status, 'Withdrawn');
  assert.equal(ledger.entries.find((item) => item.title === 'Yesterday').status, 'Available');
  assert.equal(ledger.entries.find((item) => item.title === 'Today').status, 'Available');
  assert.equal(ledger.withdrawals.some((item) => item.label === 'Earlier rewards marked withdrawn'), true);
  assert.equal(ledger.lines.at(-1).available, '$0.75');
  assert.equal(ledger.lines.at(-1).total, '$1.75');
  assert.equal(ledger.lines.at(-1).kind, 'debit');
  assert.equal(ledger.lines.find((item) => item.description === 'Yesterday').available, '$1.50');
  assert.equal(ledger.lines.find((item) => item.description === 'Yesterday').total, '$1.50');
  assert.equal((await fetch(`${base}/api/tokens/withdraw`, { method: 'POST', headers, body: JSON.stringify({ userId: sydney, copper: 0, silver: 0, gold: 1, requestId: 'request-too-much' }) })).status, 400);
  const withdrawn = await (await fetch(`${base}/api/tokens/withdraw`, { method: 'POST', headers, body: JSON.stringify({ userId: sydney, copper: 1, silver: 1, gold: 0, requestId: 'request-ok-1234' }) })).json();
  assert.equal(withdrawn.dispensed.amount, '$0.75');
  assert.equal(withdrawn.person.availableQuarters, 0);
  assert.equal(withdrawn.person.totalQuarters, 7);
  const replay = await (await fetch(`${base}/api/tokens/withdraw`, { method: 'POST', headers, body: JSON.stringify({ userId: sydney, copper: 1, silver: 1, gold: 0, requestId: 'request-ok-1234' }) })).json();
  assert.equal(replay.replayed, true);
  assert.equal(replay.person.availableQuarters, 0);
  assert.equal((await fetch(`${base}/api/chores/${current}/toggle`, { method: 'POST', headers })).status, 409);
  assert.ok(db.prepare('SELECT 1 FROM chore_completions WHERE chore_id=? AND period_key=?').get(current, day(0)));
  assert.equal((await fetch(`${base}/api/tokens/withdraw`, { method: 'POST', headers, body: JSON.stringify({ userId: otherChild, copper: 1, silver: 0, gold: 0, requestId: 'request-other-1' }) })).status, 400);
  const deviceHeaders = { cookie: `family_device_session=${createSession(db, { householdId: home, kind: 'device', deviceName: 'Wall' })}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' };
  const added = insertChore('New', 4);
  assert.equal((await fetch(`${base}/api/chores/${added}/toggle`, { method: 'POST', headers })).status, 200);
  const device = await (await fetch(`${base}/api/tokens/withdraw`, { method: 'POST', headers: deviceHeaders, body: JSON.stringify({ userId: sydney, copper: 0, silver: 0, gold: 1, requestId: 'request-device-1' }) })).json();
  assert.equal(device.person.availableQuarters, 0);
  assert.equal(device.person.totalQuarters, 11);
});

test('backup downloads the household database and restore replaces it', async (t) => {
  const previous = process.env.APP_ORIGIN; process.env.APP_ORIGIN = 'http://127.0.0.1';
  t.after(() => previous === undefined ? delete process.env.APP_ORIGIN : process.env.APP_ORIGIN = previous);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-backup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const live = path.join(dir, 'live.sqlite'), source = path.join(dir, 'source.sqlite');
  const db = openDatabase(live), other = openDatabase(source);
  household(db, 'Current Home'); household(other, 'Restored Home');
  const backup = path.join(dir, 'backup.sqlite');
  await writeBackup(other, backup);
  other.close();
  assert.throws(() => validateFamilyHubDatabase(path.join(dir, 'missing.sqlite')), /Family Hub backup/);
  fs.writeFileSync(path.join(dir, 'bad.sqlite'), 'not a database');
  assert.throws(() => validateFamilyHubDatabase(path.join(dir, 'bad.sqlite')), /Family Hub backup/);
  const password = await hashPassword('a secure password');
  const adult = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'adult')").run(1, 'backup@example.test', 'Adult', password).lastInsertRowid);
  const restarted = [];
  const server = createApp(db, { databasePath: live, restart: () => restarted.push(true) }).listen(0);
  t.after(() => { server.close(); if (db.open) db.close(); });
  await new Promise((resolve) => server.once('listening', resolve));
  const headers = { cookie: `family_user_session=${createSession(db, { householdId: 1, userId: adult })}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1' };
  const base = `http://127.0.0.1:${server.address().port}`;
  const deviceHeaders = { cookie: `family_device_session=${createSession(db, { householdId: 1, kind: 'device', deviceName: 'Wall' })}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1' };
  assert.equal((await fetch(`${base}/api/household/backup`, { headers: deviceHeaders })).status, 403);
  const downloaded = await fetch(`${base}/api/household/backup`, { headers });
  assert.equal(downloaded.status, 200);
  assert.equal(Buffer.from(await downloaded.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await fetch(`${base}/api/household/restore`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: fs.readFileSync(path.join(dir, 'bad.sqlite')) })).status, 400);
  assert.equal(restarted.length, 0);
  const restored = await fetch(`${base}/api/household/restore`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: fs.readFileSync(backup) });
  assert.equal(restored.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(restarted.length, 1);
  const check = openDatabase(live);
  assert.equal(check.prepare('SELECT name FROM households').get().name, 'Restored Home');
  check.close();
});
