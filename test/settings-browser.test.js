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

test('settings retain drafts, isolate failures, and work at phone and desktop widths', { skip: !browserPath, timeout: 90000 }, async (t) => {
  const publicRoot = new URL('../public/', import.meta.url);
  const household = { name: 'Sample home', timezone: 'UTC', weekStartsOn: 0, theme: 'green', dimEnabled: false, tokenBoardEnabled: false };
  let failWeatherLoad = true, failWeatherSave = false, weatherSaveCount = 0, tokenSaves = 0, screenDeletes = 0, restores = 0, holdSave;
  let failScreenPair = false;
  const pairingRequests = [];
  let displayMode = false, failListSave = false, listStale = false;
  let anylist = { keyReady: true, connected: false, enabled: false, listId: '', listIds: [], lists: [], state: 'unconfigured', lastSuccessAt: null };
  let listItems = [{ id: 'milk', name: 'Milk', notes: '', quantity: '2', quantityUnit: 'L', checked: false }, { id: 'bread', name: 'Bread', notes: '', quantity: '', checked: true }];
  const resources = [{ id: 'groceries', name: 'Sample groceries' }, { id: 'household', name: 'Sample household' }, { id: 'pharmacy', name: 'Pharmacy' }, { id: 'tools', name: 'Tools' }];
  const extraItems = new Map(resources.slice(1).map(list => [list.id, []]));
  const itemsFor = id => id === 'groceries' ? listItems : extraItems.get(id);
  let nextListItem = 10;
  const listSnapshot = () => {
    const lists = anylist.enabled ? anylist.listIds.map(id => ({ ...resources.find(list => list.id === id), items: itemsFor(id), lastSuccessAt: '2026-10-25T12:00:00Z', stale: listStale })) : [];
    return { enabled: !!lists.length, lists, name: lists[0]?.name || '', items: lists[0]?.items || [], lastSuccessAt: lists[0]?.lastSuccessAt || null, stale: listStale };
  };
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
    if (route === '/api/me') return json({ user: displayMode ? null : { id: 1, name: 'Sample adult', role: 'adult' }, device: displayMode ? 'Sample wall' : null, household });
    if (route === '/api/version') return json({ version: 'sample-deployment' });
    if (route === '/api/release') return json({ version: '0.3.3', channel: 'release' });
    if (route === '/api/dashboard') return json({ today: '2026-10-25', routines: [{ id: 1, title: 'Read together', child_id: 2, child_name: 'Sample child', period: 'morning', completed: false }], chores: [{ id: 1, title: 'Set the table', assignee_name: 'Sample child', reward_quarters: 2, completed: false }], plans: [], weather: null });
    if (route === '/api/calendar/events') return json({ events: [], errors: [] });
    if (route === '/api/tokens') return json({ people: [] });
    if (route === '/api/members') return json(sampleMembers);
    if (route === '/api/integrations/anylist/connect') { anylist = { ...anylist, connected: true, lists: resources, state: 'disabled' }; return json(anylist); }
    if (route === '/api/integrations/anylist') {
      if (req.method === 'PUT') anylist = { ...anylist, ...body, state: body.enabled ? 'ok' : 'disabled' };
      return json(anylist);
    }
    if (route === '/api/lists/anylist') return json(listSnapshot());
    const listRoute = route.match(/^\/api\/lists\/anylist\/([^/]+)\/items(?:\/(.+))?$/);
    if (listRoute) {
      const listId = decodeURIComponent(listRoute[1]), id = listRoute[2] && decodeURIComponent(listRoute[2]);
      if (failListSave) return json({ error: 'Sample list save failure. Refresh before trying again.' }, 502);
      let items = itemsFor(listId);
      if (req.method === 'POST') items.push({ id: `item-${nextListItem++}`, name: body.name, notes: '', quantity: '', checked: false });
      if (req.method === 'DELETE') items = items.filter(item => item.id !== id);
      if (req.method === 'PATCH') items = items.map(item => item.id === id ? { ...item, checked: body.checked } : item);
      if (listId === 'groceries') listItems = items; else extraItems.set(listId, items);
      return json(listSnapshot());
    }
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
    if (route === '/api/screens/pair') { pairingRequests.push(body); return failScreenPair ? json({ error: 'Sample code expired. Enter the new code.' }, 400) : json({ ok: true }); }
    if (route === '/api/devices/3' && req.method === 'DELETE') { screenDeletes += 1; screens = []; res.writeHead(204); return res.end(); }
    if (route === '/api/household/token-board') { tokenSaves += 1; household.tokenBoardEnabled = body.enabled; return json({ tokenBoardEnabled: body.enabled }); }
    if (route === '/api/household/restore') { restores += 1; return json({ ok: true }); }
    if (route === '/api/household/theme' && req.method === 'PUT') { household.theme = body.theme; return json(body); }
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
  let nextId = 0, acceptDialog = false, virtualBudgetDone;
  const pending = new Map(), dialogs = [], exceptions = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) { const request = pending.get(message.id); pending.delete(message.id); if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result); }
    if (message.method === 'Page.javascriptDialogOpening') { dialogs.push(message.params.message); send('Page.handleJavaScriptDialog', { accept: acceptDialog }).catch(() => {}); }
    if (message.method === 'Emulation.virtualTimeBudgetExpired') { virtualBudgetDone?.(); virtualBudgetDone = undefined; }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
  });
  await send('Page.enable'); await send('Runtime.enable');
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const advanceTime = async budget => {
    const expired = new Promise(resolve => { virtualBudgetDone = resolve; });
    await send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget });
    await expired;
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = (selector, value) => evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const tab = name => click(`[data-settings-tab="${name}"]`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/#settings` });
  await until(() => evaluate('!!document.querySelector("#settings-tab-screens")'));

  await t.test('desktop places appearance, mode, and settings at the rail bottom; mobile keeps header controls', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const desktop = await evaluate(`(()=>{const ids=['appearance-menu-button','theme-toggle','menu-button'],nodes=ids.map(id=>document.getElementById(id)),rects=nodes.map(node=>node.getBoundingClientRect()),styles=nodes.map(node=>{const style=getComputedStyle(node);return {border:style.borderStyle,background:style.backgroundColor,color:style.color}}),positions=nodes.map(node=>getComputedStyle(node).position),icons=[...document.querySelectorAll('#app>nav .rail-icon'),document.querySelector('#theme-toggle .rail-icon:not([hidden])'),document.querySelector('#menu-button .rail-icon')],iconBounds=icons.map(icon=>{const rect=icon.getBoundingClientRect(),style=getComputedStyle(icon);return {width:rect.width,height:rect.height,strokeWidth:style.strokeWidth}});return {rects:rects.map(rect=>({left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom})),positions,styles,iconBounds,themeLabel:nodes[0].textContent.trim(),pressed:nodes[1].getAttribute('aria-pressed'),modeLabel:getComputedStyle(nodes[1],'::after').content,accountIconVisible:getComputedStyle(nodes[2].querySelector('.account-icon')).display!=='none',scrollWidth:document.documentElement.scrollWidth,innerWidth}})()`);
    assert.deepEqual(desktop.positions, ['fixed', 'fixed', 'fixed']);
    assert.ok(desktop.rects.every(rect => rect.left >= 0 && rect.right <= 88), `Controls must fit in the left rail: ${JSON.stringify(desktop)}`);
    assert.ok(desktop.rects[0].top < desktop.rects[1].top && desktop.rects[1].top < desktop.rects[2].top, `Controls must follow Appearance, mode, Settings order: ${JSON.stringify(desktop)}`);
    assert.ok(desktop.styles.every(style => style.border === 'none' && style.background === 'rgba(0, 0, 0, 0)' && style.color === desktop.styles[0].color), `Rail controls must share the unboxed navigation style: ${JSON.stringify(desktop.styles)}`);
    assert.equal(new Set(desktop.iconBounds.map(icon => `${icon.width}x${icon.height}`)).size, 1, `Left-rail icons must use one visible box: ${JSON.stringify(desktop.iconBounds)}`);
    assert.ok(desktop.iconBounds.every(icon => icon.width === 28 && icon.height === 28 && icon.strokeWidth === '1.8px'), `Rail icons must share the same size and stroke: ${JSON.stringify(desktop.iconBounds)}`);
    assert.match(desktop.themeLabel, /Theme$/);
    assert.equal(desktop.modeLabel, desktop.pressed === 'true' ? '"Light"' : '"Dark"');
    assert.equal(desktop.accountIconVisible, true);
    assert.ok(desktop.scrollWidth <= desktop.innerWidth, `Desktop page must not overflow horizontally: ${JSON.stringify(desktop)}`);

    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    const mobile = await evaluate(`(()=>{const header=document.querySelector('#app>header').getBoundingClientRect(),nodes=['theme-toggle','menu-button'].map(id=>document.getElementById(id)),rects=nodes.map(node=>node.getBoundingClientRect()),iconSizes=[...document.querySelectorAll('#app>nav .rail-icon')].map(icon=>{const rect=icon.getBoundingClientRect();return String(rect.width)+'x'+String(rect.height)});return {positions:nodes.map(node=>getComputedStyle(node).position),rects:rects.map(rect=>({top:rect.top,bottom:rect.bottom})),header:{top:header.top,bottom:header.bottom},iconSizes,scrollWidth:document.documentElement.scrollWidth,innerWidth}})()`);
    assert.deepEqual(mobile.positions, ['static', 'static']);
    assert.ok(mobile.rects.every(rect => rect.top >= mobile.header.top && rect.bottom <= mobile.header.bottom), `Settings and mode controls must stay in the mobile header: ${JSON.stringify(mobile)}`);
    assert.equal(new Set(mobile.iconSizes).size, 1, `Mobile navigation icons must remain the same size: ${JSON.stringify(mobile.iconSizes)}`);
    assert.ok(mobile.scrollWidth <= mobile.innerWidth, `Mobile page must not overflow horizontally: ${JSON.stringify(mobile)}`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  });

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

  await t.test('reconnecting an existing screen is easy to select and retains the draft on failure', async () => {
    await tab('screens');
    await until(() => evaluate('!!document.querySelector("[data-reconnect-screen]")'));
    await click('[data-reconnect-screen]');
    assert.equal(await evaluate('document.querySelector("[name=reconnectId]").value'), '3');
    assert.equal(await evaluate('document.querySelector("#screen-name-field").hidden'), true);
    assert.equal(await evaluate('document.activeElement.name'), 'code');
    assert.match(await evaluate('document.querySelector("#screen-pair-help").textContent'), /old connection is not revoked/);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1000, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await fill('#screen-pair-form [name=code]', 'ABCDEFGH');
    failScreenPair = true;
    await click('#screen-pair-form button');
    await until(() => evaluate('document.querySelector("#screen-pair-form .form-status").textContent.includes("not saved")'));
    assert.equal(await evaluate('document.querySelector("#screen-pair-form [name=code]").value'), 'ABCDEFGH');
    await click('[data-refresh-screen]');
    assert.equal(await evaluate('document.querySelector("[name=reconnectId]").value'), '3');
    failScreenPair = false;
    await click('#screen-pair-form button');
    await until(() => evaluate('document.querySelector("#screen-pair-result").textContent.includes("Reconnect approved")'));
    assert.deepEqual(pairingRequests.at(-1), { reconnectId: 3, code: 'ABCDEFGH' });
    assert.equal(screens.length, 1); assert.equal(screens[0].device_name, 'Sample screen');
    assert.equal(await evaluate('document.querySelector("[name=reconnectId]").value'), '');
    assert.equal(await evaluate('document.querySelector("#screen-name-field").hidden'), false);
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

  await t.test('AnyList setup saves explicitly and does not retain the sign-in password', async () => {
    await tab('integrations');
    await until(() => evaluate('!!document.querySelector("#anylist-connect-form")'));
    await fill('#anylist-connect-form [name=email]', 'sample@example.test');
    await fill('#anylist-connect-form [name=password]', 'sample-password');
    assert.equal(anylist.connected, false);
    await click('#anylist-connect-form button');
    await until(() => evaluate('document.querySelector("#anylist-connect-form .form-status").textContent === "Saved."'));
    assert.equal(await evaluate('document.querySelector("#anylist-connect-form [name=password]").value'), '');
    await click('#anylist-config-form [name=listIds][value=household]');
    await click('#anylist-config-form button');
    await until(() => evaluate('document.querySelector("#anylist-config-form .form-status").textContent === "Saved."'));
    assert.deepEqual(anylist.listIds, ['household']);
    assert.equal(anylist.enabled, false);
    await click('#menu-button');
    await until(() => evaluate('document.querySelector("#anylist-config-form [name=listIds][value=household]").checked'));
    await click('#anylist-config-form [name=listIds][value=household]');
    await click('#anylist-config-form [name=listIds][value=groceries]');
    await click('#anylist-config-form [name=enabled]');
    assert.equal(anylist.enabled, false);
    await click('#anylist-config-form button');
    await until(() => evaluate('document.querySelector("#anylist-config-form .form-status").textContent === "Saved."'));
    assert.equal(anylist.enabled, true);
  });

  await t.test('Lists add, check, completed deletion, text escaping, and phone/sidebar layout work', async () => {
    await click('[data-nav="lists"]');
    await until(() => evaluate('document.querySelectorAll("[data-list-item]").length === 2'));
    assert.match(await evaluate('document.querySelector("[data-list-item=milk]").closest("label").textContent'), /2 L Milk/);
    for (const width of [390, 760, 1024, 1440, 1920]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      const bounds = await evaluate('(()=>{const nav=document.querySelector("#app>nav").getBoundingClientRect(),list=document.querySelector("#shared-list").getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,navLeft:nav.left,navTop:nav.top,navWidth:nav.width,listLeft:list.left,listWidth:list.width,visible:getComputedStyle(document.querySelector("#shared-list")).display!=="none"};})()');
      assert.equal(bounds.overflow, false, `Lists overflow at ${width}`); assert.equal(bounds.visible, true);
      if (width > 760) { assert.equal(bounds.navLeft, 0); assert.equal(bounds.navTop, 0); assert.equal(bounds.navWidth, 88); assert.ok(bounds.listLeft >= 88); }
      else { assert.ok(bounds.navTop >= 930); assert.ok(bounds.listWidth <= width); }
    }
    await evaluate('document.querySelector("#list-add-form [name=name]").focus()');
    assert.equal(await evaluate('document.querySelector("#kiosk-keyboard").hidden'), true);
    await fill('#list-add-form [name=name]', 'Eggs <img src=x>');
    failListSave = true; await click('#list-add-form button');
    await until(() => evaluate('document.querySelector("#list-status").textContent.includes("Sample list save failure")'));
    assert.equal(await evaluate('document.querySelector("#list-status").dataset.state'), 'error');
    assert.equal(await evaluate('document.querySelector("#list-add-form [name=name]").value'), 'Eggs <img src=x>');
    failListSave = false; await click('#list-add-form button');
    await until(() => evaluate('document.querySelectorAll("[data-list-item]").length === 3'));
    assert.equal(await evaluate('document.querySelector("#list-status").dataset.state'), 'ready');
    assert.equal(await evaluate('document.querySelectorAll("#list-items img").length'), 0);
    assert.equal(await evaluate('document.querySelector("#list-add-form [name=name]").value'), '');
    listStale = true; await click('#list-refresh');
    await until(() => evaluate('document.querySelector(".connection-status").dataset.state === "stale"'));
    assert.match(await evaluate('document.querySelector(".connection-status").textContent'), /not refreshed/);
    listStale = false; await click('#list-refresh');
    await until(() => evaluate('document.querySelector(".connection-status").dataset.state === "ready"'));
    await click('[data-list-item="milk"]');
    await until(() => evaluate(`!!document.querySelector('[aria-label="Delete completed item Milk"]')`));
    acceptDialog = true; await click('[aria-label="Delete completed item Milk"]'); acceptDialog = false;
    await until(() => evaluate('!document.querySelector("[data-list-item=milk]")'));
    assert.equal(listItems.some(item => item.id === 'milk'), false);
  });

  await t.test('calendar remains within the viewport after the sidebar change', async () => {
    await click('[data-nav="calendar"]');
    await until(() => evaluate('document.querySelector("#clock").textContent.length > 0'));
    for (const width of [390, 760, 800, 1024, 1440, 1920]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await until(() => evaluate(`innerWidth === ${width}`));
      const layout = await evaluate('(()=>{const overflow=document.documentElement.scrollWidth>innerWidth;return {innerWidth,bodyView:document.body.dataset.view,app:document.querySelector("#app").getBoundingClientRect().toJSON(),layout:document.querySelector(".layout").getBoundingClientRect().toJSON(),overflow,wide:overflow?[...document.querySelectorAll("#app *")].filter(node=>{const rect=node.getBoundingClientRect();return rect.width && rect.right>innerWidth+1}).slice(0,12).map(node=>({tag:node.tagName,id:node.id,classes:node.className,right:node.getBoundingClientRect().right})):[]};})()');
      assert.equal(layout.overflow, false, `Calendar overflow at ${width}: ${JSON.stringify(layout)}`);
      assert.equal(await evaluate('getComputedStyle(document.querySelector("#shared-list")).display'), 'none');
    }
  });

  await t.test('paired-display Lists has add/check controls but no delete controls', async () => {
    displayMode = true;
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/?paired-test=1#lists` });
    await until(() => evaluate('document.body.dataset.view === "lists" && document.querySelector("#identity").textContent.includes("paired display") && !!document.querySelector("[data-list-item=bread]")'));
    assert.equal(await evaluate('document.querySelectorAll("#list-items button").length'), 0);
    assert.equal(await evaluate('document.querySelector("#list-add-form").hidden'), false);
    await click('[data-list-item="bread"]');
    await until(() => listItems.find(item => item.id === 'bread').checked === false);
    await until(() => evaluate('!document.querySelector("#shared-list").hasAttribute("aria-busy")'));
    await fill('#list-add-form [name=name]', 'Apples'); await click('#list-add-form button');
    await until(() => listItems.some(item => item.name === 'Apples'));
    assert.equal(await evaluate('document.querySelectorAll("#list-items button").length'), 0);
  });
  await t.test('paired-display keyboard supports typing, shift, symbols, deletion and other text fields', async () => {
    await evaluate('document.querySelector("#list-add-form [name=name]").focus()');
    await until(() => evaluate('!document.querySelector("#kiosk-keyboard").hidden'));
    assert.ok(await evaluate('parseFloat(getComputedStyle(document.querySelector("[data-kiosk-key=a]")).minHeight) >= 54'), 'On-screen keys should have more vertical height');
    await fill('#list-add-form [name=name]', '');
    await click('[data-kiosk-key="Shift"]'); await click('[data-kiosk-key="a"]');
    await click('[data-kiosk-key="Symbols"]'); await click('[data-kiosk-key="1"]');
    await click('[data-kiosk-key="Backspace"]'); await click('[data-kiosk-key="2"]');
    assert.equal(await evaluate('document.querySelector("#list-add-form [name=name]").value'), 'A2');
    assert.equal(await evaluate('document.activeElement.name'), 'name');
    await click('[data-kiosk-key="Done"]');
    assert.equal(await evaluate('document.querySelector("#kiosk-keyboard").hidden'), true);
    await evaluate('(()=>{const input=document.createElement("input");input.id="kiosk-sample";input.setAttribute("aria-label","Sample text field");document.querySelector("#app").append(input);input.focus()})()');
    await until(() => evaluate('!document.querySelector("#kiosk-keyboard").hidden'));
    await click('[data-kiosk-key="b"]');
    assert.equal(await evaluate('document.querySelector("#kiosk-sample").value'), 'b');
    await evaluate('(()=>{const input=document.createElement("input");input.type="password";input.id="kiosk-password-sample";document.querySelector("#app").append(input);input.focus()})()');
    assert.equal(await evaluate('document.querySelector("#kiosk-keyboard").hidden'), true);
    await evaluate('document.querySelector("#kiosk-sample").remove();document.querySelector("#kiosk-password-sample").remove()');
    for (const width of [390, 760, 1024, 1920]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await evaluate('document.querySelector("#list-add-form [name=name]").focus()');
      await until(() => evaluate('!document.querySelector("#kiosk-keyboard").hidden'));
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false, `Keyboard overflow at ${width}`);
      await click('[data-kiosk-key="Done"]');
    }
  });

  await t.test('multiple lists use columns or tabs and keep drafts and targeted writes separate', async () => {
    anylist.listIds = ['groceries', 'household', 'pharmacy'];
    await click('#list-refresh');
    await until(() => evaluate('document.querySelectorAll(".shared-list-panel").length === 3'));
    await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1000, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate('document.querySelector("#list-tabs").hidden'), true);
    assert.equal(await evaluate('document.querySelector("#list-panels").dataset.mode'), 'columns');
    assert.equal(await evaluate('[...document.querySelectorAll(".shared-list-panel")].filter(panel=>!panel.hidden).length'), 3);
    await fill('[data-list-add="groceries"] [name=name]', 'Unfinished groceries');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until(() => evaluate('document.querySelector("#list-panels").dataset.mode === "tabs"'));
    assert.equal(await evaluate('document.querySelector("#list-tabs").hidden'), false);
    await click('[data-list-tab="household"]');
    await fill('[data-list-add="household"] [name=name]', 'Unfinished household');
    await click('#list-refresh');
    await until(() => evaluate('!document.querySelector("#shared-list").hasAttribute("aria-busy")'));
    assert.equal(await evaluate('document.querySelector("[data-list-add=household] [name=name]").value'), 'Unfinished household');
    await click('[data-list-tab="groceries"]');
    assert.equal(await evaluate('document.querySelector("[data-list-add=groceries] [name=name]").value'), 'Unfinished groceries');
    anylist.listIds.push('tools'); await click('#list-refresh');
    await until(() => evaluate('document.querySelectorAll(".shared-list-panel").length === 4'));
    await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1000, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate('document.querySelector("#list-tabs").hidden'), false);
    assert.equal(await evaluate('[...document.querySelectorAll(".shared-list-panel")].filter(panel=>!panel.hidden).length'), 1);
    await click('[data-list-tab="household"]');
    await fill('[data-list-add="household"] [name=name]', 'Batteries');
    await click('[data-list-add="household"] button');
    await until(() => extraItems.get('household').some(item => item.name === 'Batteries'));
    assert.equal(listItems.some(item => item.name === 'Batteries'), false);
    await until(() => evaluate('!document.querySelector("#shared-list").hasAttribute("aria-busy")'));
    for (const width of [390, 760, 1024, 1440, 1920]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false, `Multiple list overflow at ${width}`);
    }
    await click('[data-kiosk-key="Done"]');
  });

  await t.test('paired Lists returns to Calendar after idle time, respects movement, and preserves drafts', async () => {
    await click('[data-list-tab="groceries"]');
    await fill('[data-list-add="groceries"] [name=name]', 'Keep this draft');
    await evaluate('document.querySelector("[data-list-add=groceries] [name=name]").focus()');
    await advanceTime(59000);
    await evaluate('document.dispatchEvent(new PointerEvent("pointermove",{bubbles:true}))');
    assert.equal(await evaluate('document.body.dataset.view'), 'lists');
    await advanceTime(59000);
    assert.equal(await evaluate('document.body.dataset.view'), 'lists');
    await advanceTime(2000);
    await until(() => evaluate('document.body.dataset.view === "calendar"'));
    assert.equal(await evaluate('document.querySelector("#kiosk-keyboard").hidden'), true);
    assert.equal(await evaluate('document.querySelector("[data-list-add=groceries] [name=name]").value'), 'Keep this draft');
    await click('[data-nav="lists"]');
    assert.equal(await evaluate('document.querySelector("[data-list-add=groceries] [name=name]").value'), 'Keep this draft');
  });

  await t.test('task screens keep management sections collapsed until requested', async () => {
    await click('[data-nav="chores"]');
    await until(() => evaluate('document.body.dataset.view === "chores"'));
    assert.equal(await evaluate('[...document.querySelectorAll("[data-view=chores] details")].find(node=>node.querySelector("summary").textContent === "All chores").open'), false);
    assert.match(await evaluate('document.querySelector("[data-chore]").parentElement.textContent'), /Set the table/);
    await evaluate('[...document.querySelectorAll("[data-view=chores] details")].find(node=>node.querySelector("summary").textContent === "All chores").querySelector("summary").click()');
    assert.equal(await evaluate('[...document.querySelectorAll("[data-view=chores] details")].find(node=>node.querySelector("summary").textContent === "All chores").open'), true);
    await click('[data-nav="routines"]');
    await until(() => evaluate('document.body.dataset.view === "routines"'));
    assert.equal(await evaluate('[...document.querySelectorAll("[data-view=routines] details")].find(node=>node.querySelector("summary").textContent === "All routines").open'), false);
    assert.match(await evaluate('document.querySelector("[data-routine]").parentElement.textContent'), /Read together/);
  });

  await t.test('device palette picker applies all themes, preserves dark mode, and restores household default', async () => {
    await click('[data-nav="calendar"]');
    await click('#appearance-menu-button');
    assert.equal(await evaluate('document.body.dataset.view'), 'calendar', 'Opening the palette must not navigate away from Calendar');
    assert.equal(await evaluate('document.querySelector("#appearance-dialog").open'), true);
    assert.equal(await evaluate('document.querySelector("#theme-household-default").getAttribute("aria-pressed")'), 'true');
    const cardDesign = await evaluate('(()=>{const card=document.querySelector("[data-device-theme=green]"),circles=[...card.querySelectorAll(".palette-preview i")].map(node=>node.getBoundingClientRect()),layers=[...card.querySelectorAll(".palette-preview i")].map(node=>Number(getComputedStyle(node).zIndex)),style=getComputedStyle(card);return {background:style.backgroundColor,radius:style.borderRadius,overlapOne:circles[0].right>circles[1].left,overlapTwo:circles[1].right>circles[2].left,layers}})()');
    assert.equal(cardDesign.background, 'rgb(234, 241, 236)'); assert.equal(cardDesign.radius, '13px');
    assert.equal(cardDesign.overlapOne, true); assert.equal(cardDesign.overlapTwo, true);
    assert.deepEqual(cardDesign.layers, [0, 1, 2]);
    const lightAccents = {};
    const themes = ['green', 'slate', 'blue', 'warm', 'teal', 'purple', 'rose', 'ocean', 'forest', 'midnight', 'sunset', 'monochrome', 'lavender', 'coral', 'berry', 'sand'];
    assert.equal(await evaluate('document.querySelectorAll("[data-device-theme]").length'), 16);
    const roleContrast = async () => evaluate(`(()=>{const panel=document.createElement('section');panel.className='settings-panel';panel.innerHTML='<form class="settings-form"><label>Sample label<input value="Sample value"></label></form><span class="muted">Muted text</span><p class="form-status error">Sample error</p><p id="list-status" data-state="error">List error</p><p class="connection-status" data-state="stale">List is stale</p><button style="outline:3px solid var(--focus)">Focus</button>';document.body.append(panel);const rgb=value=>{const mixed=value.match(/color\\(srgb ([^)]+)\\)/),channels=(mixed?mixed[1]:value.match(/rgba?\\(([^)]+)\\)/)[1]).match(/[\\d.]+/g).slice(0,3).map(Number);return mixed?channels.map(channel=>channel*255):channels},luminance=value=>{const c=rgb(value).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2]},contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)},surface=getComputedStyle(panel).backgroundColor,label=getComputedStyle(panel.querySelector('label')),input=getComputedStyle(panel.querySelector('input')),muted=getComputedStyle(panel.querySelector('.muted')),error=getComputedStyle(panel.querySelector('.form-status')),listError=getComputedStyle(panel.querySelector('#list-status')),stale=getComputedStyle(panel.querySelector('.connection-status')),focus=getComputedStyle(panel.querySelector('button'));const result={muted:contrast(muted.color,surface),label:contrast(label.color,surface),input:contrast(input.color,input.backgroundColor),error:contrast(error.color,error.backgroundColor),listError:contrast(listError.color,listError.backgroundColor),stale:contrast(stale.color,stale.backgroundColor),focus:contrast(focus.outlineColor,surface)};panel.remove();return result})()`);
    for (const theme of themes) {
      await click(`[data-device-theme="${theme}"]`);
      const values = await evaluate(`(()=>{const root=getComputedStyle(document.documentElement),button=getComputedStyle(document.querySelector("#theme-toggle"));return {theme:document.body.dataset.theme,accent:root.getPropertyValue("--accent").trim(),muted:root.getPropertyValue("--muted").trim(),focus:getComputedStyle(document.querySelector("#today")).outlineColor,header:getComputedStyle(document.querySelector("header")).backgroundColor,preview:getComputedStyle(document.querySelector(".palette-${theme}")).backgroundColor,device:localStorage.getItem("family-hub-device-theme")}})()`);
      assert.equal(values.theme, theme); assert.equal(values.device, theme);
      assert.ok(values.accent && values.muted && values.focus && values.header && values.preview);
      const contrast = await roleContrast();
      assert.ok(contrast.muted >= 4.5, `${theme} muted text contrast: ${contrast.muted}`);
      assert.ok(contrast.label >= 4.5, `${theme} settings label contrast: ${contrast.label}`);
      assert.ok(contrast.input >= 4.5, `${theme} input text contrast: ${contrast.input}`);
      assert.ok(contrast.error >= 4.5, `${theme} settings error contrast: ${contrast.error}`);
      assert.ok(contrast.listError >= 4.5, `${theme} list error contrast: ${contrast.listError}`);
      assert.ok(contrast.stale >= 4.5, `${theme} stale-list contrast: ${contrast.stale}`);
      assert.ok(contrast.focus >= 3, `${theme} focus outline contrast: ${contrast.focus}`);
      lightAccents[theme] = values.accent;
    }
    assert.equal(new Set(Object.values(lightAccents)).size, 16);
    for (const width of [390, 760, 1024, 1440, 1920]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false, `Appearance overflow at ${width}px`);
      assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-device-theme=blue]")).display !== "none"'), true);
    }
    await click('#theme-toggle');
    assert.equal(await evaluate('document.body.classList.contains("display-dim")'), true);
    const darkAccents = {};
    for (const theme of themes) {
      await click(`[data-device-theme="${theme}"]`);
      const dark = await evaluate(`(()=>{const root=getComputedStyle(document.documentElement),holder=document.createElement("div");holder.innerHTML='<div class="day today">Today</div><button class="event">Event</button><button class="agenda-event">Agenda</button>';document.body.append(holder);const rgb=value=>{const mixed=value.match(/color\\(srgb ([^)]+)\\)/),channels=(mixed?mixed[1]:value.match(/rgba?\\(([^)]+)\\)/)[1]).match(/[\\d.]+/g).slice(0,3).map(Number);return mixed?channels.map(channel=>channel*255):channels},luminance=value=>{const c=rgb(value).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2]},contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)},event=getComputedStyle(holder.querySelector('.event')),agenda=getComputedStyle(holder.querySelector('.agenda-event')),today=getComputedStyle(holder.querySelector('.day.today')),palette=document.querySelector('[data-device-theme="${theme}"]'),paletteStyle=getComputedStyle(palette),paletteDots=[...palette.querySelectorAll('.palette-preview i')].map(node=>getComputedStyle(node).backgroundColor),result={theme:document.body.dataset.theme,accent:root.getPropertyValue('--accent').trim(),muted:getComputedStyle(document.querySelector('.muted')).color,header:getComputedStyle(document.querySelector('header')).backgroundColor,primary:getComputedStyle(document.querySelector('.primary')).backgroundColor,focus:getComputedStyle(document.querySelector('#today')).outlineColor,backdrop:getComputedStyle(document.querySelector('dialog')).boxShadow,eventContrast:contrast(event.color,event.backgroundColor),eventColor:event.color,eventBackground:event.backgroundColor,agendaContrast:contrast(agenda.color,agenda.backgroundColor),todayContrast:contrast(today.color,today.backgroundColor),paletteBackgroundLuminance:luminance(paletteStyle.backgroundColor),paletteTextContrast:contrast(paletteStyle.color,paletteStyle.backgroundColor),paletteFirstDot:paletteDots[0]};holder.remove();return result})()`);
      assert.equal(dark.theme, theme); assert.ok(dark.accent && dark.muted && dark.header && dark.primary && dark.focus && dark.backdrop);
      assert.ok(dark.eventContrast >= 4.5, `${theme} event text contrast: ${dark.eventContrast} (${dark.eventColor} on ${dark.eventBackground})`);
      assert.ok(dark.agendaContrast >= 4.5, `${theme} agenda text contrast: ${dark.agendaContrast}`);
      assert.ok(dark.todayContrast >= 4.5, `${theme} today text contrast: ${dark.todayContrast}`);
      assert.ok(dark.paletteBackgroundLuminance < 0.08, `${theme} palette card should preview dark colors: ${dark.paletteBackgroundLuminance}`);
      assert.ok(dark.paletteTextContrast >= 4.5, `${theme} dark palette label contrast: ${dark.paletteTextContrast}`);
      const contrast = await roleContrast();
      assert.ok(contrast.muted >= 4.5, `${theme} dark muted text contrast: ${contrast.muted}`);
      assert.ok(contrast.label >= 4.5, `${theme} dark settings label contrast: ${contrast.label}`);
      assert.ok(contrast.input >= 4.5, `${theme} dark input text contrast: ${contrast.input}`);
      assert.ok(contrast.error >= 4.5, `${theme} dark settings error contrast: ${contrast.error}`);
      assert.ok(contrast.listError >= 4.5, `${theme} dark list error contrast: ${contrast.listError}`);
      assert.ok(contrast.stale >= 4.5, `${theme} dark stale-list contrast: ${contrast.stale}`);
      assert.ok(contrast.focus >= 3, `${theme} dark focus outline contrast: ${contrast.focus}`);
      darkAccents[theme] = dark.accent;
    }
    assert.equal(new Set(Object.values(darkAccents)).size, 16, 'dark accents retain each palette color');
    for (const width of [390, 1440]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false, `dark calendar overflow at ${width}px`);
    }
    await click('#theme-household-default');
    assert.equal(await evaluate('document.body.dataset.theme'), 'green');
    assert.equal(await evaluate('localStorage.getItem("family-hub-device-theme")'), null);
    assert.equal(await evaluate('document.body.classList.contains("display-dim")'), true);
    await click('#appearance-close');
    assert.equal(await evaluate('document.querySelector("#appearance-dialog").open'), false);
    await click('#theme-toggle');
    assert.equal(await evaluate('document.body.classList.contains("display-dim")'), false);
    assert.deepEqual(exceptions, []);
  });
  assert.deepEqual(exceptions, []);
});
