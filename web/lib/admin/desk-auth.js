/**
 * Who is signing in, and how the desk knows them afterwards.
 *
 * Before this, one shared ADMIN_SECRET was the whole of authentication and the
 * name beside it was typed by hand: anybody with the secret could act as
 * anybody on the team, and "confirmed_by" meant only "somebody typed this
 * name". Now each person has a username and a password of their own, and the
 * name on every decision comes from the signed token rather than from the
 * request body.
 *
 *   POST ?resource=console { action: 'sign_in', username, password }
 *        -> { token, expires_at, name, role }
 *
 * The token is signed, not stored: HMAC-SHA256 over a small JSON payload with
 * ADMIN_SECRET as the key. No sessions table, nothing to clean up, and a
 * server that has forgotten everything still recognises a valid one.
 *
 * Three things end a session early:
 *   - seven days passing (the token carries its own expiry);
 *   - the password being changed (the token carries password_set_at, and a
 *     different one on the row is refused);
 *   - the person being switched off (operatorFor checks `active` on every
 *     request, as it always did).
 *
 * ADMIN_SECRET still works as a password. It is the key the deployment holds,
 * so it has to: an administrator who forgets their own password would
 * otherwise lock the desk with nobody able to let them back in. Every use of
 * it is written to the audit trail as what it is.
 */

import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { db } from '../supabase.js';
import { audit } from '../audit.js';
import { invalidateTeam } from './desk-shared.js';

const scrypt = promisify(scryptCb);

/** How long a sign-in lasts before the password is asked for again. */
export const SESSION_MS = 7 * 24 * 3600_000;

export const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

const KEY_LEN = 32;
const SCRYPT_N = 16384;

/**
 * A password, as it is stored: scrypt with a random salt, never the password.
 * The cost is written into the string, so a future increase does not make the
 * passwords already stored unreadable.
 */
