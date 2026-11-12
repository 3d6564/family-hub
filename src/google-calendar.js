import crypto from 'node:crypto';
import { requireAdult, siteUrl as configuredSiteUrl } from './auth.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_API = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const EVENT_CACHE_MS = 5 * 60_000;
const MAX_CALENDARS = 50;
const MAX_PAGES = 10;
const MAX_PENDING = 32;
const PENDING_MS = 10 * 60_000;

export class GoogleCalendarError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'GoogleCalendarError';
    this.status = status;
  }
}

function keyBytes(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new GoogleCalendarError('Google Calendar needs a server encryption key. Ask the host owner to set FAMILY_HUB_INTEGRATION_KEY.', 503);
  }
  return Buffer.from(value, 'hex');
}

function sealSecret(value, key, context) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(key), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}

function unsealSecret(value, key, context, maxLength, errorMessage) {
  try {
    const saved = JSON.parse(value);
    if (saved.version !== 1) throw new Error('Unsupported secret');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(key), Buffer.from(saved.iv, 'base64'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
    const secret = Buffer.concat([decipher.update(Buffer.from(saved.data, 'base64')), decipher.final()]).toString('utf8');
    if (!secret || secret.length > maxLength) throw new Error('Invalid secret');
    return secret;
  } catch {
    throw new GoogleCalendarError(errorMessage, 409);
  }
}

function seal(refreshToken, key, householdId) {
  return sealSecret(refreshToken, key, `google-calendar:v1:${householdId}`);
}

function unseal(value, key, householdId) {
  return unsealSecret(value, key, `google-calendar:v1:${householdId}`, 8192,
    'Google Calendar credentials cannot be opened. Restore the encryption key or reconnect Google Calendar.');
}

function sealClientSecret(secret, key, householdId) {
  return sealSecret(secret, key, `google-calendar-client:v1:${householdId}`);
}

function unsealClientSecret(value, key, householdId) {
  return unsealSecret(value, key, `google-calendar-client:v1:${householdId}`, 4096,
    'Saved Google OAuth credentials cannot be opened. Restore the encryption key or enter them again.');
}

function siteBase(value) {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) return null;
    return url;
  } catch { return null; }
}

function responseObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(response) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_RESPONSE_BYTES) throw new GoogleCalendarError('Google Calendar returned a response that is too large.', 502);
  if (!response.body) return {};
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new GoogleCalendarError('Google Calendar returned a response that is too large.', 502);
    }
    chunks.push(value);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!responseObject(data)) throw new Error('Expected an object');
    return data;
  } catch {
    throw new GoogleCalendarError('Google Calendar returned an invalid response.', 502);
  }
}

function safeText(value, max = 2000) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function boundedId(value, max = 1024) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : '';
}

function temporal(value) {
  if (typeof value?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.date)) {
    try { if (new Date(`${value.date}T00:00:00Z`).toISOString().slice(0, 10) === value.date) return { date: value.date }; } catch {}
  }
  if (typeof value?.dateTime === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.dateTime) && !Number.isNaN(Date.parse(value.dateTime))) return { dateTime: value.dateTime };
  return null;
}

/** Convert one Google event to the calendar shape shared with iCal events. */
export function normalizeGoogleEvent(event, calendar) {
  if (!responseObject(event) || event.status === 'cancelled' || !boundedId(event.id)) return null;
  const start = temporal(event.start), end = temporal(event.end);
  if (!start) return null;
  const color = /^#[0-9a-f]{6}$/i.test(calendar.color || '') ? calendar.color : '#4285f4';
  return {
    id: `google:${calendar.id}:${event.id}`,
    title: safeText(event.summary, 500) || '(Untitled)',
    description: safeText(event.description, 8000) || null,
    location: safeText(event.location, 1000) || null,
    start,
    end,
    color,
    calendar: calendar.name,
    source: 'google',
  };
}

function readJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** Keep Google refresh tokens encrypted and return selected calendars as normalized household events. */
export function createGoogleCalendarConnector(db, options = {}) {
  const envClientId = options.clientId ?? process.env.GOOGLE_OAUTH_CLIENT_ID;
  const envClientSecret = options.clientSecret ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const key = options.key ?? process.env.FAMILY_HUB_INTEGRATION_KEY;
  const base = siteBase(options.siteUrl ?? configuredSiteUrl());
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const notify = options.notify || (() => {});
  const pending = new Map(), accessTokens = new Map(), eventsCache = new Map(), eventLoads = new Map();

  function callbackUri() {
    if (!base) throw new GoogleCalendarError('Google Calendar needs a valid HTTPS SITE_URL. Use localhost for local testing.', 503);
    return new URL('/api/integrations/google-calendar/callback', base).href;
  }

  function keyReady() {
    try { keyBytes(key); return true; } catch { return false; }
  }

  function savedOAuthSettings(householdId) {
    return db.prepare('SELECT client_id,client_secret FROM google_calendar_oauth_settings WHERE household_id=?').get(householdId);
  }

  function oauthCredentials(householdId) {
    const saved = savedOAuthSettings(householdId);
    if (saved) return {
      clientId: saved.client_id,
      clientSecret: unsealClientSecret(saved.client_secret, key, householdId),
      source: 'app',
    };
    const clientId = typeof envClientId === 'string' ? envClientId.trim() : '';
    const clientSecret = typeof envClientSecret === 'string' ? envClientSecret.trim() : '';
    return { clientId, clientSecret, source: clientId || clientSecret ? 'environment' : 'not_set' };
  }

  function oauthReady(householdId) {
    try {
      const credentials = oauthCredentials(householdId);
      callbackUri();
      return !!credentials.clientId && !!credentials.clientSecret;
    } catch { return false; }
  }

  function oauthSource(householdId) {
    const saved = savedOAuthSettings(householdId);
    if (saved) return { source: 'app', appCredentialsSaved: true, oauthClientId: saved.client_id, credentialsConfigured: true };
    const envConfigured = typeof envClientId === 'string' && !!envClientId.trim()
      && typeof envClientSecret === 'string' && !!envClientSecret.trim();
    return { source: envConfigured ? 'environment' : 'none', appCredentialsSaved: false, oauthClientId: '', credentialsConfigured: envConfigured };
  }

  function rowFor(householdId) {
    return db.prepare('SELECT * FROM google_calendar_connections WHERE household_id=?').get(householdId);
  }

  function clearCache(householdId) {
    const prefix = `${householdId}:`;
    for (const cacheKey of eventsCache.keys()) if (cacheKey.startsWith(prefix)) eventsCache.delete(cacheKey);
    for (const cacheKey of eventLoads.keys()) if (cacheKey.startsWith(prefix)) eventLoads.delete(cacheKey);
    accessTokens.delete(householdId);
  }

  async function fetchJson(url, init) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' });
      return { status: response.status, body: await readJson(response) };
    } catch (error) {
      if (error instanceof GoogleCalendarError) throw error;
      throw new GoogleCalendarError('Google Calendar could not be reached.', 502);
    } finally { clearTimeout(timer); }
  }

  function tokenForm(values, credentials) {
    return new URLSearchParams({ ...values, client_id: credentials.clientId, client_secret: credentials.clientSecret });
  }

  async function requestTokens(values, credentials) {
    const { status, body } = await fetchJson(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenForm(values, credentials),
    });
    if (status < 200 || status >= 300) throw new GoogleCalendarError('Google authorization could not be completed.', 502);
    if (typeof body.access_token !== 'string' || body.access_token.length > 8192 || !Number.isFinite(Number(body.expires_in)) || Number(body.expires_in) <= 0) {
      throw new GoogleCalendarError('Google authorization returned invalid credentials.', 502);
    }
    return body;
  }

  async function accessToken(householdId, force = false) {
    const cached = accessTokens.get(householdId);
    if (!force && cached && cached.expiresAt > Date.now() + 30_000) return cached.value;
    const row = rowFor(householdId);
    if (!row) throw new GoogleCalendarError('Connect Google Calendar in Settings → Integrations first.', 409);
    const refreshToken = unseal(row.credentials, key, householdId);
    const body = await requestTokens({ grant_type: 'refresh_token', refresh_token: refreshToken }, oauthCredentials(householdId));
    const rotatedToken = typeof body.refresh_token === 'string' && body.refresh_token.length <= 8192 ? body.refresh_token : refreshToken;
    if (rotatedToken !== refreshToken) {
      db.prepare('UPDATE google_calendar_connections SET credentials=?,updated_at=CURRENT_TIMESTAMP WHERE household_id=?')
        .run(seal(rotatedToken, key, householdId), householdId);
    }
    const token = { value: body.access_token, expiresAt: Date.now() + Math.min(Number(body.expires_in), 86400) * 1000 };
    accessTokens.set(householdId, token);
    return token.value;
  }

  async function apiJson(householdId, url) {
    let token = await accessToken(householdId);
    let result = await fetchJson(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
    if (result.status === 401) {
      accessTokens.delete(householdId);
      token = await accessToken(householdId, true);
      result = await fetchJson(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
    }
    if (result.status < 200 || result.status >= 300) throw new GoogleCalendarError('Google Calendar data could not be loaded.', 502);
    return result.body;
  }

  async function apiJsonWithToken(url, token) {
    const result = await fetchJson(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
    if (result.status < 200 || result.status >= 300) throw new GoogleCalendarError('Google Calendar data could not be loaded.', 502);
    return result.body;
  }

  async function listCalendars(householdId, suppliedToken) {
    const calendars = [];
    let pageToken = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${GOOGLE_API}/users/me/calendarList`);
      url.searchParams.set('maxResults', '250');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const body = suppliedToken ? await apiJsonWithToken(url, suppliedToken) : await apiJson(householdId, url);
      if (!Array.isArray(body.items)) throw new GoogleCalendarError('Google Calendar returned an invalid calendar list.', 502);
      for (const item of body.items) {
        if (!responseObject(item) || !boundedId(item.id)) continue;
        const color = /^#[0-9a-f]{6}$/i.test(item.backgroundColor || '') ? item.backgroundColor : '#4285f4';
        calendars.push({
          id: boundedId(item.id),
          name: safeText(item.summaryOverride, 200) || safeText(item.summary, 200) || 'Google Calendar',
          primary: item.primary === true,
          color,
        });
      }
      pageToken = safeText(body.nextPageToken, 2000);
      if (!pageToken) return calendars;
    }
    if (pageToken) throw new GoogleCalendarError('Google returned too many calendars to load.', 502);
    return calendars;
  }

  async function listEvents(householdId, calendar, from, to) {
    const events = [];
    let pageToken = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${GOOGLE_API}/calendars/${encodeURIComponent(calendar.id)}/events`);
      url.searchParams.set('timeMin', from.toISOString());
      url.searchParams.set('timeMax', to.toISOString());
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('orderBy', 'startTime');
      url.searchParams.set('maxResults', '2500');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const body = await apiJson(householdId, url);
      if (!Array.isArray(body.items)) throw new GoogleCalendarError('Google Calendar returned invalid events.', 502);
      for (const item of body.items) {
        const event = normalizeGoogleEvent(item, calendar);
        if (event) events.push(event);
      }
      pageToken = safeText(body.nextPageToken, 2000);
      if (!pageToken) return events;
    }
    if (pageToken) throw new GoogleCalendarError('Google returned too many events to load.', 502);
    return events;
  }

  function saveCalendars(householdId, calendars, selectedIds, enabled) {
    db.prepare(`UPDATE google_calendar_connections SET calendars_json=?,selected_calendar_ids_json=?,enabled=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE household_id=?`).run(JSON.stringify(calendars), JSON.stringify(selectedIds), enabled ? 1 : 0, householdId);
  }

  function settings(householdId) {
    const row = rowFor(householdId), calendars = row ? readJsonArray(row.calendars_json) : [];
    const selectedIds = row ? readJsonArray(row.selected_calendar_ids_json).filter(id => typeof id === 'string') : [];
    const oauth = oauthSource(householdId), encryptionReady = keyReady(), connected = !!row;
    const configured = oauth.credentialsConfigured && !!base;
    const credentialsReady = oauthReady(householdId);
    let state = !configured ? 'unconfigured' : !encryptionReady ? 'needs_key' : !credentialsReady ? 'credentials_error' : !connected ? 'not_connected' : !row.enabled ? 'disabled' : row.last_error ? 'error' : !row.last_success_at ? 'not_checked' : 'ok';
    return {
      configured,
      oauthSource: oauth.source,
      appCredentialsSaved: oauth.appCredentialsSaved,
      oauthClientId: oauth.oauthClientId,
      keyReady: encryptionReady,
      connected,
      enabled: !!row?.enabled,
      calendars: calendars.map(calendar => ({ ...calendar, selected: selectedIds.includes(calendar.id) })),
      selectedCalendarIds: selectedIds,
      state,
      lastAttemptAt: row?.last_attempt_at || null,
      lastSuccessAt: row?.last_success_at || null,
      error: row?.last_error || null,
    };
  }

  function begin(householdId, auth) {
    keyBytes(key);
    const credentials = oauthCredentials(householdId);
    if (!credentials.clientId || !credentials.clientSecret) throw new GoogleCalendarError('Enter Google OAuth credentials in Settings → Integrations and confirm SITE_URL is correct.', 503);
    if (!auth || auth.kind !== 'user' || auth.role !== 'adult' || !Number.isInteger(auth.id) || !Number.isInteger(auth.user_id)) {
      throw new GoogleCalendarError('An adult account is required.', 403);
    }
    const redirectUri = callbackUri(), now = Date.now();
    for (const [state, request] of pending) if (request.expiresAt <= now) pending.delete(state);
    while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
    const state = crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    pending.set(state, { householdId, userId: auth.user_id, sessionId: auth.id, verifier, redirectUri, credentials, expiresAt: now + PENDING_MS });
    const url = new URL(GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: credentials.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return { authorizationUrl: url.href };
  }

  function activeAdultSession(request) {
    return db.prepare(`SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.id=? AND s.household_id=? AND s.user_id=? AND s.kind='user' AND s.expires_at>? AND u.household_id=s.household_id AND u.role='adult'`)
      .get(request.sessionId, request.householdId, request.userId, new Date().toISOString());
  }

  async function complete(query) {
    const state = typeof query?.state === 'string' && query.state.length <= 128 ? query.state : '';
    const request = pending.get(state);
    if (!request) return 'failed';
    pending.delete(state);
    if (request.expiresAt <= Date.now() || !activeAdultSession(request)) return 'failed';
    if (typeof query.error === 'string') return query.error === 'access_denied' ? 'cancelled' : 'failed';
    if (typeof query.code !== 'string' || !query.code || query.code.length > 4096) return 'failed';

    let tokens;
    try {
      tokens = await requestTokens({
        grant_type: 'authorization_code',
        code: query.code,
        code_verifier: request.verifier,
        redirect_uri: request.redirectUri,
      }, request.credentials);
    } catch { return 'failed'; }
    if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token || tokens.refresh_token.length > 8192) return 'failed';

    const credentials = seal(tokens.refresh_token, key, request.householdId), now = new Date().toISOString();
    db.prepare(`INSERT INTO google_calendar_connections(household_id,credentials,last_attempt_at)
      VALUES (?,?,?) ON CONFLICT(household_id) DO UPDATE SET credentials=excluded.credentials,calendars_json='[]',
      selected_calendar_ids_json='[]',enabled=0,last_attempt_at=excluded.last_attempt_at,last_success_at=NULL,
      last_error=NULL,updated_at=CURRENT_TIMESTAMP`).run(request.householdId, credentials, now);
    accessTokens.set(request.householdId, { value: tokens.access_token, expiresAt: Date.now() + Math.min(Number(tokens.expires_in), 86400) * 1000 });
    clearEvents(request.householdId);

    try {
      const calendars = await listCalendars(request.householdId, tokens.access_token);
      saveCalendars(request.householdId, calendars, [], false);
      notify(request.householdId);
      return 'success';
    } catch {
      db.prepare('UPDATE google_calendar_connections SET last_error=?,updated_at=CURRENT_TIMESTAMP WHERE household_id=?')
        .run('Google Calendar connected, but the calendar list could not load. Try refreshing it in Settings → Integrations.', request.householdId);
      notify(request.householdId);
      return 'partial';
    }
  }

  function clearEvents(householdId) {
    const prefix = `${householdId}:`;
    for (const cacheKey of eventsCache.keys()) if (cacheKey.startsWith(prefix)) eventsCache.delete(cacheKey);
    for (const cacheKey of eventLoads.keys()) if (cacheKey.startsWith(prefix)) eventLoads.delete(cacheKey);
  }

  async function refreshCatalog(householdId) {
    const row = rowFor(householdId);
    if (!row) throw new GoogleCalendarError('Connect Google Calendar first.', 409);
    const calendars = await listCalendars(householdId);
    const valid = new Set(calendars.map(calendar => calendar.id));
    const selected = readJsonArray(row.selected_calendar_ids_json).filter(id => valid.has(id)).slice(0, MAX_CALENDARS);
    saveCalendars(householdId, calendars, selected, !!row.enabled && selected.length > 0);
    db.prepare('UPDATE google_calendar_connections SET last_error=NULL,last_attempt_at=?,updated_at=CURRENT_TIMESTAMP WHERE household_id=?')
      .run(new Date().toISOString(), householdId);
    notify(householdId);
    return settings(householdId);
  }

  function configure(householdId, selectedIds, enabled) {
    const row = rowFor(householdId);
    if (!row) throw new GoogleCalendarError('Connect Google Calendar before selecting calendars.', 409);
    const calendars = readJsonArray(row.calendars_json);
    if (typeof enabled !== 'boolean' || !Array.isArray(selectedIds) || selectedIds.length > MAX_CALENDARS || selectedIds.some(id => typeof id !== 'string' || !id || id.length > 1024) || new Set(selectedIds).size !== selectedIds.length) {
      throw new GoogleCalendarError('Choose valid Google calendars and whether to show them.', 400);
    }
    if (enabled && !selectedIds.length) throw new GoogleCalendarError('Select at least one calendar before enabling Google Calendar.', 400);
    if (selectedIds.some(id => !calendars.some(calendar => calendar.id === id))) throw new GoogleCalendarError('Select calendars from the available Google calendar list.', 400);
    saveCalendars(householdId, calendars, selectedIds, enabled);
    clearEvents(householdId);
    notify(householdId);
    return settings(householdId);
  }

  async function calendarEvents(householdId, calendar, from, to) {
    const cacheKey = `${householdId}:${calendar.id}:${from.toISOString()}:${to.toISOString()}`;
    const cached = eventsCache.get(cacheKey), now = Date.now();
    if (cached && now - cached.at < EVENT_CACHE_MS) return { events: cached.events, cached: true };
    if (eventLoads.has(cacheKey)) return eventLoads.get(cacheKey);
    const load = (async () => {
      const events = await listEvents(householdId, calendar, from, to);
      eventsCache.set(cacheKey, { events, at: Date.now() });
      if (eventsCache.size > 500) {
        const oldest = [...eventsCache].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
        oldest.forEach(([key]) => eventsCache.delete(key));
      }
      return { events, cached: false };
    })();
    eventLoads.set(cacheKey, load);
    try { return await load; } finally { eventLoads.delete(cacheKey); }
  }

  async function readEvents(householdId, from, to) {
    const row = rowFor(householdId);
    if (!row?.enabled) return { events: [], errors: [] };
    const calendars = readJsonArray(row.calendars_json), selected = new Set(readJsonArray(row.selected_calendar_ids_json));
    const chosen = calendars.filter(calendar => selected.has(calendar.id)).slice(0, MAX_CALENDARS);
    const events = [], errors = [];
    let loaded = false;
    for (const calendar of chosen) {
      const cacheKey = `${householdId}:${calendar.id}:${from.toISOString()}:${to.toISOString()}`;
      const previous = eventsCache.get(cacheKey);
      try {
        const result = await calendarEvents(householdId, calendar, from, to);
        events.push(...result.events);
        loaded ||= !result.cached;
      } catch {
        if (previous) events.push(...previous.events);
        errors.push({ calendar: calendar.name, message: `Could not load ${calendar.name} from Google Calendar. Check the connection and try again.` });
      }
    }
    if (loaded || errors.length) {
      const attemptedAt = new Date().toISOString();
      db.prepare(`UPDATE google_calendar_connections SET last_attempt_at=?,last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END,
        last_error=?,updated_at=CURRENT_TIMESTAMP WHERE household_id=?`)
        .run(attemptedAt, loaded ? 1 : 0, attemptedAt, errors.length ? 'Some Google calendars could not load. Check Settings → Integrations.' : null, householdId);
    }
    return { events, errors };
  }

  function disconnect(householdId) {
    db.prepare('DELETE FROM google_calendar_connections WHERE household_id=?').run(householdId);
    clearCache(householdId);
    notify(householdId);
  }

  function saveOAuthCredentials(householdId, input) {
    if (rowFor(householdId)) throw new GoogleCalendarError('Disconnect Google Calendar before changing its OAuth credentials.', 409);
    const clientId = typeof input?.clientId === 'string' ? input.clientId.trim() : '';
    const clientSecret = typeof input?.clientSecret === 'string' ? input.clientSecret.trim() : '';
    if (!clientId || clientId.length > 512 || clientSecret.length > 4096) {
      throw new GoogleCalendarError('Enter a Google OAuth client ID and a valid client secret.', 400);
    }
    keyBytes(key);
    const saved = savedOAuthSettings(householdId);
    if (!clientSecret && !saved) throw new GoogleCalendarError('Enter the Google OAuth client secret.', 400);
    const encryptedSecret = clientSecret ? sealClientSecret(clientSecret, key, householdId) : saved.client_secret;
    db.prepare(`INSERT INTO google_calendar_oauth_settings(household_id,client_id,client_secret)
      VALUES (?,?,?) ON CONFLICT(household_id) DO UPDATE SET client_id=excluded.client_id,
      client_secret=excluded.client_secret,updated_at=CURRENT_TIMESTAMP`).run(householdId, clientId, encryptedSecret);
    for (const [state, request] of pending) if (request.householdId === householdId) pending.delete(state);
    return settings(householdId);
  }

  function removeOAuthCredentials(householdId) {
    if (rowFor(householdId)) throw new GoogleCalendarError('Disconnect Google Calendar before removing its OAuth credentials.', 409);
    db.prepare('DELETE FROM google_calendar_oauth_settings WHERE household_id=?').run(householdId);
    for (const [state, request] of pending) if (request.householdId === householdId) pending.delete(state);
    return settings(householdId);
  }

  function callbackPage(result) {
    const nonce = crypto.randomBytes(18).toString('base64url');
    const message = JSON.stringify({ type: 'family-hub-google-calendar-oauth', status: result });
    const text = result === 'success' ? 'Google Calendar connected. Return to Family Hub.'
      : result === 'partial' ? 'Google Calendar connected, but its calendar list needs a refresh. Return to Family Hub.'
        : result === 'cancelled' ? 'Google Calendar connection was cancelled. Return to Family Hub.'
          : 'Google Calendar could not connect. Return to Family Hub and try again.';
    return {
      nonce,
      html: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google Calendar</title><p>${text}</p><a href="/">Return to Family Hub</a><script nonce="${nonce}">if(window.opener){window.opener.postMessage(${message},location.origin);window.close()}</script></html>`,
    };
  }

  return { settings, begin, complete, callbackPage, refreshCatalog, configure, readEvents, disconnect, saveOAuthCredentials, removeOAuthCredentials };
}

function route(work) {
  return (req, res, next) => Promise.resolve().then(() => work(req, res)).catch(error => {
    if (error instanceof GoogleCalendarError) res.status(error.status).json({ error: error.message });
    else next(error);
  });
}

/** Mount the OAuth callback before the normal API session middleware. State binds it to an adult session. */
export function mountGoogleCalendarCallback(app, connector) {
  app.get('/api/integrations/google-calendar/callback', route(async (req, res) => {
    const result = await connector.complete(req.query);
    const page = connector.callbackPage(result);
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${page.nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    }).type('html').send(page.html);
  }));
}

/** Mount Google Calendar settings endpoints after authentication and CSRF checks. */
export function mountGoogleCalendar(app, connector) {
  app.get('/api/integrations/google-calendar', requireAdult, route((req, res) => res.json(connector.settings(req.auth.household_id))));
  app.put('/api/integrations/google-calendar/credentials', requireAdult, route((req, res) => res.json(connector.saveOAuthCredentials(req.auth.household_id, req.body))));
  app.delete('/api/integrations/google-calendar/credentials', requireAdult, route((req, res) => res.json(connector.removeOAuthCredentials(req.auth.household_id))));
  app.post('/api/integrations/google-calendar/connect', requireAdult, route((req, res) => res.json(connector.begin(req.auth.household_id, req.auth))));
  app.post('/api/integrations/google-calendar/calendars', requireAdult, route((req, res) => res.json(connector.configure(req.auth.household_id, req.body.selectedCalendarIds, req.body.enabled))));
  app.post('/api/integrations/google-calendar/refresh', requireAdult, route(async (req, res) => res.json(await connector.refreshCatalog(req.auth.household_id))));
  app.delete('/api/integrations/google-calendar', requireAdult, route((req, res) => { connector.disconnect(req.auth.household_id); res.status(204).end(); }));
}
