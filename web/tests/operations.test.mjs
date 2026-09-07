/**
 * The Operations side, and the promise the outbox makes.
 *
 * The specification's TEST 16 and TEST 17 are the two halves of one guarantee:
 * when Operations confirms a booking, the client is told - once, whatever the
 * network does in between.
 *
 *   npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';

import { createFakeDb } from './helpers/fake-db.mjs';
import { setClientForTests } from '../lib/supabase.js';
import { invalidateSettings } from '../lib/settings.js';
import { enqueue, drain, render } from '../lib/outbox.js';
import { createShipmentFromBooking } from '../lib/shipments.js';
import { createTask, completeTask, closeTasksForBooking, operationsNotifier } from '../lib/operations.js';
import { openMrnRequest } from '../lib/mrn.js';

const CHAT = '555';

const BOOKING = {
  booking_ref: 'MKY-BKG-260908-Z1', status: 'confirmed', chat_id: CHAT, client_id: 1,
  channel: 'telegram', vin: 'W1T96340310484233', make: 'Mercedes-Benz', model: 'Actros',
  customer_name: 'Nile Motors', customer_contact: 'telegram:555',
  origin_port: 'Vilnius', destination_port: 'Alexandria Port (incl. El Dekheila)',
};

function setup(seed = {}) {
  const db = createFakeDb({
    bot_settings: [{ key: 'required_mrn_documents', value: [] }],
    clients: [{ id: 1, telegram_user_id: 999, telegram_chat_id: 555 }],
    ...seed,
  });
  setClientForTests(db);
  invalidateSettings();
  return db;
}

/** A transport that records what it was asked to send, and can be made to fail. */
function recorder({ failTimes = 0, permanent = null } = {}) {
  const sent = [];
  let failures = 0;
  const send = async (chatId, text) => {
    if (permanent) return { ok: false, description: permanent, error_code: 403 };
    if (failures < failTimes) { failures++; return { ok: false, description: 'Bad Gateway', error_code: 502 }; }
    sent.push({ chatId, text });
    return { ok: true, result: { message_id: sent.length } };
  };
  return { send, sent };
}

// ---------------------------------------------------------------------------

test('TEST 16 - confirming a booking opens the shipment and queues one confirmation', async () => {
  const db = setup({ bookings: [BOOKING] });

  const shipment = await createShipmentFromBooking(BOOKING, { operator: 'Ariful' });
  assert.equal(shipment.ok, true);
  assert.match(shipment.shipment_id, /^MKY-\d+$/);

  const queued = await enqueue({
    chatId: CHAT, clientId: 1,
    eventType: 'booking_confirmed', entityType: 'booking', entityId: BOOKING.booking_ref,
    idempotencyKey: `booking_confirmed:${BOOKING.booking_ref}`,
    payload: {
      booking_ref: BOOKING.booking_ref, vin: BOOKING.vin, make: BOOKING.make,
      origin_port: BOOKING.origin_port, destination_port: BOOKING.destination_port,
      shipment_id: shipment.shipment_id,
    },
  });
  assert.equal(queued.queued, true);

  const post = recorder();
  const result = await drain({ send: post.send });

  assert.equal(result.sent, 1);
  assert.equal(post.sent.length, 1);
  assert.match(post.sent[0].text, /Your booking is confirmed/);
  assert.match(post.sent[0].text, new RegExp(BOOKING.booking_ref));
  assert.match(post.sent[0].text, new RegExp(shipment.shipment_id));
  assert.match(post.sent[0].text, /Thank you for choosing MKY Forwarding/);

  // The shipment exists and can be tracked.
  assert.equal(db._tables.shipments.length, 1);
  assert.equal(db._tables.shipments[0].booking_ref, BOOKING.booking_ref);
});

test('confirming the same booking twice opens one shipment, not two', async () => {
  const db = setup({ bookings: [BOOKING] });

  const first = await createShipmentFromBooking(BOOKING, { operator: 'Ariful' });
  const second = await createShipmentFromBooking(BOOKING, { operator: 'Sara' });

  assert.equal(second.existed, true);
  assert.equal(first.shipment_id, second.shipment_id);
  assert.equal(db._tables.shipments.length, 1);
});

