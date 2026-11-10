import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/auth.js';
import { createAnyListClient } from '../src/anylist-client.js';
import { createAnyListConnector } from '../src/anylist.js';
import { operationsType, userDataType } from '../src/anylist-protocol.js';

const key = 'ab'.repeat(32);
const session = { clientId: 'sample-client', accessToken: 'sample-access-token', refreshToken: 'sample-refresh-token' };
const sampleLists = () => [
  { id: 'groceries', name: 'Groceries', items: [
    { id: 'milk', name: 'Milk', notes: '', quantity: '2', quantityUnit: 'L', checked: false },
    { id: 'bread', name: 'Bread', notes: '', quantity: '', checked: true },
  ] },
  { id: 'other', name: 'Other list', items: [{ id: 'other-item', name: 'Do not cache me', checked: false }] },
];

function fakeProvider() {
  const state = { lists: sampleLists(), calls: [], fail: false, failWrite: false };
  const factory = ({ saveSession } = {}) => ({
    async login(email, password) { state.calls.push(['login', email]); assert.equal(password, 'sample-password'); saveSession?.(session); return session; },
    async lists() { state.calls.push(['lists']); if (state.fail) throw new Error('sample-secret-provider-error'); return structuredClone(state.lists); },
    async change(listId, action, item) {
      state.calls.push([action, listId, item.id]);
      if (state.failWrite) throw new Error('sample-secret-write-error');
      const list = state.lists.find(entry => entry.id === listId);
      if (action === 'add') list.items.push(structuredClone(item));
      if (action === 'check') list.items = list.items.map(entry => entry.id === item.id ? structuredClone(item) : entry);
      if (action === 'delete') list.items = list.items.filter(entry => entry.id !== item.id);
    },
  });
  return { state, factory };
}

test('AnyList client decodes known wire bytes and sends ID-based checked operations', async () => {
  // Independent wire sample: list L named Groceries, item i named Milk, unchecked.
  const bytes = Buffer.from('0a200a1e0a014c1a0947726f636572696573220e0a01691a014c22044d696c6b3000', 'hex');
  const calls = [];
  const client = createAnyListClient({ session, fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'error'); assert.equal(options.headers.authorization, `Bearer ${session.accessToken}`);
    assert.ok(options.signal instanceof AbortSignal);
    if (url.endsWith('/data/user-data/get')) return new Response(bytes);
    const operation = operationsType.decode(new Uint8Array(await options.body.get('operations').arrayBuffer())).operations[0];
    assert.equal(operation.metadata.handlerId, 'set-list-item-checked');
    assert.equal(operation.listId, 'L'); assert.equal(operation.listItemId, 'i'); assert.equal(operation.updatedValue, 'y');
    return new Response(null, { status: 204 });
  } });
  assert.deepEqual(await client.lists(), [{ id: 'L', name: 'Groceries', items: [{ id: 'i', name: 'Milk', notes: '', quantity: '', quantityUnit: '', checked: false }] }]);
  await client.change('L', 'check', { id: 'i', checked: true });
  assert.deepEqual(calls, ['https://www.anylist.com/data/user-data/get', 'https://www.anylist.com/data/shopping-lists/update']);
});

test('AnyList preserves quantity units in normalized data and delete operations', async () => {
  const bytes = userDataType.encode({ shoppingListsResponse: { newLists: [{
    identifier: 'groceries', name: 'Groceries', items: [{ identifier: 'rice', name: 'Rice', checked: true, quantityPb: { amount: '2', unit: 'kg' } }],
  }] } }).finish();
  const client = createAnyListClient({ session, fetchImpl: async (url, options) => {
    if (url.endsWith('/data/user-data/get')) return new Response(bytes);
    const operation = operationsType.decode(new Uint8Array(await options.body.get('operations').arrayBuffer())).operations[0];
    assert.equal(operation.listItem.quantityPb.amount, '2');
    assert.equal(operation.listItem.quantityPb.unit, 'kg');
    return new Response(null, { status: 204 });
  } });
  const item = (await client.lists())[0].items[0];
  assert.equal(item.quantity, '2');
  assert.equal(item.quantityUnit, 'kg');
  await client.change('groceries', 'delete', item);
});

