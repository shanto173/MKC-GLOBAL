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

// The desk keeps 9 to 19 Cairo time, which is UTC+2 or UTC+3 depending on the
// season. Each of these lands on the same side of the line either way.
const IN_HOURS = new Date('2026-09-16T12:00:00Z');       // 14:00 or 15:00 in Cairo
const AFTER_HOURS = new Date('2026-09-16T20:00:00Z');    // 22:00 or 23:00
const EARLY_EVENING = new Date('2026-09-16T17:30:00Z');  // 19:30 or 20:30
const BEFORE_HOURS = new Date('2026-09-16T03:00:00Z');   // 05:00 or 06:00

const PHONE = '+20 100 555 1234';
const PHONE_STORED = '+201005551234';

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
    // Pinned, so a test that runs at ten past seven does not find the desk shut.
    now: IN_HOURS,
  };

  const send = (input) => runFlow(input, ctx);

  return {
    db,
    ctx,
    send,
    text: (t) => send({ kind: 'text', text: t }),
    tap: (data) => send({ kind: 'callback', callback: { ...parseCallback(data), id: 'cbq' } }),
    command: (c) => send({ kind: 'command', command: c, text: c }),
    /** A file, as the transport hands it over: with a caption, or as one of a batch. */
    file: (doc, extra = {}) => send({ kind: 'document', document: doc, ...extra }),
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

/** Step 1: starts a booking and answers the two questions about the person. */
async function identify(h, { name = 'Nile Motors', phone = PHONE } = {}) {
  await h.command('/start');
  await h.tap('menu:book');
  await h.text(name);
  return h.text(phone);
}

/** Walks a fresh booking from /start to the confirmation card. */
async function bookUpTo(h, { vin = 'W1T96340310484233', mrn = 'existing', documents = true } = {}) {
  await identify(h);
  await h.text(vin);
  await h.text('Mercedes-Benz');
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
  assert.match(said(r), /Step 1 of 3/);
  assert.match(said(r), /client name/);
  assert.equal(r.state, S.BOOK_CLIENT_NAME);
});

// ---------------------------------------------------------------------------
// Step 1 - who is booking
// ---------------------------------------------------------------------------

test('step 1 asks for the name, then the number, then opens step 2 with the chassis', async () => {
  const h = harness();
  await h.command('/start');
  const start = await h.tap('menu:book');
  assert.match(said(start), /Step 1 of 3/);
  assert.match(said(start), /client name/);
  assert.equal(start.state, S.BOOK_CLIENT_NAME);

  const askedPhone = await h.text('Nile Motors');
  assert.match(said(askedPhone), /mobile number/);
  assert.equal(askedPhone.state, S.BOOK_CLIENT_PHONE);
  // On Telegram the number is asked with the share button, not an inline card.
  assert.ok(askedPhone.messages.some((m) => m.keyboard?.[0]?.[0]?.request_contact === true));

  const askedVin = await h.text(PHONE);
  assert.match(said(askedVin), /Thank you, Nile Motors/);
  assert.match(said(askedVin), /Step 2 of 3/);
  assert.match(said(askedVin), /VIN \/ Chassis number/);
  assert.equal(askedVin.state, S.BOOK_VIN);

  const b = h.booking();
  assert.equal(b.customer_name, 'Nile Motors');
  assert.equal(b.customer_contact, PHONE_STORED, 'one stored shape, whatever was typed');
});

test('the name and the number in one message are both taken', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');

  // The exact message that lost its name in the field.
  const r = await h.text('Ariful and my number is +49 176 67221612');

  const b = h.booking();
  assert.equal(b.customer_name, 'Ariful');
  assert.equal(b.customer_contact, '+4917667221612');
  // One message: the thanks with the number read back, and step 2.
  assert.equal(r.messages.length, 1);
  assert.match(said(r), /Thank you, Ariful — I have \+4917667221612 as your number/);
  assert.match(said(r), /Step 2 of 3/);
  assert.doesNotMatch(said(r), /What I need right now is the client name/);
  assert.equal(r.state, S.BOOK_VIN);
});

test('name and number together, however they are put', async () => {
  for (const [typed, name, phone] of [
    ['my name is Nile Motors and my number is 01005551234', 'Nile Motors', '01005551234'],
    ['Nile Motors, +20 100 555 1234', 'Nile Motors', '+201005551234'],
    ['+20 100 555 1234 Nile Motors', 'Nile Motors', '+201005551234'],
    ['Nile Motors. You can reach me on 0100 555 1234', 'Nile Motors', '01005551234'],
    ['اسمي شركة النيل ورقمي ٠١٠٠٥٥٥١٢٣٤', 'شركة النيل', '01005551234'],
  ]) {
    const h = harness();
    await h.command('/start');
    await h.tap('menu:book');
    const r = await h.text(typed);
    assert.equal(h.booking().customer_name, name, typed);
    assert.equal(h.booking().customer_contact, phone, typed);
    assert.equal(r.state, S.BOOK_VIN, typed);
  }
});

test('regression: "Ariful is my name" stores the name, not the sentence', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');

  const r = await h.text('Ariful is my name');
  assert.equal(h.booking().customer_name, 'Ariful');
  assert.match(said(r), /mobile number/);
});

test('the name is read out of the ways people say it', async () => {
  const { extractField } = await import('../lib/flow/paste.js');
  for (const [typed, name] of [
    ['Ariful is my name', 'Ariful'],
    ['Nile Motors is the client', 'Nile Motors'],
    ['Ariful here', 'Ariful'],
    ["I'm Ariful", 'Ariful'],
    ['I am Ariful', 'Ariful'],
    ['this is Ariful', 'Ariful'],
    ['my name is Ariful.', 'Ariful'],
    ['أنا عارف', 'عارف'],
    ['عارف اسمي', 'عارف'],
    ['اسمي عارف', 'عارف'],
    // A word for the client at the end of a company's name is part of the name.
    ['Cairo Trading Company', 'Cairo Trading Company'],
    ['Nile Cargo Egypt', 'Nile Cargo Egypt'],
    ['Alexandria Trading Co', 'Alexandria Trading Co'],
  ]) {
    assert.equal(extractField('customer_name', typed), name, typed);
  }
  assert.equal(extractField('make', 'Mercedes is the make'), 'Mercedes');
  assert.equal(extractField('make', 'Volvo FH 460'), 'Volvo FH 460');
});

test('a number alone at the name question is kept, and the name still asked', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');

  const r = await h.text('call me on +20 100 555 1234');
  assert.equal(h.booking().customer_contact, PHONE_STORED);
  assert.equal(h.booking().customer_name, undefined, '"call me on" is not a name');
  assert.match(said(r), /client name/);
  assert.equal(r.state, S.BOOK_CLIENT_NAME);
});

test('a make and a new number in one message are both taken', async () => {
  const h = harness();
  await identify(h);
  await h.text('W1T96340310484233');

  const r = await h.text('MAN and my number is +20 122 000 9999');
  assert.equal(h.booking().make, 'MAN');
  assert.equal(h.booking().customer_contact, '+201220009999');
  assert.match(said(r), /\+201220009999 is your number/);
  assert.match(said(r), /port of loading/i);
  assert.equal(r.state, S.BOOK_POL);
});

test('the number shared through Telegram\'s button answers the phone question', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');
  await h.text('Nile Motors');

  const r = await h.send({ kind: 'contact', phone: '+201005551234' });

  assert.equal(r.state, S.BOOK_VIN);
  assert.equal(h.booking().customer_contact, '+201005551234');
  // And it goes on the person's record, for next time.
  assert.equal(h.db._tables.clients[0].phone, '+201005551234');
});

test('a number typed in Arabic digits, or without a country code, is understood', async () => {
  for (const [typed, stored] of [['٠١٠٠٥٥٥١٢٣٤', '01005551234'], ['0100 555 1234', '01005551234'],
                                 ['0020 100 555 1234', '+201005551234'], ['my number is +20 100 555 1234', '+201005551234']]) {
    const h = harness();
    await h.command('/start');
    await h.tap('menu:book');
    await h.text('Nile Motors');
    const r = await h.text(typed);
    assert.equal(h.booking().customer_contact, stored, typed);
    assert.equal(r.state, S.BOOK_VIN, typed);
  }
});

