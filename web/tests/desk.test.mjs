/**
 * The MKY Desk's API, end to end against the fake database.
 *
 * What these pin down is what the desk promises the people using it:
 *   - nobody acts without the secret and a name on the team, and a role only
 *     does what it is allowed to - refused with a sentence that says who can;
 *   - an action on a case somebody else changed is refused with who and when;
 *   - a message to a customer is sent once, however many times Send is pressed;
 *   - the desk keeps working when lib/channels.js or the new tables are not
 *     there yet, and says so in words instead of crashing;
 *   - customer text comes back as data, and the desk never turns it into HTML.
 *
 * lib/channels.js belongs to another work package and may not exist here, so
 * the desk's door to it (lib/admin/channels-bridge.js) is replaced with node's
 * module mocks: each test decides whether the channel code is "deployed".
 */

import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';
process.env.ADMIN_SECRET = 'desk-secret';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';

// -- the channel code, as each test wants it ---------------------------------
const channelsState = { deployed: false, api: null };
mock.module(new URL('../lib/admin/channels-bridge.js', import.meta.url).href, {
  namedExports: { channels: async () => (channelsState.deployed ? channelsState.api : null) },
});

/** A stand-in for lib/channels.js that records what it was asked to send. */
function fakeChannels({ open = true, result = { ok: true, status: 'sent', providerMessageId: 'wamid.1' } } = {}) {
  const calls = { send: [], reopen: [] };
  return {
    calls,
    api: {
      async sendToChat(target, message, opts) { calls.send.push({ target, message, opts }); return typeof result === 'function' ? result() : result; },
      // Shapes as lib/channels.js returns them.
      async windowState() {
        return open
          ? { applies: true, open: true, known: true, lastClientMessageAt: new Date(Date.now() - 3 * 3600_000).toISOString(), closesAt: new Date(Date.now() + 21 * 3600_000).toISOString() }
          : { applies: true, open: false, known: true, lastClientMessageAt: new Date(Date.now() - 50 * 3600_000).toISOString(), closesAt: new Date(Date.now() - 26 * 3600_000).toISOString() };
      },
      async sendReopenTemplate(target, opts) { calls.reopen.push({ target, opts }); return { ok: true, status: 'sent' }; },
    },
  };
}

// -- Telegram, without the network --------------------------------------------
const telegramCalls = [];
globalThis.fetch = async (url, init) => {
  telegramCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: telegramCalls.length } }) };
};

const { createDeskDb, withViews } = await import('./helpers/desk-db.mjs');
const { setClientForTests } = await import('../lib/supabase.js');
const { invalidateSettings } = await import('../lib/settings.js');
const { flush } = await import('../lib/background.js');
const { default: handler } = await import('../lib/admin/console.js');
const { composerState } = await import('../lib/admin/desk-chat.js');
const { failureWords, ticketResolvedText } = await import('../lib/admin/desk-messages.js');
const { notifyTicketResolved } = await import('../lib/notify.js');

const SECRET = 'desk-secret';
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const WA = 'wa:201005551234';

const USERS = [
  { name: 'Sara', role: 'ops_agent', active: true },
  { name: 'Omar', role: 'ops_supervisor', active: true },
  { name: 'Ariful', role: 'admin', active: true },
  { name: 'Rita', role: 'read_only', active: true },
  { name: 'Former', role: 'ops_agent', active: false },
];

function seed(extra = {}) {
  return withViews({
    ops_users: USERS.map((u) => ({ ...u })),
    bot_settings: [
      { key: 'required_mrn_documents', value: [] },
      { key: 'required_booking_documents', value: ['invoice', 'brief', 'mrn'] },
      { key: 'whatsapp_templates', value: { missing_information_requested: { name: 'mky_information_needed', params: ['booking_ref', 'what'] } } },
    ],
    clients: [
      { id: 1, telegram_user_id: 999, telegram_chat_id: 555, display_name: 'Nile Motors', phone: '+20 100 000 0001' },
      // The name a customer chose on WhatsApp is theirs to type, script tags and all.
      { id: 2, whatsapp_id: '201005551234', whatsapp_name: '<script>alert(1)</script>', language: 'ar', phone: '+201005551234' },
      { id: 3, whatsapp_id: '201007770000', whatsapp_name: 'Stopped', language: 'en', opted_out_at: iso(2 * 86400_000) },
    ],
    conversation_sessions: [
      { id: `whatsapp:${WA}`, channel: 'whatsapp', chat_id: WA, client_id: 2, current_state: 'MAIN_MENU', last_client_message_at: iso(3 * 3600_000), updated_at: iso(3 * 3600_000) },
      { id: 'whatsapp:wa:201007770000', channel: 'whatsapp', chat_id: 'wa:201007770000', client_id: 3, current_state: 'MAIN_MENU', last_client_message_at: iso(3 * 86400_000), updated_at: iso(3 * 86400_000) },
      { id: 'telegram:555', channel: 'telegram', chat_id: '555', client_id: 1, current_state: 'MAIN_MENU', updated_at: iso(86400_000) },
    ],
    bookings: [
      {
        booking_ref: 'MKY-BKG-1', status: 'pending_review', channel: 'telegram', chat_id: '555', client_id: 1,
        customer_name: 'Nile Motors', customer_contact: '+20 100 000 0001', vin: 'YV2RT40A8FB712905', make: 'Volvo', model: 'FH',
        origin_port: 'Klaipeda', destination_port: 'Alexandria Port (incl. El Dekheila)', mrn_choice: 'existing', priority: 'normal',
        created_at: iso(5 * 3600_000), submitted_at: iso(5 * 3600_000), status_changed_at: iso(5 * 3600_000), edit_history: [],
      },
      {
        booking_ref: 'MKY-BKG-2', status: 'needs_client_action', channel: 'whatsapp', chat_id: WA, client_id: 2,
        customer_name: 'Delta Trans', customer_contact: '+201005551234', vin: 'WDB9634031L000001', make: 'Mercedes-Benz',
        origin_port: 'Antwerp', destination_port: 'Port Said', mrn_choice: 'existing', priority: 'urgent',
        created_at: iso(30 * 3600_000), status_changed_at: iso(26 * 3600_000), edit_history: [],
      },
      {
        booking_ref: 'MKY-BKG-3', status: 'confirmed', channel: 'telegram', chat_id: '555', client_id: 1,
        customer_name: 'Nile Motors', customer_contact: '+20 100 000 0001', vin: 'XLRTE47MS0E000003', make: 'DAF',
        origin_port: 'Rotterdam', destination_port: 'Damietta Port', confirmed_at: iso(60_000), confirmed_by: 'Omar',
        created_at: iso(48 * 3600_000), edit_history: [],
      },
    ],
    booking_documents: [
      { id: 101, booking_ref: 'MKY-BKG-1', chat_id: '555', doc_type: 'invoice', status: 'received', vin: 'YV2RT40A8FB712905', storage_path: '1/MKY-BKG-1/inv.pdf', mime_type: 'application/pdf', extraction_ok: true, extracted: { ok: true, vin: 'YV2RT40A8FB712905', make: 'VOLVO' }, uploaded_at: iso(5 * 3600_000) },
      { id: 102, booking_ref: 'MKY-BKG-1', chat_id: '555', doc_type: 'brief', status: 'received', vin: 'YV2RT40A8FB799999', storage_path: '1/MKY-BKG-1/cmr.pdf', mime_type: 'application/pdf', extraction_ok: true, extracted: { ok: true, vin: 'YV2RT40A8FB799999' }, uploaded_at: iso(5 * 3600_000) },
      { id: 103, booking_ref: 'MKY-BKG-1', chat_id: '555', doc_type: 'mrn', status: 'received', storage_path: '1/MKY-BKG-1/mrn.jpg', mime_type: 'image/jpeg', extraction_ok: false, needs_ocr: true, extracted: { ok: false, needs_ocr: true, message: 'no text' }, uploaded_at: iso(4 * 3600_000) },
      { id: 201, booking_ref: 'MKY-BKG-2', chat_id: WA, doc_type: 'invoice', status: 'verified', verified_by: 'Sara', vin: 'WDB9634031L000001', storage_path: '2/MKY-BKG-2/inv.pdf', extraction_ok: true, extracted: { ok: true }, uploaded_at: iso(30 * 3600_000) },
    ],
    support_tickets: [
      { ticket_ref: 'MKY-T-1', status: 'open', channel: 'telegram', chat_id: '555', client_id: 1, department: 'Booking Operations', customer: 'Nile Motors', contact: '+20 100 000 0001', summary: 'Please call me about the Volvo', request_type: 'booking', priority: 'normal', created_at: iso(40 * 60_000), status_changed_at: iso(40 * 60_000) },
    ],
    chat_messages: [
      { id: 1, channel: 'whatsapp', chat_id: WA, client_id: 2, direction: 'in', author: 'client', kind: 'text', body: 'السلام عليكم، فين الشحنة؟', status: 'received', created_at: iso(3 * 3600_000) },
      { id: 2, channel: 'whatsapp', chat_id: WA, client_id: 2, direction: 'out', author: 'bot', kind: 'text', body: 'أهلاً بيك', status: 'read', created_at: iso(3 * 3600_000 - 1000) },
      { id: 3, channel: 'whatsapp', chat_id: WA, client_id: 2, direction: 'out', author: 'staff', staff_name: 'Sara', kind: 'text', body: 'We are checking.', status: 'failed', error: '(#131047) Re-engagement message', created_at: iso(2 * 3600_000) },
    ],
    shipments: [
      { shipment_id: 'MKY-26001', booking_ref: 'MKY-BKG-2', customer_name: 'Delta Trans', origin_port: 'Antwerp', destination_port: 'Port Said', status: 'In transit', vin: 'WDB9634031L000001', channel: 'whatsapp', chat_id: WA, updated_at: iso(86400_000), delivery_status: 'Not yet' },
    ],
    ...extra,
  });
}

