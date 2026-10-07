/**
 * Shipments - confirmed bookings on their way. Change the status, the arrival
 * date or add an event; "Tell the customer" is on by default and shows the
 * exact message before anything is saved, because the commonest question a
 * forwarding desk gets is "where is my truck", and the cheapest answer is the
 * one sent before they ask.
 */

import {
  h, clear, icon, api, post, newKey, toast, chip, channelBadge, timeEl, when, emptyState, errorState, skeleton, debounce, add, fill,
} from './ui.js';
import { previewBox } from './preview.js';
import { linkFor } from './inbox.js';

const FILTERS = [['active', 'On the way'], ['delivered', 'Delivered'], ['all', 'All']];

export function renderShipments(ctx) {
  const [id] = ctx.route.parts;
  return id ? renderShipment(ctx, id) : renderList(ctx);
}

function renderList({ route, main }) {
  const filter = FILTERS.some(([k]) => k === route.query.filter) ? route.query.filter : 'active';
  let q = '';
  const listEl = h('div', { class: 'list-wrap' }, skeleton(6));
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Find by shipment, booking, customer or chassis', 'aria-label': 'Find a shipment' });

  add(main, 
    h('div', { class: 'page-head' }, h('div', {},
      h('h1', {}, 'Shipments'),
      h('p', { class: 'page-sub' }, 'Confirmed bookings on their way. Open one to update it and tell the customer.'))),
    h('div', { class: 'toolbar' },
      h('nav', { class: 'tabs', 'aria-label': 'Which shipments' }, FILTERS.map(([k, label]) => h('a', {
        class: 'tab', href: `#/shipments?filter=${k}`, 'aria-current': k === filter ? 'page' : null,
      }, label))),
      search),
    listEl);

  async function load({ quiet = false } = {}) {
    let data;
    try {
      data = await api({ view: 'shipments', filter, q });
    } catch (err) {
      if (!quiet) fill(listEl, errorState(err.message, () => load()));
      return;
    }
    clear(listEl);
    if (!data.rows.length) {
      add(listEl, emptyState(q ? 'No shipment matches that.' : filter === 'delivered' ? 'Nothing delivered yet.' : 'No shipments on the way.',
        q ? null : 'A shipment opens when a booking is confirmed.'));
      return;
    }
    add(listEl, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {},
        ['Shipment', 'Customer', 'Vehicle', 'Route', 'Status', 'Arrives', 'Updated'].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, data.rows.map((s) => h('tr', {},
        // The link stretches over its row: the whole row opens the shipment.
        h('td', { 'data-label': 'Shipment' }, h('a', { href: linkFor({ type: 'shipment', id: s.shipment_id }), class: 'mono strong stretch' }, s.shipment_id)),
        h('td', { 'data-label': 'Customer' }, h('bdi', {}, s.customer_name ?? '—'), ' ', channelBadge(s.channel, { compact: true })),
        h('td', { 'data-label': 'Vehicle' }, s.vehicle ?? '—', s.vin ? h('div', { class: 'mono muted small' }, s.vin) : null),
        h('td', { 'data-label': 'Route' }, s.route),
        h('td', { 'data-label': 'Status' }, chip(s.status, s.tone)),
        h('td', { 'data-label': 'Arrives' }, s.eta ?? '—'),
        h('td', { 'data-label': 'Updated' }, timeEl(s.updated_at))))))));
  }

  search.addEventListener('input', debounce(() => { q = search.value.trim(); load(); }, 300));
  load();
  return { refresh: () => load({ quiet: true }) };
}

function renderShipment({ main }, id) {
  let data = null;
  const root = h('div', { class: 'shipment' }, skeleton(8));
  add(main, root);

  async function load({ quiet = false } = {}) {
    let fresh;
    try {
      fresh = await api({ view: 'shipment', id });
    } catch (err) {
      if (!quiet) fill(root, errorState(err.message, err.status === 404 ? null : () => load()));
      return;
    }
    if (data && fresh.version === data.version) return;
    const editing = data && root.querySelector('.ship-form')?.dataset.dirty === '1';
    data = fresh;
    // Do not pull a half-filled form out from under somebody; say it changed.
    if (editing) { toast('This shipment was just updated by someone else. Your form is kept; saving will show what changed.', 'info'); return; }
    draw();
  }

  function draw() {
    const s = data.shipment;
    fill(root, 
      h('a', { class: 'back', href: '#/shipments' }, icon('back', { size: 16 }), 'Shipments'),
      h('header', { class: 'case-head' },
        h('div', { class: 'case-title-row' }, h('h1', { class: 'case-ref' }, s.shipment_id), chip(s.status, s.tone)),
        h('p', { class: 'case-facts' },
          h('bdi', {}, s.customer_name), ' · ', [s.make, s.model].filter(Boolean).join(' ') || 'Vehicle', s.vin ? [' · ', h('span', { class: 'mono' }, s.vin)] : null,
          ` · ${s.origin_port} → ${s.destination_port}`,
          s.booking_ref ? [' · ', h('a', { href: linkFor({ type: 'booking', ref: s.booking_ref }) }, s.booking_ref)] : null)),
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
      h('div', { class: 'card-head' }, h('h2', {}, 'Update the shipment')),
      !can ? h('p', { class: 'reason' }, data.update_reason) : null,
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
        toast(err.message, 'bad');
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
      h('div', { class: 'card-head' }, h('h2', {}, 'History')),
      list.length ? h('ol', { class: 'timeline' }, list.map((e) => h('li', {},
        timeEl(e.at, when(e.at)),
        h('span', {}, h('bdi', { dir: 'auto' }, e.description), e.location ? h('span', { class: 'muted' }, ` · ${e.location}`) : null,
          e.operator ? h('span', { class: 'muted' }, ` · ${e.operator}`) : null))))
        : h('p', { class: 'muted' }, 'Nothing recorded yet.'));
  }

  load();
  return { refresh: () => load({ quiet: true }) };
}

const field = (label, input, id) => h('div', { class: 'field' }, h('label', { class: 'label', for: id }, label), input);
