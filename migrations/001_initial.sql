PRAGMA foreign_keys = ON;

CREATE TABLE households (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('adult','child')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(household_id,email)
);
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('user','device')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE pairing_codes (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE google_accounts (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  email TEXT,
  encrypted_tokens TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE google_calendars (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES google_accounts(id) ON DELETE CASCADE,
  google_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  selected INTEGER NOT NULL DEFAULT 1,
  UNIQUE(account_id,google_id)
);
CREATE TABLE local_reminders (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE groceries (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  quantity TEXT,
  checked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE grocery_budgets (
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
  PRIMARY KEY(household_id,month)
);
CREATE TABLE grocery_trips (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
  store TEXT,
  occurred_on TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE routines (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  days TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE routine_completions (
  routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  completed_on TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(routine_id,completed_on)
);
CREATE TABLE chores (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  recurrence TEXT NOT NULL DEFAULT 'once' CHECK(recurrence IN ('once','daily','weekly')),
  due_on TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE chore_completions (
  chore_id INTEGER NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(chore_id,period_key)
);
CREATE TABLE family_targets (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  target TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX trips_household_date ON grocery_trips(household_id,occurred_on);