let db;
function setup(extra = {}, schema = {}) {
  db = createDeskDb(seed(extra), schema);
  setClientForTests(db);
  invalidateSettings();
  channelsState.deployed = false;
  channelsState.api = null;
  telegramCalls.length = 0;
  return db;
}

beforeEach(() => setup());

/** Calls the API the way the desk does. */
async function call({ method = 'GET', query = {}, body, secret = SECRET, operator = 'Sara' } = {}) {
  const req = {
    method,
    query: { resource: 'console', ...(method === 'GET' && operator ? { operator } : {}), ...query },
    headers: secret ? { 'x-admin-secret': secret } : {},
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

const get = (query, operator = 'Sara') => call({ query, operator });
const post = (body, operator = 'Sara') => call({ method: 'POST', body, operator });
/** A table's rows - created if nothing has written to it yet, so a test can seed it. */
const rows = (name) => (db._tables[name] ??= []);

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

test('no secret, or the wrong one, gets nothing', async () => {
  assert.equal((await call({ query: { view: 'inbox' }, secret: null })).status, 401);
  assert.equal((await call({ query: { view: 'inbox' }, secret: 'guess' })).status, 401);
});

test('a name that is not on the team, or no longer active, is refused in words', async () => {
  const stranger = await get({ view: 'inbox' }, 'Mallory');
  assert.equal(stranger.status, 403);
  assert.match(stranger.body.error, /not on the team list/);

  const former = await get({ view: 'inbox' }, 'Former');
  assert.equal(former.status, 403);
  assert.match(former.body.error, /no longer active/);
});

test('me says who you are, what you may do, and what is connected', async () => {
  const r = await get({ view: 'me' }, 'sara');   // any capitalisation of the name
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Sara');
  assert.equal(r.body.role_words, 'Agent');
  assert.ok(r.body.permissions.includes('chat'));
  assert.equal(r.body.features.channels, false, 'lib/channels.js is not deployed in this test');
  assert.equal(r.body.features.chat_messages, true);
  assert.ok(r.body.saved_replies.length > 0, 'saved replies have sensible defaults');
});

test('an empty team lets the first person in as administrator, once', async () => {
  setup({ ops_users: [] });
  const first = await get({ view: 'me' }, 'Ariful');
  assert.deepEqual(first.body, { bootstrap: true });

  const made = await post({ action: 'bootstrap_admin' }, 'Ariful');
  assert.equal(made.status, 200);
  assert.equal(rows('ops_users')[0].role, 'admin');

  const again = await post({ action: 'bootstrap_admin' }, 'Mallory');
  assert.equal(again.status, 409, 'the door shuts once somebody is in');
});

test('a read-only person can look but every change is refused, saying why', async () => {
  const look = await get({ view: 'case', type: 'booking', ref: 'MKY-BKG-1' }, 'Rita');
  assert.equal(look.status, 200);
  assert.equal(look.body.document_actions.verify.enabled, false);
  assert.match(look.body.document_actions.verify.reason, /read only/);

  const act = await post({ action: 'verify_document', document_id: 101 }, 'Rita');
  assert.equal(act.status, 403);
  assert.match(act.body.error, /read only/);
  assert.equal(rows('booking_documents').find((d) => d.id === 101).status, 'received', 'nothing was written');
});

test('an agent cannot change priority or hand work to someone else; a supervisor can', async () => {
  const pr = await post({ action: 'priority', booking_ref: 'MKY-BKG-1', priority: 'urgent' }, 'Sara');
  assert.equal(pr.status, 403);
  assert.match(pr.body.error, /Only a supervisor/);

  const give = await post({ action: 'assign', booking_ref: 'MKY-BKG-1', assignee: 'Omar' }, 'Sara');
  assert.equal(give.status, 403);

  const ok = await post({ action: 'assign', booking_ref: 'MKY-BKG-1', assignee: 'Sara' }, 'Omar');
  assert.equal(ok.status, 200);
  assert.equal(rows('bookings').find((b) => b.booking_ref === 'MKY-BKG-1').assigned_to, 'Sara');
});

test('settings are for administrators only', async () => {
  const agent = await get({ view: 'settings' }, 'Sara');
  assert.equal(agent.status, 403);
  assert.match(agent.body.error, /Only an administrator/);
  const admin = await get({ view: 'settings' }, 'Ariful');
  assert.equal(admin.status, 200);
});

// ---------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------

test('the inbox says what to do, in sentences, most urgent first', async () => {
  const r = await get({ view: 'inbox', tab: 'needs_us' });
  assert.equal(r.status, 200);
  const sentences = r.body.items.map((i) => i.sentence);

  assert.ok(sentences.some((s) => /^Check 3 documents and confirm$/.test(s)), sentences.join(' | '));
  assert.ok(sentences.some((s) => /^Call back \+20 100 000 0001$/.test(s)));
  assert.ok(sentences.some((s) => /Message failed — couldn’t reach Delta Trans/.test(s)));
  assert.ok(sentences.some((s) => /Couldn’t read the MRN/.test(s)), 'an unreadable file is its own line');
  assert.equal(r.body.items[0].kind, 'problem', 'something wrong comes first');

  for (const i of r.body.items) {
    assert.doesNotMatch(i.sentence, /_/, `"${i.sentence}" leaks a database value`);
    assert.ok(i.since, 'every row has an age');
  }
});

test('the tabs split our move from the customer’s and from what is done today', async () => {
  const r = await get({ view: 'inbox', tab: 'waiting' });
  assert.deepEqual(r.body.items.map((i) => i.ref), ['MKY-BKG-2']);
  assert.match(r.body.items[0].sentence, /Waiting for the customer to send the Brief and MRN/);
  assert.equal(r.body.items[0].tone, 'amber');

  const done = await get({ view: 'inbox', tab: 'done' });
  assert.ok(done.body.items.some((i) => i.ref === 'MKY-BKG-3' && /Confirmed by Omar/.test(i.sentence)));
  assert.ok(r.body.counts.tabs.needs_us >= 4);
});

test('filters narrow the list and count what they hold', async () => {
  const problems = await get({ view: 'inbox', filter: 'problems' });
  assert.ok(problems.body.items.length >= 2);
  assert.ok(problems.body.items.every((i) => i.kind === 'problem'));
  assert.equal(problems.body.counts.filters.problems, problems.body.items.length);

  await post({ action: 'take', booking_ref: 'MKY-BKG-1' }, 'Sara');
  setClientForTests(db);
  // booking_queue is a view; in the fake it is refreshed by hand.
  db._tables.booking_queue.find((b) => b.booking_ref === 'MKY-BKG-1').assigned_to = 'Sara';
  const mine = await get({ view: 'inbox', filter: 'mine' }, 'Sara');
  // Her case, and the unreadable file on her case: both are hers to deal with.
  assert.ok(mine.body.items.some((i) => i.id === 'booking:MKY-BKG-1'));
  assert.ok(mine.body.items.every((i) => i.ref === 'MKY-BKG-1'));
  const omar = await get({ view: 'inbox', filter: 'mine' }, 'Omar');
  assert.equal(omar.body.items.length, 0);
});

test('the inbox works before the message table exists, and says so', async () => {
  setup({}, { missingTables: ['chat_messages'] });
  const r = await get({ view: 'inbox' });
  assert.equal(r.status, 200);
  assert.equal(r.body.features.chat_messages, false);
  assert.ok(!r.body.items.some((i) => i.id.startsWith('message:')));
  assert.ok(r.body.items.some((i) => i.ref === 'MKY-BKG-1'), 'bookings still listed');
});

test('counts feed the tab title', async () => {
  const r = await get({ view: 'counts' });
  assert.equal(r.status, 200);
  assert.ok(r.body.needs_us >= 4);
  assert.ok(r.body.problems >= 2);
});

// ---------------------------------------------------------------------------
// The case page
// ---------------------------------------------------------------------------

test('a booking case: one next step, a checklist that says what is wrong, and a version', async () => {
  const r = await get({ view: 'case', type: 'booking', ref: 'MKY-BKG-1' });
  assert.equal(r.status, 200);
  assert.match(r.body.version, /^v[0-9a-z]+$/);
  assert.equal(r.body.header.status_words, 'New request');
  assert.equal(r.body.next_step.primary.action, 'open_document');
  assert.equal(r.body.next_step.primary.enabled, true);
  assert.equal(r.body.take.state, 'nobody');

  const state = Object.fromEntries(r.body.checklist.map((c) => [c.type, c.state]));
  assert.deepEqual(state, { invoice: 'received', brief: 'mismatch', mrn: 'unreadable' });

  const brief = r.body.documents.find((d) => d.id === 102);
  assert.equal(brief.wrong_vehicle, true);
  assert.deepEqual(brief.checks.find((c) => c.field === 'vin'), {
    field: 'vin', label: 'Chassis', document: 'YV2RT40A8FB799999', booking: 'YV2RT40A8FB712905', match: false,
  });
  const invoice = r.body.documents.find((d) => d.id === 101);
  assert.equal(invoice.checks.find((c) => c.field === 'make').match, true, 'VOLVO and Volvo are one make');
  assert.equal(r.body.documents.find((d) => d.id === 103).unreadable, true);
});

test('Confirm is offered disabled, with what is missing, until the booking is complete', async () => {
  setup({ booking_documents: [] });
  const r = await get({ view: 'case', type: 'booking', ref: 'MKY-BKG-1' });
  const confirm = r.body.next_step.secondary.find((b) => b.action === 'confirm');
  assert.equal(confirm.enabled, false);
  assert.match(confirm.reason, /Not ready yet: Invoice, Brief and MRN/);
  assert.equal(r.body.next_step.primary.action, 'request_info');
  assert.match(r.body.next_step.primary.label, /Ask for the Invoice, Brief and MRN/);
});

test('a case changed by somebody else refuses the action, naming who and when', async () => {
  const seen = (await get({ view: 'case', type: 'booking', ref: 'MKY-BKG-1' }, 'Sara')).body.version;
  const omar = (await get({ view: 'case', type: 'booking', ref: 'MKY-BKG-1' }, 'Omar')).body.version;
  assert.equal(seen, omar);

  const first = await post({ action: 'verify_document', document_id: 101, version: omar }, 'Omar');
  assert.equal(first.status, 200);

  const late = await post({ action: 'verify_document', document_id: 103, version: seen }, 'Sara');
  assert.equal(late.status, 409);
  assert.equal(late.body.stale, true);
  assert.match(late.body.error, /^Omar checked the Invoice (just now|\d+ min ago)\. The page now shows the latest\.$/);
  assert.equal(rows('booking_documents').find((d) => d.id === 103).status, 'received', 'the stale action wrote nothing');

  const fresh = (await get({ view: 'case', type: 'booking', ref: 'MKY-BKG-1' }, 'Sara')).body.version;
  const retry = await post({ action: 'verify_document', document_id: 103, version: fresh }, 'Sara');
  assert.equal(retry.status, 200, 'with the latest version it goes through');
});

test('a note from a colleague does not make your action stale', async () => {
  const seen = (await get({ view: 'case', type: 'booking', ref: 'MKY-BKG-1' })).body.version;
  await post({ action: 'internal_note', booking_ref: 'MKY-BKG-1', body: 'Customer called, all fine.' }, 'Omar');
  const r = await post({ action: 'verify_document', document_id: 101, version: seen }, 'Sara');
  assert.equal(r.status, 200);
});

test('taking a new case makes it yours and "being checked"', async () => {
  const v = (await get({ view: 'case', type: 'booking', ref: 'MKY-BKG-1' })).body.version;
  const r = await post({ action: 'take', booking_ref: 'MKY-BKG-1', version: v }, 'Sara');
  assert.equal(r.status, 200);
  const b = rows('bookings').find((x) => x.booking_ref === 'MKY-BKG-1');
  assert.equal(b.assigned_to, 'Sara');
  assert.equal(b.status, 'under_review');

  const steal = await post({ action: 'take', booking_ref: 'MKY-BKG-1' }, 'Ariful');
  assert.equal(steal.status, 200, 'an administrator may take it over');
});

test('correcting a detail is recorded with what it was', async () => {
  const v = (await get({ view: 'case', type: 'booking', ref: 'MKY-BKG-1' })).body.version;
  const r = await post({ action: 'edit_details', booking_ref: 'MKY-BKG-1', version: v, field: 'make', value: 'Volvo Trucks' });
  assert.equal(r.status, 200);
  const b = rows('bookings').find((x) => x.booking_ref === 'MKY-BKG-1');
  assert.equal(b.make, 'Volvo Trucks');
  assert.deepEqual(b.edit_history.at(-1).from, 'Volvo');
  const trail = rows('audit_logs').find((a) => a.action === 'booking_details_corrected');
  assert.equal(trail.metadata.from, 'Volvo');
  assert.equal(trail.metadata.to, 'Volvo Trucks');
});

test('a chassis correction cannot walk around the duplicate guard, and a decided booking is not edited', async () => {
  const dup = await post({ action: 'edit_details', booking_ref: 'MKY-BKG-1', field: 'vin', value: 'xlrte47ms0e000003' });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /MKY-BKG-3 already uses this chassis/);

  const decided = await post({ action: 'edit_details', booking_ref: 'MKY-BKG-3', field: 'make', value: 'Volvo' });
  assert.equal(decided.status, 409);
  assert.match(decided.body.error, /decided/);
});

test('typing what an unreadable file says takes it off the problems list', async () => {
  const before = await get({ view: 'inbox', filter: 'problems' });
  assert.ok(before.body.items.some((i) => i.id === 'document:103'));

  const r = await post({ action: 'mark_document_read_values', document_id: 103, values: { mrn: '26ltvr610172694233' } });
  assert.equal(r.status, 200);
  const doc = rows('booking_documents').find((d) => d.id === 103);
  assert.equal(doc.extracted.typed.mrn, '26LTVR610172694233');
  assert.equal(doc.extracted.typed_by, 'Sara');

  const after = await get({ view: 'inbox', filter: 'problems' });
  assert.ok(!after.body.items.some((i) => i.id === 'document:103'));
});

test('asking for a new document: the preview is the message, in the customer’s language', async () => {
  const preview = await get({ view: 'preview', kind: 'reject_document', document_id: 201, reason_code: 'unreadable' });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.language, 'ar');
  assert.match(preview.body.text, /MKY-BKG-2/);
  assert.match(preview.body.text, /نسخة جديدة من الفاتورة/, 'the Arabic customer is asked in Arabic');

  const v = (await get({ view: 'case', type: 'booking', ref: 'MKY-BKG-2' })).body.version;
  const r = await post({ action: 'reject_document', document_id: 201, reason_code: 'unreadable', version: v });
  assert.equal(r.status, 200);
  const queued = rows('notification_outbox').find((o) => o.idempotency_key === 'doc_replacement:201:unreadable');
  assert.ok(queued);
  assert.match(queued.payload.requested_ar, /مش مقروءة/);

  const twice = await post({ action: 'reject_document', document_id: 201, reason_code: 'unreadable' });
  assert.equal(twice.status, 200);
  assert.equal(rows('notification_outbox').filter((o) => o.idempotency_key === 'doc_replacement:201:unreadable').length, 1, 'asked once');
});

