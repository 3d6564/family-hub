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

export function setSessionCookie(res, token, kind = 'user') {
  const cookie = kind === 'device' ? DEVICE_COOKIE : USER_COOKIE;
  const secure = process.env.APP_ORIGIN?.startsWith('https://') ? '; Secure' : '';
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
    const expected = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
    if (!origin || origin !== expected || req.get('x-csrf-token') !== '1') return res.status(403).json({ error: 'Request verification failed.' });
  }
  next();
}
