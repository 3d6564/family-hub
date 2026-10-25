import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// Optional real-browser coverage uses an existing Chromium binary, not a dependency.
const browserPath = process.env.FAMILY_HUB_TEST_BROWSER;

async function until(check) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('Browser condition timed out.');
}

test('settings retain drafts, isolate failures, and work at phone and desktop widths', { skip: !browserPath, timeout: 60000 }, async (t) => {
  const publicRoot = new URL('../public/', import.meta.url);
  const household = { name: 'Sample home', timezone: 'UTC', weekStartsOn: 0, theme: 'green', dimEnabled: false, tokenBoardEnabled: false };
  let failWeatherLoad = true, failWeatherSave = false, weatherSaveCount = 0, tokenSaves = 0, screenDeletes = 0, restores = 0, holdSave;
  let weather = { enabled: false, location: 'Sample city', provider: 'open-meteo', units: 'f', days: 5, refreshMinutes: 30, hasKey: { openweathermap: true }, status: { state: 'disabled' } };
  let feeds = [{ id: 1, name: 'Sample calendar', color: '#4285f4', enabled: 1, status: { state: 'not_checked' } }];
  let sampleMembers = [{ id: 1, name: 'Sample adult', role: 'adult', has_email: 1 }, { id: 2, name: 'Sample child', role: 'child', has_email: 0 }];
  let screens = [{ id: 3, device_name: 'Sample screen', last_seen_at: '2026-10-25 12:00:00', screen_width: 1280, screen_height: 720, viewport_width: 1280, viewport_height: 720, pixel_ratio: 1 }];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'), route = url.pathname;
    if (route === '/api/events/stream') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('event: ready\ndata: {}\n\n'); return; }
    const json = (body, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    let body = {};
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) { let text = ''; for await (const chunk of req) text += chunk; body = JSON.parse(text || '{}'); }
    if (route === '/api/setup') return json({ needsSetup: false });
    if (route === '/api/me') return json({ user: { id: 1, name: 'Sample adult', role: 'adult' }, household });
    if (route === '/api/version') return json({ version: 'sample-deployment' });
    if (route === '/api/release') return json({ version: '0.3.3', channel: 'release' });
    if (route === '/api/dashboard') return json({ today: '2026-10-25', routines: [], chores: [], plans: [], weather: null });
    if (route === '/api/calendar/events') return json({ events: [], errors: [] });
    if (route === '/api/tokens') return json({ people: [] });
    if (route === '/api/members') return json(sampleMembers);
    if (route === '/api/members/2' && req.method === 'PATCH') { sampleMembers = sampleMembers.map(member => member.id === 2 ? { ...member, ...body } : member); return json({ ok: true }); }
    if (route === '/api/household/weather') {
      if (req.method === 'GET') return failWeatherLoad ? json({ error: 'Sample weather load failure.' }, 503) : json(weather);
      weatherSaveCount += 1;
      if (holdSave) await holdSave;
      if (failWeatherSave) return json({ error: 'Sample provider setting rejected.' }, 400);
      weather = { ...weather, ...body }; delete weather.keys;
      return json(weather);
    }
    if (route === '/api/calendar/feeds') return json(feeds);
    if (route === '/api/calendar/feeds/1' && req.method === 'PATCH') { feeds = feeds.map(feed => ({ ...feed, ...body })); return json({ ok: true }); }
    if (route === '/api/devices') return json(screens);
    if (route === '/api/devices/3' && req.method === 'DELETE') { screenDeletes += 1; screens = []; res.writeHead(204); return res.end(); }
    if (route === '/api/household/token-board') { tokenSaves += 1; household.tokenBoardEnabled = body.enabled; return json({ tokenBoardEnabled: body.enabled }); }
    if (route === '/api/household/restore') { restores += 1; return json({ ok: true }); }
    if (route.startsWith('/api/household/')) return json(body);
    if (route.startsWith('/api/')) return json([]);
    const filename = route === '/' ? 'index.html' : route.slice(1);
    if (!/^[\w.-]+$/.test(filename)) { res.writeHead(404); return res.end(); }
    try {
      const bytes = fs.readFileSync(new URL(filename, publicRoot));
      res.writeHead(200, { 'Content-Type': filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'family-hub-browser-'));
  const browser = spawn(browserPath, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => { browser.kill(); });
  let stderr = '';
  browser.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const browserAddress = await until(() => stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]);
  const port = new URL(browserAddress).port;
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  t.after(() => socket.close());
  let nextId = 0, acceptDialog = false;
  const pending = new Map(), dialogs = [], exceptions = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) { const request = pending.get(message.id); pending.delete(message.id); if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result); }
    if (message.method === 'Page.javascriptDialogOpening') { dialogs.push(message.params.message); send('Page.handleJavaScriptDialog', { accept: acceptDialog }).catch(() => {}); }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
  });
  await send('Page.enable'); await send('Runtime.enable');
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = (selector, value) => evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const tab = name => click(`[data-settings-tab="${name}"]`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/#settings` });
  await until(() => evaluate('!!document.querySelector("#settings-tab-screens")'));

  await t.test('failed weather loading does not block other settings and can be retried', async () => {
    assert.equal(await evaluate('document.querySelector("#release-info").textContent'), 'Installed version: 0.3.3');
    assert.equal(await evaluate('document.querySelectorAll("[role=tab]").length'), 8);
    assert.equal(await evaluate('!!document.querySelector("#settings-tab-routines")'), true);
    assert.equal(await evaluate('document.querySelector("#weather-form input").disabled'), true);
    failWeatherLoad = false;
    await tab('weather'); await click('[data-settings-load="weather"] button');
    await until(() => evaluate('document.querySelector("[name=weatherLocation]").value === "Sample city"'));
    assert.equal(await evaluate('document.querySelector("[name=weatherApiKey]").value'), '');
    assert.equal(await evaluate('document.querySelector("#weather-form button").disabled'), true);
  });

  await t.test('provider switching keeps only replacement drafts and discarding clears them', async () => {
    const count = weatherSaveCount;
    await fill('[name=weatherApiKey]', 'sample-replacement-key');
    await evaluate('document.querySelector("[name=weatherProvider]").value="openweathermap";document.querySelector("[name=weatherProvider]").dispatchEvent(new Event("change",{bubbles:true}))');
    assert.equal(await evaluate('document.querySelector("[name=weatherApiKey]").value'), '');
    assert.match(await evaluate('document.querySelector("[name=weatherApiKey]").placeholder'), /Saved key/);
    await evaluate('document.querySelector("[name=weatherProvider]").value="open-meteo";document.querySelector("[name=weatherProvider]").dispatchEvent(new Event("change",{bubbles:true}))');
    assert.equal(await evaluate('document.querySelector("[name=weatherApiKey]").value'), 'sample-replacement-key');
    acceptDialog = true; await tab('routines'); acceptDialog = false;
    await tab('weather');
    assert.equal(await evaluate('document.querySelector("[name=weatherApiKey]").value'), '');
    assert.equal(weatherSaveCount, count);
  });

  await t.test('drafts survive unrelated reloads and navigation cancellation', async () => {
    await fill('[name=weatherLocation]', 'Draft city');
    await fill('#calendar-feed-form [name=name]', 'Another sample calendar');
    await fill('#calendar-feed-form [name=url]', 'https://calendar.example/sample.ics');
    await evaluate('document.querySelector("#calendar-feed-form").requestSubmit()');
    await until(() => evaluate('document.querySelector("#calendar-feed-form .form-status").textContent === "Saved."'));
    assert.equal(await evaluate('document.querySelector("[name=weatherLocation]").value'), 'Draft city');
    await tab('routines');
    assert.equal(await evaluate('document.querySelector(".settings-grid").dataset.settingsTab'), 'weather');
    assert.match(dialogs.at(-1), /Discard unsaved/);
    await evaluate('location.hash="calendar"');
    await until(() => evaluate('location.hash === "#settings"'));
    assert.equal(await evaluate('document.body.dataset.view'), 'settings');
  });

  await t.test('failed saves retain drafts, retries work, and duplicate submissions are blocked', async () => {
    failWeatherSave = true;
    await click('#weather-form button');
    await until(() => evaluate('document.querySelector("#weather-form .form-status").textContent.includes("not saved")'));
    assert.equal(await evaluate('document.querySelector("[name=weatherLocation]").value'), 'Draft city');
    assert.equal(await evaluate('document.querySelector("#weather-form button").disabled'), false);
    failWeatherSave = false;
    let release; holdSave = new Promise(resolve => { release = resolve; });
    const count = weatherSaveCount;
    await click('#weather-form button');
    await until(() => weatherSaveCount === count + 1);
    await evaluate('document.querySelector("#weather-form").requestSubmit()');
    assert.equal(weatherSaveCount, count + 1);
    assert.equal(await evaluate('document.querySelector("#weather-form").getAttribute("aria-busy")'), 'true');
    release(); holdSave = null;
    await until(() => evaluate('document.querySelector("#weather-form .form-status").textContent === "Saved."'));
    assert.equal(await evaluate('document.querySelector("#weather-form button").disabled'), true);
  });

  await t.test('token visibility uses explicit saving and appearance drafts stay intact', async () => {
    await tab('display');
    await click('[name=tokenBoardEnabled]');
    assert.equal(tokenSaves, 0);
    await fill('[name=displayTitle]', 'Draft title');
    await click('#token-board-form button');
    await until(() => tokenSaves === 1);
    assert.equal(await evaluate('document.querySelector("[name=displayTitle]").value'), 'Draft title');
    await click('#menu-button');
    assert.equal(await evaluate('document.querySelector("[name=displayTitle]").value'), 'Draft title');
    acceptDialog = true; await tab('screens'); acceptDialog = false;
    assert.equal(await evaluate('document.querySelector("[name=displayTitle]").value'), '');
  });

  await t.test('screen revocation is located with screens and requires named confirmation', async () => {
    await until(() => evaluate('!!document.querySelector("[data-device]")'));
    assert.equal(await evaluate('!!document.querySelector("#settings-panel-access [data-device]")'), false);
    assert.match(await evaluate('document.querySelector("#settings-panel-screens").textContent'), /not live screenshots/);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1000, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await click('[data-device]'); assert.equal(screenDeletes, 0);
    assert.match(dialogs.at(-1), /Sample screen/);
    acceptDialog = true; await click('[data-device]'); acceptDialog = false;
    await until(() => screenDeletes === 1);
    await until(() => evaluate('!document.querySelector("[data-device]")'));
  });

  await t.test('saving one member preserves another member draft and calendar deletion is confirmed', async () => {
    await tab('household');
    await evaluate('document.querySelectorAll("#members details").forEach(node=>node.open=true)');
    await fill('[data-member-edit="1"] [name=name]', 'Unsaved adult name');
    await fill('[data-member-edit="2"] [name=name]', 'Updated child name');
    await click('[data-member-edit="2"] button');
    await until(() => evaluate('document.querySelector("[data-member-edit=\\"2\\"] .form-status").textContent === "Saved."'));
    assert.equal(await evaluate('document.querySelector("[data-member-edit=\\"1\\"] [name=name]").value'), 'Unsaved adult name');
    acceptDialog = true; await tab('calendars'); acceptDialog = false;
    await click('[data-delete-feed]');
    assert.match(dialogs.at(-1), /Sample calendar/);
    assert.equal(feeds.length, 1);
  });

  await t.test('Access groups are separated and roadmap cards and update checks are absent', async () => {
    await tab('access');
    assert.equal(await evaluate('document.querySelector("#logout").closest(".settings-group") === document.querySelector("#password-form").closest(".settings-group")'), true);
    assert.equal(await evaluate('!!document.querySelector(".danger-zone #backup-restore")'), true);
    assert.equal(await evaluate('!!document.querySelector("#update-info")'), false);
    await evaluate('(()=>{const transfer=new DataTransfer();transfer.items.add(new File(["sample"],"sample-backup.sqlite"));const input=document.querySelector("#backup-file");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));})()');
    assert.match(dialogs.at(-1), /sample-backup.sqlite/);
    assert.equal(restores, 0);
    await tab('integrations');
    assert.equal(await evaluate('!!document.querySelector(".integration-roadmap")'), false);
  });

  await t.test('all tabs are visible and active sections use the content width on phones and desktops', async () => {
    for (const width of [390, 760, 1024, 1440, 1920]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      for (const section of ['display', 'screens', 'calendars', 'routines', 'weather', 'household', 'access', 'integrations']) {
        await tab(section);
        const bounds = await evaluate('(()=>{const tabs=[...document.querySelectorAll("[role=tab]")].map(node=>node.getBoundingClientRect());const grid=document.querySelector(".settings-grid").getBoundingClientRect();const panel=document.querySelector("#settings-panel-"+document.querySelector(".settings-grid").dataset.settingsTab).getBoundingClientRect();return {tabsFit:tabs.every(rect=>rect.left>=0&&rect.right<=innerWidth),grid:grid.width,panel:panel.width,overflow:document.documentElement.scrollWidth>innerWidth};})()');
        assert.equal(bounds.tabsFit, true, `${section} tabs at ${width}`); assert.equal(bounds.overflow, false, `${section} overflow at ${width}`); assert.ok(Math.abs(bounds.grid - bounds.panel) < 2, `${section} width at ${width}`);
      }
    }
    await tab('display');
    await evaluate('document.querySelector("#settings-tab-display").focus();document.querySelector("#settings-tab-display").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))');
    assert.equal(await evaluate('document.activeElement.dataset.settingsTab'), 'screens');
  });
  assert.deepEqual(exceptions, []);
});
