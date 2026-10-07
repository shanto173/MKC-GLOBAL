/**
 * Who may change the operations team, and what a change writes.
 *
 * The endpoint wrote "operator" and "supervisor" long after the database's role
 * check stopped accepting them, so every save failed; and anybody holding the
 * desk password could add an administrator through it, which the desk itself
 * refuses. No network, no database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_SECRET = 'desk-secret';
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';

const { createFakeDb } = await import('./helpers/fake-db.mjs');
const { setClientForTests } = await import('../lib/supabase.js');
const { default: users } = await import('../api/admin/users.js');

function post(body) {
  const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  return users({ method: 'POST', query: {}, headers: { 'x-admin-secret': 'desk-secret' }, body }, res).then(() => res);
}

function team(rows) {
  const db = createFakeDb({ ops_users: rows });
  setClientForTests(db);
  return db;
}

const role = (db, name) => db._tables.ops_users.find((u) => u.name === name)?.role;

test('an administrator adds a person; the old role words are stored as the new ones', async () => {
  const db = team([{ name: 'Ariful', role: 'admin', active: true }]);
  const a = await post({ operator: 'ariful', name: 'Sara', role: 'supervisor' });
  const b = await post({ operator: 'Ariful', name: 'Omar' });
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(role(db, 'Sara'), 'ops_supervisor');
  assert.equal(role(db, 'Omar'), 'ops_agent');
});

test('nobody but an active administrator may change the team', async () => {
  const db = team([
    { name: 'Ariful', role: 'admin', active: true },
    { name: 'Sara', role: 'ops_supervisor', active: true },
    { name: 'Old Boss', role: 'admin', active: false },
  ]);
  for (const operator of [undefined, 'Sara', 'Old Boss', 'Stranger']) {
    const res = await post({ operator, name: 'Mallory', role: 'admin' });
    assert.equal(res.statusCode, 403, `${operator} must be refused`);
  }
  assert.equal(role(db, 'Mallory'), undefined);
});

test('switching somebody off and on again keeps their role', async () => {
  const db = team([{ name: 'Ariful', role: 'admin', active: true }, { name: 'Sara', role: 'ops_supervisor', active: true }]);
  await post({ operator: 'Ariful', name: 'Sara', active: false });
  await post({ operator: 'Ariful', name: 'sara' });
  assert.equal(role(db, 'Sara'), 'ops_supervisor');
  assert.equal(db._tables.ops_users.find((u) => u.name === 'Sara').active, true);
});

test('an empty desk lets its first person in; an unknown role is refused', async () => {
  const db = team([]);
  const first = await post({ name: 'Ariful', role: 'admin' });
  assert.equal(first.statusCode, 200);
  assert.equal(role(db, 'Ariful'), 'admin');

  const bad = await post({ operator: 'Ariful', name: 'Sara', role: 'owner' });
  assert.equal(bad.statusCode, 400);
});
