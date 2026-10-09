/**
 * The desk_activity trigger, on a real Postgres.
 *
 * Every migration is applied to PGlite (Postgres compiled to WebAssembly, in
 * this process - no server, no network) and rows are written the way the bot
 * and the desk write them. Each write must move exactly the versions the
 * desk needs - the areas of the desk and the records it shows - and nothing
 * a desk cannot see; a rolled-back write moves nothing; a statement of
 * twenty thousand rows moves each key once.
 *
 * And the fake database's emulation of the trigger (helpers/activity-db.mjs),
 * which the other desk tests run on, must agree with the real one write for
 * write: each write's rows are read as they were before and after, and the
 * emulation's keys for them compared with the keys Postgres moved.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const pglite = await import('@electric-sql/pglite').catch(() => null);
const skip = pglite ? false : '@electric-sql/pglite is not installed (npm ci installs it)';

const { scopesFor } = await import('./helpers/activity-db.mjs');

let db;
before(async () => {
  if (!pglite) return;
  const { vector } = await import('@electric-sql/pglite/vector');
  const { pg_trgm: trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  db = new pglite.PGlite({ extensions: { vector, pg_trgm: trgm } });
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;`);
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  }
});
after(async () => { await db?.close(); });

const versions = async () => Object.fromEntries((await db.query('select scope, version from desk_activity')).rows.map((r) => [r.scope, Number(r.version)]));
const movedBetween = (a, b) => Object.keys(b).filter((k) => b[k] !== a[k]).sort();
const rowsOf = async (table, where) => (await db.query(`select to_jsonb(t) as r from ${table} t where ${where} order by 1`)).rows.map((x) => x.r);
const snapshot = async () => ({
  bookings: await rowsOf('bookings', 'true'),
  chat_messages: await rowsOf('chat_messages', 'true'),
  booking_documents: await rowsOf('booking_documents', 'true'),
  mrn_requests: await rowsOf('mrn_requests', 'true'),
});

/**
 * Runs one write and returns the keys Postgres moved, after checking the
 * emulation names the same ones. `rows` picks out the rows it writes.
 */
async function write({ sql, table, op, rows: where }) {
  const beforeRows = op === 'insert' ? [] : await rowsOf(table, where);
  const tablesBefore = await snapshot();
  const was = await versions();
  await db.exec(sql);
  const now = await versions();
  const afterRows = op === 'delete' ? [] : await rowsOf(table, where);
  const tablesAfter = await snapshot();

  const emulated = new Set();
  if (op === 'insert') for (const r of afterRows) for (const k of scopesFor(table, 'insert', null, r, tablesAfter)) emulated.add(k);
  else if (op === 'delete') for (const r of beforeRows) for (const k of scopesFor(table, 'delete', r, null, tablesBefore)) emulated.add(k);
  else beforeRows.forEach((r, i) => { for (const k of scopesFor(table, 'update', r, afterRows[i], tablesAfter)) emulated.add(k); });

  const moved = movedBetween(was, now);
  assert.deepEqual([...emulated].sort(), moved, `the emulation and Postgres disagree on: ${sql}`);
  return moved;
}

const WA = 'chat:whatsapp:wa:2010';