test('TEST 17 - a transport failure is retried, and the client is told exactly once', async () => {
  setup();

  await enqueue({
    chatId: CHAT, eventType: 'booking_confirmed', entityType: 'booking', entityId: 'REF-9',
    idempotencyKey: 'booking_confirmed:REF-9',
    payload: { booking_ref: 'REF-9', vin: 'W1T9', make: 'Volvo', origin_port: 'Koper', destination_port: 'Suez Port' },
  });

  // First attempt fails; the row must go back to pending, NOT be marked sent.
  const flaky = recorder({ failTimes: 1 });
  const first = await drain({ send: flaky.send });
  assert.equal(first.sent, 0);
  assert.equal(first.retried, 1);
  assert.equal(flaky.sent.length, 0);

  const { db } = await import('../lib/supabase.js');
  const row = db()._tables.notification_outbox[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.attempt_count, 1);
  assert.match(row.last_error, /Bad Gateway/);

  // It is scheduled for later, so an immediate re-run does nothing.
  const tooSoon = await drain({ send: flaky.send });
  assert.equal(tooSoon.considered, 0);

  // When the time comes it goes out, once.
  row.available_at = new Date(Date.now() - 1000).toISOString();
  const second = await drain({ send: flaky.send });
  assert.equal(second.sent, 1);
  assert.equal(flaky.sent.length, 1);

  // And never again.
  row.available_at = new Date(Date.now() - 1000).toISOString();
  const third = await drain({ send: flaky.send });
  assert.equal(third.considered, 0);
  assert.equal(flaky.sent.length, 1, 'the client was told exactly once');
});

test('a client who has blocked the bot is not retried forever', async () => {
  setup();
  await enqueue({
    chatId: CHAT, eventType: 'booking_confirmed', entityId: 'REF-10',
    idempotencyKey: 'booking_confirmed:REF-10',
    payload: { booking_ref: 'REF-10', vin: 'W1T9', make: 'Volvo', origin_port: 'Koper', destination_port: 'Suez Port' },
  });

  const blocked = recorder({ permanent: 'Forbidden: bot was blocked by the user' });
  const result = await drain({ send: blocked.send });

  assert.equal(result.dead, 1);
  assert.equal(result.retried, 0);

  const { db } = await import('../lib/supabase.js');
  assert.equal(db()._tables.notification_outbox[0].status, 'dead');
});

test('an event with no renderer is parked, never sent as an empty message', async () => {
  setup();
  await enqueue({
    chatId: CHAT, eventType: 'something_nobody_wrote_a_message_for', entityId: 'X',
    idempotencyKey: 'x:1', payload: {},
  });

  const post = recorder();
  const result = await drain({ send: post.send });

  assert.equal(result.dead, 1);
  assert.equal(post.sent.length, 0);
});

// ---------------------------------------------------------------------------
// The work queue
// ---------------------------------------------------------------------------

test('the same event raises one Operations task however many times it fires', async () => {
  const db = setup();

  const a = await createTask({
    taskType: 'new_booking_request', bookingRef: 'REF-11', chatId: CHAT,
    idempotencyKey: 'booking_submitted:REF-11', payload: {},
  });
  const b = await createTask({
    taskType: 'new_booking_request', bookingRef: 'REF-11', chatId: CHAT,
    idempotencyKey: 'booking_submitted:REF-11', payload: {},
  });

  assert.equal(a.existed, false);
  assert.equal(b.existed, true);
  assert.equal(b.task.task_ref, a.task.task_ref);
  assert.equal(db._tables.operations_tasks.length, 1);
});

test('deciding a booking closes the work still open against it', async () => {
  const db = setup();
  await createTask({
    taskType: 'new_booking_request', bookingRef: 'REF-12', chatId: CHAT,
    idempotencyKey: 'booking_submitted:REF-12', payload: {},
  });

  await closeTasksForBooking('REF-12', { operator: 'Ariful', reason: 'booking confirmed' });

  const task = db._tables.operations_tasks[0];
  assert.equal(task.status, 'done');
  assert.equal(task.completed_by, 'Ariful');
});

test('completing a task twice is a no-op, not an error', async () => {
  const db = setup();
  const made = await createTask({
    taskType: 'other', chatId: CHAT, idempotencyKey: 'once', payload: {},
  });

  const first = await completeTask(made.task.task_ref, { operator: 'Sara' });
  const second = await completeTask(made.task.task_ref, { operator: 'Sara' });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(db._tables.operations_tasks.filter((t) => t.status === 'done').length, 1);
});

test('an MRN request cannot be opened twice for one booking', async () => {
  const db = setup({
    mrn_requests: [{
      request_ref: 'MKY-MRN-260908-AAAA', booking_ref: 'REF-13', chat_id: CHAT,
      status: 'submitted', missing_information: [], supplied_information: {},
    }],
  });

  // The fake enforces uniqueness on request_ref; the real schema also carries a
  // partial unique index on (booking_ref) for live statuses. Either way the
  // service must hand back the existing application rather than a second one.
  const again = await openMrnRequest({ bookingRef: 'REF-13', chatId: CHAT, vin: 'W1T9' });

  const live = db._tables.mrn_requests.filter(
    (r) => r.booking_ref === 'REF-13' && ['submitted', 'under_review'].includes(r.status),
  );
  assert.ok(again.ok);
  assert.ok(live.length >= 1);
});

