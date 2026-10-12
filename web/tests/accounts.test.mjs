/**
 * Per-person sign-ins: a username, a password and a signed token.
 *
 * What these pin down is the promise the desk now makes about identity:
 *
 *   - a password is checked against a stored digest, never kept in the clear,
 *     and a wrong one is refused without saying which half was wrong;
 *   - the name on a decision comes from the token, so holding a token does not
 *     let anybody act as a colleague by typing their name into the request;
 *   - changing a password, or switching a person off, ends their sessions;
 *   - an administrator makes accounts, and nobody else does - but anybody may
 *     change their own password;
 *   - the shared ADMIN_SECRET still opens the door, because the deployment
 *     holds it and an administrator who forgets their password must not be
 *     able to lock the desk for good.
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
const { default: handler } = await import('../lib/admin/console.js');
const { flush } = await import('../lib/background.js');
const { invalidateTeam } = await import('../lib/admin/desk-shared.js');
const { hashPassword, verifyPassword, normaliseUsername, forgetFailures, readToken } = await import('../lib/admin/desk-auth.js');

const SECRET = 'desk-secret';
const SARA_PASSWORD = 'correct horse battery';

let db;
let saraHash;

async function setup({ users } = {}) {
  saraHash ??= await hashPassword(SARA_PASSWORD);
  db = createDeskDb(withViews({
    ops_users: users ?? [
      { name: 'Sara', username: 'sara', role: 'ops_agent', active: true, password_hash: saraHash, password_set_at: '2026-10-01T00:00:00.000Z' },
      { name: 'Ariful Islam', username: 'ariful.islam', role: 'admin', active: true, password_hash: null, password_set_at: null },
      { name: 'Former', username: 'former', role: 'ops_agent', active: false, password_hash: saraHash, password_set_at: '2026-10-01T00:00:00.000Z' },
    ],
    bot_settings: [],
  }));
  setClientForTests(db);
  invalidateSettings();
  invalidateTeam();
  forgetFailures();
  return db;
}

beforeEach(() => setup());

/** One call to the desk's API, with a token, a secret, or neither. */
async function call({ method = 'GET', query = {}, body, token = null, secret = null, operator = null } = {}) {
  const req = {
    method,
    query: { resource: 'console', ...(method === 'GET' && operator ? { operator } : {}), ...query },
    headers: { ...(secret ? { 'x-admin-secret': secret } : {}), ...(token ? { 'x-desk-token': token } : {}) },
    body: method === 'POST' ? { ...(operator ? { operator } : {}), ...body } : undefined,
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

const signIn = (username, password) => call({ method: 'POST', body: { action: 'sign_in', username, password } });
const rows = (name) => (db._tables[name] ??= []);

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

test('a password is stored as a digest and nothing else', async () => {
  const hash = await hashPassword('a good long password');
  assert.ok(hash.startsWith('scrypt$'), 'the algorithm and its cost are written into the value');
  assert.ok(!hash.includes('a good long password'));
  assert.equal(await verifyPassword('a good long password', hash), true);
  assert.equal(await verifyPassword('a good long passwore', hash), false);
  assert.equal(await verifyPassword('', hash), false);
  // Two people choosing the same password do not get the same row.
  assert.notEqual(hash, await hashPassword('a good long password'));
  // Nothing that is not a digest is ever accepted as one.
  for (const junk of [null, '', 'plain', 'scrypt$16384$only$three', 'md5$16384$c2E$aGk']) {
    assert.equal(await verifyPassword('plain', junk), false, String(junk));
  }
});

test('a username is the obvious thing typed, however it was written', () => {
  assert.equal(normaliseUsername('Ariful Islam'), 'ariful.islam');
  assert.equal(normaliseUsername('  SARA  '), 'sara');
  assert.equal(normaliseUsername('a..b__c'), 'a.b__c');
  assert.equal(normaliseUsername('!!!'), '');
});

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

test('the right password gives a token that names the person it was issued to', async () => {
  const r = await signIn('sara', SARA_PASSWORD);
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Sara');
  assert.equal(r.body.role, 'ops_agent');
  assert.ok(r.body.token);
  assert.equal(readToken(r.body.token).name, 'Sara');

  const me = await call({ query: { view: 'me' }, token: r.body.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.name, 'Sara');
  assert.equal(me.body.role_words, 'Agent');
});

test('the name works as well as the username, for people who had one before the other', async () => {
  for (const typed of ['Sara', 'sara', 'SARA']) {
    assert.equal((await signIn(typed, SARA_PASSWORD)).status, 200, typed);
  }
});

test('a wrong password is refused, and never says which half was wrong', async () => {
  const wrong = await signIn('sara', 'not it at all');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.token, undefined);
  const nobody = await signIn('mallory', 'not it at all');
  assert.equal(nobody.status, 401);
  assert.equal(nobody.body.error, wrong.body.error, 'an unknown username reads exactly like a wrong password');
});

test('somebody switched off cannot sign in, even with the right password', async () => {
  const r = await signIn('former', SARA_PASSWORD);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /switched off/);
  assert.equal(r.body.token, undefined);
});

test('wrong passwords over and over are slowed down', async () => {
  for (let i = 0; i < 8; i += 1) assert.equal((await signIn('sara', `guess-${i}`)).status, 401);
  const locked = await signIn('sara', SARA_PASSWORD);
  assert.equal(locked.status, 429);
  assert.match(locked.body.error, /Too many attempts/);
});

test('a person with no password of their own gets in on the shared desk secret, and is told to set one', async () => {
  const r = await signIn('ariful.islam', SECRET);
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Ariful Islam');
  assert.equal(r.body.needs_password, true);
  // And it is written down as what it was.
  assert.ok(rows('audit_logs').some((a) => a.action === 'desk_sign_in_with_secret'));
});

test('an empty desk lets its first person in, and offers them the administrator’s chair', async () => {
  await setup({ users: [] });
  assert.equal((await signIn('Ariful', 'something else')).status, 401);

  const r = await signIn('Ariful', SECRET);
  assert.equal(r.status, 200);
  assert.equal(r.body.bootstrap, true);

  const me = await call({ query: { view: 'me' }, token: r.body.token });
  assert.equal(me.body.bootstrap, true);

  const made = await call({ method: 'POST', token: r.body.token, body: { action: 'bootstrap_admin' } });
  assert.equal(made.status, 200);
  assert.equal(rows('ops_users')[0].name, 'Ariful');
  assert.equal(rows('ops_users')[0].role, 'admin');
});

// ---------------------------------------------------------------------------
// What a token is, and is not
// ---------------------------------------------------------------------------

test('a token cannot be used to act as somebody else', async () => {
  const { body: { token } } = await signIn('sara', SARA_PASSWORD);
  // The name in the request says the administrator; the token says Sara, and
  // the token is what counts - so an agent's permissions are what apply.
  const r = await call({ method: 'POST', token, body: { action: 'user_save', operator: 'Ariful Islam', name: 'Mona', role: 'admin' } });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /administrator can manage the team/);

  const me = await call({ query: { view: 'me' }, token, operator: 'Ariful Islam' });
  assert.equal(me.body.name, 'Sara');
});

