/**
 * The status card pinned at the top of a chat, through its whole life.
 *
 * Booked -> pinned. Shipment moves -> the same message is edited, so nothing
 * new appears in the chat. Delivered -> the card takes itself away. Booked
 * again -> it comes back.
 *
 * This talks to the real Telegram API, so it needs a chat the bot can write to:
 *
 *   npm run pintest -- <chat_id>
 *
 * Everything it creates in the chat and in the database is removed at the end.
 */

import 'dotenv/config';

const chatId = process.argv[2];
if (!chatId) {
  console.error('Usage: npm run pintest -- <chat_id>   (find yours with npm run chatid)');
  process.exit(1);
}

const { db } = await import('../lib/supabase.js');
const { refreshPin } = await import('../lib/pinned.js');
const { pinnedMessage, deleteMessageQuietly, unpinMessage } = await import('../lib/telegram.js');
const { createShipmentFromBooking, updateShipmentStatus } = await import('../lib/shipments.js');

const stamp = Date.now().toString(36).toUpperCase();
const ref = `TEST-PIN-${stamp}`;
const vin = `TESTPIN${stamp}`;

const problems = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' -> ' + detail}`);
  if (!ok) problems.push(name);
};

/**
 * Telegram takes a moment to report a newly pinned message, so a read straight
 * after pinning can come back empty. Ask again rather than call it a failure.
 */
const pinnedNow = async (expect = null) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const p = (await pinnedMessage(chatId)) ?? {};
    if (p.messageId && (!expect || p.text?.includes(expect))) return p;
    await new Promise((r) => setTimeout(r, 700));
  }
  return (await pinnedMessage(chatId)) ?? {};
};

console.log(`chat ${chatId}, booking ${ref}\n`);

// Start from a known state: a card left pinned by an earlier run would make the
// first refresh an edit rather than a fresh pin, which is correct behaviour but
// not what this test is measuring.
const before = (await pinnedMessage(chatId)) ?? {};
if (before.messageId && before.mine && before.text?.startsWith('📌')) {
  await unpinMessage(chatId, before.messageId);
  await deleteMessageQuietly(chatId, before.messageId);
  console.log('cleared a card left over from an earlier run');
} else {
  console.log('pinned before:', before.messageId ?? 'nothing');
}

// --- a booking is made ------------------------------------------------------
console.log('\na booking is made');
await db().from('bookings').insert({
  booking_ref: ref,
  channel: 'telegram',
  chat_id: String(chatId),
  customer_name: 'Pin Test',
  customer_contact: `pin-${stamp}@example.invalid`,
  origin_country: 'Lithuania',
  origin_port: 'Vilnius',
  destination_port: 'Alexandria Port (incl. El Dekheila)',
  cargo_description: 'Mercedes-Benz Actros 1845',
  vin,
  make: 'Mercedes-Benz',
  model: 'Actros 1845',
  incoterm: 'FOB',
  status: 'pending_review',
});

const first = await refreshPin(chatId);
check('a card is pinned', first.action === 'pinned', JSON.stringify(first));
const afterBooking = await pinnedNow(ref);
check('it is the message Telegram reports as pinned', Boolean(afterBooking.messageId), JSON.stringify(afterBooking).slice(0, 120));
check('it shows the booking', afterBooking.text?.includes(ref), (afterBooking.text ?? '').slice(0, 160));
check('and says it is waiting', /Awaiting confirmation/i.test(afterBooking.text ?? ''), (afterBooking.text ?? '').slice(0, 160));

// --- Operations confirms, the shipment opens --------------------------------
console.log('\nOperations confirms it');
const { data: booking } = await db().from('bookings').select('*').eq('booking_ref', ref).maybeSingle();
await db().from('bookings').update({ status: 'confirmed' }).eq('booking_ref', ref);
const opened = await createShipmentFromBooking({ ...booking, status: 'confirmed' }, { operator: 'pin test' });
check('a shipment is open', opened.ok === true, JSON.stringify(opened));

const second = await refreshPin(chatId);
check('the same card is edited, not a new one', second.action === 'edited', JSON.stringify(second));
const afterOpen = await pinnedNow(opened.shipment_id);
check('the pinned message id did not change', afterOpen.messageId === afterBooking.messageId, `${afterBooking.messageId} -> ${afterOpen.messageId}`);
check('it now shows the shipment', afterOpen.text?.includes(opened.shipment_id), (afterOpen.text ?? '').slice(0, 200));

// --- it moves ---------------------------------------------------------------
console.log('\nthe vessel sails');
await updateShipmentStatus(opened.shipment_id, { status: 'Loaded on vessel', vessel: 'MSC Aurora V.238W', eta: '2026-11-12' }, { operator: 'pin test' });
const third = await refreshPin(chatId);
check('edited again in place', third.action === 'edited', JSON.stringify(third));
const moving = await pinnedNow('Loaded on vessel');
check('the new status is on the card', /Loaded on vessel/i.test(moving.text ?? ''), (moving.text ?? '').slice(0, 200));
check('with the vessel and the ETA', /MSC Aurora/.test(moving.text ?? '') && /2026-11-12/.test(moving.text ?? ''), (moving.text ?? '').slice(0, 220));

// --- delivered --------------------------------------------------------------
console.log('\nit is delivered');
await updateShipmentStatus(opened.shipment_id, { status: 'Delivered', delivery_status: 'Complete' }, { operator: 'pin test' });
const gone = await refreshPin(chatId);
check('the card takes itself away', gone.action === 'cleared', JSON.stringify(gone));
const afterDelivery = await pinnedNow();
check('nothing of ours is pinned any more', !afterDelivery.messageId || afterDelivery.messageId !== moving.messageId, JSON.stringify(afterDelivery).slice(0, 120));

// --- and comes back ---------------------------------------------------------
console.log('\nthe customer books again');
await db().from('bookings').insert({
  booking_ref: `${ref}-2`,
  channel: 'telegram',
  chat_id: String(chatId),
  customer_name: 'Pin Test',
  customer_contact: `pin-${stamp}@example.invalid`,
  origin_country: 'Lithuania',
  origin_port: 'Klaipeda',
  destination_port: 'Port Said',
  cargo_description: 'Volvo FH16',
  vin: `${vin}B`,
  make: 'Volvo',
  model: 'FH16',
  status: 'pending_review',
});
const again = await refreshPin(chatId);
check('a fresh card is pinned', again.action === 'pinned', JSON.stringify(again));
const back = await pinnedNow(`${ref}-2`);
check('showing the new booking', back.text?.includes(`${ref}-2`), (back.text ?? '').slice(0, 200));

// --- clean up ---------------------------------------------------------------
if (back.messageId) {
  await unpinMessage(chatId, back.messageId);
  await deleteMessageQuietly(chatId, back.messageId);
}
await db().from('shipment_events').delete().eq('shipment_id', opened.shipment_id);
await db().from('shipments').delete().eq('shipment_id', opened.shipment_id);
await db().from('bookings').delete().in('booking_ref', [ref, `${ref}-2`]);
await db().from('vehicles').delete().in('vin', [vin, `${vin}B`]);

console.log(`\n${problems.length === 0 ? 'all checks pass' : problems.length + ' failed: ' + problems.join(', ')}`);
process.exit(problems.length === 0 ? 0 : 1);