test('a WhatsApp customer outside the 24 hours: the preview says it goes as the template', async () => {
  channelsState.deployed = true;
  channelsState.api = fakeChannels({ open: false }).api;
  const r = await get({ view: 'preview', kind: 'request_info', booking_ref: 'MKY-BKG-2', requested: 'The brief' });
  assert.equal(r.body.delivery.via, 'template');
  assert.match(r.body.delivery.words, /mky_information_needed/);
});

// ---------------------------------------------------------------------------
// Talking to the customer
// ---------------------------------------------------------------------------

test('WhatsApp without the channel code: refused in words, nothing recorded as sent', async () => {
  const r = await post({ action: 'send_message', channel: 'whatsapp', chat_id: WA, text: 'Hello', action_key: 'k-wa-0000001' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /WhatsApp sending isn’t connected yet/);
  assert.equal(rows('notification_outbox').length, 0);
});

test('Telegram without the channel code falls back to the outbox, and a double click sends once', async () => {
  const body = { action: 'send_message', booking_ref: 'MKY-BKG-1', text: 'We are on it.', action_key: 'k-tg-0000001' };
  const first = await post(body);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'sent');
  const second = await post(body);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);

  const sends = telegramCalls.filter((c) => c.url.endsWith('/sendMessage'));
  assert.equal(sends.length, 1, 'one message, however many clicks');
  assert.equal(sends[0].body.text, 'We are on it.');
  assert.equal(rows('notification_outbox')[0].idempotency_key, 'desk:k-tg-0000001');
});

test('with the channel code: one send, as staff, in the customer’s language; a repeat is recognised', async () => {
  const fake = fakeChannels();
  channelsState.deployed = true;
  channelsState.api = fake.api;

  const body = { action: 'send_message', channel: 'whatsapp', chat_id: WA, text: 'تمام، بنراجع', action_key: 'k-wa-0000002' };
  const first = await post(body, 'Sara');
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'sent');
  const again = await post(body, 'Sara');
  assert.equal(again.body.duplicate, true);

  assert.equal(fake.calls.send.length, 1);
  const { target, opts } = fake.calls.send[0];
  assert.deepEqual(target, { channel: 'whatsapp', chatId: WA, clientId: 2 });
  assert.equal(opts.author, 'staff');
  assert.equal(opts.staffName, 'Sara');
  assert.equal(opts.language, 'ar');
});

test('the window closed while typing: refused with the reason, and the template offered', async () => {
  const fake = fakeChannels({ open: false });
  channelsState.deployed = true;
  channelsState.api = fake.api;

  const chat = await get({ view: 'chat', channel: 'whatsapp', chat_id: WA });
  assert.equal(chat.body.composer.mode, 'template_only');
  assert.match(chat.body.composer.reason, /24 hours/);

  const r = await post({ action: 'send_message', channel: 'whatsapp', chat_id: WA, text: 'Hi', action_key: 'k-wa-0000003' });
  assert.equal(r.status, 409);
  assert.equal(r.body.status, 'needs_template');
  assert.equal(fake.calls.send.length, 0);

  const t = await post({ action: 'send_reopen_template', channel: 'whatsapp', chat_id: WA, action_key: 'k-wa-0000004' });
  assert.equal(t.status, 200);
  assert.equal(fake.calls.reopen.length, 1);
  assert.equal(fake.calls.reopen[0].opts.language, 'ar');
});

