/**
 * The booking, tracking and contact flows, driven exactly as Telegram drives
 * them, against an in-memory database.
 *
 * Every test here is the specification's acceptance list turned into something
 * that fails when the behaviour changes. They run with no network, no Telegram
 * token and no language model - which is itself the point being proved: if a
 * booking could only be completed with a model in the loop, none of this would
 * be testable, and "no critical booking decision depends solely on an LLM"
 * would be a claim rather than a fact.
 *
 *   npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';
process.env.OPERATIONS_PHONE ||= '';

import { createFakeDb } from './helpers/fake-db.mjs';
import { setClientForTests } from '../lib/supabase.js';
import { invalidateSettings } from '../lib/settings.js';
import { resetFlowReady } from '../lib/flow/ready.js';
import { runFlow } from '../lib/flow/machine.js';
import { parseCallback } from '../lib/flow/keyboards.js';
import { S } from '../lib/flow/states.js';
import { matchPort, looksLikeVin, normalizeVin } from '../lib/bookings.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const SETTINGS = [
  { key: 'required_booking_documents', value: ['invoice', 'brief', 'mrn'] },
  { key: 'required_booking_documents_mky_mrn', value: ['invoice', 'brief'] },
  { key: 'required_mrn_documents', value: [] },
  { key: 'acid_required', value: false },
  { key: 'allow_submit_while_mrn_pending', value: true },
  { key: 'allowed_file_types', value: ['application/pdf', 'image/jpeg'] },
  { key: 'max_upload_bytes', value: 20971520 },
  { key: 'allow_unowned_shipment_tracking', value: false },
  { key: 'operations_phone', value: null },
];

const CHAT = '555';
const OTHER_CHAT = '777';

function harness(seed = {}) {
  const db = createFakeDb({
    bot_settings: SETTINGS,
    clients: [{ id: 1, telegram_user_id: 999, telegram_chat_id: 555, display_name: 'Arif' }],
    ...seed,
  });
  setClientForTests(db);
  invalidateSettings();
  // The schema probe caches; each test gets a clean verdict for its own tables.
  resetFlowReady(true);

  const ctx = {
    channel: 'telegram',
    chatId: CHAT,
    clientId: 1,
    telegramUserId: 999,
    userName: 'Arif',
    correlationId: 'test',
  };

  const send = (input) => runFlow(input, ctx);

  return {
    db,
    ctx,
    send,
    text: (t) => send({ kind: 'text', text: t }),
    tap: (data) => send({ kind: 'callback', callback: { ...parseCallback(data), id: 'cbq' } }),
    command: (c) => send({ kind: 'command', command: c, text: c }),
    file: (doc) => send({ kind: 'document', document: doc }),
    /** Files a document straight into the store, as the transport would. */
    upload(docType, { vin = null, bookingRef = null, fileName = 'f.pdf' } = {}) {
      const row = {
        chat_id: CHAT, client_id: 1, channel: 'telegram', booking_ref: bookingRef,
        doc_type: docType, file_name: fileName, vin, status: 'received',
        extraction_ok: true, uploaded_at: new Date().toISOString(),
      };
      db._tables.booking_documents ??= [];
      const id = 1000 + db._tables.booking_documents.length;
      db._tables.booking_documents.push({ id, ...row, vin_norm: normalizeVin(vin) });
      return { document: { id, doc_type: docType } };
    },
    booking: () => db._tables.bookings?.[db._tables.bookings.length - 1] ?? null,
    bookings: () => db._tables.bookings ?? [],
    tasks: () => db._tables.operations_tasks ?? [],
    outbox: () => db._tables.notification_outbox ?? [],
  };
}

/** All the text of a flow result, joined, for substring assertions. */
const said = (result) => result.messages.map((m) => m.text).join('\n---\n');

/** Every callback_data offered by a result. */
const buttons = (result) =>
  result.messages.flatMap((m) => (m.inline ?? []).flat().map((b) => b.callback_data));

/** Walks a fresh booking from /start to the confirmation card. */
async function bookUpTo(h, { vin = 'W1T96340310484233', mrn = 'existing', documents = true } = {}) {
  await h.command('/start');
  await h.tap('menu:book');
  await h.text(vin);
  await h.text('Mercedes-Benz');
  await h.text('Nile Motors');
  await h.text('Vilnius');
  await h.text('Alexandria');
  const choice = await h.tap(`bk:mrn:${mrn}`);
  if (!documents) return choice;

  const required = mrn === 'mky_issue' ? ['invoice', 'brief'] : ['invoice', 'brief', 'mrn'];
  if (mrn === 'mky_issue') await h.text('Exported from Lithuania by AB Transporta, invoice 4471.');

  let last = choice;
  for (const type of required) {
    last = await h.file(h.upload(type, { vin }));
  }
  return last;
}

// ---------------------------------------------------------------------------
// 1 - the menu
// ---------------------------------------------------------------------------

test('TEST 1 - /start shows the main menu with three buttons', async () => {
  const h = harness();
  const r = await h.command('/start');

  assert.match(said(r), /Welcome/);
  assert.match(said(r), /How can we help you today/);
  assert.deepEqual(buttons(r), ['menu:book', 'menu:track', 'menu:contact']);
  assert.equal(r.state, S.MAIN_MENU);
});

test('a typed "1" still starts a booking, alongside the buttons', async () => {
  const h = harness();
  await h.command('/start');
  const r = await h.text('1');
  assert.match(said(r), /VIN \/ Chassis number/);
  assert.equal(r.state, S.BOOK_VIN);
});

// ---------------------------------------------------------------------------
// 2-4 - the chassis check
// ---------------------------------------------------------------------------

test('TEST 2 - an unknown chassis is new, and moves to step 2', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');
  const r = await h.text('W1T96340310484233');

  assert.match(said(r), /This unit is new/);
  assert.match(said(r), /Make \/ Brand/);
  assert.equal(r.state, S.BOOK_MAKE);
  assert.equal(h.booking().vin, 'W1T96340310484233');
});

test('TEST 3 - a known unit with no live booking continues, reusing what we hold', async () => {
  const h = harness({
    vehicles: [{ vin: 'W1T96340310484233', make: 'Scania', model: 'R450' }],
  });
  await h.command('/start');
  await h.tap('menu:book');
  const r = await h.text('W1T96340310484233');

  assert.match(said(r), /already in our system/);
  assert.match(said(r), /Nothing is blocking it/);
  // The make we already hold is not asked for again.
  assert.equal(h.booking().make, 'Scania');
  assert.equal(r.state, S.BOOK_CLIENT_NAME);
});

