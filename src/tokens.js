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
  const adjusted = db.prepare('SELECT COALESCE(SUM(quarters),0) quarters FROM token_adjustments WHERE household_id=? AND user_id=?').get(householdId, userId).quarters;
  return earned - withdrawn + adjusted;
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

/** Choose the child who receives a chore reward. Assigned chores keep their assignee. */
function rewardChildId(db, chore, userId) {
  if (chore.assignee_id) return chore.assignee_id;
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id < 1) throw new TokenError('Choose the child who earned this reward.');
  const child = db.prepare("SELECT id FROM users WHERE id=? AND household_id=? AND role='child'").get(id, chore.household_id);
  if (!child) throw new TokenError('Choose a child in this household.', 404);
  return child.id;
}

/** Record the reward for a completed chore. A repeat completion restores the same reward. */
export function postChoreEarning(db, chore, periodKey, userId) {
  if (!chore?.reward_quarters) return;
  const recipient = rewardChildId(db, chore, userId);
  const existing = db.prepare('SELECT id,reversed_at FROM token_earnings WHERE chore_id=? AND period_key=?').get(chore.id, periodKey);
  if (existing?.reversed_at) db.prepare('UPDATE token_earnings SET reversed_at=NULL,user_id=? WHERE id=?').run(recipient, existing.id);
  else if (!existing) db.prepare('INSERT INTO token_earnings(household_id,user_id,chore_id,period_key,quarters) VALUES (?,?,?,?,?)').run(chore.household_id, recipient, chore.id, periodKey, chore.reward_quarters);
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
      COALESCE((SELECT SUM(quarters) FROM token_earnings te WHERE te.household_id=u.household_id AND te.user_id=u.id AND te.reversed_at IS NULL),0) total_quarters,
      COALESCE((SELECT SUM(quarters) FROM token_withdrawals tw WHERE tw.household_id=u.household_id AND tw.user_id=u.id),0) withdrawn_quarters,
      COALESCE((SELECT SUM(quarters) FROM token_adjustments ta WHERE ta.household_id=u.household_id AND ta.user_id=u.id),0) adjusted_quarters
    FROM users u WHERE u.household_id=? AND u.role='child' ORDER BY total_quarters DESC,u.name`).all(householdId).map((person) => {
    const available = person.total_quarters - person.withdrawn_quarters + person.adjusted_quarters;
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
export function tokenLedger(db, householdId, userId, { canManage = false } = {}) {
  ensureTokenLedger(db, householdId);
  const household = db.prepare('SELECT timezone FROM households WHERE id=?').get(householdId);
  const person = personBalances(db, householdId).find((item) => item.id === Number(userId));
  if (!person) throw new TokenError('Choose a child in this household.', 404);
  const earnings = db.prepare(`SELECT te.id,te.period_key,te.quarters,te.reversed_at,te.created_at,c.title
    FROM token_earnings te LEFT JOIN chores c ON c.id=te.chore_id
    WHERE te.household_id=? AND te.user_id=?`).all(householdId, person.id)
    .sort((a, b) => earnedOn(a.period_key, a.created_at, household.timezone).localeCompare(earnedOn(b.period_key, b.created_at, household.timezone)) || a.id - b.id);
  let remaining = db.prepare('SELECT COALESCE(SUM(quarters),0) quarters FROM token_withdrawals WHERE household_id=? AND user_id=?').get(householdId, person.id).quarters;
  const adjustments = db.prepare('SELECT * FROM token_adjustments WHERE household_id=? AND user_id=?').all(householdId, person.id);
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
  const reversedWithdrawals = new Map(adjustments.filter(row => row.withdrawal_id !== null).map(row => [row.withdrawal_id, row.id]));
  const reversedAdjustments = new Map(adjustments.filter(row => row.adjustment_id !== null).map(row => [row.adjustment_id, row.id]));
  const events = [
    ...earnings.filter(row => !row.reversed_at).map(row => ({ sort: earnedOn(row.period_key, row.created_at, household.timezone), time: '', order: 0, id: row.id, type: 'earning', date: ledgerDate(row.period_key, row.created_at, household.timezone), description: row.title || 'Removed chore', change: row.quarters, earned: row.quarters, canReverse: false })),
    ...withdrawals.map(row => ({ sort: earnedOn('', row.created_at, household.timezone), time: utcTimestamp(row.created_at), order: 1, id: row.id, type: 'withdrawal', date: row.date, description: row.label, change: -row.quarters, earned: 0, reversed: reversedWithdrawals.has(row.id), reversalId: reversedWithdrawals.get(row.id) || null, canReverse: canManage && !reversedWithdrawals.has(row.id) && row.label !== 'Earlier rewards marked withdrawn' })),
    ...adjustments.map(row => ({ sort: earnedOn('', row.created_at, household.timezone), time: utcTimestamp(row.created_at), order: 2, id: row.id, type: row.kind === 'manual' ? 'adjustment' : 'reversal', date: ledgerDate('', row.created_at, household.timezone), description: row.kind === 'reversal' ? `Reversal of ${row.withdrawal_id !== null ? 'withdrawal' : 'adjustment'} #${row.withdrawal_id ?? row.adjustment_id}` : 'Adult balance adjustment', change: row.quarters, earned: 0, reversed: reversedAdjustments.has(row.id), reversalId: reversedAdjustments.get(row.id) || null, canReverse: canManage && row.kind === 'manual' && !reversedAdjustments.has(row.id), ...(canManage ? { reason: row.reason, actorName: row.actor_name } : {}) })),
  ].sort((a, b) => a.sort.localeCompare(b.sort) || a.time.localeCompare(b.time) || a.order - b.order || a.id - b.id);
  let availableQuartersRunning = 0, totalQuartersRunning = 0;
  const lines = events.map(event => {
    totalQuartersRunning += event.earned;
    availableQuartersRunning += event.change;
    return { id: event.id, type: event.type, date: event.date, description: event.description, amount: `${event.change < 0 ? '-' : ''}${formatQuarters(Math.abs(event.change))}`, quarters: event.change, kind: event.change < 0 ? 'debit' : 'credit', available: formatQuarters(availableQuartersRunning), total: formatQuarters(totalQuartersRunning), canReverse: !!event.canReverse, reversed: !!event.reversed, reversalId: event.reversalId || null, ...(canManage && event.reason ? { reason: event.reason, actorName: event.actorName } : {}) };
  });
  return { person, entries, withdrawals: withdrawals.map(({ date, label, amount }) => ({ date, label, amount })), lines, managementAllowed: canManage };

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
    const inserted = db.prepare(`INSERT INTO token_withdrawals(household_id,user_id,quarters,copper,silver,gold,request_id,kind,created_at)
      VALUES (?,?,?,?,?,?,?,'dispense',?)`).run(householdId, person.id, quarters, counts.copper, counts.silver, counts.gold, id, nextTokenTimestamp(db, householdId, person.id));
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

