import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdleReturn, editKeyboardText } from '../public/kiosk-input.js';

test('on-screen keyboard edits selection, caret, maxlength and Unicode backspace', () => {
  assert.deepEqual(editKeyboardText('Milk', 0, 4, 'R'), { value: 'R', caret: 1 });
  assert.deepEqual(editKeyboardText('Milk', 2, 2, '-'), { value: 'Mi-lk', caret: 3 });
  assert.deepEqual(editKeyboardText('Eggs', 4, 4, '!', 4), { value: 'Eggs', caret: 4 });
  assert.deepEqual(editKeyboardText('a😀', 3, 3, 'Backspace'), { value: 'a', caret: 1 });
  assert.deepEqual(editKeyboardText('Milk', 1, 3, 'Backspace'), { value: 'Mk', caret: 1 });
});

test('idle return is paired-only, resets on activity, and waits for writes without losing drafts', () => {
  let clock = 0, pending, paired = true, lists = true, saving = false, returns = 0;
  const controller = createIdleReturn({ enabled: () => paired, active: () => lists, busy: () => saving,
    onIdle: () => { returns++; lists = false; }, now: () => clock,
    setTimer: (callback, delay) => { pending = { callback, at: clock + delay }; return pending; },
    clearTimer: () => { pending = undefined; },
  });
  const advance = milliseconds => { clock += milliseconds; if (pending && clock >= pending.at) { const next = pending; pending = undefined; next.callback(); } };
  controller.update(); advance(59000); assert.equal(returns, 0);
  controller.activity(); advance(1000); assert.equal(returns, 0);
  advance(59000); assert.equal(returns, 1);
  lists = true; saving = true; controller.update(); advance(60000); assert.equal(returns, 1);
  saving = false; advance(1000); assert.equal(returns, 2);
  paired = false; lists = true; controller.update(); advance(120000); assert.equal(returns, 2);
  paired = true; lists = false; controller.update(); advance(120000); assert.equal(returns, 2);
  controller.dispose();
});
