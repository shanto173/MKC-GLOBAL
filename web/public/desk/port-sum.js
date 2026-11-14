/**
 * Port Sum Up — every booking that has from-port, to-port and a chassis,
 * including drafts still collecting papers. Assigned to me is the same list
 * filtered to the signed-in person; they can still open any other order from
 * Port Sum Up, and every conversation is still in Chats.
 *
 * The list is built for a desk with thousands of orders on it: the funds
 * filter, the counts beside it, the search and the paging are all the
 * database's work (lib/admin/desk-port-sum.js), a hundred rows at a time, and
 * a row holds no control it does not need - a supervisor's list of names is
 * built when it is first used, not three hundred times as the page is drawn.
 */

import {
  h, clear, icon, api, post, session, toast, toastError, badge, channelIcon, avatar,
  emptyState, errorState, skeleton, debounce, add, fill, VIEW_SCOPES, scopesOf, PURPOSE,
} from './ui.js';
import { linkFor, ACTION_WORDS } from './inbox.js';
import { openViewer } from './viewer.js';

const FUNDS_FALLBACK = {
  not_received: 'Not Received',
  received: 'Received',
  in_process: 'In process',
};
const FUNDS_KEYS = Object.keys(FUNDS_FALLBACK);

/**
 * Where the money is, in the desk's colours: amber is waiting on the
 * customer, blue is ours to do, green is done. Each one also has a word and
 * an icon, so nobody has to tell amber from green to read it.
 */
const FUNDS_TONE = { not_received: 'amber', in_process: 'blue', received: 'green' };
const FUNDS_ICON = { not_received: 'clock', in_process: 'refresh', received: 'checkCircle' };
const FUNDS_FILTERS = [
  ['any', 'All'],
  ['not_received', 'Not Received'],
  ['in_process', 'In process'],
  ['received', 'Received'],
];

/**
 * An amount as a person writes one: 1,200 · 1,200.50. No amount is no words -
 * never "0", which is an amount somebody decided on.
 */