test('a token that was tampered with, expired or never signed is refused', async () => {
  const { body: { token } } = await signIn('sara', SARA_PASSWORD);
  const [payload, signature] = token.split('.');
  for (const bad of ['', 'nonsense', payload, `${payload}.${signature}x`, `${payload}x.${signature}`]) {
    const r = await call({ query: { view: 'me' }, token: bad || 'x' });
    assert.equal(r.status, 401, `token "${bad}"`);
  }
  // A payload swapped for somebody else's keeps the old signature, so it fails.
  const forged = Buffer.from(JSON.stringify({ n: 'Ariful Islam', r: 'admin', pv: 0, exp: 4000000000 }), 'utf8').toString('base64url');
  assert.equal((await call({ query: { view: 'me' }, token: `${forged}.${signature}` })).status, 401);
});

test('changing a password ends the sessions that were signed in with the old one', async () => {
  const { body: { token } } = await signIn('sara', SARA_PASSWORD);
  assert.equal((await call({ query: { view: 'me' }, token }).then((r) => r.status)), 200);

  const changed = await call({ method: 'POST', token, body: { action: 'set_password', password: 'a brand new one' } });
  assert.equal(changed.status, 200);
  assert.ok(changed.body.token, 'the tab that changed it is handed a token for the new password');
  invalidateTeam();

  const old = await call({ query: { view: 'me' }, token });
  assert.equal(old.status, 401);
  assert.equal(old.body.reauth, true);
  assert.match(old.body.error, /password was changed/);

  assert.equal((await call({ query: { view: 'me' }, token: changed.body.token })).status, 200);
  assert.equal((await signIn('sara', 'a brand new one')).status, 200);
  assert.equal((await signIn('sara', SARA_PASSWORD)).status, 401);
});

