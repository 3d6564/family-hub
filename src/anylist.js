import crypto from 'node:crypto';
import { requireAdult } from './auth.js';
import { AnyListError, createAnyListClient, validAnyListSession } from './anylist-client.js';

const refreshMs = 60000;
const idText = value => typeof value === 'string' && value.length > 0 && value.length <= 160;

function encryptionKey(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new AnyListError('AnyList needs a server encryption key. Ask the host owner to set FAMILY_HUB_INTEGRATION_KEY.', 503);
  return Buffer.from(value, 'hex');
}

function seal(session, key, householdId) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(key), iv);
  cipher.setAAD(Buffer.from(`anylist:v1:${householdId}`));
  const data = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}

function unseal(value, key, householdId) {
  const bytes = encryptionKey(key);
  try {
    const saved = JSON.parse(value);
    if (saved.version !== 1) throw new Error('Unsupported secret');
    const decipher = crypto.createDecipheriv('aes-256-gcm', bytes, Buffer.from(saved.iv, 'base64'));
    decipher.setAAD(Buffer.from(`anylist:v1:${householdId}`));
    decipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
    const session = JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.data, 'base64')), decipher.final()]).toString('utf8'));
    if (!validAnyListSession(session)) throw new Error('Invalid session');
    return session;
  } catch { throw new AnyListError('AnyList credentials cannot be opened. Ask the host owner to restore the encryption key, or ask an adult to reconnect.', 409); }
}

