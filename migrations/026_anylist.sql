CREATE TABLE anylist_connections (
  household_id INTEGER PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  credentials TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  list_id TEXT,
  list_name TEXT,
  lists_json TEXT NOT NULL DEFAULT '[]',
  items_json TEXT NOT NULL DEFAULT '[]',
  last_success_at TEXT
);
