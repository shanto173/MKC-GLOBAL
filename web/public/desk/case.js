/**
 * The case page: a booking, a call-back or an MRN application - same layout.
 *
 * The top says what this is and whose move it is. The "Next step" card says
 * the one thing to do and has the one button that does it; everything else is
 * secondary and quieter. Below: the papers, the details (correctable), notes
 * that never leave the desk, and what has happened so far. On the right, the
 * conversation with the customer.
 *
 * Every action sends the version of the case this page was drawn from. If a
 * colleague changed the case meanwhile, the server refuses with who and when,
 * and the page redraws itself from the latest.
 */

import {
  h, clear, icon, api, post, toast, chip, timeEl, ago, when, emptyState, errorState, skeleton, actionButton, dialog, draft, session, add, fill, lines,
} from './ui.js';
import { mountConversation } from './conversation.js';
import { openViewer } from './viewer.js';
import { previewBox } from './preview.js';
import { linkFor } from './inbox.js';

const TURN_TONE = { ops: 'blue', client: 'amber', none: 'green' };
const TURN_WORDS = { ops: 'Our turn', client: 'Customer’s turn', none: 'Nothing to do' };
const CHECK_ICON = {
  checked: ['check', 'green'], received: ['circle', 'blue'], mismatch: ['alert', 'red'], unreadable: ['alert', 'red'],
  replacement: ['refresh', 'amber'], missing: ['circle', 'amber'], reading: ['clock', 'gray'],
};
const DETAIL_LABELS = {
  customer_name: 'Customer name', customer_contact: 'Phone or email', company: 'Company', vin: 'Chassis (VIN)',
  make: 'Make', model: 'Model', origin_port: 'Loading port', destination_port: 'Destination',
};

