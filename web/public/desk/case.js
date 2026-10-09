/**
 * The case page: a booking, a call-back or an MRN application - same layout.
 *
 * A sticky header across the top says what this is, its state, whose move it
 * is and who has it. Below, two columns: the work on the left, the
 * conversation with the customer on the right, full height, its composer
 * always in reach.
 *
 * The "Next step" card is the anchor of the left column: the one thing to do
 * and the one primary button that does it; everything else is secondary and
 * quieter. Once it scrolls out of view, that primary button appears in the
 * header instead - never two copies on screen at once. Below it: the papers,
 * the details (correctable in place, one line at a time), notes that never
 * leave the desk, and what has happened so far.
 *
 * Every action sends the version of the case this page was drawn from. If a
 * colleague changed the case meanwhile, the server refuses with who and when,
 * and the page redraws itself from the latest.
 */

import {
  h, icon, api, post, toast, toastError, badge, avatar, timeEl, ago, when, emptyState, errorState, skeleton, actionButton,
  dialog, draft, session, add, fill, lines, channelBadge, scopesOf,
} from './ui.js';
import { mountConversation } from './conversation.js';
import { openViewer } from './viewer.js';
import { previewBox } from './preview.js';
import { linkFor } from './inbox.js';

const TURN_TONE = { ops: 'blue', client: 'amber', none: 'green' };
const TURN_WORDS = { ops: 'Our turn', client: 'Customer’s turn', none: 'Nothing to do' };
const CHECK_ICON = {
  checked: ['check', 'green'], received: ['eye', 'blue'], mismatch: ['alert', 'red'], unreadable: ['alert', 'red'],
  replacement: ['refresh', 'amber'], missing: ['clock', 'amber'], reading: ['clock', 'gray'],
};
const DETAIL_LABELS = {
  customer_name: 'Customer name', customer_contact: 'Phone or email', company: 'Company', vin: 'Chassis (VIN)',
  make: 'Make', model: 'Model', origin_port: 'Loading port', destination_port: 'Destination',
};
const HISTORY_SHOWN = 6;

