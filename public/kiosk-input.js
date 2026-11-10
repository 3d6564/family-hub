/** Return edited text and its caret position, respecting maxlength and Unicode backspace. */
export function editKeyboardText(value, start, end, key, maxLength = -1) {
  let from = start, inserted = key;
  if (key === 'Backspace') {
    inserted = '';
    if (start === end) from = start - (Array.from(value.slice(0, start)).at(-1)?.length || 0);
  }
  const next = value.slice(0, from) + inserted + value.slice(end);
  if (maxLength >= 0 && next.length > maxLength) return { value, caret: end };
  return { value: next, caret: from + inserted.length };
}

/** Return an active, paired Lists view to Calendar after a minute of inactivity. */
export function createIdleReturn({ enabled, active, busy, onIdle, idleMs = 60000, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer, lastActivity = now();
  const canRun = () => enabled() && active();
  function schedule(delay) { timer = setTimer(check, delay); }
  function check() {
    timer = undefined;
    if (!canRun()) return;
    const remaining = idleMs - (now() - lastActivity);
    if (remaining > 0) schedule(remaining);
    else if (busy()) schedule(1000);
    else onIdle();
  }
  function activity() {
    lastActivity = now();
    if (canRun() && timer === undefined) schedule(idleMs);
  }
  function dispose() { if (timer !== undefined) clearTimer(timer); timer = undefined; }
  function update() { dispose(); activity(); }
  return { activity, update, dispose };
}

/** Provide a local keyboard for paired-display text inputs, never account/password fields. */
export function createKioskInput({ enabled, active, busy, onIdle }) {
  const keyboard = document.createElement('section');
  keyboard.id = 'kiosk-keyboard'; keyboard.className = 'kiosk-keyboard'; keyboard.hidden = true;
  keyboard.setAttribute('role', 'group'); keyboard.setAttribute('aria-label', 'On-screen keyboard');
  document.body.append(keyboard);
  let target, originalInputMode, shift = false, symbols = false;
  const idle = createIdleReturn({ enabled, active, busy, onIdle: () => { close(); onIdle(); } });
  const eligible = element => (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement && ['text', 'search', 'email', 'tel', 'url'].includes(element.type)) && !['current-password', 'new-password', 'one-time-code'].includes(element.autocomplete) && !element.disabled && !element.readOnly && !element.hidden && !element.closest('[hidden]') && element.getClientRects().length > 0;

  function close() {
    if (target) {
      if (originalInputMode === null) target.removeAttribute('inputmode'); else target.setAttribute('inputmode', originalInputMode);
    }
    target = undefined; keyboard.hidden = true;
    document.body.classList.remove('keyboard-open');
    document.body.style.removeProperty('--keyboard-height');
  }

  function press(key) {
    if (!target || !enabled() || !eligible(target)) return close();
    idle.activity();
    if (key === 'Done') { const field = target; close(); field.blur(); return; }
    if (key === 'Shift') { shift = !shift; return draw(); }
    if (key === 'Symbols') { symbols = !symbols; return draw(); }
    const text = key === 'Space' ? ' ' : key === 'Backspace' ? key : shift && !symbols ? key.toUpperCase() : key;
    const value = target.value, start = target.selectionStart ?? value.length, end = target.selectionEnd ?? value.length;
    const next = editKeyboardText(value, start, end, text, target.maxLength);
    const inputType = key === 'Backspace' ? 'deleteContentBackward' : 'insertText';
    if (!target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data: key === 'Backspace' ? null : text }))) return;
    target.value = next.value;
    try { target.setSelectionRange(next.caret, next.caret); } catch { /* Number inputs do not expose a text selection. */ }
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data: key === 'Backspace' ? null : text }));
    target.focus({ preventScroll: true });
    if (shift && !symbols) { shift = false; draw(); }
  }

  function draw() {
    keyboard.replaceChildren();
    const heading = document.createElement('span'); heading.className = 'keyboard-title'; heading.textContent = 'On-screen keyboard'; keyboard.append(heading);
    const rows = symbols ? ['1234567890', '@#$%&*()-_', '.,!?\'":/+='] : ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
    const add = (row, key, label = key) => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.kioskKey = key;
      button.textContent = label; button.onclick = () => press(key);
      if (key === 'Shift') button.setAttribute('aria-pressed', String(shift));
      if (key === 'Space') button.className = 'keyboard-space';
      row.append(button);
    };
    for (const keys of rows) {
      const row = document.createElement('div'); row.className = 'keyboard-row';
      for (const key of keys) add(row, key, shift && !symbols ? key.toUpperCase() : key);
      keyboard.append(row);
    }
    const controls = document.createElement('div'); controls.className = 'keyboard-row';
    add(controls, 'Shift'); add(controls, 'Symbols', symbols ? 'ABC' : '123'); add(controls, 'Space'); add(controls, 'Backspace', '⌫');
    controls.lastElementChild.setAttribute('aria-label', 'Backspace'); add(controls, 'Done'); keyboard.append(controls);
  }

  function open(field) {
    if (target === field && !keyboard.hidden) return;
    close(); target = field; originalInputMode = field.getAttribute('inputmode');
    field.setAttribute('inputmode', 'none'); shift = false; symbols = field.type === 'number' || field.type === 'tel';
    (field.closest('dialog') || document.body).append(keyboard);
    draw(); keyboard.hidden = false; document.body.classList.add('keyboard-open');
    requestAnimationFrame(() => {
      if (target !== field || keyboard.hidden) return;
      document.body.style.setProperty('--keyboard-height', `${keyboard.getBoundingClientRect().height}px`);
      field.scrollIntoView({ block: 'nearest' });
    });
  }

  keyboard.addEventListener('pointerdown', event => { event.preventDefault(); idle.activity(); });
  document.addEventListener('focusin', event => {
    if (keyboard.contains(event.target)) return;
    if (enabled() && eligible(event.target)) open(event.target); else close();
  });
  document.addEventListener('focusout', () => queueMicrotask(() => {
    if (target && document.activeElement !== target && !keyboard.contains(document.activeElement)) close();
  }));
  document.addEventListener('pointerdown', event => {
    if (!keyboard.contains(event.target) && !eligible(event.target)) close();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  document.addEventListener('close', () => { if (target?.closest('dialog') && !target.closest('dialog').open) close(); }, true);
  for (const event of ['pointerdown', 'pointermove', 'touchstart', 'keydown', 'input', 'wheel', 'scroll']) document.addEventListener(event, idle.activity, { capture: true, passive: true });
  return { viewChanged() { close(); idle.update(); } };
}
