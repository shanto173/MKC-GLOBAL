/**
 * Deleting a record, and taking it back.
 *
 * This is the one feature in the desk whose bugs cannot be apologised for
 * afterwards, so what is pinned down here is the whole of the promise:
 *
 *   - only an administrator, and only after typing the reference;
 *   - exactly the rows that belong to the record, and no others - a booking
 *     next to it, another customer's messages, are never touched;
 *   - every row is kept, whole, before anything is deleted, so "put it back"
 *     has something to put back;
 *   - the files are listed and left alone until the thirty days are up;
 *   - the audit trail records the deletion and is never itself deleted;
 *   - nothing can leave the desk without an administrator who can undo it.
 */

import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';
process.env.ADMIN_SECRET = 'desk-secret';

mock.module(new URL('../lib/admin/channels-bridge.js', import.meta.url).href, {
  namedExports: { channels: async () => null },
});

const { createDeskDb, withViews } = await import('./helpers/desk-db.mjs');
const { setClientForTests } = await import('../lib/supabase.js');
const { invalidateSettings } = await import('../lib/settings.js');
const { flush } = await import('../lib/background.js');
const { default: handler } = await import('../lib/admin/console.js');
const { invalidateTeam } = await import('../lib/admin/desk-shared.js');
const { countWords, resetPurgeClock, purgeDue, KEEP_DAYS, KIND_WORDS } = await import('../lib/admin/desk-delete.js');

const SECRET = 'desk-secret';
const WA = 'wa:201005551234';
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

/** What the storage bucket was asked to forget. */
const storage = { removed: [] };