test('TEST 4 - an already-booked chassis is refused, with reference and route', async () => {
  const h = harness({
    bookings: [{
      booking_ref: 'MKY-BKG-260901-AAAA', status: 'confirmed', chat_id: OTHER_CHAT,
      vin: 'W1T96340310484233', make: 'Volvo', customer_name: 'Someone Else',
      origin_port: 'Klaipeda', destination_port: 'Port Said',
    }],
  });
  await h.command('/start');
  await h.tap('menu:book');
  const r = await h.text('W1T96340310484233');

  assert.match(said(r), /already booked/);
  assert.match(said(r), /MKY-BKG-260901-AAAA/);
  assert.match(said(r), /Klaipeda → Port Said/);
  assert.deepEqual(buttons(r), ['menu:track', 'menu:home']);
  assert.equal(r.state, S.MAIN_MENU);

  // No second request was created, and the draft was not left lying around.
  const live = h.bookings().filter((b) => b.status !== 'cancelled');
  assert.equal(live.length, 1);
  assert.equal(live[0].booking_ref, 'MKY-BKG-260901-AAAA');
});

test('a chassis that differs only in spacing and case is the same chassis', async () => {
  const h = harness({
    bookings: [{
      booking_ref: 'MKY-BKG-260901-BBBB', status: 'pending_review', chat_id: OTHER_CHAT,
      vin: 'W1T96340310484233', make: 'Volvo', customer_name: 'X',
      origin_port: 'Koper', destination_port: 'Suez Port',
    }],
  });
  await h.command('/start');
  await h.tap('menu:book');
  const r = await h.text('w1t 9634-0310 484233');
  assert.match(said(r), /already booked/);
});

test('something that is not a chassis number is rejected, not stored', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');
  const r = await h.text('12345');

  assert.match(said(r), /does not look like a full chassis number/);
  assert.equal(r.state, S.BOOK_VIN);
  assert.equal(h.booking().vin, undefined);
});

// ---------------------------------------------------------------------------
// 5-6 - the basics
// ---------------------------------------------------------------------------

test('TEST 5 - one missing field is asked for on its own', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');
  await h.text('W1T96340310484233');
  await h.text('Mercedes-Benz');
  await h.text('Nile Motors');
  const r = await h.text('Vilnius');

  assert.match(said(r), /Egyptian destination port/);
  assert.doesNotMatch(said(r), /We are missing some information/);
  assert.equal(r.state, S.BOOK_DESTINATION);
});

test('TEST 6 - several missing fields are listed before the first is asked', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');
  const r = await h.text('W1T96340310484233');

  assert.match(said(r), /We are missing some information/);
  assert.match(said(r), /Make \/ Brand/);
  assert.match(said(r), /Client name/);
  assert.match(said(r), /Destination/);
});

test('a destination we do not serve is refused with the list of ones we do', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');
  await h.text('W1T96340310484233');
  await h.text('Mercedes-Benz');
  await h.text('Nile Motors');
  await h.text('Vilnius');
  const r = await h.text('Aswan');

  assert.match(said(r), /is not a port we serve/);
  assert.equal(r.state, S.BOOK_DESTINATION);
  assert.equal(h.booking().destination_port, undefined);
});

test('the draft is written as each answer arrives, not held until the end', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');
  await h.text('W1T96340310484233');
  assert.equal(h.booking().vin, 'W1T96340310484233');
  await h.text('Mercedes-Benz');
  assert.equal(h.booking().make, 'Mercedes-Benz');
  assert.equal(h.booking().status, 'draft');
});

// ---------------------------------------------------------------------------
// 7-11 - MRN and documents
// ---------------------------------------------------------------------------

test('the MRN question is asked once the basics are in, with two choices', async () => {
  const h = harness();
  const r = await bookUpTo(h, { documents: false, mrn: 'existing' });
  assert.equal(r.state, S.BOOK_DOCUMENTS);

  // Re-run to observe the question itself.
  const h2 = harness();
  await h2.command('/start');
  await h2.tap('menu:book');
  await h2.text('W1T96340310484233');
  await h2.text('Mercedes-Benz');
  await h2.text('Nile Motors');
  await h2.text('Vilnius');
  const q = await h2.text('Alexandria');
  assert.match(said(q), /Do you already have an MRN/);
  assert.deepEqual(buttons(q), ['bk:mrn:existing', 'bk:mrn:mky_issue', 'menu:home']);
});

test('TEST 7 - "I have the MRN" asks for invoice, brief and MRN', async () => {
  const h = harness();
  const r = await bookUpTo(h, { documents: false, mrn: 'existing' });

  assert.match(said(r), /Invoice/);
  assert.match(said(r), /Brief/);
  assert.match(said(r), /MRN/);
  assert.equal(h.booking().mrn_choice, 'existing');
});

test('TEST 8 - "MKY issues the MRN" opens an MRN request and an Operations task', async () => {
  const h = harness();
  await bookUpTo(h, { documents: false, mrn: 'mky_issue' });

  const requests = h.db._tables.mrn_requests ?? [];
  assert.equal(requests.length, 1);
  assert.equal(requests[0].status, 'submitted');
  assert.equal(requests[0].booking_ref, h.booking().booking_ref);

  const mrnTasks = h.tasks().filter((t) => t.task_type === 'mrn_request');
  assert.equal(mrnTasks.length, 1);
  assert.equal(mrnTasks[0].priority, 'high');

  // The MRN is not asked of a client who has just told us they do not have one.
  assert.equal(h.booking().mrn_needed, true);
});

test('the MKY-MRN branch does not invent a customs requirement', async () => {
  const h = harness();
  await bookUpTo(h, { documents: false, mrn: 'mky_issue' });
  const request = h.db._tables.mrn_requests[0];

  // required_mrn_documents is empty until MKY says otherwise, so nothing is
  // demanded of the client and the task says why.
  assert.deepEqual(request.missing_information, []);
  const task = h.tasks().find((t) => t.task_type === 'mrn_request');
  assert.match(task.notes, /has not defined what an MRN application needs/);
});

test('TEST 9 - several documents outstanding gives the "just a little more" list', async () => {
  const h = harness();
  await bookUpTo(h, { documents: false });
  const r = await h.file(h.upload('invoice', { vin: 'W1T96340310484233' }));

  assert.match(said(r), /Just a little more/);
  assert.match(said(r), /Brief/);
  assert.match(said(r), /MRN/);
  assert.doesNotMatch(said(r), /Almost there/);
});

test('TEST 10 - the last outstanding document gives the "almost there" message', async () => {
  const h = harness();
  await bookUpTo(h, { documents: false });
  await h.file(h.upload('invoice', { vin: 'W1T96340310484233' }));
  const r = await h.file(h.upload('brief', { vin: 'W1T96340310484233' }));

  assert.match(said(r), /Almost there/);
  assert.match(said(r), /MRN/);
  assert.doesNotMatch(said(r), /Just a little more/);
});

test('TEST 11 - all documents present advances to the confirmation card', async () => {
  const h = harness();
  const r = await bookUpTo(h);

  assert.match(said(r), /We have everything we need/);
  assert.match(said(r), /Please confirm your booking details/);
  assert.match(said(r), /W1T96340310484233/);
  assert.deepEqual(buttons(r), ['bk:confirm', 'bk:edit', 'bk:cancel:ask']);
  assert.equal(r.state, S.BOOK_FINAL_CONFIRMATION);
});

