CREATE TABLE routine_assignees (
  routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (routine_id, child_id)
);
INSERT INTO routine_assignees(routine_id, child_id)
SELECT id, child_id FROM routines;

CREATE TABLE routine_completion_entries (
  routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  completed_on TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (routine_id, child_id, completed_on)
);
INSERT INTO routine_completion_entries(routine_id, child_id, completed_on, completed_at)
SELECT c.routine_id, r.child_id, c.completed_on, c.completed_at
FROM routine_completions c JOIN routines r ON r.id = c.routine_id;
DROP TABLE routine_completions;
ALTER TABLE routine_completion_entries RENAME TO routine_completions;
