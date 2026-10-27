const conditions = new Set(['clear', 'cloudy', 'rain', 'storm', 'snow', 'unknown']);
const refreshChoices = new Set([15, 30, 60, 180]);
const providers = new Set(['openweathermap', 'open-meteo', 'weatherapi', 'pirateweather']);
const providerDayLimit = { openweathermap: 5, 'open-meteo': 7, weatherapi: 7, pirateweather: 7 };
const usStates = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia',
};

/** Return the supported weather provider ids. */
export function weatherProviderIds() {
  return [...providers];
}

/** Return a supported forecast refresh interval in minutes, or the fallback. */
export function weatherRefreshMinutes(value, fallback = 30) {
  const minutes = Number(value);
  return Number.isInteger(minutes) && refreshChoices.has(minutes) ? minutes : fallback;
}

/** Map an OpenWeatherMap condition id to a Family Hub icon name. */
export function weatherCondition(id) {
  if (id >= 200 && id < 300) return 'storm';
  if (id >= 300 && id < 600) return 'rain';
  if (id >= 600 && id < 700) return 'snow';
  if (id === 800) return 'clear';
  if (id > 800 && id < 900) return 'cloudy';
  return 'unknown';
}

/** Map an Open-Meteo weather code to a Family Hub icon name. */
export function openMeteoCondition(code) {
  if (code === 0) return 'clear';
  if ([1, 2, 3, 45, 48].includes(code)) return 'cloudy';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'unknown';
}

/** Map a WeatherAPI.com condition code to a Family Hub icon name. */
export function weatherApiCondition(code) {
  if (code === 1000) return 'clear';
  if ([1087, 1273, 1276, 1279, 1282].includes(code)) return 'storm';
  if ([1066, 1114, 1117, 1210, 1213, 1216, 1219, 1222, 1225, 1237, 1255, 1258, 1261, 1264].includes(code)) return 'snow';
  if ([1003, 1006, 1009, 1030, 1135, 1147].includes(code)) return 'cloudy';
  if ([1063, 1069, 1072, 1150, 1153, 1168, 1171, 1180, 1183, 1186, 1189, 1192, 1195, 1198, 1201, 1204, 1207, 1240, 1243, 1246, 1249, 1252].includes(code)) return 'rain';
  return 'unknown';
}

