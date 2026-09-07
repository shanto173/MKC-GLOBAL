/**
 * The operations console.
 *
 * Plain ES modules, no framework and no build step - the same choice the rest
 * of this project made, and the reason the console is a file the server can
 * hand over unchanged.
 *
 * It imports the SAME workflow module the server uses, so a chip's colour and
 * a button's presence are decided by the same code that decides whether the
 * action is allowed. This copy decides what to draw. The server decides what
 * is permitted, and re-derives it from rows on every write - nothing here is
 * trusted, and every action can be refused with a reason we then show.
 */

import {
  STATUS, statusLabel, statusTone, whoseTurn, PRIORITY, priorityLabel,
  humanAge, DOC_STATUS, DOC_LABEL, REJECT_REASONS, TRANSITIONS,
  REQUEST_STATUS, REQUEST_TRANSITIONS, REQUEST_TYPE,
  requestStatusLabel, requestStatusTone, shipmentTone,
} from './workflow.js';

const SKEY = 'mky-ops-secret';
const NKEY = 'mky-ops-name';

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const esc = (s) => String(s ?? '');

let secret = localStorage.getItem(SKEY) || '';
let operator = localStorage.getItem(NKEY) || '';
let route = { page: 'dashboard', ref: null, filter: 'active' };
let dirty = false;               // unsaved text in a composer

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Every call carries the secret in a HEADER, never the query string: as a
 * query parameter it lands in the platform's request logs and in the browser's
 * history on every navigation.
 */
async function api(path, options = {}) {
  const url = `/api/admin/ops?resource=console&${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { 'x-admin-secret': secret, ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  if (res.status === 401) { gate('That secret was not accepted.'); throw new Error('unauthorised'); }
  const data = await res.json().catch(() => ({ error: 'The server sent something we could not read.' }));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { data, status: res.status });
  return data;
}

const post = (body) => api('', { method: 'POST', body: JSON.stringify({ ...body, operator }) });

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

const NAV = [
  ['Operations', [
    ['dashboard', '🏠', 'Dashboard'],
    ['queue', '📥', 'Booking Queue'],
    ['mrn', '🧾', 'MRN Requests'],
    ['documents', '📄', 'Document Review'],
  ]],
  ['Shipments', [
    ['confirmed', '🚢', 'Confirmed Bookings'],
    ['shipments', '🌍', 'Shipments'],
  ]],
  ['Communication', [
    ['requests', '💬', 'Client Requests'],
  ]],
  ['Personal', [
    ['tasks', '✅', 'My Tasks'],
  ]],
];

let counts = {};

function renderShell() {
  const nav = $('#nav');
  nav.innerHTML = '';
  for (const [group, items] of NAV) {
    nav.appendChild(el('div', 'navgroup', group));
    const box = el('div', 'nav');
    for (const [page, icon, label] of items) {
      const a = el('a');
      a.href = `#/${page}`;
      if (route.page === page) a.setAttribute('aria-current', 'page');
      a.append(el('span', null, icon), el('span', null, label));
      const n = counts[page];
      if (n) a.appendChild(el('span', 'count', String(n)));
      box.appendChild(a);
    }
    nav.appendChild(box);
  }
  $('#whoName').textContent = operator || 'not signed in';
  $('#whoRole').textContent = counts.role ? counts.role.replace(/_/g, ' ') : '';
}

function toast(message, bad = false) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = el('div', `toast${bad ? ' bad' : ''}`, message);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3000);
}

function skeleton(rows = 6) {
  const s = el('div', 'skeleton');
  for (let i = 0; i < rows; i++) s.appendChild(el('div'));
  return s;
}

function errorState(message, retry) {
  const box = el('div', 'errorstate');
  box.append(el('div', 'big', message));
  const b = el('button', 'btn', 'Try again');
  b.onclick = retry;
  box.appendChild(b);
  return box;
}

function emptyState(title, detail) {
  const box = el('div', 'empty');
  box.append(el('div', 'big', title));
  if (detail) box.append(el('div', null, detail));
  return box;
}

const chip = (text, tone) => {
  const c = el('span', `chip ${tone}`);
  c.append(el('span', null, text));
  return c;
};

const ownerTag = (owner) => el('span', `owner ${owner}`,
  owner === 'ops' ? 'US' : owner === 'client' ? 'CLIENT' : '—');

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

