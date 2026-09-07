/**
 * The operations console, end to end against the real database.
 *
 * Covers the things a console gets wrong quietly: a total that is really just
 * the page size, a decision signed with a name nobody can check, an ETD that
 * was never a departure date, and a field that can be corrected but never
 * emptied. Everything it creates, it removes.
 *
 *   npm run opstest
 */

import 'dotenv/config';

// No mail, no Telegram: this test decides bookings, and a decision writes to
// the customer. Nothing here should reach a real person.
process.env.RESEND_API_KEY = '';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.STAFF_CHAT_ID = '';
process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-secret';

const { db } = await import('../lib/supabase.js');
const bookingsApi = (await import('../api/admin/bookings.js')).default;
const shipmentsApi = (await import('../api/admin/shipments.js')).default;
const usersApi = (await import('../api/admin/users.js')).default;

const SECRET = process.env.ADMIN_SECRET;
const stamp = Date.now().toString(36).toUpperCase();
const chatId = `ops-${stamp}`;
const OPERATOR = `Test Operator ${stamp}`;

const problems = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' -> ' + detail}`);
  if (!ok) problems.push(name);
};

/** Calls a Vercel-style handler and returns { status, body }. */
async function call(handler, { method = 'GET', query = {}, body = null } = {}) {
  const res = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.payload = data; return this; },
    setHeader() { return this; },
    send(data) { this.payload = data; return this; },
    end(data) { this.payload = data ?? this.payload; return this; },
  };
  await handler({ method, query, headers: { 'x-admin-secret': SECRET }, body }, res);
  return { status: res.statusCode, body: res.payload };
}

const booking = (n) => ({
  booking_ref: `TEST-OPS-${stamp}-${n}`,
  channel: 'web',
  chat_id: chatId,
  customer_name: 'Ops Test Customer',
  customer_contact: `ops-${stamp}@example.invalid`,
  origin_country: 'Lithuania',
  origin_port: 'Vilnius',
  destination_port: 'Alexandria Port (incl. El Dekheila)',
  cargo_description: 'Mercedes-Benz Actros 1845',
  vin: `TESTOPS${stamp}${n}`,
  make: 'Mercedes-Benz',
  model: 'Actros 1845',
  incoterm: 'FOB',
  ready_date: '2026-10-15',
  status: 'pending_review',
  raw: { engine_condition: 'damaged engine' },
});

console.log(`operator "${OPERATOR}", chat ${chatId}\n`);
await db().from('bookings').insert([booking(1), booking(2), booking(3)]);

// --- the desk ---------------------------------------------------------------
console.log('who is on the operations desk');
const deskBefore = await call(usersApi);
check('the desk can be listed', deskBefore.status === 200 && Array.isArray(deskBefore.body.users), JSON.stringify(deskBefore.body).slice(0, 160));

// Registering first makes the next check deterministic: an empty desk lets
// anybody through on purpose, so a stranger is only refused once the desk has
// somebody on it.
const added = await call(usersApi, { method: 'POST', body: { name: OPERATOR } });
check('an operator can be added to the desk', added.status === 200 && added.body.user?.name === OPERATOR, JSON.stringify(added.body).slice(0, 160));

const unknown = await call(bookingsApi, {
  method: 'POST',
  body: { booking_ref: `TEST-OPS-${stamp}-1`, action: 'confirm', operator: `Stranger ${stamp}` },
});
check('a name nobody knows cannot decide a booking', unknown.status === 400, `${unknown.status} ${JSON.stringify(unknown.body).slice(0, 160)}`);

const { data: stillPending } = await db().from('bookings').select('status').eq('booking_ref', `TEST-OPS-${stamp}-1`).maybeSingle();
check('and the booking it tried to decide is untouched', stillPending?.status === 'pending_review', JSON.stringify(stillPending));

// --- paging -----------------------------------------------------------------
console.log('\nhow many are waiting');
const page = await call(bookingsApi, { query: { status: 'pending_review', limit: '2' } });
check('a page reports the true total, not its own length', page.body.total >= 3 && page.body.count === 2, JSON.stringify({ count: page.body.count, total: page.body.total }));
check('and says there is more to fetch', page.body.has_more === true, JSON.stringify({ count: page.body.count, total: page.body.total, has_more: page.body.has_more }));

const nextPage = await call(bookingsApi, { query: { status: 'pending_review', limit: '2', offset: '2' } });
const firstRefs = page.body.bookings.map((b) => b.booking_ref);
const secondRefs = nextPage.body.bookings.map((b) => b.booking_ref);
check('the next page is different rows', secondRefs.every((r) => !firstRefs.includes(r)), JSON.stringify({ firstRefs, secondRefs }).slice(0, 200));

// --- confirming -------------------------------------------------------------
console.log('\nconfirming a booking');
const ref = `TEST-OPS-${stamp}-2`;
const decided = await call(bookingsApi, { method: 'POST', body: { booking_ref: ref, action: 'confirm', operator: OPERATOR } });
check('the booking is confirmed', decided.status === 200 && decided.body.ok === true, `${decided.status} ${JSON.stringify(decided.body).slice(0, 200)}`);
check('a shipment was opened', Boolean(decided.body.shipment?.shipment_id), JSON.stringify(decided.body.shipment));

const shipmentId = decided.body.shipment?.shipment_id;
const { data: ship } = await db().from('shipments').select('*').eq('shipment_id', shipmentId ?? '').maybeSingle();
check('ETD is left empty until a sailing is booked', ship?.etd === null, JSON.stringify(ship?.etd));
const { data: events } = await db().from('shipment_events').select('description').eq('shipment_id', shipmentId ?? '');
check('the cargo ready date is recorded as what it is', (events ?? []).some((e) => /cargo ready from 2026-10-15/i.test(e.description)), JSON.stringify(events).slice(0, 200));
const { data: decidedRow } = await db().from('bookings').select('confirmed_by').eq('booking_ref', ref).maybeSingle();
check('the decision carries the desk name', decidedRow?.confirmed_by === OPERATOR, JSON.stringify(decidedRow));

// --- editing a shipment -----------------------------------------------------
console.log('\nsetting and then clearing a value');
const setVessel = await call(shipmentsApi, {
  method: 'POST',
  body: { shipment_id: shipmentId, vessel: 'MSC Aurora V.238W', etd: '2026-11-02', operator: OPERATOR, note: 'Sailing booked' },
});
check('a vessel and a real ETD can be set', setVessel.body.ok === true, JSON.stringify(setVessel.body).slice(0, 200));
const { data: afterSet } = await db().from('shipments').select('vessel, etd').eq('shipment_id', shipmentId).maybeSingle();
check('both were stored', afterSet?.vessel === 'MSC Aurora V.238W' && afterSet?.etd === '2026-11-02', JSON.stringify(afterSet));

const clearVessel = await call(shipmentsApi, {
  method: 'POST',
  body: { shipment_id: shipmentId, vessel: null, eta: '', operator: OPERATOR, note: 'Vessel cancelled' },
});
check('clearing is accepted', clearVessel.body.ok === true, JSON.stringify(clearVessel.body).slice(0, 200));
const { data: afterClear } = await db().from('shipments').select('vessel, etd').eq('shipment_id', shipmentId).maybeSingle();
check('the vessel is gone', afterClear?.vessel === null, JSON.stringify(afterClear?.vessel));
check('and an untouched field is untouched', afterClear?.etd === '2026-11-02', JSON.stringify(afterClear?.etd));

const strangerEdit = await call(shipmentsApi, {
  method: 'POST',
  body: { shipment_id: shipmentId, vessel: 'Ghost Ship', operator: 'Somebody Nobody Knows' },
});
check('an unknown name cannot edit a shipment', strangerEdit.status === 400, `${strangerEdit.status} ${JSON.stringify(strangerEdit.body).slice(0, 160)}`);

// --- cleanup ----------------------------------------------------------------
if (shipmentId) {
  await db().from('shipment_events').delete().eq('shipment_id', shipmentId);
  await db().from('shipments').delete().eq('shipment_id', shipmentId);
}
await db().from('bookings').delete().eq('chat_id', chatId);
await db().from('ops_users').delete().eq('name', OPERATOR);

console.log(`\n${problems.length === 0 ? 'all checks pass' : problems.length + ' failed: ' + problems.join(', ')}`);
process.exit(problems.length === 0 ? 0 : 1);
