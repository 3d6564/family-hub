import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createSession, digest } from '../src/auth.js';
import { normalizeGoogleEvent } from '../src/google-calendar.js';

const encryptionKey = 'a'.repeat(64);

function addUser(db, householdId, role, name) {
  return Number(db.prepare('INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?,?)')
    .run(householdId, `${name.toLowerCase()}@example.test`, name, 'unused', role).lastInsertRowid);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function originEnvironment(t) {
  const keys = ['SITE_URL', 'APP_ORIGIN', 'ALLOWED_ORIGINS', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'FAMILY_HUB_INTEGRATION_KEY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  delete process.env.SITE_URL;
  delete process.env.ALLOWED_ORIGINS;
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  delete process.env.FAMILY_HUB_INTEGRATION_KEY;
  process.env.APP_ORIGIN = 'http://127.0.0.1';
  t.after(() => keys.forEach(key => previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]));
}

test('Google OAuth is adult-bound, stores only encrypted refresh credentials, and supplies read-only events to displays', async (t) => {
  originEnvironment(t);
  const db = openDatabase(':memory:');
  const home = Number(db.prepare('INSERT INTO households(name,timezone) VALUES (?,?)').run('Home', 'UTC').lastInsertRowid);
  const adultId = addUser(db, home, 'adult', 'Adult'), childId = addUser(db, home, 'child', 'Child');
  const adultToken = createSession(db, { householdId: home, userId: adultId });
  const childToken = createSession(db, { householdId: home, userId: childId });
  const deviceToken = createSession(db, { householdId: home, kind: 'device', deviceName: 'Wall' });
  let tokenCalls = 0, calendarListCalls = 0, eventCalls = 0, failEvents = false;
  const googleFetch = async (url, init) => {
    const target = new URL(url);
    if (target.href === 'https://oauth2.googleapis.com/token') {
      tokenCalls++;
      const form = new URLSearchParams(init.body);
      if (form.get('grant_type') === 'authorization_code') {
        assert.equal(form.get('code'), 'sample-code');
        assert.ok(form.get('code_verifier'));
        assert.equal(form.get('redirect_uri'), 'http://localhost:3000/api/integrations/google-calendar/callback');
        return json({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 });
      }
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), 'refresh-secret');
      return json({ access_token: 'access-secret', expires_in: 3600 });
    }
    assert.equal(init.headers.Authorization, 'Bearer access-secret');
    if (target.pathname.endsWith('/users/me/calendarList')) {
      calendarListCalls++;
      return json({ items: [{ id: 'primary', summary: 'Private family calendar', primary: true, backgroundColor: '#336699' }] });
    }
    if (target.pathname.endsWith('/calendars/primary/events')) {
      eventCalls++;
      if (failEvents) return json({ error_description: 'refresh-secret must not be exposed' }, 503);
      return json({ items: [
        { id: 'meeting-1', summary: 'Private meeting', start: { dateTime: '2026-12-02T15:00:00Z' }, end: { dateTime: '2026-12-02T15:30:00Z' } },
        { id: 'day-1', summary: 'All day', start: { date: '2026-12-03' }, end: { date: '2026-12-04' } },
      ] });
    }
    throw new Error(`Unexpected Google request ${target.href}`);
  };
  const server = createApp(db, {
    integrationKey: encryptionKey,
    googleOAuthClientId: 'sample-client-id',
    googleOAuthClientSecret: 'sample-client-secret',
    googleCalendarFetch: googleFetch,
    siteUrl: 'http://localhost:3000',
  }).listen(0);
  t.after(() => { server.close(); db.close(); });
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const adultHeaders = { cookie: `family_user_session=${adultToken}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' };
  const childHeaders = { ...adultHeaders, cookie: `family_user_session=${childToken}` };

  assert.equal((await fetch(`${base}/api/integrations/google-calendar`, { headers: { cookie: `family_device_session=${deviceToken}` } })).status, 403);
  assert.equal((await fetch(`${base}/api/integrations/google-calendar/connect`, { method: 'POST', headers: childHeaders, body: '{}' })).status, 403);
  let response = await fetch(`${base}/api/integrations/google-calendar`, { headers: { cookie: `family_user_session=${adultToken}` } });
  let settings = await response.json();
  assert.equal(settings.configured, true);
  assert.equal(settings.keyReady, true);
  assert.equal(settings.connected, false);

  response = await fetch(`${base}/api/integrations/google-calendar/connect`, { method: 'POST', headers: adultHeaders, body: '{}' });
  assert.equal(response.status, 200);
  const { authorizationUrl } = await response.json(), authorization = new URL(authorizationUrl);
  assert.equal(authorization.origin, 'https://accounts.google.com');
  assert.equal(authorization.searchParams.get('scope'), 'https://www.googleapis.com/auth/calendar.readonly');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const state = authorization.searchParams.get('state');

  const callback = new URL('/api/integrations/google-calendar/callback', base);
  callback.searchParams.set('state', state);
  callback.searchParams.set('code', 'sample-code');
  response = await fetch(callback);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(await response.text(), /Google Calendar connected/);
  assert.equal(calendarListCalls, 1);
  const connection = db.prepare('SELECT credentials FROM google_calendar_connections WHERE household_id=?').get(home);
  assert.ok(connection);
  assert.doesNotMatch(connection.credentials, /refresh-secret|access-secret/);

  response = await fetch(`${base}/api/integrations/google-calendar`, { headers: { cookie: `family_user_session=${adultToken}` } });
  settings = await response.json();
  assert.equal(settings.connected, true);
  assert.equal(settings.calendars[0].name, 'Private family calendar');
  assert.equal(JSON.stringify(settings).includes('refresh-secret'), false);

  response = await fetch(`${base}/api/integrations/google-calendar/calendars`, {
    method: 'POST', headers: adultHeaders,
    body: JSON.stringify({ selectedCalendarIds: ['primary'], enabled: true }),
  });
  assert.equal(response.status, 200);
  const eventUrl = `${base}/api/calendar/events?from=2026-12-01T00%3A00%3A00.000Z&to=2027-01-01T00%3A00%3A00.000Z`;
  response = await fetch(eventUrl, { headers: { cookie: `family_device_session=${deviceToken}` } });
  let calendarData = await response.json();
  assert.deepEqual(calendarData.errors, []);
  assert.deepEqual(calendarData.events.map(event => event.title), ['Private meeting', 'All day']);
  assert.equal(calendarData.events[0].source, 'google');
  assert.equal(calendarData.events[0].calendar, 'Private family calendar');
  assert.equal(calendarData.events[0].color, '#336699');
  assert.deepEqual(calendarData.events[1].start, { date: '2026-12-03' });
  assert.equal(JSON.stringify(calendarData).includes('refresh-secret'), false);
  assert.equal(tokenCalls, 1);
  assert.equal(eventCalls, 1);

  failEvents = true;
  const otherMonth = await fetch(`${base}/api/calendar/events?from=2027-01-01T00%3A00%3A00.000Z&to=2027-02-01T00%3A00%3A00.000Z`, { headers: { cookie: `family_device_session=${deviceToken}` } });
  calendarData = await otherMonth.json();
  assert.equal(calendarData.events.length, 0);
  assert.match(calendarData.errors[0].message, /Check the connection/);
  assert.equal(JSON.stringify(calendarData).includes('refresh-secret'), false);

  response = await fetch(callback);
  assert.match(await response.text(), /could not connect/);
  assert.equal(tokenCalls, 1, 'OAuth state is one-use');

  response = await fetch(`${base}/api/integrations/google-calendar`, { method: 'DELETE', headers: adultHeaders });
  assert.equal(response.status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM google_calendar_connections').get().count, 0);
});

test('Google OAuth credentials are adult-managed, encrypted, and override the environment fallback', async (t) => {
  originEnvironment(t);
  const db = openDatabase(':memory:');
  const home = Number(db.prepare('INSERT INTO households(name,timezone) VALUES (?,?)').run('Home', 'UTC').lastInsertRowid);
  const adultId = addUser(db, home, 'adult', 'Adult'), childId = addUser(db, home, 'child', 'Child');
  const adultToken = createSession(db, { householdId: home, userId: adultId });
  const childToken = createSession(db, { householdId: home, userId: childId });
  const submittedCredentials = [];
  const googleFetch = async (url, init) => {
    const target = new URL(url);
    if (target.href === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(init.body);
      submittedCredentials.push({ clientId: form.get('client_id'), clientSecret: form.get('client_secret'), grantType: form.get('grant_type') });
      if (form.get('grant_type') === 'authorization_code') return json({ access_token: 'app-access', refresh_token: 'app-refresh', expires_in: 3600 });
      throw new Error('Unexpected refresh request');
    }
    assert.equal(target.pathname.endsWith('/users/me/calendarList'), true);
    return json({ items: [] });
  };
  const server = createApp(db, {
    integrationKey: encryptionKey,
    googleOAuthClientId: 'environment-client-id',
    googleOAuthClientSecret: 'environment-client-secret',
    googleCalendarFetch: googleFetch,
    siteUrl: 'http://localhost:3000',
  }).listen(0);
  t.after(() => { server.close(); db.close(); });
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const adultHeaders = { cookie: `family_user_session=${adultToken}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' };
  const childHeaders = { ...adultHeaders, cookie: `family_user_session=${childToken}` };

  let response = await fetch(`${base}/api/integrations/google-calendar`, { headers: { cookie: `family_user_session=${adultToken}` } });
  let settings = await response.json();
  assert.equal(settings.oauthSource, 'environment');
  assert.equal(settings.appCredentialsSaved, false);
  assert.equal(JSON.stringify(settings).includes('environment-client-secret'), false);

  const credentialsBody = JSON.stringify({ clientId: 'app-client-id', clientSecret: 'app-client-secret' });
  assert.equal((await fetch(`${base}/api/integrations/google-calendar/credentials`, { method: 'PUT', headers: childHeaders, body: credentialsBody })).status, 403);
  response = await fetch(`${base}/api/integrations/google-calendar/credentials`, { method: 'PUT', headers: adultHeaders, body: credentialsBody });
  assert.equal(response.status, 200);
  settings = await response.json();
  assert.equal(settings.oauthSource, 'app');
  assert.equal(settings.appCredentialsSaved, true);
  assert.equal(settings.oauthClientId, 'app-client-id');
  assert.equal(JSON.stringify(settings).includes('app-client-secret'), false);
  const stored = db.prepare('SELECT client_id,client_secret FROM google_calendar_oauth_settings WHERE household_id=?').get(home);
  assert.equal(stored.client_id, 'app-client-id');
  assert.doesNotMatch(stored.client_secret, /app-client-secret/);

  response = await fetch(`${base}/api/integrations/google-calendar/connect`, { method: 'POST', headers: adultHeaders, body: '{}' });
  const authorization = new URL((await response.json()).authorizationUrl);
  assert.equal(authorization.searchParams.get('client_id'), 'app-client-id');
  const callback = new URL('/api/integrations/google-calendar/callback', base);
  callback.searchParams.set('state', authorization.searchParams.get('state'));
  callback.searchParams.set('code', 'sample-code');
  await fetch(callback);
  assert.deepEqual(submittedCredentials, [{ clientId: 'app-client-id', clientSecret: 'app-client-secret', grantType: 'authorization_code' }]);

  assert.equal((await fetch(`${base}/api/integrations/google-calendar/credentials`, { method: 'PUT', headers: adultHeaders, body: credentialsBody })).status, 409);
  assert.equal((await fetch(`${base}/api/integrations/google-calendar/credentials`, { method: 'DELETE', headers: childHeaders })).status, 403);
  assert.equal((await fetch(`${base}/api/integrations/google-calendar/credentials`, { method: 'DELETE', headers: adultHeaders })).status, 409);
  assert.equal((await fetch(`${base}/api/integrations/google-calendar`, { method: 'DELETE', headers: adultHeaders })).status, 204);

  response = await fetch(`${base}/api/integrations/google-calendar/credentials`, { method: 'DELETE', headers: adultHeaders });
  assert.equal(response.status, 200);
  settings = await response.json();
  assert.equal(settings.oauthSource, 'environment');
  response = await fetch(`${base}/api/integrations/google-calendar/connect`, { method: 'POST', headers: adultHeaders, body: '{}' });
  assert.equal(new URL((await response.json()).authorizationUrl).searchParams.get('client_id'), 'environment-client-id');
});