test('a document for another chassis is flagged, and does not count as received', async () => {
  const h = harness();
  await bookUpTo(h, { documents: false });
  const r = await h.file(h.upload('invoice', { vin: 'ZZZ99999999999999' }));

  assert.match(said(r), /but this booking is for/);
  // Still wanted: the wrong-vehicle paper did not satisfy the requirement.
  assert.match(said(r), /Invoice/);
});

test('an unreadable file is not guessed at - the client is asked what it is', async () => {
  const h = harness();
  await bookUpTo(h, { documents: false });
  const r = await h.file(h.upload('other', { vin: 'W1T96340310484233' }));

  assert.match(said(r), /not sure what it is/);
  assert.ok(buttons(r).some((b) => b.startsWith('bk:doctype:')));
  assert.equal(r.state, S.BOOK_DOCUMENT_CLASSIFY);
});

test('the client classifying a file files it under that type', async () => {
  const h = harness();
  await bookUpTo(h, { documents: false });
  await h.file(h.upload('other', { vin: 'W1T96340310484233' }));
  const r = await h.tap('bk:doctype:invoice');

  assert.match(said(r), /Invoice received/);
  const doc = h.db._tables.booking_documents.find((d) => d.doc_type === 'invoice');
  assert.ok(doc, 'the document was refiled as an invoice');
});

test('the confirmation card never claims a document is verified', async () => {
  const h = harness();
  const r = await bookUpTo(h);
  assert.doesNotMatch(said(r), /verified/i);
});

// ---------------------------------------------------------------------------
// 12-14 - editing and submitting
// ---------------------------------------------------------------------------

test('TEST 12 - editing the make saves it and returns to the confirmation', async () => {
  const h = harness();
  await bookUpTo(h);
  await h.tap('bk:edit');
  const asked = await h.tap('bk:edit:make');
  assert.match(said(asked), /Make \/ Brand/);

  const r = await h.text('Volvo');
  assert.match(said(r), /Information updated successfully/);
  assert.match(said(r), /Please confirm your booking details/);
  assert.equal(h.booking().make, 'Volvo');
  assert.equal(r.state, S.BOOK_FINAL_CONFIRMATION);
});

test('TEST 13 - editing the chassis re-runs the duplicate check', async () => {
  const h = harness({
    bookings: [{
      booking_ref: 'MKY-BKG-260901-CCCC', status: 'confirmed', chat_id: OTHER_CHAT,
      vin: 'VF600000000000001', make: 'Renault', customer_name: 'Other',
      origin_port: 'Le Havre', destination_port: 'Damietta Port',
    }],
  });
  await bookUpTo(h);
  await h.tap('bk:edit');
  await h.tap('bk:edit:vin');
  const r = await h.text('VF600000000000001');

  assert.match(said(r), /already booked/);
  assert.match(said(r), /MKY-BKG-260901-CCCC/);
  assert.equal(r.state, S.MAIN_MENU);
});

test('editing the chassis to an unused one keeps the request alive', async () => {
  const h = harness();
  await bookUpTo(h);
  await h.tap('bk:edit');
  await h.tap('bk:edit:vin');
  const r = await h.text('WDB9634031L484299');

  assert.equal(h.booking().vin, 'WDB9634031L484299');
  // The papers were for the old chassis, so they no longer match: the flow says
  // so rather than carrying them over silently.
  assert.match(said(r), /but this booking is for/);
});

test('TEST 14 - Confirm submits the request and creates exactly one Operations task', async () => {
  const h = harness();
  await bookUpTo(h);
  const r = await h.tap('bk:confirm');

  assert.match(said(r), /Booking request confirmed/);
  assert.match(said(r), /sending your request to our Operations Team/);
  assert.doesNotMatch(said(r), /Your booking is confirmed/);

  const b = h.booking();
  assert.equal(b.status, 'pending_review');
  assert.ok(b.submitted_at);
  assert.ok(b.client_confirmed_at);

  const tasks = h.tasks().filter((t) => t.task_type === 'new_booking_request');
  assert.equal(tasks.length, 1);
});

test('Confirm is refused while a required document is missing', async () => {
  const h = harness();
  await bookUpTo(h, { documents: false });
  await h.file(h.upload('invoice', { vin: 'W1T96340310484233' }));
  const r = await h.tap('bk:confirm');

  assert.match(said(r), /cannot send this to Operations/);
  assert.equal(h.booking().status, 'draft');
  assert.equal(h.tasks().length, 0);
});

test('TEST 15 - a repeated Confirm does not submit twice', async () => {
  const h = harness();
  await bookUpTo(h);
  await h.tap('bk:confirm');
  const again = await h.tap('bk:confirm');

  assert.match(said(again), /already with our Operations Team/);
  assert.equal(h.tasks().filter((t) => t.task_type === 'new_booking_request').length, 1);
  assert.equal(h.outbox().filter((o) => o.event_type === 'booking_request_submitted').length, 1);
});

test('submission is blocked when another chat booked the chassis in the meantime', async () => {
  const h = harness();
  await bookUpTo(h);

  // Somebody else's request lands between the card and the yes.
  h.db._tables.bookings.push({
    id: 9001, booking_ref: 'MKY-BKG-260908-RACE', status: 'pending_review', chat_id: OTHER_CHAT,
    vin: 'W1T96340310484233', vin_norm: 'W1T96340310484233', make: 'Volvo',
    customer_name: 'Other', origin_port: 'Koper', destination_port: 'Suez Port',
  });

  const r = await h.tap('bk:confirm');
  assert.match(said(r), /already booked under MKY-BKG-260908-RACE/);
  assert.equal(h.bookings().find((b) => b.chat_id === CHAT).status, 'draft');
});

test('the submitted request carries exactly what the client approved', async () => {
  const h = harness();
  await bookUpTo(h);
  await h.tap('bk:confirm');
  const b = h.booking();

  assert.equal(b.vin, 'W1T96340310484233');
  assert.equal(b.make, 'Mercedes-Benz');
  assert.equal(b.customer_name, 'Nile Motors');
  assert.equal(b.origin_port, 'Vilnius');
  assert.equal(b.destination_port, 'Alexandria Port (incl. El Dekheila)');
});

// ---------------------------------------------------------------------------
// 18-21 - tracking
// ---------------------------------------------------------------------------

const SHIPMENT = {
  shipment_id: 'MKY-26001', booking_ref: 'MKY-BKG-260901-DDDD', chat_id: CHAT,
  vin: 'W1T96340310484233', make: 'Mercedes-Benz', customer_name: 'Nile Motors',
  origin_port: 'Vilnius', destination_port: 'Alexandria Port (incl. El Dekheila)',
  status: 'In transit', vessel: 'MSC Aurora', eta: '2026-09-20',
};

test('TEST 18 - tracking by booking reference', async () => {
  const h = harness({ shipments: [SHIPMENT] });
  await h.tap('menu:track');
  const r = await h.text('MKY-BKG-260901-DDDD');

  assert.match(said(r), /Found it/);
  assert.match(said(r), /MKY-26001/);
  assert.match(said(r), /In transit/);
  assert.match(said(r), /MSC Aurora/);
  assert.equal(r.state, S.TRACK_RESULTS);
});

