import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
export const USER_COOKIE = 'family_user_session';
export const DEVICE_COOKIE = 'family_device_session';

export async function hashPassword(password, { allowTemporaryPassword = false } = {}) {
  const minimumLength = allowTemporaryPassword ? 8 : 12;
  if (typeof password !== 'string' || password.length < minimumLength) throw new Error(`Password must be at least ${minimumLength} characters.`);
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [, n, r, p, salt, expected] = stored.split('$');
    const actual = await scrypt(password, Buffer.from(salt, 'base64'), 64, { N: +n, r: +r, p: +p });
    return crypto.timingSafeEqual(actual, Buffer.from(expected, 'base64'));
  } catch { return false; }
}

export function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
export function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((pair) => pair.length === 2));
}

export function createSession(db, { householdId, userId = null, kind = 'user', deviceName = null }, days = +(process.env.SESSION_DAYS || 30)) {
  const token = randomToken();
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  db.prepare('INSERT INTO sessions(token_hash,household_id,user_id,device_name,kind,expires_at) VALUES (?,?,?,?,?,?)')
    .run(digest(token), householdId, userId, deviceName, kind, expires);
  return token;
}

/** Browser address used for cookies and saved changes. Older names still work. */
export function siteUrl(env = process.env) {
  return (env.SITE_URL || env.APP_ORIGIN || '').trim().replace(/\/$/, '');
}

/** Addresses allowed to save changes. SITE_URL is included automatically. */
export function allowedSiteOrigins(env = process.env, fallback = '') {
  const origins = [siteUrl(env), ...(env.ALLOWED_ORIGINS || '').split(',')].map((value) => value.trim().replace(/\/$/, '')).filter(Boolean);
  return [...new Set(origins.length ? origins : [fallback].filter(Boolean))];
}

export function setSessionCookie(res, token, kind = 'user') {
  const cookie = kind === 'device' ? DEVICE_COOKIE : USER_COOKIE;
  const secure = siteUrl().startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${cookie}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${+(process.env.SESSION_DAYS || 30) * 86400}${secure}`);
}

export function clearUserSessionCookie(res) { res.setHeader('Set-Cookie', `${USER_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`); }

export function authenticate(db) {
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const query = db.prepare(`SELECT s.*,u.name,u.email,u.role FROM sessions s LEFT JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.kind=? AND s.expires_at > ?`);
    const now = new Date().toISOString();
    const userToken = cookies[USER_COOKIE], deviceToken = cookies[DEVICE_COOKIE];
    const session = (userToken && query.get(digest(userToken), 'user', now)) || (deviceToken && query.get(digest(deviceToken), 'device', now));
    if (!session) return res.status(401).json({ error: 'Sign in or pair this device.' });
    req.auth = session;
    next();
  };
}

export function createPairingCode(db, householdId, minutes = 10) {
  const code = randomToken(6).slice(0, 8).toUpperCase();
  db.prepare('INSERT INTO pairing_codes(household_id,code_hash,expires_at) VALUES (?,?,?)').run(householdId, digest(code), new Date(Date.now() + minutes * 60000).toISOString());
  return code;
}

const DISPLAY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function displayPairCode() {
  return [...crypto.randomBytes(8)].map((byte) => DISPLAY_CODE_ALPHABET[byte % DISPLAY_CODE_ALPHABET.length]).join('');
}

/** Normalize a code read from a screen. Returns null when the shape is wrong. */
export function normalizeDisplayCode(value) {
  const code = typeof value === 'string' ? value.replace(/[\s-]/g, '').toUpperCase() : '';
  return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code) ? code : null;
}

/**
 * Start a screen-initiated pairing.
 * The screen shows the short code. Only the screen keeps the secret used to collect the session.
 */
export function createDisplayPairing(db, minutes = 10) {
  const now = new Date().toISOString();
  db.prepare('DELETE FROM display_pairings WHERE expires_at<=? AND claimed_at IS NULL').run(now);
  if (db.prepare('SELECT COUNT(*) AS count FROM display_pairings WHERE expires_at>? AND claimed_at IS NULL').get(now).count >= 20) return null;
  const code = displayPairCode();
  const secret = randomToken(32);
  const expiresAt = new Date(Date.now() + minutes * 60000).toISOString();
  db.prepare('INSERT INTO display_pairings(user_code_hash,device_secret_hash,expires_at) VALUES (?,?,?)').run(digest(code), digest(secret), expiresAt);
  return { code, secret, expiresAt };
}

/** Bind a screen code to the approving adult's household. The code alone does not create a session. */
export function approveDisplayPairing(db, householdId, code, deviceName) {
  const normalized = normalizeDisplayCode(code);
  const name = typeof deviceName === 'string' && deviceName.trim() && deviceName.trim().length <= 60 ? deviceName.trim() : 'Wall display';
  if (!normalized) return false;
  const row = db.prepare('SELECT * FROM display_pairings WHERE user_code_hash=?').get(digest(normalized));
  const now = new Date().toISOString();
  if (!row || row.claimed_at || row.expires_at <= now) return false;
  if (row.approved_at && row.household_id !== householdId) return false;
  const result = db.prepare(`UPDATE display_pairings
    SET household_id=?, device_name=?, approved_at=COALESCE(approved_at, ?)
    WHERE id=? AND claimed_at IS NULL AND (approved_at IS NULL OR household_id=?)`).run(householdId, name, now, row.id, householdId);
  return result.changes === 1;
}

/**
 * Give the session only to the screen that holds the secret.
 * A second claim does not issue another session.
 */
export function claimDisplayPairing(db, secret) {
  if (typeof secret !== 'string' || secret.length < 20 || secret.length > 80) return { status: 'expired' };
  const row = db.prepare('SELECT * FROM display_pairings WHERE device_secret_hash=?').get(digest(secret));
  const now = new Date().toISOString();
  if (!row || row.expires_at <= now) return { status: 'expired' };
  if (!row.approved_at || !row.household_id) return { status: 'pending' };
  const claim = db.prepare('UPDATE display_pairings SET claimed_at=? WHERE id=? AND claimed_at IS NULL').run(now, row.id);
  if (!claim.changes) return { status: 'paired', already: true };
  return { status: 'paired', householdId: row.household_id, deviceName: row.device_name || 'Wall display' };
}

export function requireAdult(req, res, next) {
  if (req.auth.kind !== 'user' || req.auth.role !== 'adult') return res.status(403).json({ error: 'An adult account is required.' });
  next();
}

export function requireUser(req, res, next) {
  if (req.auth.kind !== 'user') return res.status(403).json({ error: 'A personal account is required.' });
  next();
}

export function csrf(req, res, next) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    const allowed = allowedSiteOrigins(process.env, `${req.protocol}://${req.get('host')}`);
    if (!origin || !allowed.includes(origin) || req.get('x-csrf-token') !== '1') return res.status(403).json({ error: 'Request verification failed.' });
  }
  next();
}