/** Normalize SQLite and ISO timestamps for chronological ledger lines. */
function utcTimestamp(value) {
  const stamp = String(value).replace(' ', 'T');
  return new Date(stamp.endsWith('Z') ? stamp : `${stamp}Z`).toISOString();
}

// Corrections and withdrawals use separate tables. Keep their timestamps ordered
// even when two transactions finish within the same clock millisecond.
function nextTokenTimestamp(db, householdId, userId) {
  const rows = db.prepare(`SELECT created_at FROM token_withdrawals WHERE household_id=? AND user_id=?
    UNION ALL SELECT created_at FROM token_adjustments WHERE household_id=? AND user_id=?`).all(householdId, userId, householdId, userId);
  const latest = rows.reduce((stamp, row) => Math.max(stamp, Date.parse(utcTimestamp(row.created_at))), 0);
  return new Date(Math.max(Date.now(), latest + 1)).toISOString();
}

function correctionValues({ userId, actorId, reason, requestId }) {
  if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(actorId) || actorId < 1) throw new TokenError('Choose a child and sign in as an adult.');
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 200) throw new TokenError('Enter a reason of 1 to 200 characters.');
  return { userId, actorId, reason: reason.trim(), requestId: textRequest(requestId) };
}

/** Record an adult correction atomically, preserving the original ledger history. */
function recordCorrection(db, input, kind) {
  const values = correctionValues(input), { householdId } = input;
  if (kind === 'manual' && (!Number.isSafeInteger(input.quarters) || input.quarters === 0 || Math.abs(input.quarters) > 40000)) throw new TokenError('Use a non-zero amount in $0.25 increments, up to $10,000.');
  if (kind === 'reversal' && (!['withdrawal', 'adjustment'].includes(input.transactionType) || !Number.isSafeInteger(input.transactionId) || input.transactionId < 1)) throw new TokenError('Choose a valid transaction to reverse.');
  ensureTokenLedger(db, householdId);
  const change = db.transaction(() => {
    const actor = db.prepare("SELECT id,name FROM users WHERE id=? AND household_id=? AND role='adult'").get(values.actorId, householdId);
    if (!actor) throw new TokenError('An adult account is required.', 403);
    const child = db.prepare("SELECT id FROM users WHERE id=? AND household_id=? AND role='child'").get(values.userId, householdId);
    if (!child) throw new TokenError('Choose a child in this household.', 404);
    const withdrawalId = kind === 'reversal' && input.transactionType === 'withdrawal' ? input.transactionId : null;
    const adjustmentId = kind === 'reversal' && input.transactionType === 'adjustment' ? input.transactionId : null;
    const existing = db.prepare('SELECT * FROM token_adjustments WHERE household_id=? AND request_id=?').get(householdId, values.requestId);
    if (existing) {
      if (existing.user_id !== values.userId || existing.kind !== kind || existing.reason !== values.reason || existing.withdrawal_id !== withdrawalId || existing.adjustment_id !== adjustmentId || (kind === 'manual' && existing.quarters !== input.quarters)) throw new TokenError('This correction request was already used for a different transaction.', 409);
      return { replayed: true, transactionId: existing.id };
    }
    let quarters = input.quarters;
    if (kind === 'reversal') {
      const original = withdrawalId !== null
        ? db.prepare('SELECT quarters,kind FROM token_withdrawals WHERE id=? AND household_id=? AND user_id=?').get(withdrawalId, householdId, values.userId)
        : db.prepare('SELECT quarters,kind FROM token_adjustments WHERE id=? AND household_id=? AND user_id=?').get(adjustmentId, householdId, values.userId);
      if (!original) throw new TokenError('Transaction not found for this child.', 404);
      if (original.kind !== (withdrawalId !== null ? 'dispense' : 'manual')) throw new TokenError('Only token withdrawals and manual adjustments can be reversed.', 409);
      const reversed = withdrawalId !== null
        ? db.prepare('SELECT id FROM token_adjustments WHERE withdrawal_id=?').get(withdrawalId)
        : db.prepare('SELECT id FROM token_adjustments WHERE adjustment_id=?').get(adjustmentId);
      if (reversed) throw new TokenError('This transaction has already been reversed.', 409);
      quarters = withdrawalId !== null ? original.quarters : -original.quarters;
    }
    if (availableQuarters(db, householdId, values.userId) + quarters < 0) throw new TokenError('This would make the available balance negative. To undo a withdrawal, select Reverse on that ledger line instead of subtracting again.', 409);
    const result = db.prepare(`INSERT INTO token_adjustments(household_id,user_id,actor_id,actor_name,quarters,reason,kind,withdrawal_id,adjustment_id,request_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(householdId, values.userId, actor.id, actor.name, quarters, values.reason, kind, withdrawalId, adjustmentId, values.requestId, nextTokenTimestamp(db, householdId, values.userId));
    return { replayed: false, transactionId: Number(result.lastInsertRowid) };
  });
  const result = change.immediate();
  return { ...result, person: personBalances(db, householdId).find(person => person.id === values.userId) };
}

/** Add or subtract available funds without changing chore-earned totals. */
export function adjustTokenBalance(db, input) { return recordCorrection(db, input, 'manual'); }

/** Restore a withdrawal or offset a manual adjustment once, without deleting it. */
export function reverseTokenTransaction(db, input) { return recordCorrection(db, input, 'reversal'); }