test('TEST 19 - tracking by chassis number', async () => {
  const h = harness({ shipments: [SHIPMENT] });
  await h.tap('menu:track');
  const r = await h.text('w1t9634 0310484233');
  assert.match(said(r), /MKY-26001/);
});

test('TEST 20 - an unknown identifier offers retry, contact and menu', async () => {
  const h = harness({ shipments: [SHIPMENT] });
  await h.tap('menu:track');
  const r = await h.text('NOPE-1234');

  assert.match(said(r), /could not find a shipment/);
  assert.deepEqual(buttons(r), ['tr:retry', 'menu:contact', 'menu:home']);
});

test('TEST 21 - Refresh re-reads the database rather than repeating itself', async () => {
  const h = harness({ shipments: [SHIPMENT] });
  await h.tap('menu:track');
  await h.text('MKY-BKG-260901-DDDD');

  // The world moves between the two answers.
  h.db._tables.shipments[0].status = 'Arrived at destination port';
  h.db._tables.shipments[0].vessel = 'MSC Ambition';

  const r = await h.tap('tr:refresh:MKY-26001');
  assert.match(said(r), /Latest status/);
  assert.match(said(r), /Arrived at destination port/);
  assert.match(said(r), /MSC Ambition/);
});

test('a value the database does not hold reads "Not available yet", never a guess', async () => {
  const h = harness({
    shipments: [{ ...SHIPMENT, vessel: null, eta: null, status: 'Booking confirmed, awaiting cargo' }],
  });
  await h.tap('menu:track');
  const r = await h.text('MKY-26001');

  assert.match(said(r), /Vessel: .*Not assigned yet/);
  assert.match(said(r), /ETA: .*Not available yet/);
});

test('TEST 26 - another client\'s shipment is not readable, and looks identical to not-found', async () => {
  const h = harness({ shipments: [{ ...SHIPMENT, chat_id: OTHER_CHAT, booking_ref: null }] });
  await h.tap('menu:track');
  const r = await h.text('MKY-26001');

  assert.match(said(r), /could not find a shipment/);
  assert.doesNotMatch(said(r), /MSC Aurora/);
  assert.doesNotMatch(said(r), /Nile Motors/);
});

test('a shipment owned through the booking, not the chat, is readable by its client', async () => {
  const h = harness({
    shipments: [{ ...SHIPMENT, chat_id: null }],
    bookings: [{
      booking_ref: 'MKY-BKG-260901-DDDD', status: 'confirmed', chat_id: CHAT, client_id: 1,
      vin: 'W1T96340310484233', make: 'Mercedes-Benz', customer_name: 'Nile Motors',
      origin_port: 'Vilnius', destination_port: 'Alexandria Port (incl. El Dekheila)',
    }],
  });
  await h.tap('menu:track');
  const r = await h.text('MKY-26001');
  assert.match(said(r), /MSC Aurora/);
});

test('a confirmed booking with no shipment yet says where it actually is', async () => {
  const h = harness({
    bookings: [{
      booking_ref: 'MKY-BKG-260901-EEEE', status: 'pending_review', chat_id: CHAT, client_id: 1,
      vin: 'W1T96340310484233', make: 'Mercedes-Benz', customer_name: 'Nile Motors',
      origin_port: 'Vilnius', destination_port: 'Alexandria Port (incl. El Dekheila)',
    }],
  });
  await h.tap('menu:track');
  const r = await h.text('MKY-BKG-260901-EEEE');

  assert.match(said(r), /pending review/);
  assert.match(said(r), /no vessel or arrival date/);
  assert.doesNotMatch(said(r), /Not available yet.*Not available yet.*Not available yet/s);
});

// ---------------------------------------------------------------------------
// 22-25 - contact
// ---------------------------------------------------------------------------

test('TEST 22-25 - the contact menu offers all four routes', async () => {
  const h = harness();
  const r = await h.tap('menu:contact');

  assert.match(said(r), /What do you need help with/);
  assert.deepEqual(buttons(r), ['ct:booking', 'ct:tracking', 'ct:docs', 'ct:ops']);
});

test('TEST 22 - contact/booking shows only a booking this client owns', async () => {
  const h = harness({
    bookings: [{
      booking_ref: 'MKY-BKG-260901-FFFF', status: 'pending_review', chat_id: CHAT, client_id: 1,
      vin: 'W1T96340310484233', make: 'Mercedes-Benz', customer_name: 'Nile Motors',
      origin_port: 'Vilnius', destination_port: 'Alexandria Port (incl. El Dekheila)',
      mrn_choice: 'existing',
    }],
  });
  await h.tap('menu:contact');
  await h.tap('ct:booking');
  const r = await h.text('MKY-BKG-260901-FFFF');

  assert.match(said(r), /MKY-BKG-260901-FFFF/);
  assert.match(said(r), /Nile Motors/);
});

test('TEST 27 - contact/booking refuses another client\'s reference', async () => {
  const h = harness({
    bookings: [{
      booking_ref: 'MKY-BKG-260901-GGGG', status: 'pending_review', chat_id: OTHER_CHAT, client_id: 2,
      vin: 'ZZZ99999999999999', make: 'Volvo', customer_name: 'Someone Else',
      origin_port: 'Koper', destination_port: 'Suez Port',
    }],
  });
  await h.tap('menu:contact');
  await h.tap('ct:booking');
  const r = await h.text('MKY-BKG-260901-GGGG');

  assert.match(said(r), /could not find/);
  assert.doesNotMatch(said(r), /Someone Else/);
});

test('TEST 24 - contact/documents computes what is missing from the database', async () => {
  const h = harness();
  await bookUpTo(h, { documents: false });
  await h.file(h.upload('invoice', { vin: 'W1T96340310484233' }));

  await h.tap('menu:contact');
  await h.tap('ct:docs');
  const r = await h.tap('ct:docs:missing');

  assert.match(said(r), /Brief/);
  assert.match(said(r), /MRN/);
  assert.doesNotMatch(said(r), /Invoice/);
});

test('TEST 25 - Talk to Operations never invents a phone number', async () => {
  const h = harness();      // operations_phone is null and OPERATIONS_PHONE is unset
  await h.tap('menu:contact');
  const r = await h.tap('ct:ops');

  assert.match(said(r), /Connecting you with our Operations Team/);
  assert.match(said(r), /has not been configured/);
  assert.doesNotMatch(said(r), /\+20/);

  // The request is still recorded, so the desk can call back.
  assert.equal(h.tasks().filter((t) => t.task_type === 'client_callback').length, 1);
});

test('Talk to Operations gives the configured number when there is one', async () => {
  const h = harness();
  h.db._tables.bot_settings.find((s) => s.key === 'operations_phone').value = '+20 3 111 2222';
  invalidateSettings();

  await h.tap('menu:contact');
  const r = await h.tap('ct:ops');
  assert.match(said(r), /\+20 3 111 2222/);
});

