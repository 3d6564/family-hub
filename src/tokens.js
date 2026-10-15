import { localDate } from './domain.js';

export const tokenValues = { copper: 1, silver: 2, gold: 4 };

/** Raise a token error with a status the API can return. */
export class TokenError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Format quarter-dollar units as dollars. */
export function formatQuarters(quarters) {
  return `$${(quarters / 4).toFixed(2)}`;
}

function shiftDate(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function earnedOn(periodKey, completedAt, timezone) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(periodKey)) return periodKey;
  const stamp = String(completedAt || '').includes('T') ? completedAt : `${completedAt || ''}`.replace(' ', 'T');
  const date = new Date(stamp.endsWith('Z') ? stamp : `${stamp}Z`);
  return Number.isNaN(date.getTime()) ? '0000-01-01' : localDate(date, timezone);
}

function availableQuarters(db, householdId, userId) {
  const earned = db.prepare('SELECT COALESCE(SUM(quarters),0) quarters FROM token_earnings WHERE household_id=? AND user_id=? AND reversed_at IS NULL').get(householdId, userId).quarters;
  const withdrawn = db.prepare('SELECT COALESCE(SUM(quarters),0) quarters FROM token_withdrawals WHERE household_id=? AND user_id=?').get(householdId, userId).quarters;
  return earned - withdrawn;
}

/** Post missing chore rewards and settle earnings from before yesterday once. */
export function ensureTokenLedger(db, householdId, now = new Date()) {
  const household = db.prepare('SELECT id,timezone,token_opened FROM households WHERE id=?').get(householdId);
  if (!household) return;
  const sync = db.transaction(() => {
    db.prepare(`INSERT INTO token_earnings(household_id,user_id,chore_id,period_key,quarters,created_at)
      SELECT c.household_id,c.assignee_id,c.id,cc.period_key,c.reward_quarters,cc.completed_at
      FROM chore_completions cc JOIN chores c ON c.id=cc.chore_id
      WHERE c.household_id=? AND c.assignee_id IS NOT NULL AND c.reward_quarters>0
      AND NOT EXISTS (SELECT 1 FROM token_earnings te WHERE te.chore_id=c.id AND te.period_key=cc.period_key)`).run(householdId);
    const opened = db.prepare('SELECT token_opened FROM households WHERE id=?').get(householdId).token_opened;
    if (opened) return;
    const yesterday = shiftDate(localDate(now, household.timezone), -1);
    const earnings = db.prepare(`SELECT te.id,te.user_id,te.quarters,te.period_key,te.created_at
      FROM token_earnings te WHERE te.household_id=? AND te.reversed_at IS NULL`).all(householdId);
    const settled = new Map();
    for (const earning of earnings) {
      if (earnedOn(earning.period_key, earning.created_at, household.timezone) >= yesterday) continue;
      settled.set(earning.user_id, (settled.get(earning.user_id) || 0) + earning.quarters);
    }
    const insert = db.prepare(`INSERT INTO token_withdrawals(household_id,user_id,quarters,request_id,kind)
      VALUES (?,?,?,?, 'opening')`);
    for (const [userId, quarters] of settled) {
      if (quarters > 0) insert.run(householdId, userId, quarters, `opening:${householdId}:${userId}`);
    }
    db.prepare('UPDATE households SET token_opened=1 WHERE id=?').run(householdId);
  });
  sync.immediate();
}

/** Record the reward for a completed assigned chore. A repeat completion restores the same reward. */
export function postChoreEarning(db, chore, periodKey) {
  if (!chore?.assignee_id || !chore.reward_quarters) return;
  const existing = db.prepare('SELECT id,reversed_at FROM token_earnings WHERE chore_id=? AND period_key=?').get(chore.id, periodKey);
  if (existing?.reversed_at) db.prepare('UPDATE token_earnings SET reversed_at=NULL WHERE id=?').run(existing.id);
  else if (!existing) db.prepare('INSERT INTO token_earnings(household_id,user_id,chore_id,period_key,quarters) VALUES (?,?,?,?,?)').run(chore.household_id, chore.assignee_id, chore.id, periodKey, chore.reward_quarters);
}

