/**
 * How many times the desk and the bot go to the database.
 *
 * On Supabase's small instance every call is a PostgREST transaction: BEGIN,
 * four set_config()s, the statement, COMMIT, on a pool of a handful of
 * connections that the bot's writes share with the desk's reads. The
 * statements themselves take a tenth of a millisecond; the number of them is
 * the load. docs/SYSTEM-DESIGN-DB-LOAD.md has the measurements these numbers
 * come from, before and after.
 *
 * Each test counts the calls one thing makes (tests/helpers/count-db.mjs) and
 * holds it to a budget, so a change that quietly brings back a read per row,
 * or a refresh that re-reads everything when nothing changed, fails here.
 */

import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';
process.env.ADMIN_SECRET = 'desk-secret';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';

// The channel code is "not deployed" here, as in desk.test.mjs: the counts are
// the desk's own reads, not lib/channels.js's.
mock.module(new URL('../lib/admin/channels-bridge.js', import.meta.url).href, {
  namedExports: { channels: async () => null },
});
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) });

const { createDeskDb, withViews } = await import('./helpers/desk-db.mjs');
const { countCalls } = await import('./helpers/count-db.mjs');
const { setClientForTests } = await import('../lib/supabase.js');
const { invalidateSettings } = await import('../lib/settings.js');
const { flush } = await import('../lib/background.js');
const { default: handler } = await import('../lib/admin/console.js');
const { customerFor, customersFor, customerKey, invalidateTeam } = await import('../lib/admin/desk-shared.js');
const { withActivity } = await import('./helpers/activity-db.mjs');

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

/**
 * A desk with work on it: `n` customers, each with an open booking and three
 * papers, every third with a call-back, every fourth with an MRN application,
 * and `failing` of them with a message that did not go through.
 */
function seed({ n = 12, failing = 3 } = {}) {
  const t = {
    ops_users: [
      { name: 'Sara', role: 'ops_agent', active: true },
      { name: 'Ariful', role: 'admin', active: true },
    ],
    bot_settings: [
      { key: 'required_booking_documents', value: ['invoice', 'brief', 'mrn'] },
      { key: 'required_booking_documents_mky_mrn', value: ['invoice', 'brief'] },
    ],
    clients: [], conversation_sessions: [], bookings: [], booking_documents: [], support_tickets: [],
    chat_messages: [], mrn_requests: [], notification_outbox: [], audit_logs: [],
    shipments: [{ shipment_id: 'MKY-26001', booking_ref: 'MKY-BKG-1', customer_name: 'Cust 1', status: 'In transit', updated_at: iso(86400_000), delivery_status: 'Not yet' }],
  };
  let id = 1;
  for (let i = 0; i < n; i++) {
    const chat = `wa:2010000${String(i).padStart(5, '0')}`;
    t.clients.push({ id: 100 + i, whatsapp_id: chat.slice(3), whatsapp_name: `Cust ${i}`, language: 'en' });
    t.conversation_sessions.push({ id: `whatsapp:${chat}`, channel: 'whatsapp', chat_id: chat, client_id: 100 + i, current_state: 'MAIN_MENU', last_client_message_at: iso(3600_000), updated_at: iso(3600_000) });
    t.bookings.push({
      booking_ref: `MKY-BKG-${i}`, status: ['pending_review', 'under_review', 'needs_client_action'][i % 3], channel: 'whatsapp', chat_id: chat, client_id: 100 + i,
      customer_name: `Cust ${i}`, customer_contact: '+201000000', vin: `YV2RT40A8FB7${String(i).padStart(5, '0')}`, make: 'Volvo',
      origin_port: 'Klaipeda', destination_port: 'Alexandria', mrn_choice: i % 4 === 0 ? 'mky_issue' : 'existing', priority: 'normal',
      created_at: iso(5 * 3600_000), submitted_at: iso(5 * 3600_000), status_changed_at: iso(5 * 3600_000), edit_history: [],
    });
    for (const type of ['invoice', 'brief', 'mrn']) {
      t.booking_documents.push({ id: id++, booking_ref: `MKY-BKG-${i}`, chat_id: chat, doc_type: type, status: 'received', extraction_ok: true, extracted: { ok: true }, uploaded_at: iso(4 * 3600_000) });
    }
    t.chat_messages.push({ id: id++, channel: 'whatsapp', chat_id: chat, client_id: 100 + i, direction: 'in', author: 'client', kind: 'text', body: 'hi', status: 'received', created_at: iso(20 * 60_000) });
    if (i < failing) {
      t.chat_messages.push({ id: id++, channel: 'whatsapp', chat_id: chat, client_id: 100 + i, direction: 'out', author: 'bot', kind: 'text', body: 'x', status: 'failed', error: '(#131047) Re-engagement', created_at: iso(10 * 60_000) });
    }
    if (i % 3 === 0) {
      t.support_tickets.push({ ticket_ref: `MKY-T-${i}`, status: 'open', channel: 'whatsapp', chat_id: chat, client_id: 100 + i, department: 'Booking Operations', customer: `Cust ${i}`, contact: '+20 100 000 0001', summary: 'call me', request_type: 'booking', priority: 'normal', created_at: iso(40 * 60_000), status_changed_at: iso(40 * 60_000) });
    }
    if (i % 4 === 0) {
      t.mrn_requests.push({ request_ref: `MKY-MRN-${i}`, booking_ref: i % 8 === 0 ? null : `MKY-BKG-${i}`, chat_id: chat, client_id: i % 8 === 0 ? null : 100 + i, status: 'submitted', created_at: iso(3600_000) });
    }
  }
  return withViews(t);
}

