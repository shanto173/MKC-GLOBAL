/**
 * Deleting a record, from wherever it is shown.
 *
 * One dialog for a booking, a request, an MRN application, a shipment, a whole
 * customer and a team member's sign-in, so the question is asked the same way
 * every time and the answer is never a single red button:
 *
 *   1. the server is asked what would actually go, and the dialog reads the
 *      counts back - "3 documents, 41 messages, 1 shipment" - because nobody
 *      can weigh a deletion they cannot see the size of;
 *   2. the reference has to be typed. Not to be tiresome: a red button is
 *      eventually pressed on the row above the one somebody meant, and typing
 *      MKY-BKG-2 is the one thing that cannot happen by accident;
 *   3. it says how long it can be taken back, and where from.
 *
 * The typing is checked again on the server (lib/admin/desk-delete.js). This is
 * the part that stops a mistake; that part is what stops a crafted request.
 */

import { h, dialog, post, api, toast, icon, skeleton, session } from './ui.js';

/**
 * Asks, and deletes.
 *
 * @param {{ kind: string, reference: string, name?: string, onDone?: Function }} opts
 *   kind       booking | request | mrn | shipment | customer | person
 *   reference  the booking ref, ticket ref, shipment id, client id, or name
 *   name       what to call it in the title before the server answers
 *   onDone     after it is gone - usually "leave this page", since the page
 *              is about a record that no longer exists
 */
export function deleteDialog({ kind, reference, name = null, onDone = null }) {
  const body = h('div', { class: 'stack' }, skeleton(3));
  const dlg = dialog({
    title: `Delete ${name || reference}?`,
    body,
    onStale: null,
    actions: [{ label: 'Cancel' }],
  });

  let preview = null;
  const typed = h('input', {
    class: 'input', id: 'del-confirm', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false',
  });

  /** Delete turns on only once what is typed matches, as the server will check it. */
  const matches = () => Boolean(preview)
    && typed.value.trim().toLowerCase() === String(preview.confirm_with).trim().toLowerCase();

  function drawActions() {
    dlg.setActions([
      { label: 'Cancel' },
      {
        label: `Delete ${preview?.kind_words ?? 'record'}`,
        kind: 'danger',
        busy: 'Deleting…',
        disabled: !matches(),
        async run() {
          if (!matches()) { dlg.error(`Type “${preview.confirm_with}” to confirm.`); return true; }
          const out = await post({
            action: 'delete_record', kind, reference, confirm: typed.value.trim(),
          });
          toast(`${capital(out.kind_words)} ${out.reference} deleted. You can put it back from Settings → Recently deleted for ${out.keep_days} days.`,
            'ok', { timeout: 10_000 });
          await onDone?.(out);
          return false;
        },
      },
    ]);
  }

  (async () => {
    try {
      preview = await api({ view: 'delete_preview', kind, reference });
    } catch (err) {
      body.replaceChildren(h('div', { class: 'banner banner-red' }, icon('alert', { size: 15 }), h('p', {}, err.message)));
      return;
    }
    const words = preview.words ?? [];
    body.replaceChildren(
      h('div', { class: 'banner banner-red' }, icon('alert', { size: 15 }),
        h('p', {},
          h('strong', {}, 'This deletes customer data. '),
          words.length
            ? `${capital(preview.label)} goes, and with it ${asList(words)}.`
            : `${capital(preview.label)} goes.`)),
      preview.note ? h('p', { class: 'muted' }, preview.note) : null,
      h('p', { class: 'muted' },
        `It leaves every screen at once. For ${preview.keep_days} days you can put it back from Settings → Recently deleted; after that it is gone for good, files and all.`),
      h('div', { class: 'field' },
        h('label', { class: 'label', for: 'del-confirm' },
          'Type ', h('code', {}, preview.confirm_with), ' to confirm'),
        typed));
    typed.addEventListener('input', drawActions);
    drawActions();
    typed.focus();
  })();

  return dlg;
}

/** "3 documents, 41 messages and 1 shipment" */
function asList(words) {
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

const capital = (s) => (s ? String(s)[0].toUpperCase() + String(s).slice(1) : '');

/** Whether this desk may delete at all - the button is not drawn otherwise. */
export const canDelete = () => session.can('delete');

/**
 * The bin, wherever a record is shown: the same quiet icon button as the one
 * on a conversation and on a team member, so it is the same thing everywhere
 * and there is one place to change it. Null for anybody who may not delete -
 * the control is not drawn at all, and the server refuses it as well.
 *
 * @param {{ kind: string, reference: string|number, what: string, name?: string, onDone?: Function }} opts
 *   what  what is being deleted, for the label a screen reader reads out
 */
export function deleteBin({ kind, reference, what, name = null, onDone = null }) {
  if (!canDelete()) return null;
  const b = h('button', {
    class: 'icon-btn row-delete', type: 'button', 'aria-label': `Delete ${what}`, title: `Delete ${what}`,
  }, icon('trash', { size: 15 }));
  b.addEventListener('click', () => deleteDialog({
    kind, reference: String(reference), name: name ?? what, onDone,
  }));
  return b;
}