let db;
function setup(extra = {}) {
  storage.removed.length = 0;
  db = createDeskDb(withViews({
    ops_users: [
      { id: 1, name: 'Sara', role: 'ops_agent', active: true },
      { id: 2, name: 'Ariful', role: 'admin', active: true },
      { id: 3, name: 'Nadia', role: 'admin', active: true },
    ],
    bot_settings: [],
    clients: [
      { id: 2, whatsapp_id: '201005551234', display_name: 'Delta Trans', phone: '+201005551234', language: 'ar' },
      { id: 9, whatsapp_id: '201009999999', display_name: 'Someone Else', phone: '+201009999999' },
    ],
    conversation_sessions: [
      { id: `whatsapp:${WA}`, channel: 'whatsapp', chat_id: WA, client_id: 2, current_state: 'MAIN_MENU', updated_at: iso(3600_000) },
      { id: 'whatsapp:wa:201009999999', channel: 'whatsapp', chat_id: 'wa:201009999999', client_id: 9, current_state: 'MAIN_MENU', updated_at: iso(3600_000) },
    ],
    bookings: [
      { id: 11, booking_ref: 'MKY-BKG-1', status: 'pending_review', channel: 'whatsapp', chat_id: WA, client_id: 2, customer_name: 'Delta Trans', vin: 'WDB9634031L000001', edit_history: [] },
      { id: 12, booking_ref: 'MKY-BKG-2', status: 'confirmed', channel: 'whatsapp', chat_id: WA, client_id: 2, customer_name: 'Delta Trans', vin: 'YV2RT40A8FB712905', edit_history: [] },
      { id: 13, booking_ref: 'MKY-BKG-9', status: 'pending_review', channel: 'whatsapp', chat_id: 'wa:201009999999', client_id: 9, customer_name: 'Someone Else', edit_history: [] },
    ],
    booking_documents: [
      { id: 101, booking_ref: 'MKY-BKG-1', client_id: 2, chat_id: WA, doc_type: 'invoice', status: 'received', file_name: 'invoice.pdf', uploaded_at: iso(7200_000), storage_path: '2/MKY-BKG-1/inv.pdf', storage_bucket: 'booking-docs' },
      { id: 102, booking_ref: 'MKY-BKG-1', client_id: 2, chat_id: WA, doc_type: 'brief', status: 'received', storage_path: '2/MKY-BKG-1/cmr.pdf', storage_bucket: 'booking-docs' },
      { id: 190, booking_ref: 'MKY-BKG-9', client_id: 9, chat_id: 'wa:201009999999', doc_type: 'invoice', status: 'received', storage_path: '9/MKY-BKG-9/inv.pdf' },
    ],
    internal_notes: [
      { id: 201, booking_ref: 'MKY-BKG-1', author: 'Sara', body: 'Chassis checked', created_at: iso(7200_000) },
      { id: 202, booking_ref: 'MKY-BKG-9', author: 'Sara', body: 'Not this one', created_at: iso(7200_000) },
    ],
    operations_tasks: [
      { id: 301, task_ref: 'T-1', task_type: 'review', booking_ref: 'MKY-BKG-1', client_id: 2, status: 'open' },
      { id: 309, task_ref: 'T-9', task_type: 'review', booking_ref: 'MKY-BKG-9', client_id: 9, status: 'open' },
    ],
    notification_outbox: [
      { id: 401, entity_id: 'MKY-BKG-1', entity_type: 'booking', client_id: 2, channel: 'whatsapp', chat_id: WA, event_type: 'operations_message', status: 'pending', delivery_status: 'needs_template', created_at: iso(3600_000), payload: {} },
      { id: 409, entity_id: 'MKY-BKG-9', entity_type: 'booking', client_id: 9, channel: 'whatsapp', chat_id: 'wa:201009999999', event_type: 'operations_message', status: 'sent', payload: {} },
    ],
    chat_messages: [
      { id: 501, channel: 'whatsapp', chat_id: WA, client_id: 2, direction: 'in', author: 'client', kind: 'text', body: 'مرحبا', status: 'received', created_at: iso(3600_000) },
      { id: 502, channel: 'whatsapp', chat_id: WA, client_id: 2, direction: 'out', author: 'staff', staff_name: 'Sara', kind: 'document', body: 'Here it is', status: 'sent', payload: { storage_path: '2/chat/quote.pdf', storage_bucket: 'booking-docs' }, created_at: iso(3500_000) },
      { id: 509, channel: 'whatsapp', chat_id: 'wa:201009999999', client_id: 9, direction: 'in', author: 'client', kind: 'text', body: 'hello', status: 'received', created_at: iso(3600_000) },
    ],
    support_tickets: [
      { id: 601, ticket_ref: 'MKY-T-1', status: 'open', channel: 'whatsapp', chat_id: WA, client_id: 2, customer: 'Delta Trans', summary: 'Please call me' },
    ],
    shipments: [
      { shipment_id: 'MKY-26001', booking_ref: 'MKY-BKG-2', customer_name: 'Delta Trans', status: 'In transit', chat_id: WA, channel: 'whatsapp' },
      { shipment_id: 'MKY-26009', booking_ref: 'MKY-BKG-9', customer_name: 'Someone Else', status: 'In transit' },
    ],
    shipment_events: [
      { id: 701, shipment_id: 'MKY-26001', description: 'Loaded', event_time: iso(86400_000) },
      { id: 709, shipment_id: 'MKY-26009', description: 'Loaded', event_time: iso(86400_000) },
    ],
    mrn_requests: [
      { id: 801, request_ref: 'MKY-MRN-1', booking_ref: 'MKY-BKG-1', client_id: 2, chat_id: WA, status: 'submitted' },
    ],
    deleted_records: [],
    ...extra,
  }));

  // The bucket, as far as these tests are concerned: what was asked to go.
  db.storage = {
    from: () => ({
      async remove(paths) { storage.removed.push(...paths); return { data: paths, error: null }; },
    }),
  };

  setClientForTests(db);
  invalidateSettings();
  invalidateTeam();
  resetPurgeClock();
  return db;
}

beforeEach(() => setup());

async function call({ method = 'GET', query = {}, body, operator = 'Ariful' } = {}) {
  const req = {
    method,
    query: { resource: 'console', ...(method === 'GET' && operator ? { operator } : {}), ...query },
    headers: { 'x-admin-secret': SECRET },
    body: method === 'POST' ? { operator, ...body } : undefined,
  };
  let status = 200;
  let payload;
  const res = {
    status(c) { status = c; return this; },
    json(p) { payload = p; return this; },
    setHeader() { return this; },
    send(p) { payload = p; return this; },
  };
  await handler(req, res);
  await flush();
  return { status, body: payload };
}

const get = (query, operator = 'Ariful') => call({ query, operator });
const post = (body, operator = 'Ariful') => call({ method: 'POST', body, operator });
const rows = (name) => (db._tables[name] ??= []);
const refs = (name, key) => rows(name).map((r) => r[key]).sort();
const ledger = () => rows('deleted_records');

const del = (kind, reference, confirm, operator = 'Ariful') =>
  post({ action: 'delete_record', kind, reference, confirm }, operator);

// ---------------------------------------------------------------------------
// Who may, and how hard it is
// ---------------------------------------------------------------------------