let db;
let activity = null;
/** A fresh desk; `activity: true` gives it the migration's desk_activity and triggers. */
function setup({ activity: withPulse = false, ...options } = {}) {
  db = createDeskDb(seed(options));
  activity = withPulse ? withActivity(db) : null;
  setClientForTests(db);
  invalidateSettings();
  invalidateTeam();
  return db;
}
beforeEach(() => setup());

async function call({ method = 'GET', query = {}, body, operator = 'Sara', headers = {} } = {}) {
  const req = {
    method,
    query: { resource: 'console', ...(method === 'GET' ? { operator } : {}), ...query },
    headers: { 'x-admin-secret': 'desk-secret', ...headers },
    body: method === 'POST' ? { operator, ...body } : undefined,
  };
  let status = 200;
  let payload;
  const sent = {};
  const res = {
    status(c) { status = c; return this; },
    json(p) { payload = p; return this; },
    setHeader(k, v) { sent[String(k).toLowerCase()] = v; return this; },
    send(p) { payload = p; return this; },
    end() { return this; },
  };
  await handler(req, res);
  await flush();
  return { status, body: payload, headers: sent };
}
const get = (query, operator = 'Sara', headers = {}) => call({ query, operator, headers });
const post = (body, operator = 'Sara') => call({ method: 'POST', body, operator });

/** Counts the calls `fn` makes. */
async function counted(fn) {
  const rec = countCalls(db);
  const out = await fn();
  return { rec, out };
}

// ---------------------------------------------------------------------------
// What every request costs
// ---------------------------------------------------------------------------

test('who is asking is checked from the team list read once, not once per request', async () => {
  const { rec } = await counted(async () => {
    for (let i = 0; i < 5; i++) assert.equal((await get({ view: 'counts' })).status, 200);
    assert.equal((await get({ view: 'counts' }, 'Mallory')).status, 403, 'a stranger is still refused');
  });
  assert.equal(rec.byTable().ops_users, 1, rec.lines().join('\n'));
});

test('a change to the team made here is seen at once, without waiting for the cache', async () => {
  assert.equal((await get({ view: 'counts' }, 'Rita')).status, 403);
  const made = await post({ action: 'user_save', name: 'Rita', role: 'ops_agent', active: true }, 'Ariful');
  assert.equal(made.status, 200);
  assert.equal((await get({ view: 'counts' }, 'Rita')).status, 200, 'the new person is in');
  await post({ action: 'user_save', name: 'Rita', role: 'ops_agent', active: false }, 'Ariful');
  const off = await get({ view: 'counts' }, 'Rita');
  assert.equal(off.status, 403);
  assert.match(off.body.error, /no longer active/);
});

test('several customers are looked up in at most four reads, and each answer is what customerFor gives', async () => {
  db._tables.clients.push({ id: 900, telegram_chat_id: 555, telegram_username: 'nile' });
  db._tables.conversation_sessions.push({ id: 'telegram:555', channel: 'telegram', chat_id: '555', client_id: null, current_state: 'BOOK_VIN', language: 'ar' });
  const asks = [
    { clientId: 101, channel: 'whatsapp', chatId: 'wa:201000000001' },        // by id
    { clientId: null, channel: 'whatsapp', chatId: 'wa:201000000002' },       // through the session
    { clientId: null, channel: 'whatsapp', chatId: 'wa:209999999999' },       // nobody we know
    { clientId: null, channel: 'telegram', chatId: '555' },                   // by Telegram chat
    { clientId: 4242, channel: 'whatsapp', chatId: 'wa:201000000003' },      // a client id with no row
    { clientId: null, channel: null, chatId: null },
  ];
  const { rec, out } = await counted(() => customersFor(asks));
  assert.ok(rec.count <= 4, rec.lines().join('\n'));
  for (const ask of asks) {
    assert.deepEqual(out.get(customerKey(ask)), await customerFor(ask), JSON.stringify(ask));
  }
});


