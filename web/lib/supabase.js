import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { logEvent } from './audit.js';

let client = null;

/**
 * How long one database call may take before it is given up on.
 *
 * A REST call to Supabase normally answers in well under 100 ms. In the live
 * test on 2026-10-08 single writes hung for 5 to 17 seconds - the session
 * upsert after a tap, the window stamp before a turn - and the customer heard
 * nothing until each came back, because nothing gave up on them. A call that
 * has not answered in a few seconds is not going to answer usefully; the
 * caller's own error handling (a session read that failed, a write that is
 * logged and retried) is a better outcome than an unbounded wait.
 *
 * SUPABASE_TIMEOUT_MS changes it, for scripts doing bulk work.
 */
export const DEFAULT_DB_TIMEOUT_MS = 4500;

/** Storage uploads carry whole PDFs and photos, so they get longer. */
export const DEFAULT_STORAGE_TIMEOUT_MS = 30_000;

/** A call slower than this is written to the log with its table and method. */
export const SLOW_DB_CALL_MS = 1000;

const positive = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * The error a call that ran out of time fails with. Named AbortError on
 * purpose: postgrest-js retries a failed GET three more times, with waits of
 * one, two and four seconds, unless the failure is an abort - and a read that
 * has already taken the whole deadline must not be made to take four.
 */
const TIMED_OUT = /database call timed out after \d+ ms/;

/** True when a Supabase result's error is our deadline, not a database refusal. */
export function isTimeout(error) {
  return TIMED_OUT.test(String(error?.message ?? error ?? ''));
}

/**
 * Which table (or function, or storage bucket) and which method a request is,
 * for the log. Only the path is read: the query string carries customer
 * values - chat ids, phone numbers - that have no business in a log line.
 */
export function describeRequest(input, init = {}) {
  const href = typeof input === 'string' ? input : input?.url ?? String(input ?? '');
  const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
  let path = '';
  try { path = new URL(href).pathname; } catch { path = href.split('?')[0]; }
  const rest = /\/rest\/v1\/(?:rpc\/)?([^/?]+)/.exec(path);
  if (rest) return { table: path.includes('/rpc/') ? `rpc:${rest[1]}` : rest[1], method, storage: false };
  const bucket = /\/storage\/v1\/object\/(?:sign\/|public\/|authenticated\/)?([^/?]+)/.exec(path);
  if (bucket) return { table: `storage:${bucket[1]}`, method, storage: true };
  return { table: path || 'unknown', method, storage: path.includes('/storage/') };
}

/**
 * A fetch with a deadline, and a log line for anything slow.
 *
 * `base` is looked up on every call rather than captured, so a test - or a
 * platform - that replaces globalThis.fetch is honoured.
 */
export function deadlineFetch({
  base = (...args) => globalThis.fetch(...args),
  timeoutMs = positive(process.env.SUPABASE_TIMEOUT_MS, DEFAULT_DB_TIMEOUT_MS),
  storageTimeoutMs = positive(process.env.SUPABASE_STORAGE_TIMEOUT_MS, DEFAULT_STORAGE_TIMEOUT_MS),
  slowMs = SLOW_DB_CALL_MS,
} = {}) {
  return async function fetchWithDeadline(input, init = {}) {
    const { table, method, storage } = describeRequest(input, init);
    const limit = storage ? storageTimeoutMs : timeoutMs;
    const deadline = AbortSignal.timeout(limit);
    // A caller's own signal still works: whichever fires first wins.
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    const started = Date.now();
    let status = null;
    try {
      const res = await base(input, { ...init, signal });
      status = res?.status ?? null;
      return res;
    } catch (err) {
      if (deadline.aborted && !init?.signal?.aborted) {
        status = 'timeout';
        const timedOut = new Error(`database call timed out after ${limit} ms (${method} ${table})`);
        timedOut.name = 'AbortError';
        timedOut.code = 'DB_TIMEOUT';
        throw timedOut;
      }
      status = 'error';
      throw err;
    } finally {
      const took = Date.now() - started;
      if (took >= slowMs) logEvent('db_slow', { table, method, ms: took, status, limit_ms: limit });
    }
  };
}

/**
 * A Supabase client whose every call has a deadline. Exported so the deadline
 * can be tested against the real client library, not a stand-in for it.
 */
export function createDatabaseClient(url, key, { fetch: base, timeoutMs, storageTimeoutMs, slowMs } = {}) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: deadlineFetch({ ...(base ? { base } : {}), timeoutMs, storageTimeoutMs, slowMs }) },
  });
}

/**
 * Server-side Supabase client using the service_role key.
 * This bypasses Row Level Security, so it must never run in a browser.
 */
export function db() {
  if (!client) {
    if (!config.supabase.url || !config.supabase.serviceRoleKey) {
      throw new Error('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
    }
    client = createDatabaseClient(config.supabase.url, config.supabase.serviceRoleKey);
  }
  return client;
}

/**
 * Runs an idempotent write, and runs it once more if the first attempt ran out
 * of time.
 *
 * Only for writes that land the same however many times they land - an upsert
 * of a whole row, an update setting a value - because a timed-out call may well
 * have reached the database. Never for an insert that would make a second row,
 * and never for a claim, where the retry would lose to its own first attempt.
 *
 * @param {() => PromiseLike<{error?: object|null}>} write  builds and runs the call
 * @param {string} label  what it is, for the log
 */
export async function retryOnTimeout(write, label = 'write') {
  const first = await write();
  if (!isTimeout(first?.error)) return first;
  logEvent('db_retry', { what: label });
  return write();
}

/**
 * Replaces the client, for tests only.
 *
 * The flows are worth testing precisely because they must behave the same on a
 * Tuesday as on a Friday, and that is only checkable against a database whose
 * contents the test controls. Pass null to restore the real client.
 *
 * Guarded by NODE_ENV so a stray call in production cannot silently point the
 * bot at something that is not Supabase.
 */
export function setClientForTests(fake) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('setClientForTests must never be called in production');
  }
  client = fake;
}