test('AnyList saves disabled selection without fetching and clears only the previous list cache', async (t) => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const home = Number(db.prepare("INSERT INTO households(name,timezone) VALUES ('Sample home','UTC')").run().lastInsertRowid);
  const { state, factory } = fakeProvider();
  const connector = createAnyListConnector(db, { key, clientFactory: factory });
  await connector.connect(home, 'adult@example.test', 'sample-password');
  let settings = await connector.configure(home, 'other', false);
  assert.equal(settings.listId, 'other', 'a list can be selected before enabling');
  await connector.configure(home, 'groceries', true);
  const before = db.prepare('SELECT * FROM anylist_connections WHERE household_id=?').get(home);
  const calls = state.calls.length;
  state.fail = true;
  await connector.configure(home, 'groceries', false);
  assert.equal(db.prepare('SELECT items_json FROM anylist_connections WHERE household_id=?').get(home).items_json, before.items_json);
  settings = await connector.configure(home, 'other', false);
  assert.equal(settings.listId, 'other');
  assert.equal(settings.enabled, false);
  const saved = db.prepare('SELECT * FROM anylist_connections WHERE household_id=?').get(home);
  assert.equal(saved.list_name, 'Other list');
  assert.equal(saved.items_json, '[]');
  assert.equal(saved.last_success_at, null);
  assert.equal(saved.credentials, before.credentials);
  assert.equal(state.calls.length, calls, 'disabled configuration must not fetch');
  await assert.rejects(connector.configure(home, 'unknown', false), /available AnyList list/);
  assert.equal(connector.settings(home).listId, 'other');
  assert.equal(createAnyListConnector(db, { key, clientFactory: factory }).settings(home).listId, 'other', 'disabled selection survives connector restart');
  assert.equal(state.calls.length, calls);
});

test('AnyList login retains tokens but not password, and refresh persists rotated tokens before retry', async () => {
  const saves = [], calls = [];
  const empty = userDataType.encode({ shoppingListsResponse: { newLists: [] } }).finish();
  const client = createAnyListClient({ saveSession: value => saves.push(value), fetchImpl: async (url, options) => {
    calls.push(url);
    if (url.endsWith('/auth/token')) {
      assert.equal(options.body.get('email'), 'adult@example.test');
      assert.equal(options.body.get('password'), 'sample-password');
      assert.equal(options.headers.authorization, undefined);
      return Response.json({ access_token: 'first-access', refresh_token: 'first-refresh' });
    }
    if (url.endsWith('/auth/token/refresh')) {
      assert.equal(options.body.get('refresh_token'), 'first-refresh');
      return Response.json({ access_token: 'next-access', refresh_token: 'next-refresh' });
    }
    if (options.headers.authorization === 'Bearer first-access') return new Response(null, { status: 401 });
    assert.equal(saves.at(-1).refreshToken, 'next-refresh');
    assert.equal(options.headers.authorization, 'Bearer next-access');
    return new Response(empty);
  } });
  const loggedIn = await client.login('adult@example.test', 'sample-password');
  assert.match(loggedIn.clientId, /^[A-F0-9]{32}$/);
  assert.equal(JSON.stringify(saves).includes('sample-password'), false);
  assert.deepEqual(await client.lists(), []);
  assert.equal(calls.length, 4);
});

test('AnyList client rejects malformed, oversized, redirected, and duplicate-ID responses without leaking detail', async () => {
  for (const response of [
    () => new Response(Buffer.from([255])),
    () => new Response(null, { status: 302, headers: { location: 'https://outside.example.test' } }),
    () => new Response('sample-private-data', { headers: { 'content-length': String(9 * 1024 * 1024) } }),
    () => new Response(userDataType.encode({ shoppingListsResponse: { newLists: [{ identifier: 'L', name: 'List', items: [{ identifier: 'i', name: 'One' }, { identifier: 'i', name: 'Two' }] }] } }).finish()),
  ]) {
    const client = createAnyListClient({ session, fetchImpl: async () => response() });
    await assert.rejects(client.lists(), error => !error.message.includes('private') && error.status === 502);
  }
  let calls = 0;
  const client = createAnyListClient({ session, fetchImpl: async () => { calls++; throw new Error('sample-private-network-detail'); } });
  await assert.rejects(client.change('L', 'add', { id: 'i', name: 'Milk' }), /could not update/);
  assert.equal(calls, 1, 'uncertain writes must not retry');
});