test('Google OAuth callback rejects a revoked adult session and missing encryption keys', async (t) => {
  originEnvironment(t);
  const db = openDatabase(':memory:');
  const home = Number(db.prepare('INSERT INTO households(name,timezone) VALUES (?,?)').run('Home', 'UTC').lastInsertRowid);
  const adultId = addUser(db, home, 'adult', 'Adult'), token = createSession(db, { householdId: home, userId: adultId });
  let tokenCalls = 0;
  const server = createApp(db, {
    integrationKey: '', googleOAuthClientId: 'sample-client-id', googleOAuthClientSecret: 'sample-client-secret',
    siteUrl: 'http://localhost:3000',
    googleCalendarFetch: async () => { tokenCalls++; return json({ access_token: 'unused', refresh_token: 'unused', expires_in: 3600 }); },
  }).listen(0);
  t.after(() => { server.close(); db.close(); });
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { cookie: `family_user_session=${token}`, origin: 'http://127.0.0.1', 'x-csrf-token': '1', 'content-type': 'application/json' };
  const settings = await (await fetch(`${base}/api/integrations/google-calendar`, { headers })).json();
  assert.equal(settings.keyReady, false);
  assert.equal(settings.state, 'needs_key');
  assert.equal((await fetch(`${base}/api/integrations/google-calendar/connect`, { method: 'POST', headers, body: '{}' })).status, 503);

  const configuredServer = createApp(db, {
    integrationKey: encryptionKey, googleOAuthClientId: 'sample-client-id', googleOAuthClientSecret: 'sample-client-secret',
    siteUrl: 'http://localhost:3000', googleCalendarFetch: async () => { tokenCalls++; return json({}); },
  }).listen(0);
  t.after(() => configuredServer.close());
  await new Promise(resolve => configuredServer.once('listening', resolve));
  const configuredBase = `http://127.0.0.1:${configuredServer.address().port}`;
  const start = await (await fetch(`${configuredBase}/api/integrations/google-calendar/connect`, { method: 'POST', headers, body: '{}' })).json();
  const state = new URL(start.authorizationUrl).searchParams.get('state');
  const session = db.prepare('SELECT id FROM sessions WHERE token_hash=?').get(digest(token));
  db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
  const callback = new URL('/api/integrations/google-calendar/callback', configuredBase);
  callback.searchParams.set('state', state); callback.searchParams.set('code', 'sample-code');
  const result = await fetch(callback);
  assert.match(await result.text(), /could not connect/);
  assert.equal(tokenCalls, 0, 'a revoked adult session cannot finish OAuth');
});

test('Google event normalization rejects malformed items and keeps all-day date values', () => {
  const calendar = { id: 'primary', name: 'Private calendar', color: '#123456' };
  assert.equal(normalizeGoogleEvent({ id: 'bad', start: {} }, calendar), null);
  assert.equal(normalizeGoogleEvent({ id: 'bad-date', start: { date: '2026-02-31' } }, calendar), null);
  assert.equal(normalizeGoogleEvent({ id: 'local-time', start: { dateTime: '2026-12-03T10:00:00' } }, calendar), null);
  assert.deepEqual(normalizeGoogleEvent({ id: 'day', summary: 'All day', start: { date: '2026-12-03' }, end: { date: '2026-12-04' } }, calendar), {
    id: 'google:primary:day', title: 'All day', description: null, location: null,
    start: { date: '2026-12-03' }, end: { date: '2026-12-04' }, color: '#123456', calendar: 'Private calendar', source: 'google',
  });
});
