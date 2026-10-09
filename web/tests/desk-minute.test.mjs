/**
 * A minute of the desk, end to end: the browser's polling loop
 * (public/desk/ui.js) talking to the real API (lib/admin/console.js) over a
 * fetch that calls it directly, against the fake database with the
 * desk_activity triggers - and every database call counted.
 *
 * This is the number the design is for: what one person with the desk open
 * costs the database per minute, when nothing happens and when something
 * does. docs/SYSTEM-DESIGN-DB-LOAD.md has the projection from it.
 */

import test, { mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';
process.env.ADMIN_SECRET = 'desk-secret';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';

mock.module(new URL('../lib/admin/channels-bridge.js', import.meta.url).href, {
  namedExports: { channels: async () => null },
});

// -- a page ---------------------------------------------------------------------
globalThis.document = { hidden: false, addEventListener() {}, querySelector: () => null };
globalThis.window = { addEventListener() {} };

const { createDeskDb, withViews } = await import('./helpers/desk-db.mjs');
const { withActivity } = await import('./helpers/activity-db.mjs');
const { countCalls } = await import('./helpers/count-db.mjs');
const { setClientForTests } = await import('../lib/supabase.js');
const { invalidateSettings } = await import('../lib/settings.js');
const { invalidateTeam } = await import('../lib/admin/desk-shared.js');
const { default: handler } = await import('../lib/admin/console.js');
const ui = await import('../public/desk/ui.js');

// -- the network: fetch calls the API handler in-process ------------------------
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url, 'http://desk');
  const query = Object.fromEntries(u.searchParams);
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const req = { method: init.method ?? 'GET', query, headers, body: init.body ? JSON.parse(init.body) : undefined };
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
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => sent[k.toLowerCase()] ?? null },
    json: async () => payload,
  };
};

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

function seed() {
  const bookings = [];
  const docs = [];
  let id = 1;
  for (let i = 0; i < 15; i++) {
    bookings.push({
      booking_ref: `MKY-BKG-${i}`, status: ['pending_review', 'under_review', 'needs_client_action'][i % 3], channel: 'whatsapp',
      chat_id: `wa:20100000${i}`, client_id: null, customer_name: `Cust ${i}`, customer_contact: '+201000000',
      vin: `YV2RT40A8FB7${String(i).padStart(5, '0')}`, make: 'Volvo', origin_port: 'Klaipeda', destination_port: 'Alexandria',
      mrn_choice: 'existing', priority: 'normal', created_at: iso(5 * 3600_000), status_changed_at: iso(5 * 3600_000), edit_history: [],
    });
    for (const t of ['invoice', 'brief']) docs.push({ id: id++, booking_ref: `MKY-BKG-${i}`, doc_type: t, status: 'received', extraction_ok: true, extracted: { ok: true }, uploaded_at: iso(3600_000) });
  }
  return withViews({
    ops_users: [{ name: 'Sara', role: 'ops_agent', active: true }],
    bot_settings: [{ key: 'required_booking_documents', value: ['invoice', 'brief', 'mrn'] }],
    bookings, booking_documents: docs, clients: [], conversation_sessions: [], support_tickets: [], chat_messages: [],
    mrn_requests: [], notification_outbox: [], audit_logs: [], shipments: [],
  });
}

let db;
let activity;
beforeEach(() => {
  db = createDeskDb(seed());
  activity = withActivity(db);
  setClientForTests(db);
  invalidateSettings();
  invalidateTeam();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  ui.session.name = 'Sara';
  ui.session.secret = 'desk-secret';
  ui.forgetAnswers();
});
afterEach(() => { ui.stopLive(); mock.timers.reset(); });

async function pass(ms) {
  for (let t = 0; t < ms; t += 250) {
    mock.timers.tick(250);
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }
}

/** The inbox screen as app.js runs it: loaded once, then subscribed to its scopes. */
async function openInbox() {
  ui.primeLive(await ui.api({ view: 'pulse' }));
  const screen = { loads: 0 };
  const load = async () => { screen.loads += 1; screen.data = await ui.api({ view: 'inbox', tab: 'needs_us', limit: 50 }); return true; };
  await load();
  ui.subscribe(ui.VIEW_SCOPES.inbox, load);
  ui.startLive();
  return screen;
}

test('a minute with the inbox open and nothing happening: about four small reads', async () => {
  await openInbox();
  const rec = countCalls(db);
  await pass(60_000);
  assert.ok(rec.count >= 3 && rec.count <= 5, `${rec.count} calls in a minute:\n${rec.lines().join('\n')}`);
  // The pulse, and the team list once its 30 seconds are up - per instance,
  // whoever is asking - and nothing else.
  assert.ok(rec.calls.every((c) => c.table === 'desk_activity' || c.table === 'ops_users'), `nothing but the pulse:\n${rec.lines().join('\n')}`);
  assert.ok(rec.calls.filter((c) => c.table === 'ops_users').length <= 2);
});

test('the same minute on the old rhythm, or on a database without the migration, costs far more', async () => {
  // No desk_activity: nothing to vouch for an answer, nothing shared. The old
  // app.js tick - the counts and the inbox every 20 seconds - against it.
  db = createDeskDb(seed());
  setClientForTests(db);
  invalidateTeam();
  await ui.api({ view: 'me' });
  const rec = countCalls(db);
  for (let tick = 0; tick < 3; tick++) {
    ui.forgetAnswers();
    await ui.api({ view: 'counts' });
    await ui.api({ view: 'inbox', tab: 'needs_us', limit: 50 });
  }
  assert.ok(rec.count >= 50, `${rec.count} calls in a minute`);
});

test('somebody takes a case: the inbox is fetched again within a tick, once', async () => {
  const screen = await openInbox();
  const loadsBefore = screen.loads;
  const rec = countCalls(db);
  // A colleague, on another desk.
  db._tables.bookings.find((b) => b.booking_ref === 'MKY-BKG-0').assigned_to = 'Omar';
  db._tables.booking_queue.find((b) => b.booking_ref === 'MKY-BKG-0').assigned_to = 'Omar';
  activity.bump('bookings');
  await pass(20_000);
  assert.equal(screen.loads, loadsBefore + 1);
  assert.equal(screen.data.items.find((i) => i.ref === 'MKY-BKG-0').assigned_to, 'Omar');
  assert.ok(rec.count <= 20, `${rec.count} calls:\n${rec.lines().join('\n')}`);
});

test('a chat message elsewhere does not refetch the inbox', async () => {
  const screen = await openInbox();
  const loadsBefore = screen.loads;
  activity.bump('messages');
  await pass(20_000);
  assert.equal(screen.loads, loadsBefore);
});
