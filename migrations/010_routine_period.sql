ALTER TABLE routines ADD COLUMN period TEXT NOT NULL DEFAULT 'morning';
UPDATE routines SET period = 'after_school' WHERE title = 'Empty backpack';
UPDATE routines SET period = 'bedtime' WHERE title IN ('Lay out tomorrow''s clothes', 'Put dirty clothes in the hamper', 'Brush teeth at bedtime', 'Read for 15 minutes');
