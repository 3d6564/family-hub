ALTER TABLE households ADD COLUMN routine_morning_start TEXT NOT NULL DEFAULT '00:00';
ALTER TABLE households ADD COLUMN routine_afternoon_start TEXT NOT NULL DEFAULT '15:00';
ALTER TABLE households ADD COLUMN routine_bedtime_start TEXT NOT NULL DEFAULT '19:00';