test('WhatsApp refusing a message as outside the window is said in words, the draft is the operator’s to keep', async () => {
  const fake = fakeChannels({ result: { ok: false, status: 'needs_template', error: '131047: Re-engagement message', code: 131047 } });
  channelsState.deployed = true;
  channelsState.api = fake.api;
  const r = await post({ action: 'send_message', channel: 'whatsapp', chat_id: WA, text: 'Hello', action_key: 'k-wa-meta-001' });
  assert.equal(r.status, 409);
  assert.equal(r.body.status, 'needs_template');
  assert.match(r.body.error, /24 hours/);
  assert.ok(r.body.composer, 'the composer as it is now comes back with the refusal');
  const ledger = rows('notification_outbox').find((o) => o.idempotency_key === 'desk:k-wa-meta-001');
  assert.equal(ledger.status, 'failed', 'recorded as not sent');
});

test('a customer who wrote STOP: composer disabled, saying when', async () => {
  channelsState.deployed = true;
  channelsState.api = fakeChannels({ open: false }).api;
  const chat = await get({ view: 'chat', channel: 'whatsapp', chat_id: 'wa:201007770000' });
  assert.equal(chat.body.composer.mode, 'disabled');
  assert.match(chat.body.composer.reason, /wrote STOP on/);
  const r = await post({ action: 'send_message', channel: 'whatsapp', chat_id: 'wa:201007770000', text: 'Hi', action_key: 'k-wa-0000005' });
  assert.equal(r.status, 409);
});

test('the conversation comes back as data: failures in words, customer text untouched', async () => {
  const r = await get({ view: 'chat', channel: 'whatsapp', chat_id: WA });
  assert.equal(r.status, 200);
  assert.equal(r.body.available, true);
  assert.deepEqual(r.body.messages.map((m) => m.author), ['client', 'bot', 'staff']);
  const failed = r.body.messages[2];
  assert.equal(failed.retryable, true);
  assert.match(failed.error_words, /hasn’t written in 24 hours/);
  // Exactly as typed - the server neither escapes nor builds markup; the
  // browser sets it as text. Both halves of that are tested.
  assert.equal(r.body.customer.profile_name, '<script>alert(1)</script>');
  assert.equal(r.body.messages[0].body, 'السلام عليكم، فين الشحنة؟');
  assert.ok(r.body.bookings.some((b) => b.booking_ref === 'MKY-BKG-2'));
});

test('a file the customer sent comes back with its own name, the caption kept as the body', async () => {
  rows('chat_messages').push(
    { id: 40, channel: 'whatsapp', chat_id: WA, client_id: 2, direction: 'in', author: 'client', kind: 'document', body: null, payload: { file_name: 'فاتورة-7710.pdf', media_id: 'm1' }, status: 'received', created_at: iso(60_000) },
    { id: 41, channel: 'whatsapp', chat_id: WA, client_id: 2, direction: 'in', author: 'client', kind: 'image', body: 'the chassis plate', payload: { file_name: null }, status: 'received', created_at: iso(30_000) },
  );
  const r = await get({ view: 'chat', channel: 'whatsapp', chat_id: WA });
  const file = r.body.messages.find((m) => m.id === 40);
  assert.equal(file.kind, 'document');
  assert.equal(file.file_name, 'فاتورة-7710.pdf', 'the name exactly as sent, for the desk to show as a file');
  assert.ok(!file.body, 'no caption, so no words');
  const photo = r.body.messages.find((m) => m.id === 41);
  assert.equal(photo.file_name, null);
  assert.equal(photo.body, 'the chassis plate');
  assert.equal(r.body.messages.find((m) => m.id === 1).file_name, null, 'a text message has no file name');
});

test('before the migration the conversation says when history starts, and sending still works', async () => {
  setup({}, { missingTables: ['chat_messages'] });
  const r = await get({ view: 'chat', channel: 'telegram', chat_id: '555' });
  assert.equal(r.status, 200);
  assert.equal(r.body.available, false);
  assert.equal(r.body.notice, 'Conversation history starts once the database update is applied.');
  assert.equal(r.body.composer.mode, 'text');

  const sent = await post({ action: 'send_message', channel: 'telegram', chat_id: '555', text: 'Hello', action_key: 'k-tg-0000009' });
  assert.equal(sent.status, 200);
});

test('before the migration the new client columns are simply absent, and nothing errors', async () => {
  setup({}, { missingColumns: { clients: ['whatsapp_id', 'language', 'opted_out_at', 'whatsapp_name'] } });
  const r = await get({ view: 'case', type: 'booking', ref: 'MKY-BKG-1' });
  assert.equal(r.status, 200);
  const s = await get({ view: 'search', q: 'Nile' });
  assert.equal(s.status, 200, 'search falls back to the columns that exist');
});

test('a failed message: retried once, then off the problems list', async () => {
  const fake = fakeChannels();
  channelsState.deployed = true;
  channelsState.api = fake.api;
  const r = await post({ action: 'retry_message', message_id: 3, action_key: 'k-retry-0001' });
  assert.equal(r.status, 200);
  assert.equal(fake.calls.send[0].message.text, 'We are checking.');
  const inbox = await get({ view: 'inbox', filter: 'problems' });
  assert.ok(!inbox.body.items.some((i) => i.id === 'message:3'));
});

test('a problem can be set aside, and stays aside', async () => {
  const r = await post({ action: 'dismiss_problem', problem_id: 'message:3' });
  assert.equal(r.status, 200);
  const inbox = await get({ view: 'inbox', filter: 'problems' });
  assert.ok(!inbox.body.items.some((i) => i.id === 'message:3'));
});

// The live test, 2026-10-08: every failed message was its own red Problem
// row - 77 of them, most for test numbers WhatsApp does not know - and the
// one real item was buried under them.

/** Failed bot replies to one chat, as markDelivery leaves them, newest last. */
function failures(chatId, n, { error = '131026: Message undeliverable - Message Undeliverable.', from = 100, clientId = null } = {}) {
  const made = [];
  for (let i = 0; i < n; i++) {
    const row = {
      id: from + i, channel: 'whatsapp', chat_id: chatId, client_id: clientId, direction: 'out', author: 'bot', kind: 'buttons',
      body: `reply ${i}`, status: 'failed', error, provider_message_id: `wamid.f${from + i}`, created_at: iso((n - i) * 60_000),
    };
    rows('chat_messages').push(row);
    made.push(row);
  }
  return made;
}

test('failed messages are one problem per chat - and a number not on WhatsApp is one item, said plainly', async () => {
  const lost = failures('wa:999000000005', 6);
  // The outbox's own record of two of them - the same messages, not more.
  for (const m of lost.slice(-2)) {
    rows('notification_outbox').push({
      id: 500 + m.id, channel: 'whatsapp', chat_id: 'wa:999000000005', event_type: 'booking_confirmed', entity_type: 'booking',
      entity_id: 'MKY-BKG-X', payload: {}, status: 'dead', delivery_status: 'failed', provider_message_id: m.provider_message_id,
      last_error: m.error, idempotency_key: `k-${m.id}`, created_at: m.created_at, updated_at: m.created_at,
    });
  }
  const r = await get({ view: 'inbox', filter: 'problems' });
  const mine = r.body.items.filter((i) => i.link?.chat_id === 'wa:999000000005');
  assert.equal(mine.length, 1, `one item for the customer, not ${mine.length}`);
  const [item] = mine;
  assert.equal(item.id, 'chat:whatsapp:wa:999000000005');
  assert.match(item.sentence, /isn’t on WhatsApp/);
  assert.match(item.detail, /\+999000000005/);
  assert.match(item.detail, /6 messages/);
  assert.equal(item.problem.type, 'chat');
  assert.equal(item.problem.count, 6, 'the outbox rows are the same messages, not more');
  assert.equal(item.problem.last_attempt, lost.at(-1).created_at);
  assert.equal(item.problem.reason, 'not_on_whatsapp');
  assert.equal(item.problem.retryable, false, 'sending again cannot reach a number WhatsApp does not know');

  // Delta Trans's one failure is still its own row, retryable as before.
  assert.ok(r.body.items.some((i) => i.id === 'message:3'));
});

test('several failures for one chat: one item, with how many, the last error and the last attempt', async () => {
  const more = failures(WA, 2, { error: '(#131047) Re-engagement message', from: 200, clientId: 2 });
  const r = await get({ view: 'inbox', filter: 'problems' });
  const forWa = r.body.items.filter((i) => i.link?.chat_id === WA && i.kind === 'problem');
  assert.equal(forWa.length, 1);
  const [item] = forWa;
  assert.equal(item.sentence, '3 messages didn’t reach Delta Trans');
  assert.equal(item.problem.count, 3);
  assert.equal(item.problem.last_attempt, more.at(-1).created_at);
  assert.match(item.problem.last_error, /hasn’t written in 24 hours/);
  assert.match(item.detail, /hasn’t written in 24 hours/);

  // Set aside, it stays aside - until something new fails.
  const aside = await post({ action: 'dismiss_problem', problem_id: item.id });
  assert.equal(aside.status, 200);
  let after = await get({ view: 'inbox', filter: 'problems' });
  assert.ok(!after.body.items.some((i) => i.link?.chat_id === WA && i.kind === 'problem'));
  rows('chat_messages').push({
    id: 299, channel: 'whatsapp', chat_id: WA, client_id: 2, direction: 'out', author: 'bot', kind: 'text', body: 'later',
    status: 'failed', error: 'boom', created_at: new Date(Date.now() + 1000).toISOString(),
  });
  after = await get({ view: 'inbox', filter: 'problems' });
  const back = after.body.items.filter((i) => i.link?.chat_id === WA && i.kind === 'problem');
  assert.equal(back.length, 1);
  assert.equal(back[0].id, 'message:299', 'just the new one');
});