/** Reverse an unpaid reward. A withdrawn reward cannot be unchecked. */
export function reverseChoreEarning(db, chore, periodKey) {
  const earning = db.prepare('SELECT id,quarters,user_id,household_id FROM token_earnings WHERE chore_id=? AND period_key=? AND reversed_at IS NULL').get(chore.id, periodKey);
  if (!earning) return;
  if (availableQuarters(db, earning.household_id, earning.user_id) < earning.quarters) throw new TokenError('This reward was already withdrawn. It cannot be unchecked.', 409);
  db.prepare('UPDATE token_earnings SET reversed_at=CURRENT_TIMESTAMP WHERE id=? AND reversed_at IS NULL').run(earning.id);
}

function personBalances(db, householdId) {
  return db.prepare(`SELECT u.id,u.name,
      COALESCE((SELECT SUM(quarters) FROM token_earnings te WHERE te.user_id=u.id AND te.reversed_at IS NULL),0) total_quarters,
      COALESCE((SELECT SUM(quarters) FROM token_withdrawals tw WHERE tw.user_id=u.id),0) withdrawn_quarters
    FROM users u WHERE u.household_id=? AND u.role='child' ORDER BY total_quarters DESC,u.name`).all(householdId).map((person) => {
    const available = person.total_quarters - person.withdrawn_quarters;
    return { id: person.id, name: person.name, totalQuarters: person.total_quarters, availableQuarters: available, total: formatQuarters(person.total_quarters), available: formatQuarters(available) };
  });
}

