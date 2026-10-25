import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreDatabase, writeBackup } from './backup.js';
import { approveDisplayPairing, authenticate, claimDisplayPairing, clearUserSessionCookie, createDisplayPairing, createPairingCode, createSession, csrf, DEVICE_COOKIE, digest, hashPassword, parseCookies, requireAdult, requireUser, setSessionCookie, USER_COOKIE, verifyPassword } from './auth.js';
import { chorePeriod, isChoreDue, localDate, parseDays } from './domain.js';
import { fetchFeedEvents, validateFeedUrl } from './ical.js';
import { ensureTokenLedger, postChoreEarning, reverseChoreEarning, tokenLedger, tokenStatus, TokenError, withdrawTokens } from './tokens.js';
import { releaseInfo } from './release.js';
import { createUpdateChecker } from './updates.js';
import { currentForecast, fetchWeather, weatherProviderIds, weatherRefreshMinutes } from './weather.js';

const publicDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'public');
const clients = new Map();
const text = (value, max = 120) => typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null;
const rewardQuarters = (value) => {
  if (value !== undefined && value !== null && value !== '' && !['number', 'string'].includes(typeof value)) return null;
  const amount = value === undefined || value === null || value === '' ? 0 : Number(value);
  const quarters = amount * 4;
  return Number.isFinite(amount) && amount >= 0 && Number.isSafeInteger(quarters) ? quarters : null;
};
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
function screenMetrics(body = {}) {
  const integer = (value, max = 20000) => Number.isInteger(value) && value > 0 && value <= max ? value : null;
  const metrics = {
    screenWidth: integer(body.screenWidth),
    screenHeight: integer(body.screenHeight),
    viewportWidth: integer(body.viewportWidth),
    viewportHeight: integer(body.viewportHeight),
    pixelRatio: Number(body.pixelRatio),
  };
  if (!metrics.screenWidth || !metrics.screenHeight || !metrics.viewportWidth || !metrics.viewportHeight || !Number.isFinite(metrics.pixelRatio) || metrics.pixelRatio < 0.5 || metrics.pixelRatio > 8) return null;
  return metrics;
}
function saveDeviceScreen(db, token, metrics) {
  if (!token || !metrics) return;
  db.prepare("UPDATE sessions SET screen_width=?,screen_height=?,viewport_width=?,viewport_height=?,pixel_ratio=?,last_seen_at=CURRENT_TIMESTAMP WHERE token_hash=? AND kind='device'").run(metrics.screenWidth, metrics.screenHeight, metrics.viewportWidth, metrics.viewportHeight, metrics.pixelRatio, digest(token));
}

