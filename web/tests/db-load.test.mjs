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
      customer_name: i % 2 ? `Cust ${i}` : null, customer_contact: '+201000000', vin: `YV2RT40A8FB7${String(i).padStart(5, '0')}`, make: 'Volvo',
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
function setup(options) {
  db = createDeskDb(seed(options));
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