test('the chats list: both channels, newest first, failures counted', async () => {
  const r = await get({ view: 'chats' });
  assert.equal(r.status, 200);
  const wa = r.body.chats.find((c) => c.chat_id === WA);
  assert.equal(wa.channel, 'whatsapp');
  assert.equal(wa.failed, 1);
  assert.equal(wa.name, 'Delta Trans');
  assert.ok(r.body.chats.some((c) => c.channel === 'telegram'), 'a chat with no messages logged yet still appears');
  const found = await get({ view: 'chats', q: '1005551234' });
  assert.deepEqual(found.body.chats.map((c) => c.chat_id), [WA], 'found by phone digits');
});

test('a tapped button shows what was tapped, never the engine’s payload', async () => {
  rows('chat_messages').push(
    { id: 50, channel: 'whatsapp', chat_id: WA, client_id: 2, direction: 'in', author: 'client', kind: 'button_reply', body: 'lang:ar', payload: { title: 'العربية' }, status: 'received', created_at: iso(60_000) },
    { id: 51, channel: 'whatsapp', chat_id: WA, client_id: 2, direction: 'in', author: 'client', kind: 'text', body: 'bk:phone:use', payload: {}, status: 'received', created_at: iso(50_000) },
    { id: 52, channel: 'whatsapp', chat_id: WA, client_id: 2, direction: 'in', author: 'client', kind: 'text', body: 'VIN: YV2RT40A8FB712905', payload: {}, status: 'received', created_at: iso(40_000) },
  );
  const r = await get({ view: 'chat', channel: 'whatsapp', chat_id: WA });
  const byId = Object.fromEntries(r.body.messages.map((m) => [m.id, m]));
  assert.equal(byId[50].body, 'Tapped “العربية”');
  assert.equal(byId[50].kind, 'tap');
  assert.equal(byId[51].body, 'Tapped a button');
  assert.equal(byId[52].body, 'VIN: YV2RT40A8FB712905', 'what a customer typed is never taken for a button');
});

test('where the customer is with the bot, and a language not chosen yet, in words', async () => {
  rows('conversation_sessions').find((s) => s.id === 'telegram:555').current_state = 'CHOOSE_LANGUAGE';
  const r = await get({ view: 'chat', channel: 'telegram', chat_id: '555' });
  assert.equal(r.body.customer.bot_state_words, 'Choosing a language');
  assert.equal(r.body.customer.language, null);
  assert.equal(r.body.customer.language_words, 'Not chosen yet');
});

test('a notification held because the customer wrote STOP is a problem', async () => {
  rows('notification_outbox').push({
    id: 77, channel: 'whatsapp', chat_id: 'wa:201007770000', client_id: 3, event_type: 'shipment_update', entity_type: 'shipment',
    entity_id: 'MKY-26001', payload: { reference: 'MKY-26001' }, status: 'pending', delivery_status: 'opted_out',
    idempotency_key: 'held-1', created_at: iso(3600_000), updated_at: iso(3600_000),
  });
  const r = await get({ view: 'inbox', filter: 'problems' });
  const held = r.body.items.find((i) => i.id === 'outbox:77');
  assert.ok(held);
  assert.match(held.sentence, /wrote STOP/);
});

test('answering a customer who wrote STOP and then wrote again is allowed, and says so to the channel', async () => {
  const fake = fakeChannels();
  channelsState.deployed = true;
  channelsState.api = fake.api;
  rows('clients').find((c) => c.id === 3).opted_out_at = iso(5 * 3600_000);
  rows('conversation_sessions').find((s) => s.client_id === 3).last_client_message_at = iso(600_000);
  const r = await post({ action: 'send_message', channel: 'whatsapp', chat_id: 'wa:201007770000', text: 'Hello again', action_key: 'k-wa-answer01' });
  assert.equal(r.status, 200);
  assert.equal(fake.calls.send[0].opts.answering, true);
});

test('a WhatsApp window that cannot be read lets the operator write, and says WhatsApp decides', async () => {
  const fake = fakeChannels();
  fake.api.windowState = async () => ({ applies: true, open: true, known: false, lastClientMessageAt: null, closesAt: null });
  channelsState.deployed = true;
  channelsState.api = fake.api;
  const r = await get({ view: 'chat', channel: 'whatsapp', chat_id: WA });
  assert.equal(r.body.composer.mode, 'text');
  assert.match(r.body.composer.note, /WhatsApp will refuse/);
});

// ---------------------------------------------------------------------------
// Shipments, requests, settings
// ---------------------------------------------------------------------------

test('a shipment update tells the customer in their language, once', async () => {
  const fake = fakeChannels();
  channelsState.deployed = true;
  channelsState.api = fake.api;
  const v = (await get({ view: 'shipment', id: 'MKY-26001' })).body.version;
  const r = await post({ action: 'shipment_update', shipment_id: 'MKY-26001', version: v, status: 'Arrived at destination port', tell_customer: true, action_key: 'k-ship-0001' });
  assert.equal(r.status, 200);
  assert.equal(rows('shipments')[0].status, 'Arrived at destination port');
  assert.equal(fake.calls.send.length, 1);
  assert.match(fake.calls.send[0].message.text, /تحديث على شحنتك MKY-26001/);
  assert.match(fake.calls.send[0].message.text, /وصلت ميناء الوصول/);
  assert.doesNotMatch(fake.calls.send[0].message.text, /Update on your shipment/, 'one language, not both');

  const stale = await post({ action: 'shipment_update', shipment_id: 'MKY-26001', version: v, status: 'Delivered' });
  assert.equal(stale.status, 409);
});

test('the request-resolved preview is word for word what notify.js sends', async () => {
  const ticket = rows('support_tickets')[0];
  const note = 'Called them, booking moved to Friday.';
  const preview = await get({ view: 'preview', kind: 'request_resolve', ticket_ref: 'MKY-T-1', note });
  telegramCalls.length = 0;
  await notifyTicketResolved({ ...ticket, resolution_note: note });
  const sent = telegramCalls.find((c) => c.url.endsWith('/sendMessage'));
  assert.equal(preview.body.text, sent.body.text);
  assert.equal(ticketResolvedText(ticket, note, null), sent.body.text);
  // The way back to a person is the button every channel shows, and it comes
  // with the message - not "reply 3", which only Telegram's old menu knew.
  assert.doesNotMatch(sent.body.text, /reply 3|ابعت 3/);
  assert.match(JSON.stringify(sent.body.reply_markup ?? {}), /menu:contact/);
});

// ---------------------------------------------------------------------------
// What the redesigned desk reads from the server instead of guessing
// ---------------------------------------------------------------------------

const TONES = ['blue', 'amber', 'green', 'red', 'gray'];
const MEANINGS = { blue: 'info', amber: 'warning', green: 'success', red: 'danger', gray: 'neutral' };

/** Two MRN applications that are rows of their own: one for a decided booking, one for a WhatsApp chat with none. */
function mrnApplications() {
  rows('mrn_requests').push(
    { id: 31, request_ref: 'MKY-MRN-31', booking_ref: 'MKY-BKG-3', chat_id: '555', client_id: 1, status: 'approved', created_at: iso(3600_000), submitted_at: iso(3600_000) },
    { id: 32, request_ref: 'MKY-MRN-32', booking_ref: null, chat_id: WA, client_id: 2, status: 'submitted', created_at: iso(1800_000), submitted_at: iso(1800_000) },
  );
}

test('every inbox row says its status as a label and a tone, not just a sentence to read it from', async () => {
  mrnApplications();
  failures('wa:999000000005', 2);
  for (const tab of ['needs_us', 'waiting', 'done']) {
    const r = await get({ view: 'inbox', tab });
    for (const item of r.body.items) {
      assert.ok(item.status?.label, `${item.id} has a status label`);
      assert.ok(TONES.includes(item.status.tone), `${item.id}: ${item.status.tone}`);
      assert.equal(item.status.meaning, MEANINGS[item.status.tone], `${item.id} says what its tone means`);
    }
  }
  const r = await get({ view: 'inbox', tab: 'needs_us' });
  const byId = Object.fromEntries(r.body.items.map((i) => [i.id, i]));
  assert.deepEqual(byId['request:MKY-T-1'].status, { label: 'New', tone: 'blue', meaning: 'info' });
  assert.deepEqual(byId['mrn:MKY-MRN-31'].status, { label: 'Approved — record the number', tone: 'blue', meaning: 'info' });
  assert.deepEqual(byId['mrn:MKY-MRN-32'].status, { label: 'New application', tone: 'blue', meaning: 'info' });
  assert.equal(byId['chat:whatsapp:wa:999000000005'].status.label, 'Not on WhatsApp');
  assert.equal(byId['message:3'].status.label, 'Not delivered');
  assert.equal(byId['document:103'].status.label, 'Unreadable');
  assert.equal(byId['booking:MKY-BKG-1'].status.label, 'New request', 'a booking says what its status_words say');
  assert.equal(byId['booking:MKY-BKG-1'].status_words, 'New request', 'and status_words is still there');
});

