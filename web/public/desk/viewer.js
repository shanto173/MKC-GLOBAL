/**
 * The document viewer: the file on one side, what the bot read from it on the
 * other, checked against the booking - and the two decisions a person makes
 * about a paper: it looks right, or the customer must send a new one.
 *
 * The file is shown through a short-lived signed link fetched when the viewer
 * opens. If the link has expired by the time the browser asks for it (a page
 * left open, a slow network), the viewer fetches a fresh one once by itself.
 *
 * When the bot could not read the file at all, the viewer says so and lets the
 * person type what it says - kept apart from the bot's reading, with their name.
 */

import { h, clear, icon, api, post, toast, chip, when, dialog } from './ui.js';
import { previewBox } from './preview.js';

const TYPABLE_LABELS = {
  vin: 'Chassis (VIN)', mrn: 'MRN', acid: 'ACID', eur1: 'EUR.1 number', make: 'Make', model: 'Model', document_date: 'Date on the document',
};

/**
 * @param {{caseRef: string, docId: number, getData: () => object, reload: () => Promise<object>,
 *          onStale: Function, refreshCounts: Function}} ctx
 */
export function openViewer(ctx) {
  let docId = ctx.docId;
  let urlInfo = null;
  let retriedUrl = false;

  const fileArea = h('div', { class: 'viewer-file' });
  const info = h('div', { class: 'viewer-info' });
  const nav = h('div', { class: 'viewer-nav' });
  const body = h('div', { class: 'viewer' }, fileArea, info);

  const dlg = dialog({ title: 'Document', body: [nav, body], size: 'xl', actions: [] });
  dlg.el.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
  });

  const allDocs = () => {
    const d = ctx.getData();
    const order = d.checklist.filter((c) => c.document_id).map((c) => c.document_id);
    for (const o of d.other_documents) if (!order.includes(o.id)) order.push(o.id);
    return order.map((id) => d.documents.find((x) => x.id === id)).filter(Boolean);
  };
  const current = () => ctx.getData().documents.find((d) => d.id === docId);

  function step(delta) {
    const list = allDocs();
    const i = list.findIndex((d) => d.id === docId);
    const next = list[i + delta];
    if (next) { docId = next.id; draw({ reloadFile: true }); }
  }

  function draw({ reloadFile = false } = {}) {
    const doc = current();
    if (!doc) { dlg.close(); return; }
    const list = allDocs();
    const i = list.findIndex((d) => d.id === docId);
    dlg.el.querySelector('.dialog-title').textContent = `${doc.label} · ${ctx.caseRef}`;
    clear(nav).append(
      h('button', { class: 'btn btn-small btn-quiet', type: 'button', disabled: i <= 0, onclick: () => step(-1) }, icon('left', { size: 14 }), 'Previous'),
      h('span', { class: 'viewer-count' }, `${i + 1} of ${list.length}`),
      h('button', { class: 'btn btn-small btn-quiet', type: 'button', disabled: i >= list.length - 1, onclick: () => step(1) }, 'Next', icon('right', { size: 14 })));
    if (reloadFile) { urlInfo = null; retriedUrl = false; loadFile(doc); }
    drawInfo(doc);
  }

  // -- the file ----------------------------------------------------------------
  async function loadFile(doc) {
    clear(fileArea).append(h('p', { class: 'viewer-loading' }, 'Opening the file…'));
    if (!doc.has_file) {
      clear(fileArea).append(h('div', { class: 'viewer-nofile' }, icon('file', { size: 32 }),
        h('p', {}, 'The file itself was not stored — only what was read from it.')));
      return;
    }
    try {
      urlInfo = await api({ view: 'document_url', id: doc.id });
    } catch (err) {
      clear(fileArea).append(h('div', { class: 'viewer-nofile' }, h('p', {}, err.message),
        h('button', { class: 'btn', type: 'button', onclick: () => loadFile(doc) }, 'Try again')));
      return;
    }
    if (doc.id !== docId) return;
    showFile(doc);
  }

  /** The signed link expired before the browser used it: fetch a fresh one, once. */
  function expired(doc) {
    if (retriedUrl) {
      clear(fileArea).append(h('div', { class: 'viewer-nofile' }, h('p', {}, 'The file would not open.'),
        h('button', { class: 'btn', type: 'button', onclick: () => { retriedUrl = false; loadFile(doc); } }, 'Try again')));
      return;
    }
    retriedUrl = true;
    loadFile(doc);
  }

  function showFile(doc) {
    const mime = String(urlInfo.mime_type ?? doc.mime_type ?? '');
    const open = h('a', { class: 'btn btn-small btn-quiet', href: urlInfo.url, target: '_blank', rel: 'noopener noreferrer' },
      icon('external', { size: 14 }), 'Open in a new tab');
    let frame;
    if (mime.startsWith('image/')) {
      frame = h('img', { class: 'viewer-img', src: urlInfo.url, alt: `${doc.label} as sent by the customer` });
      frame.addEventListener('error', () => expired(doc));
    } else if (mime === 'application/pdf' || /\.pdf$/i.test(doc.file_name ?? '')) {
      frame = h('iframe', { class: 'viewer-pdf', src: urlInfo.url, title: `${doc.label} (PDF)` });
    } else {
      frame = h('div', { class: 'viewer-nofile' }, icon('file', { size: 32 }), h('p', {}, 'This kind of file cannot be shown here.'));
    }
    // A link fetched earlier than its expiry minus a margin is still good; past
    // it, ask again rather than show a broken frame.
    if (urlInfo.expires_at && new Date(urlInfo.expires_at) < new Date()) return expired(doc);
    clear(fileArea).append(frame, h('div', { class: 'viewer-file-bar' },
      h('span', { class: 'muted small' }, doc.file_name ?? ''), open));
  }

  // -- what the bot read, and the decision ---------------------------------------
  function drawInfo(doc) {
    const d = ctx.getData();
    const actions = d.document_actions;
    const mismatch = doc.checks.filter((c) => !c.match);

    clear(info).append(
      h('div', { class: 'viewer-status' },
        chip(doc.status_words, doc.tone),
        h('span', { class: 'muted small' }, `Arrived ${when(doc.uploaded_at)}`)),
      mismatch.length ? h('div', { class: 'callout callout-red', role: 'note' }, icon('alert', { size: 16 }),
        h('p', {}, h('strong', {}, 'Does not match the booking. '),
          mismatch.map((c) => `${c.label}: the document says ${c.document}, the booking says ${c.booking}.`).join(' '))) : null,
      doc.reading ? h('div', { class: 'callout callout-gray' }, h('p', {}, 'The bot is still reading this file. Look again in a moment.')) : null,
      doc.unreadable ? typeIn(doc, actions) : readTable(doc),
      doc.typed_by ? h('p', { class: 'muted small' }, `Values typed by ${doc.typed_by}.`) : null,
      decision(doc, actions));
  }

  function readTable(doc) {
    if (!doc.read.length) return h('p', { class: 'muted' }, 'The bot found nothing it could read on this document.');
    const byField = new Map(doc.checks.map((c) => [c.field, c]));
    return h('div', {},
      h('h3', { class: 'viewer-h' }, 'What the bot read'),
      h('table', { class: 'read-table' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Field'), h('th', { scope: 'col' }, 'On the document'), h('th', { scope: 'col' }, 'On the booking'))),
        h('tbody', {}, doc.read.map((f) => {
          const c = byField.get(f.field);
          return h('tr', { class: c && !c.match ? 'is-mismatch' : '' },
            h('th', { scope: 'row' }, f.label),
            h('td', { dir: 'auto', class: f.field === 'vin' || f.field === 'mrn' ? 'mono' : '' }, String(f.value), f.typed ? h('span', { class: 'muted small' }, ' (typed)') : null),
            h('td', {}, c ? h('span', { class: `match ${c.match ? 'match-yes' : 'match-no'}` },
              icon(c.match ? 'check' : 'alert', { size: 13 }), c.match ? ' Matches' : ` Differs: ${c.booking}`) : h('span', { class: 'muted' }, '—')));
        }))));
  }

  /** The bot could not read it; a person reads it and types what it says. */
  function typeIn(doc, actions) {
    const inputs = {};
    const form = h('form', { class: 'type-in' },
      h('div', { class: 'callout callout-amber' }, icon('alert', { size: 16 }),
        h('p', {}, h('strong', {}, 'The bot couldn’t read this file. '), 'It is a scan or a photo without readable text. Type what you see — only what matters for this booking.')),
      actions.typable.map((k) => {
        inputs[k] = h('input', { class: `input${k === 'vin' || k === 'mrn' ? ' mono' : ''}`, id: `type-${k}`, autocomplete: 'off', spellcheck: 'false' });
        return h('div', { class: 'field' }, h('label', { for: `type-${k}`, class: 'label' }, TYPABLE_LABELS[k] ?? k), inputs[k]);
      }),
      h('button', { class: 'btn', type: 'submit', disabled: !actions.type_values.enabled, title: actions.type_values.reason }, 'Save what I typed'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()]).filter(([, v]) => v));
      if (!Object.keys(values).length) return toast('Type at least one value from the document.', 'info');
      try {
        await post({ action: 'mark_document_read_values', document_id: doc.id, values, version: ctx.getData().version });
        toast('Saved. The values are checked against the booking.');
        await ctx.reload();
        ctx.refreshCounts();
        draw();
      } catch (err) {
        if (err.data?.stale) { dlg.close(); return ctx.onStale(err); }
        toast(err.message, 'bad');
      }
    });
    return form;
  }

  function decision(doc, actions) {
    if (doc.status === 'replacement_requested') {
      return h('div', { class: 'viewer-decided' }, icon('refresh', { size: 16 }),
        h('p', {}, `A new copy was asked for${doc.rejection_reason ? `: ${doc.rejection_reason}` : '.'}`));
    }
    const box = h('div', { class: 'viewer-actions' });
    const verified = doc.status === 'verified';
    const ok = h('button', {
      class: 'btn btn-primary', type: 'button', 'aria-disabled': actions.verify.enabled ? null : 'true', title: actions.verify.reason,
    }, icon('check', { size: 15 }), verified ? 'Checked' : 'Looks right');
    if (verified) ok.disabled = true;
    const bad = h('button', {
      class: 'btn', type: 'button', 'aria-disabled': actions.reject.enabled ? null : 'true', title: actions.reject.reason,
    }, 'Ask for a new one');

    ok.addEventListener('click', async () => {
      if (!actions.verify.enabled) return toast(actions.verify.reason, 'info');
      ok.disabled = true;
      try {
        await post({ action: 'verify_document', document_id: doc.id, version: ctx.getData().version });
        toast(`${doc.label} checked.`);
        await ctx.reload();
        ctx.refreshCounts();
        // Straight on to the next paper that still needs eyes.
        const next = allDocs().find((x) => x.id !== doc.id && ['received', 'pending_verification'].includes(x.status));
        if (next) { docId = next.id; draw({ reloadFile: true }); } else draw();
      } catch (err) {
        if (err.data?.stale) { dlg.close(); return ctx.onStale(err); }
        toast(err.message, 'bad');
        ok.disabled = false;
      }
    });
    bad.addEventListener('click', () => {
      if (!actions.reject.enabled) return toast(actions.reject.reason, 'info');
      askForNew(doc, actions);
    });

    box.append(ok, bad);
    if (!actions.verify.enabled && actions.verify.reason) box.append(h('p', { class: 'reason' }, actions.verify.reason));
    return box;
  }

  /** Why, a note, the exact message in the customer's language, then send. */
  function askForNew(doc, actions) {
    const version = ctx.getData().version;
    const suggested = doc.wrong_vehicle ? 'wrong_vin' : doc.unreadable ? 'unreadable' : 'unreadable';
    const reasons = h('fieldset', { class: 'radios' }, h('legend', { class: 'label' }, 'What is wrong with it?'),
      actions.reasons.map((r) => h('label', { class: 'radio' },
        h('input', { type: 'radio', name: 'reason', value: r.code, checked: r.code === suggested }), r.words)));
    const note = h('textarea', { class: 'input', rows: '2', dir: 'auto', placeholder: 'Optional — anything specific they should know' });
    const reasonCode = () => reasons.querySelector('input:checked')?.value ?? 'other';
    const pv = previewBox(() => ({ kind: 'reject_document', document_id: doc.id, reason_code: reasonCode(), note: note.value.trim() }));
    reasons.addEventListener('change', pv.update);
    note.addEventListener('input', pv.update);

    const back = h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => draw() }, 'Back');
    const send = h('button', { class: 'btn btn-primary', type: 'button' }, 'Send to customer');
    let sending = false;
    send.addEventListener('click', async () => {
      if (sending) return;
      sending = true;
      send.disabled = true;
      send.textContent = 'Sending…';
      try {
        await post({ action: 'reject_document', document_id: doc.id, reason_code: reasonCode(), reason: note.value.trim(), version });
        toast(`Asked for a new ${doc.label}. The booking now waits for the customer.`);
        await ctx.reload();
        ctx.refreshCounts();
        draw();
      } catch (err) {
        if (err.data?.stale) { dlg.close(); return ctx.onStale(err); }
        toast(err.message, 'bad');
        send.disabled = false;
        send.textContent = 'Send to customer';
      } finally {
        sending = false;
      }
    });

    clear(info).append(
      h('h3', { class: 'viewer-h' }, `Ask for a new ${doc.label}`),
      reasons,
      h('label', { class: 'label' }, 'Note to the customer'), note,
      pv.el,
      h('div', { class: 'viewer-actions' }, send, back));
    pv.now();
    reasons.querySelector('input:checked')?.focus();
  }

  draw({ reloadFile: true });
}