test('switching somebody off ends their session too', async () => {
  const { body: { token } } = await signIn('sara', SARA_PASSWORD);
  await call({ method: 'POST', secret: SECRET, operator: 'Ariful Islam', body: { action: 'user_save', name: 'Sara', role: 'ops_agent', active: false } });
  const r = await call({ query: { view: 'me' }, token });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /no longer active/);
});

// ---------------------------------------------------------------------------
// Who may make an account
// ---------------------------------------------------------------------------

test('an administrator adds a person with a username and a password, and that person can sign in', async () => {
  const admin = await signIn('ariful.islam', SECRET);
  const made = await call({
    method: 'POST', token: admin.body.token,
    body: { action: 'user_save', name: 'Mona Fahmy', username: 'mona', password: 'another good password', role: 'ops_supervisor' },
  });
  assert.equal(made.status, 200);
  assert.equal(made.body.user.username, 'mona');
  assert.equal(made.body.user.has_password, true);
  assert.equal(made.body.user.role, 'ops_supervisor');
  // Never the digest, to anybody.
  assert.equal(made.body.user.password_hash, undefined);

  invalidateTeam();
  const mona = await signIn('mona', 'another good password');
  assert.equal(mona.status, 200);
  assert.equal(mona.body.name, 'Mona Fahmy');
  assert.equal(mona.body.needs_password, false, 'they have a password of their own');
  const me = await call({ query: { view: 'me' }, token: mona.body.token });
  assert.equal(me.body.role_words, 'Supervisor');
});

test('a username nobody gave is made from the name, and no two people share one', async () => {
  const admin = await signIn('ariful.islam', SECRET);
  const made = await call({ method: 'POST', token: admin.body.token, body: { action: 'user_save', name: 'Mona Fahmy', role: 'ops_agent' } });
  assert.equal(made.body.user.username, 'mona.fahmy');
  assert.equal(made.body.user.has_password, false, 'added, but cannot sign in until a password is set');

  const clash = await call({ method: 'POST', token: admin.body.token, body: { action: 'user_save', name: 'Mona Other', username: 'mona.fahmy', role: 'ops_agent' } });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /already Mona Fahmy’s username/);
});

test('a password too short, or the desk secret itself, is refused', async () => {
  const admin = await signIn('ariful.islam', SECRET);
  const short = await call({ method: 'POST', token: admin.body.token, body: { action: 'user_save', name: 'Mona', password: 'abc', role: 'ops_agent' } });
  assert.equal(short.status, 400);
  assert.match(short.body.error, /at least 8 characters/);

  const shared = await call({ method: 'POST', token: admin.body.token, body: { action: 'set_password', name: 'Sara', password: SECRET } });
  assert.equal(shared.status, 400);
  assert.match(shared.body.error, /desk secret/);
});

