CREATE TABLE google_calendar_connections (
  household_id INTEGER PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  credentials TEXT NOT NULL,
  calendars_json TEXT NOT NULL DEFAULT '[]',
  selected_calendar_ids_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
