ALTER TABLE households ADD COLUMN token_board_enabled INTEGER NOT NULL DEFAULT 0 CHECK(token_board_enabled IN (0,1));

ALTER TABLE sessions ADD COLUMN screen_width INTEGER;
ALTER TABLE sessions ADD COLUMN screen_height INTEGER;
ALTER TABLE sessions ADD COLUMN viewport_width INTEGER;
ALTER TABLE sessions ADD COLUMN viewport_height INTEGER;
ALTER TABLE sessions ADD COLUMN pixel_ratio REAL;
ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
