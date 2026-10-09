/**
 * Telling the desk what changed, cheaply.
 *
 *   GET ?resource=console&view=pulse&watch=booking:MKY-1,chat:whatsapp:wa:…
 *     -> { supported, versions: { bookings: '41', …, 'booking:MKY-1': '7' }, at }
 *
 * The desk used to fetch every screen again every 20 seconds. Now it asks for
 * the pulse - one read of the nine areas' versions and of the records its
 * open screens show (supabase/migrations/20261009120000_desk_activity.sql) -
 * and fetches a screen only when something that screen shows has moved
 * (public/desk/live.js scopesOf says what). Ten people with the desk open,
 * nothing happening: ten small reads every 15 seconds, where there were over
 * four hundred.
 *
 * The same versions make the heavy views conditional. Each answer carries an
 * ETag built from what it was worked out from - the view and its parameters,
 * who asked, the versions of its scopes, a clock bucket for what depends on
 * the time, and the build. A request that sends that ETag back while none of
 * it has changed is answered 304 after the one read, without working the view
 * out at all. Before the migration there are no versions; the ETag is then a
 * hash of the answer itself, which saves the bytes and the redraw, not the
 * reads.
 *
 * And the inbox, which every operator's desk asks for when one booking moves,
 * is worked out once per instance per set of versions (shared()) rather than
 * once per operator.
 *
 * NOTHING HERE IS ALLOWED TO BE STALE. The versions are transactional: a
 * version that has moved means the write that moved it is visible. So a
 * cached answer is reused only under exactly the versions it was worked out
 * from, and the only thing that can make an answer old is the clock, which
 * VIEW_CLOCK bounds.
 */

import { db } from '../supabase.js';
import { fingerprint, isMissingTable } from './desk-shared.js';
import { SCOPES, scopesOf, viewKey, isArea, VIEW_CLOCK } from '../../public/desk/live.js';

/** How long a database without desk_activity is believed to still lack it. */
const UNSUPPORTED_RECHECK_MS = 300_000;

/** Changes with every deployment, so an answer from older code is never "not modified". */
const BUILD = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || `boot-${Date.now().toString(36)}`;

let missing = null;   // { client, at } once desk_activity was seen not to exist

/** At most this many records' keys in one pulse. */
const MAX_WATCH = 20;
const WATCHABLE = /^(booking|request|mrn|shipment|chat):[^,]{1,190}$/;

/** The record keys a request asks about (?watch=booking:MKY-1,chat:whatsapp:wa:…), checked. */
export function watchedKeys(raw) {
  return [...new Set(String(raw ?? '').split(',').map((k) => k.trim()).filter((k) => WATCHABLE.test(k)))].slice(0, MAX_WATCH);
}

/**
 * The versions of the nine areas, and of the records named - read now, in
 * one call. Never cached: a pulse read a moment before an operator's own
 * write would answer their next screen with the state before it.
 * { supported: false } when the table is not there (or holds no areas). A
 * record nobody has written since the migration has no row, and no version:
 * the same on every read, until its first write gives it one.
 */
export async function readPulse(keys = []) {
  const client = db();
  if (missing?.client === client && Date.now() - missing.at < UNSUPPORTED_RECHECK_MS) return { supported: false, versions: null };
  const records = keys.filter((k) => !isArea(k));
  const { data, error } = await client.from('desk_activity').select('scope, version').in('scope', [...SCOPES, ...records]);
  if (error) {
    if (isMissingTable(error)) missing = { client, at: Date.now() };
    else console.error('desk_activity read failed:', error.message);
    return { supported: false, versions: null };
  }
  if (!data?.some((row) => isArea(row.scope))) {
    missing = { client, at: Date.now() };
    return { supported: false, versions: null };
  }
  const versions = {};
  for (const row of data) versions[row.scope] = String(row.version);
  return { supported: true, versions };
}

/** For tests: forget that the table was missing. */
export function resetLiveForTests() {
  missing = null;
  memo = null;
}

/** GET view=pulse&watch=booking:MKY-1,chat:whatsapp:wa:2010… */
export async function pulseView(req, res) {
  const pulse = await readPulse(watchedKeys(req.query?.watch));
  res.setHeader?.('Cache-Control', 'no-store');
  return res.status(200).json({ supported: pulse.supported, versions: pulse.versions, scopes: SCOPES, at: new Date().toISOString() });
}

/** Which clock bucket a view is in: its answer may change when this does, with no write at all. */
const clockOf = (view, now = Date.now()) => Math.floor(now / ((VIEW_CLOCK[view] ?? VIEW_CLOCK.default) * 1000));

