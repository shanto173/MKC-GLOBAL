/**
 * Port Sum Up — every booking that has from-port, to-port and VIN, including
 * drafts still collecting papers. Assigned to me is the same list filtered to
 * the signed-in person; they can still open any other row from Port Sum Up.
 */

import {
  h, clear, icon, api, post, session, toast, toastError, badge, channelIcon,
  emptyState, errorState, skeleton, debounce, add, fill, VIEW_SCOPES, scopesOf, PURPOSE,
} from './ui.js';
import { linkFor } from './inbox.js';
import { openViewer } from './viewer.js';

const FUNDS_FALLBACK = {
  not_received: 'Not Received',
  received: 'Received',
  in_process: 'In process',
};

export function renderPortSum(ctx) {
  const [ref] = ctx.route.parts;
  if (ref) return renderDetail(ctx, ref);
  return renderList(ctx, { filter: 'all', title: 'Port Sum Up', purpose: PURPOSE.portSum, back: null });
}

export function renderAssigned(ctx) {
  if (ctx.route.parts[0]) {
    location.replace(`#/port-sum/${encodeURIComponent(ctx.route.parts[0])}`);
    return null;
  }
  return renderList(ctx, {
    filter: 'mine',
    title: 'Assigned to me',
    purpose: PURPOSE.assigned,
    back: null,
  });
}