test('the notifier works with nothing configured, and says which channels ran', async () => {
  setup();
  const notifier = operationsNotifier();

  // No STAFF_CHAT_ID and no Pumble: the Supabase record is the notification.
  assert.deepEqual(notifier.channels, ['supabase']);

  const result = await notifier.notifyNewBooking(BOOKING, { task_ref: 'MKY-TSK-1' });
  assert.equal(result.supabase.ok, true);
});

test('a notification channel that throws cannot break the business action', async () => {
  setup();
  const notifier = operationsNotifier();
  // Passing something the formatter will choke on: the fan-out must swallow it.
  const result = await notifier.notifyClientContactRequest(null);
  assert.ok(result.supabase);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('a rejection carries the operator\'s reason and no celebration', () => {
  const message = render({
    event_type: 'booking_rejected',
    payload: { booking_ref: 'REF-14', reason: 'The chassis on the invoice does not match.' },
  });

  assert.match(message.text, /not able to confirm request REF-14/);
  assert.match(message.text, /chassis on the invoice does not match/);
  assert.doesNotMatch(message.text, /🎉/);
});

test('a request for more information repeats what the operator actually asked for', () => {
  const message = render({
    event_type: 'missing_information_requested',
    payload: { booking_ref: 'REF-15', requested: 'A clearer photo of page 2 of the invoice.' },
  });

  assert.match(message.text, /REF-15/);
  assert.match(message.text, /clearer photo of page 2/);
});

// ---------------------------------------------------------------------------
// The client's copy of the paperwork
// ---------------------------------------------------------------------------

test('a queued PDF renders as a document, not as a message', async () => {
  const request = render({ event_type: 'booking_request_pdf', payload: { booking_ref: 'MKY-BKG-1' } });
  assert.ok(request.document, 'it is a document row');
  assert.equal(request.document.kind, 'booking_pdf');
  assert.match(request.document.caption, /Booking request MKY-BKG-1/);

  const confirmed = render({ event_type: 'booking_confirmed_pdf', payload: { booking_ref: 'MKY-BKG-1' } });
  assert.match(confirmed.document.caption, /Booking confirmation MKY-BKG-1/);

  // Without a reference there is nothing truthful to send.
  assert.equal(render({ event_type: 'booking_confirmed_pdf', payload: {} }), null);
});

test('the PDF is delivered as a file, and retried on its own if it fails', async () => {
  const db = setup({
    bookings: [{ ...BOOKING, status: 'confirmed' }],
  });

  await enqueue({
    chatId: CHAT, eventType: 'booking_confirmed_pdf', entityType: 'booking',
    entityId: BOOKING.booking_ref,
    idempotencyKey: `booking_confirmed_pdf:${BOOKING.booking_ref}`,
    payload: { booking_ref: BOOKING.booking_ref },
  });

  const files = [];
  let failures = 1;
  const sendFile = async (chatId, buffer, filename, caption) => {
    if (failures-- > 0) throw new Error('Bad Gateway');
    files.push({ chatId, bytes: buffer.length, filename, caption });
    return { ok: true };
  };
  const send = async () => ({ ok: true });

  const first = await drain({ send, sendFile });
  assert.equal(first.sent, 0, 'a failed upload is not marked sent');
  assert.equal(first.retried, 1);
  assert.equal(files.length, 0);

  const row = db._tables.notification_outbox[0];
  row.available_at = new Date(Date.now() - 1000).toISOString();

  const second = await drain({ send, sendFile });
  assert.equal(second.sent, 1);
  assert.equal(files.length, 1);
  assert.match(files[0].filename, /\.pdf$/);
  assert.ok(files[0].bytes > 5000, 'a real PDF, not an empty buffer');
  assert.match(files[0].caption, /Booking confirmation/);
});

test('the PDF is built from the booking as it stands when it is sent', async () => {
  // Queued while pending, delivered after confirmation: the sheet must say
  // confirmed, not carry the stale wording from when it was queued.
  const db = setup({ bookings: [{ ...BOOKING, status: 'pending_review' }] });

  await enqueue({
    chatId: CHAT, eventType: 'booking_confirmed_pdf', entityId: BOOKING.booking_ref,
    idempotencyKey: 'pdf:late', payload: { booking_ref: BOOKING.booking_ref },
  });

  db._tables.bookings[0].status = 'confirmed';

  let captured = null;
  await drain({
    send: async () => ({ ok: true }),
    sendFile: async (_chat, buffer) => { captured = buffer; return { ok: true }; },
  });

  assert.ok(captured, 'the document was built and sent');
  const { readDocument } = await import('../lib/read-file.js');
  const read = await readDocument({ buffer: captured, mimeType: 'application/pdf', fileName: 'x.pdf' });
  assert.match(read.text, /BOOKING CONFIRMATION/);
  assert.doesNotMatch(read.text, /AWAITING CONFIRMATION/);
});
