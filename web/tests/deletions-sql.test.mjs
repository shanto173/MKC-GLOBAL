/**
 * Putting a deleted record back, on a real Postgres.
 *
 * restore_deleted_record is the one piece of this feature that has to be SQL:
 * every id in the database is `generated always as identity`, and a row only
 * goes back under the id it had - the documents and notes kept with it point at
 * that number. Only INSERT ... OVERRIDING SYSTEM VALUE may say so, and nothing
 * above the database can.
 *
 * So it is tested where it runs: every migration applied to PGlite (Postgres
 * compiled to WebAssembly, in this process), a customer and their paperwork
 * deleted exactly as lib/admin/desk-delete.js deletes them, and put back.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const pglite = await import('@electric-sql/pglite').catch(() => null);
const skip = pglite ? false : '@electric-sql/pglite is not installed (npm ci installs it)';

let db;
before(async () => {
  if (!pglite) return;
  const { vector } = await import('@electric-sql/pglite/vector');
  const { pg_trgm: trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  db = new pglite.PGlite({ extensions: { vector, pg_trgm: trgm } });
  await db.exec('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;');
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  }
});
after(async () => { await db?.close(); });

const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;

/**
 * A customer with paperwork, deleted the way the desk deletes them: the rows
 * read whole, kept in order (children first), then removed.
 */