test('a contact request becomes a ticket with the problem and the number', async () => {
  const h = harness();
  await h.tap('menu:contact');
  await h.tap('ct:ops');
  const r = await h.text('My invoice shows the wrong weight. Call me on +20 100 555 1234');

  assert.match(said(r), /Ticket MKY-TKT-/);
  const tickets = h.db._tables.support_tickets ?? [];
  assert.equal(tickets.length, 1);
  assert.match(tickets[0].contact, /\+20 100 555 1234/);
  assert.equal(tickets[0].department, 'Booking Operations');
});

// ---------------------------------------------------------------------------
// 28-30 - resilience
// ---------------------------------------------------------------------------

test('TEST 28 - the conversation resumes from the database after a restart', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');
  await h.text('W1T96340310484233');
  await h.text('Mercedes-Benz');

  // Everything in memory is gone; only Postgres remains. A new invocation must
  // pick up exactly where the last one stopped.
  const fresh = { ...h.ctx };
  const resumed = await runFlow({ kind: 'text', text: 'Nile Motors' }, fresh);

  assert.equal(resumed.state, S.BOOK_POL);
  assert.equal(h.booking().customer_name, 'Nile Motors');
});

test('TEST 29 - /cancel asks first, and only drops the unfinished request', async () => {
  const h = harness();
  await bookUpTo(h, { documents: false });
  const ask = await h.command('/cancel');
  assert.match(said(ask), /Shall I cancel/);
  assert.deepEqual(buttons(ask), ['bk:cancel:yes', 'bk:cancel:no']);

  const r = await h.tap('bk:cancel:yes');
  assert.match(said(r), /has been cancelled/);
  assert.equal(h.booking().status, 'cancelled');
});

test('declining the cancellation puts the client back where they were', async () => {
  const h = harness();
  await bookUpTo(h);
  await h.command('/cancel');
  const r = await h.tap('bk:cancel:no');

  assert.match(said(r), /Please confirm your booking details/);
  assert.equal(h.booking().status, 'draft');
});

test('/cancel with nothing in progress says so instead of erroring', async () => {
  const h = harness();
  await h.command('/start');
  const r = await h.command('/cancel');
  assert.match(said(r), /nothing in progress/);
});

test('an unfinished request is offered back, never silently resumed or dropped', async () => {
  const h = harness();
  await bookUpTo(h, { documents: false });

  const r = await h.tap('menu:book');
  assert.match(said(r), /unfinished booking request/);
  assert.deepEqual(buttons(r), ['bk:draft:continue', 'bk:draft:restart', 'menu:home']);

  const resumed = await h.tap('bk:draft:continue');
  assert.match(said(resumed), /Invoice|Brief|MRN/);
  assert.equal(h.bookings().filter((b) => b.status === 'draft').length, 1);
});

test('"start over" drops the old draft and starts one request, not two', async () => {
  const h = harness();
  await bookUpTo(h, { documents: false });
  await h.tap('menu:book');
  const r = await h.tap('bk:draft:restart');

  assert.match(said(r), /VIN \/ Chassis number/);
  assert.equal(h.bookings().filter((b) => b.status === 'draft').length, 1);
  assert.equal(h.bookings().filter((b) => b.status === 'cancelled').length, 1);
});

test('TEST 30 - a database failure does not advance the conversation', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');

  // Writes to bookings fail; reads still work. That is what a partial outage
  // looks like from here, and it is the case where a naive flow would announce
  // success and move on.
  const realFrom = h.db.from.bind(h.db);
  h.db.from = (name) => {
    const query = realFrom(name);
    if (name === 'bookings') {
      query.update = () => {
        query.op = 'update';
        query.execute = async () => ({ data: null, error: { message: 'connection reset' }, count: null });
        return query;
      };
    }
    return query;
  };

  const r = await runFlow({ kind: 'text', text: 'W1T96340310484233' }, h.ctx);
  h.db.from = realFrom;

  assert.match(said(r), /Something went wrong/);
  // Still waiting for the chassis: the state did NOT move on.
  assert.equal(r.state, S.BOOK_VIN);
});

test('a button pressed on a request that has already been submitted is refused', async () => {
  const h = harness();
  await bookUpTo(h);
  await h.tap('bk:confirm');

  // A stale card from before the submission.
  const r = await runFlow(
    { kind: 'callback', callback: { ...parseCallback('bk:edit'), id: 'cbq' } },
    h.ctx,
  );
  assert.doesNotMatch(said(r), /Which information would you like to edit/);
});

test('a free-text question mid-booking is left to the assistant, and the booking survives', async () => {
  const h = harness();
  await bookUpTo(h, { documents: false });

  const r = await h.text('how long does shipping to Alexandria take?');
  assert.equal(r.handled, false, 'the flow declines it so the assistant can answer');
  assert.equal(h.booking().status, 'draft');
});

// ---------------------------------------------------------------------------
// Units worth pinning down on their own
// ---------------------------------------------------------------------------

test('port matching does not send Damietta to Port Said', () => {
  assert.equal(matchPort('Damietta port'), 'Damietta Port');
  assert.equal(matchPort('damietta'), 'Damietta Port');
  assert.equal(matchPort('Port Said'), 'Port Said');
  assert.equal(matchPort('alex'), 'Alexandria Port (incl. El Dekheila)');
  assert.equal(matchPort('دمياط'), 'Damietta Port');
  assert.equal(matchPort('السخنة'), 'Ain Sokhna Port');
  assert.equal(matchPort('Aswan'), null);
  assert.equal(matchPort(''), null);
});

test('a chassis number is told apart from a menu digit and a phone number', () => {
  assert.equal(looksLikeVin('W1T96340310484233'), true);
  assert.equal(looksLikeVin('wdb 9634-031 L484299'), true);
  assert.equal(looksLikeVin('1'), false);
  assert.equal(looksLikeVin('+20 100 555 1234'), false);
  assert.equal(looksLikeVin('I want to book a truck to Alexandria please'), false);
});

test('the outbox refuses to queue the same event twice', async () => {
  const h = harness();
  const { enqueue } = await import('../lib/outbox.js');

  const first = await enqueue({
    chatId: CHAT, eventType: 'booking_confirmed', entityId: 'REF-1',
    idempotencyKey: 'booking_confirmed:REF-1', payload: {},
  });
  const second = await enqueue({
    chatId: CHAT, eventType: 'booking_confirmed', entityId: 'REF-1',
    idempotencyKey: 'booking_confirmed:REF-1', payload: {},
  });

  assert.equal(first.queued, true);
  assert.equal(second.ok, true);
  assert.equal(second.queued, false, 'the retry is a no-op, not a second message');
  assert.equal(h.outbox().length, 1);
});

test('a confirmation renders only from values the database supplied', async () => {
  const { render } = await import('../lib/outbox.js');

  const complete = render({
    event_type: 'booking_confirmed',
    payload: {
      booking_ref: 'MKY-BKG-1', vin: 'W1T9', make: 'Volvo',
      origin_port: 'Koper', destination_port: 'Suez Port', shipment_id: 'MKY-26002',
    },
  });
  assert.match(complete.text, /Your booking is confirmed/);
  assert.match(complete.text, /MKY-26002/);

  // Missing the reference, so there is nothing truthful to send. It is dropped
  // rather than sent with a blank where the reference should be.
  assert.equal(render({ event_type: 'booking_confirmed', payload: { make: 'Volvo' } }), null);
});