test('something that is not a number is refused, and the number asked for again', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');
  await h.text('Nile Motors');

  const r = await h.text('soon');
  assert.match(said(r), /does not look like a phone number/);
  assert.equal(r.state, S.BOOK_CLIENT_PHONE);
  assert.notEqual(h.booking().customer_contact, 'soon');
});

test('the number on file is offered back, and "yes" takes it', async () => {
  const h = harness();
  h.db._tables.clients[0].phone = '+201112223334';

  await h.command('/start');
  await h.tap('menu:book');
  const asked = await h.text('Nile Motors');
  assert.match(said(asked), /\+201112223334 is still your number/);

  const r = await h.text('yes');
  assert.equal(h.booking().customer_contact, '+201112223334');
  assert.equal(r.state, S.BOOK_VIN);
});

test('a number is never suggested when there is none on file', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');
  const asked = await h.text('Nile Motors');
  assert.doesNotMatch(said(asked), /still your number/);
});

test('a chassis pasted at the name step still faces the duplicate check', async () => {
  const h = harness({
    bookings: [{
      booking_ref: 'MKY-BKG-260907-TAKEN', status: 'confirmed', chat_id: OTHER_CHAT,
      vin: 'YV2RT40A8FB712905', make: 'Volvo', customer_name: 'Someone Else',
      origin_port: 'Koper', destination_port: 'Suez Port',
    }],
  });
  await h.command('/start');
  await h.tap('menu:book');

  // The whole block, at the very first question. The chassis in it is looked
  // up, not written down - and this one is taken.
  const r = await h.text('Chassis: YV2RT40A8FB712905\nMake: Volvo\nClient: Delta Trans Egypt\nPhone: +20 100 555 1234\nDestination: Port Said');

  assert.match(said(r), /already booked/);
  assert.match(said(r), /MKY-BKG-260907-TAKEN/);
  assert.equal(r.state, S.MAIN_MENU);
});

test('a chassis mentioned at the name step is checked, kept, and the name still asked', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');

  const r = await h.text('W1T96340310484233');
  assert.equal(h.booking().vin, 'W1T96340310484233');
  assert.match(said(r), /Noted/);
  assert.match(said(r), /client name/);
  assert.equal(r.state, S.BOOK_CLIENT_NAME);
});

test('a block with everything in it, pasted at the name step, goes straight to the MRN question', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');

  const r = await h.text(
    'Client: Nile Cargo Egypt\nMobile: +20 100 555 1234\nChassis: WMA06XZZ8KM745219\nMake: MAN\nLoading: Hamburg\nDestination: Port Said',
  );

  const b = h.booking();
  assert.equal(b.customer_name, 'Nile Cargo Egypt');
  assert.equal(b.customer_contact, PHONE_STORED);
  assert.equal(b.vin, 'WMA06XZZ8KM745219');
  assert.equal(b.destination_port, 'Port Said');
  assert.match(said(r), /Do you already have an MRN/);
  assert.equal(r.state, S.BOOK_MRN_CHOICE);
});

test('a number shared while another question is open is kept, and that question asked again', async () => {
  const h = harness();
  await identify(h);
  await h.text('W1T96340310484233');
  // Being asked for the make; the client taps "share my number" instead.
  const r = await h.send({ kind: 'contact', phone: '+201222333444' });

  assert.equal(h.booking().customer_contact, '+201222333444');
  assert.match(said(r), /Make \/ Brand/);
  assert.equal(r.state, S.BOOK_MAKE);
  // It did NOT become a support ticket.
  assert.equal((h.db._tables.support_tickets ?? []).length, 0);
});

// ---------------------------------------------------------------------------
// 2-4 - the chassis check
// ---------------------------------------------------------------------------

test('TEST 2 - an unknown chassis is new, and moves on to the make', async () => {
  const h = harness();
  await identify(h);
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
  await identify(h);
  const r = await h.text('W1T96340310484233');

  assert.match(said(r), /already in our system/);
  assert.match(said(r), /Nothing is blocking it/);
  // The make we already hold is not asked for again.
  assert.equal(h.booking().make, 'Scania');
  assert.equal(r.state, S.BOOK_POL);
});

test('TEST 4 - an already-booked chassis is refused, with reference and route', async () => {
  const h = harness({
    bookings: [{
      booking_ref: 'MKY-BKG-260901-AAAA', status: 'confirmed', chat_id: OTHER_CHAT,
      vin: 'W1T96340310484233', make: 'Volvo', customer_name: 'Someone Else',
      origin_port: 'Klaipeda', destination_port: 'Port Said',
    }],
  });
  await identify(h);
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
  await identify(h);
  const r = await h.text('w1t 9634-0310 484233');
  assert.match(said(r), /already booked/);
});

test('something that is not a chassis number is rejected, not stored', async () => {
  const h = harness();
  await identify(h);
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
  await identify(h);
  await h.text('W1T96340310484233');
  await h.text('Mercedes-Benz');
  const r = await h.text('Vilnius');

  assert.match(said(r), /Egyptian destination port/);
  assert.doesNotMatch(said(r), /We are missing some information/);
  assert.equal(r.state, S.BOOK_DESTINATION);
});

test('TEST 6 - several missing fields are listed before the first is asked', async () => {
  const h = harness();
  await identify(h);
  const r = await h.text('W1T96340310484233');

  assert.match(said(r), /We are missing some information/);
  assert.match(said(r), /Make \/ Brand/);
  assert.match(said(r), /Port of loading/);
  assert.match(said(r), /Destination/);
  // Step 1 is done; it is not listed as if it were still to come.
  assert.doesNotMatch(said(r), /Client name/);
  assert.doesNotMatch(said(r), /Mobile number/);
});