/** Keep AnyList credentials, selected-list cache, and serialized provider operations household-scoped. */
export function createAnyListConnector(db, { key = process.env.FAMILY_HUB_INTEGRATION_KEY, clientFactory = createAnyListClient, notify = () => {} } = {}) {
  const queues = new Map(), attempts = new Map();
  const rowFor = householdId => db.prepare('SELECT * FROM anylist_connections WHERE household_id=?').get(householdId);
  let keyReady = false;
  try { encryptionKey(key); keyReady = true; } catch {}

  async function exclusive(householdId, work) {
    const queue = queues.get(householdId) || { tail: Promise.resolve(), count: 0 };
    if (queue.count >= 12) throw new AnyListError('The list is busy. Wait a moment and try again.', 429);
    queues.set(householdId, queue); queue.count++;
    const result = queue.tail.then(work);
    queue.tail = result.catch(() => {});
    try { return await result; } finally { if (--queue.count === 0) queues.delete(householdId); }
  }

  function client(householdId, row) {
    return clientFactory({ session: unseal(row.credentials, key, householdId), saveSession: session => {
      db.prepare('UPDATE anylist_connections SET credentials=? WHERE household_id=?').run(seal(session, key, householdId), householdId);
    } });
  }

  function cache(householdId, row, lists) {
    const selected = lists.find(list => list.id === row.list_id);
    if (row.list_id && !selected) throw new AnyListError('The selected AnyList list is unavailable. Ask an adult to select a list again.', 409);
    const now = new Date().toISOString();
    db.prepare('UPDATE anylist_connections SET lists_json=?,list_name=?,items_json=?,last_success_at=? WHERE household_id=?')
      .run(JSON.stringify(lists.map(({ id, name }) => ({ id, name }))), selected?.name || null, JSON.stringify(selected?.items || []), now, householdId);
    attempts.set(householdId, { at: Date.now(), failed: false });
    return selected;
  }

  function settings(householdId) {
    const row = rowFor(householdId), attempt = attempts.get(householdId);
    return { keyReady, connected: !!row, enabled: !!row?.enabled, listId: row?.list_id || '', lists: row ? JSON.parse(row.lists_json) : [],
      source: 'AnyList', lastSuccessAt: row?.last_success_at || null,
      state: !row ? 'unconfigured' : !row.enabled ? 'disabled' : attempt?.failed ? 'error' : 'ok' };
  }

  function snapshot(householdId) {
    const row = rowFor(householdId), attempt = attempts.get(householdId);
    if (!row?.enabled || !row.list_id) return { enabled: false, name: '', items: [], stale: false, lastSuccessAt: null };
    return { enabled: true, name: row.list_name, items: JSON.parse(row.items_json), lastSuccessAt: row.last_success_at,
      stale: !!attempt?.failed || !row.last_success_at || Date.now() - Date.parse(row.last_success_at) >= refreshMs };
  }

  async function fetchLists(householdId, row) {
    try {
      const lists = await client(householdId, row).lists();
      cache(householdId, row, lists);
      return lists;
    } catch (error) {
      attempts.set(householdId, { at: Date.now(), failed: true });
      throw error;
    }
  }

  return {
    settings,
    read(householdId, force = false) { return exclusive(householdId, async () => {
      const row = rowFor(householdId), attempt = attempts.get(householdId);
      const due = !attempt || Date.now() - attempt.at >= (force ? 5000 : refreshMs);
      if (row?.enabled && row.list_id && due) {
        try { await fetchLists(householdId, row); } catch { /* Keep the last selected-list cache available during provider failure. */ }
      }
      return snapshot(householdId);
    }); },
    connect(householdId, email, password) { return exclusive(householdId, async () => {
      encryptionKey(key);
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof password !== 'string' || !password || password.length > 4096) throw new AnyListError('Enter your AnyList email and password.', 400);
      // A reconnect replaces the account and clears old list data only after login and fetch succeed.
      let session;
      const provider = clientFactory({ saveSession: value => { session = value; } });
      const loggedIn = await provider.login(email.trim(), password);
      session ||= loggedIn;
      if (!validAnyListSession(session)) throw new AnyListError();
      const lists = await provider.lists();
      db.prepare(`INSERT INTO anylist_connections(household_id,credentials,lists_json) VALUES (?,?,?)
        ON CONFLICT(household_id) DO UPDATE SET credentials=excluded.credentials,lists_json=excluded.lists_json,
        enabled=0,list_id=NULL,list_name=NULL,items_json='[]',last_success_at=NULL`)
        .run(householdId, seal(session, key, householdId), JSON.stringify(lists.map(({ id, name }) => ({ id, name }))));
      attempts.delete(householdId); notify(householdId);
      return settings(householdId);
    }); },
    configure(householdId, listId, enabled) { return exclusive(householdId, async () => {
      const row = rowFor(householdId);
      if (!row) throw new AnyListError('Connect AnyList before selecting a list.', 409);
      if (typeof enabled !== 'boolean' || (enabled && !idText(listId))) throw new AnyListError('Select a list and choose whether to enable it.', 400);
      if (!enabled) {
        const selectedId = listId === undefined || listId === '' ? row.list_id : listId;
        const selected = JSON.parse(row.lists_json).find(list => list.id === selectedId);
        if (selectedId !== null && (!idText(selectedId) || (!selected && selectedId !== row.list_id))) throw new AnyListError('Select an available AnyList list.', 400);
        const changed = selectedId !== row.list_id;
        // Disabled configuration uses saved discovery data, never a provider request.
        db.prepare('UPDATE anylist_connections SET enabled=0,list_id=?,list_name=?,items_json=?,last_success_at=? WHERE household_id=?')
          .run(selectedId, selected?.name || (changed ? null : row.list_name), changed ? '[]' : row.items_json, changed ? null : row.last_success_at, householdId);
      } else {
        // Verify the resource before replacing the previous selected-list cache.
        const lists = await client(householdId, row).lists();
        if (!lists.some(list => list.id === listId)) throw new AnyListError('Select an available AnyList list.', 400);
        db.transaction(() => {
          db.prepare('UPDATE anylist_connections SET enabled=1,list_id=? WHERE household_id=?').run(listId, householdId);
          cache(householdId, { ...row, list_id: listId }, lists);
        })();
      }
      notify(householdId); return settings(householdId);
    }); },
    refreshCatalog(householdId) { return exclusive(householdId, async () => {
      const row = rowFor(householdId);
      if (!row) throw new AnyListError('Connect AnyList first.', 409);
      // Discovery must still work when a previously selected list has been removed.
      const lists = await client(householdId, row).lists();
      db.prepare('UPDATE anylist_connections SET lists_json=? WHERE household_id=?').run(JSON.stringify(lists.map(({ id, name }) => ({ id, name }))), householdId);
      return settings(householdId);
    }); },
    disconnect(householdId) { return exclusive(householdId, () => {
      db.prepare('DELETE FROM anylist_connections WHERE household_id=?').run(householdId);
      attempts.delete(householdId); notify(householdId);
    }); },
    mutate(householdId, action, input) { return exclusive(householdId, async () => {
      const row = rowFor(householdId);
      if (!row?.enabled || !row.list_id) throw new AnyListError('The AnyList list is disabled. Ask an adult to enable it.', 409);
      const provider = client(householdId, row);
      try {
        let lists;
        try { lists = await provider.lists(); }
        catch (error) { attempts.set(householdId, { at: Date.now(), failed: true }); throw error; }
        const selected = cache(householdId, row, lists);
        let item;
        if (action === 'add') {
          if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 500) throw new AnyListError('Enter an item name of up to 500 characters.', 400);
          const name = input.name.trim();
          item = selected.items.find(entry => entry.name.toLowerCase() === name.toLowerCase());
          if (item && !item.checked) return snapshot(householdId);
          if (item) { action = 'check'; item = { ...item, checked: false }; }
          else item = { id: crypto.randomUUID().replaceAll('-', '').toUpperCase(), name, checked: false, notes: '', quantity: '' };
        } else {
          if (!idText(input.id)) throw new AnyListError('Choose a valid list item.', 400);
          item = selected.items.find(entry => entry.id === input.id);
          if (!item) throw new AnyListError('This item is no longer on the list. Refresh the list.', 404);
          if (action === 'check') {
            if (typeof input.checked !== 'boolean') throw new AnyListError('Choose checked or unchecked.', 400);
            if (item.checked === input.checked) return snapshot(householdId);
            item = { ...item, checked: input.checked };
          } else if (action !== 'delete' || !item.checked) throw new AnyListError('Only completed items can be deleted.', 409);
        }
        await provider.change(row.list_id, action, item);
        // Reflect only acknowledged writes; the next poll reconciles with the provider.
        const items = action === 'delete' ? selected.items.filter(entry => entry.id !== item.id) : action === 'add' ? [...selected.items, item] : selected.items.map(entry => entry.id === item.id ? item : entry);
        db.prepare('UPDATE anylist_connections SET items_json=? WHERE household_id=?').run(JSON.stringify(items), householdId);
        notify(householdId);
        return snapshot(householdId);
      } catch (error) {
        if (!(error instanceof AnyListError) || error.status >= 500) {
          attempts.set(householdId, { at: Date.now(), failed: true });
          throw new AnyListError('AnyList could not confirm the change. Refresh the list before trying again.');
        }
        throw error;
      }
    }); },
  };
}