test('the audit log redacts anything that looks like a secret or a payload', async () => {
  const { redact } = await import('../lib/audit.js');
  const out = redact({
    booking_ref: 'MKY-BKG-1',
    service_role_key: 'super-secret',
    telegram_bot_token: '123:ABC',
    file_content: 'x'.repeat(5000),
    nested: { password: 'hunter2', vin: 'W1T9' },
  });

  assert.equal(out.booking_ref, 'MKY-BKG-1');
  assert.equal(out.service_role_key, '[redacted]');
  assert.equal(out.telegram_bot_token, '[redacted]');
  assert.equal(out.file_content, '[redacted]');
  assert.equal(out.nested.password, '[redacted]');
  assert.equal(out.nested.vin, 'W1T9');
});

// ---------------------------------------------------------------------------
// Regressions - each of these failed before the fix it names
// ---------------------------------------------------------------------------

test('regression: editing the route asks for the destination, not the MRN question', async () => {
  const h = harness();
  await bookUpTo(h);
  await h.tap('bk:edit');
  await h.tap('bk:edit:route');

  const afterPol = await h.text('Klaipeda');
  assert.match(said(afterPol), /Egyptian destination port/);
  assert.doesNotMatch(said(afterPol), /Do you already have an MRN/);
  assert.doesNotMatch(said(afterPol), /Perfect! Let us continue/);
  assert.equal(afterPol.state, S.BOOK_EDIT_DESTINATION);

  const done = await h.text('Port Said');
  assert.match(said(done), /Information updated successfully/);
  assert.match(said(done), /Klaipeda → Port Said/);
  assert.equal(h.booking().origin_port, 'Klaipeda');
  assert.equal(h.booking().destination_port, 'Port Said');
});

test('regression: Confirm still works when the session has lost the reference', async () => {
  const h = harness();
  await bookUpTo(h);

  // The session forgets, as it would after an expiry or a reset; the request
  // itself is untouched.
  const session = h.db._tables.conversation_sessions[0];
  session.active_booking_ref = null;

  const r = await h.tap('bk:confirm');
  assert.match(said(r), /Booking request confirmed/);
  assert.equal(h.booking().status, 'pending_review');
});

test('regression: Confirm with nothing at all in progress does not apologise for a fault', async () => {
  const h = harness();
  await h.command('/start');
  const r = await h.tap('bk:confirm');

  assert.doesNotMatch(said(r), /Something went wrong/);
  assert.match(said(r), /nothing in progress/);
});

test('regression: a document sent from the menu lands on the open request', async () => {
  const h = harness();
  await bookUpTo(h, { documents: false });

  // The client wanders back to the menu, then sends the invoice anyway.
  await h.command('/menu');
  const r = await h.file(h.upload('invoice', { vin: 'W1T96340310484233' }));

  assert.match(said(r), /Invoice received/);
  assert.match(said(r), /Just a little more/);
  assert.equal(r.state, S.BOOK_DOCUMENTS);
});

test('regression: a document with no request to belong to is not filed against one', async () => {
  const h = harness();
  await h.command('/start');
  const r = await h.file(h.upload('invoice'));

  assert.doesNotMatch(said(r), /received/i);
  assert.match(said(r), /did not follow/);
});

test('regression: the same wrong chassis is reported once, not once per file', async () => {
  const h = harness();
  await bookUpTo(h);
  await h.tap('bk:edit');
  await h.tap('bk:edit:vin');
  const r = await h.text('WDB9634031L484299');

  const warnings = r.messages.filter((m) => /but this booking is for/.test(m.text));
  assert.equal(warnings.length, 1, 'three mismatched papers, one warning');
});

test('regression: an all-but-empty draft can still be cancelled', async () => {
  // The client gives a chassis number, is told the unit is already booked, and
  // the draft behind them - which has nothing on it but a VIN - is dropped.
  // A completeness constraint that covered every non-draft status refused that
  // write, so this exercises the exact path.
  const h = harness({
    bookings: [{
      booking_ref: 'MKY-BKG-260901-HHHH', status: 'confirmed', chat_id: OTHER_CHAT,
      vin: 'W1T96340310484233', make: 'Volvo', customer_name: 'Other',
      origin_port: 'Koper', destination_port: 'Suez Port',
    }],
  });
  await h.command('/start');
  await h.tap('menu:book');
  const r = await h.text('W1T96340310484233');

  assert.match(said(r), /already booked/);
  const ours = h.bookings().filter((b) => b.chat_id === CHAT);
  assert.equal(ours.length, 1);
  assert.equal(ours[0].status, 'cancelled', 'the empty draft was cancelled, not left as a draft');
  assert.equal(ours[0].make, undefined, 'and it really was incomplete');
});

test('regression: /cancel drops a draft that has nothing on it yet', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');          // draft created, nothing answered
  await h.command('/cancel');
  const r = await h.tap('bk:cancel:yes');

  assert.match(said(r), /has been cancelled/);
  assert.equal(h.booking().status, 'cancelled');
});

test('the database refuses a request that reaches Operations incomplete', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');
  await h.text('W1T96340310484233');

  // Nothing but a chassis. Forcing it past draft must be refused - the flow
  // never does this, and the constraint is the reason nothing else can either.
  const { db } = await import('../lib/supabase.js');
  const { error } = await db()
    .from('bookings')
    .update({ status: 'pending_review' })
    .eq('booking_ref', h.booking().booking_ref)
    .select();

  assert.ok(error, 'an incomplete request cannot become pending_review');
  assert.match(error.message, /bookings_complete_when_submitted/);
  assert.equal(h.booking().status, 'draft', 'and nothing was written');
});

// ---------------------------------------------------------------------------
// The website widget uses the same machine, without inline keyboards
// ---------------------------------------------------------------------------

test('a typed number stands in for a button, so the widget can drive the flow', async () => {
  const h = harness();
  await h.command('/start');

  // "1" is the first button the menu offered.
  const r = await h.text('1');
  assert.match(said(r), /VIN \/ Chassis number/);
});

test('the offered buttons come back with the result, for a client that cannot tap', async () => {
  const h = harness();
  const r = await h.command('/start');

  assert.deepEqual(r.offered.map((o) => o.data), ['menu:book', 'menu:track', 'menu:contact']);
  assert.match(r.offered[0].label, /Book my shipment/);
});

test('a number is an answer, not a menu choice, when a question was asked', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');
  await h.text('W1T96340310484233');

  // Being asked for the make. "2" is a (silly) make, not the second button.
  const r = await h.text('2');
  assert.equal(h.booking().make, '2');
  assert.doesNotMatch(said(r), /Track/);
});

test('a number outside the offered range is not treated as a button', async () => {
  const h = harness();
  const r = await h.command('/start');
  assert.equal(r.offered.length, 3);

  const nine = await h.text('9');
  // Three buttons were offered, so "9" is not one of them: it falls through to
  // the assistant rather than picking something at random.
  assert.equal(nine.handled, false);
});