test('each write moves exactly what the desk shows of it - and the fake database says the same', { skip }, async () => {
  const cases = [
    ['a new customer', { table: 'clients', op: 'insert', rows: `whatsapp_id = '2010'`, sql: `insert into clients (whatsapp_id, whatsapp_name, phone) values ('2010', 'Ali', '+2010')` }, ['customers', WA]],
    ['the same WhatsApp name again', { table: 'clients', op: 'update', rows: `whatsapp_id = '2010'`, sql: `update clients set whatsapp_name = 'Ali', updated_at = now() + interval '1 s' where whatsapp_id = '2010'` }, []],
    ['a new WhatsApp name', { table: 'clients', op: 'update', rows: `whatsapp_id = '2010'`, sql: `update clients set whatsapp_name = 'Ali K' where whatsapp_id = '2010'` }, ['customers', WA]],
    ['the bot moves on', { table: 'conversation_sessions', op: 'insert', rows: `chat_id = 'wa:2010'`, sql: `insert into conversation_sessions (id, channel, chat_id, current_state, context) values ('whatsapp:wa:2010', 'whatsapp', 'wa:2010', 'MAIN_MENU', '{}')` }, [WA]],
    ['a draft started', { table: 'bookings', op: 'insert', rows: `booking_ref = 'B1'`, sql: `insert into bookings (booking_ref, status, chat_id, client_id) values ('B1', 'draft', 'wa:2010', (select id from clients where whatsapp_id = '2010'))` }, ['booking:B1', 'bookings', WA]],
    ['the draft typed into', { table: 'bookings', op: 'update', rows: `booking_ref = 'B1'`, sql: `update bookings set vin = 'YV2RT40A8FB712905', make = 'Volvo' where booking_ref = 'B1'` }, []],
    ['the draft sent', { table: 'bookings', op: 'update', rows: `booking_ref = 'B1'`, sql: `update bookings set status = 'pending_review', customer_name = 'Ali', origin_port = 'Klaipeda', destination_port = 'Alexandria' where booking_ref = 'B1'` }, ['booking:B1', 'bookings', WA]],
    ['a Telegram booking', { table: 'bookings', op: 'insert', rows: `booking_ref = 'B2'`, sql: `insert into bookings (booking_ref, status, chat_id, channel) values ('B2', 'draft', '555', 'telegram')` }, ['booking:B2', 'bookings', 'chat:telegram:555']],
    // A paper moves its conversation too: the chat draws it beside its message (20261009123000).
    ['a paper', { table: 'booking_documents', op: 'insert', rows: `booking_ref = 'B1'`, sql: `insert into booking_documents (booking_ref, chat_id, doc_type, status, extracted) values ('B1', 'wa:2010', 'invoice', 'received', '{"pending": true}')` }, ['booking:B1', 'bookings', WA]],
    ['...read by the bot', { table: 'booking_documents', op: 'update', rows: `doc_type = 'invoice'`, sql: `update booking_documents set extracted = '{"ok": true}', extraction_ok = true where doc_type = 'invoice'` }, ['booking:B1', 'bookings', WA]],
    ['a paper moved to another booking', { table: 'booking_documents', op: 'update', rows: `doc_type = 'invoice'`, sql: `update booking_documents set booking_ref = 'B2' where doc_type = 'invoice'` }, ['booking:B1', 'booking:B2', 'bookings', WA]],
    ['a photo on no booking yet', { table: 'booking_documents', op: 'insert', rows: `file_name = 'truck.jpg'`, sql: `insert into booking_documents (booking_ref, chat_id, channel, doc_type, status, file_name) values (null, '555', 'telegram', 'other', 'received', 'truck.jpg')` }, ['bookings', 'chat:telegram:555']],
    // Filed by the desk with no chat on purpose; the conversation that sent it is its booking's.
    ['an MKY document filed on a booking', { table: 'booking_documents', op: 'insert', rows: `doc_type = 'mky'`, sql: `insert into booking_documents (booking_ref, chat_id, channel, doc_type, status, file_name) values ('B1', null, 'whatsapp', 'mky', 'verified', 'quote.pdf')` }, ['booking:B1', 'bookings', WA]],
    ['...removed from the case', { table: 'booking_documents', op: 'update', rows: `doc_type = 'mky'`, sql: `update booking_documents set deleted_at = now() where doc_type = 'mky'` }, ['booking:B1', 'bookings', WA]],
    ['an MKY document on a booking with no chat', { table: 'booking_documents', op: 'insert', rows: `file_name = 'orphan.pdf'`, sql: `insert into booking_documents (booking_ref, chat_id, doc_type, status, file_name) values ('NOPE', null, 'mky', 'verified', 'orphan.pdf')` }, ['booking:NOPE', 'bookings']],
    ['a message in', { table: 'chat_messages', op: 'insert', rows: `body = 'hi'`, sql: `insert into chat_messages (channel, chat_id, direction, author, kind, body, status) values ('whatsapp', 'wa:2010', 'in', 'client', 'text', 'hi', 'received')` }, [WA, 'messages']],
    ['a message out that failed', { table: 'chat_messages', op: 'insert', rows: `provider_message_id = 'w1'`, sql: `insert into chat_messages (channel, chat_id, direction, author, kind, body, status, provider_message_id) values ('whatsapp', 'wa:2010', 'out', 'bot', 'text', 'x', 'failed', 'w1')` }, [WA, 'messages', 'problems']],
    ['it was delivered after all', { table: 'chat_messages', op: 'update', rows: `provider_message_id = 'w1'`, sql: `update chat_messages set status = 'delivered' where provider_message_id = 'w1'` }, [WA, 'messages', 'problems']],
    ['a notification queued', { table: 'notification_outbox', op: 'insert', rows: `idempotency_key = 'k1'`, sql: `insert into notification_outbox (chat_id, channel, event_type, entity_type, entity_id, idempotency_key, status) values ('wa:2010', 'whatsapp', 'booking_confirmed', 'booking', 'B1', 'k1', 'pending')` }, ['booking:B1', 'outbox']],
    ['...sent', { table: 'notification_outbox', op: 'update', rows: `idempotency_key = 'k1'`, sql: `update notification_outbox set status = 'sent' where idempotency_key = 'k1'` }, ['booking:B1', 'outbox']],
    ['...read (a receipt on a sent row)', { table: 'notification_outbox', op: 'update', rows: `idempotency_key = 'k1'`, sql: `update notification_outbox set updated_at = now() where idempotency_key = 'k1'` }, []],
    ['a failed message set aside', { table: 'audit_logs', op: 'insert', rows: `action = 'problem_dismissed' and entity_id like 'message:%'`, sql: `insert into audit_logs (actor_type, action, entity_type, entity_id) values ('operator', 'problem_dismissed', 'problem', 'message:' || (select id from chat_messages where provider_message_id = 'w1'))` }, [WA, 'history', 'problems']],
    ['a whole chat set aside', { table: 'audit_logs', op: 'insert', rows: `entity_id = 'chat:telegram:555'`, sql: `insert into audit_logs (actor_type, action, entity_type, entity_id) values ('operator', 'problem_dismissed', 'problem', 'chat:telegram:555')` }, ['chat:telegram:555', 'history', 'problems']],
    ['a paper checked', { table: 'audit_logs', op: 'insert', rows: `action = 'document_verified'`, sql: `insert into audit_logs (actor_type, action, entity_type, entity_id) values ('operator', 'document_verified', 'booking_document', (select id::text from booking_documents where doc_type = 'invoice'))` }, ['booking:B2', 'history']],
    ['an audit row with an id no column could hold', { table: 'audit_logs', op: 'insert', rows: `action = 'absurd'`, sql: `insert into audit_logs (actor_type, action, entity_type, entity_id) values ('operator', 'absurd', 'booking_document', '99999999999999999999999')` }, ['history']],
    ['an MRN application', { table: 'mrn_requests', op: 'insert', rows: `request_ref = 'M1'`, sql: `insert into mrn_requests (request_ref, booking_ref, chat_id, status) values ('M1', 'B1', 'wa:2010', 'submitted')` }, ['booking:B1', 'bookings', 'mrn:M1']],
    ['its history', { table: 'audit_logs', op: 'insert', rows: `action = 'mrn_review'`, sql: `insert into audit_logs (actor_type, action, entity_type, entity_id) values ('operator', 'mrn_review', 'mrn_request', 'M1')` }, ['booking:B1', 'history', 'mrn:M1']],
    ['a call-back', { table: 'support_tickets', op: 'insert', rows: `ticket_ref = 'T1'`, sql: `insert into support_tickets (ticket_ref, chat_id, channel, department, status, summary, customer, contact) values ('T1', 'wa:2010', 'whatsapp', 'Booking Operations', 'open', 'call me', 'Ali', '+2010')` }, [WA, 'request:T1', 'requests']],
    ['a note on it', { table: 'internal_notes', op: 'insert', rows: `entity_id = 'T1'`, sql: `insert into internal_notes (booking_ref, entity_type, entity_id, author, body) values (null, 'support_ticket', 'T1', 'Sara', 'called')` }, ['history', 'request:T1']],
    ['someone joins the team', { table: 'ops_users', op: 'insert', rows: `name = 'Sara'`, sql: `insert into ops_users (name, role, active) values ('Sara', 'ops_agent', true)` }, ['team']],
    ['...and signs in', { table: 'ops_users', op: 'update', rows: `name = 'Sara'`, sql: `update ops_users set last_seen = now() where name = 'Sara'` }, []],
    ['a shipment', { table: 'shipments', op: 'insert', rows: `shipment_id = 'S1'`, sql: `insert into shipments (shipment_id, booking_ref, chat_id, status, customer_name, origin_port, destination_port) values ('S1', 'B1', 'wa:2010', 'In transit', 'Ali', 'Klaipeda', 'Alexandria')` }, ['booking:B1', 'shipment:S1', 'shipments']],
    ['a message deleted', { table: 'chat_messages', op: 'delete', rows: `body = 'hi'`, sql: `delete from chat_messages where body = 'hi'` }, [WA, 'messages']],
  ];
  for (const [what, w, expected] of cases) {
    assert.deepEqual(await write(w), [...expected].sort(), what);
  }
});