test('the inbox costs the same number of reads however many chats have a failed message', async () => {
  setup({ n: 12, failing: 2 });
  await get({ view: 'me' });   // the team, read once, as on a warm instance
  const few = await counted(() => get({ view: 'inbox' }));
  setup({ n: 12, failing: 12 });
  await get({ view: 'me' });
  const many = await counted(() => get({ view: 'inbox' }));

  assert.equal(few.out.status, 200);
  assert.ok(many.out.body.counts.filters.problems > few.out.body.counts.filters.problems);
  assert.equal(many.rec.count, few.rec.count, `\n${few.rec.lines().join('\n')}\n---\n${many.rec.lines().join('\n')}`);
  assert.ok(many.rec.count <= 15, many.rec.lines().join('\n'));
});

test('the inbox carries the sidebar numbers, so the desk need not ask for them separately', async () => {
  const inbox = await get({ view: 'inbox' });
  const counts = await get({ view: 'counts' });
  assert.deepEqual(inbox.body.nav, counts.body);
});

// ---------------------------------------------------------------------------
// The pulse, and answers that have not changed
// ---------------------------------------------------------------------------

test('the pulse is one read, and says which areas of the desk have moved', async () => {
  setup({ activity: true });
  await get({ view: 'me' });
  const { rec, out } = await counted(() => get({ view: 'pulse' }));
  assert.equal(out.status, 200);
  assert.equal(out.body.supported, true);
  assert.deepEqual(Object.keys(out.body.versions).sort(), ['bookings', 'customers', 'history', 'messages', 'outbox', 'problems', 'requests', 'shipments', 'team']);
  assert.equal(rec.count, 1, rec.lines().join('\n'));

  await post({ action: 'take', booking_ref: 'MKY-BKG-0' });
  const after = await get({ view: 'pulse' });
  assert.notEqual(after.body.versions.bookings, out.body.versions.bookings, 'taking a case moved the bookings');
  assert.equal(after.body.versions.shipments, out.body.versions.shipments, 'and nothing it does not touch');
});