function renderList({ main, signal = null }, { filter, title, purpose }) {
  let q = '';
  const listEl = h('div', { class: 'list-wrap' }, skeleton(6, { kind: 'rows' }));
  const search = h('input', {
    class: 'input', type: 'search',
    placeholder: 'Customer, chassis, port or booking',
    'aria-label': 'Find a Port Sum Up row',
  });
  const count = h('span', { class: 'page-meta', 'aria-live': 'polite' });
  let meta = { funds: FUNDS_FALLBACK, team: [], can_assign_others: false, can_edit: false };

  add(main,
    h('div', { class: 'page-head' }, h('div', {},
      h('h1', {}, title),
      h('p', { class: 'page-sub' }, purpose)), count),
    h('div', { class: 'ship-bar' },
      h('label', { class: 'search-field' }, icon('search', { size: 16 }), search)),
    listEl);

  const PAGE = 100;
  let rows = [];
  let next = null;
  let first = null;

  async function load({ quiet = false } = {}) {
    let data;
    try {
      data = await api({ view: 'port_sum', filter, q, limit: Math.min(300, Math.max(PAGE, rows.length)) }, { signal });
    } catch (err) {
      if (err.aborted) return false;
      if (!quiet) fill(listEl, errorState(err, () => load()));
      return false;
    }
    if (data === first) return true;
    first = data;
    meta = {
      funds: data.funds ?? FUNDS_FALLBACK,
      team: data.team ?? [],
      can_assign_others: Boolean(data.can_assign_others),
      can_edit: Boolean(data.can_edit),
    };
    rows = data.rows ?? [];
    next = data.next ?? null;
    if (data.pending && !quiet) toast(data.pending, 'info');
    draw();
    return true;
  }

  async function more(button) {
    if (!next) return;
    button.disabled = true;
    let data;
    try {
      data = await api({ view: 'port_sum', filter, q, limit: PAGE, after: next }, { signal });
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
    count.textContent = `${rows.length} order${rows.length === 1 ? '' : 's'}${q ? ' found' : ''}`;
    clear(listEl);
    if (!rows.length) {
      add(listEl, emptyState(
        q ? 'No order matches that.' : filter === 'mine' ? 'Nothing assigned to you yet.' : 'No Port Sum Up rows yet.',
        q ? 'Try the chassis, customer name or a port.' : 'A row appears when a customer has set from-port, to-port and VIN.',
        null,
        { icon: q ? 'search' : 'mapPin' },
      ));
      return;
    }
    add(listEl, h('div', { class: 'table-wrap' }, h('table', { class: 'table table-hover port-sum-table' },
      h('thead', {}, h('tr', {},
        ['Route', 'Employee', 'Customer / VIN', 'Documents', 'Amount', 'Funds', 'Assign', ''].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, rows.map((r) => rowEl(r)))));
    if (next) {
      const button = h('button', { class: 'btn', type: 'button' }, 'Show more');
      button.addEventListener('click', () => more(button));
      add(listEl, h('div', { class: 'more' }, button));
    }
  }

  function rowEl(r) {
    const href = `#/port-sum/${encodeURIComponent(r.booking_ref)}`;
    const amount = h('input', {
      class: 'input input-small port-amount', type: 'number', min: '0', step: '0.01',
      value: r.port_amount ?? '', disabled: !meta.can_edit, 'aria-label': `Amount for ${r.route}`,
    });
    const funds = h('select', {
      class: 'input input-small', disabled: !meta.can_edit, 'aria-label': `Funds status for ${r.route}`,
    }, Object.entries(meta.funds).map(([k, label]) => h('option', { value: k, selected: k === r.port_funds_status }, label)));

    const assign = assignControl(r);
    const chat = chatButton(r);
    const docs = docsCell(r);

    const tr = h('tr', {},
      h('td', { 'data-label': 'Route' },
        h('a', { href, class: 'stretch port-route' }, h('strong', {}, r.route)),
        h('span', { class: 'cell-sub mono' }, r.booking_ref)),
      h('td', { 'data-label': 'Employee' }, r.employee || h('span', { class: 'muted' }, 'Unassigned')),
      h('td', { 'data-label': 'Customer' },
        h('span', { class: 'row-name' }, r.channel ? channelIcon(r.channel, 14) : null, h('bdi', {}, r.customer_name || 'Name pending')),
        r.vin ? h('span', { class: 'cell-sub mono' }, r.vin) : null,
        r.vehicle ? h('span', { class: 'cell-sub' }, r.vehicle) : null),
      h('td', { 'data-label': 'Documents', class: 'port-docs-cell cell-actions' }, docs),
      h('td', { 'data-label': 'Amount', class: 'cell-actions' }, amount),
      h('td', { 'data-label': 'Funds', class: 'cell-actions' }, funds),
      h('td', { 'data-label': 'Assign', class: 'cell-actions' }, assign),
      h('td', { 'data-label': 'Chat', class: 'cell-actions' }, chat));

    const saveFunds = debounce(async () => {
      if (!meta.can_edit) return;
      // No version from the list: the fingerprint includes MRN/docs the row
      // does not always carry, and a false "stale" would block every save.
      const body = {
        action: 'port_sum_update', booking_ref: r.booking_ref,
        port_amount: amount.value === '' ? null : amount.value,
        port_funds_status: funds.value,
      };
      try {
        const res = await post(body);
        r.port_amount = res.row?.port_amount ?? (amount.value === '' ? null : Number(amount.value));
        r.port_funds_status = res.row?.port_funds_status ?? funds.value;
        r.version = res.version ?? r.version;
        toast('Saved.', 'ok');
      } catch (err) {
        if (err.data?.stale) { toast(err.message, 'info'); first = null; await load({ quiet: true }); return; }
        toastError(err);
      }
    }, 500);
    amount.addEventListener('change', saveFunds);
    funds.addEventListener('change', saveFunds);
    return tr;
  }

  function assignControl(r) {
    if (!meta.can_assign_others && r.employee && r.employee.toLowerCase() !== session.name.toLowerCase()) {
      return h('span', { class: 'muted', title: 'Only a supervisor can reassign this.' }, r.employee);
    }
    if (!meta.can_assign_others && !session.can('assign_self')) {
      return h('span', { class: 'muted' }, r.employee || '—');
    }
    const people = meta.team.length ? meta.team : [{ name: session.name }];
    const sel = h('select', {
      class: 'input input-small', 'aria-label': `Assign ${r.route}`,
      disabled: !meta.can_assign_others && Boolean(r.employee) && r.employee.toLowerCase() !== session.name.toLowerCase(),
    },
    h('option', { value: '' }, 'Unassigned'),
    ...people.map((p) => h('option', {
      value: p.name,
      selected: r.employee && p.name.toLowerCase() === r.employee.toLowerCase(),
    }, p.name)));

    // Agents without assign_others may only take unassigned rows (or keep themselves).
    if (!meta.can_assign_others) {
      for (const opt of sel.options) {
        if (opt.value && opt.value.toLowerCase() !== session.name.toLowerCase()) opt.disabled = true;
      }
    }

    sel.addEventListener('change', async () => {
      const to = sel.value.trim();
      try {
        if (!to) {
          await post({ action: 'unassign', booking_ref: r.booking_ref });
          r.employee = null;
        } else if (to.toLowerCase() === session.name.toLowerCase() && !r.employee) {
          await post({ action: 'take', booking_ref: r.booking_ref });
          r.employee = session.name;
        } else {
          await post({ action: 'assign', booking_ref: r.booking_ref, assignee: to });
          r.employee = to;
        }
        toast(to ? `Assigned to ${to}.` : 'Unassigned.', 'ok');
        first = null;
        await load({ quiet: true });
      } catch (err) {
        if (err.data?.stale) { toast(err.message, 'info'); first = null; await load({ quiet: true }); return; }
        toastError(err);
        sel.value = r.employee || '';
      }
    });
    return sel;
  }

  function chatButton(r) {
    if (!r.chat_id || !r.channel) {
      return h('span', { class: 'muted', title: 'No chat linked yet' }, '—');
    }
    return h('a', {
      class: 'btn btn-sm',
      href: linkFor({ type: 'chat', channel: r.channel, chat_id: r.chat_id }),
      title: 'Open chat',
    }, icon('chats', { size: 14 }), 'Chat');
  }

  function docsCell(r) {
    const docs = r.documents ?? [];
    if (!docs.length) return h('span', { class: 'muted' }, 'None yet');
    return h('div', { class: 'port-docs' }, docs.slice(0, 6).map((d) => {
      const b = h('button', {
        class: `btn btn-sm btn-ghost port-doc${d.sent_by_mky ? ' is-mky' : ''}`,
        type: 'button',
        title: d.file_name || d.label,
        disabled: !d.has_file,
      }, icon(d.sent_by_mky ? 'stamp' : 'file', { size: 12 }), d.label);
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openDoc(d.id); });
      return b;
    }), docs.length > 6 ? h('span', { class: 'muted' }, `+${docs.length - 6}`) : null);
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

  search.addEventListener('input', debounce(() => { q = search.value.trim(); rows = []; next = null; first = null; load(); }, 300));
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
    const funds = d.funds ?? FUNDS_FALLBACK;
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
    h('option', { value: '' }, 'Unassigned'),
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
        d.port_amount = res.row?.port_amount ?? null;
        d.port_funds_status = res.row?.port_funds_status ?? fundsSel.value;
        d.version = res.version ?? d.version;
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
          badge(d.port_funds_words, d.port_funds_status === 'received' ? 'green' : d.port_funds_status === 'in_process' ? 'blue' : 'amber')),
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
