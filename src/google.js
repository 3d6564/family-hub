import crypto from 'node:crypto';
import { google } from 'googleapis';

function keyBuffer(raw = process.env.TOKEN_ENCRYPTION_KEY) {
  if (!raw) throw new Error('TOKEN_ENCRYPTION_KEY is required for Google Calendar.');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes in base64.');
  return key;
}

export function encryptTokens(tokens, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer(key), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens)), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((value) => value.toString('base64url')).join('.');
}

export function decryptTokens(value, key) {
  const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer(key), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString());
}

export function oauthClient() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) throw new Error('Google OAuth is not configured.');
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
}

export function classifyGoogleError(error) {
  const status = error?.response?.status || error?.code;
  const reason = error?.response?.data?.error;
  if (status === 401 || reason === 'invalid_grant') return { status: 'revoked', message: 'Google access was revoked. Reconnect this account.' };
  if (status === 403) return { status: 'unavailable', message: 'Google Calendar access is unavailable for this account.' };
  return { status: 'unavailable', message: 'Google Calendar is temporarily unavailable.' };
}
