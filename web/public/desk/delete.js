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

import { h, dialog, post, api, toast, icon, skeleton, session, fill } from './ui.js';

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
  const b = binButton(what);
  if (!b) return null;
  b.addEventListener('click', () => deleteDialog({
    kind, reference: String(reference), name: name ?? what, onDone,
  }));
  return b;
}

/** The bin itself: one markup and one class, wherever a bin is drawn. */
function binButton(what) {
  if (!canDelete()) return null;
  return h('button', {
    class: 'icon-btn row-delete', type: 'button', 'aria-label': `Delete ${what}`, title: `Delete ${what}`,
  }, icon('trash', { size: 15 }));
}

/**
 * The same bin for a row that stands for several records at once - a chat's
 * failed messages, counted together on one Inbox row. It asks the same
 * question a selection does, because that is what it is.
 */
export function deleteManyBin({ targets, what, onDone = null }) {
  if (!targets?.length) return null;
  const b = binButton(what);
  if (!b) return null;
  b.addEventListener('click', () => deleteManyDialog({ targets, onDone }));
  return b;
}

// ---------------------------------------------------------------------------
// Several at once
// ---------------------------------------------------------------------------

/** The records a selection names, in the form the server reads (desk-delete.js). */
const encodeTargets = (targets) => targets.map((t) => `${t.kind}:${t.reference}`).join(',');

/**
 * Deleting everything that is ticked on a list.
 *
 * The same dialog as one record, asked once for the lot: the server is asked
 * what would go, every record is listed with its counts, and the number of
 * records has to be typed. A reference cannot be typed for twenty of them; a
 * count can, and typing it is what makes somebody read how many they ticked.
 *
 * Each record is deleted on its own behind this (its own copy in Recently
 * deleted, its own line on the trail), so one that cannot go does not take the
 * rest with it - and what did not go is said.
 */
export function deleteManyDialog({ targets, onDone = null }) {
  const body = h('div', { class: 'stack' }, skeleton(3));
  const dlg = dialog({
    title: `Delete ${targets.length} ${targets.length === 1 ? 'record' : 'records'}?`,
    body,
    onStale: null,
    actions: [{ label: 'Cancel' }],
  });

  let preview = null;
  const typed = h('input', {
    class: 'input', id: 'del-count', autocomplete: 'off', inputmode: 'numeric', spellcheck: 'false',
  });
  const matches = () => Boolean(preview) && typed.value.trim() === String(preview.confirm_with);

  function drawActions() {
    dlg.setActions([
      { label: 'Cancel' },
      {
        label: `Delete ${preview?.total ?? targets.length} ${preview?.total === 1 ? 'record' : 'records'}`,
        kind: 'danger',
        busy: 'Deleting…',
        disabled: !matches(),
        async run() {
          if (!matches()) { dlg.error(`Type ${preview.confirm_with} to confirm.`); return true; }
          // Only the ones still there: the ones already gone were not counted
          // and are not asked for.
          const going = preview.records.map((r) => ({ kind: r.kind, reference: r.reference }));
          const out = await post({ action: 'delete_records', targets: encodeTargets(going), confirm: typed.value.trim() });
          if (!out.deleted.length) {
            dlg.error(out.failed[0]?.error ?? 'Nothing could be deleted.');
            return true;
          }
          if (out.failed.length) {
            toast(`${out.deleted.length} deleted. ${out.failed.length} could not go — ${out.failed[0].error}`, 'bad', { timeout: 15_000 });
          } else {
            toast(`${out.deleted.length} ${out.deleted.length === 1 ? 'record' : 'records'} deleted. You can put them back one at a time from Settings → Recently deleted for ${out.keep_days} days.`,
              'ok', { timeout: 10_000 });
          }
          await onDone?.(out);
          return false;
        },
      },
    ]);
  }

  (async () => {
    try {
      preview = await api({ view: 'delete_preview_many', targets: encodeTargets(targets) });
    } catch (err) {
      body.replaceChildren(h('div', { class: 'banner banner-red' }, icon('alert', { size: 15 }), h('p', {}, err.message)));
      return;
    }
    if (!preview.records.length) {
      body.replaceChildren(h('div', { class: 'banner banner-amber' }, icon('alert', { size: 15 }),
        h('p', {}, 'None of those is here any more. The list will catch up in a moment.')));
      return;
    }
    body.replaceChildren(
      h('div', { class: 'banner banner-red' }, icon('alert', { size: 15 }),
        h('p', {}, h('strong', {}, 'This deletes customer data. '),
          `${preview.total} ${preview.total === 1 ? 'record' : 'records'} go, with everything that belongs to each of them.`)),
      h('ul', { class: 'del-list' }, preview.records.map((r) => h('li', {},
        h('span', { class: 'del-label' }, capital(r.label)),
        r.words?.length ? h('span', { class: 'muted small' }, asList(r.words)) : null))),
      preview.missing.length
        ? h('p', { class: 'muted' }, `${preview.missing.length} of what you ticked ${preview.missing.length === 1 ? 'is' : 'are'} already gone, and ${preview.missing.length === 1 ? 'is' : 'are'} not counted here.`)
        : null,
      h('p', { class: 'muted' },
        `They leave every screen at once. For ${preview.keep_days} days each one can be put back from Settings → Recently deleted; after that they are gone for good, files and all.`),
      h('div', { class: 'field' },
        h('label', { class: 'label', for: 'del-count' },
          'Type ', h('code', {}, preview.confirm_with), ' — the number of records — to confirm'),
        typed));
    typed.addEventListener('input', drawActions);
    drawActions();
    typed.focus();
  })();

  return dlg;
}