async function deleteCustomer(clientId, { by = 'Ariful' } = {}) {
  const parts = [];
  for (const [table, where] of [
    ['booking_documents', 'client_id = $1'],
    ['bookings', 'client_id = $1'],
    ['chat_messages', 'client_id = $1'],
    ['clients', 'id = $1'],
  ]) {
    const got = await one(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as rows from ${table} t where ${where}`, [clientId]);
    if (got.rows.length) parts.push({ table, rows: got.rows });
  }
  const kept = await one(
    `insert into deleted_records (kind, reference, label, summary, payload, files, deleted_by, purge_after)
     values ('customer', $1, 'Delta Trans — everything', '{}'::jsonb, $2::jsonb, '[]'::jsonb, $3, now() + interval '30 days')
     returning id`,
    [String(clientId), JSON.stringify(parts), by],
  );
  for (const part of parts) {
    const where = part.table === 'clients' ? 'id = $1' : 'client_id = $1';
    await db.query(`delete from ${part.table} where ${where}`, [clientId]);
  }
  return kept.id;
}

test('a customer and their paperwork go back exactly as they were, ids and all', { skip }, async () => {
  await db.exec(`
    insert into clients (id, display_name, whatsapp_id, phone) overriding system value
      values (2, 'Delta Trans', '201005551234', '+201005551234'),
             (9, 'Someone Else', '201009999999', '+201009999999');
    insert into bookings (id, booking_ref, status, channel, chat_id, client_id, customer_name, vin, make, origin_port, destination_port) overriding system value
      values (11, 'MKY-BKG-1', 'pending_review', 'whatsapp', 'wa:201005551234', 2, 'Delta Trans', 'WDB9634031L000001', 'Mercedes-Benz', 'Antwerp', 'Port Said'),
             (19, 'MKY-BKG-9', 'pending_review', 'whatsapp', 'wa:201009999999', 9, 'Someone Else', 'YV2RT40A8FB712905', 'Volvo', 'Klaipeda', 'Alexandria Port');
    insert into booking_documents (id, booking_ref, client_id, chat_id, doc_type, status, storage_path) overriding system value
      values (101, 'MKY-BKG-1', 2, 'wa:201005551234', 'invoice', 'received', '2/MKY-BKG-1/inv.pdf'),
             (102, 'MKY-BKG-1', 2, 'wa:201005551234', 'brief', 'received', '2/MKY-BKG-1/cmr.pdf');
    insert into chat_messages (id, channel, chat_id, client_id, direction, author, kind, body, status) overriding system value
      values (501, 'whatsapp', 'wa:201005551234', 2, 'in', 'client', 'text', 'مرحبا', 'received');`);

  const before2 = await one('select to_jsonb(t) as r from bookings t where id = 11');
  const id = await deleteCustomer(2);

  // Gone from every table, and nobody else's rows with them.
  assert.equal((await all('select 1 from clients where id = 2')).length, 0);
  assert.equal((await all('select 1 from bookings where id = 11')).length, 0);
  assert.equal((await all('select 1 from booking_documents where client_id = 2')).length, 0);
  assert.equal((await all('select 1 from chat_messages where client_id = 2')).length, 0);
  assert.equal((await all('select 1 from clients where id = 9')).length, 1, 'the other customer is untouched');
  assert.equal((await all('select 1 from bookings where id = 19')).length, 1);

  const put = await one('select restore_deleted_record($1) as done', [id]);

  // Back, under the ids they had, with every column as it was.
  const after2 = await one('select to_jsonb(t) as r from bookings t where id = 11');
  assert.deepEqual(after2.r, before2.r, 'the booking is the row it was, not a copy with a new id');
  assert.equal((await all('select 1 from clients where id = 2')).length, 1);
  assert.deepEqual((await all('select id from booking_documents where client_id = 2 order by id')).map((r) => Number(r.id)), [101, 102]);
  assert.equal(Number((await one("select count(*) as n from chat_messages where client_id = 2")).n), 1);
  assert.deepEqual(put.done, { clients: 1, bookings: 1, booking_documents: 2, chat_messages: 1 });

  // And the ledger says it was put back.
  const row = await one('select restored_at from deleted_records where id = $1', [id]);
  assert.ok(row.restored_at, 'recorded, so it cannot be put back twice');
});

test('the same record cannot be put back twice, and an unknown one says so', { skip }, async () => {
  const id = Number((await one('select id from deleted_records order by id desc limit 1')).id);
  await assert.rejects(() => db.query('select restore_deleted_record($1)', [id]), /already put back/i);
  await assert.rejects(() => db.query('select restore_deleted_record($1)', [999999]), /no deleted record/i);
});

test('a row somebody re-created in the meantime does not fail the rest of the restore', { skip }, async () => {
  await db.exec(`
    insert into clients (id, display_name, whatsapp_id) overriding system value values (3, 'Nile Motors', '201007770000');
    insert into bookings (id, booking_ref, status, channel, chat_id, client_id, customer_name, vin, make, origin_port, destination_port) overriding system value
      values (31, 'MKY-BKG-31', 'pending_review', 'whatsapp', 'wa:201007770000', 3, 'Nile Motors', 'XLRTE47MS0E000003', 'DAF', 'Rotterdam', 'Damietta Port');`);
  const id = await deleteCustomer(3);

  // The customer is typed in again by hand before anybody notices the mistake.
  await db.exec(`insert into clients (id, display_name, whatsapp_id) overriding system value values (3, 'Nile Motors (again)', '201007770000');`);

  await db.query('select restore_deleted_record($1)', [id]);
  // The booking is back beside the row that was already there, rather than the
  // whole restore failing on one conflict.
  assert.equal((await all('select 1 from bookings where id = 31')).length, 1);
  assert.equal((await one('select display_name from clients where id = 3')).display_name, 'Nile Motors (again)',
    'the row that was there is left as it is');
});

test('one paper on its own goes back under its own id, beside the booking that kept it', { skip }, async () => {
  // The shape of every one-row kind (a paper, a note, a message, a queued
  // message, a shipment update): one table, one row, and a parent that never
  // went anywhere. It still has to come back under the id it had.
  await db.exec(`
    insert into clients (id, display_name, whatsapp_id) overriding system value values (5, 'One Paper', '201005555000');
    insert into bookings (id, booking_ref, status, channel, chat_id, client_id, customer_name, vin, make, origin_port, destination_port) overriding system value
      values (51, 'MKY-BKG-51', 'pending_review', 'whatsapp', 'wa:201005555000', 5, 'One Paper', 'WDB9634031L000051', 'MAN', 'Antwerp', 'Port Said');
    insert into booking_documents (id, booking_ref, client_id, chat_id, doc_type, status, storage_path) overriding system value
      values (151, 'MKY-BKG-51', 5, 'wa:201005555000', 'invoice', 'received', '5/MKY-BKG-51/inv.pdf');`);

  const was = await one('select to_jsonb(t) as r from booking_documents t where id = 151');
  const kept = await one(
    `insert into deleted_records (kind, reference, label, summary, payload, files, deleted_by, purge_after)
     values ('document', '151', 'Invoice for MKY-BKG-51', '{}'::jsonb,
             jsonb_build_array(jsonb_build_object('table', 'booking_documents', 'rows', jsonb_build_array($1::jsonb))),
             '[]'::jsonb, 'Ariful', now() + interval '30 days')
     returning id`,
    [JSON.stringify(was.r)],
  );
  await db.query('delete from booking_documents where id = 151');
  assert.equal((await all('select 1 from booking_documents where id = 151')).length, 0);
  assert.equal((await all('select 1 from bookings where id = 51')).length, 1, 'a paper is not the booking’s to take');

  const put = await one('select restore_deleted_record($1) as done', [kept.id]);
  assert.deepEqual(put.done, { booking_documents: 1 });
  assert.deepEqual((await one('select to_jsonb(t) as r from booking_documents t where id = 151')).r, was.r,
    'the row it was, not a copy with a new id');
});

test('restoring walks the payload backwards, so a parent is back before its children', { skip }, async () => {
  // clients has to exist before bookings.client_id points at it; the payload is
  // kept children-first, so a forwards restore would fail on the foreign key.
  await db.exec(`
    insert into clients (id, display_name, whatsapp_id) overriding system value values (4, 'Order Test', '201004444444');
    insert into bookings (id, booking_ref, status, channel, chat_id, client_id, customer_name, vin, make, origin_port, destination_port) overriding system value
      values (41, 'MKY-BKG-41', 'pending_review', 'whatsapp', 'wa:201004444444', 4, 'Order Test', 'WDB9634031L000041', 'Scania', 'Antwerp', 'Port Said');`);
  const id = await deleteCustomer(4);
  const kept = await one('select payload from deleted_records where id = $1', [id]);
  assert.deepEqual(kept.payload.map((p) => p.table), ['bookings', 'clients'], 'kept children first');

  await db.query('select restore_deleted_record($1)', [id]);
  assert.equal((await all('select 1 from bookings where id = 41')).length, 1);
});