export function renderCase({ route, main, refreshCounts }) {
  const [type, ref] = route.parts;
  if (!['booking', 'request', 'mrn'].includes(type) || !ref) {
    add(main, emptyState('There is nothing to show here.', null, h('a', { class: 'btn', href: '#/inbox' }, 'Back to the inbox')));
    return null;
  }

  const target = type === 'booking' ? { booking_ref: ref } : type === 'request' ? { ticket_ref: ref } : { request_ref: ref };
  let data = null;
  let drawnAs = null;      // what the page was last drawn from, to redraw only on change
  let convo = null;
  let openedDoc = false;

  const root = h('div', { class: 'case' }, skeleton(10));
  add(main, root);

  const headEl = h('header', { class: 'case-head' });
  const mainCol = h('div', { class: 'case-sections' });
  const side = h('aside', { class: 'case-side', id: 'conversation', 'aria-label': 'Conversation with the customer' });
  const sticky = h('div', { class: 'sticky-bar' });

  /**
   * @param {{quiet?: boolean, own?: boolean}} opts
   *   quiet - a background refresh: no skeleton, no error page
   *   own   - after this operator's own action: redraw at once, and do not
   *           announce as news a change they just made themselves
   */
  async function load({ quiet = false, own = false } = {}) {
    let fresh;
    try {
      fresh = await api({ view: 'case', type, ref });
    } catch (err) {
      if (!quiet) fill(root, errorState(err.status === 404 ? err.message : (err.message || 'We could not load this case.'), err.status === 404 ? null : () => load()));
      return null;
    }
    // Two different questions. Did the CASE change (its version: what a
    // decision rests on)? That is worth telling the operator about if a
    // colleague did it. Did anything SHOWN change (a note, the history)?
    // That only needs redrawing.
    const changedCase = data && fresh.version !== data.version;
    const byOther = changedCase && fresh.last_change && fresh.last_change.who !== session.name;
    const shown = JSON.stringify(fresh);
    const changed = shown !== drawnAs;
    data = fresh;
    if (!root.contains(headEl)) {
      // The header sits in the left column so the conversation can run the
      // full height on the right, its composer in view without scrolling.
      fill(root, h('div', { class: 'case-grid' }, h('div', { class: 'case-main' }, headEl, mainCol), side), sticky);
      convo = mountConversation(side, {
        channel: data.conversation.channel,
        chatId: data.conversation.chat_id,
        target,
        draftKey: `chat:${type}:${ref}`,
      });
    }
    if (changed) {
      // Not while somebody is typing in the page: a redraw would take the
      // field away mid-word. It happens as soon as they leave the field.
      const typing = quiet && !own && mainCol.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (typing) {
        mainCol.addEventListener('focusout', () => setTimeout(() => {
          if (!mainCol.contains(document.activeElement)) { drawnAs = JSON.stringify(data); draw(); }
        }, 0), { once: true });
      } else {
        drawnAs = shown;
        draw();
      }
    }
    if (byOther && quiet && !own) toast(`Updated: ${fresh.last_change.who} ${fresh.last_change.what}.`, 'info');
    if (!openedDoc && route.query.doc && type === 'booking') {
      openedDoc = true;
      openDoc(Number(route.query.doc));
    }
    return data;
  }

  /** After an action: reload, recount, and say what happened. */
  async function after(message, tone = 'ok') {
    if (message) toast(message, tone);
    await load({ quiet: true, own: true });
    refreshCounts();
  }

  /**
   * After an action that tells the customer: what the server found when it
   * asked whether they were reached, in its words and in the tone it deserves.
   * Nothing is assumed here any more - "The customer is being told" used to be
   * said even when the message had been refused, and a red "could NOT be told"
   * appeared for WhatsApp customers who were reading the message.
   */
  async function afterTelling(done, r) {
    await after(done);
    const warned = new Set(r?.warnings ?? []);
    for (const w of warned) toast(w, 'bad', { timeout: 15000 });
    const told = r?.customer_told;
    if (told?.words && !warned.has(told.words)) {
      toast(told.words, told.warn ? 'bad' : told.reached === 'sent' ? 'ok' : 'info', { timeout: told.warn ? 15000 : 9000 });
    }
  }

  /** A refusal because the case moved on: say who did what, and show the latest. */
  async function stale(err) {
    toast(err.message, 'info', { timeout: 9000 });
    await load({ quiet: true, own: true });
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  function draw() {
    drawHead();
    fill(mainCol, 
      nextStepCard(),
      warnings(),
      type === 'booking' ? documentsCard() : null,
      type === 'booking' && data.mrn ? mrnCard() : null,
      type === 'request' ? requestCard() : null,
      type === 'mrn' ? applicationCard() : null,
      type === 'booking' ? detailsCard() : null,
      notesCard(),
      historyCard());
    drawSticky();
  }

  function drawHead() {
    const hd = data.header;
    const facts = [
      hd.title && type !== 'booking' ? h('span', {}, hd.title) : null,
      hd.vehicle ? h('span', {}, hd.vehicle) : null,
      hd.vin ? h('span', { class: 'mono' }, hd.vin) : null,
      hd.route ? h('span', {}, hd.route) : null,
      hd.submitted_at ? h('span', {}, 'Came in ', timeEl(hd.submitted_at, ago(hd.submitted_at))) : null,
    ].filter(Boolean);

    fill(headEl, 
      h('a', { class: 'back', href: '#/inbox' }, icon('back', { size: 16 }), 'Inbox'),
      h('div', { class: 'case-title-row' },
        h('h1', { class: 'case-ref' }, hd.ref),
        chip(hd.status_words, hd.tone),
        chip(TURN_WORDS[hd.turn] ?? TURN_WORDS.none, TURN_TONE[hd.turn] ?? 'gray', 'chip-outline'),
        hd.priority === 'urgent' ? chip('Urgent', 'red') : hd.priority === 'high' ? chip('High priority', 'amber') : null),
      h('p', { class: 'case-facts' }, facts.flatMap((f, i) => (i ? [h('span', { class: 'dot', 'aria-hidden': 'true' }, '·'), f] : [f]))),
      ownership());
  }

  /** Who has this case, and the one control that changes that. */
  function ownership() {
    const t = data.take;
    if (!t) return data.header.assigned_to ? h('p', { class: 'case-owner' }, icon('user', { size: 14 }), `${data.header.assigned_to} has this`) : null;
    // A request is put back with request_assign; a booking has its own unassign.
    const body = t.action === 'unassign' && type === 'request' ? { action: 'request_assign', clear: true } : { action: t.action };
    return h('div', { class: `case-owner owner-${t.state}` },
      icon('user', { size: 14 }), h('span', {}, t.words),
      actionButton({ ...t, kind: t.state === 'nobody' ? 'secondary' : 'quiet' }, (e, b) => quick(b, body,
        t.action === 'unassign' ? 'Put back for anyone to take.' : 'It is yours now.'), { cls: 'btn-small' }));
  }

  function nextStepCard() {
    const n = data.next_step;
    const tone = TURN_TONE[n.owner] ?? 'gray';
    const shown = n.secondary.filter((s) => !s.more);
    const more = n.secondary.filter((s) => s.more);
    return h('section', { class: `card next next-${tone}`, 'aria-labelledby': 'next-title' },
      h('p', { class: 'eyebrow' }, 'Next step'),
      h('h2', { class: 'next-title', id: 'next-title' }, n.title),
      n.detail ? h('p', { class: 'next-detail' }, n.detail) : null,
      h('div', { class: 'next-actions' },
        n.primary ? actionButton(n.primary, () => run(n.primary), { cls: 'btn-large', showReason: true }) : null,
        shown.map((s) => actionButton({ ...s, kind: s.kind === 'danger' ? 'danger-quiet' : 'quiet' }, () => run(s))),
        more.length ? moreMenu(more) : null));
  }

  function moreMenu(items) {
    const menu = h('details', { class: 'menu' },
      h('summary', { class: 'btn btn-quiet' }, 'More', icon('down', { size: 14 })),
      h('div', { class: 'menu-list', role: 'menu' }, items.map((s) => {
        const item = h('button', {
          class: `menu-item${s.kind === 'danger' ? ' menu-danger' : ''}`, type: 'button', role: 'menuitem',
          'aria-disabled': s.enabled ? null : 'true',
        }, h('span', { class: 'menu-item-title' }, s.label), !s.enabled && s.reason ? h('span', { class: 'menu-item-sub' }, s.reason) : null);
        item.addEventListener('click', () => {
          menu.open = false;
          if (!s.enabled) { toast(s.reason, 'info'); return; }
          run(s);
        });
        return item;
      })));
    return menu;
  }

  function warnings() {
    const out = [];
    if (data.duplicate) {
      const d = data.duplicate;
      out.push(h('div', { class: 'callout callout-red', role: 'note' },
        icon('alert', { size: 16 }),
        h('p', {}, h('strong', {}, 'Same chassis, another booking. '),
          `${d.booking_ref} (${d.status_words}, `, h('bdi', {}, d.customer_name ?? 'unknown customer'), ') already uses this chassis. ',
          h('a', { href: linkFor({ type: 'booking', ref: d.booking_ref }) }, 'Open it'))));
    }
    if (type === 'booking' && data.shipment) {
      const s = data.shipment;
      out.push(h('div', { class: 'callout callout-green' }, icon('ship', { size: 16 }),
        h('p', {}, `Shipment ${s.shipment_id} is open — ${s.status}. `, h('a', { href: linkFor({ type: 'shipment', id: s.shipment_id }) }, 'Update the shipment'))));
    }
    return out.length ? h('div', { class: 'warnings' }, out) : null;
  }

  function documentsCard() {
    const list = data.checklist;
    return h('section', { class: 'card', 'aria-labelledby': 'docs-title' },
      h('div', { class: 'card-head' },
        h('h2', { id: 'docs-title' }, 'Documents'),
        h('p', { class: 'card-sub' }, list.length ? `${list.filter((c) => c.state === 'checked').length} of ${list.length} checked` : '')),
      data.required_note ? h('p', { class: 'muted' }, data.required_note) : null,
      list.length ? h('ul', { class: 'checklist' }, list.map((c) => {
        const [ic, tone] = CHECK_ICON[c.state] ?? ['circle', 'gray'];
        return h('li', { class: `check-row check-${c.state}` },
          h('span', { class: `check-icon tone-text-${tone}` }, icon(ic, { size: 18 })),
          h('span', { class: 'check-label' }, c.label),
          h('span', { class: `check-words tone-text-${tone}` }, c.words),
          c.document_id
            ? h('button', { class: 'btn btn-small', type: 'button', onclick: () => openDoc(c.document_id) },
              ['received', 'mismatch', 'unreadable'].includes(c.state) ? 'Check' : 'View')
            : h('span', { class: 'check-none' }, '—'));
      })) : null,
      data.other_documents.length ? h('div', { class: 'other-docs' },
        h('h3', {}, 'Other files'),
        h('ul', { class: 'checklist' }, data.other_documents.map((d) => h('li', { class: 'check-row' },
          h('span', { class: 'check-icon' }, icon('file', { size: 18 })),
          h('span', { class: 'check-label' }, d.label),
          h('span', { class: 'check-words' }, d.status_words),
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => openDoc(d.id) }, 'View'))))) : null);
  }

  function mrnCard() {
    const m = data.mrn;
    return h('section', { class: 'card', 'aria-labelledby': 'mrn-title' },
      h('div', { class: 'card-head' }, h('h2', { id: 'mrn-title' }, 'MRN — MKY is getting it'), chip(m.status_words, m.mrn_number ? 'green' : 'blue')),
      h('dl', { class: 'details' },
        row('MRN number', m.mrn_number ? h('span', { class: 'mono' }, m.mrn_number) : 'Not issued yet'),
        m.request_ref ? row('Application', h('a', { href: linkFor({ type: 'mrn', ref: m.request_ref }) }, m.request_ref)) : null),
      m.supplied.length ? h('div', {}, h('h3', {}, 'What the customer told us'),
        h('ul', { class: 'said' }, m.supplied.map((s) => h('li', {}, h('span', { class: 'muted' }, when(s.at)), ' ', h('bdi', { dir: 'auto' }, s.text))))) : null);
  }

  function requestCard() {
    const r = data.request;
    return h('section', { class: 'card', 'aria-labelledby': 'asked-title' },
      h('div', { class: 'card-head' }, h('h2', { id: 'asked-title' }, 'What the customer asked')),
      h('div', { class: 'said-block' }, lines(r.summary || 'They did not say.')),
      h('dl', { class: 'details' },
        row('Call them on', r.contact ? h('a', { href: `tel:${r.contact.replace(/[^\d+]/g, '')}` }, h('bdi', {}, r.contact)) : 'No number given — reply in the chat'),
        row('Department', r.department),
        r.booking_ref ? row('About booking', h('a', { href: linkFor({ type: 'booking', ref: r.booking_ref }) }, r.booking_ref)) : null,
        r.resolution_note ? row('They were told', h('bdi', { dir: 'auto' }, r.resolution_note)) : null),
      data.bookings?.length ? h('div', {}, h('h3', {}, 'Their bookings'),
        h('ul', { class: 'mini-list' }, data.bookings.map((b) => h('li', {},
          h('a', { href: linkFor({ type: 'booking', ref: b.booking_ref }) }, b.booking_ref), ' ',
          chip(b.status_words, b.tone), ' ', [b.make, b.vin].filter(Boolean).join(' · '))))) : null);
  }

  function applicationCard() {
    const m = data.mrn;
    return h('section', { class: 'card', 'aria-labelledby': 'app-title' },
      h('div', { class: 'card-head' }, h('h2', { id: 'app-title' }, 'The application')),
      h('dl', { class: 'details' },
        row('MRN number', m.mrn_number ? h('span', { class: 'mono' }, m.mrn_number) : 'Not issued yet'),
        data.booking ? row('Booking', h('span', {}, h('a', { href: linkFor({ type: 'booking', ref: data.booking.booking_ref }) }, data.booking.booking_ref), ` · ${data.booking.status_words}`)) : row('Booking', 'None linked'),
        m.missing?.length ? row('Still needed', m.missing.join(', ')) : null,
        m.notes ? row('Desk notes', h('bdi', { dir: 'auto' }, m.notes)) : null),
      m.supplied.length ? h('div', {}, h('h3', {}, 'What the customer told us'),
        h('ul', { class: 'said' }, m.supplied.map((s) => h('li', {}, h('span', { class: 'muted' }, when(s.at)), ' ', h('bdi', { dir: 'auto' }, s.text))))) : null);
  }

  // -- details, correctable in place ------------------------------------------
  function detailsCard() {
    const b = data.booking;
    const dl = h('dl', { class: 'details details-edit' });
    for (const [field, label] of Object.entries(DETAIL_LABELS)) add(dl, ...detailRow(field, label, b[field]));
    return h('section', { class: 'card', 'aria-labelledby': 'details-title' },
      h('div', { class: 'card-head' },
        h('h2', { id: 'details-title' }, 'Details'),
        h('p', { class: 'card-sub' }, b.editable ? 'Correct a mistake in place. Every change is recorded with who made it.' : (b.edit_reason ?? ''))),
      dl,
      h('p', { class: 'muted small' }, `MRN: ${b.mrn_choice === 'mky_issue' ? 'MKY is getting it' : b.mrn_choice === 'existing' ? 'the customer has it' : 'not said'}${b.mrn_number ? ` · ${b.mrn_number}` : ''}`));
  }

  function detailRow(field, label, value) {
    const dt = h('dt', {}, label);
    const dd = h('dd', {});
    const show = () => {
      fill(dd, 
        h('bdi', { class: field === 'vin' ? 'mono' : '' }, value || '—'),
        data.booking.editable ? h('button', { class: 'link-btn', type: 'button', onclick: edit, 'aria-label': `Correct ${label.toLowerCase()}` }, 'Correct') : null);
    };
    const edit = () => {
      const version = data.version;
      const input = h('input', { class: `input${field === 'vin' ? ' mono' : ''}`, value: value ?? '', 'aria-label': label, dir: 'auto' });
      const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
      const save = h('button', { class: 'btn btn-primary btn-small', type: 'button' }, 'Save');
      const cancel = h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: show }, 'Cancel');
      const submit = async () => {
        save.disabled = true;
        try {
          await post({ action: 'edit_details', booking_ref: ref, version, field, value: input.value });
          await after(`${label} corrected.`);
        } catch (e) {
          if (e.data?.stale) return stale(e);
          err.textContent = e.message;
          err.hidden = false;
          save.disabled = false;
        }
      };
      save.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') show(); });
      fill(dd, h('span', { class: 'inline-edit' }, input, save, cancel), err);
      input.focus();
      input.select();
    };
    show();
    return [dt, dd];
  }

  function row(label, value) {
    return [h('dt', {}, label), h('dd', {}, value ?? '—')];
  }

  // -- notes: unmistakably internal ---------------------------------------------
  function notesCard() {
    const key = `note:${type}:${ref}`;
    const ta = h('textarea', { class: 'input', rows: '2', dir: 'auto', 'aria-label': 'Internal note', placeholder: 'For the team only…' });
    ta.value = draft.get(key);
    ta.addEventListener('input', () => draft.set(key, ta.value));
    const save = h('button', { class: 'btn btn-small', type: 'button', disabled: !session.can('notes') }, 'Save note');
    save.addEventListener('click', async () => {
      if (ta.value.trim().length < 2) return toast('Write the note first.', 'info');
      save.disabled = true;
      try {
        await post({ action: 'internal_note', ...target, body: ta.value.trim() });
        draft.set(key, '');
        await after('Note saved.');
      } catch (e) {
        toast(e.message, 'bad');
        save.disabled = false;
      }
    });
    const notes = data.notes ?? [];
    return h('section', { class: 'card notes', 'aria-labelledby': 'notes-title' },
      h('div', { class: 'card-head' },
        h('h2', { id: 'notes-title' }, icon('lock', { size: 15 }), 'Internal notes'),
        h('p', { class: 'card-sub notes-badge' }, 'Never sent to the customer')),
      session.can('notes') ? h('div', { class: 'note-compose' }, ta, save) : null,
      notes.length ? h('ul', { class: 'note-list' }, notes.map((n) => h('li', { class: 'note' },
        h('p', { class: 'note-meta' }, h('strong', {}, n.author), ' · ', timeEl(n.at, when(n.at))),
        h('div', { class: 'note-body' }, lines(n.body))))) : h('p', { class: 'muted' }, 'No notes yet.'));
  }

  function historyCard() {
    const items = data.history ?? [];
    let showAll = false;
    const list = h('ol', { class: 'timeline' });
    const toggle = h('button', { class: 'link-btn', type: 'button' });
    const paint = () => {
      fill(list, ...(showAll ? items : items.slice(0, 8)).map((a) => h('li', {},
        timeEl(a.at, when(a.at)), h('span', {}, h('strong', {}, a.who), ` ${a.what}`))));
      toggle.textContent = showAll ? 'Show less' : `Show all (${items.length})`;
      toggle.hidden = items.length <= 8;
    };
    toggle.addEventListener('click', () => { showAll = !showAll; paint(); });
    paint();
    return h('section', { class: 'card', 'aria-labelledby': 'history-title' },
      h('div', { class: 'card-head' }, h('h2', { id: 'history-title' }, 'History')),
      items.length ? [list, toggle] : h('p', { class: 'muted' }, 'Nothing recorded yet.'));
  }

  /**
   * On a phone the primary action stays in reach at the bottom of the screen -
   * shown once the Next step card itself has scrolled out of view.
   */
  let watcher = null;
  function drawSticky() {
    watcher?.disconnect();
    const card = mainCol.querySelector('.next');
    if (card && 'IntersectionObserver' in window) {
      watcher = new IntersectionObserver(([e]) => sticky.classList.toggle('is-visible', !e.isIntersecting));
      watcher.observe(card);
    } else {
      sticky.classList.add('is-visible');
    }
    const p = data.next_step.primary;
    fill(sticky, 
      p ? actionButton(p, () => run(p), { cls: 'btn-block' }) : h('span', { class: 'sticky-words' }, data.next_step.title),
      data.conversation.chat_id ? h('a', { class: 'btn', href: '#conversation', onclick: (e) => { e.preventDefault(); side.scrollIntoView({ behavior: 'smooth' }); } }, icon('chats', { size: 16 }), 'Chat') : null);
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  function run(spec) {
    switch (spec.action) {
      case 'open_document': return spec.document_id ? openDoc(spec.document_id) : null;
      case 'request_info': return askDialog(spec.prefill ?? '');
      case 'confirm': return confirmDialog(spec.warning);
      case 'reject': return rejectDialog();
      case 'cancel': return simpleDialog({
        title: 'Cancel this request?', words: 'Use this when the customer withdrew it. The customer is not told.',
        label: 'Cancel request', kind: 'danger', body: { action: 'cancel' }, done: 'Cancelled.',
      });
      case 'priority': return priorityDialog();
      case 'assign': return assignDialog('assign');
      case 'request_assign': return assignDialog('request_assign');
      case 'create_booking': return referenceDialog();
      case 'issue_mrn': return mrnDialog(spec.request_ref ?? data.mrn?.request_ref ?? null);
      case 'mrn_need_info': return mrnInfoDialog();
      case 'mrn_review': return quick(null, { action: 'mrn_review' }, 'Marked as being worked on.');
      case 'mrn_reject': return simpleDialog({
        title: 'Reject this MRN application?', words: 'The customer is not told automatically — write to them in the conversation.',
        label: 'Reject application', kind: 'danger', body: { action: 'mrn_reject' }, done: 'Application rejected.', note: 'Why (for the team)',
      });
      case 'request_resolve': return resolveDialog();
      case 'request_status':
        if (spec.status === 'closed') {
          return simpleDialog({
            title: 'Close without a message?', words: 'The customer is not told. Use this for duplicates and requests that need no answer.',
            label: 'Close request', kind: 'danger', body: { action: 'request_status', status: 'closed' }, done: 'Closed.',
          });
        }
        return quick(null, { action: 'request_status', status: spec.status }, 'Updated.');
      case 'take': return quick(null, { action: 'take' }, 'It is yours now.');
      default: return toast('That action is not available here.', 'info');
    }
  }

  /** An action with no questions to ask: send it with the version this page shows. */
  async function quick(button, body, ok) {
    if (button) button.disabled = true;
    try {
      await post({ ...target, version: data.version, ...body });
      await after(ok);
    } catch (e) {
      if (e.data?.stale) return stale(e);
      toast(e.message, 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  }

  function openDoc(id) {
    openViewer({
      caseRef: ref,
      docId: id,
      getData: () => data,
      reload: () => load({ quiet: true, own: true }),
      onStale: stale,
      refreshCounts,
    });
  }

  function askDialog(prefill) {
    const version = data.version;
    const ta = h('textarea', { class: 'input', rows: '4', dir: 'auto', 'aria-describedby': 'ask-hint' });
    ta.value = prefill;
    const pv = previewBox(() => (ta.value.trim() ? { kind: 'request_info', booking_ref: ref, requested: ta.value.trim() } : null));
    ta.addEventListener('input', pv.update);
    pv.now();
    dialog({
      title: 'Ask the customer for something',
      subtitle: 'The booking waits for them until they answer.',
      body: [h('label', { class: 'label' }, 'What should they send or tell us?'),
        ta, h('p', { class: 'field-hint', id: 'ask-hint' }, 'One thing per line. Write it the way you would say it to them.'), pv.el],
      actions: [{ label: 'Cancel' }, {
        label: 'Send to customer', kind: 'primary', busy: 'Sending…',
        run: async (dlg) => {
          if (!ta.value.trim()) throw new Error('Write what they should send.');
          const r = await post({ action: 'request_info', booking_ref: ref, requested: ta.value.trim(), version, action_key: dlg.key });
          if (r.duplicate) await after('They were already asked exactly this.');
          else await afterTelling('Asked. The booking now waits for the customer.', r);
        },
      }],
      onStale: stale,
    });
  }

  function confirmDialog(warning) {
    const version = data.version;
    const b = data.booking;
    const checked = data.checklist.filter((c) => c.state === 'checked').length;
    const pv = previewBox(() => ({ kind: 'confirm', booking_ref: ref }));
    pv.now();
    dialog({
      title: 'Confirm this booking',
      subtitle: 'Confirming tells the customer and opens the shipment. It cannot be undone here.',
      body: [
        warning ? h('div', { class: 'callout callout-amber' }, icon('alert', { size: 16 }), h('p', {}, warning, ' You can still confirm if you are sure.')) : null,
        h('dl', { class: 'details details-compact' },
          row('Customer', h('bdi', {}, b.customer_name)),
          row('Chassis', h('span', { class: 'mono' }, b.vin)),
          row('Vehicle', [b.make, b.model].filter(Boolean).join(' ') || '—'),
          row('Route', data.header.route ?? '—'),
          row('Documents', `${checked} of ${data.checklist.length} checked`)),
        pv.el],
      actions: [{ label: 'Not yet' }, {
        label: 'Confirm booking', kind: 'primary', busy: 'Confirming…',
        run: async (dlg) => {
          const r = await post({ action: 'confirm', booking_ref: ref, version, action_key: dlg.key });
          const ship = r.shipment?.shipment_id ? ` Shipment ${r.shipment.shipment_id} is open.` : '';
          await afterTelling(`Confirmed.${ship}`, r);
        },
      }],
      onStale: stale,
    });
  }

  function rejectDialog() {
    const version = data.version;
    const ta = h('textarea', { class: 'input', rows: '3', dir: 'auto' });
    const pv = previewBox(() => ({ kind: 'reject', booking_ref: ref, note: ta.value.trim() }));
    ta.addEventListener('input', pv.update);
    pv.now();
    dialog({
      title: 'Reject this request',
      subtitle: 'The customer is told, with your reason.',
      body: [h('label', { class: 'label' }, 'Why? The customer reads this.'), ta, pv.el],
      actions: [{ label: 'Keep it' }, {
        label: 'Reject and tell the customer', kind: 'danger', busy: 'Rejecting…',
        run: async (dlg) => {
          if (!ta.value.trim()) throw new Error('Say why — the customer is told the reason.');
          const r = await post({ action: 'reject', booking_ref: ref, note: ta.value.trim(), version, action_key: dlg.key });
          await afterTelling('Rejected.', r);
        },
      }],
      onStale: stale,
    });
  }

  function simpleDialog({ title, words, label, kind = 'primary', body, done, note = null }) {
    const version = data.version;
    const ta = note ? h('textarea', { class: 'input', rows: '2', dir: 'auto' }) : null;
    dialog({
      title,
      body: [h('p', {}, words), note ? [h('label', { class: 'label' }, note), ta] : null],
      actions: [{ label: 'Go back' }, {
        label, kind, busy: 'Working…',
        run: async () => {
          await post({ ...target, version, ...body, ...(ta ? { note: ta.value.trim() } : {}) });
          await after(done);
        },
      }],
      onStale: stale,
    });
  }

  function priorityDialog() {
    const version = data.version;
    const current = data.header.priority ?? 'normal';
    const opts = [['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent — goes to the top of everyone’s inbox']];
    const group = h('fieldset', { class: 'radios' }, h('legend', { class: 'sr-only' }, 'Priority'),
      opts.map(([v, l]) => h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'prio', value: v, checked: v === current }), l)));
    dialog({
      title: 'Change the priority',
      body: group,
      actions: [{ label: 'Cancel' }, {
        label: 'Save', kind: 'primary',
        run: async () => {
          const priority = group.querySelector('input:checked')?.value ?? 'normal';
          await post({ action: 'priority', booking_ref: ref, priority, version });
          await after('Priority changed.');
        },
      }],
      onStale: stale,
    });
  }

  function assignDialog(action) {
    const version = data.version;
    const select = h('select', { class: 'input', 'aria-label': 'Team member' },
      (session.team ?? []).map((n) => h('option', { value: n, selected: n === data.header.assigned_to }, n)));
    dialog({
      title: 'Give this to someone else',
      subtitle: 'It moves to their “Mine” list.',
      body: [h('label', { class: 'label' }, 'Team member'), select],
      actions: [{ label: 'Cancel' }, {
        label: 'Give it to them', kind: 'primary',
        run: async () => {
          await post({ action, ...target, assignee: select.value, version });
          await after(`Given to ${select.value}.`);
        },
      }],
      onStale: stale,
    });
  }

  function referenceDialog() {
    const version = data.version;
    const input = h('input', { class: 'input mono', value: ref });
    const vessel = h('input', { class: 'input' });
    dialog({
      title: 'Record the booking reference',
      body: [h('label', { class: 'label' }, 'Booking reference'), input,
        h('label', { class: 'label' }, 'Vessel (if known)'), vessel],
      actions: [{ label: 'Cancel' }, {
        label: 'Record it', kind: 'primary',
        run: async () => {
          await post({ action: 'create_booking', booking_ref: ref, reference: input.value.trim(), vessel: vessel.value.trim(), version });
          await after('Recorded. Confirm the booking when you are ready.');
        },
      }],
      onStale: stale,
    });
  }

  function mrnDialog(requestRef) {
    const version = data.version;
    const input = h('input', { class: 'input mono', placeholder: 'e.g. 26LTVR610172694233', autocomplete: 'off', spellcheck: 'false' });
    const pv = requestRef ? previewBox(() => (input.value.trim() ? { kind: 'issue_mrn', request_ref: requestRef, mrn_number: input.value.trim() } : null),
      { empty: 'Type the MRN to see the message.' }) : null;
    if (pv) { input.addEventListener('input', pv.update); pv.now(); }
    dialog({
      title: 'Record the MRN',
      subtitle: 'Type it exactly as customs issued it. It is never generated here.',
      body: [h('label', { class: 'label' }, 'MRN number'), input, pv ? pv.el : h('p', { class: 'field-hint' }, 'The customer is told the number.')],
      actions: [{ label: 'Cancel' }, {
        label: 'Record and tell the customer', kind: 'primary', busy: 'Recording…',
        run: async () => {
          if (!input.value.trim()) throw new Error('Type the MRN.');
          const r = await post({ action: 'issue_mrn', ...target, ...(requestRef ? { request_ref: requestRef } : {}), mrn_number: input.value.trim().toUpperCase(), version });
          await afterTelling('MRN recorded.', r);
        },
      }],
      onStale: stale,
    });
  }

  function mrnInfoDialog() {
    const version = data.version;
    const ta = h('textarea', { class: 'input', rows: '3', dir: 'auto' });
    const pv = previewBox(() => (ta.value.trim() ? { kind: 'mrn_need_info', request_ref: ref, requested: ta.value.trim() } : null));
    ta.addEventListener('input', pv.update);
    pv.now();
    dialog({
      title: 'Ask for information for the MRN',
      body: [h('label', { class: 'label' }, 'What do you need from them?'), ta, pv.el],
      actions: [{ label: 'Cancel' }, {
        label: 'Send to customer', kind: 'primary', busy: 'Sending…',
        run: async () => {
          if (!ta.value.trim()) throw new Error('Write what you need.');
          const r = await post({ action: 'mrn_need_info', request_ref: ref, requested: ta.value.trim(), version });
          await afterTelling('Asked. The application waits for the customer.', r);
        },
      }],
      onStale: stale,
    });
  }

  function resolveDialog() {
    const version = data.version;
    const ta = h('textarea', { class: 'input', rows: '3', dir: 'auto' });
    const pv = previewBox(() => ({ kind: 'request_resolve', ticket_ref: ref, note: ta.value.trim() }));
    ta.addEventListener('input', pv.update);
    pv.now();
    dialog({
      title: 'Mark resolved',
      subtitle: 'Write what was done or agreed. The customer gets this message.',
      body: [h('label', { class: 'label' }, 'What was done?'), ta, pv.el],
      actions: [{ label: 'Cancel' }, {
        label: 'Resolve and tell the customer', kind: 'primary', busy: 'Sending…',
        run: async () => {
          if (!ta.value.trim()) throw new Error('Say what was done — the customer is told this.');
          const r = await post({ action: 'request_resolve', ticket_ref: ref, note: ta.value.trim(), version });
          await afterTelling('Resolved.', r);
        },
      }],
      onStale: stale,
    });
  }

  load();
  return {
    async refresh() {
      if (document.querySelector('dialog[open]')) return convo?.refresh();
      await load({ quiet: true });
      await convo?.refresh();
    },
    dispose() {
      watcher?.disconnect();
      document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    },
  };
}
