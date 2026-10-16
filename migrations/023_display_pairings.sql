CREATE TABLE display_pairings (
  id INTEGER PRIMARY KEY,
  user_code_hash TEXT NOT NULL UNIQUE,
  device_secret_hash TEXT NOT NULL UNIQUE,
  household_id INTEGER REFERENCES households(id) ON DELETE CASCADE,
  device_name TEXT,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