/** Map a Pirate Weather icon name to a Family Hub icon name. */
export function pirateCondition(icon) {
  if (icon === 'clear-day' || icon === 'clear-night') return 'clear';
  if (icon === 'rain' || icon === 'sleet') return 'rain';
  if (icon === 'snow') return 'snow';
  if (icon === 'thunderstorm') return 'storm';
  if (['cloudy', 'fog', 'wind', 'partly-cloudy-day', 'partly-cloudy-night'].includes(icon)) return 'cloudy';
  return 'unknown';
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function weekdayLabel(date, timeZone = 'UTC') {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(date);
}

/** Turn an OpenWeatherMap forecast into daily highs, lows, and optional details. */
export function forecastFromOpenWeather(body, units, placeName, current) {
  const offset = Number(body?.city?.timezone) || 0;
  const groups = new Map();
  for (const item of body?.list || []) {
    if (!Number.isFinite(item?.dt)) continue;
    const local = new Date((item.dt + offset) * 1000);
    const key = local.toISOString().slice(0, 10);
    const bucket = groups.get(key) || { label: weekdayLabel(local), highs: [], lows: [], pops: [], winds: [], humidities: [], midday: null };
    if (Number.isFinite(item.main?.temp_max)) bucket.highs.push(item.main.temp_max);
    if (Number.isFinite(item.main?.temp_min)) bucket.lows.push(item.main.temp_min);
    if (Number.isFinite(item.pop)) bucket.pops.push(item.pop * 100);
    if (Number.isFinite(item.wind?.speed)) bucket.winds.push(item.wind.speed);
    if (Number.isFinite(item.main?.humidity)) bucket.humidities.push(item.main.humidity);
    const hour = local.getUTCHours();
    if (!bucket.midday || Math.abs(hour - 15) < Math.abs(bucket.midday.hour - 15)) bucket.midday = { hour, id: item.weather?.[0]?.id };
    groups.set(key, bucket);
  }
  const days = [...groups.values()].slice(0, providerDayLimit.openweathermap).map((bucket) => ({
    label: bucket.label,
    condition: weatherCondition(bucket.midday?.id),
    high: bucket.highs.length ? Math.max(...bucket.highs) : null,
    low: bucket.lows.length ? Math.min(...bucket.lows) : null,
    precip: bucket.pops.length ? Math.max(...bucket.pops) : null,
    wind: bucket.winds.length ? Math.max(...bucket.winds) : null,
    humidity: average(bucket.humidities),
  }));
  return {
    place: placeName || body?.city?.name || '',
    units: units === 'c' ? 'c' : 'f',
    current: current ? { temperature: current.main?.temp, feelsLike: current.main?.feels_like } : null,
    days,
  };
}

/** Build location queries, including a US state abbreviation. */
export function locationQueries(location) {
  const parts = location.split(',').map((part) => part.trim()).filter(Boolean);
  const queries = [parts.join(',')];
  if (parts.length === 2 && /^[A-Za-z]{2}$/.test(parts[1])) queries.push(`${parts[0]},${parts[1].toUpperCase()},US`);
  return [...new Set(queries)];
}

function pickGeocode(results, query) {
  if (!results?.length) return null;
  const parts = query.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return results[0];
  const region = parts[1].toUpperCase();
  const state = usStates[region];
  const country = (parts[2] || (state ? 'US' : '')).toUpperCase();
  return results.find((place) => {
    if (state && place.admin1 !== state) return false;
    if (country && place.country_code?.toUpperCase() !== country) return false;
    return true;
  }) || null;
}

async function geocodeOpenMeteo(location, signal) {
  for (const query of locationQueries(location)) {
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.searchParams.set('name', query.split(',')[0]);
    url.searchParams.set('count', '10');
    url.searchParams.set('language', 'en');
    const response = await fetch(url, { signal });
    if (!response.ok) return null;
    const match = pickGeocode((await response.json()).results, query);
    if (match) return match;
  }
  return null;
}

function placeName(place) {
  return [place?.name, place?.admin1 || place?.state].filter(Boolean).join(', ');
}

/** Fetch a forecast from OpenWeatherMap. The API key stays in this request. */
export async function fetchOpenWeather({ location, units, apiKey, provider, signal }) {
  if ((provider && provider !== 'openweathermap') || !apiKey || !location) return null;
  let place = null;
  for (const query of locationQueries(location)) {
    const geo = new URL('https://api.openweathermap.org/geo/1.0/direct');
    geo.searchParams.set('q', query);
    geo.searchParams.set('limit', '1');
    geo.searchParams.set('appid', apiKey);
    const places = await fetch(geo, { signal });
    if (!places.ok) return null;
    [place] = await places.json();
    if (place) break;
  }
  if (!place) return null;
  const unit = units === 'c' ? 'metric' : 'imperial';
  const forecast = new URL('https://api.openweathermap.org/data/2.5/forecast');
  const currentUrl = new URL('https://api.openweathermap.org/data/2.5/weather');
  for (const url of [forecast, currentUrl]) {
    url.searchParams.set('lat', String(place.lat));
    url.searchParams.set('lon', String(place.lon));
    url.searchParams.set('units', unit);
    url.searchParams.set('appid', apiKey);
  }
  const [forecastResponse, currentResponse] = await Promise.all([fetch(forecast, { signal }), fetch(currentUrl, { signal })]);
  if (!forecastResponse.ok) return null;
  const current = currentResponse.ok ? await currentResponse.json() : null;
  return forecastFromOpenWeather(await forecastResponse.json(), units, placeName(place), current);
}

/** Fetch a forecast from Open-Meteo. A key uses the customer API. */
export async function fetchOpenMeteo({ location, units, apiKey, signal }) {
  if (!location) return null;
  const place = await geocodeOpenMeteo(location, signal);
  if (!place) return null;
  const url = new URL(apiKey ? 'https://customer-api.open-meteo.com/v1/forecast' : 'https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(place.latitude));
  url.searchParams.set('longitude', String(place.longitude));
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', String(providerDayLimit['open-meteo']));
  url.searchParams.set('temperature_unit', units === 'c' ? 'celsius' : 'fahrenheit');
  url.searchParams.set('wind_speed_unit', units === 'c' ? 'kmh' : 'mph');
  url.searchParams.set('current', 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m');
  url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,relative_humidity_2m_mean');
  if (apiKey) url.searchParams.set('apikey', apiKey);
  const response = await fetch(url, { signal });
  if (!response.ok) return null;
  const body = await response.json();
  const days = (body.daily?.time || []).slice(0, providerDayLimit['open-meteo']).map((date, index) => ({
    label: weekdayLabel(new Date(`${date}T12:00:00Z`), 'UTC'),
    condition: openMeteoCondition(body.daily.weather_code?.[index]),
    high: body.daily.temperature_2m_max?.[index],
    low: body.daily.temperature_2m_min?.[index],
    precip: body.daily.precipitation_probability_max?.[index],
    wind: body.daily.wind_speed_10m_max?.[index],
    humidity: body.daily.relative_humidity_2m_mean?.[index],
  }));
  return {
    place: placeName(place),
    units: units === 'c' ? 'c' : 'f',
    current: { temperature: body.current?.temperature_2m, feelsLike: body.current?.apparent_temperature },
    days,
    timeZone,
  };
}

async function readWeatherApi(location, apiKey, days, signal) {
  const url = new URL('https://api.weatherapi.com/v1/forecast.json');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('q', location);
  url.searchParams.set('days', String(days));
  url.searchParams.set('aqi', 'no');
  url.searchParams.set('alerts', 'no');
  const response = await fetch(url, { signal });
  if (!response.ok) return null;
  return response.json();
}

/** Fetch a forecast from WeatherAPI.com. A long request falls back to 3 days. */
export async function fetchWeatherApi({ location, units, apiKey, signal }) {
  if (!apiKey || !location) return null;
  let body = null;
  for (const query of locationQueries(location)) {
    body = await readWeatherApi(query, apiKey, providerDayLimit.weatherapi, signal);
    if (!body && providerDayLimit.weatherapi > 3) body = await readWeatherApi(query, apiKey, 3, signal);
    if (body?.forecast?.forecastday) break;
    body = null;
  }
  if (!body) return null;
  const metric = units === 'c';
  const days = body.forecast.forecastday.slice(0, providerDayLimit.weatherapi).map((item) => ({
    label: weekdayLabel(new Date(`${item.date}T12:00:00Z`), 'UTC'),
    condition: weatherApiCondition(item.day?.condition?.code),
    high: metric ? item.day?.maxtemp_c : item.day?.maxtemp_f,
    low: metric ? item.day?.mintemp_c : item.day?.mintemp_f,
    precip: item.day?.daily_chance_of_rain,
    wind: metric ? item.day?.maxwind_kph : item.day?.maxwind_mph,
    humidity: item.day?.avghumidity,
  }));
  return {
    place: [body.location?.name, body.location?.region].filter(Boolean).join(', '),
    units: metric ? 'c' : 'f',
    current: {
      temperature: metric ? body.current?.temp_c : body.current?.temp_f,
      feelsLike: metric ? body.current?.feelslike_c : body.current?.feelslike_f,
    },
    days,
  };
}

/** Fetch a forecast from Pirate Weather. Location lookup does not send the API key. */
export async function fetchPirateWeather({ location, units, apiKey, signal }) {
  if (!apiKey || !location) return null;
  const place = await geocodeOpenMeteo(location, signal);
  if (!place) return null;
  const url = new URL(`https://api.pirateweather.net/forecast/${encodeURIComponent(apiKey)}/${place.latitude},${place.longitude}`);
  url.searchParams.set('units', units === 'c' ? 'ca' : 'us');
  url.searchParams.set('exclude', 'minutely,hourly,alerts');
  const response = await fetch(url, { signal });
  if (!response.ok) return null;
  const body = await response.json();
  const timeZone = body.timezone || 'UTC';
  const days = (body.daily?.data || []).slice(0, providerDayLimit.pirateweather).map((item) => ({
    label: weekdayLabel(new Date(item.time * 1000), timeZone),
    condition: pirateCondition(item.icon),
    high: item.temperatureHigh ?? item.temperatureMax,
    low: item.temperatureLow ?? item.temperatureMin,
    precip: Number.isFinite(item.precipProbability) ? item.precipProbability * 100 : null,
    wind: item.windSpeed,
    humidity: Number.isFinite(item.humidity) ? item.humidity * 100 : null,
  }));
  return {
    place: placeName(place),
    units: units === 'c' ? 'c' : 'f',
    current: {
      temperature: body.currently?.temperature,
      feelsLike: body.currently?.apparentTemperature,
    },
    days,
  };
}

/** Fetch a forecast from the selected provider. The API key stays in this request. */
export async function fetchWeather(settings) {
  if (settings.provider === 'open-meteo') return fetchOpenMeteo(settings);
  if (settings.provider === 'weatherapi') return fetchWeatherApi(settings);
  if (settings.provider === 'pirateweather') return fetchPirateWeather(settings);
  return fetchOpenWeather(settings);
}

function sanitizeDay(day) {
  const label = typeof day?.label === 'string' ? day.label.trim().slice(0, 12) : '';
  if (!label) return null;
  return {
    label,
    condition: conditions.has(day.condition) ? day.condition : 'unknown',
    high: numberOrNull(day.high),
    low: numberOrNull(day.low),
    precip: numberOrNull(day.precip),
    wind: numberOrNull(day.wind),
    humidity: numberOrNull(day.humidity),
  };
}

function sanitizeCurrent(current) {
  if (!current || typeof current !== 'object') return null;
  const temperature = numberOrNull(current.temperature);
  const feelsLike = numberOrNull(current.feelsLike);
  if (temperature === null && feelsLike === null) return null;
  return { temperature, feelsLike };
}

/** Return a forecast safe to send to a wall display. */
export function publicForecast(value) {
  if (!value || !Array.isArray(value.days)) return null;
  const days = value.days.slice(0, 7).map(sanitizeDay).filter(Boolean);
  if (!days.length) return null;
  return {
    place: typeof value.place === 'string' ? value.place.trim().slice(0, 80) : '',
    units: value.units === 'c' ? 'c' : 'f',
    current: sanitizeCurrent(value.current),
    days,
  };
}

function clampDays(value) {
  const days = Number(value);
  return Number.isInteger(days) && days >= 1 && days <= 7 ? days : 5;
}

function presentForecast(value, household) {
  const clean = publicForecast(value);
  if (!clean) return null;
  const days = clean.days.slice(0, clampDays(household?.weather_days));
  if (!days.length) return null;
  return {
    place: clean.place,
    units: clean.units,
    windUnit: clean.units === 'c' ? 'km/h' : 'mph',
    show: {
      precip: !!household?.weather_show_precip,
      wind: !!household?.weather_show_wind,
      humidity: !!household?.weather_show_humidity,
      current: !!household?.weather_show_current,
      feels: !!household?.weather_show_feels,
    },
    current: clean.current,
    days,
  };
}

function providerKey(db, household) {
  const provider = providers.has(household.weather_provider) ? household.weather_provider : (household.weather_api_key ? 'openweathermap' : null);
  if (!provider) return { provider: null, apiKey: '' };
  const saved = db.prepare('SELECT api_key FROM weather_provider_keys WHERE household_id=? AND provider=?').get(household.id, provider);
  return { provider, apiKey: saved?.api_key || (provider === 'openweathermap' ? household.weather_api_key || '' : '') };
}

/** Load a cached forecast; report safe outcomes only when a provider refresh is attempted. */
export async function currentForecast(db, household, fetchForecast, now = new Date(), onRefresh = () => {}) {
  if (!household?.weather_enabled || !household.weather_location) return null;
  const cached = db.prepare('SELECT payload,fetched_at FROM weather_cache WHERE household_id=?').get(household.id);
  const readCached = () => {
    if (!cached) return null;
    try { return presentForecast(JSON.parse(cached.payload), household); } catch { return null; }
  };
  const freshEnough = cached && now - new Date(cached.fetched_at) < weatherRefreshMinutes(household.weather_refresh_minutes) * 60 * 1000;
  if (freshEnough) return readCached();
  const { provider, apiKey } = providerKey(db, household);
  if (!provider || (provider !== 'open-meteo' && !apiKey) || typeof fetchForecast !== 'function') return readCached();
  let fetched = null;
  try {
    fetched = publicForecast(await fetchForecast({
      provider,
      location: household.weather_location,
      units: household.weather_units,
      apiKey,
      signal: AbortSignal.timeout(8000),
    }));
  } catch {
    fetched = null;
  }
  onRefresh({ lastAttemptAt: now.toISOString(), failed: !fetched });
  if (!fetched) return readCached();
  db.prepare(`INSERT INTO weather_cache(household_id,payload,fetched_at) VALUES (?,?,?)
    ON CONFLICT(household_id) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at`).run(household.id, JSON.stringify(fetched), now.toISOString());
  return presentForecast(fetched, household);
}