/** The parameters that change an answer: everything asked, but not the secret or the resource. */
function params(query = {}) {
  const out = {};
  for (const k of Object.keys(query).sort()) {
    if (['resource', 'secret', 'operator'].includes(k)) continue;
    out[k] = query[k];
  }
  return out;
}

/**
 * The ETag for a view under the current versions, or null when the view is
 * not one the desk polls or there are no versions to vouch for it.
 */
export function versionTag(view, req, who, pulse, now = Date.now()) {
  const scopes = scopesOf(view, req.query);
  if (!scopes || !pulse?.supported) return null;
  return `W/"v-${fingerprint({
    v: viewKey(view, req.query),
    q: params(req.query),
    w: [who?.name ?? null, who?.role ?? null],
    s: scopes.map((s) => pulse.versions[s] ?? null),
    t: clockOf(view, now),
    b: BUILD,
  }).slice(1)}"`;
}

/** FNV-1a over the text itself: the ETag of an answer no version vouches for. */
function bodyTag(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `W/"b-${h.toString(36)}-${text.length.toString(36)}"`;
}

/** Whether If-None-Match names this ETag (weak comparison, as for a GET). */
export function matches(header, etag) {
  if (!header || !etag) return false;
  const bare = (t) => String(t).trim().replace(/^W\//, '');
  return String(header).split(',').some((t) => t.trim() === '*' || bare(t) === bare(etag));
}

function notModified(res, etag) {
  res.setHeader?.('ETag', etag);
  res.setHeader?.('Cache-Control', 'private, no-cache');
  res.status(304);
  return typeof res.end === 'function' ? res.end() : res.send?.('');
}

/**
 * Runs a GET view conditionally.
 *
 * `run(res)` works the view out and answers through the res it is given. On
 * the way out its 200 answer is tagged; a request whose If-None-Match already
 * names that tag gets 304 instead - before `run` when the versions vouch for
 * it, after it when only the answer's own hash can.
 */
export async function conditionalView(view, req, res, who, run) {
  const scopes = scopesOf(view, req.query);
  // Not polled, so nothing vouches for it: no ETag, never "not modified",
  // and never kept by anything between here and the browser - search
  // results, previews, and the signed links of document_url and chat_files,
  // which expire in minutes.
  if (!scopes) {
    res.setHeader?.('Cache-Control', 'no-store');
    return run(res);
  }
  const pulse = await readPulse(scopes);
  req.deskPulse = pulse;
  const asked = req.headers?.['if-none-match'] ?? null;
  const tag = versionTag(view, req, who, pulse);
  if (tag && matches(asked, tag)) return notModified(res, tag);

  let code = 200;
  const wrapped = {
    status(c) { code = c; res.status(c); return wrapped; },
    setHeader(...args) { res.setHeader?.(...args); return wrapped; },
    send(body) { res.send?.(body); return wrapped; },
    end(...args) { if (typeof res.end === 'function') res.end(...args); else res.send?.(''); return wrapped; },
    json(payload) {
      // A view that could not read all of what it shows says so (deskNoTag):
      // no ETag, so nothing is ever answered "not modified" from it.
      if (code === 200 && req.deskNoTag) {
        res.setHeader?.('Cache-Control', 'no-store');
      } else if (code === 200) {
        const etag = tag ?? bodyTag(JSON.stringify(payload));
        if (!tag && matches(asked, etag)) { notModified(res, etag); return wrapped; }
        res.setHeader?.('ETag', etag);
        res.setHeader?.('Cache-Control', 'private, no-cache');
      }
      res.json(payload);
      return wrapped;
    },
  };
  return run(wrapped);
}

// ---------------------------------------------------------------------------
// One inbox per instance per set of versions
// ---------------------------------------------------------------------------

let memo = null;   // { client, key, promise }

/**
 * `compute()` once per database client, set of versions and clock bucket;
 * every operator asking under the same versions shares the answer - and a
 * request that arrives while it is being worked out waits for that one.
 * Without versions (no migration yet) nothing is shared: there is nothing to
 * tell an old answer from a new one.
 *
 * @param {{supported: boolean, versions: object}|null} pulse  as readPulse() gave it, for this request
 * @param {string[]} scopes  what the answer reads
 */
export function shared(name, pulse, scopes, compute, now = Date.now()) {
  if (!pulse?.supported) return compute();
  const client = db();
  const key = fingerprint({ n: name, s: scopes.map((s) => pulse.versions[s] ?? null), t: clockOf(name, now) });
  if (memo?.client === client && memo.key === key) return memo.promise;
  const promise = compute();
  memo = { client, key, promise };
  // A failure is not remembered, nor an answer missing part of what it shows
  // (`partial`): the next request works it out again.
  promise.then(
    (value) => { if (value?.partial && memo?.promise === promise) memo = null; },
    () => { if (memo?.promise === promise) memo = null; },
  );
  return promise;
}
