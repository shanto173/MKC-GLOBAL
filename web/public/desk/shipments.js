/**
 * Shipments - confirmed bookings on their way. Change the status, the arrival
 * date or add an event; "Tell the customer" is on by default and shows the
 * exact message before anything is saved, because the commonest question a
 * forwarding desk gets is "where is my truck", and the cheapest answer is the
 * one sent before they ask.
 */

import {
  h, clear, icon, api, post, newKey, toast, toastError, badge, channelIcon, timeEl, ago, when, emptyState, errorState, skeleton, debounce, add, fill,
  VIEW_SCOPES, scopesOf,
} from './ui.js';
import { previewBox } from './preview.js';
import { linkFor } from './inbox.js';

const FILTERS = [['active', 'On the way'], ['delivered', 'Delivered'], ['all', 'All']];
const DAY = 86400_000;

/**
 * The arrival date as a person says it: "13 Oct", "in 5 d", "today" - and,
 * when the date has passed and the shipment is not delivered, a red "Late"
 * badge with how late. Calendar days in the browser's time zone.
 */
const ARRIVED = /arrived|clearance|cleared|released|out for delivery|delivered/i;
export function etaParts(eta, tone, now = new Date(), status = '') {
  if (!eta) return null;
  const d = new Date(`${eta}T00:00:00`);
  if (Number.isNaN(d.getTime())) return { date: eta, rel: '', late: 0 };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((d - today) / DAY);
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  const done = tone === 'green';
  // Once it has arrived, the arrival date is history, not a promise that can be late.
  if (ARRIVED.test(status) && !done) return { date, rel: 'arrived', late: 0 };
  const rel = done ? '' : days === 0 ? 'today' : days === 1 ? 'tomorrow' : days > 1 ? `in ${days} d` : `${-days} d ago`;
  return { date, rel, late: !done && days < 0 ? -days : 0 };
}

export function renderShipments(ctx) {
  const [id] = ctx.route.parts;
  return id ? renderShipment(ctx, id) : renderList(ctx);
}