export function amountWords(amount) {
  if (amount == null || amount === '') return '';
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  return n.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** What an empty list says, which depends on why it is empty. */
export function emptyWords(q, filter, funds, words = FUNDS_FALLBACK) {
  if (q) return ['No order matches that.', 'Try the chassis, the customer’s name or a port.'];
  if (filter === 'mine') return ['Nothing is assigned to you yet.', 'Every order is on Port Sum Up, and anyone can give you one from there.'];
  if (funds && funds !== 'any') {
    return [`No order is "${words[funds] ?? funds}".`, 'The other three hold them all — All shows every order.'];
  }
  return [
    'No orders yet.',
    'An order appears here as soon as a customer has given both ports and a chassis number — before any documents.',
  ];
}

export function renderPortSum(ctx) {
  const [ref] = ctx.route.parts;
  if (ref) return renderDetail(ctx, ref);
  return renderList(ctx, {
    filter: 'all', title: 'Port Sum Up', purpose: PURPOSE.portSum, base: '#/port-sum',
  });
}

export function renderAssigned(ctx) {
  // One order is one screen, wherever it was opened from.
  if (ctx.route.parts[0]) {
    location.replace(`#/port-sum/${encodeURIComponent(ctx.route.parts[0])}`);
    return null;
  }
  return renderList(ctx, {
    filter: 'mine', title: 'Assigned to me', purpose: PURPOSE.assigned, base: '#/assigned',
  });
}
/**
 * The list, a page at a time, the way Shipments reads shipments: the database
 * filters, counts and pages, and "Show more" asks for the rows after the last
 * one shown by its place in the order, never by an offset that shifts when an
 * order above it changes.
 */
function renderList({ route, main, signal = null }, { filter, title, purpose, base }) {
  const funds = FUNDS_KEYS.includes(route.query.funds) ? route.query.funds : 'any';
  let q = '';
  const listEl = h('div', { class: 'list-wrap' }, skeleton(6, { kind: 'rows' }));
  const search = h('input', {
    class: 'input', type: 'search',
    placeholder: 'Customer, chassis, port or booking',
    'aria-label': `Find an order in ${title}`,
  });
  const count = h('span', { class: 'page-meta', 'aria-live': 'polite' });
  const filtersEl = h('nav', { class: 'seg', 'aria-label': 'Which orders' });
  let meta = { words: FUNDS_FALLBACK, team: [], can_assign_others: false, can_edit: false };

  /** Whether an amount on the page has been typed into and not yet saved. */
  const dirty = () => Boolean(listEl.querySelector('.port-amount[data-dirty="1"]'));

  /** The funds filter, each item with how many it holds. */
  const drawFilters = (counts = null) => fill(filtersEl, ...FUNDS_FILTERS.map(([k, label]) => {
    const n = counts?.[k];
    return h('a', {
      class: `seg-item${n === 0 ? ' is-zero' : ''}`,
      href: k === 'any' ? base : `${base}?funds=${k}`,
      'aria-current': k === funds ? 'page' : null,
      'aria-label': n == null ? null : `${label}, ${n}`,
    }, label, n == null ? null : h('span', { class: 'seg-count', 'aria-hidden': 'true' }, String(n)));
  }));
  drawFilters();

  add(main,
    h('div', { class: 'page-head' }, h('div', {},
      h('h1', {}, title),
      h('p', { class: 'page-sub' }, purpose)), count),
    h('div', { class: 'ship-bar' },
      filtersEl,
      h('label', { class: 'search-field' }, icon('search', { size: 16 }), search)),
    listEl);

  const PAGE = 100;
  const MAX_FIRST = 300;
  let rows = [];
  let next = null;
  let counts = null;
  let first = null;      // the first page's answer, as last drawn: a 304 hands back the same one
  let told = false;      // whether a half-typed amount has already been mentioned

  /** Loads the first page; false when it could not. */
  async function load({ quiet = false } = {}) {
    let data;
    try {
      data = await api({
        view: 'port_sum', filter, funds, q, limit: Math.min(MAX_FIRST, Math.max(PAGE, rows.length)),
      }, { signal });
    } catch (err) {
      if (err.aborted) return false;
      if (!quiet) fill(listEl, errorState(err, () => load()));
      return false;
    }
    if (data === first) return true;
    first = data;
    meta = {
      words: data.funds_words ?? FUNDS_FALLBACK,
      team: data.team ?? [],
      can_assign_others: Boolean(data.can_assign_others),
      can_edit: Boolean(data.can_edit),
    };
    counts = data.counts ?? counts;
    rows = data.rows ?? [];
    next = data.next ?? null;
    if (data.pending && !quiet) toast(data.pending, 'info');
    // Never pull a half-typed amount out from under somebody. The pulse
    // redraws this table whenever a colleague touches any order on it, and
    // the box being typed into would lose what is in it.
    if (dirty()) {
      if (!told) {
        toast('Another order on this list just changed. What you are typing is kept — it saves when you leave the box.', 'info');
        told = true;
      }
      return true;
    }
    draw();
    return true;
  }

  async function more(button) {
    if (!next) return;
    button.disabled = true;
    let data;
    try {
      data = await api({ view: 'port_sum', filter, funds, q, limit: PAGE, after: next }, { signal });
    } catch (err) {
      if (!err.aborted) toastError(err);
      button.disabled = false;
      return;
    }
    const seen = new Set(rows.map((r) => r.booking_ref));
    rows = [...rows, ...(data.rows ?? []).filter((r) => !seen.has(r.booking_ref))];
    next = data.next ?? null;
    draw();
  }

  function draw() {
    drawFilters(counts);
    const total = counts?.[funds];
    count.textContent = total != null && total > rows.length
      ? `${rows.length} of ${total} orders`
      : `${rows.length} order${rows.length === 1 ? '' : 's'}${q ? ' found' : ''}`;
    clear(listEl);
    if (!rows.length) {
      add(listEl, emptyState(...emptyWords(q, filter, funds, meta.words), null, { icon: q ? 'search' : 'mapPin' }));
      return;
    }
    add(listEl, h('div', { class: 'table-wrap' }, h('table', { class: 'table table-hover port-sum-table' },
      h('thead', {}, h('tr', {},
        ['Route', 'Employee', 'Customer and chassis', 'Documents', 'Funds', 'Assign', 'Chat']
          .map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, rows.map((r) => rowEl(r))))));
    if (next) {
      const button = h('button', { class: 'btn', type: 'button' }, 'Show more');
      button.addEventListener('click', () => more(button));
      add(listEl, h('div', { class: 'more' }, button));
    }
  }

  function rowEl(r) {
    const href = `#/port-sum/${encodeURIComponent(r.booking_ref)}`;
    return h('tr', {},
      // The link stretches over its row: the whole row opens the order.
      h('td', { 'data-label': 'Route' },
        h('a', { href, class: 'stretch port-route' }, h('strong', {}, r.route)),
        h('span', { class: 'cell-sub mono' }, r.booking_ref)),
      h('td', { 'data-label': 'Employee' }, ownerCell(r)),
      h('td', { 'data-label': 'Customer' },
        h('span', { class: 'row-name' }, r.channel ? channelIcon(r.channel, 14) : null,
          h('bdi', {}, r.customer_name || 'Name pending')),
        r.vin ? h('span', { class: 'cell-sub mono' }, r.vin) : null,
        r.vehicle ? h('span', { class: 'cell-sub' }, r.vehicle) : null),
      h('td', { 'data-label': 'Documents', class: 'port-docs-cell' }, docsCell(r)),
      h('td', { 'data-label': 'Funds', class: 'cell-actions' }, fundsCell(r)),
      h('td', { 'data-label': 'Assign', class: 'cell-actions' }, assignCell(r)),
      h('td', { 'data-label': 'Chat', class: 'cell-actions' }, chatButton(r)));
  }

  /**
   * Who has it, in the inbox's words: the person, or "Unassigned". The control
   * that changes it is the Assign column, so this column stays a word.
   */
  function ownerCell(r) {
    if (!r.employee) return h('span', { class: 'owner-none' }, icon('userX', { size: 14 }), 'Unassigned');
    const mine = r.employee.toLowerCase() === String(session.name).toLowerCase();
    return h('span', { class: 'row-owner', title: `${r.employee} has this` },
      avatar(r.employee, { size: 'sm' }), h('span', {}, mine ? 'You' : r.employee));
  }

  /**
   * The amount and where the money is: one column, as the brief asks for it.
   * The badge says the state in a word, an icon and a colour; the two controls
   * under it change it. The amount is saved when the box is left, not on every
   * key - a number is half-typed most of the time somebody is typing it, and
   * every save is a write the whole desk is told about.
   */
  function fundsCell(r) {
    const mark = (hold) => fill(hold, badge(r.port_funds_words, FUNDS_TONE[r.port_funds_status] ?? 'gray',
      { small: true, icon: FUNDS_ICON[r.port_funds_status] }));
    const held = mark(h('span', { class: 'port-funds-mark' }));
    if (!meta.can_edit) {
      return h('div', { class: 'port-funds' }, held,
        h('span', { class: 'cell-sub' }, r.port_amount == null ? 'No amount yet' : amountWords(r.port_amount)));
    }

    const amount = h('input', {
      class: 'input input-small port-amount', type: 'number', min: '0', step: '0.01', inputmode: 'decimal',
      value: r.port_amount ?? '', 'aria-label': `Amount for ${r.booking_ref}`,
    });
    const state = h('select', {
      class: 'input input-small', 'aria-label': `Where the funds are for ${r.booking_ref}`,
    }, Object.entries(meta.words).map(([k, label]) => h('option', { value: k, selected: k === r.port_funds_status }, label)));

    amount.addEventListener('input', () => { amount.dataset.dirty = '1'; });
    amount.addEventListener('change', save);
    state.addEventListener('change', save);

    async function save() {
      const sent = { amount: amount.value, state: state.value };
      amount.disabled = true;
      state.disabled = true;
      try {
        const res = await post({
          action: 'port_sum_update', booking_ref: r.booking_ref,
          port_amount: sent.amount === '' ? null : sent.amount,
          port_funds_status: sent.state,
        });
        r.port_amount = res.row?.port_amount ?? (sent.amount === '' ? null : Number(sent.amount));
        r.port_funds_status = res.row?.port_funds_status ?? sent.state;
        r.port_funds_words = res.row?.port_funds_words ?? meta.words[r.port_funds_status] ?? r.port_funds_words;
        delete amount.dataset.dirty;
        told = false;
        mark(held);
        toast('Saved.', 'ok');
      } catch (err) {
        delete amount.dataset.dirty;
        if (err.data?.stale) {
          toast(err.message, 'info');
          first = null;
          await load({ quiet: true });
          return;
        }
        toastError(err);
        amount.value = r.port_amount ?? '';
        state.value = r.port_funds_status;
      } finally {
        amount.disabled = false;
        state.disabled = false;
      }
    }

    return h('div', { class: 'port-funds' }, held, h('div', { class: 'port-funds-edit' }, amount, state));
  }

  /**
   * Giving the order to somebody. An agent may take one nobody has, or give
   * their own back; a supervisor may hand any of them to anyone.
   *
   * The supervisor's list of names is built when the control is first used,
   * not for all three hundred rows as the page is drawn: a team of ten would
   * otherwise put three thousand options into a page nobody is going to read.
   */
  function assignCell(r) {
    const mine = Boolean(r.employee) && r.employee.toLowerCase() === String(session.name).toLowerCase();

    if (!meta.can_assign_others) {
      if (!session.can('assign_self')) {
        return h('span', { class: 'muted', title: 'Your role cannot change who has this.' }, '—');
      }
      if (r.employee && !mine) {
        return h('span', { class: 'muted', title: `${r.employee} has this. Only a supervisor can give it to someone else.` }, '—');
      }
      const button = h('button', { class: 'btn btn-sm', type: 'button' },
        icon(mine ? 'userX' : 'userPlus', { size: 14 }), mine ? 'Unassign' : ACTION_WORDS.assign);
      button.addEventListener('click', () => {
        button.disabled = true;
        assign(r, mine ? '' : session.name, () => { button.disabled = false; });
      });
      return button;
    }

    const sel = h('select', { class: 'input input-small', 'aria-label': `Who has ${r.booking_ref}` },
      h('option', { value: r.employee ?? '' }, r.employee ?? 'Anyone on the team'));
    let filled = false;
    const fillPeople = () => {
      if (filled) return;
      filled = true;
      const people = meta.team.length ? meta.team : [{ name: session.name }];
      fill(sel,
        h('option', { value: '' }, 'Anyone on the team'),
        ...people.map((p) => h('option', {
          value: p.name,
          selected: Boolean(r.employee) && p.name.toLowerCase() === r.employee.toLowerCase(),
        }, p.name)));
      sel.value = r.employee ?? '';
    };
    for (const event of ['pointerdown', 'focus', 'keydown']) sel.addEventListener(event, fillPeople);
    sel.addEventListener('change', () => {
      sel.disabled = true;
      assign(r, sel.value.trim(), () => { sel.disabled = false; sel.value = r.employee ?? ''; });
    });
    return sel;
  }

  /**
   * One owner change, and then the list again, so every row's owner is the
   * one the database has - including the rows a colleague moved meanwhile.
   *
   * The desk's three actions, as the inbox and the case page use them:
   * taking one nobody has is "take", which also starts the review of an order
   * waiting for one; handing it to somebody is "assign"; and clearing it is
   * "unassign". No version goes with them - a list row's fingerprint is
   * worked out without the order's MRN application, so it would refuse every
   * order that has one. The server checks what matters anyway: it will not
   * let an agent take an order a colleague already has.
   */
  async function assign(r, to, undo) {
    const me = String(session.name).toLowerCase();
    try {
      if (!to) await post({ action: 'unassign', booking_ref: r.booking_ref });
      else if (to.toLowerCase() === me && !r.employee) await post({ action: 'take', booking_ref: r.booking_ref });
      else await post({ action: 'assign', booking_ref: r.booking_ref, assignee: to });
      toast(to
        ? `Assigned to ${to.toLowerCase() === me ? 'you' : to}.`
        : 'Unassigned. Anyone on the team can assign it to themselves.', 'ok');
    } catch (err) {
      if (err.data?.stale) toast(err.message, 'info');
      else toastError(err);
      undo();
      first = null;
      await load({ quiet: true });
      return;
    }
    first = null;
    await load({ quiet: true });
  }

  function chatButton(r) {
    if (!r.chat_id || !r.channel) {
      return h('span', { class: 'muted', title: 'No conversation is linked to this order yet' }, '—');
    }
    return h('a', {
      class: 'btn btn-sm',
      href: linkFor({ type: 'chat', channel: r.channel, chat_id: r.chat_id }),
      'aria-label': `Open the conversation with ${r.customer_name || 'this customer'}`,
    }, icon('chats', { size: 14 }), 'Chat');
  }

  /**
   * The papers already in, each opening in the document viewer. Six at most on
   * a row and the rest counted: a row is for seeing that they arrived, and the
   * order's own screen lists every one of them with View and Download.
   */
  function docsCell(r) {
    const docs = r.documents ?? [];
    if (!docs.length) return h('span', { class: 'muted' }, 'None yet');
    return h('div', { class: 'port-docs' }, docs.slice(0, 6).map((d) => {
      const b = h('button', {
        class: `btn btn-sm btn-ghost port-doc${d.sent_by_mky ? ' is-mky' : ''}`,
        type: 'button',
        title: d.sent_by_mky ? `${d.file_name || d.label} — sent by MKY` : d.label,
        disabled: !d.has_file,
      }, icon(d.sent_by_mky ? 'stamp' : 'file', { size: 12 }), d.label);
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openDoc(d.id); });
      return b;
    }), docs.length > 6
      ? h('a', { class: 'cell-sub', href: `#/port-sum/${encodeURIComponent(r.booking_ref)}` }, `+${docs.length - 6} more`)
      : null);
  }

  async function openDoc(id) {
    let paper;
    try {
      paper = await api({ view: 'document', id });
    } catch (err) {
      toastError(err);
      return;
    }
    openViewer({
      caseRef: paper.booking_ref ?? 'Document',
      docId: id,
      getData: () => paper,
      reload: async () => { paper = await api({ view: 'document', id }); return paper; },
      onStale: async (err) => { toast(err.message, 'info'); paper = await api({ view: 'document', id }).catch(() => paper); },
      refreshCounts: () => {},
    });
  }

  search.addEventListener('input', debounce(() => {
    q = search.value.trim();
    rows = [];
    next = null;
    first = null;
    load();
  }, 300));
  load();
  return { refresh: () => load({ quiet: true }), scopes: VIEW_SCOPES.port_sum };
}

