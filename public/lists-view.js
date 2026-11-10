const $ = selector => document.querySelector(selector);

/** Build the shared-list view and adult-only connection forms without exposing provider credentials. */
export function createListsView({ api, settingsForms, getMe }) {
  let busy = false, loading = false, refreshAgain = false, revision = 0, saved;
  const adult = () => getMe()?.user?.role === 'adult';
  const status = message => { $('#list-status').textContent = message; };

  function render(data) {
    saved = data;
    const focused = document.activeElement?.dataset.listItem;
    $('#list-name').textContent = data.enabled ? data.name : 'Lists';
    $('#list-add-form').hidden = !data.enabled;
    $('#list-items').replaceChildren();
    status(!data.enabled ? 'No shared list is enabled. An adult can connect AnyList in Settings → Integrations.' : data.stale ? 'Showing saved items. AnyList has not refreshed. Ask an adult to check the connection.' : data.lastSuccessAt ? `Updated ${new Date(data.lastSuccessAt).toLocaleString()} · AnyList is the source of truth.` : 'AnyList is the source of truth.');
    if (!data.enabled) return;
    for (const checked of [false, true]) {
      const items = data.items.filter(item => item.checked === checked);
      if (!items.length) continue;
      const heading = document.createElement('h3'); heading.textContent = checked ? 'Completed' : 'To buy';
      $('#list-items').append(heading);
      for (const item of items) {
        const row = document.createElement('div'); row.className = 'check-row list-row';
        const label = document.createElement('label'), input = document.createElement('input'), copy = document.createElement('span');
        input.type = 'checkbox'; input.checked = checked; input.dataset.listItem = item.id;
        const quantity = [item.quantity, item.quantityUnit].filter(Boolean).join(' ');
        copy.textContent = `${quantity ? `${quantity} ` : ''}${item.name}`;
        if (item.notes) { const note = document.createElement('small'); note.className = 'muted'; note.textContent = item.notes; copy.append(note); }
        label.append(input, copy); row.append(label);
        input.onchange = () => action(async () => api(`/api/lists/anylist/items/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ checked: input.checked }) }));
        if (checked && adult()) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'adult-only'; button.textContent = 'Delete'; button.setAttribute('aria-label', `Delete completed item ${item.name}`);
          button.onclick = () => { if (confirm(`Delete completed item “${item.name}” from AnyList?`)) action(() => api(`/api/lists/anylist/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' })); };
          row.append(button);
        }
        $('#list-items').append(row);
      }
    }
    if (!data.items.length) { const message = document.createElement('p'); message.textContent = 'The list is empty. Add an item above.'; $('#list-items').append(message); }
    if (focused) [...document.querySelectorAll('[data-list-item]')].find(input => input.dataset.listItem === focused)?.focus();
  }

  async function action(work) {
    if (busy) return;
    busy = true; revision++; $('#shared-list').setAttribute('aria-busy', 'true');
    for (const control of document.querySelectorAll('#shared-list input,#shared-list button')) control.disabled = true;
    status('Saving to AnyList…');
    try { render(await work()); }
    catch (error) { if (saved) render(saved); status(error.message); }
    finally {
      busy = false; $('#shared-list').removeAttribute('aria-busy');
      for (const control of document.querySelectorAll('#shared-list input,#shared-list button')) control.disabled = false;
      if (refreshAgain) { refreshAgain = false; refresh(); }
    }
  }

  async function refresh(force = false) {
    if (busy) { refreshAgain = true; return; }
    if (loading) { refreshAgain = true; return; }
    loading = true;
    const version = revision;
    if (!saved) status('Loading list…');
    try { const data = await api(`/api/lists/anylist${force ? '?refresh=1' : ''}`); if (!busy && version === revision) render(data); }
    catch (error) { if (!busy && version === revision) status(error.message); }
    finally { loading = false; if (refreshAgain) { refreshAgain = false; refresh(); } }
  }

  function renderSettings(data) {
    const connect = $('#anylist-connect-form'), configure = $('#anylist-config-form');
    $('#anylist-status').textContent = !data.keyReady ? 'Host setup needed: set FAMILY_HUB_INTEGRATION_KEY before connecting.' : !data.connected ? 'Not connected.' : `${data.state === 'disabled' ? 'Disabled' : data.state === 'error' ? 'Update failed. Check the connection or reconnect.' : 'Connected'}${data.lastSuccessAt ? ` · Last updated ${new Date(data.lastSuccessAt).toLocaleString()}` : ''}. AnyList is the source of truth.`;
    if (!settingsForms.busy(connect)) {
      for (const field of connect.elements) field.disabled = !data.keyReady;
      settingsForms.update(connect);
    }
    configure.hidden = !data.connected;
    $('#anylist-actions').hidden = !data.connected;
    if (!settingsForms.dirty(configure) && !settingsForms.busy(configure)) {
      const select = configure.elements.listId; select.replaceChildren(new Option('Select a list', ''));
      for (const list of data.lists) select.add(new Option(list.name, list.id));
      select.value = data.listId; configure.elements.enabled.checked = data.enabled;
      settingsForms.mark(configure);
    }
  }

  async function settings() {
    if (!adult()) return;
    let form = $('#anylist-connect-form');
    if (!form) {
      const root = $('#settings-panel-integrations');
      root.innerHTML = '<h3>AnyList</h3><p>Share one grocery or household list. Adults and paired displays can add and check items. Only adults can delete completed items.</p><p class="muted">This is an unofficial connection. AnyList sends an account response to the server; only shopping-list fields are decoded, and only the selected list’s items are saved. Your password is used for sign-in and is not saved.</p><p id="anylist-status" role="status">Loading connection…</p><form id="anylist-connect-form" class="settings-form"><label>AnyList email<input name="email" type="email" maxlength="254" autocomplete="username" required></label><label>AnyList password<input name="password" type="password" maxlength="4096" autocomplete="current-password" required></label><button>Connect / reconnect</button></form><form id="anylist-config-form" class="settings-form" hidden><label>Shared list<select name="listId"></select></label><label class="check-label"><input name="enabled" type="checkbox"> Enable shared list</label><button>Save list settings</button></form><div id="anylist-actions" class="screen-card-actions" hidden><button id="anylist-discover" type="button">Refresh available lists</button><button id="anylist-disconnect" type="button">Disconnect AnyList</button></div>';
      form = $('#anylist-connect-form');
      form.onsubmit = event => {
        event.preventDefault();
        settingsForms.run(form, async () => {
          const data = await api('/api/integrations/anylist/connect', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
          form.reset(); settingsForms.mark($('#anylist-config-form')); renderSettings(data); revision++; saved = undefined; await refresh();
        });
      };
      const configure = $('#anylist-config-form');
      configure.onsubmit = event => {
        event.preventDefault();
        settingsForms.run(configure, async () => {
          const data = await api('/api/integrations/anylist', { method: 'PUT', body: JSON.stringify({ listId: configure.elements.listId.value, enabled: configure.elements.enabled.checked }) });
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
        await settings(); revision++; saved = undefined; await refresh();
      });
      settingsForms.watch(root);
    }
    try { renderSettings(await api('/api/integrations/anylist')); }
    catch (error) { $('#anylist-status').textContent = `${error.message} Reopen Integrations to retry.`; }
  }

  $('#list-refresh').onclick = () => refresh(true);
  $('#list-add-form').onsubmit = event => {
    event.preventDefault(); const form = event.target, name = form.elements.name.value;
    action(async () => { const data = await api('/api/lists/anylist/items', { method: 'POST', body: JSON.stringify({ name }) }); form.reset(); return data; });
  };
  setInterval(() => { if (document.body.dataset.view === 'lists' && !$('#app').hidden) refresh(); }, 60000);
  return { refresh, settings };
}
