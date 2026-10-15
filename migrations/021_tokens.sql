ALTER TABLE households ADD COLUMN token_opened INTEGER NOT NULL DEFAULT 0 CHECK(token_opened IN (0,1));

CREATE TABLE token_earnings (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chore_id INTEGER REFERENCES chores(id) ON DELETE SET NULL,
  period_key TEXT NOT NULL,
  quarters INTEGER NOT NULL CHECK(quarters > 0),
  reversed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX token_earnings_completion ON token_earnings(chore_id, period_key) WHERE chore_id IS NOT NULL;
CREATE INDEX token_earnings_user ON token_earnings(household_id, user_id);

CREATE TABLE token_withdrawals (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quarters INTEGER NOT NULL CHECK(quarters > 0),
  copper INTEGER NOT NULL DEFAULT 0 CHECK(copper >= 0),
  silver INTEGER NOT NULL DEFAULT 0 CHECK(silver >= 0),
  gold INTEGER NOT NULL DEFAULT 0 CHECK(gold >= 0),
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'dispense' CHECK(kind IN ('dispense','opening')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(household_id, request_id),
  CHECK(kind = 'opening' OR copper + silver * 2 + gold * 4 = quarters)
);
CREATE INDEX token_withdrawals_user ON token_withdrawals(household_id, user_id);