test('a refresh with nothing changed is one cheap read: the inbox answers 304 without being worked out', async () => {
  setup({ activity: true });
  await get({ view: 'me' });
  const first = await get({ view: 'inbox' });
  assert.equal(first.status, 200);
  assert.match(first.headers.etag, /^W\/"v-/);

  const { rec, out } = await counted(() => get({ view: 'inbox' }, 'Sara', { 'if-none-match': first.headers.etag }));
  assert.equal(out.status, 304);
  assert.equal(out.body, undefined, 'no body');
  assert.equal(rec.count, 1, rec.lines().join('\n'));
});

test('a change the inbox shows is a new answer; a change it does not show is still 304', async () => {
  setup({ activity: true });
  await get({ view: 'me' });
  const first = await get({ view: 'inbox' });

  // A message delivered in somebody's chat: not on the inbox.
  db._tables.chat_messages.push({ id: 9999, channel: 'whatsapp', chat_id: 'wa:201000000001', direction: 'out', author: 'bot', kind: 'text', body: 'ok', status: 'sent', created_at: new Date().toISOString() });
  activity.bump('messages');
  assert.equal((await get({ view: 'inbox' }, 'Sara', { 'if-none-match': first.headers.etag })).status, 304);

  // A case taken: on the inbox.
  await post({ action: 'take', booking_ref: 'MKY-BKG-0' });
  const after = await get({ view: 'inbox' }, 'Sara', { 'if-none-match': first.headers.etag });
  assert.equal(after.status, 200);
  assert.notEqual(after.headers.etag, first.headers.etag);
});

test('the answer depends on who asks: another operator\'s tag is never theirs', async () => {
  setup({ activity: true });
  const sara = await get({ view: 'counts' }, 'Sara');
  const ariful = await get({ view: 'counts' }, 'Ariful', { 'if-none-match': sara.headers.etag });
  assert.equal(ariful.status, 200, '"mine" is per person');
});

test('ten operators asking for the inbox under the same versions work it out once', async () => {
  setup({ activity: true });
  for (const name of ['Omar', 'Mona', 'Karim', 'Laila', 'Hany', 'Dina', 'Tarek', 'Nour']) db._tables.ops_users.push({ name, role: 'ops_agent', active: true });
  invalidateTeam();
  await get({ view: 'me' });
  const first = await counted(() => get({ view: 'inbox' }, 'Sara'));
  const rest = await counted(async () => {
    for (const name of ['Ariful', 'Omar', 'Mona', 'Karim', 'Laila', 'Hany', 'Dina', 'Tarek', 'Nour']) {
      assert.equal((await get({ view: 'inbox' }, name)).status, 200);
    }
  });
  assert.ok(first.rec.count > 5, first.rec.lines().join('\n'));
  assert.equal(rest.rec.count, 9, `one pulse read each, the rows shared:\n${rest.rec.lines().join('\n')}`);
});

test('what depends on the clock is worked out again after five minutes, changed or not', async (t) => {
  setup({ activity: true });
  await get({ view: 'me' });
  const first = await get({ view: 'inbox' });
  const start = Date.now();
  t.mock.method(Date, 'now', () => start + 301_000);
  const later = await get({ view: 'inbox' }, 'Sara', { 'if-none-match': first.headers.etag });
  assert.equal(later.status, 200, '"overdue" and "done today" may have moved');
});

test('before the migration the desk still works: no pulse, a hash for an ETag, nothing shared', async () => {
  setup();   // no desk_activity
  await get({ view: 'me' });
  const pulse = await get({ view: 'pulse' });
  assert.equal(pulse.body.supported, false);
  const first = await get({ view: 'inbox' });
  assert.match(first.headers.etag, /^W\/"b-/);
  const again = await counted(() => get({ view: 'inbox' }, 'Sara', { 'if-none-match': first.headers.etag }));
  assert.equal(again.out.status, 304, 'the same answer is not sent twice');
  assert.ok(again.rec.count > 5, 'but it was worked out: there is nothing to vouch for it');

  await post({ action: 'take', booking_ref: 'MKY-BKG-0' });
  db._tables.booking_queue.find((b) => b.booking_ref === 'MKY-BKG-0').assigned_to = 'Sara';
  const after = await get({ view: 'inbox' }, 'Sara', { 'if-none-match': first.headers.etag });
  assert.equal(after.status, 200, 'and a changed answer is sent');
});

test('search and previews are never answered from a tag: they are asked for, not polled', async () => {
  setup({ activity: true });
  const r = await get({ view: 'search', q: 'Cust 1' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.etag, undefined);
});

// ---------------------------------------------------------------------------
// Lists read what they show
// ---------------------------------------------------------------------------

/** 250 shipments; one write gave 120 of them the same updated_at, as a bulk update would. */
function manyShipments() {
  const same = iso(7 * 86400_000);
  db._tables.shipments = Array.from({ length: 250 }, (_, i) => ({
    shipment_id: `MKY-${String(30000 + i)}`, booking_ref: null, customer_name: i === 3 ? 'Old Customer Ltd' : `Cust ${i}`,
    origin_port: 'Antwerp', destination_port: 'Port Said', status: 'In transit', delivery_status: i % 5 === 0 ? 'Complete' : 'Not yet',
    updated_at: i < 120 ? same : iso(i * 60_000), vin: `VIN${i}`,
  }));
}

test('shipments come a page at a time, each exactly once, even when many share an update time', async () => {
  manyShipments();
  const seen = [];
  let after = null;
  let pages = 0;
  do {
    const r = await get({ view: 'shipments', filter: 'all', limit: 40, ...(after ? { after } : {}) });
    assert.equal(r.status, 200);
    if (!after) assert.deepEqual(r.body.counts, { active: 200, delivered: 50, all: 250 });
    seen.push(...r.body.rows.map((s) => s.shipment_id));
    after = r.body.next;
    pages += 1;
  } while (after && pages < 20);
  assert.equal(seen.length, 250);
  assert.equal(new Set(seen).size, 250, 'no shipment twice, none skipped');
});

test('a search finds a shipment the first page does not show, and is filtered in the database', async () => {
  manyShipments();
  const first = await get({ view: 'shipments', filter: 'all' });
  assert.ok(!first.body.rows.some((s) => s.customer_name === 'Old Customer Ltd'), 'not on the first page');
  const { rec, out } = await counted(() => get({ view: 'shipments', filter: 'all', q: 'old customer' }));
  assert.deepEqual(out.body.rows.map((s) => s.customer_name), ['Old Customer Ltd']);
  assert.ok(rec.lines().some((l) => /select shipments \[.*or\(…\)/.test(l)), rec.lines().join('\n'));
});