test('AnyList cache saves selected items only, encrypts tokens, isolates failures, and supports disable/disconnect', async (t) => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const home = Number(db.prepare("INSERT INTO households(name,timezone) VALUES ('Sample home','UTC')").run().lastInsertRowid);
  const { state, factory } = fakeProvider();
  const connector = createAnyListConnector(db, { key, clientFactory: factory });
  await connector.connect(home, 'adult@example.test', 'sample-password');
  assert.equal(connector.settings(home).enabled, false);
  const row = db.prepare('SELECT * FROM anylist_connections WHERE household_id=?').get(home);
  assert.equal(row.credentials.includes(session.accessToken), false);
  assert.equal(row.credentials.includes(session.refreshToken), false);
  assert.equal(JSON.stringify(row).includes('sample-password'), false);
  assert.equal(JSON.stringify(row).includes('Do not cache me'), false);
  await connector.configure(home, 'groceries', true);
  assert.equal((await connector.read(home)).items.length, 2);
  assert.equal(db.prepare('SELECT items_json FROM anylist_connections WHERE household_id=?').get(home).items_json.includes('Do not cache me'), false);
  state.fail = true;
  const restarted = createAnyListConnector(db, { key, clientFactory: factory });
  const cached = await restarted.read(home);
  assert.equal(cached.stale, true); assert.equal(cached.items.length, 2);
  assert.equal(cached.items.find(item => item.id === 'milk').quantityUnit, 'L', 'cached quantities keep their units during failures');
  const calls = state.calls.length;
  await restarted.read(home); assert.equal(state.calls.length, calls, 'provider failures are throttled');
  assert.equal(JSON.stringify(cached).includes('sample-secret'), false);
  await restarted.configure(home, '', false);
  assert.equal((await restarted.read(home)).enabled, false);
  assert.equal(state.calls.length, calls, 'disabled reads do not call the provider');
  assert.ok(db.prepare('SELECT credentials FROM anylist_connections WHERE household_id=?').get(home));
  state.fail = false;
  await restarted.configure(home, 'groceries', true);
  assert.equal((await restarted.read(home)).stale, false, 'a successful reconnect to the list clears failure state');
  await restarted.disconnect(home);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM anylist_connections').get().n, 0);
});

test('AnyList writes use selected IDs, reuse completed items, and reject deleting active items', async (t) => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const home = Number(db.prepare("INSERT INTO households(name,timezone) VALUES ('Sample home','UTC')").run().lastInsertRowid);
  const { state, factory } = fakeProvider(), connector = createAnyListConnector(db, { key, clientFactory: factory });
  await connector.connect(home, 'adult@example.test', 'sample-password'); await connector.configure(home, 'groceries', true);
  await assert.rejects(connector.mutate(home, 'delete', { id: 'milk' }), /Only completed/);
  await assert.rejects(connector.mutate(home, 'check', { id: 'other-item', checked: true }), /no longer/);
  await assert.rejects(connector.mutate(home, 'check', { id: 'milk', checked: 'true' }), /checked or unchecked/);
  await connector.mutate(home, 'add', { name: 'bread' });
  assert.equal(state.lists[0].items.find(item => item.id === 'bread').checked, false);
  assert.equal(state.lists[0].items.length, 2);
  await Promise.all([connector.mutate(home, 'add', { name: 'Eggs' }), connector.mutate(home, 'add', { name: 'Eggs' })]);
  assert.equal(state.lists[0].items.filter(item => item.name === 'Eggs').length, 1);
  await connector.mutate(home, 'check', { id: 'milk', checked: true });
  await connector.mutate(home, 'delete', { id: 'milk' });
  assert.equal(state.lists[0].items.some(item => item.id === 'milk'), false);
  state.failWrite = true;
  await assert.rejects(connector.mutate(home, 'add', { name: 'Rice' }), /could not confirm/);
  assert.equal((await connector.read(home)).items.some(item => item.name === 'Rice'), false);
});

test('AnyList secret encryption is household-bound and missing keys do not block disconnect', async (t) => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const home = Number(db.prepare("INSERT INTO households(name,timezone) VALUES ('Home','UTC')").run().lastInsertRowid);
  const other = Number(db.prepare("INSERT INTO households(name,timezone) VALUES ('Other','UTC')").run().lastInsertRowid);
  const { factory } = fakeProvider(), connector = createAnyListConnector(db, { key, clientFactory: factory });
  await connector.connect(home, 'adult@example.test', 'sample-password');
  const secret = db.prepare('SELECT credentials FROM anylist_connections WHERE household_id=?').get(home).credentials;
  db.prepare('INSERT INTO anylist_connections(household_id,credentials) VALUES (?,?)').run(other, secret);
  await assert.rejects(connector.configure(other, 'groceries', true), /cannot be opened/);
  const missingKey = createAnyListConnector(db, { key: '', clientFactory: factory });
  assert.equal(missingKey.settings(home).keyReady, false);
  await assert.rejects(missingKey.connect(home, 'adult@example.test', 'sample-password'), /server encryption key/);
  await missingKey.disconnect(home);
  assert.equal(missingKey.settings(home).connected, false);
});

