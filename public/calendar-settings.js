const CALENDAR_COLORS = [
  ['#4285f4', 'Blue'],
  ['#34a853', 'Green'],
  ['#ea4335', 'Red'],
  ['#fbbc04', 'Yellow'],
  ['#ff9800', 'Orange'],
  ['#a142f4', 'Purple'],
  ['#12a8a0', 'Teal'],
  ['#e91e63', 'Pink'],
  ['#5f6368', 'Gray'],
];

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const validColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

/** Manage saved iCal and Google calendars in one household-scoped settings view. */
export function createCalendarSettings({ api, settingsForms, getMe, onEventsChanged = async () => {} }) {
  let feeds = [];
  let google = null;
  let googleError = '';
  let card, dialog, inventory, feedForm, googleSource, typePicker, typeBack, googlePopup;

  function paletteSelect(value, label) {
    const select = document.createElement('select');
    select.setAttribute('aria-label', label);
    const colors = CALENDAR_COLORS.slice();
    if (validColor(value) && !colors.some(([hex]) => hex.toLowerCase() === value.toLowerCase())) colors.push([value, 'Current color']);
    for (const [hex, name] of colors) {
      const option = document.createElement('option');
      option.value = hex;
      option.textContent = name;
      select.append(option);
    }
    select.value = validColor(value) ? value : CALENDAR_COLORS[0][0];
    return select;
  }

  function setMessage(node, message, error = false) {
    node.textContent = message;
    node.classList.toggle('error', error);
  }

  function feedStatus(feed) {
    if (!feed.enabled) return 'Disabled';
    if (feed.status?.state === 'error') return 'Enabled · Update failed';
    if (feed.status?.state === 'ok') return 'Enabled · Connected';
    return 'Enabled · Not checked';
  }

  function googleStatus(calendar) {
    if (!calendar.enabled) return 'Disabled';
    if (google?.state === 'error') return 'Enabled · Update failed';
    if (google?.lastSuccessAt) return 'Enabled · Connected';
    return 'Enabled · Not checked';
  }

  function makeBadge(text, className) {
    const badge = document.createElement('span');
    badge.className = className;
    badge.textContent = text;
    return badge;
  }

  function makeRow({ kind, id, name, color, enabled, status, index = -1 }) {
    const row = document.createElement('div');
    row.className = 'calendar-row';
    row.dataset.calendarKind = kind;
    row.dataset.calendarId = String(id);
    row.setAttribute('role', 'listitem');

    if (kind === 'ical') {
      const order = document.createElement('span');
      order.className = 'feed-order-controls calendar-row-order';
      for (const [direction, glyph, text] of [['up', '↑', 'Move up'], ['down', '↓', 'Move down']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.feedMove = String(id);
        button.dataset.direction = direction;
        button.setAttribute('aria-label', `${text} ${name}`);
        button.textContent = glyph;
        button.disabled = direction === 'up' ? index === 0 : index === feeds.length - 1;
        button.addEventListener('click', () => moveFeed(button));
        order.append(button);
      }
      row.append(order);
    }

    const main = document.createElement('div');
    main.className = 'calendar-row-main';
    const heading = document.createElement('div');
    heading.className = 'calendar-row-heading';
    const title = document.createElement('strong');
    title.className = 'calendar-row-name';
    title.textContent = name;
    heading.append(title, makeBadge(kind === 'ical' ? 'iCal' : 'Google Calendar', 'calendar-source-badge'));
    const detail = document.createElement('div');
    detail.className = 'calendar-row-detail';
    detail.append(makeBadge(enabled ? 'Enabled' : 'Disabled', `calendar-enabled-badge${enabled ? '' : ' is-disabled'}`));
    const connection = document.createElement('span');
    connection.className = 'calendar-row-connection';
    connection.textContent = status;
    detail.append(connection);
    main.append(heading, detail);
    row.append(main);

    const colorLabel = document.createElement('label');
    colorLabel.className = 'calendar-color-control';
    const colorText = document.createElement('span');
    colorText.textContent = 'Color';
    const colorSelect = paletteSelect(color, `Color for ${name}`);
    colorSelect.dataset.calendarColor = String(id);
    colorSelect.addEventListener('change', () => kind === 'ical'
      ? updateFeed(row, { color: colorSelect.value })
      : updateGoogle(row, id, { color: colorSelect.value }));
    colorLabel.append(colorText, colorSelect);
    row.append(colorLabel);

    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'calendar-enabled-control';
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = !!enabled;
    enabledInput.setAttribute('aria-label', `${enabled ? 'Disable' : 'Enable'} ${name}`);
    enabledInput.dataset.calendarEnabled = String(id);
    enabledInput.addEventListener('change', () => kind === 'ical'
      ? updateFeed(row, { enabled: enabledInput.checked })
      : updateGoogle(row, id, { enabled: enabledInput.checked }));
    const enabledText = document.createElement('span');
    enabledText.textContent = 'Show';
    enabledLabel.append(enabledInput, enabledText);
    row.append(enabledLabel);

    if (kind === 'ical') {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'calendar-row-edit';
      edit.textContent = 'Edit';
      edit.setAttribute('aria-label', `Edit ${name}`);
      edit.addEventListener('click', () => editFeed(id));
      row.append(edit);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'calendar-row-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${name} from Family Hub`);
    remove.addEventListener('click', () => kind === 'ical' ? deleteFeed(remove, id, name) : removeGoogle(remove, id, name));
    row.append(remove);

    const feedback = document.createElement('p');
    feedback.className = 'calendar-row-feedback';
    feedback.setAttribute('role', 'status');
    row.append(feedback);
    return row;
  }

  function renderInventory() {
    if (!inventory) return;
    inventory.replaceChildren();
    for (const [index, feed] of feeds.entries()) {
      inventory.append(makeRow({ kind: 'ical', id: feed.id, name: feed.name, color: feed.color, enabled: !!feed.enabled, status: feedStatus(feed), index }));
    }
    for (const calendar of google?.calendars || []) {
      if (!calendar.selected) continue;
      inventory.append(makeRow({ kind: 'google', id: calendar.id, name: calendar.name, color: calendar.color, enabled: !!calendar.enabled, status: googleStatus(calendar) }));
    }
    if (!inventory.children.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No calendars saved yet. Select Add a calendar to get started.';
      inventory.append(empty);
    }
  }

  async function load() {
    feeds = await api('/api/calendar/feeds');
    try {
      google = await api('/api/integrations/google-calendar');
      googleError = '';
    } catch (error) {
      googleError = error.message;
    }
    renderInventory();
    renderGoogleSetup();
    return feeds;
  }

  function renderGoogleSetup() {
    if (!googleSource || !google) return;
    const status = $('#google-calendar-status', googleSource);
    const credentialsForm = $('#google-oauth-credentials-form', googleSource);
    const calendarsForm = $('#google-calendar-form', googleSource);
    if (googleError) {
      setMessage(status, `${googleError} Try again.`, true);
      return;
    }
    const messages = {
      unconfigured: 'Enter Google OAuth credentials before connecting.',
      needs_key: 'Ask the host owner to set FAMILY_HUB_INTEGRATION_KEY before connecting.',
      credentials_error: 'Saved Google OAuth credentials cannot be opened. Restore the encryption key or enter the credentials again.',
      not_connected: 'Not connected.',
      disabled: 'Connected. No Google calendars are enabled.',
      not_checked: 'Connected. Test the connection to refresh the calendar list.',
      ok: 'Connected.',
      error: 'Google Calendar could not refresh. Test the connection and try again.',
    };
    const last = google.lastSuccessAt ? ` Last updated ${new Date(google.lastSuccessAt).toLocaleString()}.` : '';
    setMessage(status, `${messages[google.state] || 'Google Calendar status is unavailable.'}${google.error ? ` ${google.error}` : ''}${last}`);
    const source = $('#google-calendar-credential-source', googleSource);
    source.textContent = `${google.oauthSource === 'app' ? 'Using credentials saved in Family Hub.' : google.oauthSource === 'environment' ? 'Using the host environment fallback.' : 'No Google OAuth credentials are configured.'}${google.connected ? ' Disconnect Google Calendar before changing or removing credentials.' : ''}`;

    if (!settingsForms.dirty(credentialsForm) && !settingsForms.busy(credentialsForm)) {
      credentialsForm.elements.clientId.value = google.appCredentialsSaved ? google.oauthClientId : '';
      credentialsForm.elements.clientSecret.value = '';
      for (const field of credentialsForm.elements) field.disabled = google.connected;
      const removeCredentials = $('#google-oauth-credentials-remove', googleSource);
      removeCredentials.hidden = !google.appCredentialsSaved;
      removeCredentials.disabled = google.connected;
      settingsForms.mark(credentialsForm);
    }

    const connect = $('#google-calendar-connect', googleSource);
    const test = $('#google-calendar-test', googleSource);
    const disconnect = $('#google-calendar-disconnect', googleSource);
    connect.hidden = google.connected;
    connect.disabled = !google.configured || !google.keyReady || google.state === 'credentials_error';
    test.hidden = !google.connected;
    test.disabled = !google.keyReady;
    disconnect.hidden = !google.connected;
    calendarsForm.hidden = !google.connected;
    renderAvailableGoogleCalendars();
  }

  function renderAvailableGoogleCalendars() {
    const form = $('#google-calendar-form', googleSource);
    const options = $('#google-calendar-options', googleSource);
    if (!form || !options || !google) return;
    const available = google.calendars.filter(calendar => !calendar.selected);
    options.replaceChildren();
    for (const calendar of available) {
      const item = document.createElement('div');
      item.className = 'google-calendar-add-option';
      const label = document.createElement('label');
      label.className = 'google-calendar-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.name = 'newCalendar';
      checkbox.value = calendar.id;
      const name = document.createElement('span');
      name.textContent = `${calendar.name}${calendar.primary ? ' · Primary' : ''}`;
      label.append(checkbox, name);
      const color = paletteSelect(calendar.color, `Color for ${calendar.name}`);
      color.name = 'calendarColor';
      color.dataset.googleColor = calendar.id;
      item.append(label, color);
      options.append(item);
    }
    if (!available.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'All available Google calendars are saved. Test the connection to refresh this list.';
      options.append(empty);
    }
    const submit = $('button[type="submit"]', form);
    submit.disabled = !available.length || !google.keyReady;
    settingsForms.watch(dialog);
    settingsForms.mark(form);
  }

  function setSource(source) {
    typePicker.hidden = true;
    typeBack.hidden = false;
    const ical = $('#ical-calendar-source', dialog), googlePanel = $('#google-calendar-integration', dialog);
    ical.hidden = source !== 'ical';
    googlePanel.hidden = source !== 'google';
    $('#calendar-dialog-title', dialog).textContent = source === 'ical' ? 'Add an iCal calendar' : 'Add a Google calendar';
    if (source === 'ical') {
      feedForm.elements.name.focus();
      settingsForms.mark(feedForm);
    } else {
      renderGoogleSetup();
      const target = $('#google-calendar-connect', googlePanel);
      if (!target.hidden) target.focus();
      else $('#google-calendar-test', googlePanel).focus();
    }
  }

  function showAddDialog() {
    feedForm.reset();
    feedForm.dataset.feedEdit = '';
    feedForm.elements.url.required = true;
    feedForm.elements.url.placeholder = '';
    $('#ical-calendar-enabled-row', feedForm).hidden = true;
    $('#ical-calendar-test-status', feedForm).textContent = '';
    $('#ical-calendar-save', feedForm).textContent = 'Save calendar';
    $('#calendar-dialog-title', dialog).textContent = 'Add a calendar';
    $('#ical-calendar-source', dialog).hidden = true;
    $('#google-calendar-integration', dialog).hidden = true;
    typePicker.hidden = false;
    typeBack.hidden = true;
    dialog.showModal();
    $('[data-calendar-type="ical"]', typePicker).focus();
  }

  function editFeed(id) {
    const feed = feeds.find(item => item.id === id);
    if (!feed) return;
    feedForm.dataset.feedEdit = String(id);
    feedForm.elements.name.value = feed.name;
    feedForm.elements.url.value = '';
    feedForm.elements.url.required = false;
    feedForm.elements.url.placeholder = 'Leave blank to keep the saved URL';
    feedForm.elements.color.value = feed.color;
    $('#ical-calendar-enabled', feedForm).checked = !!feed.enabled;
    $('#ical-calendar-enabled-row', feedForm).hidden = false;
    $('#ical-calendar-test-status', feedForm).textContent = '';
    $('#ical-calendar-save', feedForm).textContent = 'Save calendar';
    $('#calendar-dialog-title', dialog).textContent = 'Edit iCal calendar';
    typePicker.hidden = true;
    typeBack.hidden = false;
    $('#ical-calendar-source', dialog).hidden = false;
    $('#google-calendar-integration', dialog).hidden = true;
    dialog.showModal();
    settingsForms.mark(feedForm);
    feedForm.elements.name.focus();
  }

  async function testFeed(button) {
    const testStatus = $('#ical-calendar-test-status', feedForm);
    const feedId = Number(feedForm.dataset.feedEdit) || null;
    const url = feedForm.elements.url.value.trim();
    if (!url && !feedId) return setMessage(testStatus, 'Enter the calendar URL first.', true);
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    setMessage(testStatus, 'Testing connection…');
    try {
      const body = { name: feedForm.elements.name.value, color: feedForm.elements.color.value };
      if (feedId) body.feedId = feedId;
      if (url) body.url = url;
      const result = await api('/api/calendar/feeds/test', { method: 'POST', body: JSON.stringify(body) });
      setMessage(testStatus, `Connection works · ${result.eventCount} event${result.eventCount === 1 ? '' : 's'} in the next month.`);
      if (feedId) await load();
    } catch (error) {
      setMessage(testStatus, error.message, true);
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  async function saveFeed(event) {
    event.preventDefault();
    const id = Number(feedForm.dataset.feedEdit) || null;
    const values = {
      name: feedForm.elements.name.value,
      color: feedForm.elements.color.value,
    };
    if (id) {
      values.enabled = $('#ical-calendar-enabled', feedForm).checked;
      if (feedForm.elements.url.value.trim()) values.url = feedForm.elements.url.value.trim();
    } else {
      values.url = feedForm.elements.url.value.trim();
    }
    const saved = await settingsForms.run(feedForm, async () => {
      await api(id ? `/api/calendar/feeds/${id}` : '/api/calendar/feeds', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(values) });
    }, { reset: !id });
    if (!saved) return;
    feedForm.dataset.feedEdit = '';
    await load();
    await onEventsChanged();
    if (!id) {
      dialog.close();
      $('#calendar-add-button', card).focus();
    }
  }

  async function runRowAction(button, work) {
    const row = button.closest('.calendar-row'), feedback = $('.calendar-row-feedback', row);
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    setMessage(feedback, 'Saving…');
    try {
      await work();
      await load();
      await onEventsChanged();
    } catch (error) {
      setMessage(feedback, `${error.message} Try again.`, true);
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  async function updateFeed(row, values) {
    const id = Number(row.dataset.calendarId);
    await runRowAction($('button.calendar-row-edit', row) || $('[data-calendar-enabled]', row), async () => {
      await api(`/api/calendar/feeds/${id}`, { method: 'PATCH', body: JSON.stringify(values) });
    });
  }

  function googleOptions(overrides = {}) {
    const selected = google.selectedCalendarIds.slice();
    const options = {};
    for (const id of selected) {
      const calendar = google.calendars.find(item => item.id === id);
      if (!calendar) continue;
      options[id] = {
        enabled: calendar.enabled ?? google.enabled,
        color: calendar.color,
      };
    }
    for (const [id, values] of Object.entries(overrides)) {
      if (options[id]) options[id] = { ...options[id], ...values };
    }
    return { selected, options };
  }

  async function saveGoogle(selectedCalendarIds, calendarOptions) {
    const enabled = selectedCalendarIds.some(id => calendarOptions[id]?.enabled === true);
    google = await api('/api/integrations/google-calendar/calendars', {
      method: 'POST',
      body: JSON.stringify({ selectedCalendarIds, enabled, calendarOptions }),
    });
    await load();
    await onEventsChanged();
  }

  async function updateGoogle(row, id, changes) {
    const button = $('[data-calendar-enabled]', row) || $('[data-calendar-color]', row);
    await runRowAction(button, async () => {
      const { selected, options } = googleOptions({ [id]: changes });
      await saveGoogle(selected, options);
    });
  }

  async function deleteFeed(button, id, name) {
    if (!confirm(`Delete calendar “${name}”? Its events will leave Family Hub. The source calendar is unchanged.`)) return;
    await runRowAction(button, () => api(`/api/calendar/feeds/${id}`, { method: 'DELETE' }));
  }

  async function removeGoogle(button, id, name) {
    if (!confirm(`Remove “${name}” from Family Hub? The Google calendar and account will not be changed.`)) return;
    await runRowAction(button, async () => {
      const { selected, options } = googleOptions();
      const remaining = selected.filter(calendarId => calendarId !== id);
      delete options[id];
      await saveGoogle(remaining, options);
    });
  }

  async function moveFeed(button) {
    const index = feeds.findIndex(feed => feed.id === Number(button.dataset.feedMove));
    const swap = index + (button.dataset.direction === 'up' ? -1 : 1);
    if (index < 0 || swap < 0 || swap >= feeds.length) return;
    const ids = feeds.map(feed => feed.id);
    [ids[index], ids[swap]] = [ids[swap], ids[index]];
    await runRowAction(button, () => api('/api/calendar/feed-order', { method: 'PUT', body: JSON.stringify({ ids }) }));
  }

  async function saveNewGoogleCalendars(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const additions = $$('input[name="newCalendar"]:checked', form).map(input => input.value);
    if (!additions.length) return;
    const { selected, options } = googleOptions();
    for (const id of additions) {
      const calendar = google.calendars.find(item => item.id === id);
      const color = $(`[data-google-color="${CSS.escape(id)}"]`, form)?.value;
      selected.push(id);
      options[id] = { enabled: true, color: validColor(color) ? color : calendar?.color };
    }
    const saved = await settingsForms.run(form, async () => saveGoogle(selected, options));
    if (saved) {
      setMessage($('#google-calendar-status', googleSource), 'Calendar added to Family Hub.');
      await load();
      renderAvailableGoogleCalendars();
    }
  }

  async function mount(grid) {
    if (card) return;
    card = document.createElement('section');
    card.id = 'calendar-integration';
    card.className = 'integration-card';
    card.setAttribute('aria-labelledby', 'calendar-integration-title');
    card.innerHTML = `
      <div class="integration-card-heading">
        <div><h4 id="calendar-integration-title">Calendars</h4><p class="muted">Manage saved calendars, colors, and status in one place.</p></div>
        <button type="button" id="calendar-add-button">Add a calendar</button>
      </div>
      <button type="button" id="calendar-status-refresh">Refresh status</button>
      <div id="calendar-inventory" role="list" aria-label="Saved calendars"></div>
      <dialog id="calendar-config-dialog" class="calendar-config-dialog" aria-labelledby="calendar-dialog-title">
        <div class="calendar-dialog-heading"><div><p class="eyebrow">CALENDAR SETTINGS</p><h2 id="calendar-dialog-title">Add a calendar</h2></div><button type="button" id="calendar-dialog-close" class="dialog-close" aria-label="Close calendar settings">×</button></div>
        <div id="calendar-type-picker" class="calendar-type-choices" role="group" aria-label="Choose a calendar type">
          <button type="button" data-calendar-type="ical"><span>Public iCal</span><small>Add a public calendar feed</small></button>
          <button type="button" data-calendar-type="google"><span>Google Calendar</span><small>Connect and select calendars</small></button>
        </div>
        <button type="button" id="calendar-type-back" hidden>Choose another source</button>
        <section id="ical-calendar-source" class="calendar-config-source" hidden><p class="muted">Saved feed URLs stay hidden. Enter a new URL when editing to replace one.</p><div id="ical-form-slot"></div></section>
        <section id="google-calendar-integration" class="calendar-config-source" hidden aria-labelledby="google-calendar-title">
          <h3 id="google-calendar-title">Google Calendar</h3>
          <p id="google-calendar-status" role="status">Loading Google Calendar settings…</p>
          <p id="google-calendar-credential-source" class="muted"></p>
          <form id="google-oauth-credentials-form" class="settings-form"><label>Google OAuth client ID<input name="clientId" type="text" maxlength="512" autocomplete="off" required></label><label>Google OAuth client secret<input name="clientSecret" type="password" maxlength="4096" autocomplete="new-password"></label><p class="muted">Leave the secret blank to keep the saved secret. Family Hub encrypts it and never shows it again.</p><div class="google-calendar-actions"><button type="submit">Save OAuth credentials</button><button type="button" id="google-oauth-credentials-remove" hidden>Remove saved credentials</button></div></form>
          <div class="google-calendar-actions"><button type="button" id="google-calendar-connect">Connect Google account</button><button type="button" id="google-calendar-test" hidden>Test connection</button><button type="button" id="google-calendar-disconnect" hidden>Disconnect Google account</button></div>
          <form id="google-calendar-form" class="settings-form" hidden><fieldset><legend>Add available calendars</legend><div id="google-calendar-options" class="google-calendar-list"></div></fieldset><button type="submit">Add selected calendars</button></form>
        </section>
      </dialog>`;
    grid.append(card);
    dialog = $('#calendar-config-dialog', card);
    inventory = $('#calendar-inventory', card);
    typePicker = $('#calendar-type-picker', dialog);
    typeBack = $('#calendar-type-back', dialog);
    googleSource = $('#google-calendar-integration', dialog);

    const savedList = document.querySelector('#calendar-feeds');
    const savedForm = document.querySelector('#calendar-feed-form');
    const notice = document.querySelector('[data-settings-load="feeds"]');
    const oldNote = savedForm?.nextElementSibling?.matches('.muted') ? savedForm.nextElementSibling : null;
    if (savedList) inventory.append(savedList);
    if (savedForm) {
      feedForm = savedForm;
      $('#ical-form-slot', dialog).append(feedForm);
      if (oldNote) $('#ical-form-slot', dialog).append(oldNote);
      const oldColor = feedForm.elements.color;
      const colorSelect = paletteSelect(oldColor.value, 'Calendar color');
      colorSelect.name = 'color';
      oldColor.replaceWith(colorSelect);
      const save = $('button', feedForm);
      save.id = 'ical-calendar-save';
      save.textContent = 'Save calendar';
      const actions = document.createElement('div');
      actions.className = 'calendar-dialog-actions';
      const test = document.createElement('button');
      test.type = 'button';
      test.id = 'ical-calendar-test';
      test.textContent = 'Test connection';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', closeDialog);
      const status = document.createElement('p');
      status.id = 'ical-calendar-test-status';
      status.setAttribute('role', 'status');
      actions.append(test, cancel, save);
      feedForm.append(status, actions);
      const enabledRow = document.createElement('label');
      enabledRow.id = 'ical-calendar-enabled-row';
      enabledRow.className = 'check-label';
      enabledRow.hidden = true;
      enabledRow.innerHTML = '<input id="ical-calendar-enabled" name="enabled" type="checkbox"> Enabled';
      colorSelect.before(enabledRow);
      test.addEventListener('click', () => testFeed(test));
      feedForm.addEventListener('submit', saveFeed);
      feedForm.elements.url.addEventListener('input', () => { $('#ical-calendar-test-status', feedForm).textContent = ''; });
      settingsForms.watch(dialog);
      settingsForms.mark(feedForm);
    }
    if (notice) card.insertBefore(notice, inventory);

    $('#calendar-add-button', card).addEventListener('click', showAddDialog);
    $('#calendar-status-refresh', card).addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try { await onEventsChanged(); await load(); }
      catch (error) { setMessage($('[data-settings-load="feeds"]', card) || button, error.message, true); }
      finally { button.disabled = false; }
    });
    $('[data-calendar-type="ical"]', typePicker).addEventListener('click', () => setSource('ical'));
    $('[data-calendar-type="google"]', typePicker).addEventListener('click', () => setSource('google'));
    typeBack.addEventListener('click', () => {
      if (!settingsForms.guard(dialog)) return;
      $('#ical-calendar-source', dialog).hidden = true;
      googleSource.hidden = true;
      typePicker.hidden = false;
      typeBack.hidden = true;
      $('#calendar-dialog-title', dialog).textContent = 'Add a calendar';
      $('[data-calendar-type="ical"]', typePicker).focus();
    });
    $('#calendar-dialog-close', dialog).addEventListener('click', closeDialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
    dialog.addEventListener('click', event => {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog();
    });

    const credentialsForm = $('#google-oauth-credentials-form', googleSource);
    credentialsForm.addEventListener('submit', async event => {
      event.preventDefault();
      const payload = { clientId: credentialsForm.elements.clientId.value, clientSecret: credentialsForm.elements.clientSecret.value };
      const saved = await settingsForms.run(credentialsForm, async () => {
        await api('/api/integrations/google-calendar/credentials', { method: 'PUT', body: JSON.stringify(payload) });
        credentialsForm.elements.clientSecret.value = '';
      });
      if (saved) await load();
    });
    $('#google-oauth-credentials-remove', googleSource).addEventListener('click', async event => {
      if (!confirm('Remove the saved Google OAuth credentials?')) return;
      const button = event.currentTarget;
      button.disabled = true;
      try { await api('/api/integrations/google-calendar/credentials', { method: 'DELETE' }); await load(); }
      catch (error) { setMessage($('#google-calendar-status', googleSource), error.message, true); }
      finally { button.disabled = false; }
    });
    $('#google-calendar-connect', googleSource).addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      const popup = window.open('about:blank', 'family-hub-google-calendar', 'popup,width=520,height=720');
      try {
        const result = await api('/api/integrations/google-calendar/connect', { method: 'POST', body: '{}' });
        const authorization = new URL(result.authorizationUrl);
        if (authorization.origin !== 'https://accounts.google.com') throw new Error('Google returned an invalid sign-in address.');
        if (popup) { googlePopup = popup; popup.location.href = authorization.href; }
        else location.assign(authorization.href);
      } catch (error) { popup?.close(); setMessage($('#google-calendar-status', googleSource), error.message, true); }
      finally { button.disabled = false; }
    });
    $('#google-calendar-test', googleSource).addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      setMessage($('#google-calendar-status', googleSource), 'Testing connection…');
      try {
        google = await api('/api/integrations/google-calendar/refresh', { method: 'POST', body: '{}' });
        googleError = '';
        renderGoogleSetup();
        setMessage($('#google-calendar-status', googleSource), `Connection works · ${google.calendars.length} calendar${google.calendars.length === 1 ? '' : 's'} found.`);
      } catch (error) { setMessage($('#google-calendar-status', googleSource), error.message, true); }
      finally { button.disabled = false; }
    });
    $('#google-calendar-disconnect', googleSource).addEventListener('click', async event => {
      if (!confirm('Disconnect Google Calendar? Its saved calendars will be removed from Family Hub. Google events will not be changed.')) return;
      const button = event.currentTarget;
      button.disabled = true;
      try { await api('/api/integrations/google-calendar', { method: 'DELETE' }); await load(); }
      catch (error) { setMessage($('#google-calendar-status', googleSource), error.message, true); }
      finally { button.disabled = false; }
    });
    $('#google-calendar-form', googleSource).addEventListener('submit', saveNewGoogleCalendars);
    window.addEventListener('message', async event => {
      if (event.origin !== location.origin || event.source !== googlePopup || event.data?.type !== 'family-hub-google-calendar-oauth') return;
      googlePopup = null;
      if (event.data.status === 'success' || event.data.status === 'partial') {
        await load();
        renderGoogleSetup();
      } else setMessage($('#google-calendar-status', googleSource), event.data.status === 'cancelled' ? 'Google Calendar connection was cancelled.' : 'Google Calendar could not connect. Try again.', true);
    });
    settingsForms.watch(dialog);
    renderInventory();
    renderGoogleSetup();
  }

  function closeDialog() {
    if (!settingsForms.guard(dialog)) return;
    dialog.close();
    $('#calendar-add-button', card).focus();
  }

  return { mount, load };
}