export async function hashPassword(plain) {
  const salt = randomBytes(16);
  const key = await scrypt(String(plain), salt, KEY_LEN, { N: SCRYPT_N, r: 8, p: 1 });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Does this password match what is stored? Compared in constant time. */
export async function verifyPassword(plain, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const cost = Number(parts[1]);
  if (!Number.isInteger(cost) || cost < 1024) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[2], 'base64url');
    expected = Buffer.from(parts[3], 'base64url');
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  const key = await scrypt(String(plain), salt, expected.length, { N: cost, r: 8, p: 1 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Why this password cannot be used, in the words the screen shows. Null when it can. */
export function passwordProblem(plain) {
  const s = String(plain ?? '');
  if (s.length < MIN_PASSWORD) return `A password needs at least ${MIN_PASSWORD} characters.`;
  if (s.length > MAX_PASSWORD) return `That password is too long (at most ${MAX_PASSWORD} characters).`;
  if (s.trim() !== s) return 'A password cannot start or end with a space.';
  if (config.adminSecret && s === config.adminSecret) return 'That is the desk secret, not a personal password. Choose a different one.';
  return null;
}

/**
 * A sign-in name, as it is stored: lowercase letters, digits, dot, dash and
 * underscore. "Ariful Islam" becomes "ariful.islam", so the obvious thing
 * typed into the box is the thing that was meant.
 */
export function normaliseUsername(value) {
  const s = String(value ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\-_]+|[.\-_]+$/g, '');
  return s.slice(0, 40);
}

/** Why this username cannot be used. Null when it can. */
export function usernameProblem(value) {
  const u = normaliseUsername(value);
  if (u.length < 2) return 'A username needs at least two letters or digits.';
  return null;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');

function sign(payload) {
  return createHmac('sha256', config.adminSecret).update(payload).digest('base64url');
}

/** The version a token is issued against: the moment the password was last set. */
export const passwordVersion = (user) => (user?.password_set_at ? Date.parse(user.password_set_at) || 0 : 0);

/** A signed token for this person. `pv` is what makes a password change end it. */
export function mintToken(user, { now = Date.now(), ms = SESSION_MS } = {}) {
  const body = b64(JSON.stringify({
    n: user.name, r: user.role, pv: passwordVersion(user), iat: Math.floor(now / 1000), exp: Math.floor((now + ms) / 1000),
  }));
  return `${body}.${sign(body)}`;
}

/**
 * Reads a token back. Returns { ok: true, name, pv, exp } or { ok: false,
 * error } - never throws, whatever was in the header.
 */
export function readToken(token) {
  const raw = String(token ?? '');
  if (!raw || !config.adminSecret) return { ok: false, error: 'Sign in again.' };
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return { ok: false, error: 'Sign in again.' };
  const body = raw.slice(0, dot);
  const given = raw.slice(dot + 1);

  const wanted = sign(body);
  const a = Buffer.from(given);
  const b = Buffer.from(wanted);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: 'Sign in again.' };

  let claims;
  try {
    claims = JSON.parse(unb64(body));
  } catch {
    return { ok: false, error: 'Sign in again.' };
  }
  if (!claims?.n || !Number.isFinite(claims.exp)) return { ok: false, error: 'Sign in again.' };
  if (claims.exp * 1000 < Date.now()) return { ok: false, error: 'Your sign-in has expired. Sign in again.', expired: true };
  return { ok: true, name: String(claims.n), pv: Number(claims.pv) || 0, exp: claims.exp * 1000 };
}

/** The token on a request, from the header the desk sends or the body of an action. */
export const tokenOf = (req) => req?.headers?.['x-desk-token'] ?? req?.body?.token ?? null;

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

/**
 * Wrong passwords, counted per username on this instance.
 *
 * Serverless instances come and go, so this is a speed bump rather than a
 * lock: it costs an attacker the time to find a fresh instance, and it costs a
 * person who mistyped their password nothing, because a correct password
 * clears the count.
 */
const failures = new Map();
const LOCK_AFTER = 8;
const LOCK_MS = 10 * 60_000;

function locked(key) {
  const f = failures.get(key);
  if (!f) return 0;
  if (Date.now() - f.at > LOCK_MS) { failures.delete(key); return 0; }
  return f.count >= LOCK_AFTER ? Math.ceil((LOCK_MS - (Date.now() - f.at)) / 60_000) : 0;
}
function failed(key) {
  const f = failures.get(key);
  failures.set(key, { count: (f && Date.now() - f.at <= LOCK_MS ? f.count : 0) + 1, at: Date.now() });
}
export const forgetFailures = () => failures.clear();

/**
 * POST { action: 'sign_in', username, password } - no token needed, and the
 * only action that needs none.
 *
 * Refusals never say which half was wrong: "no such username" tells an
 * attacker which names exist.
 */
export async function signIn(req, res) {
  const typed = String(req.body?.username ?? req.body?.operator ?? '').trim();
  const password = String(req.body?.password ?? req.body?.secret ?? '');
  const no = () => res.status(401).json({ error: 'That username and password were not accepted.' });

  if (!typed || !password) return res.status(400).json({ error: 'Type your username and password.' });
  if (!config.adminSecret) {
    return res.status(503).json({ error: 'The desk is not configured: ADMIN_SECRET is not set on the server.', setup: 'ADMIN_SECRET' });
  }

  const key = normaliseUsername(typed) || typed.toLowerCase();
  const minutes = locked(key);
  if (minutes) {
    return res.status(429).json({ error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` });
  }

  const { data, error } = await db().from('ops_users').select('*');
  if (error) return res.status(503).json({ error: 'We could not check who you are. Try again.' });
  const everyone = data ?? [];

  // A desk with nobody on it: the first person signs in with the deployment's
  // own secret and any name, and is then offered the administrator's chair
  // (view=me -> bootstrap). Without this a fresh install has no way in.
  if (!everyone.some((u) => u.active !== false)) {
    if (!safeEquals(password, config.adminSecret)) { failed(key); return no(); }
    const name = typed.slice(0, 80);
    return res.status(200).json({
      token: mintToken({ name, role: 'admin', password_set_at: null }),
      expires_at: new Date(Date.now() + SESSION_MS).toISOString(),
      name,
      role: 'admin',
      bootstrap: true,
    });
  }

  const wanted = normaliseUsername(typed);
  const user = everyone.find((u) => u.username && normaliseUsername(u.username) === wanted)
    // The name itself is accepted too: people who were on the desk before
    // usernames existed know their name, not a username they never chose.
    ?? everyone.find((u) => String(u.name ?? '').trim().toLowerCase() === typed.toLowerCase())
    ?? everyone.find((u) => normaliseUsername(u.name) === wanted);

  if (!user) { failed(key); return no(); }

  const byOwn = user.password_hash ? await verifyPassword(password, user.password_hash) : false;
  const bySecret = !byOwn && safeEquals(password, config.adminSecret);
  if (!byOwn && !bySecret) { failed(key); return no(); }

  // Switched off is said plainly: it is not a guess about a password, and the
  // person needs to know whom to ask.
  if (user.active === false) {
    return res.status(403).json({ error: `“${user.name}” is switched off. Ask an administrator.` });
  }

  failures.delete(key);
  if (bySecret) {
    await audit({
      actor_type: 'operator', actor_id: user.name, action: 'desk_sign_in_with_secret',
      entity_type: 'ops_user', entity_id: `user:${user.name}`,
      metadata: { username: user.username ?? null, had_password: Boolean(user.password_hash) },
    }).catch(() => null);
  }

  await db().from('ops_users').update({ last_seen: new Date().toISOString() }).eq('name', user.name)
    .then(() => null, () => null);

  return res.status(200).json({
    token: mintToken(user),
    expires_at: new Date(Date.now() + SESSION_MS).toISOString(),
    name: user.name,
    role: user.role,
    // Said so the desk can nudge: signed in on the shared secret, with no
    // password of their own yet.
    needs_password: Boolean(bySecret && !user.password_hash),
  });
}

/** Constant-time string compare that does not leak length through an exception. */
function safeEquals(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  if (!y.length || x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/**
 * POST { action: 'set_password', name?, password } - an administrator sets
 * somebody's password, or anybody sets their own.
 *
 * Changing a password moves password_set_at, which ends every token issued
 * against the old one: a person who was signed in elsewhere signs in again.
 */
export async function setPassword(req, res, who) {
  const target = String(req.body?.name ?? '').trim() || who.name;
  const mine = target.toLowerCase() === who.name.toLowerCase();
  if (!mine && !who.can('users')) {
    return res.status(403).json({ error: 'Only an administrator can set somebody else’s password.' });
  }

  const password = String(req.body?.password ?? '');
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });

  const { data: all, error: readErr } = await db().from('ops_users').select('name');
  if (readErr) return res.status(503).json({ error: 'We could not reach the team list. Try again.' });
  const user = (all ?? []).find((u) => String(u.name).toLowerCase() === target.toLowerCase());
  if (!user) return res.status(404).json({ error: `“${target}” is not on the team.` });

  const password_hash = await hashPassword(password);
  // One timestamp, used for both the row and the token minted below: two
  // calls to now() differ by a millisecond, and the token would be refused
  // the moment it was issued.
  const password_set_at = new Date().toISOString();
  const { error } = await db().from('ops_users')
    .update({ password_hash, password_set_at })
    .eq('name', user.name);
  if (error) return res.status(500).json({ error: 'We could not save that password.' });
  invalidateTeam();

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'desk_password_set',
    entity_type: 'ops_user', entity_id: `user:${user.name}`,
    metadata: { name: user.name, by: who.name, own: mine },
  });

  // Whoever changed their own password keeps working without signing in again.
  const token = mine ? mintToken({ name: user.name, role: who.role, password_set_at }) : null;
  return res.status(200).json({
    ok: true,
    name: user.name,
    token,
    ...(token ? { expires_at: new Date(Date.now() + SESSION_MS).toISOString() } : {}),
    words: mine ? 'Your password is set.' : `${user.name} can sign in with that password. Anywhere they were signed in, they will be asked again.`,
  });
}
