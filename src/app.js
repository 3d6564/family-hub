import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticate, clearUserSessionCookie, createPairingCode, createSession, csrf, digest, hashPassword, parseCookies, requireAdult, requireUser, setSessionCookie, USER_COOKIE, verifyPassword } from './auth.js';
import { chorePeriod, isChoreDue, localDate, parseDays } from './domain.js';
import { fetchFeedEvents, validateFeedUrl } from './ical.js';

const publicDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'public');
const clients = new Map();
const text = (value, max = 120) => typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null;
function reorder(db, table, householdId, ids) {
  const existing = db.prepare(`SELECT id FROM ${table} WHERE household_id=?`).all(householdId).map((row) => row.id);
  const requested = ids.map(Number);
  if (!Array.isArray(ids) || requested.length !== existing.length || requested.some((id) => !existing.includes(id))) return false;
  const update = db.prepare(`UPDATE ${table} SET sort_order=? WHERE id=? AND household_id=?`);
  db.transaction(() => requested.forEach((id, index) => update.run(index, id, householdId)))();
  return true;
}

function emit(householdId, event = 'update') {
  for (const res of clients.get(householdId) || []) res.write(`event: ${event}\ndata: {}\n\n`);
}
function asyncRoute(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }

/** Build the Express application around an opened database. */
export function createApp(db, dependencies = {}) {
  const app = express();
  const deploymentVersion = crypto.randomUUID();
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
    const household = db.prepare('SELECT id,name,timezone,week_starts_on weekStartsOn FROM households WHERE id=?').get(req.auth.household_id);
    res.json({ household, user: req.auth.user_id ? { id: req.auth.user_id, name: req.auth.name, email: req.auth.email, role: req.auth.role } : null, device: req.auth.kind === 'device' ? req.auth.device_name : null });
  });
  app.get('/api/version', (req, res) => res.json({ version: deploymentVersion }));
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
    const routines = db.prepare(`SELECT r.*,u.name child_name,EXISTS(SELECT 1 FROM routine_completions c WHERE c.routine_id=r.id AND c.completed_on=?) completed
      FROM routines r JOIN users u ON u.id=r.child_id WHERE r.household_id=? AND r.active=1 ORDER BY r.sort_order,r.id`).all(today, h).filter((r) => r.days.split(',').includes(String(new Date(`${today}T12:00:00Z`).getUTCDay())));
    const chores = db.prepare('SELECT c.*,u.name assignee_name FROM chores c LEFT JOIN users u ON u.id=c.assignee_id WHERE c.household_id=? AND c.active=1 ORDER BY c.sort_order,c.id').all(h)
      .filter((c) => isChoreDue(c, new Date(), household.timezone))
      .map((c) => ({ ...c, completed: !!db.prepare('SELECT 1 FROM chore_completions WHERE chore_id=? AND period_key=?').get(c.id, chorePeriod(c.recurrence, new Date(), household.timezone)) }));
    const plans = db.prepare('SELECT * FROM family_targets WHERE household_id=? ORDER BY sort_order,id').all(h);
    res.json({ today, routines, chores, plans });
  });

  app.get('/api/members', requireAdult, (req, res) => res.json(db.prepare("SELECT id,name,role,email NOT LIKE 'child-%@family-hub.invalid' has_email FROM users WHERE household_id=? ORDER BY role,name").all(req.auth.household_id)));
  app.post('/api/members', requireAdult, asyncRoute(async (req, res) => {
    const name = text(req.body.name, 80), email = text(req.body.email, 254)?.toLowerCase(), role = req.body.role;
    if (!name || !['adult', 'child'].includes(role) || (role === 'adult' && (!email || !req.body.password))) return res.status(400).json({ error: 'Name, email, and password are required for adult accounts.' });
    const passwordHash = await hashPassword(req.body.password || crypto.randomUUID());
    const memberEmail = email || `child-${crypto.randomUUID()}@family-hub.invalid`;
    const result = db.prepare('INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?,?)').run(req.auth.household_id, memberEmail, name, passwordHash, role);
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  }));
  app.patch('/api/members/:id', requireAdult, asyncRoute(async (req, res) => {
    const member = db.prepare('SELECT * FROM users WHERE id=? AND household_id=?').get(req.params.id, req.auth.household_id);
    if (!member) return res.status(404).json({ error: 'Household member not found.' });
    const name = req.body.name === undefined ? member.name : text(req.body.name, 80);
    const role = req.body.role === undefined ? member.role : req.body.role;
    if (!name || !['adult', 'child'].includes(role)) return res.status(400).json({ error: 'A name and valid role are required.' });
    if (member.id === req.auth.user_id && role !== 'adult') return res.status(400).json({ error: 'Your own account must remain an adult account.' });
    let email = member.email, passwordHash = member.password_hash;
    if (req.body.email !== undefined) {
      const requestedEmail = text(req.body.email, 254)?.toLowerCase();
      if (!requestedEmail) {
        if (role !== 'child') return res.status(400).json({ error: 'Adult accounts need an email address.' });
        email = `child-${crypto.randomUUID()}@family-hub.invalid`; passwordHash = await hashPassword(crypto.randomUUID());
      } else {
        if (typeof req.body.password !== 'string' || req.body.password.length < 12) return res.status(400).json({ error: 'A new email needs a password with at least 12 characters.' });
        const existing = db.prepare('SELECT id FROM users WHERE household_id=? AND email=?').get(req.auth.household_id, requestedEmail);
        if (existing && existing.id !== member.id) return res.status(400).json({ error: 'That email is already in use.' });
        email = requestedEmail; passwordHash = await hashPassword(req.body.password);
      }
    } else if (req.body.password) passwordHash = await hashPassword(req.body.password);
    db.prepare('UPDATE users SET name=?,role=?,email=?,password_hash=? WHERE id=?').run(name, role, email, passwordHash, member.id);
    res.json({ ok: true });
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
  app.put('/api/household/week-start', requireAdult, (req, res) => {
    const weekStartsOn = +req.body.weekStartsOn;
    if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) return res.status(400).json({ error: 'Week start must be a day of the week.' });
    db.prepare('UPDATE households SET week_starts_on=? WHERE id=?').run(weekStartsOn, req.auth.household_id);
    emit(req.auth.household_id, 'calendar'); res.json({ weekStartsOn });
  });
  app.get('/api/devices', requireAdult, (req, res) => res.json(db.prepare("SELECT id,device_name,created_at,expires_at FROM sessions WHERE household_id=? AND kind='device' ORDER BY created_at DESC").all(req.auth.household_id)));
  app.delete('/api/devices/:id', requireAdult, (req, res) => { db.prepare("DELETE FROM sessions WHERE id=? AND household_id=? AND kind='device'").run(req.params.id, req.auth.household_id); res.status(204).end(); });

  app.get('/api/routines', requireAdult, (req, res) => res.json(db.prepare('SELECT r.id,r.title,r.days,r.sort_order,u.name child_name FROM routines r JOIN users u ON u.id=r.child_id WHERE r.household_id=? AND r.active=1 ORDER BY r.sort_order,r.id').all(req.auth.household_id)));
  app.put('/api/routine-order', requireAdult, (req, res) => {
    if (!reorder(db, 'routines', req.auth.household_id, req.body.ids || [])) return res.status(400).json({ error: 'The routine order must include every routine once.' });
    emit(req.auth.household_id, 'tasks'); res.json({ ok: true });
  });
  app.post('/api/routines', requireAdult, (req, res) => {
    const title = text(req.body.title, 40), days = parseDays(req.body.days), child = db.prepare("SELECT id FROM users WHERE id=? AND household_id=? AND role='child'").get(req.body.childId, req.auth.household_id);
    if (!title || !child || !days) return res.status(400).json({ error: 'Child, a title of 40 characters or fewer, and valid days are required.' });
    const order = db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 next FROM routines WHERE household_id=?').get(req.auth.household_id).next;
    db.prepare('INSERT INTO routines(household_id,child_id,title,days,sort_order) VALUES (?,?,?,?,?)').run(req.auth.household_id, child.id, title, days, order); emit(req.auth.household_id, 'tasks'); res.status(201).json({ ok: true });
  });
  app.patch('/api/routines/:id', requireAdult, (req, res) => {
    const routine = db.prepare('SELECT * FROM routines WHERE id=? AND household_id=?').get(req.params.id, req.auth.household_id);
    const title = req.body.title === undefined ? routine?.title : text(req.body.title, 40), days = req.body.days === undefined ? routine?.days : parseDays(req.body.days);
    if (!routine) return res.status(404).json({ error: 'Routine not found.' });
    if (!title || !days) return res.status(400).json({ error: 'A title of 40 characters or fewer and valid days are required.' });
    db.prepare('UPDATE routines SET title=?,days=? WHERE id=?').run(title, days, routine.id); emit(req.auth.household_id, 'tasks'); res.json({ ok: true });
  });
  app.delete('/api/routines/:id', requireAdult, (req, res) => { db.prepare('DELETE FROM routines WHERE id=? AND household_id=?').run(req.params.id, req.auth.household_id); emit(req.auth.household_id, 'tasks'); res.status(204).end(); });
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
  app.get('/api/chores', requireAdult, (req, res) => res.json(db.prepare('SELECT c.id,c.title,c.days,c.recurrence,c.sort_order,u.name assignee_name FROM chores c LEFT JOIN users u ON u.id=c.assignee_id WHERE c.household_id=? AND c.active=1 ORDER BY c.sort_order,c.id').all(req.auth.household_id)));
  app.put('/api/chore-order', requireAdult, (req, res) => {
    if (!reorder(db, 'chores', req.auth.household_id, req.body.ids || [])) return res.status(400).json({ error: 'The chore order must include every chore once.' });
    emit(req.auth.household_id, 'tasks'); res.json({ ok: true });
  });
  app.post('/api/chores', requireAdult, (req, res) => {
    const title = text(req.body.title, 40), days = req.body.recurrence === 'once' ? null : parseDays(req.body.days);
    if (!title || (req.body.recurrence !== 'once' && !days)) return res.status(400).json({ error: 'A title of 40 characters or fewer and valid days are required.' });
    const assignee = req.body.assigneeId == null ? null : db.prepare('SELECT id FROM users WHERE id=? AND household_id=?').get(req.body.assigneeId, req.auth.household_id)?.id;
    const recurrence = days?.split(',').length === 1 ? 'weekly' : days ? 'daily' : 'once';
    const order = db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 next FROM chores WHERE household_id=?').get(req.auth.household_id).next;
    db.prepare('INSERT INTO chores(household_id,assignee_id,title,recurrence,due_on,days,sort_order) VALUES (?,?,?,?,?,?,?)').run(req.auth.household_id, assignee, title, recurrence, '0000-01-01', days, order); emit(req.auth.household_id, 'tasks'); res.status(201).json({ ok: true });
  });
  app.patch('/api/chores/:id', requireAdult, (req, res) => {
    const chore = db.prepare('SELECT * FROM chores WHERE id=? AND household_id=?').get(req.params.id, req.auth.household_id);
    const title = req.body.title === undefined ? chore?.title : text(req.body.title, 40), days = req.body.recurrence === 'once' ? null : req.body.days === undefined ? chore?.days : parseDays(req.body.days);
    if (!chore) return res.status(404).json({ error: 'Chore not found.' });
    if (!title || (req.body.recurrence !== 'once' && !days)) return res.status(400).json({ error: 'A title of 40 characters or fewer and valid days are required.' });
    const recurrence = days?.split(',').length === 1 ? 'weekly' : days ? 'daily' : 'once';
    db.prepare('UPDATE chores SET title=?,recurrence=?,due_on=?,days=? WHERE id=?').run(title, recurrence, '0000-01-01', days, chore.id); emit(req.auth.household_id, 'tasks'); res.json({ ok: true });
  });
  app.delete('/api/chores/:id', requireAdult, (req, res) => { db.prepare('DELETE FROM chores WHERE id=? AND household_id=?').run(req.params.id, req.auth.household_id); emit(req.auth.household_id, 'tasks'); res.status(204).end(); });
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
  app.patch('/api/reminders/:id', requireUser, (req, res) => {
    const reminder = db.prepare('SELECT * FROM local_reminders WHERE id=? AND household_id=?').get(req.params.id, req.auth.household_id);
    const title = text(req.body.title) || reminder?.title, starts = text(req.body.startsAt, 40) || reminder?.starts_at;
    if (!reminder) return res.status(404).json({ error: 'Reminder not found.' });
    if (!title || Number.isNaN(Date.parse(starts))) return res.status(400).json({ error: 'Title and time are required.' });
    db.prepare('UPDATE local_reminders SET title=?,starts_at=? WHERE id=?').run(title, starts, reminder.id); emit(req.auth.household_id, 'calendar'); res.json({ ok: true });
  });
  app.delete('/api/reminders/:id', requireUser, (req, res) => { db.prepare('DELETE FROM local_reminders WHERE id=? AND household_id=?').run(req.params.id, req.auth.household_id); emit(req.auth.household_id, 'calendar'); res.status(204).end(); });

  app.get('/api/calendar/feeds', requireAdult, (req, res) => res.json(db.prepare('SELECT id,name,color,enabled,created_at,updated_at,1 configured FROM calendar_feeds WHERE household_id=? ORDER BY name').all(req.auth.household_id)));
  app.post('/api/calendar/feeds', requireAdult, (req, res) => {
    const name = text(req.body.name, 80), color = text(req.body.color, 7), validation = validateFeedUrl(req.body.url);
    if (!name) return res.status(400).json({ error: 'Calendar name is required and must be 80 characters or fewer.' });
    if (!/^#[0-9a-f]{6}$/i.test(color || '')) return res.status(400).json({ error: 'Calendar color must be a six-digit hex color.' });
    if (!validation.valid) return res.status(400).json({ error: validation.error });
    const result = db.prepare('INSERT INTO calendar_feeds(household_id,name,url,color) VALUES (?,?,?,?)').run(req.auth.household_id, name, validation.url, color);
    emit(req.auth.household_id, 'calendar'); res.status(201).json({ id: Number(result.lastInsertRowid), name, color, enabled: 1, configured: 1 });
  });
  app.patch('/api/calendar/feeds/:id', requireAdult, (req, res) => {
    const feed = db.prepare('SELECT * FROM calendar_feeds WHERE id=? AND household_id=?').get(req.params.id, req.auth.household_id);
    if (!feed) return res.status(404).json({ error: 'Calendar feed not found.' });
    const name = req.body.name === undefined ? feed.name : text(req.body.name, 80);
    const color = req.body.color === undefined ? feed.color : text(req.body.color, 7);
    const validation = req.body.url ? validateFeedUrl(req.body.url) : { valid: true, url: feed.url };
    if (!name) return res.status(400).json({ error: 'Calendar name is required and must be 80 characters or fewer.' });
    if (!/^#[0-9a-f]{6}$/i.test(color || '')) return res.status(400).json({ error: 'Calendar color must be a six-digit hex color.' });
    if (!validation.valid) return res.status(400).json({ error: validation.error });
    db.prepare('UPDATE calendar_feeds SET name=?,url=?,color=?,enabled=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name, validation.url, color, req.body.enabled === undefined ? feed.enabled : +!!req.body.enabled, feed.id);
    emit(req.auth.household_id, 'calendar'); res.json({ ok: true });
  });
  app.delete('/api/calendar/feeds/:id', requireAdult, (req, res) => {
    const result = db.prepare('DELETE FROM calendar_feeds WHERE id=? AND household_id=?').run(req.params.id, req.auth.household_id);
    if (!result.changes) return res.status(404).json({ error: 'Calendar feed not found.' });
    emit(req.auth.household_id, 'calendar'); res.status(204).end();
  });
  app.get('/api/calendar/events', asyncRoute(async (req, res) => {
    const timeMin = text(req.query.from, 40), timeMax = text(req.query.to, 40);
    if (!timeMin || !timeMax || Number.isNaN(Date.parse(timeMin)) || Number.isNaN(Date.parse(timeMax))) return res.status(400).json({ error: 'Valid from and to times are required.' });
    const from = new Date(timeMin), to = new Date(timeMax);
    if (from >= to || to - from > 62 * 86400000) return res.status(400).json({ error: 'Calendar range must be positive and no longer than 62 days.' });
    const feeds = db.prepare('SELECT id,name,url,color FROM calendar_feeds WHERE household_id=? AND enabled=1').all(req.auth.household_id);
    const events = db.prepare('SELECT id,title,starts_at FROM local_reminders WHERE household_id=? AND starts_at>=? AND starts_at<? ORDER BY starts_at').all(req.auth.household_id, timeMin, timeMax).map((event) => ({ id: `local:${event.id}`, title: event.title, start: { dateTime: event.starts_at }, end: null, color: null, calendar: 'Family Hub', source: 'local reminder' }));
    const errors = [];
    for (const feed of feeds) {
      try {
        events.push(...await (dependencies.fetchFeedEvents || fetchFeedEvents)(feed, from, to));
      } catch (error) {
        errors.push({ feedId: feed.id, calendar: feed.name, message: `Could not load ${feed.name}: ${error.message}` });
      }
    }
    events.sort((a, b) => (a.start.dateTime || a.start.date).localeCompare(b.start.dateTime || b.start.date));
    res.json({ events, errors });
  }));

  app.use(express.static(publicDir, { etag: true, maxAge: '1h', setHeaders: (res, file) => { if (file.endsWith('service-worker.js')) res.set('Cache-Control', 'no-cache'); } }));
  app.get('/{*path}', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.use((error, req, res, next) => { console.error(error.message); if (!res.headersSent) res.status(error.status || 500).json({ error: error.status ? error.message : 'The request failed. Try again.' }); else next(error); });
  return app;
}