test('anybody may change their own password; only an administrator may change another’s', async () => {
  const sara = await signIn('sara', SARA_PASSWORD);
  const theirs = await call({ method: 'POST', token: sara.body.token, body: { action: 'set_password', name: 'Ariful Islam', password: 'not yours to set' } });
  assert.equal(theirs.status, 403);
  assert.match(theirs.body.error, /somebody else’s password/);

  const own = await call({ method: 'POST', token: sara.body.token, body: { action: 'set_password', password: 'mine to set entirely' } });
  assert.equal(own.status, 200);

  const admin = await signIn('ariful.islam', SECRET);
  const reset = await call({ method: 'POST', token: admin.body.token, body: { action: 'set_password', name: 'Sara', password: 'reset by the admin' } });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.token, null, 'resetting somebody else’s password hands this tab nothing');
  invalidateTeam();
  assert.equal((await signIn('sara', 'reset by the admin')).status, 200);
});

test('the old shared secret still opens every door, for the deployment that holds it', async () => {
  const r = await call({ query: { view: 'me' }, secret: SECRET, operator: 'Sara' });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Sara');
  assert.equal((await call({ query: { view: 'me' }, secret: 'guess', operator: 'Sara' })).status, 401);
  assert.equal((await call({ query: { view: 'me' }, operator: 'Sara' })).status, 401);
});

// ---------------------------------------------------------------------------
// A database that has not caught up with the code
// ---------------------------------------------------------------------------

test('on a desk whose database has not run the migration, everything still works on the shared secret', async () => {
  // ops_users as it was before the accounts migration: no username, no password.
  await setup({
    users: [
      { name: 'Sara', role: 'ops_agent', active: true },
      { name: 'Ariful Islam', role: 'admin', active: true },
    ],
  });

  const r = await signIn('Sara', SECRET);
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Sara');
  assert.equal(r.body.needs_password, true);
  assert.equal((await call({ query: { view: 'me' }, token: r.body.token })).status, 200);

  // Settings says the columns are not there, so the screen can say so rather
  // than offering a password box that cannot save.
  const s = await call({ query: { view: 'settings' }, secret: SECRET, operator: 'Ariful Islam' });
  assert.equal(s.body.accounts, false);

  // And adding a person writes no credentials it cannot write.
  const made = await call({
    method: 'POST', secret: SECRET, operator: 'Ariful Islam',
    body: { action: 'user_save', name: 'Mona', username: 'mona', password: 'a good long one', role: 'ops_agent' },
  });
  assert.equal(made.status, 200);
  assert.equal(made.body.accounts, false);
  assert.equal(rows('ops_users').find((u) => u.name === 'Mona').password_hash, undefined);
});

test('a token stays good on an instance that is still reading the old columns', async () => {
  // Signed in against a database that has the columns...
  const { body: { token } } = await signIn('sara', SARA_PASSWORD);
  assert.ok(readToken(token).pv > 0, 'the token names the password it was issued against');

  // ...and then served by a copy of ops_users without password_set_at, as an
  // instance that was warm when the migration ran would read it. Absent is not
  // "never set": the session must not be thrown away on a missing column.
  invalidateTeam();
  const full = db.from.bind(db);
  db.from = (table) => (table === 'ops_users'
    ? stripColumns(full(table), ['password_set_at', 'username', 'password_hash'])
    : full(table));
  try {
    const me = await call({ query: { view: 'me' }, token });
    assert.equal(me.status, 200);
    assert.equal(me.body.name, 'Sara');
  } finally {
    db.from = full;
    invalidateTeam();
  }
});

/** A table read with some columns taken out of every row, as an older database answers. */
function stripColumns(builder, columns) {
  const strip = (rowsIn) => (Array.isArray(rowsIn)
    ? rowsIn.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !columns.includes(k))))
    : rowsIn);
  return new Proxy(builder, {
    get(target, prop) {
      if (prop === 'then') {
        return (resolve, reject) => target.then((out) => resolve({ ...out, data: strip(out.data) }), reject);
      }
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return (...args) => {
        const out = value.apply(target, args);
        return out === target || (out && typeof out.then === 'function' && typeof out.select === 'function')
          ? stripColumns(out, columns) : out;
      };
    },
  });
}