test('AnyList API permits paired-display add/check but restricts connection and completed deletion to adults', async (t) => {
  const db = openDatabase(':memory:');
  const home = Number(db.prepare("INSERT INTO households(name,timezone) VALUES ('Home','UTC')").run().lastInsertRowid);
  const other = Number(db.prepare("INSERT INTO households(name,timezone) VALUES ('Other','UTC')").run().lastInsertRowid);
  const adult = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,'adult@example.test','Adult','unused','adult')").run(home).lastInsertRowid);
  const adultToken = createSession(db, { householdId: home, userId: adult });
  const child = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,'child@example.test','Child','unused','child')").run(home).lastInsertRowid);
  const childToken = createSession(db, { householdId: home, userId: child });
  const deviceToken = createSession(db, { householdId: home, kind: 'device', deviceName: 'Wall' });
  const otherToken = createSession(db, { householdId: other, kind: 'device', deviceName: 'Other wall' });
  const { state, factory } = fakeProvider();
  const server = createApp(db, { integrationKey: key, anylistClientFactory: factory }).listen(0, '127.0.0.1');
  await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); db.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (route, method = 'GET', body, kind = 'adult', extra = {}) => fetch(`${origin}${route}`, { method, headers: {
    'Content-Type': 'application/json', origin, 'X-CSRF-Token': '1', ...(kind === 'none' ? {} : { cookie: `${['adult', 'child'].includes(kind) ? 'family_user_session' : 'family_device_session'}=${kind === 'adult' ? adultToken : kind === 'child' ? childToken : kind === 'other' ? otherToken : deviceToken}` }), ...extra,
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request('/api/lists/anylist', 'GET', null, 'none')).status, 401);
  assert.equal((await request('/api/integrations/anylist', 'GET', null, 'device')).status, 403);
  assert.equal((await request('/api/integrations/anylist', 'GET', null, 'child')).status, 403);
  assert.equal((await request('/api/integrations/anylist/connect', 'POST', { email: 'adult@example.test', password: 'sample-password' }, 'device')).status, 403);
  let response = await request('/api/integrations/anylist/connect', 'POST', { email: 'adult@example.test', password: 'sample-password' });
  assert.equal(response.status, 200); assert.equal(JSON.stringify(await response.json()).includes('sample-access'), false);
  assert.equal((await request('/api/integrations/anylist', 'PUT', { enabled: true, listId: 'groceries' })).status, 200);
  response = await request('/api/lists/anylist', 'GET', null, 'device');
  assert.equal(response.status, 200); assert.equal(JSON.stringify(await response.json()).includes('Other list'), false);
  assert.equal((await request('/api/lists/anylist/items', 'POST', { name: 'Eggs', listId: 'other' }, 'device')).status, 200);
  assert.equal(state.lists[0].items.at(-1).name, 'Eggs');
  assert.equal((await request('/api/lists/anylist/items/milk', 'PATCH', { checked: true }, 'device', { origin: 'https://outside.example.test' })).status, 403);
  assert.equal((await request('/api/lists/anylist/items/milk', 'PATCH', { checked: true }, 'other')).status, 409);
  assert.equal((await request('/api/lists/anylist/items/other-item', 'PATCH', { checked: true }, 'device')).status, 404);
  assert.equal((await request('/api/lists/anylist/items/milk', 'PATCH', { checked: true }, 'device')).status, 200);
  assert.equal((await request('/api/lists/anylist/items/bread', 'PATCH', { checked: false }, 'child')).status, 200);
  assert.equal((await request('/api/lists/anylist/items/milk', 'DELETE', null, 'device')).status, 403);
  assert.equal((await request('/api/lists/anylist/items/milk', 'DELETE', null, 'child')).status, 403);
  assert.equal((await request('/api/lists/anylist/items/milk', 'DELETE')).status, 200);
  assert.equal((await request('/api/lists/anylist/items/milk', 'GET', null, 'none')).status, 401);
  assert.equal((await request('/api/integrations/anylist', 'DELETE', null, 'device')).status, 403);
  assert.equal((await request('/api/integrations/anylist', 'DELETE')).status, 204);
  db.prepare("DELETE FROM sessions WHERE household_id=? AND kind='device'").run(home);
  assert.equal((await request('/api/lists/anylist/items', 'POST', { name: 'Rice' }, 'device')).status, 401);
});