test('regression: the outstanding list is shown once, not after every answer', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');

  const afterVin = await h.text('W1T96340310484233');
  assert.match(said(afterVin), /We are missing some information/, 'shown on the way in');

  const afterMake = await h.text('Mercedes-Benz');
  assert.doesNotMatch(said(afterMake), /We are missing some information/, 'and not repeated');
  assert.match(said(afterMake), /client name/i, 'just the next question');

  const afterName = await h.text('Nile Motors');
  assert.doesNotMatch(said(afterName), /We are missing some information/);
});

test('a client who has been away is reminded what is left when they resume', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');
  await h.text('W1T96340310484233');

  await h.command('/menu');
  await h.tap('menu:book');
  const resumed = await h.tap('bk:draft:continue');

  assert.match(said(resumed), /We are missing some information/);
});

// ---------------------------------------------------------------------------
// A deploy that beats its migration
// ---------------------------------------------------------------------------

test('with migration 008 missing, the flow stands aside instead of erroring', async () => {
  const h = harness();
  // The table is not there. This is what Vercel serves in the window between a
  // push landing and somebody clicking Run on the migration.
  resetFlowReady(null);
  const realFrom = h.db.from.bind(h.db);
  h.db.from = (name) => {
    if (name === 'conversation_sessions') {
      const q = realFrom(name);
      q.execute = async () => ({
        data: null,
        error: { code: '42P01', message: 'relation "conversation_sessions" does not exist' },
        count: null,
      });
      return q;
    }
    return realFrom(name);
  };

  const r = await runFlow({ kind: 'command', command: '/start', text: '/start' }, h.ctx);
  h.db.from = realFrom;
  resetFlowReady(true);

  assert.equal(r.handled, false, 'the assistant answers, so the bot is not dead');
  assert.equal(r.degraded, true);
  assert.deepEqual(r.messages, []);
});

test('with the schema missing, the model keeps its booking tools', async () => {
  const { toolsForTurn } = await import('../lib/agent.js');

  const withFlow = toolsForTurn({ stateMachine: true }).map((t) => t.name);
  const withoutFlow = toolsForTurn({ stateMachine: false }).map((t) => t.name);

  assert.ok(!withFlow.includes('create_booking'), 'the flow owns booking when the schema is there');
  assert.ok(withoutFlow.includes('create_booking'), 'and the model owns it when it is not');
  assert.ok(withoutFlow.includes('lookup_vehicle'));
});

test('a probe failure that is NOT a missing table does not revert a working bot', async () => {
  const h = harness();
  resetFlowReady(null);
  // Exactly ONE call fails - the probe. The counter lives outside the factory,
  // or every query gets its own "first attempt" and the session read fails too,
  // which is a different scenario altogether.
  let failuresLeft = 1;
  const realFrom = h.db.from.bind(h.db);
  h.db.from = (name) => {
    const q = realFrom(name);
    if (name === 'conversation_sessions') {
      const original = q.execute.bind(q);
      q.execute = async () => {
        if (failuresLeft > 0) {
          failuresLeft--;
          return { data: null, error: { message: 'fetch failed' }, count: null };
        }
        return original();
      };
    }
    return q;
  };

  const r = await runFlow({ kind: 'command', command: '/start', text: '/start' }, h.ctx);
  h.db.from = realFrom;
  resetFlowReady(true);

  // A network blip is not evidence that the migration is missing.
  assert.equal(r.handled, true);
  assert.match(said(r), /Welcome/);
});

// ---------------------------------------------------------------------------
// A client pasting the table they were given
// ---------------------------------------------------------------------------

const PASTED_TABLE = `Make        │ Volvo FH 460 Globetrotter │
├─────────────┼───────────────────────────┤
│ Client      │ Delta Trans Egypt         │
├─────────────┼───────────────────────────┤
│ Loading     │ Klaipeda, Lithuania       │
├─────────────┼───────────────────────────┤
│ Destination │ Port Said`;

test('regression: a pasted table is read, not refused as "too long"', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');
  await h.text('YV2RT40A8FB712905');

  const r = await h.text(PASTED_TABLE);

  assert.doesNotMatch(said(r), /rather long/);
  const b = h.booking();
  assert.equal(b.make, 'Volvo');
  assert.equal(b.model, 'FH 460 Globetrotter');
  assert.equal(b.customer_name, 'Delta Trans Egypt');
  assert.equal(b.origin_port, 'Klaipeda, Lithuania');
  assert.equal(b.destination_port, 'Port Said');

  // Everything was supplied, so the next thing asked is the MRN question.
  assert.match(said(r), /Do you already have an MRN/);
  assert.equal(r.state, S.BOOK_MRN_CHOICE);
});

test('a table pasted at the chassis step carries the chassis and the rest', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');

  const r = await h.text(
    'Chassis: YV2RT40A8FB712905\nMake: Volvo\nClient: Delta Trans Egypt\nLoading: Klaipeda\nDestination: Port Said',
  );

  const b = h.booking();
  assert.equal(b.vin, 'YV2RT40A8FB712905');
  assert.equal(b.make, 'Volvo');
  assert.equal(b.customer_name, 'Delta Trans Egypt');
  assert.equal(b.destination_port, 'Port Said');
  assert.match(said(r), /Do you already have an MRN/);
});

test('a pasted chassis still faces the duplicate check, it is not just stored', async () => {
  const h = harness({
    bookings: [{
      booking_ref: 'MKY-BKG-260907-TAKEN', status: 'confirmed', chat_id: OTHER_CHAT,
      vin: 'YV2RT40A8FB712905', make: 'Volvo', customer_name: 'Someone Else',
      origin_port: 'Koper', destination_port: 'Suez Port',
    }],
  });
  await h.command('/start');
  await h.tap('menu:book');

  const r = await h.text('Chassis: YV2RT40A8FB712905\nMake: Volvo\nClient: Delta Trans Egypt\nDestination: Port Said');

  assert.match(said(r), /already booked/);
  assert.match(said(r), /MKY-BKG-260907-TAKEN/);
});

test('a port we do not serve in a paste is said out loud, not silently dropped', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');
  await h.text('YV2RT40A8FB712905');

  const r = await h.text('Make: Volvo\nClient: Delta Trans Egypt\nLoading: Klaipeda\nDestination: Aswan');

  assert.match(said(r), /is not a port we serve/);
  assert.equal(h.booking().make, 'Volvo', 'the valid fields were still taken');
  assert.equal(h.booking().destination_port, undefined);
  assert.equal(r.state, S.BOOK_DESTINATION, 'and it asks for the one it could not accept');
});

test('an ordinary one-word answer is still an answer, not a paste', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');
  await h.text('YV2RT40A8FB712905');
  await h.text('Volvo');

  assert.equal(h.booking().make, 'Volvo');
  assert.equal(h.booking().customer_name, undefined);
});

