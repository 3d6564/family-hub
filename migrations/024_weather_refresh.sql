ALTER TABLE households ADD COLUMN weather_refresh_minutes INTEGER NOT NULL DEFAULT 30 CHECK(weather_refresh_minutes IN (15, 30, 60, 180));
