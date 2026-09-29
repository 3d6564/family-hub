/** Return YYYY-MM in a named timezone, including exact month boundaries. */
export function monthKey(date, timezone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' }).formatToParts(date);
  return `${parts.find((p) => p.type === 'year').value}-${parts.find((p) => p.type === 'month').value}`;
}

export function localDate(date, timezone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return ['year', 'month', 'day'].map((type) => parts.find((p) => p.type === type).value).join('-');
}

/** Convert day names, numbers, and ranges into a sorted weekday list. */
export function parseDays(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const names = { sun: 0, su: 0, s: 0, mon: 1, mo: 1, m: 1, tue: 2, tu: 2, t: 2, wed: 3, we: 3, w: 3, thu: 4, th: 4, r: 4, fri: 5, fr: 5, f: 5, sat: 6, sa: 6 };
  const day = (token) => /^\d$/.test(token) ? +token : names[token];
  const values = new Set();
  for (const part of value.toLowerCase().replace(/\s/g, '').split(',')) {
    const range = part.split('-'); if (range.length > 2) return null;
    const first = day(range[0]), last = range[1] === undefined ? first : day(range[1]);
    if (!Number.isInteger(first) || !Number.isInteger(last) || first > last) return null;
    for (let current = first; current <= last; current++) values.add(current);
  }
  return values.size ? [...values].sort().join(',') : null;
}

/** Return the completion key. Scheduled chores reset on each local day. */
export function chorePeriod(recurrence, date, timezone = 'UTC') {
  if (recurrence === 'once') return 'once';
  return localDate(date, timezone);
}

/** Return whether a chore is due on the supplied local date. */
export function isChoreDue(chore, date, timezone = 'UTC') {
  const today = localDate(date, timezone);
  if (chore.recurrence === 'once') return true;
  if (chore.days) return chore.days.split(',').includes(String(new Date(`${today}T12:00:00Z`).getUTCDay()));
  if (today < chore.due_on) return false;
  if (chore.recurrence === 'daily') return true;
  const weekday = (value) => new Date(`${value}T12:00:00Z`).getUTCDay();
  return weekday(today) === weekday(chore.due_on);
}