/** Mount the selected-list API after authentication and CSRF middleware. */
export function mountAnyList(app, db, options) {
  const connector = createAnyListConnector(db, options);
  const route = work => (req, res, next) => Promise.resolve().then(() => work(req, res)).catch(error => {
    if (error instanceof AnyListError) res.status(error.status).json({ error: error.message });
    else next(error);
  });
  const home = req => req.auth.household_id;
  app.get('/api/integrations/anylist', requireAdult, route((req, res) => res.json(connector.settings(home(req)))));
  app.post('/api/integrations/anylist/connect', requireAdult, route(async (req, res) => res.json(await connector.connect(home(req), req.body.email, req.body.password))));
  app.put('/api/integrations/anylist', requireAdult, route(async (req, res) => res.json(await connector.configure(home(req), req.body.listId, req.body.enabled))));
  app.post('/api/integrations/anylist/refresh', requireAdult, route(async (req, res) => res.json(await connector.refreshCatalog(home(req)))));
  app.delete('/api/integrations/anylist', requireAdult, route(async (req, res) => { await connector.disconnect(home(req)); res.status(204).end(); }));
  app.get('/api/lists/anylist', route(async (req, res) => res.json(await connector.read(home(req), req.query.refresh === '1'))));
  app.post('/api/lists/anylist/items', route(async (req, res) => res.json(await connector.mutate(home(req), 'add', { name: req.body.name }))));
  app.patch('/api/lists/anylist/items/:id', route(async (req, res) => res.json(await connector.mutate(home(req), 'check', { id: req.params.id, checked: req.body.checked }))));
  app.delete('/api/lists/anylist/items/:id', requireAdult, route(async (req, res) => res.json(await connector.mutate(home(req), 'delete', { id: req.params.id }))));
}