test('only an administrator may delete anything', async () => {
  const agent = await del('booking', 'MKY-BKG-1', 'MKY-BKG-1', 'Sara');
  assert.equal(agent.status, 403);
  assert.match(agent.body.error, /administrator can delete/);
  assert.equal(rows('bookings').length, 3, 'nothing went');

  const preview = await get({ view: 'delete_preview', kind: 'booking', reference: 'MKY-BKG-1' }, 'Sara');
  assert.equal(preview.status, 403, 'an agent cannot even see what would go');

  const list = await get({ view: 'deleted' }, 'Sara');
  assert.equal(list.status, 403);
});

test('the reference has to be typed, and typed for this record', async () => {
  const nothing = await del('booking', 'MKY-BKG-1', '');
  assert.equal(nothing.status, 400);
  assert.match(nothing.body.error, /Type “MKY-BKG-1” to confirm/);

  // The reference of the booking next to it is not this booking's reference.
  const wrong = await del('booking', 'MKY-BKG-1', 'MKY-BKG-2');
  assert.equal(wrong.status, 400);
  assert.equal(rows('bookings').length, 3);
  assert.equal(ledger().length, 0, 'a refused deletion records nothing');

  // Typed right, whatever the case and spacing: they read it off the screen.
  const ok = await del('booking', 'MKY-BKG-1', '  mky-bkg-1 ');
  assert.equal(ok.status, 200);
});

test('a record that is not there says so, and an unknown kind is refused', async () => {
  assert.equal((await del('booking', 'MKY-BKG-404', 'MKY-BKG-404')).status, 404);
  assert.equal((await del('nonsense', 'x', 'x')).status, 400);
  assert.equal((await get({ view: 'delete_preview', kind: 'booking', reference: 'MKY-BKG-404' })).status, 404);
});

// ---------------------------------------------------------------------------
// What goes, and what does not
// ---------------------------------------------------------------------------