/** Build the Express application around an opened database. */
export function createApp(db, dependencies = {}) {
  // Only safe connection outcomes are retained; provider errors can contain secrets.
  const weatherAttempts = new Map(), calendarAttempts = new Map();
  const app = express();
  const deploymentVersion = crypto.randomUUID();
  app.disable('x-powered-by');
  app.get('/health/ready', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      db.prepare('SELECT 1').get();
      res.type('text').send('ready');
    } catch {
      res.status(503).type('text').send('unavailable');
    }
  });
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  const databasePath = dependencies.databasePath || process.env.DATABASE_PATH || db.name;
  let restoring = false;
  const needsSetup = () => db.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0;
  app.get('/api/setup', (req, res) => res.json({ needsSetup: needsSetup() }));
  app.post('/api/setup/account', csrf, asyncRoute(async (req, res) => {
    if (!needsSetup()) return res.status(409).json({ error: 'Family Hub is already set up. Sign in instead.' });
    const email = text(req.body.email, 254)?.toLowerCase();
    const name = text(req.body.name, 80);
    const householdName = text(req.body.householdName, 80);
    if (!email || !name) return res.status(400).json({ error: 'Enter your name and email.' });
    let passwordHash;
    try { passwordHash = await hashPassword(req.body.password); } catch (error) { return res.status(400).json({ error: error.message }); }
    if (!needsSetup()) return res.status(409).json({ error: 'Family Hub is already set up. Sign in instead.' });
    const household = db.prepare('SELECT id FROM households ORDER BY id LIMIT 1').get();
    if (!household) return res.status(500).json({ error: 'Family Hub could not create the household.' });
    if (householdName) db.prepare('UPDATE households SET name=? WHERE id=?').run(householdName, household.id);
    const userId = Number(db.prepare("INSERT INTO users(household_id,email,name,password_hash,role) VALUES (?,?,?,?, 'adult')").run(household.id, email, name, passwordHash).lastInsertRowid);
    setSessionCookie(res, createSession(db, { householdId: household.id, userId }), 'user');
    res.status(201).json({ ok: true });
  }));
  app.post('/api/setup/restore', csrf, express.raw({ type: 'application/octet-stream', limit: '64mb' }), asyncRoute(async (req, res) => {
    if (!needsSetup()) return res.status(409).json({ error: 'Family Hub is already set up. Sign in to restore a backup.' });
    if (restoring) return res.status(409).json({ error: 'A restore is already in progress.' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Choose a Family Hub backup file.' });
    restoring = true;
    try {
      await restoreDatabase(db, databasePath, req.body);
      res.json({ ok: true, restarting: true });
      res.on('finish', () => setTimeout(() => (dependencies.restart || (() => process.exit(0)))(), 300));
    } catch (error) {
      restoring = false;
      if (!res.headersSent) res.status(error.status || 400).json({ error: error.message || 'Choose a Family Hub backup file.' });
    }
  }));
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
  app.post('/api/display-pairings', csrf, (req, res) => {
    const pairing = createDisplayPairing(db);
    if (!pairing) return res.status(429).json({ error: 'Too many screens are waiting. Try again in a few minutes.' });
    res.status(201).json(pairing);
  });
  app.post('/api/display-pairings/status', csrf, (req, res) => {
    const claim = db.transaction(() => {
      const result = claimDisplayPairing(db, req.body?.secret);
      if (result.status === 'paired' && !result.already) saveDeviceScreen(db, result.token, screenMetrics(req.body));
      return result;
    })();
    if (claim.status === 'paired' && !claim.already) {
      const token = claim.token;
      setSessionCookie(res, token, 'device');
      if (claim.reconnectedSessionId) closeScreenStreams(claim.householdId, claim.reconnectedSessionId);
    }
    res.json({ status: claim.status });
  });

  const auth = authenticate(db);
  app.use('/api', auth, csrf);
  app.get('/api/me', (req, res) => {
    const household = db.prepare('SELECT id,name,display_title displayTitle,timezone,week_starts_on weekStartsOn,dim_enabled dimEnabled,dim_start dimStart,dim_end dimEnd,theme,token_board_enabled tokenBoardEnabled,routine_morning_start routineMorningStart,routine_afternoon_start routineAfternoonStart,routine_bedtime_start routineBedtimeStart FROM households WHERE id=?').get(req.auth.household_id);
    household.tokenBoardEnabled = !!household.tokenBoardEnabled;
    res.json({ household, user: req.auth.user_id ? { id: req.auth.user_id, name: req.auth.name, email: req.auth.email, role: req.auth.role } : null, device: req.auth.kind === 'device' ? req.auth.device_name : null });
  });
  app.get('/api/version', (req, res) => res.json({ version: deploymentVersion }));
  app.get('/api/release', requireAdult, (req, res) => res.json(releaseInfo()));
  const updates = dependencies.updateChecker || createUpdateChecker();
  app.get('/api/updates', requireAdult, asyncRoute(async (req, res) => res.json(await updates.status())));
  app.get('/api/household/backup', requireAdult, asyncRoute(async (req, res) => {
    if (restoring) return res.status(409).json({ error: 'A restore is in progress. Try again after Family Hub restarts.' });
    const dest = path.join(os.tmpdir(), `family-hub-${crypto.randomUUID()}.sqlite`);
    try {
      await writeBackup(db, dest);
      const stamp = new Date().toISOString().slice(0, 10);
      res.download(dest, `family-hub-${stamp}.sqlite`, () => fs.rmSync(dest, { force: true }));
    } catch (error) {
      fs.rmSync(dest, { force: true });
      throw error;
    }
  }));
  app.post('/api/household/restore', requireAdult, express.raw({ type: 'application/octet-stream', limit: '64mb' }), asyncRoute(async (req, res) => {
    if (restoring) return res.status(409).json({ error: 'A restore is already in progress.' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Choose a Family Hub backup file.' });
    restoring = true;
    try {
      await restoreDatabase(db, databasePath, req.body);
      res.json({ ok: true, restarting: true });
      res.on('finish', () => setTimeout(() => (dependencies.restart || (() => process.exit(0)))(), 300));
    } catch (error) {
      if (!db.open) {
        if (!res.headersSent) res.status(500).json({ error: 'Restore did not finish. Family Hub will restart on the previous database.' });
        return setTimeout(() => (dependencies.restart || (() => process.exit(0)))(), 300);
      }
      restoring = false;
      return res.status(error.status || 400).json({ error: error.message || 'Choose a Family Hub backup file.' });
    }
  }));
  app.post('/api/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[USER_COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));
    clearUserSessionCookie(res); res.json({ ok: true });
  });
  app.get('/api/events/stream', (req, res) => {
    res.locals.sessionId = req.auth.id;
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders(); res.write('event: ready\ndata: {}\n\n');
    const set = clients.get(req.auth.household_id) || new Set(); set.add(res); clients.set(req.auth.household_id, set);
    req.on('close', () => set.delete(res));
  });

  app.get('/api/dashboard', asyncRoute(async (req, res) => {
    const h = req.auth.household_id;
    const household = db.prepare(`SELECT id,timezone,weather_enabled,weather_location,weather_units,weather_api_key,weather_provider,weather_days,weather_refresh_minutes,
      weather_show_precip,weather_show_wind,weather_show_humidity,weather_show_current,weather_show_feels FROM households WHERE id=?`).get(h);
    const today = localDate(new Date(), household.timezone);
    const routines = db.prepare(`SELECT r.id,r.title,r.days,r.period,r.sort_order,a.child_id,u.name child_name,EXISTS(SELECT 1 FROM routine_completions c WHERE c.routine_id=r.id AND c.child_id=a.child_id AND c.completed_on=?) completed
      FROM routines r JOIN routine_assignees a ON a.routine_id=r.id JOIN users u ON u.id=a.child_id WHERE r.household_id=? AND r.active=1 ORDER BY r.sort_order,r.id,u.name`).all(today, h).filter((r) => r.days.split(',').includes(String(new Date(`${today}T12:00:00Z`).getUTCDay())));
    const chores = db.prepare('SELECT c.*,u.name assignee_name FROM chores c LEFT JOIN users u ON u.id=c.assignee_id WHERE c.household_id=? AND c.active=1 ORDER BY c.sort_order,c.id').all(h)
      .filter((c) => isChoreDue(c, new Date(), household.timezone))
      .map((c) => ({ ...c, completed: !!db.prepare('SELECT 1 FROM chore_completions WHERE chore_id=? AND period_key=?').get(c.id, chorePeriod(c.recurrence, new Date(), household.timezone)) }))
      .filter((c) => c.recurrence !== 'once' || !c.completed);
    const plans = db.prepare('SELECT * FROM family_targets WHERE household_id=? ORDER BY sort_order,id').all(h);
    const dim = db.prepare('SELECT dim_enabled enabled,dim_start start,dim_end end,timezone,theme,display_title displayTitle,token_board_enabled tokenBoardEnabled,routine_morning_start routineMorningStart,routine_afternoon_start routineAfternoonStart,routine_bedtime_start routineBedtimeStart FROM households WHERE id=?').get(h);
    dim.tokenBoardEnabled = !!dim.tokenBoardEnabled;
    const weather = await currentForecast(db, household, dependencies.fetchForecast || fetchWeather, new Date(), (status) => weatherAttempts.set(h, status));
    res.json({ today, routines, chores, plans, dim, weather });
  }));

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
  app.post('/api/screens/pair', requireAdult, (req, res) => {
    const name = text(req.body.name, 60) || 'Wall display';
    const reconnectId = req.body.reconnectId === undefined ? null : req.body.reconnectId;
    if (reconnectId !== null && (!Number.isSafeInteger(reconnectId) || reconnectId <= 0)) return res.status(400).json({ error: 'Choose an existing screen to reconnect.' });
    if (!approveDisplayPairing(db, req.auth.household_id, req.body.code, name, reconnectId)) return res.status(400).json({ error: 'The code is invalid, expired, or already assigned, or the screen is unavailable. Refresh Screens and try again.' });
    res.json({ ok: true });
  });
  app.put('/api/household/week-start', requireAdult, (req, res) => {
    const weekStartsOn = +req.body.weekStartsOn;
    if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) return res.status(400).json({ error: 'Week start must be a day of the week.' });
    db.prepare('UPDATE households SET week_starts_on=? WHERE id=?').run(weekStartsOn, req.auth.household_id);
    emit(req.auth.household_id, 'calendar'); res.json({ weekStartsOn });
  });
  app.put('/api/household/display-title', requireAdult, (req, res) => {
    if (req.body.displayTitle !== null && typeof req.body.displayTitle !== 'string') return res.status(400).json({ error: 'Enter a display title of 60 characters or fewer, or leave it blank.' });
    const displayTitle = req.body.displayTitle?.trim() ? text(req.body.displayTitle, 60) : null;
    if (req.body.displayTitle?.trim() && !displayTitle) return res.status(400).json({ error: 'Display title must be 60 characters or fewer.' });
    db.prepare('UPDATE households SET display_title=? WHERE id=?').run(displayTitle, req.auth.household_id);
    emit(req.auth.household_id, 'dashboard'); res.json({ displayTitle });
  });
  app.put('/api/household/dim', requireAdult, (req, res) => {
    const dimStart = text(req.body.dimStart, 5), dimEnd = text(req.body.dimEnd, 5);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dimStart || '') || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dimEnd || '') || dimStart === dimEnd) return res.status(400).json({ error: 'Choose a start and end time, using different times.' });
    const dimEnabled = req.body.dimEnabled ? 1 : 0;
    db.prepare('UPDATE households SET dim_enabled=?,dim_start=?,dim_end=? WHERE id=?').run(dimEnabled, dimStart, dimEnd, req.auth.household_id);
    emit(req.auth.household_id, 'dashboard'); res.json({ dimEnabled, dimStart, dimEnd });
  });
  app.put('/api/household/routine-times', requireAdult, (req, res) => {
    const time = (value) => text(value, 5);
    const morningStart = time(req.body.morningStart), afternoonStart = time(req.body.afternoonStart), bedtimeStart = time(req.body.bedtimeStart);
    const valid = (value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value || '');
    if (![morningStart, afternoonStart, bedtimeStart].every(valid) || !(morningStart < afternoonStart && afternoonStart < bedtimeStart)) return res.status(400).json({ error: 'Choose valid Morning, Afternoon, and Bedtime starts in that order.' });
    db.prepare('UPDATE households SET routine_morning_start=?,routine_afternoon_start=?,routine_bedtime_start=? WHERE id=?').run(morningStart, afternoonStart, bedtimeStart, req.auth.household_id);
    emit(req.auth.household_id, 'tasks'); res.json({ routineMorningStart: morningStart, routineAfternoonStart: afternoonStart, routineBedtimeStart: bedtimeStart });
  });
  function weatherKeyValue(value) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return '';
    return trimmed.length <= 200 ? trimmed : null;
  }
  function weatherKeysFor(householdId) {
    const saved = Object.fromEntries(db.prepare('SELECT provider,api_key FROM weather_provider_keys WHERE household_id=?').all(householdId).map((row) => [row.provider, row.api_key]));
    return Object.fromEntries(weatherProviderIds().map((provider) => [provider, saved[provider] || '']));
  }
  function weatherSettings(row, keys) {
    return {
      enabled: !!row.weather_enabled, location: row.weather_location || '', units: row.weather_units, provider: row.weather_provider || 'openweathermap', days: row.weather_days || 5, refreshMinutes: weatherRefreshMinutes(row.weather_refresh_minutes),
      showPrecip: !!row.weather_show_precip, showWind: !!row.weather_show_wind, showHumidity: !!row.weather_show_humidity, showCurrent: !!row.weather_show_current, showFeels: !!row.weather_show_feels,
      hasKey: Object.fromEntries(weatherProviderIds().map((provider) => [provider, !!keys[provider]])),
    };
  }
  app.get('/api/household/weather', requireAdult, (req, res) => {
    const row = db.prepare('SELECT weather_enabled,weather_location,weather_units,weather_provider,weather_days,weather_refresh_minutes,weather_show_precip,weather_show_wind,weather_show_humidity,weather_show_current,weather_show_feels FROM households WHERE id=?').get(req.auth.household_id);
    const cached = db.prepare('SELECT fetched_at FROM weather_cache WHERE household_id=?').get(req.auth.household_id);
    const attempt = weatherAttempts.get(req.auth.household_id);
    const settings = weatherSettings(row, weatherKeysFor(req.auth.household_id));
    const configured = !!row.weather_location && (settings.provider === 'open-meteo' || settings.hasKey[settings.provider]);
    const state = !settings.enabled ? 'disabled' : !configured ? 'unconfigured' : attempt?.failed ? 'error' : !cached ? 'not_checked' : Date.now() - Date.parse(cached.fetched_at) >= settings.refreshMinutes * 60000 ? 'stale' : 'ok';
    res.json({ ...settings, status: { state, lastSuccessAt: cached?.fetched_at || null, lastAttemptAt: attempt?.lastAttemptAt || null } });
  });
  app.put('/api/household/weather', requireAdult, (req, res) => {
    const id = req.auth.household_id;
    const current = db.prepare('SELECT weather_enabled,weather_location,weather_units,weather_api_key,weather_provider,weather_days,weather_refresh_minutes,weather_show_precip,weather_show_wind,weather_show_humidity,weather_show_current,weather_show_feels FROM households WHERE id=?').get(id);
    const enabled = req.body.enabled === undefined ? current.weather_enabled : req.body.enabled ? 1 : 0;
    const location = req.body.location === undefined ? current.weather_location : text(req.body.location, 80);
    const units = req.body.units === undefined ? current.weather_units : req.body.units === 'c' ? 'c' : req.body.units === 'f' ? 'f' : null;
    const provider = req.body.provider === undefined ? (current.weather_provider || 'openweathermap') : text(req.body.provider, 20);
    const days = req.body.days === undefined ? current.weather_days || 5 : Number(req.body.days);
    const refreshMinutes = req.body.refreshMinutes === undefined ? weatherRefreshMinutes(current.weather_refresh_minutes) : weatherRefreshMinutes(req.body.refreshMinutes, null);
    const flag = (name, column) => req.body[name] === undefined ? current[column] : req.body[name] ? 1 : 0;
    if (!weatherProviderIds().includes(provider)) return res.status(400).json({ error: 'Choose OpenWeatherMap, Open-Meteo, WeatherAPI.com, or Pirate Weather.' });
    if (!Number.isInteger(days) || days < 1 || days > 7) return res.status(400).json({ error: 'Choose 1 to 7 forecast days.' });
    if (refreshMinutes === null) return res.status(400).json({ error: 'Choose a forecast update of 15 minutes, 30 minutes, 1 hour, or 3 hours.' });
    if (enabled && !location) return res.status(400).json({ error: 'Enter a location to show the forecast.' });
    if (!units) return res.status(400).json({ error: 'Choose Fahrenheit or Celsius.' });
    const keys = weatherKeysFor(id);
    if (req.body.keys !== undefined && (!req.body.keys || typeof req.body.keys !== 'object' || Array.isArray(req.body.keys))) return res.status(400).json({ error: 'Save each provider key separately.' });
    for (const name of weatherProviderIds()) {
      if (!req.body.keys || req.body.keys[name] === undefined) continue;
      const key = weatherKeyValue(req.body.keys[name]);
      if (key === null) return res.status(400).json({ error: 'Each weather API key must be 200 characters or fewer.' });
      keys[name] = key;
    }
    if (req.body.apiKey !== undefined && req.body.keys?.[provider] === undefined) {
      const key = weatherKeyValue(req.body.apiKey);
      if (key === null) return res.status(400).json({ error: 'Weather API key must be 200 characters or fewer.' });
      if (key !== '') keys[provider] = key;
    }
    if (enabled && provider !== 'open-meteo' && !keys[provider]) return res.status(400).json({ error: 'Save an API key for this provider, or choose Open-Meteo.' });
    const activeKey = keys[provider] || null;
    const refreshForecast = location !== current.weather_location || units !== current.weather_units || provider !== (current.weather_provider || 'openweathermap') || activeKey !== (current.weather_provider === provider ? current.weather_api_key : weatherKeysFor(id)[provider]);
    db.transaction(() => {
      db.prepare(`UPDATE households SET weather_enabled=?,weather_location=?,weather_units=?,weather_api_key=?,weather_provider=?,weather_days=?,weather_refresh_minutes=?,
        weather_show_precip=?,weather_show_wind=?,weather_show_humidity=?,weather_show_current=?,weather_show_feels=? WHERE id=?`).run(
        enabled, location, units, activeKey, provider, days, refreshMinutes, flag('showPrecip', 'weather_show_precip'), flag('showWind', 'weather_show_wind'), flag('showHumidity', 'weather_show_humidity'), flag('showCurrent', 'weather_show_current'), flag('showFeels', 'weather_show_feels'), id);
      const saveKey = db.prepare(`INSERT INTO weather_provider_keys(household_id,provider,api_key) VALUES (?,?,?)
        ON CONFLICT(household_id,provider) DO UPDATE SET api_key=excluded.api_key`);
      const deleteKey = db.prepare('DELETE FROM weather_provider_keys WHERE household_id=? AND provider=?');
      for (const name of weatherProviderIds()) if (keys[name]) saveKey.run(id, name, keys[name]); else deleteKey.run(id, name);
      if (refreshForecast) {
        db.prepare('DELETE FROM weather_cache WHERE household_id=?').run(id);
        weatherAttempts.delete(id);
      }
    })();
    emit(id, 'dashboard');
    const saved = db.prepare('SELECT weather_enabled,weather_location,weather_units,weather_provider,weather_days,weather_refresh_minutes,weather_show_precip,weather_show_wind,weather_show_humidity,weather_show_current,weather_show_feels FROM households WHERE id=?').get(id);
    const response = weatherSettings(saved, weatherKeysFor(id));
    res.json(response);
  });
  app.put('/api/household/theme', requireAdult, (req, res) => {
    const theme = text(req.body.theme, 12);
    if (!['green', 'slate', 'blue', 'warm'].includes(theme)) return res.status(400).json({ error: 'Choose Green, Slate, Blue, or Warm.' });
    db.prepare('UPDATE households SET theme=? WHERE id=?').run(theme, req.auth.household_id);
    emit(req.auth.household_id, 'dashboard'); res.json({ theme });
  });
  app.put('/api/household/token-board', requireAdult, (req, res) => {
    const tokenBoardEnabled = req.body.enabled ? 1 : 0;
    db.prepare('UPDATE households SET token_board_enabled=? WHERE id=?').run(tokenBoardEnabled, req.auth.household_id);
    emit(req.auth.household_id, 'dashboard');
    res.json({ tokenBoardEnabled: !!tokenBoardEnabled });
  });
  app.post('/api/device/screen', (req, res) => {
    const token = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
    const device = token && db.prepare("SELECT id,household_id FROM sessions WHERE token_hash=? AND kind='device' AND expires_at>?").get(digest(token), new Date().toISOString());
    if (!device) return res.status(403).json({ error: 'A paired display is required.' });
    const metrics = screenMetrics(req.body);
    if (!metrics) return res.status(400).json({ error: 'The screen dimensions are invalid.' });
    db.prepare('UPDATE sessions SET screen_width=?,screen_height=?,viewport_width=?,viewport_height=?,pixel_ratio=?,last_seen_at=CURRENT_TIMESTAMP WHERE id=? AND household_id=?').run(metrics.screenWidth, metrics.screenHeight, metrics.viewportWidth, metrics.viewportHeight, metrics.pixelRatio, device.id, device.household_id);
    res.json({ ok: true });
  });
  app.get('/api/devices', requireAdult, (req, res) => res.json(db.prepare("SELECT id,device_name,screen_width,screen_height,viewport_width,viewport_height,pixel_ratio,last_seen_at,created_at,expires_at FROM sessions WHERE household_id=? AND kind='device' ORDER BY created_at DESC").all(req.auth.household_id)));
  function closeScreenStreams(householdId, sessionId) {
    for (const response of clients.get(householdId) || []) if (response.locals.sessionId === sessionId) response.end();
  }
  app.delete('/api/devices/:id', requireAdult, (req, res) => { const result = db.prepare("DELETE FROM sessions WHERE id=? AND household_id=? AND kind='device'").run(req.params.id, req.auth.household_id); if (result.changes) closeScreenStreams(req.auth.household_id, Number(req.params.id)); res.status(204).end(); });

  function childIdsFor(householdId, ids) {
    const requested = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean))];
    if (!requested.length) return [];
    const found = db.prepare(`SELECT id FROM users WHERE household_id=? AND role='child' AND id IN (${requested.map(() => '?').join(',')})`).all(householdId, ...requested).map((row) => row.id);
    return found.length === requested.length ? found : [];
  }
  function saveRoutineChildren(routineId, childIds) {
    db.prepare('DELETE FROM routine_assignees WHERE routine_id=?').run(routineId);
    const insert = db.prepare('INSERT INTO routine_assignees(routine_id,child_id) VALUES (?,?)');
    childIds.forEach((childId) => insert.run(routineId, childId));
    db.prepare('UPDATE routines SET child_id=? WHERE id=?').run(childIds[0], routineId);
  }
  app.get('/api/routines', requireAdult, (req, res) => {
    const rows = db.prepare(`SELECT r.id,r.title,r.days,r.period,r.sort_order,a.child_id,u.name child_name FROM routines r JOIN routine_assignees a ON a.routine_id=r.id JOIN users u ON u.id=a.child_id WHERE r.household_id=? AND r.active=1 ORDER BY r.sort_order,r.id,u.name`).all(req.auth.household_id);
    const grouped = new Map();
    for (const row of rows) {
      const item = grouped.get(row.id) || { id: row.id, title: row.title, days: row.days, period: row.period, sort_order: row.sort_order, child_ids: [], child_names: [] };
      item.child_ids.push(row.child_id); item.child_names.push(row.child_name); grouped.set(row.id, item);
    }
    res.json([...grouped.values()].map((item) => ({ ...item, child_names: item.child_names.join(', ') })));
  });
  app.put('/api/routine-order', requireAdult, (req, res) => {
    if (!reorder(db, 'routines', req.auth.household_id, req.body.ids || [])) return res.status(400).json({ error: 'The routine order must include every routine once.' });
    emit(req.auth.household_id, 'tasks'); res.json({ ok: true });
  });
  app.post('/api/routines', requireAdult, (req, res) => {
    const periods = ['morning', 'after_school', 'bedtime'];
    const title = text(req.body.title, 40), days = parseDays(req.body.days), period = req.body.period || 'morning', childIds = childIdsFor(req.auth.household_id, req.body.childIds || req.body.childId);
    if (!title || !childIds.length || !days || !periods.includes(period)) return res.status(400).json({ error: 'At least one child, a title of 40 characters or fewer, valid days, and a time of day are required.' });
    const order = db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 next FROM routines WHERE household_id=?').get(req.auth.household_id).next;
    const result = db.prepare('INSERT INTO routines(household_id,child_id,title,days,period,sort_order) VALUES (?,?,?,?,?,?)').run(req.auth.household_id, childIds[0], title, days, period, order);
    saveRoutineChildren(Number(result.lastInsertRowid), childIds); emit(req.auth.household_id, 'tasks'); res.status(201).json({ ok: true });
  });
  app.patch('/api/routines/:id', requireAdult, (req, res) => {
    const routine = db.prepare('SELECT * FROM routines WHERE id=? AND household_id=?').get(req.params.id, req.auth.household_id);
    const periods = ['morning', 'after_school', 'bedtime'];
    const title = req.body.title === undefined ? routine?.title : text(req.body.title, 40), days = req.body.days === undefined ? routine?.days : parseDays(req.body.days), period = req.body.period === undefined ? routine?.period : req.body.period;
    if (!routine) return res.status(404).json({ error: 'Routine not found.' });
    if (!title || !days || !periods.includes(period)) return res.status(400).json({ error: 'A title of 40 characters or fewer, valid days, and a time of day are required.' });
    const childIds = req.body.childIds === undefined && req.body.childId === undefined ? null : childIdsFor(req.auth.household_id, req.body.childIds || req.body.childId);
    if (childIds && !childIds.length) return res.status(400).json({ error: 'Choose at least one child.' });
    db.prepare('UPDATE routines SET title=?,days=?,period=? WHERE id=?').run(title, days, period, routine.id);
    if (childIds) saveRoutineChildren(routine.id, childIds);
    emit(req.auth.household_id, 'tasks'); res.json({ ok: true });
  });
  app.delete('/api/routines/:id', requireAdult, (req, res) => { db.prepare('DELETE FROM routines WHERE id=? AND household_id=?').run(req.params.id, req.auth.household_id); emit(req.auth.household_id, 'tasks'); res.status(204).end(); });
  app.post('/api/routines/:id/toggle', (req, res) => {
    const routine = db.prepare('SELECT r.*,h.timezone FROM routines r JOIN households h ON h.id=r.household_id WHERE r.id=? AND r.household_id=?').get(req.params.id, req.auth.household_id);
    if (!routine) return res.status(404).json({ error: 'Routine not found.' });
    const assignees = db.prepare('SELECT child_id FROM routine_assignees WHERE routine_id=?').all(routine.id).map((row) => row.child_id);
    if (!assignees.length) assignees.push(routine.child_id);
    const childId = Number(req.body.childId) || (assignees.length === 1 ? assignees[0] : 0);
    if (!assignees.includes(childId)) return res.status(400).json({ error: 'Choose one assigned child.' });
    const date = localDate(new Date(), routine.timezone), existing = db.prepare('SELECT 1 FROM routine_completions WHERE routine_id=? AND child_id=? AND completed_on=?').get(routine.id, childId, date);
    if (req.auth.kind === 'device' && !routine.days.split(',').includes(String(new Date(`${date}T12:00:00Z`).getUTCDay()))) return res.status(403).json({ error: 'This routine is not due today.' });
    if (existing) db.prepare('DELETE FROM routine_completions WHERE routine_id=? AND child_id=? AND completed_on=?').run(routine.id, childId, date); else db.prepare('INSERT INTO routine_completions(routine_id,child_id,completed_on) VALUES (?,?,?)').run(routine.id, childId, date);
    emit(req.auth.household_id, 'tasks'); res.json({ completed: !existing });
  });
  app.get('/api/routines/history', requireAdult, (req, res) => {
    res.json(db.prepare(`SELECT c.completed_on,c.completed_at,r.title,u.name child_name FROM routine_completions c JOIN routines r ON r.id=c.routine_id JOIN users u ON u.id=c.child_id WHERE r.household_id=? ORDER BY c.completed_on DESC,c.completed_at DESC LIMIT 2000`).all(req.auth.household_id));
  });
  app.get('/api/chores', requireAdult, (req, res) => res.json(db.prepare('SELECT c.id,c.title,c.days,c.recurrence,c.sort_order,c.reward_quarters,c.assignee_id,u.name assignee_name FROM chores c LEFT JOIN users u ON u.id=c.assignee_id WHERE c.household_id=? AND c.active=1 ORDER BY c.sort_order,c.id').all(req.auth.household_id)));
  app.put('/api/chore-order', requireAdult, (req, res) => {
    if (!reorder(db, 'chores', req.auth.household_id, req.body.ids || [])) return res.status(400).json({ error: 'The chore order must include every chore once.' });
    emit(req.auth.household_id, 'tasks'); res.json({ ok: true });
  });
  app.post('/api/chores', requireAdult, (req, res) => {
    const title = text(req.body.title, 40), days = req.body.recurrence === 'once' ? null : parseDays(req.body.days), reward = rewardQuarters(req.body.rewardAmount);
    if (!title || (req.body.recurrence !== 'once' && !days) || reward === null) return res.status(400).json({ error: 'A title of 40 characters or fewer, valid days, and a reward in $0.25 steps are required.' });
    const assignee = req.body.assigneeId == null ? null : db.prepare('SELECT id FROM users WHERE id=? AND household_id=?').get(req.body.assigneeId, req.auth.household_id)?.id;
    const recurrence = days?.split(',').length === 1 ? 'weekly' : days ? 'daily' : 'once';
    const order = db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 next FROM chores WHERE household_id=?').get(req.auth.household_id).next;
    db.prepare('INSERT INTO chores(household_id,assignee_id,title,recurrence,due_on,days,sort_order,reward_quarters) VALUES (?,?,?,?,?,?,?,?)').run(req.auth.household_id, assignee, title, recurrence, '0000-01-01', days, order, reward); emit(req.auth.household_id, 'tasks'); res.status(201).json({ ok: true });
  });
  app.patch('/api/chores/:id', requireAdult, (req, res) => {
    const chore = db.prepare('SELECT * FROM chores WHERE id=? AND household_id=?').get(req.params.id, req.auth.household_id);
    const title = req.body.title === undefined ? chore?.title : text(req.body.title, 40), days = req.body.recurrence === 'once' ? null : req.body.days === undefined ? chore?.days : parseDays(req.body.days), reward = req.body.rewardAmount === undefined ? chore?.reward_quarters : rewardQuarters(req.body.rewardAmount);
    if (!chore) return res.status(404).json({ error: 'Chore not found.' });
    if (!title || (req.body.recurrence !== 'once' && !days) || reward === null) return res.status(400).json({ error: 'A title of 40 characters or fewer, valid days, and a reward in $0.25 steps are required.' });
    const assignee = req.body.assigneeId === undefined ? chore.assignee_id : req.body.assigneeId === '' || req.body.assigneeId === null ? null : db.prepare('SELECT id FROM users WHERE id=? AND household_id=?').get(req.body.assigneeId, req.auth.household_id)?.id;
    if (assignee === undefined) return res.status(400).json({ error: 'Choose a household member or Anyone.' });
    const recurrence = days?.split(',').length === 1 ? 'weekly' : days ? 'daily' : 'once';
    db.prepare('UPDATE chores SET title=?,assignee_id=?,recurrence=?,due_on=?,days=?,reward_quarters=? WHERE id=?').run(title, assignee, recurrence, '0000-01-01', days, reward, chore.id); emit(req.auth.household_id, 'tasks'); res.json({ ok: true });
  });
  app.delete('/api/chores/:id', requireAdult, (req, res) => { db.prepare('DELETE FROM chores WHERE id=? AND household_id=?').run(req.params.id, req.auth.household_id); emit(req.auth.household_id, 'tasks'); res.status(204).end(); });
  app.post('/api/chores/:id/toggle', (req, res) => {
    const chore = db.prepare('SELECT c.*,h.timezone FROM chores c JOIN households h ON h.id=c.household_id WHERE c.id=? AND c.household_id=?').get(req.params.id, req.auth.household_id);
    if (!chore) return res.status(404).json({ error: 'Chore not found.' });
    if (req.auth.kind === 'device' && !isChoreDue(chore, new Date(), chore.timezone)) return res.status(403).json({ error: 'This chore is not due today.' });
    const period = chorePeriod(chore.recurrence, new Date(), chore.timezone);
    try {
      ensureTokenLedger(db, req.auth.household_id);
      const toggle = db.transaction(() => {
        const existing = db.prepare('SELECT 1 FROM chore_completions WHERE chore_id=? AND period_key=?').get(chore.id, period);
        if (existing) {
          reverseChoreEarning(db, chore, period);
          db.prepare('DELETE FROM chore_completions WHERE chore_id=? AND period_key=?').run(chore.id, period);
          if (chore.recurrence === 'once') db.prepare('UPDATE chores SET active=1 WHERE id=?').run(chore.id);
          return false;
        }
        db.prepare('INSERT INTO chore_completions(chore_id,period_key) VALUES (?,?)').run(chore.id, period);
        postChoreEarning(db, chore, period);
        if (chore.recurrence === 'once') db.prepare('UPDATE chores SET active=0 WHERE id=?').run(chore.id);
        return true;
      });
      const completed = toggle.immediate();
      emit(req.auth.household_id, 'tasks');
      res.json({ completed });
    } catch (error) {
      if (error instanceof TokenError) return res.status(error.status).json({ error: error.message });
      throw error;
    }
  });
  app.get('/api/tokens', (req, res) => res.json(tokenStatus(db, req.auth.household_id)));
  app.get('/api/tokens/ledger', (req, res) => {
    try { res.json(tokenLedger(db, req.auth.household_id, req.query.userId)); }
    catch (error) { if (error instanceof TokenError) return res.status(error.status).json({ error: error.message }); throw error; }
  });
  app.post('/api/tokens/withdraw', (req, res) => {
    try {
      const result = withdrawTokens(db, { householdId: req.auth.household_id, userId: Number(req.body.userId), copper: req.body.copper, silver: req.body.silver, gold: req.body.gold, requestId: req.body.requestId });
      emit(req.auth.household_id, 'tasks');
      res.json(result);
    } catch (error) {
      if (error instanceof TokenError) return res.status(error.status).json({ error: error.message });
      throw error;
    }
  });
  app.get('/api/chores/history', requireAdult, (req, res) => {
    res.json(db.prepare(`SELECT c.period_key,c.completed_at,h.title,u.name assignee_name FROM chore_completions c JOIN chores h ON h.id=c.chore_id LEFT JOIN users u ON u.id=h.assignee_id WHERE h.household_id=? ORDER BY c.completed_at DESC LIMIT 2000`).all(req.auth.household_id));
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

  app.get('/api/calendar/feeds', requireAdult, (req, res) => {
    const feeds = db.prepare('SELECT id,name,color,enabled,sort_order,created_at,updated_at,1 configured FROM calendar_feeds WHERE household_id=? ORDER BY sort_order,id').all(req.auth.household_id);
    res.json(feeds.map((feed) => ({ ...feed, status: { ...(calendarAttempts.get(req.auth.household_id)?.get(feed.id) || { state: 'not_checked', lastSuccessAt: null, lastAttemptAt: null }), ...(!feed.enabled ? { state: 'disabled' } : {}) } })));
  });
  app.post('/api/calendar/feeds', requireAdult, (req, res) => {
    const name = text(req.body.name, 80), color = text(req.body.color, 7), validation = validateFeedUrl(req.body.url);
    if (!name) return res.status(400).json({ error: 'Calendar name is required and must be 80 characters or fewer.' });
    if (!/^#[0-9a-f]{6}$/i.test(color || '')) return res.status(400).json({ error: 'Calendar color must be a six-digit hex color.' });
    if (!validation.valid) return res.status(400).json({ error: validation.error });
    const order = db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 next FROM calendar_feeds WHERE household_id=?').get(req.auth.household_id).next;
    const result = db.prepare('INSERT INTO calendar_feeds(household_id,name,url,color,sort_order) VALUES (?,?,?,?,?)').run(req.auth.household_id, name, validation.url, color, order);
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
    if (validation.url !== feed.url) calendarAttempts.get(req.auth.household_id)?.delete(feed.id);
    emit(req.auth.household_id, 'calendar'); res.json({ ok: true });
  });
  app.delete('/api/calendar/feeds/:id', requireAdult, (req, res) => {
    const result = db.prepare('DELETE FROM calendar_feeds WHERE id=? AND household_id=?').run(req.params.id, req.auth.household_id);
    if (!result.changes) return res.status(404).json({ error: 'Calendar feed not found.' });
    calendarAttempts.get(req.auth.household_id)?.delete(Number(req.params.id));
    emit(req.auth.household_id, 'calendar'); res.status(204).end();
  });
  app.put('/api/calendar/feed-order', requireAdult, (req, res) => {
    if (!reorder(db, 'calendar_feeds', req.auth.household_id, req.body.ids || [])) return res.status(400).json({ error: 'The calendar order must include every calendar once.' });
    emit(req.auth.household_id, 'calendar'); res.json({ ok: true });
  });
  app.get('/api/calendar/events', asyncRoute(async (req, res) => {
    const timeMin = text(req.query.from, 40), timeMax = text(req.query.to, 40);
    if (!timeMin || !timeMax || Number.isNaN(Date.parse(timeMin)) || Number.isNaN(Date.parse(timeMax))) return res.status(400).json({ error: 'Valid from and to times are required.' });
    const from = new Date(timeMin), to = new Date(timeMax);
    if (from >= to || to - from > 62 * 86400000) return res.status(400).json({ error: 'Calendar range must be positive and no longer than 62 days.' });
    const feeds = db.prepare('SELECT id,name,url,color,sort_order FROM calendar_feeds WHERE household_id=? AND enabled=1 ORDER BY sort_order,id').all(req.auth.household_id);
    const events = db.prepare('SELECT id,title,starts_at FROM local_reminders WHERE household_id=? AND starts_at>=? AND starts_at<? ORDER BY starts_at').all(req.auth.household_id, timeMin, timeMax).map((event) => ({ event: { id: `local:${event.id}`, title: event.title, start: { dateTime: event.starts_at }, end: null, color: null, calendar: 'Family Hub', source: 'local reminder' }, order: -1 }));
    const errors = [];
    const statuses = calendarAttempts.get(req.auth.household_id) || new Map();
    calendarAttempts.set(req.auth.household_id, statuses);
    for (const feed of feeds) {
      const lastAttemptAt = new Date().toISOString();
      try {
        const feedEvents = await (dependencies.fetchFeedEvents || fetchFeedEvents)(feed, from, to);
        events.push(...feedEvents.map((event) => ({ event, order: feed.sort_order })));
        statuses.set(feed.id, { state: 'ok', lastAttemptAt, lastSuccessAt: lastAttemptAt });
      } catch (error) {
        statuses.set(feed.id, { state: 'error', lastAttemptAt, lastSuccessAt: statuses.get(feed.id)?.lastSuccessAt || null });
        errors.push({ feedId: feed.id, calendar: feed.name, message: `Could not load ${feed.name}. Check the calendar connection and try again.` });
      }
    }
    events.sort((a, b) => a.order - b.order || (a.event.start.dateTime || a.event.start.date).localeCompare(b.event.start.dateTime || b.event.start.date));
    res.json({ events: events.map(({ event }) => event), errors });
  }));

  app.use(express.static(publicDir, { etag: true, maxAge: 0, setHeaders: (res) => { res.set('Cache-Control', 'no-cache'); } }));
  app.get('/{*path}', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.use((error, req, res, next) => { console.error(error.message); if (!res.headersSent) res.status(error.status || 500).json({ error: error.status ? error.message : 'The request failed. Try again.' }); else next(error); });
  return app;
}