test('a write rolled back moves nothing; twenty thousand rows in one statement move each key once', { skip }, async () => {
  const was = await versions();
  await db.exec(`begin; update bookings set priority = 'high' where booking_ref = 'B1'; rollback;`);
  assert.deepEqual(movedBetween(was, await versions()), []);

  const before2 = await versions();
  await db.exec(`insert into chat_messages (channel, chat_id, direction, author, kind, body, status)
    select 'whatsapp', 'wa:' || (g % 50), 'in', 'client', 'text', 'm' || g, 'received' from generate_series(1, 20000) g`);
  const now = await versions();
  assert.equal(now.messages - before2.messages, 1, 'the messages area once');
  assert.equal(now['chat:whatsapp:wa:7'] - (before2['chat:whatsapp:wa:7'] ?? 0), 1, 'and each chat once');
});

test('a desk asking about records reads them by key with the areas, in one query', { skip }, async () => {
  const { rows } = await db.query(`select scope, version from desk_activity
    where scope = any('{bookings,customers,history,messages,outbox,problems,requests,shipments,team,booking:B1,booking:nowhere}')`);
  const names = rows.map((r) => r.scope).sort();
  assert.ok(names.includes('booking:B1'));
  assert.ok(!names.includes('booking:nowhere'), 'a record never written has no row yet');
  assert.equal(names.filter((n) => !n.includes(':')).length, 9);
});
