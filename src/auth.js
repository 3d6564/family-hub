import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'family_session';

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('Password must be at least 12 characters.');
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

export function setSessionCookie(res, token) {
  const secure = process.env.APP_ORIGIN?.startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${+(process.env.SESSION_DAYS || 30) * 86400}${secure}`);
}

export function clearSessionCookie(res) { res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`); }

export function authenticate(db) {
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const session = token && db.prepare(`SELECT s.*,u.name,u.email,u.role FROM sessions s LEFT JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at > ?`).get(digest(token), new Date().toISOString());
    if (!session) return res.status(401).json({ error: 'Sign in or pair this device.' });
    req.auth = session;
    next();
  };
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
