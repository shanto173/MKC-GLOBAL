/**
 * The papers MKY issues: the CMR, and the MRN declaration sheet.
 *
 * A form, filled in from what the booking and its documents already say, that
 * can be saved half-done and come back to. Issuing renders the PDF, files it
 * against the booking and hands back a link - from which it opens, prints and
 * is sent like any other paper.
 *
 * The fields come from the server (lib/mky-docs.js), not from a copy here: one
 * description of what a CMR is, so a field added to the paper appears on this
 * screen in the same breath.
 */

import { h, icon, api, post, toast, toastError, dialog, add, fill, when, session } from './ui.js';

export const ISSUE_WORDS = {
  cmr: { title: 'CMR', opens: 'Issue the CMR', ic: 'file' },
  mrn: { title: 'MRN sheet', opens: 'Issue the MRN sheet', ic: 'fileText' },
};

/** Whoever may check a customer's paper may issue one of ours. */
export const canIssue = () => session.can('documents');

/**
 * @param {{ref: string, kind: 'cmr'|'mrn', onDone?: Function}} ctx
 */
export function issueDialog({ ref, kind, onDone = null }) {
  const body = h('div', { class: 'issue-body' }, h('p', { class: 'muted' }, 'Opening…'));
  const foot = h('p', { class: 'issue-foot muted small' });
  let values = {};
  let form = null;
  let busy = false;

  const dlg = dialog({
    title: ISSUE_WORDS[kind]?.title ?? 'Document',
    body: h('div', {}, body, foot),
    size: 'lg',
    actions: [],
  });

  // The dialog's own footer, filled directly: one of the buttons is a link to
  // the issued PDF, which setActions() cannot express.
  const buttons = dlg.el.querySelector('.dialog-actions');

  async function load() {
    try {
      form = await api({ view: 'mky_document', ref, kind });
      values = { ...form.values };
      draw();
    } catch (err) {
      fill(body, h('p', { class: 'tone-text-red' }, err.message));
    }
  }

  function draw() {
    const rows = form.fields.map((f) => {
      const id = `issue-${kind}-${f.key}`;
      const control = f.lines
        ? h('textarea', { id, rows: String(f.lines), class: 'input', dir: 'auto' })
        : h('input', { id, type: 'text', class: 'input', dir: 'auto' });
      control.value = values[f.key] ?? '';
      control.addEventListener('input', () => { values[f.key] = control.value; });
      return h('div', { class: `field${f.lines ? ' field-wide' : ''}` },
        h('label', { for: id }, f.box ? h('span', { class: 'issue-box' }, String(f.box)) : null, f.label),
        control,
        f.hint ? h('p', { class: 'field-hint' }, f.hint) : null);
    });

    fill(body,
      h('p', { class: 'muted small' }, form.note),
      h('div', { class: 'issue-grid' }, ...rows));

    fill(foot, form.status === 'issued'
      ? [`Issued ${when(form.issued_at)}${form.issued_by ? ` by ${form.issued_by}` : ''} · ${form.document_no}. `,
        'Issuing again replaces the PDF and keeps the same number.']
      : form.status === 'draft' ? ['Saved as a draft. Nothing has been issued yet.'] : ['Nothing issued yet.']);

    drawButtons();
  }

  function drawButtons() {
    const open = form.url
      ? h('a', { class: 'btn btn-ghost', href: form.url, target: '_blank', rel: 'noopener noreferrer' },
        icon('external', { size: 15 }), 'Open the PDF')
      : null;
    const save = h('button', { class: 'btn', type: 'button', disabled: busy }, icon('check', { size: 15 }), 'Save draft');
    const issue = h('button', { class: 'btn btn-primary', type: 'button', disabled: busy },
      icon('file', { size: 15 }), form.status === 'issued' ? 'Issue again' : 'Issue');

    save.addEventListener('click', () => run('mky_document_save', save, 'Saved.'));
    issue.addEventListener('click', () => run('mky_document_issue', issue, 'Issued.'));
    fill(buttons, open, h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dlg.close() }, 'Close'), save, issue);
  }

  async function run(action, button, done) {
    if (busy) return;
    busy = true;
    const was = button.textContent;
    button.textContent = '…';
    try {
      const out = await post({ action, ref, kind, values });
      if (out.status) form.status = out.status;
      if (out.document_no) form.document_no = out.document_no;
      if (out.issued_at) form.issued_at = out.issued_at;
      if (out.url) form.url = out.url;
      toast(done);
      // What was issued is a document on the booking now, so the page behind
      // this dialog is out of date the moment it lands.
      if (action === 'mky_document_issue') onDone?.();
      fill(foot, form.status === 'issued'
        ? [`Issued ${when(form.issued_at)} by ${session.name} · ${form.document_no}.`]
        : ['Saved as a draft. Nothing has been issued yet.']);
    } catch (err) {
      toastError(err);
    } finally {
      busy = false;
      button.textContent = was;
      drawButtons();
    }
  }

  load();
  return dlg;
}