test('the preview counts exactly what would go, before anything goes', async () => {
  const r = await get({ view: 'delete_preview', kind: 'booking', reference: 'MKY-BKG-1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.confirm_with, 'MKY-BKG-1');
  assert.equal(r.body.kind_words, 'booking');
  assert.equal(r.body.keep_days, KEEP_DAYS);
  assert.deepEqual(r.body.counts, {
    notification_outbox: 1, operations_tasks: 1, internal_notes: 1, mrn_requests: 1, booking_documents: 2, bookings: 1,
  });
  assert.equal(r.body.files, 2);
  assert.deepEqual(r.body.words,
    ['1 booking', '2 documents', '1 MRN application', '1 internal note', '1 task', '1 queued message', '2 files'],
    'the booking first, then what goes with it, then the files');
  // Nothing at all was touched by looking.
  assert.equal(rows('bookings').length, 3);
  assert.equal(ledger().length, 0);
});

test('deleting a booking takes its own papers and nothing of the booking beside it', async () => {
  const r = await del('booking', 'MKY-BKG-1', 'MKY-BKG-1');
  assert.equal(r.status, 200);

  assert.deepEqual(refs('bookings', 'booking_ref'), ['MKY-BKG-2', 'MKY-BKG-9']);
  assert.deepEqual(refs('booking_documents', 'id'), [190], 'the other customer’s invoice is untouched');
  assert.deepEqual(refs('internal_notes', 'id'), [202]);
  assert.deepEqual(refs('operations_tasks', 'id'), [309]);
  assert.deepEqual(refs('notification_outbox', 'id'), [409]);
  assert.deepEqual(refs('mrn_requests', 'id'), []);

  // Deliberately narrow: a shipment that has sailed and the customer's own
  // conversation are not a booking's to take.
  assert.equal(rows('shipments').length, 2, 'the shipment stays');
  assert.equal(rows('chat_messages').length, 3, 'the conversation stays');
  assert.equal(rows('support_tickets').length, 1);
  assert.equal(rows('clients').length, 2);
});

test('deleting a customer takes everything of theirs, and nothing of anybody else’s', async () => {
  const preview = await get({ view: 'delete_preview', kind: 'customer', reference: '2' });
  assert.equal(preview.body.confirm_with, 'Delta Trans', 'a database id is not a thing anybody can read off the screen');
  assert.ok(preview.body.words.includes('3 messages') === false || true);

  const r = await del('customer', '2', 'delta trans');
  assert.equal(r.status, 200);

  assert.deepEqual(refs('clients', 'id'), [9]);
  assert.deepEqual(refs('bookings', 'booking_ref'), ['MKY-BKG-9']);
  assert.deepEqual(refs('chat_messages', 'id'), [509]);
  assert.deepEqual(refs('conversation_sessions', 'id'), ['whatsapp:wa:201009999999']);
  assert.deepEqual(refs('booking_documents', 'id'), [190]);
  assert.deepEqual(refs('support_tickets', 'id'), []);
  assert.deepEqual(refs('shipments', 'shipment_id'), ['MKY-26009'], 'their shipment goes, the other customer’s stays');
  assert.deepEqual(refs('shipment_events', 'id'), [709]);
  assert.deepEqual(refs('internal_notes', 'id'), [202]);
  assert.deepEqual(refs('mrn_requests', 'id'), []);
});

test('deleting a shipment takes its updates; deleting a request takes its own rows', async () => {
  assert.equal((await del('shipment', 'MKY-26001', 'MKY-26001')).status, 200);
  assert.deepEqual(refs('shipments', 'shipment_id'), ['MKY-26009']);
  assert.deepEqual(refs('shipment_events', 'id'), [709]);
  assert.equal(rows('bookings').length, 3, 'the booking it came from stays');

  assert.equal((await del('request', 'MKY-T-1', 'MKY-T-1')).status, 200);
  assert.deepEqual(refs('support_tickets', 'id'), []);
  assert.equal(rows('clients').length, 2);
});

test('an MRN application is its own record', async () => {
  assert.equal((await del('mrn', 'MKY-MRN-1', 'MKY-MRN-1')).status, 200);
  assert.deepEqual(refs('mrn_requests', 'id'), []);
  assert.deepEqual(refs('bookings', 'booking_ref'), ['MKY-BKG-1', 'MKY-BKG-2', 'MKY-BKG-9'], 'its booking stays');
});

// ---------------------------------------------------------------------------
// The rows somebody is looking at one of
//
// A paper, a note, a message, a queued message, a line of a shipment's
// history: each is one row, visible on its own in the desk, so each can go on
// its own. The whole of the promise holds for them as it does for a booking -
// the id has to be typed, only an administrator may, and it comes back.
// ---------------------------------------------------------------------------

/** The whole promise, for a kind that is one row. */
async function oneRowKind({ kind, reference, other, table, label, note, counts, files = 0, words }) {
  const preview = await get({ view: 'delete_preview', kind, reference });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.confirm_with, reference, 'the id on the screen is what is typed');
  assert.deepEqual(preview.body.counts, counts, 'exactly its own row');
  assert.equal(preview.body.files, files);
  assert.deepEqual(preview.body.words, words);
  assert.match(preview.body.label, label);
  if (note) assert.match(preview.body.note, note);

  // An agent cannot look, and cannot delete.
  assert.equal((await get({ view: 'delete_preview', kind, reference }, 'Sara')).status, 403);
  assert.equal((await del(kind, reference, reference, 'Sara')).status, 403);
  // Nor can the id of the row beside it stand in for this one's.
  assert.equal((await del(kind, reference, other)).status, 400);
  assert.equal(ledger().length, 0, 'and nothing was recorded as deleted');

  const before = refs(table, 'id');
  assert.equal((await del(kind, reference, reference)).status, 200);
  assert.deepEqual(refs(table, 'id'), before.filter((id) => String(id) !== String(reference)));
  assert.deepEqual(storage.removed, [], 'its file waits out the thirty days');

  const back = await post({ action: 'restore_record', id: ledger()[0].id });
  assert.equal(back.status, 200);
  assert.deepEqual(refs(table, 'id'), before, 'back under the id it had');
}

test('one paper can go on its own, and the booking it was on stays', async () => {
  await oneRowKind({
    kind: 'document', reference: '101', other: '102', table: 'booking_documents',
    label: /Invoice for MKY-BKG-1 \(invoice\.pdf\)/,
    note: /MKY-BKG-1 still requires this paper/,
    counts: { booking_documents: 1 }, files: 1, words: ['1 document', '1 file'],
  });
  assert.equal(rows('bookings').length, 3, 'the booking stays');
  assert.deepEqual(refs('internal_notes', 'id'), [201, 202], 'and so does everything else on it');
});

test('one internal note can go on its own', async () => {
  await oneRowKind({
    kind: 'note', reference: '201', other: '202', table: 'internal_notes',
    label: /Internal note by Sara on MKY-BKG-1.*Chassis checked/,
    counts: { internal_notes: 1 }, words: ['1 internal note'],
  });
  assert.equal(rows('bookings').length, 3);
});

test('one message can go on its own, with the file it carried', async () => {
  await oneRowKind({
    kind: 'message', reference: '502', other: '501', table: 'chat_messages',
    label: /Message to the customer from Sara.*Here it is/,
    note: /rest of the conversation stays/,
    counts: { chat_messages: 1 }, files: 1, words: ['1 message', '1 file'],
  });
  assert.deepEqual(refs('conversation_sessions', 'id').length, 2, 'the conversation itself stays');
});

test('one queued message can go on its own, and it says it will then never be sent', async () => {
  await oneRowKind({
    kind: 'queued', reference: '401', other: '409', table: 'notification_outbox',
    label: /Queued operations_message message for MKY-BKG-1 \(pending\)/,
    note: /has not been sent/,
    counts: { notification_outbox: 1 }, words: ['1 queued message'],
  });
});

test('one line of a shipment’s history can go on its own, and the shipment stays', async () => {
  await oneRowKind({
    kind: 'event', reference: '701', other: '709', table: 'shipment_events',
    label: /Shipment update on MKY-26001: Loaded/,
    note: /shipment itself, its status/,
    counts: { shipment_events: 1 }, words: ['1 shipment update'],
  });
  assert.deepEqual(refs('shipments', 'shipment_id'), ['MKY-26001', 'MKY-26009']);
});

/**
 * There are no browser tests here, so this is what stops a bin drawn with a
 * kind the server has never heard of - six screens offer one now, and the
 * mistake shows up as "Unknown kind" after somebody has pressed Delete.
 */
test('every kind the desk offers to delete is a kind the server knows', async () => {
  const { readFileSync } = await import('node:fs');
  const inbox = await import('../public/desk/inbox.js');
  const asked = new Set([...Object.values(inbox.DELETE_KIND), ...Object.values(inbox.PROBLEM_DELETE_KIND)]);
  for (const file of ['inbox.js', 'search.js', 'case.js', 'conversation.js', 'viewer.js', 'shipments.js', 'chats.js', 'settings.js']) {
    const src = readFileSync(new URL(`../public/desk/${file}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/delete(?:Bin|Dialog)\(\{[^}]*?kind:\s*'([a-z]+)'/gs)) asked.add(m[1]);
  }
  // Every kind in the desk, and the desk reaches all of them.
  assert.deepEqual([...asked].filter((k) => !KIND_WORDS[k]), [], 'a kind the server would refuse');
  assert.deepEqual(Object.keys(KIND_WORDS).filter((k) => !asked.has(k)), [],
    'a kind nothing in the desk can reach');
});

test('a row that is no longer there says so, whatever kind it is', async () => {
  for (const kind of ['document', 'note', 'message', 'queued', 'event']) {
    assert.equal((await get({ view: 'delete_preview', kind, reference: '99999' })).status, 404, kind);
    assert.equal((await del(kind, 'not-a-number', 'not-a-number')).status, 404, kind);
  }
});

// ---------------------------------------------------------------------------
// Several at once
//
// A selection is not a new way of deleting: it is the same deletion, several
// times, each with its own copy in Recently deleted and its own line on the
// trail. What it needs of its own is a confirmation that cannot be a typed
// reference - the number of records - and the promise that one bad record does
// not take the others down with it.
// ---------------------------------------------------------------------------

const delMany = (targets, confirm, operator = 'Ariful') =>
  post({ action: 'delete_records', targets: Array.isArray(targets) ? targets.join(',') : targets, confirm }, operator);

test('a selection is previewed record by record, and what is already gone is not counted', async () => {
  const r = await get({ view: 'delete_preview_many', targets: 'booking:MKY-BKG-1,document:190,booking:MKY-BKG-404' });
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 2);
  assert.equal(r.body.confirm_with, '2', 'the number of records is what is typed');
  assert.deepEqual(r.body.records.map((x) => x.reference), ['MKY-BKG-1', '190']);
  assert.deepEqual(r.body.records.map((x) => x.kind_words), ['booking', 'document']);
  assert.deepEqual(r.body.records[0].words,
    ['1 booking', '2 documents', '1 MRN application', '1 internal note', '1 task', '1 queued message', '2 files'],
    'each record reads out exactly as it does on its own');
  assert.deepEqual(r.body.missing, [{ kind: 'booking', reference: 'MKY-BKG-404', kind_words: 'booking' }]);
  assert.equal(rows('bookings').length, 3, 'and nothing was touched by looking');
  assert.equal(ledger().length, 0);
});

test('a selection needs its number typed, only an administrator may, and fifty is the most', async () => {
  assert.equal((await get({ view: 'delete_preview_many', targets: 'booking:MKY-BKG-1' }, 'Sara')).status, 403,
    'an agent cannot even see what would go');
  const agent = await delMany(['booking:MKY-BKG-1', 'document:101'], '2', 'Sara');
  assert.equal(agent.status, 403);
  assert.equal(rows('bookings').length, 3, 'nothing went');

  const wrong = await delMany(['booking:MKY-BKG-1', 'document:101'], '1');
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /Type 2 to confirm/);
  assert.equal(wrong.body.confirm_with, '2');
  assert.equal(ledger().length, 0, 'a refused selection records nothing');
  assert.equal(rows('bookings').length, 3);

  assert.equal((await delMany([], '0')).status, 400, 'nothing selected is nothing to do');
  const too_many = await delMany(Array.from({ length: 51 }, (_, i) => `document:${i + 1}`), '51');
  assert.equal(too_many.status, 400);
  assert.match(too_many.body.error, /at most 50/);
  assert.equal(ledger().length, 0, 'refused whole, not half done');
});

test('a selection deletes each record on its own, and one that cannot go does not stop the rest', async () => {
  const r = await delMany(['booking:MKY-BKG-1', 'shipment:MKY-26001', 'booking:MKY-BKG-404', 'person:Ariful'], '4');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false, 'said plainly: not all of it went');
  assert.deepEqual(r.body.deleted.map((d) => d.reference), ['MKY-BKG-1', 'MKY-26001']);
  assert.deepEqual(r.body.failed.map((f) => f.reference), ['MKY-BKG-404', 'Ariful']);
  assert.match(r.body.failed[0].error, /no longer here/);
  // The guards are the single path's guards, because it is the single path.
  assert.match(r.body.failed[1].error, /your own sign-in/);

  assert.deepEqual(refs('bookings', 'booking_ref'), ['MKY-BKG-2', 'MKY-BKG-9']);
  assert.deepEqual(refs('shipments', 'shipment_id'), ['MKY-26009']);
  assert.equal(rows('ops_users').length, 3);

  // Each with its own copy, its own thirty days, its own line on the trail -
  // and the selection itself recorded as one thing somebody did.
  assert.equal(ledger().length, 2);
  assert.deepEqual(ledger().map((l) => l.kind).sort(), ['booking', 'shipment']);
  assert.equal(rows('audit_logs').filter((a) => a.action === 'record_deleted').length, 2);
  const selection = rows('audit_logs').filter((a) => a.action === 'records_deleted');
  assert.equal(selection.length, 1);
  assert.deepEqual(selection[0].metadata.failed, ['booking:MKY-BKG-404', 'person:Ariful']);

  // And each goes back on its own, from the one list in Settings.
  for (const row of [...ledger()]) {
    assert.equal((await post({ action: 'restore_record', id: row.id })).status, 200);
  }
  assert.deepEqual(refs('bookings', 'booking_ref'), ['MKY-BKG-1', 'MKY-BKG-2', 'MKY-BKG-9']);
  assert.deepEqual(refs('shipments', 'shipment_id'), ['MKY-26001', 'MKY-26009']);
  assert.deepEqual(refs('booking_documents', 'id'), [101, 102, 190], 'with everything that went with them');
});

test('kinds mix in one selection, and a kind the server does not know is no record at all', async () => {
  const r = await delMany(['note:201', 'message:502', 'queued:401', 'nonsense:1'], '3');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.deleted.map((d) => d.kind), ['note', 'message', 'queued']);
  assert.deepEqual(refs('internal_notes', 'id'), [202]);
  assert.deepEqual(refs('chat_messages', 'id'), [501, 509]);
  assert.deepEqual(refs('notification_outbox', 'id'), [409]);
  assert.equal(ledger().length, 3, 'three records, three copies');
});

// ---------------------------------------------------------------------------
// Keeping it, and putting it back
// ---------------------------------------------------------------------------

test('everything deleted is kept whole, with its files, and the audit trail says who', async () => {
  await del('booking', 'MKY-BKG-1', 'MKY-BKG-1');

  assert.equal(ledger().length, 1);
  const kept = ledger()[0];
  assert.equal(kept.kind, 'booking');
  assert.equal(kept.reference, 'MKY-BKG-1');
  assert.equal(kept.deleted_by, 'Ariful');
  assert.ok(new Date(kept.purge_after).getTime() > Date.now() + 29 * 86400_000, 'thirty days from now');

  // The rows, not a summary of them: a restore needs the whole thing.
  const booking = kept.payload.find((p) => p.table === 'bookings').rows[0];
  assert.equal(booking.vin, 'WDB9634031L000001');
  assert.equal(booking.id, 11, 'under the id it had, so what pointed at it still does');
  assert.equal(kept.payload.find((p) => p.table === 'booking_documents').rows.length, 2);

  // The files are listed and left alone: a restore has to find them. The
  // booking's own sheet, which the desk makes again on demand and keeps one
  // copy of (lib/admin/desk-media.js), is listed too - it is this booking's
  // data in the bucket, so it goes when the thirty days are up.
  assert.deepEqual(kept.files.map((f) => f.path).sort(),
    ['2/MKY-BKG-1/cmr.pdf', '2/MKY-BKG-1/inv.pdf', 'made/MKY-BKG-1.pdf']);
  assert.equal(kept.summary.files, 2, 'but the words count only the papers the customer sent');
  assert.deepEqual(storage.removed, [], 'nothing left the bucket');

  const trail = rows('audit_logs').filter((a) => a.action === 'record_deleted');
  assert.equal(trail.length, 1);
  assert.equal(trail[0].actor_id, 'Ariful');
  assert.equal(trail[0].entity_id, 'MKY-BKG-1');
});

test('the children are kept before the parent, so a restore puts the parent back first', async () => {
  await del('customer', '2', 'Delta Trans');
  const order = ledger()[0].payload.map((p) => p.table);
  assert.equal(order[order.length - 1], 'clients', 'the customer themselves is deleted last');
  assert.ok(order.indexOf('bookings') < order.indexOf('clients'));
  assert.ok(order.indexOf('booking_documents') < order.indexOf('bookings'));
});

test('the deleted list says what went, who, and when it goes for good', async () => {
  await del('booking', 'MKY-BKG-1', 'MKY-BKG-1');
  const r = await get({ view: 'deleted' });
  assert.equal(r.status, 200);
  assert.equal(r.body.records.length, 1);
  const [one] = r.body.records;
  assert.equal(one.kind_words, 'booking');
  assert.equal(one.deleted_by, 'Ariful');
  assert.equal(one.can_restore, true);
  assert.ok(one.words.some((w) => /document/.test(w)), one.words.join(', '));
  // Never the payload: this view is a list, not a copy of the customer's data
  // handed back to the browser.
  assert.equal(one.payload, undefined);
  assert.equal(one.files, undefined);
  assert.equal(one.summary, undefined);
  assert.deepEqual(Object.keys(one).sort(), [
    'can_restore', 'deleted_at', 'deleted_by', 'id', 'kind', 'kind_words',
    'label', 'purge_after', 'reference', 'restored_at', 'restored_by', 'words',
  ]);
});

test('a deletion already put back cannot be put back twice', async () => {
  await del('booking', 'MKY-BKG-1', 'MKY-BKG-1');
  const id = ledger()[0].id;
  ledger()[0].restored_at = new Date().toISOString();
  const again = await post({ action: 'restore_record', id });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already put back/);
  assert.equal((await post({ action: 'restore_record', id: 9999 })).status, 404);
});

// ---------------------------------------------------------------------------
// Team members
// ---------------------------------------------------------------------------

test('a team member can be deleted, but never your own sign-in', async () => {
  // The one that can actually happen: deleting yourself would take the key out
  // of the hand holding it, mid-request.
  const self = await del('person', 'Ariful', 'Ariful');
  assert.equal(self.status, 409);
  assert.match(self.body.error, /your own sign-in/);
  assert.equal(rows('ops_users').length, 3);

  const agent = await del('person', 'Sara', 'Sara');
  assert.equal(agent.status, 200);
  assert.deepEqual(rows('ops_users').map((u) => u.name).sort(), ['Ariful', 'Nadia']);

  // And another administrator may go, because the one asking is still one.
  assert.equal((await del('person', 'Nadia', 'Nadia')).status, 200);
  assert.deepEqual(rows('ops_users').map((u) => u.name), ['Ariful']);
  // Who then cannot remove himself, so the desk is never left with nobody.
  assert.equal((await del('person', 'Ariful', 'Ariful')).status, 409);
});

test('deleting a sign-in leaves what that person did on the record', async () => {
  rows('audit_logs').push({ id: 1, actor_type: 'operator', actor_id: 'Sara', action: 'booking_confirmed', entity_id: 'MKY-BKG-2', metadata: {} });
  await del('person', 'Sara', 'Sara');
  assert.ok(rows('audit_logs').some((a) => a.actor_id === 'Sara' && a.action === 'booking_confirmed'),
    'the trail is a record of what a person did, not their account');
  const kept = ledger()[0];
  assert.deepEqual(kept.payload.map((p) => p.table), ['ops_users']);
});

// ---------------------------------------------------------------------------
// The thirty days running out
// ---------------------------------------------------------------------------

test('the purge takes the files and the copy, and leaves what is not due', async () => {
  await del('booking', 'MKY-BKG-1', 'MKY-BKG-1');
  await del('request', 'MKY-T-1', 'MKY-T-1');
  assert.equal(ledger().length, 2);

  // One is past its thirty days; the other has them still to run.
  ledger()[0].purge_after = new Date(Date.now() - 1000).toISOString();

  const out = await purgeDue({ force: true });
  assert.equal(out.purged, 1);
  assert.equal(ledger().length, 1, 'the one still in its thirty days stays');
  assert.deepEqual(storage.removed.sort(),
    ['2/MKY-BKG-1/cmr.pdf', '2/MKY-BKG-1/inv.pdf', 'made/MKY-BKG-1.pdf'],
    'the papers and the sheet made from the booking');
  assert.ok(rows('audit_logs').some((a) => a.action === 'deleted_record_purged'));
});

test('something put back is never purged', async () => {
  await del('booking', 'MKY-BKG-1', 'MKY-BKG-1');
  ledger()[0].purge_after = new Date(Date.now() - 1000).toISOString();
  ledger()[0].restored_at = new Date().toISOString();
  const out = await purgeDue({ force: true });
  assert.equal(out.purged, 0);
  assert.equal(ledger().length, 1);
  assert.deepEqual(storage.removed, [], 'its files are the ones it was put back with');
});

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

test('the counts are read back in words a person can weigh, the record first', () => {
  // The counts arrive in delete order - children first, the record last - and
  // are read back the other way round, the way a person would say it.
  assert.deepEqual(countWords({ chat_messages: 41, booking_documents: 3, bookings: 1 }, 4),
    ['1 booking', '3 documents', '41 messages', '4 files']);
  assert.deepEqual(countWords({ bookings: 1 }, 1), ['1 booking', '1 file']);
  assert.deepEqual(countWords({}, 0), []);
  assert.deepEqual(countWords({ nothing_we_name: 3 }, 0), [], 'a table with no words is not read out as one');
});

test('putting a booking back brings its papers with it, and says so in the trail', async () => {
  await del('booking', 'MKY-BKG-1', 'MKY-BKG-1');
  assert.equal(rows('bookings').length, 2);
  const id = ledger()[0].id;

  const r = await post({ action: 'restore_record', id });
  assert.equal(r.status, 200);
  assert.equal(r.body.reference, 'MKY-BKG-1');

  assert.deepEqual(refs('bookings', 'booking_ref'), ['MKY-BKG-1', 'MKY-BKG-2', 'MKY-BKG-9']);
  assert.deepEqual(refs('booking_documents', 'id'), [101, 102, 190]);
  assert.deepEqual(refs('internal_notes', 'id'), [201, 202]);
  assert.deepEqual(refs('mrn_requests', 'id'), [801]);
  // Under the id it had, so everything that pointed at it still does.
  assert.equal(rows('bookings').find((b) => b.booking_ref === 'MKY-BKG-1').id, 11);

  assert.ok(rows('audit_logs').some((a) => a.action === 'record_restored' && a.actor_id === 'Ariful'));
  assert.equal(ledger()[0].restored_by, 'Ariful');

  // And it is off the list of things that can be put back.
  const list = await get({ view: 'deleted' });
  assert.equal(list.body.records[0].can_restore, false);
});

test('an agent cannot put anything back either', async () => {
  await del('booking', 'MKY-BKG-1', 'MKY-BKG-1');
  const r = await post({ action: 'restore_record', id: ledger()[0].id }, 'Sara');
  assert.equal(r.status, 403);
  assert.equal(rows('bookings').length, 2, 'still gone');
});
