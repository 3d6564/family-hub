ALTER TABLE households ADD COLUMN theme TEXT NOT NULL DEFAULT 'green' CHECK(theme IN ('green','slate','blue','warm'));
