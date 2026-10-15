ALTER TABLE households ADD COLUMN weather_days INTEGER NOT NULL DEFAULT 5 CHECK(weather_days BETWEEN 1 AND 7);
ALTER TABLE households ADD COLUMN weather_show_precip INTEGER NOT NULL DEFAULT 0 CHECK(weather_show_precip IN (0,1));
ALTER TABLE households ADD COLUMN weather_show_wind INTEGER NOT NULL DEFAULT 0 CHECK(weather_show_wind IN (0,1));
ALTER TABLE households ADD COLUMN weather_show_humidity INTEGER NOT NULL DEFAULT 0 CHECK(weather_show_humidity IN (0,1));
ALTER TABLE households ADD COLUMN weather_show_current INTEGER NOT NULL DEFAULT 0 CHECK(weather_show_current IN (0,1));
ALTER TABLE households ADD COLUMN weather_show_feels INTEGER NOT NULL DEFAULT 0 CHECK(weather_show_feels IN (0,1));

CREATE TABLE weather_provider_keys (
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('openweathermap','open-meteo','weatherapi','pirateweather')),
  api_key TEXT NOT NULL,
  PRIMARY KEY (household_id, provider)
);

INSERT INTO weather_provider_keys(household_id, provider, api_key)
SELECT id,
  CASE WHEN weather_provider IN ('openweathermap','open-meteo','weatherapi','pirateweather') THEN weather_provider ELSE 'openweathermap' END,
  weather_api_key
FROM households
WHERE weather_api_key IS NOT NULL AND trim(weather_api_key) != '';