test('an MRN row names the customer and their channel, not the booking reference', async () => {
  mrnApplications();
  const r = await get({ view: 'inbox', filter: 'mrn' });
  const byRef = Object.fromEntries(r.body.items.filter((i) => i.kind === 'mrn').map((i) => [i.ref, i]));
  assert.equal(byRef['MKY-MRN-31'].who, 'Nile Motors');
  assert.equal(byRef['MKY-MRN-31'].channel, 'telegram');
  assert.equal(byRef['MKY-MRN-31'].booking_ref, 'MKY-BKG-3');
  assert.match(byRef['MKY-MRN-31'].detail, /MKY-BKG-3/);
  assert.equal(byRef['MKY-MRN-32'].channel, 'whatsapp');
  assert.notEqual(byRef['MKY-MRN-32'].who, 'MRN application');

  // And the case page says the application's own channel.
  const c = await get({ view: 'case', type: 'mrn', ref: 'MKY-MRN-32' });
  assert.equal(c.body.mrn.channel, 'whatsapp');
  assert.equal(c.body.conversation.channel, 'whatsapp');
});

test('inbox rows carry their record\'s version, so taking one needs no second read', async () => {
  const r = await get({ view: 'inbox', tab: 'needs_us' });
  const booking = r.body.items.find((i) => i.id === 'booking:MKY-BKG-1');
  const callback = r.body.items.find((i) => i.id === 'request:MKY-T-1');
  const bookingCase = await get({ view: 'case', type: 'booking', ref: 'MKY-BKG-1' });
  const requestCase = await get({ view: 'case', type: 'request', ref: 'MKY-T-1' });
  assert.equal(booking.version, bookingCase.body.version);
  assert.equal(callback.version, requestCase.body.version);

  assert.equal((await post({ action: 'take', booking_ref: 'MKY-BKG-1', version: booking.version })).status, 200);
  assert.equal((await post({ action: 'take', ticket_ref: 'MKY-T-1', version: callback.version })).status, 200);
});

test('call-backs and MRN applications found by search have a tone, like bookings', async () => {
  mrnApplications();
  const r = await get({ view: 'search', q: 'MKY' });
  const requests = r.body.groups.find((g) => g.key === 'requests');
  assert.ok(requests.items.length);
  for (const i of requests.items) assert.ok(TONES.includes(i.tone), JSON.stringify(i));
  const mrn = r.body.groups.find((g) => g.key === 'mrn');
  for (const i of mrn.items) assert.ok(TONES.includes(i.tone), JSON.stringify(i));
});

test('the shipments list counts each filter, whichever one is shown', async () => {
  rows('shipments').push({ shipment_id: 'MKY-26002', customer_name: 'Nile Motors', status: 'Delivered', delivery_status: 'Complete', updated_at: iso(3600_000) });
  for (const filter of ['active', 'delivered', 'all']) {
    const r = await get({ view: 'shipments', filter });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.counts, { active: 1, delivered: 1, all: 2 }, filter);
  }
});

// The live test, 2026-10-08: a photo of an invoice sent with no booking open
// was stored under unfiled/ and appeared nowhere on the desk.
test('a paper on no booking, and one that arrived after its booking was decided, are each a row on the desk', async () => {
  rows('booking_documents').push(
    { id: 301, booking_ref: null, chat_id: WA, client_id: 2, channel: 'whatsapp', doc_type: 'invoice', status: 'received', file_name: 'photo-1.jpg', uploaded_at: iso(600_000) },
    { id: 302, booking_ref: 'MKY-BKG-3', chat_id: '555', client_id: 1, channel: 'telegram', doc_type: 'acid', status: 'received', file_name: 'acid.jpg', uploaded_at: iso(30_000) },
    // Sent while a booking is being filled in: it is that booking's, not the desk's yet.
    { id: 303, booking_ref: null, chat_id: 'wa:201009990000', channel: 'whatsapp', doc_type: 'invoice', status: 'received', uploaded_at: iso(60_000) },
  );
  rows('bookings').push({ booking_ref: 'MKY-BKG-D', status: 'draft', chat_id: 'wa:201009990000', channel: 'whatsapp' });

  const r = await get({ view: 'inbox', tab: 'needs_us' });
  const loose = r.body.items.find((i) => i.id === 'document:301');
  assert.ok(loose, 'the paper with no booking is on the desk');
  assert.match(loose.sentence, /sent an Invoice with no booking/);
  assert.equal(loose.link.type, 'chat');
  assert.equal(loose.link.chat_id, WA);
  assert.equal(loose.link.document_id, 301);
  assert.equal(loose.status.label, 'No booking');

  const late = r.body.items.find((i) => i.id === 'document:302');
  assert.ok(late, 'the paper that came after the booking was confirmed is on the desk');
  assert.match(late.sentence, /ACID .*after .*MKY-BKG-3 was confirmed/);
  assert.deepEqual(late.link, { type: 'booking', ref: 'MKY-BKG-3', document_id: 302 });

  assert.ok(!r.body.items.some((i) => i.id === 'document:303'), 'a booking being filled in will take it');

  // Set aside, it stays aside.
  await post({ action: 'dismiss_problem', problem_id: 'document:301' });
  const after = await get({ view: 'inbox', tab: 'needs_us' });
  assert.ok(!after.body.items.some((i) => i.id === 'document:301'));
});

// The live test, 2026-10-08: the customer sent an invoice for the wrong
// chassis, then the right one, which the desk verified. "Ask for a new one" on
// the wrong one still asked the customer for "A new Invoice" and put the
// booking back on them - and the answer carried no told/not-told words, so
// the desk showed no toast.