test('regression: a labelled single row does not put the label in the value', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');

  await h.text('Chassis │ YV2RT40A8FB712905');
  assert.equal(h.booking().vin, 'YV2RT40A8FB712905', 'not "CHASSIS│YV2RT40A8FB712905"');

  await h.text('Make │ Volvo FH 460 Globetrotter');
  assert.equal(h.booking().make, 'Volvo');
  assert.equal(h.booking().model, 'FH 460 Globetrotter');

  await h.text('Client: Delta Trans Egypt');
  assert.equal(h.booking().customer_name, 'Delta Trans Egypt');
});

test('a labelled chassis still faces the duplicate check', async () => {
  const h = harness({
    bookings: [{
      booking_ref: 'MKY-BKG-260907-DUP', status: 'confirmed', chat_id: OTHER_CHAT,
      vin: 'YV2RT40A8FB712905', make: 'Volvo', customer_name: 'Other',
      origin_port: 'Koper', destination_port: 'Suez Port',
    }],
  });
  await h.command('/start');
  await h.tap('menu:book');
  const r = await h.text('Chassis │ YV2RT40A8FB712905');
  assert.match(said(r), /already booked/);
});

// ---------------------------------------------------------------------------
// A ticket needs the problem, not just a phone number
// ---------------------------------------------------------------------------

test('regression: sharing a number asks for the problem instead of raising a ticket', async () => {
  const h = harness();
  await h.tap('menu:contact');
  await h.tap('ct:ops');

  const r = await h.send({ kind: 'contact', phone: '+8801818488624' });

  assert.equal((h.db._tables.support_tickets ?? []).length, 0, 'nothing raised yet');
  assert.match(said(r), /What is the problem/);
  assert.equal(r.state, S.CONTACT_TICKET_DETAILS);

  const done = await h.text('My invoice shows the wrong gross weight for chassis YV2RT40A8FB712905.');

  const tickets = h.db._tables.support_tickets;
  assert.equal(tickets.length, 1);
  assert.match(tickets[0].summary, /wrong gross weight/);
  assert.equal(tickets[0].contact, '+8801818488624');
  assert.doesNotMatch(tickets[0].summary, /asked to speak to someone/);
  assert.match(said(done), /Ticket MKY-TKT-/);
});

test('describing the problem first then sharing a number also works', async () => {
  const h = harness();
  await h.tap('menu:contact');
  await h.tap('ct:ops');

  const asked = await h.text('The vessel on my shipment is wrong.');
  assert.equal((h.db._tables.support_tickets ?? []).length, 0);
  assert.match(said(asked), /phone number/i);

  await h.send({ kind: 'contact', phone: '+201005551234' });

  const tickets = h.db._tables.support_tickets;
  assert.equal(tickets.length, 1);
  assert.match(tickets[0].summary, /vessel on my shipment is wrong/);
  assert.equal(tickets[0].contact, '+201005551234');
});

test('problem and number in one message still raises one ticket', async () => {
  const h = harness();
  await h.tap('menu:contact');
  await h.tap('ct:ops');

  await h.text('My ACID is missing from the paperwork. Call me on +20 100 555 1234');

  const tickets = h.db._tables.support_tickets;
  assert.equal(tickets.length, 1);
  assert.match(tickets[0].summary, /ACID is missing/);
  assert.match(tickets[0].contact, /\+20 100 555 1234/);
});

test('a client who will not give a number still gets a ticket, reachable in the chat', async () => {
  const h = harness();
  await h.tap('menu:contact');
  await h.tap('ct:ops');

  await h.text('The booking reference on my PDF is wrong.');
  const r = await h.text('not now');

  const tickets = h.db._tables.support_tickets;
  assert.equal(tickets.length, 1);
  assert.match(tickets[0].summary, /booking reference on my PDF/);
  assert.equal(tickets[0].contact, 'telegram:555', 'the chat is the contact');
  assert.match(said(r), /Ticket MKY-TKT-/);
});

test('a bare phone number is never mistaken for a problem description', async () => {
  const h = harness();
  await h.tap('menu:contact');
  await h.tap('ct:ops');

  const r = await h.text('+8801818488624');

  assert.equal((h.db._tables.support_tickets ?? []).length, 0);
  assert.match(said(r), /What is the problem/);
});

// ---------------------------------------------------------------------------
// People answer in sentences, not in form fields
// ---------------------------------------------------------------------------

test('regression: a chassis number inside a sentence is accepted', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');

  // The exact message that was refused in the field.
  const r = await h.text('here is my chasis number : WMA06XZZ8KM745219');

  assert.doesNotMatch(said(r), /does not look like a full chassis number/);
  assert.match(said(r), /This unit is new/);
  assert.equal(h.booking().vin, 'WMA06XZZ8KM745219', 'the number, not the sentence');
});

test('a chassis in a sentence still faces the duplicate check', async () => {
  const h = harness({
    bookings: [{
      booking_ref: 'MKY-BKG-260908-TAKEN', status: 'confirmed', chat_id: OTHER_CHAT,
      vin: 'WMA06XZZ8KM745219', make: 'MAN', customer_name: 'Other',
      origin_port: 'Hamburg', destination_port: 'Port Said',
    }],
  });
  await h.command('/start');
  await h.tap('menu:book');
  const r = await h.text('my chassis is WMA06XZZ8KM745219, please book it');
  assert.match(said(r), /already booked/);
});

test('the other fields are read out of a sentence too', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');
  await h.text('chassis WMA06XZZ8KM745219');

  await h.text('it is a MAN TGX 18.500');
  assert.equal(h.booking().make, 'MAN');
  assert.equal(h.booking().model, 'TGX 18.500');

  await h.text('my name is Nile Cargo Egypt');
  assert.equal(h.booking().customer_name, 'Nile Cargo Egypt');

  await h.text('we ship from Hamburg');
  assert.equal(h.booking().origin_port, 'Hamburg');

  const r = await h.text('destination is Port Said please');
  assert.equal(h.booking().destination_port, 'Port Said');
  assert.match(said(r), /Do you already have an MRN/);
});

test('a sentence with no chassis number in it is still refused', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');

  const r = await h.text('I want to book a truck to Alexandria');
  assert.match(said(r), /does not look like a full chassis number/);
  assert.equal(h.booking().vin, undefined);
});

test('a phone number is never mistaken for a chassis number', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');

  const r = await h.text('my number is +20 100 555 1234');
  assert.match(said(r), /does not look like a full chassis number/);
});

test('our own booking reference is not read as a chassis number', async () => {
  const { findVin } = await import('../lib/flow/paste.js');
  assert.equal(findVin('booking MKY-BKG-260907-4YMR chassis WMA06XZZ8KM745219'), 'WMA06XZZ8KM745219');
  assert.equal(findVin('MKY-BKG-260907-4YMR'), null);
});

test('a seventeen-character number wins over other codes in the message', async () => {
  const { findVin } = await import('../lib/flow/paste.js');
  assert.equal(
    findVin('invoice INV2026447 dated 2026-09-08, chassis WMA06XZZ8KM745219, EUR1 AA7567790'),
    'WMA06XZZ8KM745219',
  );
});
