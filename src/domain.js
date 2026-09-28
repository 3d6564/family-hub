/** Return YYYY-MM in a named timezone, including exact month boundaries. */
export function monthKey(date, timezone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' }).formatToParts(date);
  return `${parts.find((p) => p.type === 'year').value}-${parts.find((p) => p.type === 'month').value}`;
}

export function localDate(date, timezone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return ['year', 'month', 'day'].map((type) => parts.find((p) => p.type === type).value).join('-');
}

/** Compute the completion key that makes recurring chores reset by period. */
export function chorePeriod(recurrence, date, timezone = 'UTC') {
  const day = localDate(date, timezone);
  if (recurrence === 'once') return 'once';
  if (recurrence === 'daily') return day;
  const noon = new Date(`${day}T12:00:00Z`);
  const monday = new Date(noon);
  monday.setUTCDate(noon.getUTCDate() - ((noon.getUTCDay() + 6) % 7));
  return localDate(monday, 'UTC');
}

/** Return whether a chore is due on the supplied local date. */
export function isChoreDue(chore, date, timezone = 'UTC') {
  const today = localDate(date, timezone);
  if (today < chore.due_on) return false;
  if (chore.recurrence === 'once') return today === chore.due_on;
  if (chore.recurrence === 'daily') return true;
  const weekday = (value) => new Date(`${value}T12:00:00Z`).getUTCDay();
  return weekday(today) === weekday(chore.due_on);
}

export function budgetSummary(db, householdId, month) {
  const budget = db.prepare('SELECT amount_cents FROM grocery_budgets WHERE household_id=? AND month=?').get(householdId, month)?.amount_cents || 0;
  const spent = db.prepare("SELECT COALESCE(SUM(amount_cents),0) total FROM grocery_trips WHERE household_id=? AND substr(occurred_on,1,7)=?").get(householdId, month).total;
  return { month, budgetCents: budget, spentCents: spent, remainingCents: budget - spent };
}