function ledgerDate(periodKey, completedAt, timezone) {
  const key = earnedOn(periodKey, completedAt, timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || key === '0000-01-01') return 'Unknown day';
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`));
}

function withdrawalLabel(row) {
  if (row.kind === 'opening') return 'Earlier rewards marked withdrawn';
  const parts = [];
  if (row.gold) parts.push(`${row.gold} gold`);
  if (row.silver) parts.push(`${row.silver} silver`);
  if (row.copper) parts.push(`${row.copper} copper`);
  return parts.length ? `Dispensed ${parts.join(', ')}` : 'Dispensed tokens';
}

/** Return the chore lines and withdrawals that make up one child's balances. */
export function tokenLedger(db, householdId, userId) {
  ensureTokenLedger(db, householdId);
  const household = db.prepare('SELECT timezone FROM households WHERE id=?').get(householdId);
  const person = personBalances(db, householdId).find((item) => item.id === Number(userId));
  if (!person) throw new TokenError('Choose a child in this household.', 404);
  const earnings = db.prepare(`SELECT te.id,te.period_key,te.quarters,te.reversed_at,te.created_at,c.title
    FROM token_earnings te LEFT JOIN chores c ON c.id=te.chore_id
    WHERE te.household_id=? AND te.user_id=?`).all(householdId, person.id)
    .sort((a, b) => earnedOn(a.period_key, a.created_at, household.timezone).localeCompare(earnedOn(b.period_key, b.created_at, household.timezone)) || a.id - b.id);
  let remaining = db.prepare('SELECT COALESCE(SUM(quarters),0) quarters FROM token_withdrawals WHERE household_id=? AND user_id=?').get(householdId, person.id).quarters;
  const entries = earnings.map((row) => {
    const date = ledgerDate(row.period_key, row.created_at, household.timezone);
    if (row.reversed_at) return { date, title: row.title || 'Removed chore', amount: formatQuarters(row.quarters), status: 'Reversed', available: formatQuarters(0) };
    const taken = Math.min(remaining, row.quarters);
    remaining -= taken;
    const available = row.quarters - taken;
    const status = available === row.quarters ? 'Available' : available ? 'Partly available' : 'Withdrawn';
    return { date, title: row.title || 'Removed chore', amount: formatQuarters(row.quarters), status, available: formatQuarters(available) };
  });
  const withdrawals = db.prepare('SELECT id,quarters,copper,silver,gold,kind,created_at FROM token_withdrawals WHERE household_id=? AND user_id=? ORDER BY created_at,id').all(householdId, person.id)
    .map((row) => ({ date: ledgerDate('', row.created_at, household.timezone), label: withdrawalLabel(row), amount: formatQuarters(row.quarters), quarters: row.quarters, id: row.id, created_at: row.created_at }));
  const events = [
    ...earnings.filter((row) => !row.reversed_at).map((row) => ({ sort: earnedOn(row.period_key, row.created_at, household.timezone), order: 0, id: row.id, date: ledgerDate(row.period_key, row.created_at, household.timezone), description: row.title || 'Removed chore', change: row.quarters })),
    ...withdrawals.map((row) => ({ sort: earnedOn('', row.created_at, household.timezone), order: 1, id: row.id, date: row.date, description: row.label, change: -row.quarters })),
  ].sort((a, b) => a.sort.localeCompare(b.sort) || a.order - b.order || a.id - b.id);
  let availableQuartersRunning = 0, totalQuartersRunning = 0;
  const lines = events.map((event) => {
    if (event.change > 0) totalQuartersRunning += event.change;
    availableQuartersRunning += event.change;
    return { date: event.date, description: event.description, amount: `${event.change < 0 ? '-' : ''}${formatQuarters(Math.abs(event.change))}`, kind: event.change < 0 ? 'debit' : 'credit', available: formatQuarters(availableQuartersRunning), total: formatQuarters(totalQuartersRunning) };
  });
  return { person, entries, withdrawals: withdrawals.map(({ date, label, amount }) => ({ date, label, amount })), lines };
}

/** Return the leaderboard and withdrawable balances for the household. */
export function tokenStatus(db, householdId) {
  ensureTokenLedger(db, householdId);
  return {
    people: personBalances(db, householdId),
    tokens: [
      { id: 'copper', name: 'Copper', quarters: 1, amount: formatQuarters(1) },
      { id: 'silver', name: 'Silver', quarters: 2, amount: formatQuarters(2) },
      { id: 'gold', name: 'Gold', quarters: 4, amount: formatQuarters(4) },
    ],
  };
}

function tokenCount(value, name) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 40) throw new TokenError(`Choose a whole number of ${name} tokens from 0 to 40.`);
  return value;
}

/** Withdraw copper, silver, and gold tokens without reducing the earned total. */
export function withdrawTokens(db, { householdId, userId, copper, silver, gold, requestId }) {
  ensureTokenLedger(db, householdId);
  const id = textRequest(requestId);
  const counts = { copper: tokenCount(copper, 'copper'), silver: tokenCount(silver, 'silver'), gold: tokenCount(gold, 'gold') };
  const quarters = counts.copper + counts.silver * 2 + counts.gold * 4;
  if (!quarters) throw new TokenError('Choose at least one token.');
  const person = db.prepare("SELECT id,name FROM users WHERE id=? AND household_id=? AND role='child'").get(userId, householdId);
  if (!person) throw new TokenError('Choose a child in this household.');
  const dispense = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM token_withdrawals WHERE household_id=? AND request_id=?').get(householdId, id);
    if (existing) {
      if (existing.user_id !== person.id || existing.quarters !== quarters || existing.copper !== counts.copper || existing.silver !== counts.silver || existing.gold !== counts.gold) throw new TokenError('This withdrawal was already used for a different amount.', 409);
      return { replayed: true, withdrawal: existing };
    }
    const available = availableQuarters(db, householdId, person.id);
    if (quarters > available) throw new TokenError(`Only ${formatQuarters(available)} is available to withdraw.`);
    const inserted = db.prepare(`INSERT INTO token_withdrawals(household_id,user_id,quarters,copper,silver,gold,request_id,kind)
      VALUES (?,?,?,?,?,?,?, 'dispense')`).run(householdId, person.id, quarters, counts.copper, counts.silver, counts.gold, id);
    return { replayed: false, withdrawal: db.prepare('SELECT * FROM token_withdrawals WHERE id=?').get(inserted.lastInsertRowid) };
  });
  const result = dispense.immediate();
  const updated = personBalances(db, householdId).find((item) => item.id === person.id);
  return {
    replayed: result.replayed,
    dispensed: { ...counts, quarters, amount: formatQuarters(quarters) },
    person: updated,
  };
}

function textRequest(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) throw new TokenError('The withdrawal request is invalid. Try again.');
  return value;
}
