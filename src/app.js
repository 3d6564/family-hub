import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';
import { authenticate, clearUserSessionCookie, createPairingCode, createSession, csrf, digest, hashPassword, parseCookies, randomToken, requireAdult, requireUser, setSessionCookie, USER_COOKIE, verifyPassword } from './auth.js';
import { budgetSummary, chorePeriod, isChoreDue, localDate, monthKey } from './domain.js';
import { classifyGoogleError, decryptTokens, encryptTokens, googleOAuthConfig, oauthClient } from './google.js';

const publicDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'public');
const clients = new Map();
const text = (value, max = 120) => typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null;
const integer = (value) => Number.isInteger(+value) && +value >= 0 ? +value : null;

function emit(householdId, event = 'update') {
  for (const res of clients.get(householdId) || []) res.write(`event: ${event}\ndata: {}\n\n`);
}
function asyncRoute(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }

function validGoogleRedirectUri(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch { return false; }
}

/** Build the Express application around an opened database. */
export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.post('/api/login', csrf, asyncRoute(async (req, res) => {
    const email = text(req.body.email, 254)?.toLowerCase();
    const user = email && db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!user || !await verifyPassword(req.body.password, user.password_hash)) return res.status(401).json({ error: 'Email or password is incorrect.' });
    setSessionCookie(res, createSession(db, { householdId: user.household_id, userId: user.id }), 'user');
    res.json({ ok: true });
  }));
  app.post('/api/pair', csrf, (req, res) => {
    const code = text(req.body.code, 12)?.replace(/\s/g, '').toUpperCase();
    const pairing = code && db.prepare('SELECT * FROM pairing_codes WHERE code_hash=? AND used_at IS NULL AND expires_at>?').get(digest(code), new Date().toISOString());
    if (!pairing) return res.status(400).json({ error: 'The pairing code is invalid or expired.' });
    const name = text(req.body.name, 60) || 'Wall display';
    db.prepare('UPDATE pairing_codes SET used_at=CURRENT_TIMESTAMP WHERE id=?').run(pairing.id);
    setSessionCookie(res, createSession(db, { householdId: pairing.household_id, kind: 'device', deviceName: name }), 'device');
    res.json({ ok: true });
  });

  const auth = authenticate(db);
  app.use('/api', auth, csrf);
  app.get('/api/me', (req, res) => {
    const household = db.prepare('SELECT id,name,timezone FROM households WHERE id=?').get(req.auth.household_id);
    res.json({ household, user: req.auth.user_id ? { id: req.auth.user_id, name: req.auth.name, email: req.auth.email, role: req.auth.role } : null, device: req.auth.kind === 'device' ? req.auth.device_name : null });
  });
  app.post('/api/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[USER_COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));
    clearUserSessionCookie(res); res.json({ ok: true });
  });
  app.get('/api/events/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders(); res.write('event: ready\ndata: {}\n\n');
    const set = clients.get(req.auth.household_id) || new Set(); set.add(res); clients.set(req.auth.household_id, set);
    req.on('close', () => set.delete(res));
  });

  app.get('/api/dashboard', (req, res) => {
    const h = req.auth.household_id;
    const household = db.prepare('SELECT timezone FROM households WHERE id=?').get(h);
    const today = localDate(new Date(), household.timezone);
    const month = monthKey(new Date(), household.timezone);
    const groceries = db.prepare('SELECT * FROM groceries WHERE household_id=? ORDER BY checked,created_at').all(h);
    const routines = db.prepare(`SELECT r.*,u.name child_name,EXISTS(SELECT 1 FROM routine_completions c WHERE c.routine_id=r.id AND c.completed_on=?) completed
      FROM routines r JOIN users u ON u.id=r.child_id WHERE r.household_id=? AND r.active=1 ORDER BY u.name,r.id`).all(today, h).filter((r) => r.days.split(',').includes(String(new Date(`${today}T12:00:00Z`).getUTCDay())));
    const chores = db.prepare('SELECT c.*,u.name assignee_name FROM chores c LEFT JOIN users u ON u.id=c.assignee_id WHERE c.household_id=? AND c.active=1 ORDER BY c.due_on,c.id').all(h)
      .filter((c) => isChoreDue(c, new Date(), household.timezone))
      .map((c) => ({ ...c, completed: !!db.prepare('SELECT 1 FROM chore_completions WHERE chore_id=? AND period_key=?').get(c.id, chorePeriod(c.recurrence, new Date(), household.timezone)) }));
    const plans = db.prepare('SELECT * FROM family_targets WHERE household_id=? ORDER BY sort_order,id').all(h);
    res.json({ today, groceries, routines, chores, plans, budget: budgetSummary(db, h, month) });
  });

  app.get('/api/members', requireAdult, (req, res) => res.json(db.prepare('SELECT id,name,role FROM users WHERE household_id=? ORDER BY role,name').all(req.auth.household_id)));
  app.post('/api/members', requireAdult, asyncRoute(async (req, res) => {
    const name = text(req.body.name, 80), email = text(req.body.email, 254)?.toLowerCase();
    if (!name || !email || !['adult', 'child'].includes(req.body.role)) return res.status(400).json({ error: 'Name, email, and role are required.' });
    const passwordHash = await hashPassword(req.body.password);
    const result = db.prepare('INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?,?)').run(req.auth.household_id, email, name, passwordHash, req.body.role);
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  }));
  app.post('/api/password', requireAdult, asyncRoute(async (req, res) => {
    const user = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.auth.user_id);
    if (!user || !await verifyPassword(req.body.currentPassword, user.password_hash)) return res.status(400).json({ error: 'Current password is incorrect.' });
    if (typeof req.body.newPassword !== 'string' || req.body.newPassword.length < 12) return res.status(400).json({ error: 'New password must be at least 12 characters.' });
    const passwordHash = await hashPassword(req.body.newPassword);
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, req.auth.user_id);
      db.prepare("DELETE FROM sessions WHERE user_id=? AND kind='user' AND id<>?").run(req.auth.user_id, req.auth.id);
    })();
    res.json({ ok: true });
  }));
  app.post('/api/pairing-codes', requireAdult, (req, res) => {
    const code = createPairingCode(db, req.auth.household_id);
    res.status(201).json({ code, expiresInMinutes: 10 });
  });
  app.get('/api/devices', requireAdult, (req, res) => res.json(db.prepare("SELECT id,device_name,created_at,expires_at FROM sessions WHERE household_id=? AND kind='device' ORDER BY created_at DESC").all(req.auth.household_id)));
  app.delete('/api/devices/:id', requireAdult, (req, res) => { db.prepare("DELETE FROM sessions WHERE id=? AND household_id=? AND kind='device'").run(req.params.id, req.auth.household_id); res.status(204).end(); });

  app.post('/api/groceries', requireUser, (req, res) => {
    const name = text(req.body.name), quantity = text(req.body.quantity, 40);
    if (!name) return res.status(400).json({ error: 'Item name is required.' });
    const result = db.prepare('INSERT INTO groceries(household_id,name,quantity) VALUES (?,?,?)').run(req.auth.household_id, name, quantity);
    emit(req.auth.household_id, 'groceries'); res.status(201).json({ id: Number(result.lastInsertRowid) });
  });
  app.patch('/api/groceries/:id', requireUser, (req, res) => {
    const row = db.prepare('SELECT * FROM groceries WHERE id=? AND household_id=?').get(req.params.id, req.auth.household_id);
    if (!row) return res.status(404).json({ error: 'Item not found.' });
    db.prepare('UPDATE groceries SET name=?,quantity=?,checked=? WHERE id=?').run(text(req.body.name) || row.name, text(req.body.quantity, 40) ?? row.quantity, req.body.checked == null ? row.checked : +!!req.body.checked, row.id);
    emit(req.auth.household_id, 'groceries'); res.json({ ok: true });
  });
  app.delete('/api/groceries/:id', requireUser, (req, res) => { db.prepare('DELETE FROM groceries WHERE id=? AND household_id=?').run(req.params.id, req.auth.household_id); emit(req.auth.household_id, 'groceries'); res.status(204).end(); });
  app.post('/api/groceries/clear', requireUser, (req, res) => { db.prepare('DELETE FROM groceries WHERE household_id=? AND checked=1').run(req.auth.household_id); emit(req.auth.household_id, 'groceries'); res.json({ ok: true }); });
  app.put('/api/budget/:month', requireAdult, (req, res) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(req.params.month) || integer(req.body.amountCents) == null) return res.status(400).json({ error: 'A valid month and amount are required.' });
    db.prepare('INSERT INTO grocery_budgets VALUES (?,?,?) ON CONFLICT(household_id,month) DO UPDATE SET amount_cents=excluded.amount_cents').run(req.auth.household_id, req.params.month, +req.body.amountCents); emit(req.auth.household_id, 'groceries'); res.json({ ok: true });
  });
  app.get('/api/trips', requireAdult, (req, res) => res.json(db.prepare('SELECT * FROM grocery_trips WHERE household_id=? ORDER BY occurred_on DESC,id DESC').all(req.auth.household_id)));
  app.post('/api/trips', requireAdult, (req, res) => {
    const amount = integer(req.body.amountCents), date = text(req.body.occurredOn, 10), note = text(req.body.note, 500);
    if (amount == null || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'Amount and date are required.' });
    if (req.body.note && !note) return res.status(400).json({ error: 'Trip notes must be 500 characters or fewer.' });
    db.prepare('INSERT INTO grocery_trips(household_id,amount_cents,store,occurred_on,note) VALUES (?,?,?,?,?)').run(req.auth.household_id, amount, text(req.body.store, 80), date, note); emit(req.auth.household_id, 'groceries'); res.status(201).json({ ok: true });
  });

  app.post('/api/routines', requireAdult, (req, res) => {
    const title = text(req.body.title), child = db.prepare("SELECT id FROM users WHERE id=? AND household_id=? AND role='child'").get(req.body.childId, req.auth.household_id);
    if (!title || !child || !/^[0-6](,[0-6])*$/.test(req.body.days || '')) return res.status(400).json({ error: 'Child, title, and days are required.' });
    db.prepare('INSERT INTO routines(household_id,child_id,title,days) VALUES (?,?,?,?)').run(req.auth.household_id, child.id, title, req.body.days); emit(req.auth.household_id, 'tasks'); res.status(201).json({ ok: true });
  });
  app.post('/api/routines/:id/toggle', (req, res) => {
    const routine = db.prepare('SELECT r.*,h.timezone FROM routines r JOIN households h ON h.id=r.household_id WHERE r.id=? AND r.household_id=?').get(req.params.id, req.auth.household_id);
    if (!routine) return res.status(404).json({ error: 'Routine not found.' });
    const date = localDate(new Date(), routine.timezone), existing = db.prepare('SELECT 1 FROM routine_completions WHERE routine_id=? AND completed_on=?').get(routine.id, date);
    if (req.auth.kind === 'device' && !routine.days.split(',').includes(String(new Date(`${date}T12:00:00Z`).getUTCDay()))) return res.status(403).json({ error: 'This routine is not due today.' });
    if (existing) db.prepare('DELETE FROM routine_completions WHERE routine_id=? AND completed_on=?').run(routine.id, date); else db.prepare('INSERT INTO routine_completions(routine_id,completed_on) VALUES (?,?)').run(routine.id, date);
    emit(req.auth.household_id, 'tasks'); res.json({ completed: !existing });
  });
  app.get('/api/routines/history', requireAdult, (req, res) => {
    res.json(db.prepare(`SELECT c.completed_on,c.completed_at,r.title,u.name child_name FROM routine_completions c JOIN routines r ON r.id=c.routine_id JOIN users u ON u.id=r.child_id WHERE r.household_id=? ORDER BY c.completed_on DESC,c.completed_at DESC LIMIT 100`).all(req.auth.household_id));
  });
  app.post('/api/chores', requireAdult, (req, res) => {
    const title = text(req.body.title), due = text(req.body.dueOn, 10), recurrence = req.body.recurrence;
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(due || '') || !['once', 'daily', 'weekly'].includes(recurrence)) return res.status(400).json({ error: 'Title, due date, and recurrence are required.' });
    const assignee = req.body.assigneeId == null ? null : db.prepare('SELECT id FROM users WHERE id=? AND household_id=?').get(req.body.assigneeId, req.auth.household_id)?.id;
    db.prepare('INSERT INTO chores(household_id,assignee_id,title,recurrence,due_on) VALUES (?,?,?,?,?)').run(req.auth.household_id, assignee, title, recurrence, due); emit(req.auth.household_id, 'tasks'); res.status(201).json({ ok: true });
  });
  app.post('/api/chores/:id/toggle', (req, res) => {
    const chore = db.prepare('SELECT c.*,h.timezone FROM chores c JOIN households h ON h.id=c.household_id WHERE c.id=? AND c.household_id=?').get(req.params.id, req.auth.household_id);
    if (!chore) return res.status(404).json({ error: 'Chore not found.' });
    if (req.auth.kind === 'device' && !isChoreDue(chore, new Date(), chore.timezone)) return res.status(403).json({ error: 'This chore is not due today.' });
    const period = chorePeriod(chore.recurrence, new Date(), chore.timezone), existing = db.prepare('SELECT 1 FROM chore_completions WHERE chore_id=? AND period_key=?').get(chore.id, period);
    if (existing) db.prepare('DELETE FROM chore_completions WHERE chore_id=? AND period_key=?').run(chore.id, period); else db.prepare('INSERT INTO chore_completions(chore_id,period_key) VALUES (?,?)').run(chore.id, period);
    emit(req.auth.household_id, 'tasks'); res.json({ completed: !existing });
  });
  app.get('/api/chores/history', requireAdult, (req, res) => {
    res.json(db.prepare(`SELECT c.period_key,c.completed_at,h.title,u.name assignee_name FROM chore_completions c JOIN chores h ON h.id=c.chore_id LEFT JOIN users u ON u.id=h.assignee_id WHERE h.household_id=? ORDER BY c.completed_at DESC LIMIT 100`).all(req.auth.household_id));
  });
  app.put('/api/plans', requireAdult, (req, res) => {
    if (!Array.isArray(req.body.plans) || req.body.plans.length > 20) return res.status(400).json({ error: 'Plans must be a list.' });
    const plans = req.body.plans.map((p) => ({ name: text(p.name, 80), target: text(p.target, 80) }));
    if (plans.some((p) => !p.name || !p.target)) return res.status(400).json({ error: 'Each plan needs a name and target.' });
    db.transaction(() => { db.prepare('DELETE FROM family_targets WHERE household_id=?').run(req.auth.household_id); const insert = db.prepare('INSERT INTO family_targets(household_id,name,target,sort_order) VALUES (?,?,?,?)'); plans.forEach((p, i) => insert.run(req.auth.household_id, p.name, p.target, i)); })();
    emit(req.auth.household_id, 'dashboard'); res.json({ ok: true });
  });

  app.get('/api/reminders', (req, res) => {
    const from = text(req.query.from, 30), to = text(req.query.to, 30);
    res.json(db.prepare('SELECT * FROM local_reminders WHERE household_id=? AND starts_at>=? AND starts_at<? ORDER BY starts_at').all(req.auth.household_id, from || '0000', to || '9999'));
  });
  app.post('/api/reminders', requireUser, (req, res) => {
    const title = text(req.body.title), starts = text(req.body.startsAt, 40);
    if (!title || !starts || Number.isNaN(Date.parse(starts))) return res.status(400).json({ error: 'Title and time are required.' });
    db.prepare('INSERT INTO local_reminders(household_id,title,starts_at,created_by) VALUES (?,?,?,?)').run(req.auth.household_id, title, starts, req.auth.user_id); emit(req.auth.household_id, 'calendar'); res.status(201).json({ ok: true });
  });
  app.delete('/api/reminders/:id', requireUser, (req, res) => { db.prepare('DELETE FROM local_reminders WHERE id=? AND household_id=?').run(req.params.id, req.auth.household_id); emit(req.auth.household_id, 'calendar'); res.status(204).end(); });

  app.get('/api/google/config', requireAdult, (req, res) => {
    const saved = db.prepare('SELECT google_client_id,google_redirect_uri FROM deployment_settings WHERE id=1').get();
    const config = saved ? { clientId: saved.google_client_id, redirectUri: saved.google_redirect_uri, source: 'database' }
      : process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI
        ? { clientId: process.env.GOOGLE_CLIENT_ID, redirectUri: process.env.GOOGLE_REDIRECT_URI, source: 'environment' } : null;
    res.json(config ? { configured: true, clientId: config.clientId, redirectUri: config.redirectUri, source: config.source, clientSecretConfigured: true } : { configured: false, clientSecretConfigured: false });
  });
  app.put('/api/google/config', requireAdult, (req, res) => {
    const clientId = text(req.body.clientId, 2048), redirectUri = text(req.body.redirectUri, 2048);
    const clientSecret = typeof req.body.clientSecret === 'string' && req.body.clientSecret.trim() && req.body.clientSecret.length <= 4096 ? req.body.clientSecret : null;
    if (!clientId) return res.status(400).json({ error: 'Google client ID is required and must be 2048 characters or fewer.' });
    if (!clientSecret) return res.status(400).json({ error: 'Google client secret is required and must be 4096 characters or fewer.' });
    if (!redirectUri || !validGoogleRedirectUri(redirectUri)) return res.status(400).json({ error: 'Redirect URI must use HTTPS, or HTTP on localhost.' });
    db.prepare(`INSERT INTO deployment_settings(id,google_client_id,encrypted_google_client_secret,google_redirect_uri) VALUES (1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET google_client_id=excluded.google_client_id,encrypted_google_client_secret=excluded.encrypted_google_client_secret,google_redirect_uri=excluded.google_redirect_uri,updated_at=CURRENT_TIMESTAMP`)
      .run(clientId, encryptTokens({ clientSecret }), redirectUri);
    res.json({ configured: true, clientId, redirectUri, source: 'database', clientSecretConfigured: true });
  });
  app.get('/api/google/connect', requireAdult, (req, res) => {
    const config = googleOAuthConfig(db);
    if (!config) return res.status(409).json({ error: 'Google OAuth is not configured. Add Google client credentials in Settings.', code: 'GOOGLE_OAUTH_UNCONFIGURED' });
    const state = randomToken();
    db.prepare('UPDATE sessions SET device_name=? WHERE id=?').run(`oauth:${digest(state)}`, req.auth.id);
    res.json({ url: oauthClient(config).generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/calendar.readonly', 'openid', 'email'], state }) });
  });
  app.get('/api/google/callback', requireAdult, asyncRoute(async (req, res) => {
    if (!req.query.state || req.auth.device_name !== `oauth:${digest(req.query.state)}`) return res.status(400).send('OAuth state is invalid.');
    const client = oauthClient(googleOAuthConfig(db)), { tokens } = await client.getToken(req.query.code); client.setCredentials(tokens);
    const info = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
    const result = db.prepare('INSERT INTO google_accounts(household_id,label,email,encrypted_tokens) VALUES (?,?,?,?)').run(req.auth.household_id, info.data.email || 'Google', info.data.email, encryptTokens(tokens));
    const list = await google.calendar({ version: 'v3', auth: client }).calendarList.list();
    const insert = db.prepare('INSERT INTO google_calendars(account_id,google_id,name,color,selected) VALUES (?,?,?,?,?)');
    for (const c of list.data.items || []) insert.run(result.lastInsertRowid, c.id, c.summary, c.backgroundColor, c.primary ? 1 : 0);
    emit(req.auth.household_id, 'calendar');
    res.redirect('/#settings');
  }));
  app.get('/api/google/calendars', requireAdult, (req, res) => res.json(db.prepare(`SELECT c.id,c.name,c.color,c.selected,a.label,a.status,a.last_error FROM google_calendars c JOIN google_accounts a ON a.id=c.account_id WHERE a.household_id=?`).all(req.auth.household_id)));
  app.patch('/api/google/calendars/:id', requireAdult, (req, res) => { db.prepare('UPDATE google_calendars SET selected=? WHERE id=? AND account_id IN (SELECT id FROM google_accounts WHERE household_id=?)').run(+!!req.body.selected, req.params.id, req.auth.household_id); emit(req.auth.household_id, 'calendar'); res.json({ ok: true }); });
  app.get('/api/calendar/events', asyncRoute(async (req, res) => {
    const timeMin = text(req.query.from, 40), timeMax = text(req.query.to, 40);
    if (!timeMin || !timeMax || Number.isNaN(Date.parse(timeMin)) || Number.isNaN(Date.parse(timeMax))) return res.status(400).json({ error: 'Valid from and to times are required.' });
    const calendars = db.prepare(`SELECT c.*,a.encrypted_tokens,a.id account_id FROM google_calendars c JOIN google_accounts a ON a.id=c.account_id WHERE a.household_id=? AND c.selected=1`).all(req.auth.household_id);
    const events = [], errors = [];
    const config = calendars.length ? googleOAuthConfig(db) : null;
    if (calendars.length && !config) return res.json({ events, errors: [{ message: 'Google OAuth is not configured. Ask an adult to add Google client credentials in Settings.' }] });
    for (const calendar of calendars) {
      try {
        const client = oauthClient(config); client.setCredentials(decryptTokens(calendar.encrypted_tokens));
        client.on('tokens', (tokens) => { const current = decryptTokens(calendar.encrypted_tokens); db.prepare('UPDATE google_accounts SET encrypted_tokens=?,status=?,last_error=NULL WHERE id=?').run(encryptTokens({ ...current, ...tokens }), 'active', calendar.account_id); });
        const response = await google.calendar({ version: 'v3', auth: client }).events.list({ calendarId: calendar.google_id, timeMin, timeMax, singleEvents: true, orderBy: 'startTime', timeZone: db.prepare('SELECT timezone FROM households WHERE id=?').get(req.auth.household_id).timezone });
        events.push(...(response.data.items || []).map((e) => ({ id: `${calendar.id}:${e.id}`, title: e.summary || '(Untitled)', start: e.start, end: e.end, color: calendar.color, calendar: calendar.name, source: 'google' })));
      } catch (error) {
        const state = classifyGoogleError(error); db.prepare('UPDATE google_accounts SET status=?,last_error=? WHERE id=?').run(state.status, state.message, calendar.account_id); errors.push({ calendar: calendar.name, message: state.message });
      }
    }
    res.json({ events, errors });
  }));

  app.use(express.static(publicDir, { etag: true, maxAge: '1h', setHeaders: (res, file) => { if (file.endsWith('service-worker.js')) res.set('Cache-Control', 'no-cache'); } }));
  app.get('/{*path}', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.use((error, req, res, next) => { console.error(error.message); if (!res.headersSent) res.status(error.status || 500).json({ error: error.status ? error.message : 'The request failed. Try again.' }); else next(error); });
  return app;
}
