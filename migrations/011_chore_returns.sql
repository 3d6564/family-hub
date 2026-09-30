ALTER TABLE chores ADD COLUMN returns_immediately INTEGER NOT NULL DEFAULT 0;

CREATE TABLE chore_completion_events (
  id INTEGER PRIMARY KEY,
  chore_id INTEGER NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
  completed_on TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX chore_completion_events_day ON chore_completion_events(chore_id, completed_on);