test('a destination we do not serve is refused with the list of ones we do', async () => {
  const h = harness();
  await identify(h);
  await h.text('W1T96340310484233');
  await h.text('Mercedes-Benz');
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
  await h.text('Nile Motors');
  assert.equal(h.booking().customer_name, 'Nile Motors');
  await h.text(PHONE);
  assert.equal(h.booking().customer_contact, PHONE_STORED);
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
  await identify(h2);
  await h2.text('W1T96340310484233');
  await h2.text('Mercedes-Benz');
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

test('TEST 11 - all documents present advances to the confirmation card, step 3', async () => {
  const h = harness();
  const r = await bookUpTo(h);

  assert.match(said(r), /We have everything we need/);
  assert.match(said(r), /Step 3 of 3/);
  assert.match(said(r), /Please confirm your booking details/);
  assert.match(said(r), /W1T96340310484233/);
  // The card shows the person as well as the vehicle - it is what they agree to.
  assert.match(said(r), /Nile Motors/);
  assert.match(said(r), /\+201005551234/);
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
// Everything in one message, with the papers attached
// ---------------------------------------------------------------------------

test('step 2 tells the client they may send it all at once, with the documents attached', async () => {
  const h = harness();
  const r = await identify(h);
  assert.match(said(r), /send it all in one message/i);
  assert.match(said(r), /attach the documents/i);
  assert.match(said(r), /VIN \/ Chassis number/);
  // One message, not an intro and then a question.
  assert.equal(r.messages.length, 1);
});

test('the details written on a file are read, and the file counted, in one go', async () => {
  const h = harness();
  await identify(h);

  const r = await h.file(h.upload('invoice', { vin: 'W1T96340310484233' }), {
    caption: 'Chassis: W1T96340310484233\nMake: MAN TGX\nLoading: Hamburg\nDestination: Port Said',
  });

  const b = h.booking();
  assert.equal(b.vin, 'W1T96340310484233');
  assert.equal(b.make, 'MAN');
  assert.equal(b.origin_port, 'Hamburg');
  assert.equal(b.destination_port, 'Port Said');
  assert.match(said(r), /Received: Invoice/);
  assert.match(said(r), /Noted from your message: chassis W1T96340310484233 · make MAN TGX · route Hamburg → Port Said/);
  // Nothing basic is missing any more, so the next question is the MRN one.
  assert.match(said(r), /Do you already have an MRN/);
  assert.equal(r.state, S.BOOK_MRN_CHOICE);
});

test('the caption is read ahead of the file, and the file then only counts', async () => {
  const h = harness();
  await identify(h);

  // The transport reads the caption the moment the file is recorded.
  const absorbed = await h.send({
    kind: 'caption',
    text: 'Rotterdam to Damietta. DAF XF 480 FT, client Giza Freight Lines, chassis XLRTEH4350G741552',
  });
  assert.deepEqual(absorbed.messages, [], 'nothing said yet - the file has not been read');

  const b = h.booking();
  assert.equal(b.vin, 'XLRTEH4350G741552');
  assert.equal(b.make, 'DAF');
  assert.equal(b.model, 'XF 480 FT');
  assert.equal(b.origin_port, 'Rotterdam');
  assert.equal(b.destination_port, 'Damietta Port');
  assert.equal(b.customer_name, 'Giza Freight Lines');

  // Then the three files, the last of which speaks.
  const docs = ['brief', 'invoice', 'mrn'].map((t) => h.upload(t, { vin: 'XLRTEH4350G741552' }));
  const r = await h.file(docs[2], { speak: true, batch: docs.map((d) => ({ ...d.document, file_name: 'f.pdf' })) });
  assert.match(said(r), /Received: Brief, Invoice, MRN/);
  // And what the caption said, read back in the same message - whichever of
  // the three files ended up speaking.
  assert.match(said(r), /Noted from your message: client Giza Freight Lines · chassis XLRTEH4350G741552 · make DAF XF 480 FT · route Rotterdam → Damietta Port/);
  assert.doesNotMatch(said(r), /Make \/ Brand/, 'it was in the caption');
  assert.doesNotMatch(said(r), /send it all in one message/, 'the step-2 opening is not repeated');
  assert.match(said(r), /We have everything we need/);
  assert.equal(r.state, S.BOOK_FINAL_CONFIRMATION);
  assert.equal(h.db._tables.conversation_sessions[0].context.caption_noted, undefined, 'read back once, then forgotten');
});

test('the same sentence typed at the chassis question fills every field it names', async () => {
  const h = harness();
  await identify(h);
  const r = await h.text('Rotterdam to Damietta. DAF XF 480 FT, client Giza Freight Lines, chassis XLRTEH4350G741552');

  const b = h.booking();
  assert.equal(b.vin, 'XLRTEH4350G741552');
  assert.equal(b.make, 'DAF');
  assert.equal(b.origin_port, 'Rotterdam');
  assert.equal(b.destination_port, 'Damietta Port');
  assert.equal(b.customer_name, 'Giza Freight Lines');
  assert.match(said(r), /This unit is new/);
  assert.match(said(r), /Noted from your message: client Giza Freight Lines · make DAF XF 480 FT · route Rotterdam → Damietta Port/);
  assert.match(said(r), /Do you already have an MRN/);
});

test('a make and a client are read out of a sentence, and a place is not made a city by accident', async () => {
  const { makeIn, nameIn } = await import('../lib/flow/paste.js');
  const { fieldsIn } = await import('../lib/flow/understand.js');
  assert.equal(makeIn('DAF XF 480 FT, client Giza Freight Lines'), 'DAF XF 480 FT');
  assert.equal(makeIn('its a big scania'), 'scania');
  assert.equal(makeIn('a MAN TGX 18.500 for Nile Cargo Egypt'), 'MAN TGX 18.500');
  assert.equal(makeIn('Volvo FH 460 Globetrotter from Klaipeda'), 'Volvo FH 460 Globetrotter');
  assert.equal(makeIn('nothing here'), null);
  assert.equal(nameIn('client Giza Freight Lines, chassis X'), 'Giza Freight Lines');
  assert.equal(nameIn('for Nile Cargo Egypt. The chassis is'), null, '"for" alone is too loose');
  assert.equal(nameIn('consignee: Horus Logistics'), 'Horus Logistics');
  assert.equal(fieldsIn('Rotterdam to Damietta').origin_port, 'Rotterdam');
  assert.equal(fieldsIn('I want to book a truck to Alexandria').origin_port, undefined);
});

test('a chassis written on a file that is already booked ends the flow there', async () => {
  const h = harness({
    bookings: [{
      booking_ref: 'MKY-BKG-260907-TAKEN', status: 'confirmed', chat_id: OTHER_CHAT,
      vin: 'YV2RT40A8FB712905', make: 'Volvo', customer_name: 'Someone Else',
      origin_port: 'Koper', destination_port: 'Suez Port',
    }],
  });
  await identify(h);
  const r = await h.file(h.upload('invoice', { vin: 'YV2RT40A8FB712905' }), {
    caption: 'Chassis: YV2RT40A8FB712905\nMake: Volvo',
  });
  assert.match(said(r), /already booked/);
  assert.match(said(r), /MKY-BKG-260907-TAKEN/);
  assert.equal(r.state, S.MAIN_MENU);
});

test('a paper sent before the chassis is kept, and the chassis asked for next', async () => {
  const h = harness();
  await identify(h);

  const r = await h.file(h.upload('invoice', { vin: 'W1T96340310484233' }));

  assert.match(said(r), /Invoice received/);
  assert.match(said(r), /VIN \/ Chassis number/);
  assert.equal(r.state, S.BOOK_VIN, 'back to the next thing missing, not stuck at the document step');
  // And the file is still counted once the chassis is in.
  await h.text('W1T96340310484233');
  await h.text('Mercedes-Benz');
  await h.text('Vilnius');
  await h.text('Alexandria');
  const docs = await h.tap('bk:mrn:existing');
  assert.doesNotMatch(said(docs), /• Invoice/);
  assert.match(said(docs), /Brief/);
});

test('three papers sent together get one answer, once all of them are read', async () => {
  const h = harness();
  await bookUpTo(h, { documents: false });

  const invoice = h.upload('invoice', { vin: 'W1T96340310484233', fileName: 'invoice.pdf' });
  const brief = h.upload('brief', { vin: 'W1T96340310484233', fileName: 'cmr.pdf' });
  const mrn = h.upload('mrn', { vin: 'W1T96340310484233', fileName: 'mrn.pdf' });
  const batch = [invoice, brief, mrn].map((d) => ({ ...d.document, file_name: 'x.pdf' }));

  // The first two finished reading while a sibling was still being read: they
  // say nothing and leave the flow exactly where it was.
  const quiet = await h.file(invoice, { speak: false, batch: [] });
  assert.deepEqual(quiet.messages, []);
  assert.equal(quiet.state, S.BOOK_DOCUMENTS);
  assert.ok(quiet.offered.length, 'the last buttons offered are remembered, not wiped');

  // The last to finish answers for all three.
  const r = await h.file(mrn, { speak: true, batch });
  assert.match(said(r), /Received: Invoice, Brief, MRN/);
  assert.doesNotMatch(said(r), /Just a little more/);
  assert.doesNotMatch(said(r), /Almost there/);
  assert.match(said(r), /We have everything we need/);
  assert.equal(r.state, S.BOOK_FINAL_CONFIRMATION);
});

test('readers that finish together race for one reply, and exactly one wins', async () => {
  const h = harness();
  const { claimReply } = await import('../lib/documents.js');

  // Three siblings, all done at once, all looking at the same three files.
  const first = await claimReply(CHAT, [11, 12, 13]);
  const second = await claimReply(CHAT, [13, 11, 12]);
  const third = await claimReply(CHAT, [12, 13, 11]);
  assert.deepEqual([first, second, third], [true, false, false]);

  // A fourth file, arriving after those were answered, is a new set.
  assert.equal(await claimReply(CHAT, [11, 12, 13, 14]), true);
  // Another chat's files are its own business.
  assert.equal(await claimReply(OTHER_CHAT, [11, 12, 13]), true);

  // Recorded as already sent, so the outbox drain never tries to deliver it.
  const rows = h.outbox().filter((o) => o.event_type === 'document_reply');
  assert.equal(rows.length, 3);
  assert.ok(rows.every((o) => o.status === 'sent'));
});

test('"Ariful, this is my number …" leaves the name, not "Ariful this is"', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');
  await h.text('Ariful, this is my number +49 176 67221612');
  assert.equal(h.booking().customer_name, 'Ariful');
  assert.equal(h.booking().customer_contact, '+4917667221612');
});

test('a file that could not be read, among several, is asked about in turn', async () => {
  const h = harness();
  await bookUpTo(h, { documents: false });

  const invoice = h.upload('invoice', { vin: 'W1T96340310484233' });
  const first = h.upload('other', { vin: 'W1T96340310484233', fileName: 'scan-1.pdf' });
  const second = h.upload('other', { vin: 'W1T96340310484233', fileName: 'scan-2.pdf' });
  const batch = [
    { ...invoice.document, file_name: 'invoice.pdf' },
    { ...first.document, file_name: 'scan-1.pdf' },
    { ...second.document, file_name: 'scan-2.pdf' },
  ];

  const r = await h.file(second, { speak: true, batch });
  assert.match(said(r), /Received: Invoice/);
  assert.match(said(r), /I have scan-1\.pdf, but I am not sure what it is/);
  assert.equal(r.state, S.BOOK_DOCUMENT_CLASSIFY);

  const next = await h.tap('bk:doctype:brief');
  assert.match(said(next), /Brief received/);
  assert.match(said(next), /I have scan-2\.pdf, but I am not sure what it is/);
  assert.equal(next.state, S.BOOK_DOCUMENT_CLASSIFY);

  const done = await h.tap('bk:doctype:mrn');
  assert.match(said(done), /MRN received/);
  assert.match(said(done), /We have everything we need/);
  assert.equal(done.state, S.BOOK_FINAL_CONFIRMATION);
});

test('an MRN among the papers answers the MRN question', async () => {
  const h = harness();
  await identify(h);
  await h.text('W1T96340310484233');
  await h.text('Mercedes-Benz');
  await h.text('Vilnius');
  const asked = await h.text('Alexandria');
  assert.equal(asked.state, S.BOOK_MRN_CHOICE);

  const docs = ['invoice', 'brief', 'mrn'].map((t) => h.upload(t, { vin: 'W1T96340310484233' }));
  const r = await h.file(docs[2], { speak: true, batch: docs.map((d) => ({ ...d.document, file_name: 'f.pdf' })) });

  assert.equal(h.booking().mrn_choice, 'existing', 'they sent one, so they have one');
  assert.doesNotMatch(said(r), /Do you already have an MRN/);
  assert.match(said(r), /We have everything we need/);
  assert.equal(r.state, S.BOOK_FINAL_CONFIRMATION);
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

  // The client gets their reference in the message that answers the yes, and
  // the PDF copy is queued to follow it.
  assert.match(said(r), new RegExp(`Your booking reference: ${b.booking_ref}`));
  assert.equal(h.outbox().filter((o) => o.event_type === 'booking_request_pdf').length, 1);
  // Not the same confirmation twice: the text is sent once, by the transport.
  assert.equal(h.outbox().filter((o) => o.event_type === 'booking_request_submitted').length, 0);

  const tasks = h.tasks().filter((t) => t.task_type === 'new_booking_request');
  assert.equal(tasks.length, 1);
});

test('the edit menu offers the phone number, and editing it returns to the card', async () => {
  const h = harness();
  await bookUpTo(h);
  const menu = await h.tap('bk:edit');
  assert.ok(buttons(menu).includes('bk:edit:phone'));

  const asked = await h.tap('bk:edit:phone');
  assert.match(said(asked), /mobile number/);
  assert.equal(asked.state, S.BOOK_EDIT_CLIENT_PHONE);

  const r = await h.text('+20 122 000 9999');
  assert.match(said(r), /Information updated successfully/);
  assert.match(said(r), /\+201220009999/);
  assert.equal(h.booking().customer_contact, '+201220009999');
  assert.equal(r.state, S.BOOK_FINAL_CONFIRMATION);
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
  assert.equal(h.outbox().filter((o) => o.event_type === 'booking_request_pdf').length, 1);
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
  assert.equal(b.customer_contact, PHONE_STORED);
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

test('tracking finds it when the chassis arrives with its label attached', async () => {
  const h = harness({ shipments: [SHIPMENT] });
  await h.tap('menu:track');

  // What the demo sheet tells people to send, and what anyone copying the line
  // out of their own booking card sends. normalizeVin() strips the separator,
  // so this used to be looked up as CHASSISW1T96340310484233 and the client was
  // told we had never heard of the booking we had just confirmed for them.
  const r = await h.text('Chassis: W1T96340310484233');
  assert.match(said(r), /MKY-26001/);
});

test('tracking finds it inside a sentence, and in Arabic', async () => {
  for (const sent of ['my chassis is W1T96340310484233',
                      'رقم الشاسيه W1T96340310484233',
                      'booking MKY-BKG-260901-DDDD please']) {
    const h = harness({ shipments: [SHIPMENT] });
    await h.tap('menu:track');
    const r = await h.text(sent);
    assert.match(said(r), /MKY-26001/, sent);
  }
});

test('extracting the identifier does not widen who may see it', async () => {
  // The lookup got broader; access must not have. A stranger quoting the label
  // form gets the same answer as a stranger quoting anything else.
  const h = harness({ shipments: [{ ...SHIPMENT, chat_id: OTHER_CHAT, booking_ref: null }] });
  await h.tap('menu:track');
  const r = await h.text('Chassis: W1T96340310484233');
  assert.match(said(r), /could not find a shipment/);
});

test('punctuation in the identifier cannot reshape the query', async () => {
  // Candidates are interpolated into a PostgREST or() expression, so anything
  // that is not part of a reference is stripped before it gets there.
  const h = harness({ shipments: [SHIPMENT] });
  await h.tap('menu:track');
  const r = await h.text('AAAA,vin_norm.neq.ZZZZ');
  assert.match(said(r), /could not find a shipment/);
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

test('TEST 22-25 - "Talk to an agent" goes straight to the agent, no menu first', async () => {
  const h = harness();
  const r = await h.tap('menu:contact');

  assert.match(said(r), /Connecting you with our Operations Team/);
  assert.doesNotMatch(said(r), /What do you need help with/);
  assert.match(said(r), /To open this with the team/);
  assert.equal(r.state, S.CONTACT_TICKET_DETAILS);
  // Logged for the desk before the client has typed a word.
  assert.equal(h.tasks().filter((t) => t.task_type === 'client_callback').length, 1);
});

test('a client whose number is on file is not asked for it again', async () => {
  const h = harness();
  h.db._tables.clients[0].phone = '+201005551234';

  const r = await h.tap('menu:contact');
  assert.match(said(r), /I have your number \(\+201005551234\)/);
  assert.doesNotMatch(said(r), /A phone number we can call you on/);

  const done = await h.text('The vessel on my shipment is wrong.');
  assert.match(said(done), /Ticket MKY-TKT-/);
  const tickets = h.db._tables.support_tickets;
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].contact, '+201005551234');
  assert.match(tickets[0].summary, /vessel on my shipment is wrong/);
});

test('the number given in step 1 of a booking serves the next request for an agent', async () => {
  const h = harness();
  await bookUpTo(h);
  await h.tap('bk:confirm');

  await h.command('/menu');
  const r = await h.tap('menu:contact');
  assert.match(said(r), /I have your number \(\+201005551234\)/);

  await h.text('My invoice shows the wrong gross weight.');
  assert.equal(h.db._tables.support_tickets[0].contact, PHONE_STORED);
});

const afterHoursTap = (h, data, now = AFTER_HOURS) => runFlow(
  { kind: 'callback', callback: { ...parseCallback(data), id: 'cbq' } },
  { ...h.ctx, now },
);

test('after 7 PM the bot says when the desk is back, and asks whether it is urgent', async () => {
  const h = harness();
  h.db._tables.bot_settings.push({ key: 'direct_phone', value: '+48 512 345 678' });
  invalidateSettings();

  const r = await afterHoursTap(h, 'menu:contact');

  assert.match(said(r), /available from 9 AM to 7 PM Cairo time/);
  assert.match(said(r), /tomorrow from 9 AM/);
  assert.match(said(r), /Is it urgent/);
  assert.deepEqual(buttons(r), ['ct:urgent:yes', 'ct:urgent:no', 'menu:home']);
  // The direct line is not read out to everyone - only to somebody who says
  // it cannot wait.
  assert.doesNotMatch(said(r), /512 345 678/);
  assert.doesNotMatch(said(r), /Connecting you with our Operations Team/);
  assert.doesNotMatch(said(r), /sentence or two/, 'no lecturing about length');
  // Still logged, so the first agent in has it.
  const task = h.tasks().find((t) => t.task_type === 'client_callback');
  assert.equal(task.payload.after_hours, true);
  assert.equal(r.state, S.CONTACT_URGENCY);
});

test('urgent after hours: the responsible person\'s number, then the emergency, then a ticket marked urgent', async () => {
  const h = harness();
  h.db._tables.bot_settings.push({ key: 'direct_phone', value: '+48 512 345 678' });
  h.db._tables.clients[0].phone = '+201005551234';
  invalidateSettings();

  await afterHoursTap(h, 'menu:contact');
  const yes = await afterHoursTap(h, 'ct:urgent:yes');
  assert.match(said(yes), /reach our responsible person directly on \+48 512 345 678, any time/);
  assert.match(said(yes), /what the emergency is about/);
  assert.doesNotMatch(said(yes), /phone number we can call you on/, 'the number is on file');
  assert.equal(yes.state, S.CONTACT_TICKET_DETAILS);

  const done = await h.text('My truck is stuck at the port and the driver has no papers.');
  const ticket = h.db._tables.support_tickets[0];
  assert.match(ticket.summary, /^URGENT: My truck is stuck/);
  assert.equal(ticket.contact, '+201005551234');
  const task = h.tasks().find((t) => t.payload?.ticket_ref === ticket.ticket_ref);
  assert.equal(task.priority, 'high');
  assert.equal(task.payload.urgent, true);
  assert.match(said(done), /marked urgent/);
  assert.match(said(done), /tomorrow from 9 AM/);
  assert.match(said(done), /responsible person is on \+48 512 345 678/);
});

test('not urgent after hours: the question, and when the desk is back', async () => {
  const h = harness();
  h.db._tables.clients[0].phone = '+201005551234';

  await afterHoursTap(h, 'menu:contact');
  const no = await afterHoursTap(h, 'ct:urgent:no');
  assert.match(said(no), /Tell me what you need help with/);
  assert.match(said(no), /tomorrow from 9 AM/);
  assert.doesNotMatch(said(no), /responsible person/);

  const done = await h.text('The vessel on my shipment is wrong.');
  const ticket = h.db._tables.support_tickets[0];
  assert.doesNotMatch(ticket.summary, /URGENT/);
  assert.match(said(done), /Ticket MKY-TKT-/);
  assert.match(said(done), /tomorrow from 9 AM/);
  assert.doesNotMatch(said(done), /marked urgent/);
});

test('typing the emergency instead of tapping is understood, and marked urgent when it says so', async () => {
  const h = harness();
  h.db._tables.bot_settings.push({ key: 'direct_phone', value: '+48 512 345 678' });
  h.db._tables.clients[0].phone = '+201005551234';
  invalidateSettings();

  await afterHoursTap(h, 'menu:contact');
  const r = await h.text('Emergency: customs are holding my truck at Damietta right now.');
  const ticket = h.db._tables.support_tickets[0];
  assert.match(ticket.summary, /^URGENT: Emergency: customs/);
  assert.match(said(r), /responsible person is on \+48 512 345 678/);

  const h2 = harness();
  h2.db._tables.clients[0].phone = '+201005551234';
  await afterHoursTap(h2, 'menu:contact');
  await h2.text('no');
  const r2 = await h2.text('I need a copy of my booking PDF again.');
  assert.doesNotMatch(h2.db._tables.support_tickets[0].summary, /URGENT/);
  assert.match(said(r2), /Ticket MKY-TKT-/);
});

test('before 9 AM it is "today from 9 AM", not tomorrow', async () => {
  const h = harness();
  const r = await runFlow(
    { kind: 'callback', callback: { ...parseCallback('menu:contact'), id: 'cbq' } },
    { ...h.ctx, now: BEFORE_HOURS },
  );
  assert.match(said(r), /today from 9 AM/);
});

test('urgent after hours with no direct number configured: flagged, and no number invented', async () => {
  const h = harness();      // direct_phone and operations_phone both unset
  await afterHoursTap(h, 'menu:contact');
  const r = await afterHoursTap(h, 'ct:urgent:yes');
  assert.match(said(r), /flagged your request as urgent/);
  assert.match(said(r), /what the emergency is about/);
  assert.doesNotMatch(said(r), /responsible person directly/);
  assert.doesNotMatch(said(r), /\+20|\+48/);
});

test('the placeholder number from .env.example is never read out as the direct line', async () => {
  const h = harness();
  h.db._tables.bot_settings.push({ key: 'direct_phone', value: '+20 3 555 0143' });
  invalidateSettings();
  await afterHoursTap(h, 'menu:contact');
  const r = await afterHoursTap(h, 'ct:urgent:yes');
  assert.doesNotMatch(said(r), /555 0143/);
  assert.match(said(r), /flagged your request as urgent/);
});

test('the desk hours come from settings, so early evening is inside a desk that closes at 11', async () => {
  const h = harness();
  const closed = await runFlow(
    { kind: 'callback', callback: { ...parseCallback('menu:contact'), id: 'cbq' } },
    { ...h.ctx, now: EARLY_EVENING },
  );
  assert.match(said(closed), /outside those hours/, 'after 7 PM by default');

  h.db._tables.bot_settings.push({ key: 'support_hours_end', value: 23 });
  invalidateSettings();
  const open = await runFlow(
    { kind: 'callback', callback: { ...parseCallback('menu:contact'), id: 'cbq' } },
    { ...h.ctx, now: EARLY_EVENING },
  );
  assert.match(said(open), /Connecting you with our Operations Team/, 'but not once the desk closes at 11');
});

test('the older contact routes still answer a button on an old card', async () => {
  const h = harness();
  const r = await h.tap('ct:docs');
  assert.match(said(r), /What do you need help with/);
  assert.deepEqual(buttons(r), ['ct:docs:upload', 'ct:docs:missing', 'ct:docs:request', 'ct:docs:other', 'menu:home']);
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
  await h.tap('ct:booking');
  const r = await h.text('MKY-BKG-260901-GGGG');

  assert.match(said(r), /could not find/);
  assert.doesNotMatch(said(r), /Someone Else/);
});

test('TEST 24 - contact/documents computes what is missing from the database', async () => {
  const h = harness();
  await bookUpTo(h, { documents: false });
  await h.file(h.upload('invoice', { vin: 'W1T96340310484233' }));

  await h.tap('ct:docs');
  const r = await h.tap('ct:docs:missing');

  assert.match(said(r), /Brief/);
  assert.match(said(r), /MRN/);
  assert.doesNotMatch(said(r), /Invoice/);
});

test('TEST 25 - Talk to an agent never invents a phone number', async () => {
  const h = harness();      // operations_phone is null and OPERATIONS_PHONE is unset
  const r = await h.tap('menu:contact');

  assert.match(said(r), /Connecting you with our Operations Team/);
  assert.match(said(r), /has not been configured/);
  assert.doesNotMatch(said(r), /\+20/);

  // The request is still recorded, so the desk can call back.
  assert.equal(h.tasks().filter((t) => t.task_type === 'client_callback').length, 1);
});

test('Talk to an agent gives the configured number when there is one', async () => {
  const h = harness();
  h.db._tables.bot_settings.find((s) => s.key === 'operations_phone').value = '+20 3 111 2222';
  invalidateSettings();

  const r = await h.tap('menu:contact');
  assert.match(said(r), /\+20 3 111 2222/);
});

test('the old "Contact Operations" button on a tracking card still reaches the agent', async () => {
  const h = harness();
  const r = await h.tap('ct:ops');
  assert.match(said(r), /Connecting you with our Operations Team/);
});

test('a contact request becomes a ticket with the problem and the number', async () => {
  const h = harness();
  await h.tap('menu:contact');
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
  await identify(h);
  await h.text('W1T96340310484233');
  await h.text('Mercedes-Benz');

  // Everything in memory is gone; only Postgres remains. A new invocation must
  // pick up exactly where the last one stopped.
  const fresh = { ...h.ctx };
  const resumed = await runFlow({ kind: 'text', text: 'Vilnius' }, fresh);

  assert.equal(resumed.state, S.BOOK_DESTINATION);
  assert.equal(h.booking().origin_port, 'Vilnius');
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

test('regression: "start over" and cancel clear every leftover draft, not only the newest', async () => {
  // Two abandoned attempts from earlier sit in the chat. Cancelling only the
  // newest brought the older one back as "an unfinished booking request".
  const stale = (ref, daysAgo, extra = {}) => ({
    booking_ref: ref, status: 'draft', chat_id: CHAT, client_id: 1,
    customer_name: 'Old Attempt', vin: null,
    created_at: new Date(Date.now() - daysAgo * 3_600_000).toISOString(),
    ...extra,
  });
  const h = harness({ bookings: [stale('MKY-BKG-260914-OLD1', 20), stale('MKY-BKG-260916-OLD2', 2)] });

  await h.command('/start');
  const offered = await h.tap('menu:book');
  assert.match(said(offered), /MKY-BKG-260916-OLD2/, 'the newest is offered');

  const fresh = await h.tap('bk:draft:restart');
  assert.match(said(fresh), /client name/);
  const drafts = h.bookings().filter((b) => b.status === 'draft');
  assert.equal(drafts.length, 1, 'one live draft, the new one');
  assert.ok(h.bookings().every((b) => !b.booking_ref.includes('OLD') || b.status === 'cancelled'), 'both old ones cancelled');

  // Cancelling the new one leaves nothing behind either.
  await h.text('Nile Motors');
  await h.command('/cancel');
  await h.tap('bk:cancel:yes');
  assert.equal(h.bookings().filter((b) => b.status === 'draft').length, 0);
  const again = await h.tap('menu:book');
  assert.doesNotMatch(said(again), /unfinished booking request/);
  assert.match(said(again), /client name/);
});

test('a leftover draft with nothing on it is simply reused, not offered back', async () => {
  const h = harness({
    bookings: [{ booking_ref: 'MKY-BKG-260916-NONE', status: 'draft', chat_id: CHAT, client_id: 1 }],
  });
  await h.command('/start');
  const r = await h.tap('menu:book');
  assert.doesNotMatch(said(r), /unfinished booking request/);
  assert.match(said(r), /client name/);
  assert.equal(r.state, S.BOOK_CLIENT_NAME);
  assert.equal(h.bookings().length, 1, 'no second row');
  await h.text('Nile Motors');
  assert.equal(h.booking().booking_ref, 'MKY-BKG-260916-NONE');
});

test('a draft nobody has touched for longer than the expiry is not offered back', async () => {
  const h = harness({
    bookings: [{
      booking_ref: 'MKY-BKG-260901-STALE', status: 'draft', chat_id: CHAT, client_id: 1,
      customer_name: 'Long Ago', created_at: new Date(Date.now() - 15 * 86_400_000).toISOString(),
    }],
  });
  await h.command('/start');
  const r = await h.tap('menu:book');
  assert.doesNotMatch(said(r), /unfinished booking request/);
  assert.match(said(r), /client name/);
  assert.equal(h.bookings().find((b) => b.booking_ref === 'MKY-BKG-260901-STALE').status, 'expired');
});

test('"start over" drops the old draft and starts one request, not two', async () => {
  const h = harness();
  await bookUpTo(h, { documents: false });
  await h.tap('menu:book');
  const r = await h.tap('bk:draft:restart');

  assert.match(said(r), /client name/);
  assert.equal(h.bookings().filter((b) => b.status === 'draft').length, 1);
  assert.equal(h.bookings().filter((b) => b.status === 'cancelled').length, 1);
});

test('TEST 30 - a database failure does not advance the conversation', async () => {
  const h = harness();
  await identify(h);

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

test('regression: a paper sent for a request already with the desk is acknowledged, not refused', async () => {
  const h = harness();
  await bookUpTo(h);
  await h.tap('bk:confirm');
  const ref = h.booking().booking_ref;
  assert.equal(h.booking().status, 'pending_review');

  // Operations asked for a replacement MRN; the client sends it with "here".
  const r = await h.file(h.upload('mrn', { vin: 'W1T96340310484233', bookingRef: ref }), { caption: 'here' });

  assert.doesNotMatch(said(r), /did not follow/);
  assert.match(said(r), new RegExp(`Received MRN for booking ${ref}`));
  assert.match(said(r), /Operations Team will check it/);
  assert.equal(h.booking().status, 'pending_review', 'nothing about the request itself changed');

  // One of several, whose reply another file gives: silent.
  const quiet = await h.file(h.upload('invoice', { vin: 'W1T96340310484233', bookingRef: ref }), { speak: false });
  assert.deepEqual(quiet.messages, []);
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
  assert.match(said(r), /client name/);
});

test('on the website the number is simply typed - no share button, and it still works', async () => {
  const h = harness();
  const web = { ...h.ctx, channel: 'web', chatId: 'web-1', clientId: null, telegramUserId: null, userName: null };
  const go = (text) => runFlow({ kind: 'text', text }, web);

  await runFlow({ kind: 'command', command: '/start', text: '/start' }, web);
  await go('1');
  const asked = await go('Nile Motors');
  assert.match(said(asked), /mobile number/);
  assert.ok(asked.messages.every((m) => !m.keyboard), 'no Telegram reply keyboard on the web');
  assert.ok(asked.offered.length, 'the widget still gets a button to draw');

  const r = await go('+20 100 555 1234');
  assert.equal(r.state, S.BOOK_VIN);
  const draft = h.bookings().find((b) => b.chat_id === 'web-1');
  assert.equal(draft.customer_contact, PHONE_STORED);
});

test('the offered buttons come back with the result, for a client that cannot tap', async () => {
  const h = harness();
  const r = await h.command('/start');

  assert.deepEqual(r.offered.map((o) => o.data), ['menu:book', 'menu:track', 'menu:contact']);
  assert.match(r.offered[0].label, /Book my shipment/);
});

test('a number is an answer, not a menu choice, when a question was asked', async () => {
  const h = harness();
  await identify(h);
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
  await identify(h);

  const afterVin = await h.text('W1T96340310484233');
  assert.match(said(afterVin), /We are missing some information/, 'shown on the way in');

  const afterMake = await h.text('Mercedes-Benz');
  assert.doesNotMatch(said(afterMake), /We are missing some information/, 'and not repeated');
  assert.match(said(afterMake), /port of loading/i, 'just the next question');

  const afterPol = await h.text('Vilnius');
  assert.doesNotMatch(said(afterPol), /We are missing some information/);
});

test('a client who has been away is reminded what is left when they resume', async () => {
  const h = harness();
  await identify(h);
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
  await identify(h);
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
  await identify(h);

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
  await identify(h);

  const r = await h.text('Chassis: YV2RT40A8FB712905\nMake: Volvo\nClient: Delta Trans Egypt\nDestination: Port Said');

  assert.match(said(r), /already booked/);
  assert.match(said(r), /MKY-BKG-260907-TAKEN/);
});

test('a port we do not serve in a paste is said out loud, not silently dropped', async () => {
  const h = harness();
  await identify(h);
  await h.text('YV2RT40A8FB712905');

  const r = await h.text('Make: Volvo\nClient: Delta Trans Egypt\nLoading: Klaipeda\nDestination: Aswan');

  assert.match(said(r), /is not a port we serve/);
  assert.equal(h.booking().make, 'Volvo', 'the valid fields were still taken');
  assert.equal(h.booking().destination_port, undefined);
  assert.equal(r.state, S.BOOK_DESTINATION, 'and it asks for the one it could not accept');
});

test('an ordinary one-word answer is still an answer, not a paste', async () => {
  const h = harness();
  await identify(h);
  await h.text('YV2RT40A8FB712905');
  await h.text('Volvo');

  assert.equal(h.booking().make, 'Volvo');
  assert.equal(h.booking().model, undefined);
  assert.equal(h.booking().customer_name, 'Nile Motors', 'untouched by a one-word make');
});

test('regression: a labelled single row does not put the label in the value', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');

  await h.text('Client: Delta Trans Egypt');
  assert.equal(h.booking().customer_name, 'Delta Trans Egypt');

  await h.text('Mobile: +20 100 555 1234');
  assert.equal(h.booking().customer_contact, PHONE_STORED);

  await h.text('Chassis │ YV2RT40A8FB712905');
  assert.equal(h.booking().vin, 'YV2RT40A8FB712905', 'not "CHASSIS│YV2RT40A8FB712905"');

  await h.text('Make │ Volvo FH 460 Globetrotter');
  assert.equal(h.booking().make, 'Volvo');
  assert.equal(h.booking().model, 'FH 460 Globetrotter');
});

test('a labelled chassis still faces the duplicate check', async () => {
  const h = harness({
    bookings: [{
      booking_ref: 'MKY-BKG-260907-DUP', status: 'confirmed', chat_id: OTHER_CHAT,
      vin: 'YV2RT40A8FB712905', make: 'Volvo', customer_name: 'Other',
      origin_port: 'Koper', destination_port: 'Suez Port',
    }],
  });
  await identify(h);
  const r = await h.text('Chassis │ YV2RT40A8FB712905');
  assert.match(said(r), /already booked/);
});

// ---------------------------------------------------------------------------
// A ticket needs the problem, not just a phone number
// ---------------------------------------------------------------------------

test('regression: sharing a number asks for the problem instead of raising a ticket', async () => {
  const h = harness();
  await h.tap('menu:contact');

  const r = await h.send({ kind: 'contact', phone: '+8801818488624' });

  assert.equal((h.db._tables.support_tickets ?? []).length, 0, 'nothing raised yet');
  assert.match(said(r), /what the problem is/i);
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

  await h.text('My ACID is missing from the paperwork. Call me on +20 100 555 1234');

  const tickets = h.db._tables.support_tickets;
  assert.equal(tickets.length, 1);
  assert.match(tickets[0].summary, /ACID is missing/);
  assert.match(tickets[0].contact, /\+20 100 555 1234/);
});

test('a client who will not give a number still gets a ticket, reachable in the chat', async () => {
  const h = harness();
  await h.tap('menu:contact');

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

  const r = await h.text('+8801818488624');

  assert.equal((h.db._tables.support_tickets ?? []).length, 0);
  assert.match(said(r), /what the problem is/i);
});

// ---------------------------------------------------------------------------
// People answer in sentences, not in form fields
// ---------------------------------------------------------------------------

test('regression: a chassis number inside a sentence is accepted', async () => {
  const h = harness();
  await identify(h);

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
  await identify(h);
  const r = await h.text('my chassis is WMA06XZZ8KM745219, please book it');
  assert.match(said(r), /already booked/);
});

test('the other fields are read out of a sentence too', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');

  await h.text('my name is Nile Cargo Egypt');
  assert.equal(h.booking().customer_name, 'Nile Cargo Egypt');

  await h.text('you can call me on 01005551234');
  assert.equal(h.booking().customer_contact, '01005551234');

  await h.text('chassis WMA06XZZ8KM745219');
  assert.equal(h.booking().vin, 'WMA06XZZ8KM745219');

  await h.text('it is a MAN TGX 18.500');
  assert.equal(h.booking().make, 'MAN');
  assert.equal(h.booking().model, 'TGX 18.500');

  await h.text('we ship from Hamburg');
  assert.equal(h.booking().origin_port, 'Hamburg');

  const r = await h.text('destination is Port Said please');
  assert.equal(h.booking().destination_port, 'Port Said');
  assert.match(said(r), /Do you already have an MRN/);
});

test('a sentence with no chassis keeps what it DID contain, and asks again', async () => {
  const h = harness();
  await identify(h);

  const r = await h.text('I want to book a truck to Alexandria');

  // The destination was in the message, so it is kept rather than thrown away
  // and asked for again two messages later.
  assert.equal(h.booking().destination_port, 'Alexandria Port (incl. El Dekheila)');
  assert.equal(h.booking().vin, undefined, 'and the sentence is not stored as a chassis');
  assert.match(said(r), /Noted/);
  assert.match(said(r), /chassis/i);
  assert.equal(r.state, S.BOOK_VIN, 'still waiting for the chassis');
});

test('a new number given at the chassis step replaces the old one, and is not stored as a chassis', async () => {
  const h = harness();
  await identify(h);

  const r = await h.text('my number is +20 122 000 9999');

  assert.equal(h.booking().vin, undefined);
  assert.equal(h.booking().customer_contact, '+201220009999');
  assert.match(said(r), /contact/i);
  assert.equal(r.state, S.BOOK_VIN);
});

test('an email mentioned later is kept on the record, and does not overwrite the number', async () => {
  const h = harness();
  await identify(h);

  await h.text('you can reach me at ariful@example.com');
  assert.equal(h.booking().vin, undefined);
  assert.equal(h.booking().customer_contact, PHONE_STORED, 'the desk phones people');
  assert.equal(h.db._tables.clients[0].email, 'ariful@example.com');
});

test('an email given instead of a number is kept, and the number still asked for', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');
  await h.text('Nile Motors');

  const r = await h.text('ariful@example.com');
  assert.match(said(r), /still need a mobile number/);
  assert.equal(r.state, S.BOOK_CLIENT_PHONE);
  assert.equal(h.db._tables.clients[0].email, 'ariful@example.com');

  await h.text(PHONE);
  assert.equal(h.booking().customer_contact, PHONE_STORED);
});

test('a question mid-form is answered by the assistant, and the form survives', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');

  const r = await h.text('how long does shipping to Alexandria take?');

  assert.equal(r.handled, false, 'handed to the knowledge assistant');
  assert.equal(r.state, S.BOOK_CLIENT_NAME, 'and the booking is exactly where it was');
});

test('asking to track mid-booking takes them there', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');

  const r = await h.text('where is my shipment');
  assert.match(said(r), /VIN \/ Chassis number or Booking Reference/);
  assert.equal(r.state, S.TRACK_IDENTIFIER);
});

test('a whole sentence fills every field it names', async () => {
  const h = harness();
  await identify(h);

  const r = await h.text('chassis WMA06XZZ8KM745219 from Klaipeda going to Alexandria');

  const b = h.booking();
  assert.equal(b.vin, 'WMA06XZZ8KM745219');
  assert.equal(b.origin_port, 'Klaipeda');
  assert.equal(b.destination_port, 'Alexandria Port (incl. El Dekheila)');
  // And the next question is the one thing it did not say - not a list that
  // still includes the ports it just gave.
  assert.match(said(r), /Make \/ Brand/);
  assert.doesNotMatch(said(r), /We are missing some information/);
});

test('a company name containing a city is not read as a destination', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');

  await h.text('Alexandria Trading Co');

  assert.equal(h.booking().customer_name, 'Alexandria Trading Co');
  assert.equal(h.booking().destination_port, undefined,
    'a client name is not a port, however it is spelled');
});

test('a question at the make step is not stored as a manufacturer', async () => {
  const h = harness();
  await identify(h);
  await h.text('WMA06XZZ8KM745219');

  const r = await h.text('what makes do you accept?');
  assert.equal(r.handled, false);
  assert.equal(h.booking().make, undefined);
});

test('"I do not have it" at the chassis step explains rather than repeating', async () => {
  const h = harness();
  await identify(h);

  const r = await h.text('I do not have it yet');
  assert.match(said(r), /cannot go further without/i);
  assert.doesNotMatch(said(r), /does not look like/);
});

test('"I do not have one" at the phone step explains that a number is needed', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');
  await h.text('Nile Motors');

  const r = await h.text('I do not have one');
  assert.match(said(r), /cannot go further without the mobile number/i);
  assert.equal(r.state, S.BOOK_CLIENT_PHONE);
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

// ---------------------------------------------------------------------------
// A booking taken entirely in Arabic
// ---------------------------------------------------------------------------

test('a whole booking works in Arabic, and the paperwork values come out Latin', async () => {
  const h = harness();
  const start = await h.text('عايز أحجز شحنة');
  assert.match(said(start), /الخطوة الأولى/, 'step 1, in Arabic');
  await h.text('شركة النيل للنقل');
  await h.text('٠١٠٠٥٥٥١٢٣٤');
  await h.text('رقم الشاسيه WMA06XZZ8KM745219');
  await h.text('مرسيدس أكتروس');
  await h.text('الشحن من فيلنيوس');
  const r = await h.text('الإسكندرية');

  const b = h.booking();
  assert.equal(b.vin, 'WMA06XZZ8KM745219');
  assert.equal(b.customer_contact, '01005551234', 'Arabic-Indic digits, stored as digits');
  // Transliterated, because these end up on the bill of lading and the customs
  // entry, where they must match the rest of the file.
  assert.equal(b.make, 'Mercedes-Benz', 'مرسيدس is Mercedes-Benz on the paperwork');
  assert.equal(b.model, 'Actros', 'and the model is split off, not glued to the make');
  assert.equal(b.origin_port, 'Vilnius', 'فيلنيوس is Vilnius');
  assert.equal(b.destination_port, 'Alexandria Port (incl. El Dekheila)');
  // The client's own business name is left exactly as they wrote it: a wrong
  // Latin guess is worse than Arabic somebody can read.
  assert.equal(b.customer_name, 'شركة النيل للنقل');

  assert.match(said(r), /عندك رقم MRN/, 'and the reply is in Arabic');
});

test('every reply carries both languages', async () => {
  const h = harness();
  const r = await h.command('/start');
  const text = said(r);
  assert.match(text, /[\u0600-\u06FF]/, 'Arabic half');
  assert.match(text, /Welcome/, 'English half');
  assert.match(text, /━━━/, 'divided, so each is readable on a phone');
});

test('an Arabic lead-in is not stored as part of the value', async () => {
  const { extractField } = await import('../lib/flow/paste.js');
  assert.equal(extractField('origin_port', 'الشحن من فيلنيوس'), 'فيلنيوس');
  assert.equal(extractField('vin', 'رقم الشاسيه WMA06XZZ8KM745219'), 'WMA06XZZ8KM745219');
  assert.equal(extractField('customer_name', 'اسمي شركة النيل'), 'شركة النيل');
});

// ---------------------------------------------------------------------------
// However the table was copied
// ---------------------------------------------------------------------------

// What copying the Markdown table out of DEMO-DATA.md actually produces: the
// pipes gone, the row numbers glued to the next label, and every line run
// together into one.
const MARKDOWN_PASTE =
  '2VIN / Chassis number`WMA06XZZ8KM745219`3Make / Brand`MAN`4Client name`Nile Cargo Egypt`'
  + '5Port of loading`Hamburg`6Egyptian destination port`Port Said`';

test('regression: a copied Markdown table fills the whole booking at once', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');

  const r = await h.text(MARKDOWN_PASTE);

  const b = h.booking();
  assert.equal(b.vin, 'WMA06XZZ8KM745219');
  assert.equal(b.make, 'MAN');
  assert.equal(b.customer_name, 'Nile Cargo Egypt');
  assert.equal(b.origin_port, 'Hamburg');
  assert.equal(b.destination_port, 'Port Said');
  // The one thing the table did not carry is the only thing asked for.
  assert.match(said(r), /mobile number/);
  assert.equal(r.state, S.BOOK_CLIENT_PHONE);

  const next = await h.text(PHONE);
  assert.equal(next.state, S.BOOK_MRN_CHOICE, 'then straight to the MRN question');
});

test('regression: the same paste part-way through fills what is left', async () => {
  const h = harness();
  await identify(h);
  await h.text('WMA06XZZ8KM745219');

  const r = await h.text(
    'Make / Brand`MAN`4Client name`Nile Cargo Egypt`5Port of loading`Hamburg`6Egyptian destination port`Port Said`',
  );

  const b = h.booking();
  assert.equal(b.make, 'MAN');
  assert.equal(b.customer_name, 'Nile Cargo Egypt');
  assert.equal(b.origin_port, 'Hamburg');
  assert.equal(b.destination_port, 'Port Said');
  assert.equal(r.state, S.BOOK_MRN_CHOICE);
});

test('backtick pairs are read one per line too', async () => {
  const { parsePastedFields } = await import('../lib/flow/paste.js');
  const out = parsePastedFields(
    'Make / Brand`MAN`\nClient name`Nile Cargo Egypt`\nPort of loading`Hamburg`\nEgyptian destination port`Port Said`',
  );
  assert.equal(out.make, 'MAN');
  assert.equal(out.customer_name, 'Nile Cargo Egypt');
  assert.equal(out.origin_port, 'Hamburg');
  assert.equal(out.destination_port, 'Port Said');
});

test('a single backticked value is still one answer, not a paste', async () => {
  const { looksLikePaste, parsePastedFields } = await import('../lib/flow/paste.js');
  assert.equal(looksLikePaste('Make`MAN`'), false, 'one field is an answer');
  assert.equal(parsePastedFields('Make`MAN`').make, 'MAN');
});

test('every paste shape reaches the same result', async () => {
  const { parsePastedFields } = await import('../lib/flow/paste.js');
  const shapes = [
    'Chassis: WMA06XZZ8KM745219\nMake: MAN\nClient: Nile Cargo Egypt\nLoading: Hamburg\nDestination: Port Said',
    'Chassis`WMA06XZZ8KM745219`Make`MAN`Client`Nile Cargo Egypt`Loading`Hamburg`Destination`Port Said`',
    '│ Chassis │ WMA06XZZ8KM745219 │\n│ Make │ MAN │\n│ Client │ Nile Cargo Egypt │\n│ Loading │ Hamburg │\n│ Destination │ Port Said │',
  ];
  for (const shape of shapes) {
    const out = parsePastedFields(shape);
    assert.equal(out.vin, 'WMA06XZZ8KM745219', shape.slice(0, 30));
    assert.equal(out.make, 'MAN', shape.slice(0, 30));
    assert.equal(out.destination_port, 'Port Said', shape.slice(0, 30));
  }
});

test('a paste that begins mid-row still lands on the right fields', async () => {
  const { parsePastedFields } = await import('../lib/flow/paste.js');

  // Copied from a numbered table by selecting from inside the first row, so the
  // opening label - "2VIN / Chassis number" - never made it into the message.
  // The run therefore STARTS with a value, and pairing left-to-right marries
  // every label to the cell after the one it names.
  const out = parsePastedFields(
    'WMA06XZZ8KM745219`3Make / Brand`MAN`4Client name`Nile Cargo Egypt'
    + '`5Port of loading`Hamburg`6Egyptian destination port`Port Said');

  assert.equal(out.vin, 'WMA06XZZ8KM745219');
  assert.equal(out.make, 'MAN');
  assert.equal(out.customer_name, 'Nile Cargo Egypt');
  assert.equal(out.origin_port, 'Hamburg');
  assert.equal(out.destination_port, 'Port Said');
});

test('a paste with no chassis in it offers no chassis', async () => {
  const { parsePastedFields } = await import('../lib/flow/paste.js');

  // The recovery that finds an unpaired chassis must not invent one. Row
  // numbers glued to label words - "6Egyptian" - have letters, digits and the
  // right length, and were being stored as the client's chassis number.
  const out = parsePastedFields(
    'Make / Brand`MAN`4Client name`Nile Cargo Egypt'
    + '`5Port of loading`Hamburg`6Egyptian destination port`Port Said`');

  assert.equal(out.vin, undefined);
  assert.equal(out.make, 'MAN');
  assert.equal(out.destination_port, 'Port Said');
});

test('the Arabic block pastes as one message too', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('menu:book');

  const r = await h.text(
    'رقم الشاسيه: WMA06XZZ8KM745219\n'
    + 'الماركة: مرسيدس أكتروس\n'
    + 'العميل: شركة النيل للنقل\n'
    + 'الشحن من: فيلنيوس\n'
    + 'ميناء الوصول: الإسكندرية',
  );

  const b = h.booking();
  assert.equal(b.vin, 'WMA06XZZ8KM745219');
  assert.equal(b.make, 'Mercedes-Benz');
  assert.equal(b.customer_name, 'شركة النيل للنقل');
  assert.equal(b.origin_port, 'Vilnius');
  assert.equal(b.destination_port, 'Alexandria Port (incl. El Dekheila)');
  assert.equal(r.state, S.BOOK_CLIENT_PHONE, 'everything but the number, so the number is asked');

  const next = await h.text('رقم الموبايل: ٠١٠٠٥٥٥١٢٣٤');
  assert.equal(h.booking().customer_contact, '01005551234');
  assert.equal(next.state, S.BOOK_MRN_CHOICE);
});

test('the phone number helpers read what people actually type', async () => {
  const { normalizePhone, looksLikePhone } = await import('../lib/phone.js');
  assert.equal(normalizePhone('+20 100 555 1234'), '+201005551234');
  assert.equal(normalizePhone('call me on 0100-555-1234 please'), '01005551234');
  assert.equal(normalizePhone('٠١٠٠٥٥٥١٢٣٤'), '01005551234');
  assert.equal(normalizePhone('0020 100 555 1234'), '+201005551234');
  // A chassis number is not a phone number, however many digits it has.
  assert.equal(normalizePhone('W1T96340310484233'), null);
  assert.equal(normalizePhone('chassis W1T96340310484233'), null);
  assert.equal(normalizePhone('12345'), null);

  assert.equal(looksLikePhone('+201005551234'), true);
  assert.equal(looksLikePhone('telegram:6284123456'), false, 'our routing address is not a number');
  assert.equal(looksLikePhone('ariful@example.com'), false);
  assert.equal(looksLikePhone(null), false);
});