test('asking for a new copy of a paper already put right sets the wrong one aside, without asking again', async () => {
  rows('booking_documents').push({
    id: 104, booking_ref: 'MKY-BKG-1', chat_id: '555', doc_type: 'invoice', status: 'received', vin: 'YV2RT40A8FB799999',
    storage_path: '1/MKY-BKG-1/inv-wrong.pdf', mime_type: 'application/pdf', extraction_ok: true, extracted: { ok: true, vin: 'YV2RT40A8FB799999' },
    uploaded_at: iso(6 * 3600_000),
  });
  // The right invoice (101) is in, for this chassis, and checked.
  rows('booking_documents').find((d) => d.id === 101).status = 'verified';
  const outboxBefore = rows('notification_outbox').length;

  const r = await post({ action: 'reject_document', document_id: 104, reason_code: 'wrong_vin', reason: 'chassis on this invoice is different' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'rejected');
  assert.equal(r.body.set_aside, true);
  assert.equal(r.body.replaced_by.id, 101);
  assert.match(r.body.customer_told.words, /already sent a correct Invoice/);
  assert.match(r.body.customer_told.words, /not asked/);
  assert.equal(r.body.customer_told.warn, false);
  assert.equal(rows('notification_outbox').length, outboxBefore, 'nothing sent to the customer');
  assert.equal(rows('bookings').find((b) => b.booking_ref === 'MKY-BKG-1').status, 'pending_review', 'the booking is not put back on them');
  assert.equal(rows('booking_documents').find((d) => d.id === 104).status, 'rejected');
});

test('asking for a new copy of a paper not yet put right asks the customer, and says whether they were told', async () => {
  const r = await post({ action: 'reject_document', document_id: 102, reason_code: 'wrong_vin', reason: 'chassis on this CMR is different' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'replacement_requested');
  assert.ok(r.body.customer_told.words, 'words for the toast, like every other action that messages the customer');
  assert.equal(typeof r.body.customer_told.warn, 'boolean');
  assert.ok(['sent', 'queued', 'held', 'failed', 'none', 'email'].includes(r.body.customer_told.reached));
  assert.equal(rows('bookings').find((b) => b.booking_ref === 'MKY-BKG-1').status, 'needs_client_action');
  assert.ok(rows('notification_outbox').some((o) => o.event_type === 'document_rejected' && o.entity_id === 'MKY-BKG-1'));
});

/** A request's call-back tasks as the bot writes them - and as it wrote them before 2026-10-08. */
function callbackTasks() {
  const t = rows('support_tickets')[0];
  rows('operations_tasks').push(
    // The request's own task.
    { id: 901, task_ref: 'MKY-TSK-OWN', task_type: 'client_callback', chat_id: '555', channel: 'telegram', status: 'open',
      priority: 'normal', idempotency_key: 'ticket:MKY-T-1', payload: { ticket_ref: 'MKY-T-1' }, created_at: t.created_at },
    // The tap's, from before the fix: no ticket named, made a minute earlier.
    { id: 902, task_ref: 'MKY-TSK-TAP', task_type: 'client_callback', chat_id: '555', channel: 'telegram', status: 'open',
      priority: 'high', idempotency_key: 'client_callback:555:2026-10-08T15', payload: { after_hours: false }, created_at: iso(41 * 60_000) },
    // Somebody else's, and this customer's request from three days ago: not this request's.
    { id: 903, task_ref: 'MKY-TSK-OTHER', task_type: 'client_callback', chat_id: '777', channel: 'telegram', status: 'open',
      payload: {}, created_at: iso(41 * 60_000) },
    { id: 904, task_ref: 'MKY-TSK-OLD', task_type: 'client_callback', chat_id: '555', channel: 'telegram', status: 'open',
      payload: {}, created_at: iso(3 * 86400_000) },
  );
  return (ref) => rows('operations_tasks').find((x) => x.task_ref === ref).status;
}

test('resolving a request closes its call-back tasks - including the tap\'s second one from before the fix', async () => {
  const status = callbackTasks();
  const r = await post({ action: 'request_resolve', ticket_ref: 'MKY-T-1', note: 'Called them back and sorted the paperwork.' });
  assert.equal(r.status, 200);
  assert.equal(status('MKY-TSK-OWN'), 'done');
  assert.equal(status('MKY-TSK-TAP'), 'done', 'resolving it left both open');
  assert.equal(status('MKY-TSK-OTHER'), 'open', 'another chat\'s');
  assert.equal(status('MKY-TSK-OLD'), 'open', 'an older request of theirs');
  const closed = rows('operations_tasks').find((x) => x.task_ref === 'MKY-TSK-OWN');
  assert.equal(closed.completed_by, 'Sara');
});

test('closing a request without a message closes its tasks too', async () => {
  const status = callbackTasks();
  const r = await post({ action: 'request_status', ticket_ref: 'MKY-T-1', status: 'closed' });
  assert.equal(r.status, 200);
  assert.equal(status('MKY-TSK-OWN'), 'done');
  assert.equal(status('MKY-TSK-TAP'), 'done');
});

test('settings: every value checked, refused with a sentence, saved with its history', async () => {
  const bad = await post({ action: 'settings_write', changes: { support_hours_start: '9am', direct_phone: 'call me' } }, 'Ariful');
  assert.equal(bad.status, 400);
  assert.match(bad.body.errors.support_hours_start, /whole hour/);
  assert.match(bad.body.errors.direct_phone, /phone number/);

  const tpl = await post({ action: 'settings_write', changes: { whatsapp_templates: { _reopen: { name: 'Please Reply!' } } } }, 'Ariful');
  assert.equal(tpl.status, 400);
  assert.match(tpl.body.errors.whatsapp_templates, /lowercase letters, digits and underscores/);

  const view = await get({ view: 'settings' }, 'Ariful');
  const ok = await post({
    action: 'settings_write', changes: { support_hours_start: 8, direct_phone: '+20 100 555 1234' },
    versions: { support_hours_start: view.body.versions.support_hours_start },
  }, 'Ariful');
  assert.equal(ok.status, 200);
  assert.equal(rows('bot_settings').find((r) => r.key === 'support_hours_start').value, 8);
  assert.ok(rows('audit_logs').some((a) => a.action === 'setting_changed' && a.metadata.setting === 'direct_phone'));

  const stale = await post({
    action: 'settings_write', changes: { support_hours_start: 10 },
    versions: { support_hours_start: view.body.versions.support_hours_start },
  }, 'Ariful');
  assert.equal(stale.status, 409, 'somebody saved it since this form loaded');
});

test('recording an MRN does not make every paper that prints another MRN "not match the booking"', async () => {
  const b = rows('bookings').find((x) => x.booking_ref === 'MKY-BKG-1');
  const docs = rows('booking_documents');
  const brief = docs.find((d) => d.id === 102);
  brief.vin = b.vin;
  brief.extracted = { ok: true, vin: b.vin, mrn: '26LTVR610172694233' };

  // MKY obtained the MRN and the desk typed it in; the transport document
  // prints a different one (a transit MRN, say). The booking's number is not
  // the paper's to match.
  b.mrn_choice = 'mky_issue';
  b.mrn_number = '26LT000000000000X1';
  docs.splice(docs.findIndex((d) => d.id === 103), 1);
  let c = await get({ view: 'case', type: 'booking', ref: 'MKY-BKG-1' });
  let paper = c.body.documents.find((d) => d.id === 102);
  assert.deepEqual(paper.checks.filter((k) => !k.match), [], 'no false "does not match the booking"');

  // The customer's own MRN declaration is what other papers are held to -
  // and the declaration is what the number on the booking is held to.
  b.mrn_choice = 'existing';
  docs.push({ id: 104, booking_ref: 'MKY-BKG-1', chat_id: '555', doc_type: 'mrn', status: 'received', vin: b.vin, storage_path: '1/MKY-BKG-1/mrn.pdf', extraction_ok: true, extracted: { ok: true, vin: b.vin, mrn: '26LTVR610172694233' }, uploaded_at: iso(3600_000) });
  c = await get({ view: 'case', type: 'booking', ref: 'MKY-BKG-1' });
  paper = c.body.documents.find((d) => d.id === 102);
  const onBrief = paper.checks.find((k) => k.field === 'mrn');
  assert.equal(onBrief.match, true, 'the brief agrees with the MRN declaration');
  assert.match(onBrief.against, /MRN declaration/);
  const onDeclaration = c.body.documents.find((d) => d.id === 104).checks.find((k) => k.field === 'mrn');
  assert.equal(onDeclaration.match, false, 'the number typed on the booking differs from the declaration - that one is real');
  assert.equal(onDeclaration.against, undefined, 'held to the booking, as every check always was');
});

test('the customer\'s answer is on the case, beside what was asked, and the case is ours again', async () => {
  const { recordAnswer } = await import('../lib/answers.js');
  rows('bookings').find((b) => b.booking_ref === 'MKY-BKG-2').needs_client_action = { requested: 'The brief, please', at: iso(3600_000), by: 'Sara' };
  await recordAnswer([{ kind: 'booking', ref: 'MKY-BKG-2' }], {
    chatId: WA, clientId: 2, text: 'Sending it this afternoon', documents: [{ id: 201, file_name: 'invoice.pdf', doc_type: 'invoice' }],
  });

  const c = await get({ view: 'case', type: 'booking', ref: 'MKY-BKG-2' });
  assert.equal(c.body.header.status, 'under_review');
  assert.equal(c.body.asked.requested, 'The brief, please');
  assert.equal(c.body.asked.by, 'Sara');
  const [answer] = c.body.asked.answers;
  assert.equal(answer.text, 'Sending it this afternoon');
  assert.deepEqual(answer.documents.map((d) => [d.id, d.label]), [[201, 'Invoice']]);
  assert.ok(c.body.history.some((h) => h.who === 'The customer' && /answered what we asked/.test(h.what)));

  // An MRN application shows its answer where it always showed what the customer said.
  rows('mrn_requests').push({ id: 9, request_ref: 'MKY-MRN-9', booking_ref: null, chat_id: WA, client_id: 2, status: 'missing_information', missing_information: ['Exporter address'], supplied_information: {} });
  await recordAnswer([{ kind: 'mrn', ref: 'MKY-MRN-9' }], { chatId: WA, clientId: 2, text: 'Baltic Trucks UAB, Vilnius' });
  const m = await get({ view: 'case', type: 'mrn', ref: 'MKY-MRN-9' });
  assert.equal(m.body.header.status, 'under_review', 'needs us again');
  assert.equal(m.body.mrn.supplied.at(-1).text, 'Baltic Trucks UAB, Vilnius');
});

test('the desk number is set in Settings and is the one the bot gives; the old example number is refused', async () => {
  const { operationsContact, companyPhone } = await import('../lib/settings.js');
  assert.equal((await operationsContact()).phone, null, 'nothing set, nothing invented');
  assert.equal(await companyPhone(), null);

  const example = await post({ action: 'settings_write', changes: { operations_phone: '+20 3 555 0143' } }, 'Ariful');
  assert.equal(example.status, 400);
  assert.match(example.body.errors.operations_phone, /example/);

  const ok = await post({ action: 'settings_write', changes: { operations_phone: '+20 3 111 2222' } }, 'Ariful');
  assert.equal(ok.status, 200);
  const contact = await operationsContact();
  assert.equal(contact.phone, '+20 3 111 2222');
  assert.equal(contact.configured, true);
  assert.equal(await companyPhone(), '+20 3 111 2222', 'the PDF footer follows the desk');

  const view = await get({ view: 'settings' }, 'Ariful');
  assert.equal(view.body.values.operations_phone, '+20 3 111 2222', 'and the page shows what is set');
});

// The live test, 2026-10-08: an urgent after-hours customer was told to ring
// "our responsible person directly on +48 512 345 678" - the placeholder the
// setup seeded as direct_phone, and the number the tests and docs use.
test('Settings says when the direct line still looks like the example number from the setup', async () => {
  rows('bot_settings').push({ key: 'direct_phone', value: '+48 512 345 678' });
  invalidateSettings();
  const view = await get({ view: 'settings' }, 'Ariful');
  assert.equal(view.status, 200);
  assert.equal(view.body.values.direct_phone, '+48 512 345 678', 'the value is shown as it is - nothing is changed');
  assert.match(view.body.warnings.direct_phone, /looks like the example number/);

  const saved = await post({ action: 'settings_write', changes: { direct_phone: '+48 512-345-678' } }, 'Ariful');
  assert.equal(saved.status, 200, 'saving it is not refused');
  assert.match(saved.body.warnings.direct_phone, /looks like the example number/);

  const real = await post({ action: 'settings_write', changes: { direct_phone: '+20 100 222 3333' } }, 'Ariful');
  assert.equal(real.status, 200);
  assert.equal(real.body.warnings?.direct_phone ?? null, null);
  const after = await get({ view: 'settings' }, 'Ariful');
  assert.equal(after.body.warnings?.direct_phone ?? null, null);
});

// ---------------------------------------------------------------------------
// The redesigned desk, reading what the server says
// ---------------------------------------------------------------------------

// The live test, 2026-10-08: "Talk to an agent" put the request on the desk
// at the tap, before the customer had said anything - the summary is the
// bot's placeholder until they do.
test('a call-back opened before the customer said what about is flagged, on its row and on its case', async () => {
  const { AWAITING_DETAILS } = await import('../lib/flow/contact.js');
  const ticket = {
    ticket_ref: 'MKY-T-2', status: 'open', channel: 'whatsapp', chat_id: WA, client_id: 2, department: 'Booking Operations',
    customer: 'Delta Trans', contact: '+201005551234', summary: AWAITING_DETAILS, request_type: 'other', priority: 'normal',
    created_at: iso(5 * 60_000), status_changed_at: iso(5 * 60_000),
  };
  // The request queue is a view of the tickets: seeded together.
  setup({ support_tickets: [...rows('support_tickets').map((t) => ({ ...t })), ticket] });
  const r = await get({ view: 'inbox', filter: 'callbacks' });
  const byRef = Object.fromEntries(r.body.items.map((i) => [i.ref, i]));
  assert.equal(byRef['MKY-T-2'].undescribed, true);
  assert.equal(byRef['MKY-T-1'].undescribed, false, 'a request that says what it is about is not flagged');

  const c = await get({ view: 'case', type: 'request', ref: 'MKY-T-2' });
  assert.equal(c.body.request.undescribed, true);
  assert.equal((await get({ view: 'case', type: 'request', ref: 'MKY-T-1' })).body.request.undescribed, false);
});

// The live test, 2026-10-08: the photo of an invoice sent with no booking
// open was on the desk as a row, but the row opened a chat with no way to
// look at the paper.
test('a paper on no booking opens on its own from its chat: held to nothing, asked about in the conversation', async () => {
  rows('booking_documents').push(
    { id: 301, booking_ref: null, chat_id: WA, client_id: 2, channel: 'whatsapp', doc_type: 'invoice', status: 'received', file_name: 'photo-1.jpg', storage_path: 'unfiled/photo-1.jpg', mime_type: 'image/jpeg', extraction_ok: true, extracted: { ok: true, vin: 'WDB9634031L000001', make: 'MERCEDES-BENZ' }, uploaded_at: iso(600_000) },
    { id: 304, booking_ref: null, chat_id: WA, client_id: 2, channel: 'whatsapp', doc_type: 'acid', status: 'received', file_name: 'acid.jpg', uploaded_at: iso(500_000) },
  );
  const r = await get({ view: 'document', id: 301 });
  assert.equal(r.status, 200);
  assert.equal(r.body.booking_ref, null);
  assert.equal(r.body.version, null, 'no case, so no case version to send');
  assert.deepEqual(r.body.documents.map((d) => d.id), [301]);
  assert.deepEqual(r.body.other_documents.map((d) => d.id), [301], 'the viewer pages through the one paper');
  assert.deepEqual(r.body.documents[0].checks, [], 'nothing to hold it to');
  assert.ok(r.body.documents[0].read.some((f) => f.field === 'vin'), 'what the bot read is still shown');
  assert.deepEqual(r.body.conversation, { channel: 'whatsapp', chat_id: WA });
  assert.equal(r.body.document_actions.verify.enabled, true);
  assert.equal(r.body.document_actions.reject.enabled, false);
  assert.match(r.body.document_actions.reject.reason, /no booking.*conversation/);

  // A read-only person sees it, and is told why they cannot act.
  const ro = await get({ view: 'document', id: 304 }, 'Rita');
  assert.equal(ro.status, 200);
  assert.equal(ro.body.document_actions.verify.enabled, false);
  assert.ok(ro.body.document_actions.verify.reason);

  // "Looks right" from there takes the row off the inbox.
  assert.ok((await get({ view: 'inbox' })).body.items.some((i) => i.id === 'document:301'));
  const v = await post({ action: 'verify_document', document_id: 301, version: r.body.version });
  assert.equal(v.status, 200);
  assert.ok(!(await get({ view: 'inbox' })).body.items.some((i) => i.id === 'document:301'));
  const after = await get({ view: 'document', id: 301 });
  assert.equal(after.body.documents[0].status, 'verified');
  assert.equal(after.body.document_actions.verify.enabled, false, 'dealt with');

  assert.equal((await get({ view: 'document', id: 9999 })).status, 404);
  assert.equal((await get({ view: 'document' })).status, 400);
});

test('a paper on a booking, opened on its own, is held to that booking', async () => {
  const r = await get({ view: 'document', id: 102 });
  assert.equal(r.status, 200);
  assert.equal(r.body.booking_ref, 'MKY-BKG-1');
  const c = await get({ view: 'case', type: 'booking', ref: 'MKY-BKG-1' });
  assert.equal(r.body.version, c.body.version, 'the same version the case page sends');
  assert.ok(r.body.documents[0].wrong_vehicle, 'its chassis differs from the booking');
  assert.equal(r.body.document_actions.reject.enabled, true);
});

test('the team: people are added and changed, and the last administrator cannot be removed', async () => {
  const add = await post({ action: 'user_save', name: 'Mona', role: 'ops_agent' }, 'Ariful');
  assert.equal(add.status, 200);
  assert.equal(rows('ops_users').find((u) => u.name === 'Mona').role, 'ops_agent');

  const lockout = await post({ action: 'user_save', name: 'Ariful', role: 'ops_agent' }, 'Ariful');
  assert.equal(lockout.status, 409);
  assert.match(lockout.body.error, /at least one active administrator/);

  const agent = await post({ action: 'user_save', name: 'Mona', role: 'admin' }, 'Sara');
  assert.equal(agent.status, 403);
});

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

test('the composer rule, case by case', () => {
  const base = { channel: 'whatsapp', chatId: WA, customer: { name: 'Delta' }, connected: true, templateAvailable: true };
  assert.equal(composerState({ ...base, channel: 'telegram', chatId: '5', window: { open: true } }).mode, 'text');
  assert.match(composerState({ ...base, connected: false, window: { open: true } }).reason, /isn’t connected yet/);
  assert.equal(composerState({ ...base, window: { open: false } }).mode, 'template_only');
  assert.equal(composerState({ ...base, window: { open: true } }).mode, 'text');
  assert.equal(composerState({ ...base, chatId: null, window: { open: true } }).mode, 'disabled');

  // Wrote STOP, then wrote again inside the window: answering them is allowed.
  const stopped = { name: 'Delta', opted_out_at: iso(5 * 3600_000), last_client_message_at: iso(3600_000) };
  assert.equal(composerState({ ...base, customer: stopped, window: { open: true } }).mode, 'text');
  const silent = { name: 'Delta', opted_out_at: iso(3600_000), last_client_message_at: iso(5 * 3600_000) };
  assert.equal(composerState({ ...base, customer: silent, window: { open: true } }).mode, 'disabled');
});

test('why a message failed, in words', () => {
  assert.match(failureWords('(#131047) Re-engagement message'), /24 hours/);
  assert.match(failureWords('(#131026) Message undeliverable'), /not on WhatsApp/);
  assert.match(failureWords('(#190) Error validating access token'), /expired/);
  assert.match(failureWords('Forbidden: bot was blocked by the user'), /blocked the bot/);
  assert.match(failureWords('something odd'), /It did not go through: something odd/);
});

test('the viewer draws a PDF itself, at the screen\'s pixel density, with the browser\'s own viewer only as a fallback', () => {
  const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const desk = path.join(web, 'public', 'desk');
  const viewer = readFileSync(path.join(desk, 'viewer.js'), 'utf8');
  // Edge's and Chrome's PDF viewer, inside an iframe, laid the page out at the
  // wrong scale above 100% display scaling - shifted, cut off, or blank.
  assert.match(viewer, /devicePixelRatio/);
  assert.match(viewer, /vendor\/pdfjs\/pdf\.min\.js/);
  assert.match(viewer, /viewer-pdf/, 'the iframe is still there for a browser pdf.js cannot run in');

  // Byte for byte the pdfjs-dist the server reads papers with, so the two
  // cannot drift. After `npm update` moves it, copy build/pdf.min.mjs and
  // build/pdf.worker.min.mjs over these again.
  for (const [mine, theirs] of [['pdf.min.js', 'pdf.min.mjs'], ['pdf.worker.min.js', 'pdf.worker.min.mjs']]) {
    const vendored = readFileSync(path.join(desk, 'vendor', 'pdfjs', mine));
    const installed = readFileSync(path.join(web, 'node_modules', 'pdfjs-dist', 'build', theirs));
    assert.ok(vendored.equals(installed), `public/desk/vendor/pdfjs/${mine} is not node_modules/pdfjs-dist/build/${theirs}`);
  }
});

test('"Matches" in the viewer\'s narrow column is never broken mid-word', () => {
  const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'desk', 'desk.css'), 'utf8');
  const rule = css.match(/\n\.match\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(rule, /white-space:\s*nowrap/, 'the cell allows breaks anywhere; the verdict must not take them');
});

test('no file of the desk ever builds HTML from data', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'desk');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|document\.write/, `${file} must set text, never HTML`);
  }
});
