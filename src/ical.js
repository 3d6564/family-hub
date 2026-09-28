import dns from 'node:dns/promises';
import net from 'node:net';
import ical from 'node-ical';

export const MAX_FEED_URL_LENGTH = 4096;
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

function blockedAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase().split('%')[0];
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value) || value.startsWith('ff') || value.startsWith('::ffff:');
  }
  return true;
}

/** Validate feed URL syntax and the allowed transport. */
export function validateFeedUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_FEED_URL_LENGTH) return { valid: false, error: `iCal URL is required and must be ${MAX_FEED_URL_LENGTH} characters or fewer.` };
  try {
    const url = new URL(value);
    if (url.username || url.password) return { valid: false, error: 'iCal URL must not contain a username or password.' };
    const localHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || (net.isIP(url.hostname) && blockedAddress(url.hostname)));
    if (url.protocol !== 'https:' && !localHttp) return { valid: false, error: 'iCal URL must use HTTPS. HTTP is allowed only for localhost or private LAN addresses.' };
    return { valid: true, url: url.href };
  } catch {
    return { valid: false, error: 'iCal URL is invalid.' };
  }
}

/** Reject DNS targets that could expose services on the application network. */
export async function assertSafeRemoteUrl(value, lookup = dns.lookup) {
  const url = new URL(value);
  const addresses = net.isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => blockedAddress(address))) throw Object.assign(new Error('Calendar feed address is not allowed.'), { code: 'UNSAFE_FEED_ADDRESS' });
}

async function responseText(response) {
  if (!response.ok) throw new Error(`Calendar feed returned HTTP ${response.status}.`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_FEED_BYTES) throw new Error('Calendar feed is larger than 5 MB.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FEED_BYTES) { await reader.cancel(); throw new Error('Calendar feed is larger than 5 MB.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function eventValue(event, start, end, id, feed) {
  const allDay = event.datetype === 'date';
  return {
    id: `${feed.id}:${id}`,
    title: event.summary || '(Untitled)',
    description: event.description || null,
    location: event.location || null,
    start: allDay ? { date: start.toISOString().slice(0, 10) } : { dateTime: start.toISOString() },
    end: allDay ? { date: end.toISOString().slice(0, 10) } : { dateTime: end.toISOString() },
    color: feed.color,
    calendar: feed.name,
    source: 'ical'
  };
}

/** Parse VEVENT records and expand recurrence only inside the requested range. */
export function parseFeedEvents(data, feed, from, to, parser = ical.sync.parseICS) {
  const parsed = parser(data), events = [];
  for (const item of Object.values(parsed)) {
    if (item?.type !== 'VEVENT' || !item.start) continue;
    const duration = new Date(item.end || item.start) - new Date(item.start);
    const starts = item.rrule ? item.rrule.between(from, to, true) : [new Date(item.start)];
    for (const occurrence of starts) {
      const key = occurrence.toISOString().slice(0, 10);
      if (item.exdate && Object.values(item.exdate).some((date) => new Date(date).getTime() === occurrence.getTime())) continue;
      const override = item.recurrences?.[key] || item;
      const start = override === item ? occurrence : new Date(override.start);
      const end = override === item ? new Date(occurrence.getTime() + duration) : new Date(override.end || override.start);
      if (end > from && start < to) events.push(eventValue(override, start, end, `${item.uid || 'event'}:${start.toISOString()}`, feed));
    }
  }
  return events;
}

/** Fetch one feed after production DNS checks and return normalized events. */
export async function fetchFeedEvents(feed, from, to, options = {}) {
  if ((options.production ?? process.env.NODE_ENV === 'production')) await assertSafeRemoteUrl(feed.url, options.lookup);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || FETCH_TIMEOUT_MS);
  try {
    const response = await (options.fetch || fetch)(feed.url, { signal: controller.signal, redirect: 'error', headers: { Accept: 'text/calendar' } });
    return parseFeedEvents(await responseText(response), feed, from, to, options.parser);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Calendar feed timed out after 10 seconds.');
    throw error;
  } finally { clearTimeout(timer); }
}
