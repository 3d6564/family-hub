ALTER TABLE routines ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chores ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
UPDATE routines SET sort_order = id;
UPDATE chores SET sort_order = id;
