/**
 * The accounts migration, on a real Postgres.
 *
 * Every migration is applied to PGlite (Postgres compiled to WebAssembly, in
 * this process - no server, no network), people are put on the desk the way
 * the old desk put them there, and the accounts migration is run again over
 * them. Migrations here are written to be safe to re-run, and this is the one
 * whose second run has work to do: the backfill that gives everybody who was
 * already on the desk the obvious username.
 *
 * What it must not do is fail. Two names that want the same username would
 * break the unique index, and a migration that stops halfway through leaves a
 * desk nobody can sign in to.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const ACCOUNTS = '20261012120000_desk_accounts.sql';
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

const rerun = () => db.exec(readFileSync(path.join(MIGRATIONS, ACCOUNTS), 'utf8'));
const team = async () => (await db.query('select name, username, password_hash, password_set_at from ops_users order by id')).rows;

test('the columns are there, and a password is not one of the things the table makes up', { skip }, async () => {
  await db.exec(`insert into ops_users (name, role, active) values ('Ariful Islam', 'admin', true)`);
  const [row] = await team();
  assert.equal(row.password_hash, null, 'nobody is given a password by the migration');
  assert.equal(row.password_set_at, null);
});

test('everybody already on the desk gets the obvious username, and nobody gets somebody else’s', { skip }, async () => {
  await db.exec(`
    insert into ops_users (name, role, active) values
      ('Sara', 'ops_agent', true),
      ('Mona  Fahmy', 'ops_agent', true),
      ('agent1', 'ops_agent', true),
      ('X', 'read_only', false),
      ('!!!', 'read_only', false),
      ('Ali Hassan', 'ops_agent', true),
      ('ali-hassan', 'ops_agent', false)`);
  await rerun();

  const by = Object.fromEntries((await team()).map((u) => [u.name, u.username]));
  assert.equal(by['Ariful Islam'], 'ariful.islam');
  assert.equal(by.Sara, 'sara');
  assert.equal(by['Mona  Fahmy'], 'mona.fahmy', 'two spaces are one dot, not two');
  assert.equal(by.agent1, 'agent1');
  assert.equal(by.X, null, 'one letter is too short to be a username');
  assert.equal(by['!!!'], null, 'a name with nothing to make a username out of is left alone');

  // Both want "ali.hassan". One gets it; the other waits for an administrator,
  // and above all the migration finished.
  const alis = [by['Ali Hassan'], by['ali-hassan']];
  assert.deepEqual(alis.filter((u) => u === 'ali.hassan').length, 1, `one of ${JSON.stringify(alis)} has it`);
  assert.equal(alis.filter((u) => u === null).length, 1);
});

test('a username is one person’s, however it is capitalised, and running it again changes nothing', { skip }, async () => {
  const before2 = await team();
  await rerun();
  assert.deepEqual(await team(), before2, 'a third run is a no-op');

  await assert.rejects(
    () => db.exec(`insert into ops_users (name, role, active, username) values ('Someone Else', 'ops_agent', true, 'SARA')`),
    /duplicate key|unique/i,
    'the index is on the lowercase, so SARA is sara',
  );
  // Two people with no username at all is not a clash: null is "not chosen yet".
  await db.exec(`insert into ops_users (name, role, active) values ('No One', 'read_only', false), ('No Two', 'read_only', false)`);
});
