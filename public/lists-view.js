const $ = selector => document.querySelector(selector);

/** Build selected-list panels, draft-preserving add forms, and adult connection settings. */
export function createListsView({ api, settingsForms, getMe }) {
  let busy = false, loading = false, refreshAgain = false, revision = 0, saved, activeId, nextPanel = 0;
  const panels = new Map(), drafts = new Map(), wide = matchMedia('(min-width:1000px)');
  const adult = () => getMe()?.user?.role === 'adult';
  const status = message => { $('#list-status').textContent = message; };
  const endpoint = listId => `/api/lists/anylist/${encodeURIComponent(listId)}/items`;

  function layout() {
    const entries = [...panels.values()], tabbed = entries.length > 1 && (!wide.matches || entries.length > 3);
    if (!panels.has(activeId)) activeId = panels.keys().next().value;
    $('#list-tabs').hidden = !tabbed;
    $('#list-panels').dataset.mode = tabbed ? 'tabs' : 'columns';
    $('#list-panels').style.setProperty('--list-columns', String(Math.max(1, entries.length)));
    for (const [id, panel] of panels) {
      const selected = id === activeId;
      panel.tab.classList.toggle('active', selected); panel.tab.setAttribute('aria-selected', String(selected)); panel.tab.tabIndex = selected ? 0 : -1;
      panel.root.hidden = tabbed && !selected;
      panel.root.setAttribute('role', tabbed ? 'tabpanel' : 'region');
      panel.root.setAttribute('aria-labelledby', tabbed ? panel.tab.id : panel.heading.id);
    }
  }

  function createPanel(list) {
    const index = nextPanel++, root = document.createElement('section'); root.className = 'shared-list-panel'; root.dataset.listId = list.id; root.id = `shared-list-${index}`;
    const heading = document.createElement('h3'); heading.id = `shared-list-heading-${index}`;
    const connection = document.createElement('p'); connection.className = 'connection-status'; connection.setAttribute('role', 'status');
    const form = document.createElement('form'); form.className = 'list-add-form'; form.dataset.listAdd = list.id;
    const label = document.createElement('label'); label.append('New item');
    const input = document.createElement('input'); input.name = 'name'; input.maxLength = 500; input.autocomplete = 'off'; input.required = true; input.dataset.listDraft = list.id;
    input.value = drafts.get(list.id) || ''; input.oninput = () => drafts.set(list.id, input.value);
    label.append(input); const add = document.createElement('button'); add.textContent = 'Add item'; form.append(label, add);
    form.onsubmit = event => {
      event.preventDefault(); const name = input.value;
      action(async () => { const data = await api(endpoint(list.id), { method: 'POST', body: JSON.stringify({ name }) }); drafts.delete(list.id); input.value = ''; return data; }, input);
    };
    const items = document.createElement('div'); items.className = 'list-items';
    if (!panels.size) { form.id = 'list-add-form'; items.id = 'list-items'; }
    root.append(heading, connection, form, items);
    const tab = document.createElement('button'); tab.type = 'button'; tab.dataset.listTab = list.id; tab.id = `shared-list-tab-${index}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', root.id);
    tab.onclick = () => { activeId = list.id; layout(); };
    tab.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const ids = [...panels.keys()], position = ids.indexOf(list.id);
      activeId = event.key === 'Home' ? ids[0] : event.key === 'End' ? ids.at(-1) : ids[(position + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length];
      layout(); panels.get(activeId).tab.focus();
    };
    return { root, heading, connection, form, input, items, tab };
  }

  function render(data) {
    saved = data;
    const focused = document.activeElement, focusList = focused?.closest('[data-list-id]')?.dataset.listId, focusItem = focused?.dataset.listItem;
    const lists = data.enabled ? data.lists : [];
    $('#list-name').textContent = lists.length === 1 ? lists[0].name : 'Lists';
    status(!lists.length ? 'No shared lists are enabled. An adult can connect AnyList in Settings → Integrations.' : 'AnyList is the source of truth.');
    for (const [id, panel] of panels) if (!lists.some(list => list.id === id)) {
      drafts.set(id, panel.input.value); panel.root.remove(); panel.tab.remove(); panels.delete(id);
    }
    for (const list of lists) {
      let panel = panels.get(list.id);
      if (!panel) { panel = createPanel(list); panels.set(list.id, panel); }
      panel.heading.textContent = list.name; panel.tab.textContent = list.name;
      panel.connection.textContent = list.stale ? 'Showing saved items. This list has not refreshed. Ask an adult to check the connection.' : list.lastSuccessAt ? `Updated ${new Date(list.lastSuccessAt).toLocaleString()}` : 'Waiting for an update.';
      panel.items.replaceChildren();
      for (const checked of [false, true]) {
        const items = list.items.filter(item => item.checked === checked);
        if (!items.length) continue;
        const heading = document.createElement('h4'); heading.textContent = checked ? 'Completed' : 'To buy'; panel.items.append(heading);
        for (const item of items) {
          const row = document.createElement('div'); row.className = 'check-row list-row';
          const label = document.createElement('label'), input = document.createElement('input'), copy = document.createElement('span');
          input.type = 'checkbox'; input.checked = checked; input.dataset.listItem = item.id;
          const quantity = [item.quantity, item.quantityUnit].filter(Boolean).join(' ');
          copy.textContent = `${quantity ? `${quantity} ` : ''}${item.name}`;
          if (item.notes) { const note = document.createElement('small'); note.className = 'muted'; note.textContent = item.notes; copy.append(note); }
          label.append(input, copy); row.append(label);
          input.onchange = () => action(() => api(`${endpoint(list.id)}/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ checked: input.checked }) }));
          if (checked && adult()) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'adult-only'; button.textContent = 'Delete'; button.setAttribute('aria-label', `Delete completed item ${item.name}`);
            button.onclick = () => { if (confirm(`Delete completed item “${item.name}” from ${list.name} in AnyList?`)) action(() => api(`${endpoint(list.id)}/${encodeURIComponent(item.id)}`, { method: 'DELETE' })); };
            row.append(button);
          }
          panel.items.append(row);
        }
      }
      if (!list.items.length) { const message = document.createElement('p'); message.textContent = 'The list is empty. Add an item above.'; panel.items.append(message); }
      // Avoid moving the focused add form: doing so would close the kiosk keyboard.
      if (panel.root.parentElement !== $('#list-panels')) $('#list-panels').append(panel.root);
      if (panel.tab.parentElement !== $('#list-tabs')) $('#list-tabs').append(panel.tab);
    }
    const ordered = lists.map(list => [list.id, panels.get(list.id)]);
    panels.clear();
    ordered.forEach(([id, panel], index) => {
      panels.set(id, panel);
      panel.form.id = index === 0 ? 'list-add-form' : `${panel.root.id}-add`;
      panel.items.id = index === 0 ? 'list-items' : `${panel.root.id}-items`;
      if ($('#list-panels').children[index] !== panel.root) $('#list-panels').insertBefore(panel.root, $('#list-panels').children[index] || null);
      if ($('#list-tabs').children[index] !== panel.tab) $('#list-tabs').insertBefore(panel.tab, $('#list-tabs').children[index] || null);
    });
    layout();
    if (focusItem && panels.has(focusList)) [...panels.get(focusList).items.querySelectorAll('[data-list-item]')].find(input => input.dataset.listItem === focusItem)?.focus({ preventScroll: true });
  }

  async function action(work, returnFocus) {
    if (busy) return;
    const focused = returnFocus || document.activeElement;
    busy = true; revision++; $('#shared-list').setAttribute('aria-busy', 'true');
    for (const control of document.querySelectorAll('#shared-list input,#shared-list button')) control.disabled = true;
    status('Saving to AnyList…');
    try { render(await work()); }
    catch (error) { if (saved) render(saved); status(error.message); }
    finally {
      busy = false; $('#shared-list').removeAttribute('aria-busy');
      for (const control of document.querySelectorAll('#shared-list input,#shared-list button')) control.disabled = false;
      if (focused?.isConnected && focused.getClientRects().length) focused.focus({ preventScroll: true });
      if (refreshAgain) { refreshAgain = false; refresh(); }
    }
  }

  async function refresh(force = false) {
    if (busy || loading) { refreshAgain = true; return; }
    loading = true; const version = revision;
    if (!saved) status('Loading lists…');
    try { const data = await api(`/api/lists/anylist${force ? '?refresh=1' : ''}`); if (!busy && version === revision) render(data); }
    catch (error) { if (!busy && version === revision) status(error.message); }
    finally { loading = false; if (refreshAgain) { refreshAgain = false; refresh(); } }
  }

  function clearDrafts() {
    drafts.clear(); for (const panel of panels.values()) panel.input.value = '';
    revision++; saved = undefined;
  }

  function renderSettings(data) {
    const connect = $('#anylist-connect-form'), configure = $('#anylist-config-form');
    $('#anylist-status').textContent = !data.keyReady ? 'Host setup needed: set FAMILY_HUB_INTEGRATION_KEY before connecting.' : !data.connected ? 'Not connected.' : `${data.state === 'disabled' ? 'Disabled' : data.state === 'error' ? 'Update failed. Check the connection or reconnect.' : 'Connected'}${data.lastSuccessAt ? ` · Last updated ${new Date(data.lastSuccessAt).toLocaleString()}` : ''}. AnyList is the source of truth.`;
    if (!settingsForms.busy(connect)) { for (const field of connect.elements) field.disabled = !data.keyReady; settingsForms.update(connect); }
    configure.hidden = !data.connected; $('#anylist-actions').hidden = !data.connected;
    if (!settingsForms.dirty(configure) && !settingsForms.busy(configure)) {
      const choices = $('#anylist-list-choices'), ids = data.listIds;
      choices.replaceChildren();
      const lists = [...data.lists, ...ids.filter(id => !data.lists.some(list => list.id === id)).map(id => ({ id, name: `Unavailable list (${id})` }))];
      for (const list of lists) {
        const label = document.createElement('label'); label.className = 'check-label';
        const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'listIds'; input.value = list.id; input.checked = ids.includes(list.id);
        label.append(input, document.createTextNode(list.name)); choices.append(label);
      }
      configure.elements.enabled.checked = data.enabled; settingsForms.mark(configure);
    }
  }

  async function settings() {
    if (!adult()) return;
    let form = $('#anylist-connect-form');
    if (!form) {
      const root = $('#settings-panel-integrations');
      root.innerHTML = '<h3>AnyList</h3><p>Share grocery or household lists. Adults and paired displays can add and check items. Only adults can delete completed items.</p><p class="muted">This is an unofficial connection. Only selected lists’ items are saved. Your password is used for sign-in and is not saved.</p><p id="anylist-status" role="status">Loading connection…</p><form id="anylist-connect-form" class="settings-form"><label>AnyList email<input name="email" type="email" maxlength="254" autocomplete="username" required></label><label>AnyList password<input name="password" type="password" maxlength="4096" autocomplete="current-password" required></label><button>Connect / reconnect</button></form><form id="anylist-config-form" class="settings-form" hidden><fieldset><legend>Shared lists</legend><div id="anylist-list-choices"></div></fieldset><p class="muted">Up to three lists appear together on wide screens. Larger selections and phones use tabs.</p><label class="check-label"><input name="enabled" type="checkbox"> Enable shared lists</label><button>Save list settings</button></form><div id="anylist-actions" class="screen-card-actions" hidden><button id="anylist-discover" type="button">Refresh available lists</button><button id="anylist-disconnect" type="button">Disconnect AnyList</button></div>';
      form = $('#anylist-connect-form');
      form.onsubmit = event => {
        event.preventDefault(); settingsForms.run(form, async () => {
          const data = await api('/api/integrations/anylist/connect', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
          form.reset(); settingsForms.mark($('#anylist-config-form')); renderSettings(data); clearDrafts(); await refresh();
        });
      };
      const configure = $('#anylist-config-form');
      configure.onsubmit = event => {
        event.preventDefault(); settingsForms.run(configure, async () => {
          const listIds = [...configure.querySelectorAll('[name=listIds]:checked')].map(input => input.value);
          const data = await api('/api/integrations/anylist', { method: 'PUT', body: JSON.stringify({ listIds, enabled: configure.elements.enabled.checked }) });
          renderSettings(data); revision++; saved = undefined; await refresh();
        });
      };
      const control = (selector, work) => { $(selector).onclick = async () => {
        const button = $(selector); if (button.disabled || !settingsForms.guard(root)) return;
        button.disabled = true; root.setAttribute('aria-busy', 'true');
        try { await work(); } catch (error) { $('#anylist-status').textContent = error.message; }
        finally { button.disabled = false; root.removeAttribute('aria-busy'); }
      }; };
      control('#anylist-discover', async () => renderSettings(await api('/api/integrations/anylist/refresh', { method: 'POST' })));
      control('#anylist-disconnect', async () => {
        if (!confirm('Disconnect AnyList and remove saved tokens and list data from Family Hub?')) return;
        await api('/api/integrations/anylist', { method: 'DELETE' });
        configure.reset(); settingsForms.mark(configure); form.reset(); settingsForms.mark(form);
        await settings(); clearDrafts(); await refresh();
      });
      settingsForms.watch(root);
    }
    try { renderSettings(await api('/api/integrations/anylist')); }
    catch (error) { $('#anylist-status').textContent = `${error.message} Reopen Integrations to retry.`; }
  }

  wide.addEventListener('change', layout);
  $('#list-refresh').onclick = () => refresh(true);
  setInterval(() => { if (document.body.dataset.view === 'lists' && !$('#app').hidden) refresh(); }, 60000);
  return { refresh, settings, isBusy: () => busy };
}
