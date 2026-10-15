ALTER TABLE households ADD COLUMN weather_enabled INTEGER NOT NULL DEFAULT 0 CHECK(weather_enabled IN (0,1));
ALTER TABLE households ADD COLUMN weather_location TEXT;
ALTER TABLE households ADD COLUMN weather_units TEXT NOT NULL DEFAULT 'f' CHECK(weather_units IN ('f','c'));
ALTER TABLE households ADD COLUMN weather_api_key TEXT;
ALTER TABLE households ADD COLUMN weather_provider TEXT;

CREATE TABLE weather_cache (
  household_id INTEGER PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
