CREATE TABLE token_adjustments (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  quarters INTEGER NOT NULL CHECK(quarters != 0),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK(kind IN ('manual','reversal')),
  withdrawal_id INTEGER REFERENCES token_withdrawals(id),
  adjustment_id INTEGER REFERENCES token_adjustments(id),
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(household_id,request_id),
  CHECK((kind='manual' AND withdrawal_id IS NULL AND adjustment_id IS NULL)
    OR (kind='reversal' AND ((withdrawal_id IS NOT NULL AND adjustment_id IS NULL)
      OR (withdrawal_id IS NULL AND adjustment_id IS NOT NULL))))
);
CREATE INDEX token_adjustments_user ON token_adjustments(household_id,user_id);
CREATE UNIQUE INDEX token_adjustments_reverse_withdrawal ON token_adjustments(withdrawal_id) WHERE withdrawal_id IS NOT NULL;
CREATE UNIQUE INDEX token_adjustments_reverse_adjustment ON token_adjustments(adjustment_id) WHERE adjustment_id IS NOT NULL;
