/** Track settings drafts without storing passwords or keys outside this page. */
export function createSettingsForms({ confirmDiscard = () => window.confirm('Discard unsaved settings changes?'), extraState = () => '', onDiscard = () => {} } = {}) {
  const states = new Map(), watched = new WeakSet();
  const fields = (form) => [...form.elements].filter((field) => field.name && field.name !== 'revealWeatherKey');
  const capture = (form) => fields(form).map((field) => ({ field, value: field.value, checked: field.checked }));
  const signature = (form) => JSON.stringify([capture(form).map(({ value, checked }) => [value, checked]), extraState(form)]);
  function status(form, message, error = false) {
    let node = form.querySelector('.form-status');
    if (!node) {
      node = document.createElement('p');
      node.className = 'form-status';
      node.setAttribute('role', 'status');
      form.append(node);
    }
    node.textContent = message;
    node.classList.toggle('error', error);
  }
  function update(form) {
    const state = states.get(form);
    if (!state) return;
    const dirty = state.signature !== signature(form);
    form.dataset.dirty = String(dirty);
    for (const button of form.querySelectorAll('button:not([type="button"])')) button.disabled = state.busy || !dirty || form.dataset.loadFailed === 'true';
    if (!state.busy) status(form, dirty ? 'Unsaved changes' : '');
  }
  function mark(form, message = '') {
    states.set(form, { signature: signature(form), fields: capture(form), busy: false });
    update(form);
    status(form, message);
  }
  function watch(root) {
    for (const form of states.keys()) if (!form.isConnected) states.delete(form);
    for (const form of root.querySelectorAll('form')) {
      if (watched.has(form)) continue;
      watched.add(form);
      if (!states.has(form)) mark(form);
      form.addEventListener('input', () => update(form));
      form.addEventListener('change', () => update(form));
    }
  }
  const dirty = (form) => states.has(form) && states.get(form).signature !== signature(form);
  const busy = (form) => !!states.get(form)?.busy;
  const pending = (root) => [...states.keys()].filter((form) => form.isConnected && root.contains(form) && dirty(form));
  function guard(root) {
    if ([...states.keys()].some((form) => form.isConnected && root.contains(form) && busy(form))) return false;
    const drafts = pending(root);
    if (!drafts.length) return true;
    if (!confirmDiscard()) return false;
    for (const form of drafts) {
      for (const { field, value, checked } of states.get(form).fields) {
        field.value = value;
        if (checked !== undefined) field.checked = checked;
      }
      onDiscard(form);
      mark(form);
    }
    return true;
  }
  async function run(form, work, { reset = false } = {}) {
    if (busy(form) || form.dataset.loadFailed === 'true') return false;
    if (!states.has(form)) mark(form);
    const state = states.get(form);
    state.busy = true;
    form.setAttribute('aria-busy', 'true');
    status(form, 'Saving…');
    const active = document.activeElement;
    const controls = [...form.elements].map((field) => [field, field.disabled]);
    try {
      // Read FormData in work before disabling controls; disabled fields are omitted.
      const result = work();
      for (const [field] of controls) field.disabled = true;
      await result;
      if (reset) form.reset();
      mark(form, 'Saved.');
      return true;
    } catch (error) {
      status(form, `${error.message} Your changes are not saved. Try again.`, true);
      return false;
    } finally {
      state.busy = false;
      form.removeAttribute('aria-busy');
      for (const [field, disabled] of controls) field.disabled = disabled;
      for (const button of form.querySelectorAll('button:not([type="button"])')) button.disabled = !dirty(form);
      if (form.contains(active) && form.isConnected) {
        const focus = active.disabled ? fields(form).find(field => !field.disabled) : active;
        focus?.focus();
      }
    }
  }
  return { watch, mark, dirty, busy, pending, guard, run, update };
}