function renderList({ route, main, signal = null }) {
  const filter = FILTERS.some(([k]) => k === route.query.filter) ? route.query.filter : 'active';
  let q = '';
  const listEl = h('div', { class: 'list-wrap' }, skeleton(6, { kind: 'rows' }));
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Shipment, booking, customer, chassis or vessel', 'aria-label': 'Find a shipment' });
  const count = h('span', { class: 'page-meta', 'aria-live': 'polite' });
  const filtersEl = h('nav', { class: 'seg', 'aria-label': 'Which shipments' });

  /** The filter, each item with how many it holds - the server counts all three, whichever is shown. */
  const drawFilters = (counts = null) => fill(filtersEl, ...FILTERS.map(([k, label]) => {
    const n = counts?.[k];
    return h('a', {
      class: `seg-item${n === 0 ? ' is-zero' : ''}`, href: `#/shipments?filter=${k}`, 'aria-current': k === filter ? 'page' : null,
      'aria-label': n == null ? null : `${label}, ${n}`,
    }, label, n == null ? null : h('span', { class: 'seg-count', 'aria-hidden': 'true' }, String(n)));
  }));
  drawFilters();

  add(main,
    h('div', { class: 'page-head' }, h('div', {},
      h('h1', {}, 'Shipments'),
      h('p', { class: 'page-sub' }, 'Confirmed bookings on their way. Open one to update it and tell the customer.')), count),
    h('div', { class: 'ship-bar' },
      filtersEl,
      h('label', { class: 'search-field' }, icon('search', { size: 16 }), search)),
    listEl);

  // A page at a time: the first page is fetched again when something
  // changes; "Show more" adds the page after the last row shown, by its
  // place in the order (the server's cursor), not by an offset that shifts
  // when a shipment above it is updated.
  const PAGE = 100;
  const MAX_FIRST = 300;
  let rows = [];
  let next = null;
  let counts = null;
  let first = null;      // the first page's answer, as last drawn: a 304 hands back the same one

  /** Loads the first page; false when it could not. */
  async function load({ quiet = false } = {}) {
    let data;
    try {
      data = await api({ view: 'shipments', filter, q, limit: Math.min(MAX_FIRST, Math.max(PAGE, rows.length)) }, { signal });
    } catch (err) {
      if (err.aborted) return false;
      if (!quiet) fill(listEl, errorState(err, () => load()));
      return false;
    }
    if (data === first) return true;
    first = data;
    counts = data.counts ?? counts;
    // Rows paged in beyond the first page are kept after it, once each.
    const seen = new Set(data.rows.map((s) => s.shipment_id));
    const beyond = rows.length > data.rows.length ? rows.slice(data.rows.length).filter((s) => !seen.has(s.shipment_id)) : [];
    rows = [...data.rows, ...beyond];
    if (!beyond.length) next = data.next ?? null;
    draw();
    return true;
  }

  async function more(button) {
    if (!next) return;
    button.disabled = true;
    let data;
    try {
      data = await api({ view: 'shipments', filter, q, limit: PAGE, after: next }, { signal });
    } catch (err) {
      if (!err.aborted) toastError(err);
      button.disabled = false;
      return;
    }
    const seen = new Set(rows.map((s) => s.shipment_id));
    rows = [...rows, ...data.rows.filter((s) => !seen.has(s.shipment_id))];
    next = data.next ?? null;
    draw();
  }

  function draw() {
    drawFilters(counts);
    const total = q ? null : counts?.[filter];
    count.textContent = total != null && total > rows.length
      ? `${rows.length} of ${total} shipments`
      : `${rows.length} shipment${rows.length === 1 ? '' : 's'}${q ? ' found' : ''}`;
    clear(listEl);
    if (!rows.length) {
      add(listEl, emptyState(q ? 'No shipment matches that.' : filter === 'delivered' ? 'Nothing delivered yet.' : 'No shipments on the way.',
        q ? 'Try the last six characters of the chassis, or the booking reference.' : 'A shipment opens when a booking is confirmed.', null,
        { icon: q ? 'search' : 'ship' }));
      return;
    }
    add(listEl, h('div', { class: 'table-wrap' }, h('table', { class: 'table table-hover' },
      h('thead', {}, h('tr', {},
        ['Shipment', 'Customer', 'Vehicle', 'Route and vessel', 'Status', 'Arrives', 'Updated'].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, rows.map((s) => {
        const eta = etaParts(s.eta, s.tone, new Date(), s.status);
        return h('tr', {},
          // The link stretches over its row: the whole row opens the shipment.
          h('td', { 'data-label': 'Shipment' }, h('a', { href: linkFor({ type: 'shipment', id: s.shipment_id }), class: 'ship-id stretch', title: s.booking_ref ? 'Booking ' + s.booking_ref : null }, s.shipment_id)),
          h('td', { 'data-label': 'Customer' }, h('span', { class: 'row-name' }, s.channel ? channelIcon(s.channel, 14) : null, h('bdi', {}, s.customer_name ?? '—'))),
          h('td', { 'data-label': 'Vehicle' }, s.vehicle ?? '—', s.vin ? h('span', { class: 'cell-sub mono' }, s.vin) : null),
          h('td', { 'data-label': 'Route' }, s.route, h('span', { class: 'cell-sub' }, icon('ship', { size: 12 }), ' ', s.vessel ?? 'No vessel yet')),
          h('td', { 'data-label': 'Status' }, badge(s.status, s.tone)),
          h('td', { 'data-label': 'Arrives' }, eta
            ? h('span', { class: 'eta' }, h('span', { class: 'eta-date' }, eta.date),
              eta.late ? badge(`Late ${eta.late} d`, 'red', { small: true }) : eta.rel ? h('span', { class: 'eta-rel' }, eta.rel) : null)
            : h('span', { class: 'muted' }, 'Not set')),
          h('td', { 'data-label': 'Updated', class: 'muted' }, timeEl(s.updated_at, ago(s.updated_at))));
      })))));
    if (next) {
      const button = h('button', { class: 'btn', type: 'button' }, 'Show more');
      button.addEventListener('click', () => more(button));
      add(listEl, h('div', { class: 'more' }, button));
    }
  }

  search.addEventListener('input', debounce(() => { q = search.value.trim(); rows = []; next = null; first = null; load(); }, 300));
  load();
  return { refresh: () => load({ quiet: true }), scopes: VIEW_SCOPES.shipments };
}

function renderShipment({ main, signal = null }, id) {
  let data = null;
  const root = h('div', { class: 'shipment' }, skeleton(6, { kind: 'cards' }));
  add(main, root);

  /** Loads the shipment; false when it could not. */
  async function load({ quiet = false } = {}) {
    let fresh;
    try {
      fresh = await api({ view: 'shipment', id }, { signal });
    } catch (err) {
      if (err.aborted) return false;
      if (!quiet) fill(root, errorState(err, err.status === 404 || err.status === 403 ? null : () => load()));
      return false;
    }
    if (data && fresh.version === data.version) return true;
    const editing = data && root.querySelector('.ship-form')?.dataset.dirty === '1';
    data = fresh;
    // Do not pull a half-filled form out from under somebody; say it changed.
    if (editing) { toast('This shipment was just updated by someone else. Your form is kept; saving will show what changed.', 'info'); return true; }
    draw();
    return true;
  }

  function draw() {
    const s = data.shipment;
    const eta = etaParts(s.eta, s.tone, new Date(), s.status);
    const facts = [
      h('bdi', {}, s.customer_name),
      [s.make, s.model].filter(Boolean).join(' ') || 'Vehicle',
      s.vin ? h('span', { class: 'mono' }, s.vin) : null,
      `${s.origin_port} → ${s.destination_port}`,
      s.vessel ? `Vessel ${s.vessel}` : null,
      eta ? `Arrives ${eta.date}${eta.rel ? ` (${eta.rel})` : ''}` : null,
      s.booking_ref ? h('a', { href: linkFor({ type: 'booking', ref: s.booking_ref }) }, s.booking_ref) : null,
    ].filter(Boolean);
    fill(root,
      h('header', { class: 'shipment-head' },
        h('a', { class: 'back', href: '#/shipments' }, icon('back', { size: 16 }), 'Shipments'),
        h('div', { class: 'case-title-row' }, h('h1', { class: 'case-ref' }, s.shipment_id), badge(s.status, s.tone),
          eta?.late ? badge(`Late ${eta.late} d`, 'red') : null),
        h('p', { class: 'case-facts' }, facts.flatMap((f, i) => (i ? [h('span', { class: 'dot', 'aria-hidden': 'true' }, '·'), f] : [f])))),
      h('div', { class: 'case-grid case-grid-even' },
        h('div', { class: 'case-main' }, form(s)),
        h('div', { class: 'case-main' }, events())));
  }

  function form(s) {
    const can = data.can_update;
    const status = h('select', { class: 'input', id: 'ship-status', disabled: !can },
      data.milestones.map((m) => h('option', { value: m, selected: m === s.status }, m)));
    const eta = h('input', { class: 'input', id: 'ship-eta', type: 'date', value: s.eta ?? '', disabled: !can });
    const vessel = h('input', { class: 'input', id: 'ship-vessel', value: s.vessel ?? '', disabled: !can });
    const location = h('input', { class: 'input', id: 'ship-location', placeholder: 'e.g. Port Said', disabled: !can });
    const note = h('textarea', { class: 'input', id: 'ship-note', rows: '2', dir: 'auto', disabled: !can, placeholder: 'What happened, in a sentence the customer understands' });
    const tell = h('input', { type: 'checkbox', id: 'ship-tell', checked: true, disabled: !can });
    const customer = data.customer;

    const pv = previewBox(() => (tell.checked ? {
      kind: 'shipment_update', shipment_id: s.shipment_id,
      status: status.value !== s.status ? status.value : '', eta: eta.value !== (s.eta ?? '') ? eta.value : '', note: note.value.trim(),
    } : null), { empty: 'The customer will not be told.' });

    const el = h('form', { class: 'card ship-form', novalidate: true },
      h('div', { class: 'card-head' }, h('h2', {}, icon('ship', { size: 16 }), 'Update the shipment')),
      !can ? h('div', { class: 'banner banner-gray', style: { marginBottom: '16px' } }, icon('lock', { size: 15 }), h('p', {}, data.update_reason)) : null,
      h('div', { class: 'form-grid' },
        field('Status', status, 'ship-status'),
        field('Estimated arrival', eta, 'ship-eta'),
        field('Vessel', vessel, 'ship-vessel'),
        field('Where (for the history)', location, 'ship-location')),
      field('Note', note, 'ship-note'),
      h('label', { class: 'check', for: 'ship-tell' }, tell, h('span', {},
        'Tell the customer', h('span', { class: 'muted small' }, customer?.channel ? ` · on ${customer.channel === 'whatsapp' ? 'WhatsApp' : 'Telegram'}` : ' · no chat linked'))),
      pv.el,
      h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit', disabled: !can }, 'Save update')));

    let key = newKey();
    for (const input of [status, eta, vessel, location, note, tell]) {
      input.addEventListener('input', () => { el.dataset.dirty = '1'; key = newKey(); pv.update(); });
      input.addEventListener('change', () => { el.dataset.dirty = '1'; pv.update(); });
    }
    el.addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = el.querySelector('button[type=submit]');
      const body = {
        action: 'shipment_update', shipment_id: s.shipment_id, version: data.version, action_key: key,
        ...(status.value !== s.status ? { status: status.value } : {}),
        ...(eta.value !== (s.eta ?? '') ? { eta: eta.value } : {}),
        ...(vessel.value.trim() !== (s.vessel ?? '') ? { vessel: vessel.value.trim() } : {}),
        ...(location.value.trim() ? { location: location.value.trim() } : {}),
        note: note.value.trim(),
        tell_customer: tell.checked,
      };
      button.disabled = true;
      button.textContent = 'Saving…';
      try {
        const r = await post(body);
        if (r.unchanged) toast('Nothing changed, so nothing was saved.', 'info');
        else if (!tell.checked) toast('Saved.');
        else if (r.customer_told?.ok) toast('Saved, and the customer was told.');
        else toast(`Saved, but the customer was NOT told: ${r.customer_told?.words ?? 'no chat to send to.'}`, 'bad', { timeout: 15000 });
        data = null;
        await load();
      } catch (err) {
        if (err.data?.stale) { toast(err.message, 'info'); data = null; await load(); return; }
        toastError(err);
      } finally {
        if (button.isConnected) { button.disabled = !can; button.textContent = 'Save update'; }
      }
    });
    pv.now();
    return el;
  }

  function events() {
    const list = data.events ?? [];
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, icon('clock', { size: 16 }), 'History')),
      list.length ? h('ol', { class: 'timeline' }, list.map((e) => h('li', {},
        timeEl(e.at, when(e.at)),
        h('span', {}, h('bdi', { dir: 'auto' }, e.description), e.location ? h('span', { class: 'muted' }, ` · ${e.location}`) : null,
          e.operator ? h('span', { class: 'muted' }, ` · ${e.operator}`) : null))))
        : h('p', { class: 'muted' }, 'Nothing recorded yet.'));
  }

  load();
  return { refresh: () => load({ quiet: true }), scopes: scopesOf('shipment', { id }) };
}

const field = (label, input, id) => h('div', { class: 'field' }, h('label', { class: 'label', for: id }, label), input);
