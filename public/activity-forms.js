import { createSettingsForms } from './settings-forms.js';

/** Share draft guards, save feedback, and cancel behavior across task and reminder forms. */
export function createActivityForms({ onSaved, onCalendarSaved, onDiscard = () => {} }) {
  const forms = createSettingsForms({
    confirmDiscard: () => window.confirm('Discard unsaved changes?'),
    onDiscard,
  });
  let returnFocus;

  function track(form) {
    forms.watch(form);
    forms.mark(form);
  }

  function close(dialog) {
    if (!forms.guard(dialog)) return false;
    dialog.close();
    if (returnFocus?.isConnected) returnFocus.focus();
    else {
      const form = dialog.querySelector('form:not([method="dialog"])');
      const trigger = form?.dataset.kind === 'chore' || form?.dataset.kind === 'routine'
        ? document.querySelector(`[data-edit-${form.dataset.kind}="${CSS.escape(form.elements.itemId.value)}"]`)
        : document.getElementById('add-reminder');
      trigger?.focus();
    }
    return true;
  }

  function opened(dialog, trigger = document.activeElement) {
    returnFocus = trigger;
    forms.mark(dialog.querySelector('form:not([method="dialog"])'));
    dialog.showModal();
    dialog.querySelector('input:not([type="hidden"]):not(:disabled)')?.focus();
  }

  function bind(form, request, { reset = false, calendar = false, dialog } = {}) {
    if (dialog?.id === 'reminder-dialog') {
      const submit = form.querySelector('button[type="submit"],button:not([type])');
      const actions = document.createElement('div'); actions.className = 'activity-form-actions';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.dataset.cancelReminder = '';
      submit.before(actions); actions.append(cancel, submit);
    }
    track(form);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const saved = await forms.run(form, () => request(form), { reset });
      if (!saved) return;
      if (reset) onDiscard(form);
      try {
        await (calendar ? onCalendarSaved() : onSaved(form));
        if (dialog) close(dialog);
      } catch {
        // The mutation succeeded. Do not invite a retry that creates a duplicate.
        const status = form.querySelector('.form-status');
        status.textContent = `Saved. The display could not refresh. Reload when the connection returns.${forms.dirty(form) ? ' Your new changes are not saved.' : ''}`;
        status.classList.remove('error');
      }
    });
  }

  function cancelButton(form) {
    const submit = form.querySelector('button:not([type="button"])');
    submit.classList.add('primary');
    const actions = document.createElement('div'); actions.className = 'activity-form-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      if (!forms.guard(form)) return;
      form.reset(); onDiscard(form); forms.mark(form);
      form.querySelector('input:not([type="checkbox"])')?.focus();
    });
    submit.before(actions); actions.append(cancel, submit);
  }

  for (const id of ['reminder-dialog', 'edit-item-dialog']) {
    const dialog = document.getElementById(id);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(dialog); });
    dialog.addEventListener('click', event => {
      const rect = dialog.getBoundingClientRect();
      if (event.target.closest('[data-close-edit],.dialog-close,[data-cancel-reminder]')
        || (event.isTrusted && event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom))) {
        event.preventDefault(); close(dialog);
      }
    });
  }

  return { ...forms, track, bind, cancelButton, opened, close };
}