/**
 * Choosing several records on a list.
 *
 * The boxes are drawn with the rows and the bar is kept, so a list that
 * redraws itself (the live loop, a filter) keeps the selection: what is
 * remembered is the records, not the elements. `shownNow` is told what the
 * screen currently draws, which is what "select all" means - never the rows
 * nobody has loaded.
 *
 * @param {{ onDone?: Function }} opts  onDone runs after a deletion, to reload the list
 */
export function bulkSelection({ onDone = null } = {}) {
  const chosen = new Map();
  const boxes = new Set();
  let shown = [];
  const keyOf = (t) => `${t.kind}:${t.reference}`;

  const count = h('span', { class: 'select-count' });
  const all = h('button', { class: 'btn btn-sm', type: 'button' });
  const none = h('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, 'Clear');
  const del = h('button', { class: 'btn btn-sm btn-danger', type: 'button' });
  const bar = h('div', { class: 'select-bar', hidden: true, role: 'group', 'aria-label': 'What is selected' }, count, all, none, del);

  function paint() {
    bar.hidden = chosen.size === 0;
    count.textContent = `${chosen.size} selected`;
    fill(del, icon('trash', { size: 14 }), `Delete ${chosen.size === 1 ? 'it' : 'them'}`);
    all.hidden = shown.length <= chosen.size || shown.every((t) => chosen.has(keyOf(t)));
    all.textContent = `Select all ${shown.length} shown`;
    for (const b of [...boxes]) {
      if (!b.isConnected) { boxes.delete(b); continue; }
      b.checked = chosen.has(b.dataset.key);
    }
  }

  all.addEventListener('click', () => { for (const t of shown) chosen.set(keyOf(t), t); paint(); });
  none.addEventListener('click', () => { chosen.clear(); paint(); });
  del.addEventListener('click', () => deleteManyDialog({
    targets: [...chosen.values()],
    onDone: async (out) => { chosen.clear(); paint(); await onDone?.(out); },
  }));

  return {
    bar,
    /** A checkbox for one row, or null for anybody who may not delete. */
    box(target) {
      if (!canDelete() || !target) return null;
      const key = keyOf(target);
      const el = h('input', {
        type: 'checkbox', class: 'select-box', dataset: { key }, checked: chosen.has(key),
        'aria-label': `Select ${target.name ?? target.reference}`,
      });
      el.addEventListener('change', () => {
        if (el.checked) chosen.set(key, target); else chosen.delete(key);
        paint();
      });
      boxes.add(el);
      return el;
    },
    /** What the list draws right now: what "select all" takes. */
    shownNow(targets) { shown = (targets ?? []).filter(Boolean); paint(); },
  };
}