async function pageDashboard(root) {
  root.appendChild(skeleton(4));
  let data;
  try {
    data = await api(`view=dashboard&operator=${encodeURIComponent(operator)}`);
  } catch (e) {
    root.replaceChildren(errorState('We could not load the dashboard.', render));
    return;
  }
  root.replaceChildren();

  counts.queue = data.counters.find((c) => c.key === 'new')?.count || 0;
  counts.tasks = data.my_tasks.length;
  renderShell();

  const grid = el('div', 'counters');
  for (const c of data.counters) {
    const b = el('button', `counter${c.count === 0 ? ' zero' : c.key === 'overdue' ? ' alert' : c.key === 'waiting' ? ' warn' : ''}`);
    b.append(el('div', 'n', String(c.count)), el('div', 't', c.label));
    b.onclick = () => { location.hash = `#/queue/${c.filter}`; };
    grid.appendChild(b);
  }
  root.appendChild(grid);

  const cols = el('div');
  cols.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start';

  cols.appendChild(taskCard('My priority tasks', data.my_tasks,
    operator ? 'Nothing assigned to you needs action.' : 'Sign in to see your work.'));
  cols.appendChild(taskCard('Unassigned work', data.unassigned, 'Everything has an owner.'));
  root.appendChild(cols);

  const act = el('div', 'card');
  act.style.marginTop = '16px';
  act.appendChild(el('h2', null, 'Recent activity'));
  const body = el('div', 'body');
  if (!data.activity.length) body.appendChild(el('div', 'sub', 'Nothing yet today.'));
  const ul = el('ul', 'timeline');
  for (const a of data.activity.slice(0, 12)) {
    const li = el('li');
    li.append(el('time', null, new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    const txt = el('span', null, `${a.who} ${a.what}`);
    if (a.entity) {
      txt.append(' ');
      const link = el('a', null, a.entity);
      link.href = `#/booking/${a.entity}`;
      txt.appendChild(link);
    }
    li.appendChild(txt);
    ul.appendChild(li);
  }
  body.appendChild(ul);
  act.appendChild(body);
  root.appendChild(act);
}

function taskCard(title, rows, emptyText) {
  const card = el('div', 'card');
  card.appendChild(el('h2', null, `${title} (${rows.length})`));
  if (!rows.length) {
    const b = el('div', 'body');
    b.appendChild(el('div', 'sub', emptyText));
    card.appendChild(b);
    return card;
  }
  const wrap = el('div', 'tablewrap');
  wrap.style.border = '0';
  wrap.style.boxShadow = 'none';
  const t = el('table', 'ops');
  t.innerHTML = '<thead><tr><th>Chassis</th><th>Client</th><th>Next action</th><th>Waiting</th></tr></thead>';
  const tb = el('tbody');
  for (const r of rows.slice(0, 8)) {
    const tr = el('tr');
    tr.onclick = () => { location.hash = `#/booking/${r.booking_ref}`; };
    tr.append(
      cell(el('span', 'mono', r.vin || '—')),
      cell(el('span', null, r.customer_name || '—')),
      cell(el('span', null, r.next.label)),
      cell(el('span', r.overdue ? 'chip red' : null, humanAge(r.waiting_since))),
    );
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  wrap.appendChild(t);
  card.appendChild(wrap);
  return card;
}

const cell = (...nodes) => { const td = el('td'); td.append(...nodes); return td; };

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

const QUEUE_FILTERS = [
  ['active', 'All active'], ['new', 'New'], ['mine', 'My tasks'], ['unassigned', 'Unassigned'],
  ['responded', 'Client responded'], ['missing_documents', 'Missing documents'], ['mrn', 'MRN required'],
  ['waiting_client', 'Waiting on client'], ['ready', 'Ready to confirm'], ['overdue', 'Overdue'],
  ['confirmed_today', 'Confirmed today'],
];

async function pageQueue(root, presetFilter) {
  const filter = presetFilter || route.filter || 'active';

  const bar = el('div', 'filters');
  for (const [key, label] of QUEUE_FILTERS) {
    const b = el('button', 'fchip', label);
    b.setAttribute('aria-pressed', String(key === filter));
    b.onclick = () => { location.hash = `#/queue/${key}`; };
    bar.appendChild(b);
  }
  const clear = el('button', 'btn small', 'Clear');
  clear.onclick = () => { location.hash = '#/queue/active'; };
  bar.appendChild(clear);
  root.appendChild(bar);

  const countLine = el('div', 'sub');
  countLine.style.margin = '0 0 10px';
  root.appendChild(countLine);

  const host = el('div');
  host.appendChild(skeleton(8));
  root.appendChild(host);

  let data;
  try {
    data = await api(`view=queue&filter=${encodeURIComponent(filter)}&operator=${encodeURIComponent(operator)}`);
  } catch (e) {
    host.replaceChildren(errorState('We could not load booking requests.', render));
    return;
  }

  countLine.textContent = `${data.total} request${data.total === 1 ? '' : 's'}`;

  if (!data.rows.length) {
    host.replaceChildren(emptyState(
      filter === 'active' ? 'No active booking requests 🎉' : 'Nothing matches this filter',
      filter === 'active' ? 'Everything has been dealt with.' : 'Try another filter.',
    ));
    return;
  }

  const wrap = el('div', 'tablewrap');
  const t = el('table', 'ops');
  t.innerHTML = `<thead><tr>
    <th></th><th>Status</th><th>Turn</th><th>Request</th><th>Chassis</th><th>Client</th>
    <th>Route</th><th>Docs</th><th>MRN</th><th>Owner</th><th>Next action</th><th>Waiting</th>
  </tr></thead>`;
  const tb = el('tbody');

  for (const r of data.rows) {
    const tr = el('tr');
    tr.onclick = () => { location.hash = `#/booking/${r.booking_ref}`; };

    const pri = el('td');
    const bar2 = el('span', `pri ${r.priority}`);
    bar2.title = `${priorityLabel(r.priority)} priority`;
    pri.appendChild(bar2);

    const status = el('td');
    status.appendChild(chip(r.status_label, statusTone(r.status)));
    if (r.client_responded) {
      const b = chip('New reply', 'green');
      b.style.marginTop = '4px';
      status.append(document.createElement('br'), b);
    }

    const docs = el('td');
    const ok = r.documents_received >= r.documents_required;
    docs.appendChild(chip(`${r.documents_received}/${r.documents_required}`, ok ? 'green' : 'amber'));

    const mrn = el('td');
    mrn.appendChild(r.mrn_status
      ? chip(String(r.mrn_status).replace(/_/g, ' '), r.mrn_status === 'issued' ? 'green' : 'amber')
      : el('span', 'sub', r.mrn_choice === 'mky_issue' ? 'not started' : '—'));

    const waiting = el('td');
    waiting.appendChild(r.overdue ? chip(humanAge(r.waiting_since), 'red') : el('span', null, humanAge(r.waiting_since)));

    const next = el('td');
    next.append(el('div', null, r.next.label));
    if (r.next.detail) next.append(el('div', 'sub', r.next.detail));

    tr.append(
      pri, status,
      cell(ownerTag(r.next.owner)),
      cell(el('span', 'mono', r.booking_ref.replace(/^MKY-BKG-/, ''))),
      cell(el('span', 'mono', r.vin || '—')),
      cell(el('span', null, r.customer_name || '—'), el('div', 'sub', r.make || '')),
      cell(el('span', 'sub', `${r.origin_port ?? '?'} → ${r.destination_port ?? '?'}`)),
      docs, mrn,
      cell(el('span', r.assigned_to ? null : 'sub', r.assigned_to || 'Unassigned')),
      next, waiting,
    );
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  wrap.appendChild(t);
  host.replaceChildren(wrap);
}

// ---------------------------------------------------------------------------
// Booking workspace
// ---------------------------------------------------------------------------

let detail = null;
let activeTab = 'overview';

async function pageBooking(root, ref) {
  root.appendChild(skeleton(6));
  try {
    detail = await api(`view=booking&ref=${encodeURIComponent(ref)}`);
  } catch (e) {
    root.replaceChildren(errorState(e.message || 'We could not load this booking.', render));
    return;
  }
  root.replaceChildren();

  const b = detail.booking;
  const next = detail.next_action;

  // Loudest thing on the page when it applies: another live booking already
  // holds this chassis.
  if (detail.duplicate) {
    const w = el('div', 'banner red');
    w.append(el('b', null, '🚨 This chassis already has a live booking'));
    const line = el('div');
    line.append(`${detail.duplicate.booking_ref} · ${statusLabel(detail.duplicate.status)} · ${detail.duplicate.customer_name ?? ''} `);
    const link = el('a', null, 'Open it');
    link.href = `#/booking/${detail.duplicate.booking_ref}`;
    line.appendChild(link);
    w.appendChild(line);
    root.appendChild(w);
  }

  const head = el('div', 'bkhead');
  const row1 = el('div', 'row1');
  row1.append(
    el('h1', null, [b.make, b.model].filter(Boolean).join(' ') || 'Booking request'),
    chip(b.status_label, statusTone(b.status)),
    ownerTag(next.owner),
  );
  if (b.priority !== 'normal') row1.appendChild(chip(priorityLabel(b.priority), PRIORITY[b.priority].tone));
  head.appendChild(row1);

  const meta = el('div', 'meta');
  meta.append(
    kv('Chassis', b.vin), kv('Request', b.booking_ref), kv('Client', b.customer_name),
    kv('Route', `${b.origin_port ?? '?'} → ${b.destination_port ?? '?'}`),
    kv('Owner', b.assigned_to || 'Unassigned'),
    kv('Waiting', humanAge(b.status_changed_at || b.submitted_at || b.created_at)),
  );
  head.appendChild(meta);
  root.appendChild(head);

  const ws = el('div', 'workspace');
  const main = el('div');
  const side = el('div', 'side');

  // -- next action ---------------------------------------------------------
  const nc = el('div', `nextcard ${next.owner === 'client' ? 'client' : next.owner === 'none' ? 'none' : ''}`);
  nc.append(el('div', 'k', next.owner === 'client' ? 'Waiting on the client' : 'Next required action'));
  nc.append(el('div', 'v', next.label));
  nc.append(el('div', 'd', next.detail));
  const primary = primaryButton(next, b);
  if (primary) { primary.style.marginTop = '11px'; nc.appendChild(primary); }
  main.appendChild(nc);

  // -- tabs ----------------------------------------------------------------
  const tabs = el('div', 'tabs');
  const panel = el('div');
  for (const [key, label] of [['overview', 'Overview'], ['documents', `Documents (${detail.documents.length})`],
    ['mrn', 'MRN'], ['messages', 'Messages'], ['activity', 'Activity']]) {
    const t = el('button', null, label);
    t.setAttribute('aria-selected', String(activeTab === key));
    t.onclick = () => { activeTab = key; drawTab(panel); tabs.querySelectorAll('button').forEach((x, i) => x.setAttribute('aria-selected', String(x === t))); };
    tabs.appendChild(t);
  }
  main.append(tabs, panel);
  drawTab(panel);

  // -- sidebar -------------------------------------------------------------
  side.appendChild(sidePanel(b));
  ws.append(main, side);
  root.appendChild(ws);
}

const kv = (k, v) => { const s = el('span'); s.append(`${k}: `, el('b', null, v || '—')); return s; };

function primaryButton(next, b) {
  const map = {
    request_documents: ['Request the documents', () => modalRequestInfo(suggestDocs())],
    request_info: ['Ask the client', () => modalRequestInfo('')],
    process_mrn: ['Process the MRN', () => { activeTab = 'mrn'; render(); }],
    review_documents: ['Check the documents', () => { activeTab = 'documents'; render(); }],
    create_booking: ['Create the booking', modalCreateBooking],
    confirm_booking: ['Confirm booking', modalConfirm],
    send_reminder: ['Send a reminder', () => modalRequestInfo(suggestDocs())],
  };
  const entry = map[next.action];
  if (!entry) return null;
  const [label, fn] = entry;
  const btn = el('button', 'btn primary', label);
  btn.onclick = fn;
  return btn;
}

const suggestDocs = () => {
  const missing = detail.document_summary.missing.map((t) => DOC_LABEL[t] ?? t);
  return missing.length ? missing.map((m) => `• ${m}`).join('\n') : '';
};

function drawTab(panel) {
  panel.replaceChildren();
  if (activeTab === 'overview') return drawOverview(panel);
  if (activeTab === 'documents') return drawDocuments(panel);
  if (activeTab === 'mrn') return drawMrn(panel);
  if (activeTab === 'messages') return drawMessages(panel);
  return drawActivity(panel);
}

function drawOverview(panel) {
  const card = el('div', 'card');
  card.appendChild(el('h2', null, 'Booking readiness'));
  const body = el('div', 'body');
  const ul = el('ul', 'checklist');
  for (const item of detail.readiness.items) {
    const li = el('li');
    li.append(el('span', 'mark', item.ok ? '✅' : item.blocking ? '⬜' : '⬜'), el('span', null, item.label));
    if (item.note) li.appendChild(el('span', 'note', item.note));
    ul.appendChild(li);
  }
  body.appendChild(ul);
  card.appendChild(body);
  panel.appendChild(card);

  const info = el('div', 'card');
  info.style.marginTop = '14px';
  info.appendChild(el('h2', null, 'Request details'));
  const ib = el('div', 'body');
  const b = detail.booking;
  const grid = el('div');
  grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px 22px';
  for (const [k, v] of [
    ['Chassis / VIN', b.vin], ['Make', b.make], ['Model', b.model],
    ['Client name', b.customer_name], ['Company', b.company],
    ['Port of loading', b.origin_port], ['Destination', b.destination_port],
    ['MRN handling', b.mrn_choice === 'mky_issue' ? 'MKY obtains it' : 'Client has it'],
    ['MRN number', b.mrn_number], ['Requested', b.created_at && new Date(b.created_at).toLocaleString()],
    ['Client confirmed', b.client_confirmed_at && new Date(b.client_confirmed_at).toLocaleString()],
  ]) {
    const cellBox = el('div');
    cellBox.append(el('div', 'k', k), el('div', null, v || '—'));
    grid.appendChild(cellBox);
  }
  ib.appendChild(grid);
  info.appendChild(ib);
  panel.appendChild(info);
}

function drawDocuments(panel) {
  const card = el('div', 'card');
  card.appendChild(el('h2', null, 'Documents'));
  const body = el('div', 'body');

  for (const type of detail.document_summary.required) {
    const got = detail.documents.filter((d) => d.doc_type === type
      || (type === 'brief' && d.doc_type === 'eur1'));
    if (!got.length) {
      const miss = el('div', 'doc');
      const top = el('div', 'top');
      top.append(el('b', null, DOC_LABEL[type] ?? type), el('span', 'sp'), chip('Missing', 'red'));
      miss.appendChild(top);
      const acts = el('div', 'acts');
      const ask = el('button', 'btn small', 'Request from client');
      ask.onclick = () => modalRequestInfo(`• ${DOC_LABEL[type] ?? type}`);
      acts.appendChild(ask);
      miss.appendChild(acts);
      body.appendChild(miss);
      continue;
    }
    for (const d of got) body.appendChild(documentCard(d));
  }

  const extra = detail.documents.filter((d) => !detail.document_summary.required.includes(d.doc_type)
    && !(d.doc_type === 'eur1' && detail.document_summary.required.includes('brief')));
  if (extra.length) {
    body.appendChild(el('div', 'k', 'Also sent'));
    for (const d of extra) body.appendChild(documentCard(d));
  }

  card.appendChild(body);
  panel.appendChild(card);
}

function documentCard(d) {
  const box = el('div', 'doc');
  const top = el('div', 'top');
  const state = DOC_STATUS[d.status] ?? DOC_STATUS.received;
  top.append(el('b', null, d.label), el('span', 'sp'), chip(state.label, state.tone));
  box.appendChild(top);

  const meta = el('div', 'sub');
  meta.textContent = `${d.file_name ?? 'file'} · ${new Date(d.uploaded_at).toLocaleString()}`
    + (d.verified_by ? ` · reviewed by ${d.verified_by}` : '')
    + (d.extraction_ok === false ? ' · could not be read automatically' : '');
  box.appendChild(meta);

  if (d.wrong_vehicle) {
    const w = el('div', 'banner amber');
    w.style.margin = '9px 0 0';
    w.append(el('b', null, '⚠️ Different chassis'), el('div', null, `This document names ${d.vin}.`));
    box.appendChild(w);
  }
  if (d.rejection_reason || d.rejection_code) {
    box.appendChild(el('div', 'sub', `Sent back: ${d.rejection_reason || d.rejection_code}`));
  }

  const acts = el('div', 'acts');
  if (d.url) {
    const open = el('a', 'btn small', 'Open');
    open.href = d.url; open.target = '_blank'; open.rel = 'noopener';
    acts.appendChild(open);
  }
  if (d.status !== 'verified') {
    const v = el('button', 'btn small primary', 'Verify');
    v.onclick = () => runAction(v, { action: 'verify_document', document_id: d.id }, 'Verified.');
    acts.appendChild(v);
  }
  if (!['replacement_requested'].includes(d.status)) {
    const r = el('button', 'btn small danger', 'Reject / replace');
    r.onclick = () => modalRejectDocument(d);
    acts.appendChild(r);
  }
  box.appendChild(acts);
  return box;
}

function drawMrn(panel) {
  const card = el('div', 'card');
  card.appendChild(el('h2', null, 'MRN'));
  const body = el('div', 'body');
  const b = detail.booking;

  if (b.mrn_choice !== 'mky_issue') {
    body.appendChild(el('div', null, 'The client holds their own MRN; it arrives as a document.'));
    if (b.mrn_number) body.appendChild(el('div', 'sub', `Recorded: ${b.mrn_number}`));
    card.appendChild(body);
    panel.appendChild(card);
    return;
  }

  const m = detail.mrn;
  if (!m) {
    body.appendChild(el('div', null, 'MKY is to obtain the MRN, but no application has been opened.'));
  } else {
    const g = el('div');
    g.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px 22px;margin-bottom:12px';
    for (const [k, v] of [['Application', m.request_ref], ['Status', String(m.status).replace(/_/g, ' ')],
      ['MRN number', m.mrn_number], ['Opened', new Date(m.created_at).toLocaleString()],
      ['Issued', m.issued_at && new Date(m.issued_at).toLocaleString()]]) {
      const c = el('div'); c.append(el('div', 'k', k), el('div', null, v || '—')); g.appendChild(c);
    }
    body.appendChild(g);

    const supplied = m.supplied_information?.notes ?? [];
    if (supplied.length) {
      body.appendChild(el('div', 'k', 'What the client told us'));
      const ul = el('ul', 'timeline');
      for (const n of supplied) {
        const li = el('li');
        li.append(el('time', null, new Date(n.at).toLocaleDateString()), el('span', null, n.text));
        ul.appendChild(li);
      }
      body.appendChild(ul);
    }

    if (m.status !== 'issued') {
      const acts = el('div', 'acts');
      const issue = el('button', 'btn primary', 'Record the MRN');
      issue.onclick = () => modalIssueMrn(m);
      acts.appendChild(issue);
      body.appendChild(acts);
    }
  }
  card.appendChild(body);
  panel.appendChild(card);
}

function drawMessages(panel) {
  // Two composers, deliberately as different as the design system allows.
  // Sending an internal note to a client is the mistake this layout exists to
  // prevent, so they never look alike and never sit in the same box.
  const client = el('div', 'compose-client');
  client.appendChild(el('h3', null, '💬 Message to the client — this is sent to Telegram'));
  const ct = el('textarea');
  ct.placeholder = 'Written to the client in their chat…';
  ct.oninput = () => { dirty = Boolean(ct.value.trim()); };
  client.appendChild(ct);
  const cb = el('button', 'btn primary', 'Send to client');
  cb.style.marginTop = '9px';
  cb.onclick = () => {
    if (!ct.value.trim()) return toast('Nothing to send.', true);
    runAction(cb, { action: 'message_client', booking_ref: detail.booking.booking_ref, text: ct.value.trim() }, 'Message queued for the client.');
  };
  client.appendChild(cb);
  panel.appendChild(client);

  const internal = el('div', 'compose-internal');
  internal.style.marginTop = '14px';
  internal.appendChild(el('h3', null, '🔒 Internal note — never leaves this console'));
  const it = el('textarea');
  it.placeholder = 'For the desk only…';
  it.oninput = () => { dirty = Boolean(it.value.trim()); };
  internal.appendChild(it);
  const ib = el('button', 'btn', 'Save internal note');
  ib.style.marginTop = '9px';
  ib.onclick = () => {
    if (!it.value.trim()) return toast('Nothing to save.', true);
    runAction(ib, { action: 'internal_note', booking_ref: detail.booking.booking_ref, body: it.value.trim() }, 'Note saved.');
  };
  internal.appendChild(ib);
  panel.appendChild(internal);

  if (detail.notes.length) {
    const card = el('div', 'card');
    card.style.marginTop = '14px';
    card.appendChild(el('h2', null, 'Internal notes'));
    const body = el('div', 'body');
    for (const n of detail.notes) {
      const box = el('div', 'note-internal');
      box.append(el('div', 'who', `${n.author} · ${new Date(n.created_at).toLocaleString()}`), el('div', null, n.body));
      body.appendChild(box);
    }
    card.appendChild(body);
    panel.appendChild(card);
  }

  const notif = el('div', 'card');
  notif.style.marginTop = '14px';
  notif.appendChild(el('h2', null, 'Client notifications'));
  const nb = el('div', 'body');
  if (!detail.notifications.length) nb.appendChild(el('div', 'sub', 'Nothing has been sent about this booking.'));
  for (const n of detail.notifications) {
    const row = el('div', 'doc');
    const top = el('div', 'top');
    const tone = n.status === 'sent' ? 'green' : n.status === 'dead' ? 'red' : 'amber';
    const word = n.status === 'sent' ? 'Sent' : n.status === 'dead' ? 'Failed' : 'Pending';
    top.append(el('b', null, String(n.event_type).replace(/_/g, ' ')), el('span', 'sp'), chip(word, tone));
    row.appendChild(top);
    row.appendChild(el('div', 'sub', (n.sent_at ? new Date(n.sent_at).toLocaleString() : `queued ${new Date(n.created_at).toLocaleString()}`)
      + (n.attempt_count ? ` · ${n.attempt_count} attempt${n.attempt_count === 1 ? '' : 's'}` : '')
      + (n.last_error ? ` · ${n.last_error}` : '')));
    nb.appendChild(row);
  }
  notif.appendChild(nb);
  panel.appendChild(notif);
}

function drawActivity(panel) {
  const card = el('div', 'card');
  card.appendChild(el('h2', null, 'Activity'));
  const body = el('div', 'body');
  if (!detail.activity.length) body.appendChild(el('div', 'sub', 'Nothing recorded yet.'));
  const ul = el('ul', 'timeline');
  for (const a of detail.activity) {
    const li = el('li');
    li.append(el('time', null, new Date(a.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })));
    li.append(el('span', null, `${a.who} ${a.what}`));
    ul.appendChild(li);
  }
  body.appendChild(ul);
  card.appendChild(body);
  panel.appendChild(card);
}

function sidePanel(b) {
  const card = el('div', 'card');
  card.appendChild(el('h2', null, 'This request'));
  const body = el('div', 'body');

  body.append(el('div', 'k', 'Status'));
  const sel = el('select');
  const allowed = [b.status, ...(TRANSITIONS[b.status] ?? [])];
  for (const s of allowed) {
    const o = el('option', null, statusLabel(s));
    o.value = s;
    if (s === b.status) o.selected = true;
    sel.appendChild(o);
  }
  sel.disabled = allowed.length < 2;
  sel.onchange = () => {
    if (sel.value === b.status) return;
    runAction(sel, { action: 'status', booking_ref: b.booking_ref, status: sel.value }, 'Status updated.');
  };
  body.appendChild(sel);

  body.append(el('div', 'k', 'Owner'));
  const owner = el('div', 'v', b.assigned_to || 'Unassigned');
  body.appendChild(owner);
  const acts = el('div', 'acts');
  if (b.assigned_to?.toLowerCase() !== operator.toLowerCase()) {
    const mine = el('button', 'btn small', 'Assign to me');
    mine.onclick = () => runAction(mine, { action: 'assign', booking_ref: b.booking_ref, assignee: operator }, 'Assigned to you.');
    acts.appendChild(mine);
  }
  if (b.assigned_to) {
    const un = el('button', 'btn small', 'Unassign');
    un.onclick = () => runAction(un, { action: 'unassign', booking_ref: b.booking_ref }, 'Owner removed.');
    acts.appendChild(un);
  }
  body.appendChild(acts);

  body.append(el('div', 'k', 'Priority'));
  const pr = el('select');
  for (const p of Object.keys(PRIORITY)) {
    const o = el('option', null, priorityLabel(p));
    o.value = p;
    if (p === b.priority) o.selected = true;
    pr.appendChild(o);
  }
  pr.onchange = () => runAction(pr, { action: 'priority', booking_ref: b.booking_ref, priority: pr.value }, 'Priority updated.');
  body.appendChild(pr);

  card.appendChild(body);
  return card;
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function modal({ title, body, confirmLabel, danger, onConfirm }) {
  const back = el('div', 'backdrop');
  const box = el('div', 'modal');
  box.appendChild(el('h2', null, title));
  const b = el('div', 'body');
  b.appendChild(body);
  box.appendChild(b);
  const foot = el('div', 'foot');
  const cancel = el('button', 'btn', 'Cancel');
  cancel.onclick = () => back.remove();
  const go = el('button', `btn ${danger ? 'danger' : 'primary'}`, confirmLabel);
  go.onclick = async () => {
    go.disabled = true; cancel.disabled = true;
    try { await onConfirm(); back.remove(); } finally { go.disabled = false; cancel.disabled = false; }
  };
  foot.append(cancel, go);
  box.appendChild(foot);
  back.appendChild(box);
  back.onclick = (e) => { if (e.target === back) back.remove(); };
  document.body.appendChild(back);
  return back;
}

function modalRequestInfo(prefill) {
  const wrap = el('div');
  wrap.appendChild(el('div', 'sub', 'The client is sent this in their own chat, in Arabic and English.'));
  const ta = el('textarea');
  ta.value = prefill || '';
  ta.placeholder = '• Invoice\n• MRN';
  wrap.appendChild(ta);
  const preview = el('div', 'preview');
  const paint = () => { preview.textContent = `⚠️ We need a little more information to continue your booking ${detail.booking.booking_ref}.\n\nPlease provide:\n${ta.value}`; };
  ta.oninput = paint; paint();
  wrap.appendChild(preview);

  modal({
    title: 'Ask the client for something',
    body: wrap,
    confirmLabel: 'Send request',
    onConfirm: async () => {
      if (!ta.value.trim()) { toast('Say what you need.', true); throw new Error('empty'); }
      await post({ action: 'request_info', booking_ref: detail.booking.booking_ref, requested: ta.value.trim() });
      toast('Sent. The request is now waiting on the client.');
      await render();
    },
  });
}

function modalRejectDocument(d) {
  const wrap = el('div');
  wrap.appendChild(el('label', null, 'Why is it being sent back?'));
  const sel = el('select');
  for (const [code, label] of REJECT_REASONS) {
    const o = el('option', null, label); o.value = code; sel.appendChild(o);
  }
  wrap.appendChild(sel);
  wrap.appendChild(el('label', null, 'Note for the client (optional)'));
  const note = el('input'); note.type = 'text'; note.placeholder = 'Page 2 is cut off';
  wrap.appendChild(note);
  const preview = el('div', 'preview');
  const paint = () => {
    const reason = note.value.trim() || REJECT_REASONS.find(([c]) => c === sel.value)[1].toLowerCase();
    preview.textContent = `⚠️ We need a replacement ${d.label} — ${reason}.`;
  };
  sel.onchange = paint; note.oninput = paint; paint();
  wrap.appendChild(preview);

  modal({
    title: `Send back the ${d.label}`,
    body: wrap,
    confirmLabel: 'Request replacement',
    danger: true,
    onConfirm: async () => {
      await post({ action: 'reject_document', document_id: d.id, reason_code: sel.value, reason: note.value.trim() });
      toast('Replacement requested. The client has been told.');
      await render();
    },
  });
}

function modalIssueMrn(m) {
  const wrap = el('div');
  wrap.appendChild(el('div', 'sub', 'Type the MRN exactly as it was issued. It is never generated here.'));
  wrap.appendChild(el('label', null, 'MRN number'));
  const num = el('input'); num.type = 'text'; num.placeholder = '26LTVR…';
  wrap.appendChild(num);

  modal({
    title: `Record the MRN for ${m.request_ref}`,
    body: wrap,
    confirmLabel: 'Mark MRN issued',
    onConfirm: async () => {
      if (!num.value.trim()) { toast('Enter the MRN.', true); throw new Error('empty'); }
      const res = await fetch('/api/admin/mrn', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-secret': secret },
        body: JSON.stringify({ request_ref: m.request_ref, action: 'issue', mrn_number: num.value.trim(), operator }),
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error || 'That did not work.', true); throw new Error('failed'); }
      toast('MRN recorded.');
      await render();
    },
  });
}

function modalCreateBooking() {
  const wrap = el('div');
  wrap.appendChild(el('div', 'sub', 'Everything the client owes is in. Record the reference this booking will carry.'));
  wrap.appendChild(el('label', null, 'Booking reference'));
  const ref = el('input'); ref.type = 'text'; ref.value = detail.booking.booking_ref;
  wrap.appendChild(ref);
  wrap.appendChild(el('label', null, 'Vessel (if known)'));
  const vessel = el('input'); vessel.type = 'text';
  wrap.appendChild(vessel);
  wrap.appendChild(el('label', null, 'Internal note (optional)'));
  const note = el('input'); note.type = 'text';
  wrap.appendChild(note);

  modal({
    title: 'Create the booking',
    body: wrap,
    confirmLabel: 'Record booking',
    onConfirm: async () => {
      await post({
        action: 'create_booking', booking_ref: detail.booking.booking_ref,
        reference: ref.value.trim(), vessel: vessel.value.trim(), note: note.value.trim(),
      });
      toast('Booking recorded. Confirm it when you are ready.');
      await render();
    },
  });
}

function modalConfirm() {
  const b = detail.booking;
  const wrap = el('div');
  const list = el('div');
  list.style.cssText = 'display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13.5px';
  for (const [k, v] of [
    ['Chassis', b.vin], ['Client', b.customer_name],
    ['Booking reference', b.booking_ref],
    ['Route', `${b.origin_port} → ${b.destination_port}`],
    ['Documents', `${detail.document_summary.received_types.length}/${detail.document_summary.required.length} received, ${detail.document_summary.verified_types.length} verified`],
    ['MRN', b.mrn_number || (b.mrn_choice === 'mky_issue' ? 'issued by MKY' : 'from the client')],
    ['Telegram', 'The client will be told'],
  ]) {
    list.append(el('div', 'k', k), el('div', null, v || '—'));
  }
  wrap.appendChild(list);
  wrap.appendChild(el('div', 'sub', 'This opens the shipment and messages the client. It cannot be undone from here.'));

  modal({
    title: 'Confirm this booking',
    body: wrap,
    confirmLabel: 'Confirm & notify client',
    onConfirm: async () => {
      const data = await post({ action: 'confirm', booking_ref: b.booking_ref });
      const told = data.customer_told || {};
      toast(told.telegram || told.queued
        ? `Confirmed. ${data.shipment?.shipment_id ? `Shipment ${data.shipment.shipment_id} opened. ` : ''}The client is being told.`
        : 'Confirmed — but the client could NOT be told. Check Messages.', !(told.telegram || told.queued));
      await render();
    },
  });
}

/** Runs an action with the button disabled, so a double click is one write. */
async function runAction(button, body, okMessage) {
  const was = button.disabled;
  button.disabled = true;
  try {
    await post(body);
    toast(okMessage);
    await render();
  } catch (e) {
    toast(e.message || 'That did not work.', true);
    button.disabled = was;
  }
}

// ---------------------------------------------------------------------------
// Placeholder pages, honest about being placeholders
// ---------------------------------------------------------------------------

async function pageList(root, title, endpointFilter, columns) {
  root.appendChild(skeleton(6));
  try {
    const data = await api(`view=queue&filter=${endpointFilter}&operator=${encodeURIComponent(operator)}`);
    root.replaceChildren();
    if (!data.rows.length) { root.appendChild(emptyState(`Nothing in ${title.toLowerCase()}`, 'Check back later.')); return; }
    const wrap = el('div', 'tablewrap');
    const t = el('table', 'ops');
    t.innerHTML = `<thead><tr>${columns.map((c) => `<th>${c[0]}</th>`).join('')}</tr></thead>`;
    const tb = el('tbody');
    for (const r of data.rows) {
      const tr = el('tr');
      tr.onclick = () => { location.hash = `#/booking/${r.booking_ref}`; };
      for (const [, get] of columns) tr.appendChild(cell(el('span', null, get(r) ?? '—')));
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    root.appendChild(wrap);
  } catch {
    root.replaceChildren(errorState(`We could not load ${title.toLowerCase()}.`, render));
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const TITLES = {
  dashboard: 'Dashboard', queue: 'Booking Queue', mrn: 'MRN Requests',
  documents: 'Document Review', confirmed: 'Confirmed Bookings', shipments: 'Shipments',
  requests: 'Client Requests', tasks: 'My Tasks', booking: 'Booking request', search: 'Search',
  request: 'Client request', shipment: 'Shipment',
};

function parseHash() {
  const parts = (location.hash || '#/dashboard').replace(/^#\/?/, '').split('/');
  const page = parts[0] || 'dashboard';
  if (['booking', 'request', 'shipment'].includes(page)) return { page, ref: decodeURIComponent(parts[1] ?? '') };
  if (page === 'queue') return { page, filter: parts[1] || 'active' };
  if (page === 'requests') return { page, filter: parts[1] || 'open' };
  if (page === 'shipments') return { page, filter: parts[1] || 'active' };
  return { page };
}

async function render() {
  route = parseHash();
  renderShell();
  $('#title').textContent = TITLES[route.page] ?? 'Operations';

  const root = $('#content');
  root.replaceChildren();

  try {
    if (route.page === 'dashboard') return await pageDashboard(root);
    if (route.page === 'queue') return await pageQueue(root, route.filter);
    if (route.page === 'booking') return await pageBooking(root, route.ref);
    if (route.page === 'tasks') return await pageQueue(root, 'mine');
    if (route.page === 'documents') return await pageQueue(root, 'missing_documents');
    if (route.page === 'mrn') return await pageQueue(root, 'mrn');
    if (route.page === 'confirmed') {
      return await pageList(root, 'Confirmed bookings', 'confirmed_today', [
        ['Booking Ref', (r) => r.booking_ref], ['Chassis', (r) => r.vin], ['Client', (r) => r.customer_name],
        ['Make', (r) => r.make], ['Route', (r) => `${r.origin_port} → ${r.destination_port}`],
        ['Confirmed', (r) => r.confirmed_at && new Date(r.confirmed_at).toLocaleString()],
        ['By', (r) => r.confirmed_by], ['Shipment', (r) => r.shipment_id],
      ]);
    }
    if (route.page === 'requests') return await pageRequests(root);
    if (route.page === 'request') return await pageRequest(root, route.ref);
    if (route.page === 'shipments') return await pageShipments(root);
    if (route.page === 'shipment') return await pageShipment(root, route.ref);
    root.appendChild(emptyState('Nothing here', 'Pick something from the sidebar.'));
  } catch (e) {
    root.replaceChildren(errorState('Something went wrong loading this screen.', render));
  }
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

function gate(message) {
  $('#app').hidden = true;
  const g = $('#gate');
  g.hidden = false;
  $('#gateErr').textContent = message || '';
  $('#gateErr').hidden = !message;
}

async function enter() {
  secret = $('#secret').value.trim();
  operator = $('#who').value.trim();
  if (!secret || !operator) return gate('Both your name and the secret are needed.');

  localStorage.setItem(SKEY, secret);
  localStorage.setItem(NKEY, operator);

  try {
    const users = await fetch('/api/admin/users', { headers: { 'x-admin-secret': secret } }).then((r) => r.json());
    if (users.error) return gate('That secret was not accepted.');
    const me = (users.users ?? []).find((u) => u.name.toLowerCase() === operator.toLowerCase());
    if (!me) return gate(`"${operator}" is not on the operations list. Ask an administrator to add you.`);
    counts.role = me.role;
  } catch {
    return gate('We could not reach the server.');
  }

  $('#gate').hidden = true;
  $('#app').hidden = false;
  await render();
}

// ---------------------------------------------------------------------------

window.addEventListener('hashchange', render);
window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

$('#enter').onclick = enter;
$('#secret').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });
$('#signout').onclick = () => { localStorage.removeItem(SKEY); localStorage.removeItem(NKEY); location.reload(); };
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.value.trim()) location.hash = `#/queue/all`;
});

if (secret && operator) {
  $('#secret').value = secret;
  $('#who').value = operator;
  enter();
} else {
  gate('');
}

// ---------------------------------------------------------------------------
// Client requests
// ---------------------------------------------------------------------------

const REQUEST_FILTERS = [
  ['open', 'All open'], ['mine', 'Mine'], ['unassigned', 'Unassigned'],
  ['booking', '📦 Booking'], ['tracking', '🚚 Tracking'], ['documents', '📄 Documents'],
  ['other', '💬 Other'], ['resolved', 'Resolved'],
];

async function pageRequests(root) {
  const filter = route.filter || 'open';

  const bar = el('div', 'filters');
  for (const [key, label] of REQUEST_FILTERS) {
    const b = el('button', 'fchip', label);
    b.setAttribute('aria-pressed', String(key === filter));
    b.onclick = () => { location.hash = `#/requests/${key}`; };
    bar.appendChild(b);
  }
  root.appendChild(bar);

  const host = el('div');
  host.appendChild(skeleton(7));
  root.appendChild(host);

  let data;
  try {
    data = await api(`view=requests&filter=${encodeURIComponent(filter)}&operator=${encodeURIComponent(operator)}`);
  } catch {
    host.replaceChildren(errorState('We could not load client requests.', render));
    return;
  }

  if (filter === 'open') { counts.requests = data.total; renderShell(); }

  if (!data.rows.length) {
    host.replaceChildren(emptyState('No open client requests 🎉', 'Nobody is waiting to hear from us.'));
    return;
  }

  const wrap = el('div', 'tablewrap');
  const t = el('table', 'ops');
  t.innerHTML = '<thead><tr>'
    + '<th></th><th>Status</th><th>Turn</th><th>Type</th><th>Client</th><th>Call</th>'
    + '<th>What they need</th><th>Booking</th><th>Owner</th><th>Next action</th><th>Waiting</th>'
    + '</tr></thead>';
  const tb = el('tbody');

  for (const r of data.rows) {
    const tr = el('tr');
    tr.onclick = () => { location.hash = `#/request/${r.ticket_ref}`; };

    const pri = el('td');
    const mark = el('span', `pri ${r.priority}`);
    mark.title = `${priorityLabel(r.priority)} priority`;
    pri.appendChild(mark);

    const type = REQUEST_TYPE[r.request_type] ?? REQUEST_TYPE.other;
    const phone = r.contact && !/^(telegram|web):/i.test(r.contact) ? r.contact : null;

    tr.append(
      pri,
      cell(chip(r.status_label, requestStatusTone(r.status))),
      cell(ownerTag(r.next.owner)),
      cell(el('span', null, `${type.icon} ${type.label}`)),
      cell(el('span', null, r.customer || r.client_display_name || '—')),
      cell(phone ? el('span', 'mono', phone) : el('span', 'sub', 'chat only')),
      cell(el('span', null, (r.summary || '').slice(0, 70))),
      cell(r.booking_ref ? el('span', 'mono', r.booking_ref.replace(/^MKY-BKG-/, '')) : el('span', 'sub', '—')),
      cell(el('span', r.assigned_to ? null : 'sub', r.assigned_to || 'Unassigned')),
      cell(el('span', null, r.next.label)),
      cell(el('span', null, humanAge(r.waiting_since))),
    );
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  wrap.appendChild(t);
  host.replaceChildren(wrap);
}

let requestView = null;

async function pageRequest(root, ref) {
  root.appendChild(skeleton(6));
  try {
    requestView = await api(`view=request&ref=${encodeURIComponent(ref)}`);
  } catch (e) {
    root.replaceChildren(errorState(e.message || 'We could not load this request.', render));
    return;
  }
  root.replaceChildren();

  const r = requestView.request;
  const next = requestView.next_action;
  const type = REQUEST_TYPE[r.request_type] ?? REQUEST_TYPE.other;

  const head = el('div', 'bkhead');
  const row1 = el('div', 'row1');
  row1.append(
    el('h1', null, `${type.icon} ${type.label}`),
    chip(r.status_label, requestStatusTone(r.status)),
    ownerTag(next.owner),
  );
  head.appendChild(row1);
  const meta = el('div', 'meta');
  meta.append(
    kv('Request', r.ticket_ref),
    kv('Client', r.customer || r.client_display_name),
    kv('Department', r.department),
    kv('Owner', r.assigned_to || 'Unassigned'),
    kv('Waiting', humanAge(r.status_changed_at || r.created_at)),
  );
  head.appendChild(meta);
  root.appendChild(head);

  const ws = el('div', 'workspace');
  const main = el('div');
  const side = el('div', 'side');

  const nc = el('div', `nextcard ${next.owner === 'client' ? 'client' : next.owner === 'none' ? 'none' : ''}`);
  nc.append(el('div', 'k', next.owner === 'client' ? 'Waiting on the client' : 'Next required action'));
  nc.append(el('div', 'v', next.label));
  main.appendChild(nc);

  const what = el('div', 'card');
  what.appendChild(el('h2', null, 'What the client said'));
  const wb = el('div', 'body');
  wb.appendChild(el('div', null, r.summary || '—'));
  const phone = r.contact && !/^(telegram|web):/i.test(r.contact) ? r.contact : null;
  wb.appendChild(el('div', 'sub', phone ? `Call: ${phone}` : 'No phone number — reply in the chat.'));
  what.appendChild(wb);
  main.appendChild(what);

  if (requestView.conversation.length) {
    const convo = el('div', 'card');
    convo.style.marginTop = '14px';
    convo.appendChild(el('h2', null, 'Recent conversation'));
    const cb = el('div', 'body');
    for (const m of requestView.conversation) {
      const box = el('div', m.role === 'user' ? 'compose-client' : 'note-internal');
      box.style.marginBottom = '8px';
      box.style.padding = '9px 11px';
      box.append(el('div', 'who', m.role === 'user' ? 'CLIENT' : 'BOT'));
      box.append(el('div', null, String(m.content).slice(0, 600)));
      cb.appendChild(box);
    }
    convo.appendChild(cb);
    main.appendChild(convo);
  }

  if (requestView.bookings.length) {
    const bk = el('div', 'card');
    bk.style.marginTop = '14px';
    bk.appendChild(el('h2', null, 'This client’s bookings'));
    const bb = el('div', 'body');
    for (const b of requestView.bookings) {
      const line = el('div');
      line.style.marginBottom = '5px';
      const a = el('a', 'mono', b.booking_ref);
      a.href = `#/booking/${b.booking_ref}`;
      line.append(a, ' ', chip(statusLabel(b.status), statusTone(b.status)), ` ${b.vin ?? ''} ${b.make ?? ''}`);
      bb.appendChild(line);
    }
    bk.appendChild(bb);
    main.appendChild(bk);
  }

  // Blue, like every other thing that reaches the client. An internal note has
  // no place on this screen: a client request is a conversation with them.
  const reply = el('div', 'compose-client');
  reply.style.marginTop = '14px';
  reply.appendChild(el('h3', null, '💬 Reply to the client — this is sent to Telegram'));
  const ta = el('textarea');
  ta.oninput = () => { dirty = Boolean(ta.value.trim()); };
  reply.appendChild(ta);
  const acts = el('div', 'acts');
  acts.style.marginTop = '9px';
  const send = el('button', 'btn primary', 'Send reply');
  send.onclick = () => {
    if (!ta.value.trim()) return toast('Nothing to send.', true);
    runAction(send, { action: 'request_reply', ticket_ref: r.ticket_ref, text: ta.value.trim() }, 'Reply queued.');
  };
  const sendWait = el('button', 'btn', 'Send and wait for them');
  sendWait.onclick = () => {
    if (!ta.value.trim()) return toast('Nothing to send.', true);
    runAction(sendWait, {
      action: 'request_reply', ticket_ref: r.ticket_ref, text: ta.value.trim(), wait_for_client: true,
    }, 'Reply sent — now waiting on the client.');
  };
  acts.append(send, sendWait);
  reply.appendChild(acts);
  main.appendChild(reply);

  const card = el('div', 'card');
  card.appendChild(el('h2', null, 'This request'));
  const body = el('div', 'body');

  body.append(el('div', 'k', 'Status'));
  const sel = el('select');
  for (const s of [r.status, ...(REQUEST_TRANSITIONS[r.status] ?? [])]) {
    const o = el('option', null, requestStatusLabel(s));
    o.value = s;
    if (s === r.status) o.selected = true;
    sel.appendChild(o);
  }
  sel.disabled = !(REQUEST_TRANSITIONS[r.status] ?? []).length;
  sel.onchange = () => {
    if (sel.value === r.status) return;
    // Resolving tells the client, so it needs a reason - never a silent status
    // change from a dropdown.
    if (sel.value === 'resolved') { sel.value = r.status; return modalResolveRequest(r); }
    runAction(sel, { action: 'request_status', ticket_ref: r.ticket_ref, status: sel.value }, 'Status updated.');
  };
  body.appendChild(sel);

  body.append(el('div', 'k', 'Owner'), el('div', 'v', r.assigned_to || 'Unassigned'));
  const oacts = el('div', 'acts');
  if ((r.assigned_to || '').toLowerCase() !== operator.toLowerCase()) {
    const mine = el('button', 'btn small', 'Assign to me');
    mine.onclick = () => runAction(mine, { action: 'request_assign', ticket_ref: r.ticket_ref, assignee: operator }, 'Assigned to you.');
    oacts.appendChild(mine);
  }
  if (r.assigned_to) {
    const un = el('button', 'btn small', 'Unassign');
    un.onclick = () => runAction(un, { action: 'request_assign', ticket_ref: r.ticket_ref, clear: true }, 'Owner removed.');
    oacts.appendChild(un);
  }
  body.appendChild(oacts);

  if (!['resolved', 'closed'].includes(r.status)) {
    const done = el('button', 'btn primary', 'Mark resolved');
    done.style.marginTop = '12px';
    done.style.width = '100%';
    done.onclick = () => modalResolveRequest(r);
    body.appendChild(done);
  } else if (r.resolution_note) {
    body.append(el('div', 'k', 'Resolution'), el('div', 'v', r.resolution_note));
    if (r.resolved_by) body.appendChild(el('div', 'sub', `by ${r.resolved_by}`));
  }

  card.appendChild(body);
  side.appendChild(card);

  ws.append(main, side);
  root.appendChild(ws);
}

function modalResolveRequest(r) {
  const wrap = el('div');
  wrap.appendChild(el('div', 'sub', 'What you write is sent to the client in their chat.'));
  const ta = el('textarea');
  ta.placeholder = 'Called and confirmed the sailing date. Nothing further needed.';
  wrap.appendChild(ta);
  const preview = el('div', 'preview');
  const paint = () => { preview.textContent = `✅ ${r.ticket_ref} — ${ta.value || '…'}`; };
  ta.oninput = paint;
  paint();
  wrap.appendChild(preview);

  modal({
    title: 'Resolve this request',
    body: wrap,
    confirmLabel: 'Resolve & tell the client',
    onConfirm: async () => {
      if (!ta.value.trim()) { toast('Say what was done.', true); throw new Error('empty'); }
      await post({ action: 'request_resolve', ticket_ref: r.ticket_ref, note: ta.value.trim() });
      toast('Resolved. The client has been told.');
      await render();
    },
  });
}

// ---------------------------------------------------------------------------
// Shipments
// ---------------------------------------------------------------------------

async function pageShipments(root) {
  const filter = route.filter || 'active';
  const bar = el('div', 'filters');
  for (const [key, label] of [['active', 'In progress'], ['delivered', 'Delivered'], ['all', 'All']]) {
    const b = el('button', 'fchip', label);
    b.setAttribute('aria-pressed', String(key === filter));
    b.onclick = () => { location.hash = `#/shipments/${key}`; };
    bar.appendChild(b);
  }
  root.appendChild(bar);

  const host = el('div');
  host.appendChild(skeleton(7));
  root.appendChild(host);

  let data;
  try {
    data = await api(`view=shipments&filter=${encodeURIComponent(filter)}`);
  } catch {
    host.replaceChildren(errorState('We could not load shipments.', render));
    return;
  }

  if (!data.rows.length) {
    host.replaceChildren(emptyState('No shipments here', 'Confirming a booking opens one automatically.'));
    return;
  }

  const wrap = el('div', 'tablewrap');
  const t = el('table', 'ops');
  t.innerHTML = '<thead><tr>'
    + '<th>Shipment</th><th>Booking</th><th>Chassis</th><th>Client</th><th>Route</th>'
    + '<th>Status</th><th>Vessel</th><th>ETD</th><th>ETA</th><th>Updated</th>'
    + '</tr></thead>';
  const tb = el('tbody');
  for (const s of data.rows) {
    const tr = el('tr');
    tr.onclick = () => { location.hash = `#/shipment/${s.shipment_id}`; };
    // A value the database does not hold says so. Never a blank, never a guess.
    tr.append(
      cell(el('span', 'mono', s.shipment_id)),
      cell(s.booking_ref ? el('span', 'mono', s.booking_ref.replace(/^MKY-BKG-/, '')) : el('span', 'sub', '—')),
      cell(el('span', 'mono', s.vin || '—')),
      cell(el('span', null, s.customer_name || '—')),
      cell(el('span', 'sub', `${s.origin_port} → ${s.destination_port}`)),
      cell(chip(s.status || 'Not started', shipmentTone(s.status))),
      cell(el('span', s.vessel ? null : 'sub', s.vessel || 'Not assigned yet')),
      cell(el('span', s.etd ? null : 'sub', s.etd || '—')),
      cell(el('span', s.eta ? null : 'sub', s.eta || 'Not available yet')),
      cell(el('span', 'sub', humanAge(s.updated_at))),
    );
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  wrap.appendChild(t);
  host.replaceChildren(wrap);
}

async function pageShipment(root, id) {
  root.appendChild(skeleton(6));
  let data;
  try {
    data = await api(`view=shipment&id=${encodeURIComponent(id)}`);
  } catch (e) {
    root.replaceChildren(errorState(e.message || 'We could not load this shipment.', render));
    return;
  }
  root.replaceChildren();
  const s = data.shipment;

  const head = el('div', 'bkhead');
  const row1 = el('div', 'row1');
  row1.append(el('h1', null, s.shipment_id), chip(s.status || 'Not started', shipmentTone(s.status)));
  head.appendChild(row1);
  const meta = el('div', 'meta');
  meta.append(
    kv('Chassis', s.vin),
    kv('Client', s.customer_name),
    kv('Route', `${s.origin_port} → ${s.destination_port}`),
    kv('Vessel', s.vessel || 'Not assigned yet'),
    kv('ETA', s.eta || 'Not available yet'),
  );
  head.appendChild(meta);
  if (s.booking_ref) {
    const a = el('a', null, `Open booking ${s.booking_ref}`);
    a.href = `#/booking/${s.booking_ref}`;
    head.appendChild(a);
  }
  root.appendChild(head);

  const ws = el('div', 'workspace');
  const main = el('div');
  const side = el('div', 'side');

  const tl = el('div', 'card');
  tl.appendChild(el('h2', null, 'Timeline'));
  const tbody = el('div', 'body');
  if (!data.events.length) tbody.appendChild(el('div', 'sub', 'Nothing recorded yet.'));
  const ul = el('ul', 'timeline');
  for (const e of data.events) {
    const li = el('li');
    li.append(el('time', null, new Date(e.event_time).toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })));
    const txt = el('span', null, e.description + (e.location ? ` — ${e.location}` : ''));
    if (e.operator) txt.appendChild(el('span', 'sub', ` (${e.operator})`));
    li.appendChild(txt);
    ul.appendChild(li);
  }
  tbody.appendChild(ul);
  tl.appendChild(tbody);
  main.appendChild(tl);

  const upd = el('div', 'card');
  upd.appendChild(el('h2', null, 'Record an update'));
  const ub = el('div', 'body');
  const field = (label, node) => { ub.append(el('div', 'k', label), node); return node; };

  const st = el('select');
  // A seeded or historic status that is not one of our milestones gets its own
  // option, or the browser silently selects the first one and an operator
  // saving a note would rewind a truck in customs back to "awaiting cargo".
  const known = data.milestones.includes(s.status);
  for (const m of (known ? data.milestones : [s.status, ...data.milestones])) {
    const o = el('option', null, m);
    o.value = m;
    if (m === s.status) o.selected = true;
    st.appendChild(o);
  }
  field('Status', st);

  const loc = el('input'); loc.type = 'text'; loc.placeholder = 'Port Said';
  field('Location (added to the timeline)', loc);
  const vessel = el('input'); vessel.type = 'text'; vessel.value = s.vessel || '';
  field('Vessel', vessel);
  const etd = el('input'); etd.type = 'date'; etd.value = s.etd || '';
  field('ETD', etd);
  const eta = el('input'); eta.type = 'date'; eta.value = s.eta || '';
  field('ETA', eta);
  const note = el('textarea');
  note.placeholder = 'What changed — in the client’s words if it is going to them.';
  field('Note', note);

  // Not every internal correction is worth a message. The client is told only
  // when somebody decides they should be.
  const tell = el('label');
  tell.style.cssText = 'display:flex;gap:8px;align-items:center;margin:12px 0;font-size:13.5px';
  const cb = el('input'); cb.type = 'checkbox';
  tell.append(cb, document.createTextNode('Tell the client about this update'));
  ub.appendChild(tell);

  const save = el('button', 'btn primary', 'Save update');
  save.onclick = () => runAction(save, {
    action: 'shipment_update',
    shipment_id: s.shipment_id,
    status: st.value,
    location: loc.value.trim(),
    vessel: vessel.value.trim(),
    etd: etd.value || '',
    eta: eta.value || '',
    note: note.value.trim(),
    tell_customer: cb.checked,
  }, cb.checked ? 'Updated, and the client is being told.' : 'Updated.');
  ub.appendChild(save);

  upd.appendChild(ub);
  side.appendChild(upd);

  ws.append(main, side);
  root.appendChild(ws);
}