function renderDetail({ main, signal = null }, ref) {
  let data = null;
  const root = h('div', { class: 'port-sum-detail' }, skeleton(6, { kind: 'cards' }));
  add(main, root);

  async function load({ quiet = false } = {}) {
    let fresh;
    try {
      fresh = await api({ view: 'port_sum_detail', ref }, { signal });
    } catch (err) {
      if (err.aborted) return false;
      if (!quiet) fill(root, errorState(err, err.status === 404 || err.status === 403 ? null : () => load()));
      return false;
    }
    // The amount and the funds status are not part of a booking's version
    // (lib/admin/desk-shared.js says why), so they are compared here: a
    // colleague recording a payment is a redraw, not a no-op.
    if (data && fresh.version === data.version
      && fresh.port_amount === data.port_amount
      && fresh.port_funds_status === data.port_funds_status) return true;
    data = fresh;
    draw();
    return true;
  }

  function draw() {
    const d = data;
    const funds = d.funds_words ?? FUNDS_FALLBACK;
    const amount = h('input', {
      class: 'input', type: 'number', min: '0', step: '0.01',
      value: d.port_amount ?? '', disabled: !d.can_edit, id: 'port-amount',
    });
    const fundsSel = h('select', { class: 'input', disabled: !d.can_edit, id: 'port-funds' },
      Object.entries(funds).map(([k, label]) => h('option', { value: k, selected: k === d.port_funds_status }, label)));
    const assignSel = h('select', {
      class: 'input',
      disabled: !d.can_assign_others && Boolean(d.employee) && d.employee?.toLowerCase() !== session.name.toLowerCase(),
      title: d.assign_reason || null,
    },
    h('option', { value: '' }, 'Anyone on the team'),
    ...(d.team ?? []).map((p) => h('option', {
      value: p.name,
      selected: d.employee && p.name.toLowerCase() === d.employee.toLowerCase(),
      disabled: !d.can_assign_others && p.name.toLowerCase() !== session.name.toLowerCase(),
    }, p.name)));

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: !d.can_edit }, 'Save amount & funds');
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        const res = await post({
          action: 'port_sum_update', booking_ref: ref, version: d.version,
          port_amount: amount.value === '' ? null : amount.value,
          port_funds_status: fundsSel.value,
        });
        // The order's fingerprint does not move for an amount or a funds
        // status, so the one this screen was drawn from is still good.
        d.port_amount = res.row?.port_amount ?? (amount.value === '' ? null : Number(amount.value));
        d.port_funds_status = res.row?.port_funds_status ?? fundsSel.value;
        d.port_funds_words = res.row?.port_funds_words ?? d.port_funds_words;
        toast('Saved.', 'ok');
      } catch (err) {
        if (err.data?.stale) { toast(err.message, 'info'); data = null; await load(); return; }
        toastError(err);
      } finally {
        if (saveBtn.isConnected) saveBtn.disabled = !d.can_edit;
      }
    });

    assignSel.addEventListener('change', async () => {
      const to = assignSel.value.trim();
      try {
        if (!to) await post({ action: 'unassign', booking_ref: ref, version: d.version });
        else if (to.toLowerCase() === session.name.toLowerCase() && !d.employee) {
          await post({ action: 'take', booking_ref: ref, version: d.version });
        } else {
          await post({ action: 'assign', booking_ref: ref, assignee: to, version: d.version });
        }
        toast(to ? `Assigned to ${to}.` : 'Unassigned.', 'ok');
        data = null;
        await load();
      } catch (err) {
        if (err.data?.stale) { toast(err.message, 'info'); data = null; await load(); return; }
        toastError(err);
        assignSel.value = d.employee || '';
      }
    });

    const facts = [
      h('bdi', {}, d.customer_name || 'Name pending'),
      d.vehicle || null,
      d.vin ? h('span', { class: 'mono' }, d.vin) : null,
      d.employee ? `Assigned to ${d.employee}` : 'Unassigned',
      badge(d.status_words, d.status_tone),
      d.shipment ? h('a', { href: linkFor({ type: 'shipment', id: d.shipment.shipment_id }) }, d.shipment.shipment_id) : null,
      h('a', { href: linkFor({ type: 'booking', ref }) }, 'Open case'),
    ].filter(Boolean);

    fill(root,
      h('header', { class: 'shipment-head' },
        h('a', { class: 'back', href: '#/port-sum' }, icon('back', { size: 16 }), 'Port Sum Up'),
        h('div', { class: 'case-title-row' },
          h('h1', { class: 'case-ref' }, d.route),
          badge(d.port_funds_words, FUNDS_TONE[d.port_funds_status] ?? 'gray', { icon: FUNDS_ICON[d.port_funds_status] })),
        h('p', { class: 'case-facts' }, facts.flatMap((f, i) => (i ? [h('span', { class: 'dot', 'aria-hidden': 'true' }, '·'), f] : [f]))),
        d.chat_id && d.channel
          ? h('p', {}, h('a', { class: 'btn', href: linkFor({ type: 'chat', channel: d.channel, chat_id: d.chat_id }) },
            icon('chats', { size: 14 }), 'Open chat'))
          : null),
      h('div', { class: 'case-grid case-grid-even' },
        h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', {}, icon('mapPin', { size: 16 }), 'Order')),
          h('dl', { class: 'facts' },
            fact('Booking', d.booking_ref),
            fact('From', d.origin_port),
            fact('To', d.destination_port),
            fact('Customer', d.customer_name || '—'),
            fact('Contact', d.customer_contact || '—'),
            fact('VIN', d.vin || '—'),
            fact('Vehicle', d.vehicle || '—'),
            d.mrn ? fact('MRN', d.mrn.mrn_number || d.mrn.request_ref) : null),
          h('div', { class: 'form-grid', style: { marginTop: '16px' } },
            field('Amount', amount),
            field('Funds', fundsSel),
            field('Assign to', assignSel)),
          h('div', { class: 'form-actions' }, saveBtn)),
        h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', {}, icon('file', { size: 16 }), 'Documents')),
          docsList(d.customer_documents, 'From the customer'),
          docsList(d.mky_documents, 'Sent by MKY'))));
  }

  function fact(label, value) {
    return h('div', { class: 'fact' }, h('dt', {}, label), h('dd', {}, typeof value === 'string' && /[A-HJ-NPR-Z0-9]{8,}/i.test(value) ? h('span', { class: 'mono' }, value) : value));
  }

  function field(label, input) {
    return h('label', { class: 'field' }, h('span', { class: 'label' }, label), input);
  }

  function docsList(docs, heading) {
    const list = docs ?? [];
    return h('div', { class: 'port-doc-block' },
      h('h3', { class: 'port-doc-heading' }, heading),
      list.length
        ? h('ul', { class: 'port-doc-list' }, list.map((doc) => {
          const open = h('button', { class: 'btn btn-sm', type: 'button', disabled: !doc.has_file }, icon('eye', { size: 14 }), 'View');
          open.addEventListener('click', () => openDoc(doc.id));
          const dl = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', disabled: !doc.has_file }, icon('download', { size: 14 }), 'Download');
          dl.addEventListener('click', () => downloadDoc(doc));
          return h('li', {},
            h('div', {},
              h('strong', {}, doc.label),
              h('span', { class: 'cell-sub' }, doc.status_words || doc.file_name || '')),
            h('div', { class: 'port-doc-actions' }, open, dl));
        }))
        : h('p', { class: 'muted' }, 'None yet.'));
  }

  async function openDoc(id) {
    let paper;
    try {
      paper = await api({ view: 'document', id });
    } catch (err) {
      toastError(err);
      return;
    }
    openViewer({
      caseRef: ref,
      docId: id,
      getData: () => paper,
      reload: async () => { paper = await api({ view: 'document', id }); return paper; },
      onStale: async (err) => { toast(err.message, 'info'); paper = await api({ view: 'document', id }).catch(() => paper); },
      refreshCounts: () => {},
    });
  }

  async function downloadDoc(doc) {
    try {
      const info = await api({ view: 'document_url', id: doc.id });
      const a = h('a', { href: info.url, download: doc.file_name || doc.label, target: '_blank', rel: 'noopener noreferrer' });
      document.body.append(a);
      a.click();
      a.remove();
    } catch (err) {
      toastError(err);
    }
  }

  load();
  return { refresh: () => load({ quiet: true }), scopes: scopesOf('port_sum_detail', { ref }) };
}