export function renderCase({ route, main, refreshCounts, signal = null, subscribe = null }) {
  const [type, ref] = route.parts;
  if (!['booking', 'request', 'mrn'].includes(type) || !ref) {
    add(main, emptyState('There is nothing to show here.', null, h('a', { class: 'btn', href: '#/inbox' }, 'Back to the inbox'), { icon: 'inbox' }));
    return null;
  }

  const target = type === 'booking' ? { booking_ref: ref } : type === 'request' ? { ticket_ref: ref } : { request_ref: ref };
  let data = null;
  let drawnAs = null;      // what the page was last drawn from, to redraw only on change
  let convo = null;
  let openedDoc = false;

  const root = h('div', { class: 'case', 'data-pane': 'work' }, skeleton(9, { kind: 'cards' }));
  add(main, root);

  const headEl = h('header', { class: 'case-head' });
  const mainCol = h('div', { class: 'case-sections' });
  const side = h('aside', { class: 'case-side', id: 'conversation', 'aria-label': 'Conversation with the customer' });
  const sticky = h('div', { class: 'sticky-bar' });

  // On a phone the two columns are two panes; this switches between them.
  const paneButtons = {};
  const showPane = (pane) => {
    root.dataset.pane = pane;
    for (const [k, b] of Object.entries(paneButtons)) b.setAttribute('aria-pressed', String(k === pane));
    window.scrollTo(0, 0);
  };
  const switcher = h('div', { class: 'case-switch' }, h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' },
    ['work', 'chat'].map((p) => {
      paneButtons[p] = h('button', { class: 'seg-item', type: 'button', 'aria-pressed': String(p === 'work'), onclick: () => showPane(p) },
        icon(p === 'work' ? 'file' : 'chats', { size: 15 }), p === 'work' ? 'Case' : 'Chat');
      return paneButtons[p];
    })));

  // The conversation column is sticky under the header, so it needs the
  // header's real height - which changes when the facts wrap.
  const sizer = 'ResizeObserver' in window ? new ResizeObserver(() => {
    root.style.setProperty('--case-head-h', `${headEl.offsetHeight}px`);
  }) : null;

  /**
   * @param {{quiet?: boolean, own?: boolean}} opts
   *   quiet - a background refresh: no skeleton, no error page
   *   own   - after this operator's own action: redraw at once, and do not
   *           announce as news a change they just made themselves
   */
  async function load({ quiet = false, own = false } = {}) {
    let fresh;
    try {
      fresh = await api({ view: 'case', type, ref }, { signal });
    } catch (err) {
      if (err.aborted) return null;
      if (!quiet) fill(root, errorState(err, err.status === 404 || err.status === 403 ? null : () => load()));
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
      fill(root, headEl, switcher, h('div', { class: 'case-grid' }, h('div', { class: 'case-main' }, mainCol), side), sticky);
      sizer?.observe(headEl);
      // An MRN application's own channel: its chat's, which the server reads
      // from the application, not from a booking it may not have.
      const where = type === 'mrn' && data.mrn?.chat_id ? { channel: data.mrn.channel, chatId: data.mrn.chat_id }
        : { channel: data.conversation.channel, chatId: data.conversation.chat_id };
      convo = mountConversation(side, {
        channel: where.channel,
        chatId: where.chatId,
        target,
        draftKey: `chat:${type}:${ref}`,
        // A file sent from a booking's conversation may be filed on it too;
        // either way the case is read again, so its version and papers are current.
        fileOn: () => (type === 'booking' && !['cancelled', 'rejected', 'expired'].includes(data?.booking?.status)
          ? [{ booking_ref: ref, label: ref }] : []),
        onSent: () => load({ quiet: true, own: true }),
        // A paper on this case opens in this case's viewer; any other on its own.
        openPaper: (id) => (data?.documents?.some((d) => d.id === id) ? openDoc(id) : openPaperAlone(id)),
        signal,
      });
      // The conversation beside the case moves with every message in it, far
      // more often than the case: it is refreshed on its own chat's version
      // (public/desk/live.js), and the case on the case's.
      // Asked for again every two minutes even when nothing moved: whether
      // WhatsApp's 24-hour window is still open changes with the clock alone
      // (the server re-checks it on every send).
      if (where.chatId) subscribe?.(scopesOf('chat', { channel: where.channel, chat_id: where.chatId }), () => convo?.refresh(), { maxAgeMs: 120_000 });
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
      type === 'booking' && data.asked ? askedCard() : null,
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
    const p = data.next_step.primary;

    fill(headEl,
      h('div', { class: 'case-title-row' },
        h('a', { class: 'back', href: '#/inbox' }, icon('back', { size: 16 }), 'Inbox'),
        h('h1', { class: 'case-ref' }, hd.ref),
        badge(hd.status_words, hd.tone),
        badge(TURN_WORDS[hd.turn] ?? TURN_WORDS.none, TURN_TONE[hd.turn] ?? 'gray', { outline: true, icon: 'user' }),
        hd.priority === 'urgent' ? badge('Urgent', 'red') : hd.priority === 'high' ? badge('High priority', 'amber', { icon: 'alert' }) : null),
      h('p', { class: 'case-facts' }, facts.flatMap((f, i) => (i ? [h('span', { class: 'dot', 'aria-hidden': 'true' }, '·'), f] : [f]))),
      h('div', { class: 'case-head-side' },
        ownership(),
        p ? actionButton(p, () => run(p), { cls: 'case-head-primary' }) : null));
  }

  /** Who has this case, and the one control that changes that. */
  function ownership() {
    const t = data.take;
    if (!t) {
      return data.header.assigned_to
        ? h('span', { class: 'case-owner' }, avatar(data.header.assigned_to, { size: 'sm' }), `${data.header.assigned_to} has this`)
        : null;
    }
    // A request is put back with request_assign; a booking has its own unassign.
    const body = t.action === 'unassign' && type === 'request' ? { action: 'request_assign', clear: true } : { action: t.action };
    const who = t.state === 'mine' ? session.name : t.state === 'other' ? data.header.assigned_to : null;
    return h('div', { class: `case-owner owner-${t.state}` },
      who ? avatar(who, { size: 'sm' }) : icon('userX', { size: 16 }), h('span', {}, t.words),
      actionButton({ ...t, kind: t.state === 'mine' ? 'ghost' : 'secondary' }, (e, b) => quick(b, body,
        t.action === 'unassign' ? 'Put back for anyone to take.' : 'It is yours now.'), { cls: 'btn-sm', iconName: t.state === 'nobody' ? 'userPlus' : null }));
  }

  function nextStepCard() {
    const n = data.next_step;
    const tone = TURN_TONE[n.owner] ?? 'gray';
    const shown = n.secondary.filter((s) => !s.more);
    const more = n.secondary.filter((s) => s.more);
    return h('section', { class: `card next next-${tone}`, 'aria-labelledby': 'next-title' },
      h('div', { class: 'next-eyebrow' }, h('span', { class: 'eyebrow' }, 'Next step')),
      h('h2', { class: 'next-title', id: 'next-title' }, n.title),
      n.detail ? h('p', { class: 'next-detail' }, n.detail) : null,
      h('div', { class: 'next-actions' },
        n.primary ? actionButton(n.primary, () => run(n.primary), { cls: 'btn-lg', showReason: true }) : null,
        shown.map((s) => actionButton({ ...s, kind: s.kind === 'danger' ? 'danger-ghost' : 'secondary' }, () => run(s))),
        more.length ? moreMenu(more) : null));
  }

  function moreMenu(items) {
    const menu = h('details', { class: 'menu' },
      h('summary', { class: 'btn btn-ghost btn-icon', 'aria-label': 'More actions', title: 'More actions' }, icon('more', { size: 18 })),
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

  /** A card with the system's header: a title (with an optional icon), a quiet note, tools on the right. */
  const card = (id, title, { sub = null, tools = null, cls = '', ic = null } = {}, ...body) => h('section', { class: `card ${cls}`.trim(), 'aria-labelledby': id },
    h('div', { class: 'card-head' },
      h('h2', { id }, ic ? icon(ic, { size: 16 }) : null, title),
      sub || tools ? h('div', { class: 'card-tools' }, sub ? h('span', { class: 'card-sub' }, sub) : null, tools) : null),
    ...body);

  function documentsCard() {
    const list = data.checklist;
    const checked = list.filter((c) => c.state === 'checked').length;
    const meter = list.length ? h('span', { class: 'progress', title: `${checked} of ${list.length} checked` },
      h('span', { class: 'progress-bar', 'aria-hidden': 'true' }, list.map((c) => h('span', { class: `is-${(CHECK_ICON[c.state] ?? ['', 'gray'])[1]}` }))),
      `${checked} of ${list.length} checked`) : null;
    const fileOf = (id) => data.documents.find((d) => d.id === id)?.file_name ?? null;
    const item = ({ state, label, words, document_id: docId, tone: wordsTone }) => {
      const [ic, tone] = CHECK_ICON[state] ?? ['file', 'gray'];
      const needsEyes = ['received', 'mismatch', 'unreadable'].includes(state);
      const file = docId ? fileOf(docId) : null;
      return h('li', { class: `check-item check-${state}${docId ? ' is-openable' : ''}` },
        h('span', { class: `check-icon tone-${tone}`, 'aria-hidden': 'true' }, icon(ic, { size: 16 })),
        h('span', { class: 'check-main' },
          h('span', { class: 'check-label' }, label),
          h('span', { class: `check-words tone-text-${wordsTone ?? tone}` }, words),
          file ? h('bdi', { class: 'check-file', dir: 'ltr', title: file }, file) : null),
        docId
          ? h('button', { class: `btn btn-sm ${needsEyes ? 'btn-secondary' : 'btn-ghost'}`, type: 'button', onclick: () => openDoc(docId), 'aria-label': `${needsEyes ? 'Check' : 'View'} the ${label}` },
            icon(needsEyes ? 'eye' : 'file', { size: 14 }), needsEyes ? 'Check' : 'View')
          : h('span', { 'aria-hidden': 'true' }));
    };
    return card('docs-title', 'Documents', { tools: meter, ic: 'file' },
      data.required_note ? h('p', { class: 'muted' }, data.required_note) : null,
      list.length ? h('ul', { class: 'checklist' }, list.map((c) => item(c))) : null,
      data.other_documents.length ? h('div', { class: 'other-docs' },
        h('h3', {}, 'Other files'),
        h('ul', { class: 'checklist' }, data.other_documents.map((d) => item({ state: 'other', label: d.label, words: d.status_words, document_id: d.id, tone: 'gray' })))) : null,
      // Papers MKY sent the customer from the conversation and filed here:
      // ours, apart from theirs, never to check.
      data.mky_documents?.length ? h('div', { class: 'other-docs' },
        h('h3', {}, 'Sent by MKY'),
        h('ul', { class: 'checklist' }, data.mky_documents.map((d) => h('li', { class: 'check-item check-mky is-openable' },
          h('span', { class: 'check-icon tone-blue', 'aria-hidden': 'true' }, icon('send', { size: 15 })),
          h('span', { class: 'check-main' },
            h('bdi', { class: 'check-label', dir: 'ltr', title: d.file_name ?? '' }, d.file_name ?? d.label),
            h('span', { class: 'check-words' }, `${d.status_words} · ${ago(d.uploaded_at)}`)),
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => openDoc(d.id), 'aria-label': `View ${d.file_name ?? 'the file'}` },
            icon('file', { size: 14 }), 'View'))))) : null);
  }

  /**
   * What we asked the customer for, and what they answered - side by side, so
   * nobody has to scroll the conversation to find the reply. The papers they
   * sent open in the viewer.
   */
  function askedCard() {
    const a = data.asked;
    const answers = a.answers ?? [];
    return card('asked-booking-title', 'What we asked the customer', {
      ic: 'reply',
      sub: a.at ? [a.by, timeEl(a.at, when(a.at))].filter(Boolean).flatMap((x, i) => (i ? [' · ', x] : [x])) : null,
    },
    a.requested ? h('div', { class: 'said-block' }, lines(a.requested)) : null,
    answers.length
      ? h('div', {}, h('h3', {}, 'Their answer'),
        h('ul', { class: 'said' }, answers.map((x) => h('li', {},
          h('span', { class: 'muted' }, when(x.at)),
          x.text ? h('bdi', { dir: 'auto' }, x.text) : null,
          (x.documents ?? []).map((d) => (d.id
            ? h('button', { class: 'link-btn', type: 'button', onclick: () => openDoc(d.id) }, d.label)
            : h('span', {}, d.label)))))))
      : h('p', { class: 'muted', style: { marginTop: '12px' } }, 'No answer yet.'));
  }

  function mrnCard() {
    const m = data.mrn;
    return card('mrn-title', 'MRN — MKY is getting it', { ic: 'stamp', tools: badge(m.status_words, m.mrn_number ? 'green' : 'blue') },
      h('dl', { class: 'kv' },
        row('MRN number', m.mrn_number ? h('span', { class: 'mono' }, m.mrn_number) : h('span', { class: 'kv-empty' }, 'Not issued yet')),
        m.request_ref ? row('Application', h('a', { href: linkFor({ type: 'mrn', ref: m.request_ref }) }, m.request_ref)) : null),
      m.supplied.length ? h('div', {}, h('h3', {}, 'What the customer told us'),
        h('ul', { class: 'said' }, m.supplied.map((s) => h('li', {}, h('span', { class: 'muted' }, when(s.at)), h('bdi', { dir: 'auto' }, s.text))))) : null);
  }

  function requestCard() {
    const r = data.request;
    // Opened at the tap of "Talk to an agent", before they said what about:
    // the summary is the bot's placeholder, not their words.
    const said = r.undescribed
      ? h('div', { class: 'callout callout-gray', role: 'note' }, icon('note', { size: 16 }),
        h('p', {}, h('strong', {}, 'Not described yet. '), 'They asked to speak to a person and have not said what about. Ask them in the conversation, or when you call.'))
      : h('div', { class: 'said-block' }, lines(r.summary || 'They did not say.'));
    return card('asked-title', 'What the customer asked', { ic: 'phone' },
      said,
      h('dl', { class: 'kv', style: { marginTop: '8px' } },
        row('Call them on', r.contact ? h('a', { href: `tel:${r.contact.replace(/[^\d+]/g, '')}`, class: 'strong' }, h('bdi', {}, r.contact)) : 'No number given — reply in the chat'),
        row('Department', r.department),
        r.booking_ref ? row('About booking', h('a', { href: linkFor({ type: 'booking', ref: r.booking_ref }) }, r.booking_ref)) : null,
        r.resolution_note ? row('They were told', h('bdi', { dir: 'auto' }, r.resolution_note)) : null),
      data.bookings?.length ? h('div', {}, h('h3', {}, 'Their bookings'),
        h('ul', { class: 'mini-list' }, data.bookings.map((b) => h('li', {},
          h('a', { href: linkFor({ type: 'booking', ref: b.booking_ref }), class: 'mono' }, b.booking_ref),
          badge(b.status_words, b.tone, { small: true }),
          h('span', { class: 'muted small' }, [b.make, b.vin].filter(Boolean).join(' · ')))))) : null);
  }

  function applicationCard() {
    const m = data.mrn;
    const channel = m.channel ?? data.conversation?.channel ?? null;
    const name = data.customer?.name ?? data.booking?.customer_name ?? null;
    return card('app-title', 'The application', { ic: 'stamp' },
      h('dl', { class: 'kv' },
        row('Customer', name || channel
          ? h('span', { class: 'kv-customer' }, name ? h('bdi', {}, name) : null, channel ? channelBadge(channel) : null)
          : h('span', { class: 'kv-empty' }, 'Not known')),
        row('MRN number', m.mrn_number ? h('span', { class: 'mono' }, m.mrn_number) : h('span', { class: 'kv-empty' }, 'Not issued yet')),
        data.booking ? row('Booking', h('span', {}, h('a', { href: linkFor({ type: 'booking', ref: data.booking.booking_ref }) }, data.booking.booking_ref), ` · ${data.booking.status_words}`)) : row('Booking', h('span', { class: 'kv-empty' }, 'None linked')),
        m.missing?.length ? row('Still needed', m.missing.join(', ')) : null,
        m.notes ? row('Desk notes', h('bdi', { dir: 'auto' }, m.notes)) : null),
      m.supplied.length ? h('div', {}, h('h3', {}, 'What the customer told us'),
        h('ul', { class: 'said' }, m.supplied.map((s) => h('li', {}, h('span', { class: 'muted' }, when(s.at)), h('bdi', { dir: 'auto' }, s.text))))) : null);
  }

  // -- details, correctable in place, one line at a time ---------------------------
  function detailsCard() {
    const b = data.booking;
    const dl = h('dl', { class: 'kv' });
    for (const [field, label] of Object.entries(DETAIL_LABELS)) add(dl, detailRow(field, label, b[field]));
    return card('details-title', 'Details', { ic: 'note', sub: b.editable ? 'Select ✎ on a line to correct it. Every change is recorded.' : (b.edit_reason ?? '') },
      dl,
      h('p', { class: 'kv-foot' }, `MRN: ${b.mrn_choice === 'mky_issue' ? 'MKY is getting it' : b.mrn_choice === 'existing' ? 'the customer has it' : 'not said'}${b.mrn_number ? ` · ${b.mrn_number}` : ''}`));
  }

  function detailRow(field, label, value) {
    const dd = h('dd', { class: 'kv-val' });
    const wrap = h('div', { class: 'kv-row' }, h('dt', { class: 'kv-key' }, label), dd);
    const show = () => {
      wrap.classList.remove('is-editing');
      fill(dd,
        value ? h('bdi', { class: field === 'vin' ? 'mono' : '' }, value) : h('span', { class: 'kv-text kv-empty' }, 'Not given'),
        data.booking.editable ? h('button', { class: 'icon-btn kv-edit', type: 'button', onclick: edit, 'aria-label': `Correct ${label.toLowerCase()}`, title: `Correct ${label.toLowerCase()}` }, icon('pencil', { size: 15 })) : null);
    };
    const edit = () => {
      const version = data.version;
      wrap.classList.add('is-editing');
      const input = h('input', { class: `input${field === 'vin' ? ' mono' : ''}`, value: value ?? '', 'aria-label': label, dir: 'auto' });
      const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
      const save = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Save');
      const cancel = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { show(); dd.querySelector('.kv-edit')?.focus(); } }, 'Cancel');
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
      fill(dd, h('span', { class: 'kv-form' }, input, save, cancel, err));
      input.focus();
      input.select();
    };
    show();
    return wrap;
  }

  function row(label, value) {
    return h('div', { class: 'kv-row' }, h('dt', { class: 'kv-key' }, label), h('dd', { class: 'kv-val' }, value ?? '—'));
  }

  // -- notes: unmistakably internal ---------------------------------------------
  function notesCard() {
    const key = `note:${type}:${ref}`;
    const ta = h('textarea', { class: 'input', rows: '2', dir: 'auto', 'aria-label': 'Internal note', placeholder: 'For the team only…' });
    ta.value = draft.get(key);
    ta.addEventListener('input', () => draft.set(key, ta.value));
    const save = h('button', { class: 'btn', type: 'button', disabled: !session.can('notes') }, 'Save note');
    save.addEventListener('click', async () => {
      if (ta.value.trim().length < 2) return toast('Write the note first.', 'info');
      save.disabled = true;
      try {
        await post({ action: 'internal_note', ...target, body: ta.value.trim() });
        draft.set(key, '');
        await after('Note saved.');
      } catch (e) {
        toastError(e);
        save.disabled = false;
      }
    });
    const notes = data.notes ?? [];
    return card('notes-title', 'Internal notes', { cls: 'notes', ic: 'lock', tools: h('span', { class: 'notes-badge' }, 'Never sent to the customer') },
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
      fill(list, ...(showAll ? items : items.slice(0, HISTORY_SHOWN)).map((a) => h('li', {},
        timeEl(a.at, when(a.at)), h('span', {}, h('strong', {}, a.who), ` ${a.what}`))));
      toggle.textContent = showAll ? 'Show less' : `Show all ${items.length}`;
      toggle.hidden = items.length <= HISTORY_SHOWN;
    };
    toggle.addEventListener('click', () => { showAll = !showAll; paint(); });
    paint();
    return card('history-title', 'History', { ic: 'clock' },
      items.length ? [list, toggle] : h('p', { class: 'muted' }, 'Nothing recorded yet.'));
  }

  /**
   * The primary action stays in reach once the Next step card has scrolled
   * out of view: in the case header on a desktop, in a bar at the bottom of
   * the screen on a phone. Never both copies at once.
   */
  let watcher = null;
  function drawSticky() {
    watcher?.disconnect();
    const nextCard = mainCol.querySelector('.next');
    const hidden = (v) => { sticky.classList.toggle('is-visible', v); root.classList.toggle('next-hidden', v); };
    if (nextCard && 'IntersectionObserver' in window) {
      const top = (document.querySelector('.top')?.offsetHeight ?? 56) + (getComputedStyle(headEl).position === 'sticky' ? headEl.offsetHeight : 0);
      watcher = new IntersectionObserver(([e]) => hidden(!e.isIntersecting), { rootMargin: `-${top}px 0px 0px 0px` });
      watcher.observe(nextCard);
    } else {
      hidden(true);
    }
    const p = data.next_step.primary;
    fill(sticky,
      p ? actionButton(p, () => run(p), { cls: 'btn-block' }) : h('span', { class: 'sticky-words' }, data.next_step.title),
      data.conversation.chat_id ? h('button', { class: 'btn', type: 'button', onclick: () => showPane('chat') }, icon('chats', { size: 16 }), 'Chat') : null);
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
      toastError(e);
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

  /** A paper from the conversation that is not on this case (another booking's, or none): read on its own. */
  async function openPaperAlone(id) {
    let paper;
    try {
      paper = await api({ view: 'document', id });
    } catch (err) {
      toastError(err);
      return;
    }
    openViewer({
      caseRef: paper.booking_ref ?? 'No booking',
      docId: id,
      getData: () => paper,
      reload: async () => { paper = await api({ view: 'document', id }); return paper; },
      onStale: async (err) => { toast(err.message, 'info', { timeout: 9000 }); paper = await api({ view: 'document', id }).catch(() => paper); },
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
        h('dl', { class: 'kv kv-compact', style: { marginTop: warning ? '12px' : '0' } },
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
      // A dialog open on this case is about the case as it was drawn; its
      // action carries that version and is refused if it moved. Not now,
      // then: the next tick, once the dialog has closed.
      if (document.querySelector('dialog[open]')) return false;
      return (await load({ quiet: true })) !== null;
    },
    // This case's own version, not every booking's (public/desk/live.js).
    scopes: scopesOf('case', { type, ref }),
    dispose() {
      watcher?.disconnect();
      sizer?.disconnect();
      convo?.dispose();
      document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    },
  };
}
