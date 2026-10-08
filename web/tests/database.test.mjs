/**
 * Talking to Supabase: every call has a deadline, a slow call is logged with
 * its table and method, and the two writes that may safely be made twice - the
 * session upsert and the window stamp - are made again when the first attempt
 * runs out of time.
 *
 * Why: in the live test on 2026-10-08 single REST writes hung for 5 to 17
 * seconds and the bot said nothing until each came back. Nothing gave up on
 * them, and nothing in the log said which call it was.
 *
 * The deadline is tested against the real supabase-js client with a fetch
 * that never answers, because what matters is how the library treats it - in
 * particular that a GET is not then retried three more times.
 *
 *   npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';

const {
  createDatabaseClient, deadlineFetch, describeRequest, isTimeout, retryOnTimeout, setClientForTests,
  DEFAULT_DB_TIMEOUT_MS,
} = await import('../lib/supabase.js');
const { createFakeDb } = await import('./helpers/fake-db.mjs');

/** A fetch that never answers - it only gives up when it is aborted. */
function hangingFetch(calls = []) {
  return (input, init = {}) => {
    calls.push({ url: String(input?.url ?? input), method: init.method ?? 'GET' });
    return new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal.reason));
    });
  };
}

/** Captures the JSON lines lib/audit.js logEvent() writes. */
async function capturingLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (line) => { try { lines.push(JSON.parse(line)); } catch { /* not ours */ } };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

const timedOut = () => ({ data: null, error: { message: 'AbortError: database call timed out after 4500 ms (POST conversation_sessions)', code: '' } });

test('a write that never answers is given up on at the deadline, as an error the caller can read', async () => {
  const client = createDatabaseClient('https://example.supabase.co', 'key', { fetch: hangingFetch(), timeoutMs: 80 });
  const started = Date.now();
  const { error } = await client.from('conversation_sessions').upsert({ id: 'whatsapp:wa:1' }, { onConflict: 'id' });
  const took = Date.now() - started;
  assert.ok(error, 'an error, not a hang');
  assert.ok(isTimeout(error), `recognisable as the deadline: ${error.message}`);
  assert.ok(took < 1000, `given up on after ${took} ms`);
});

test('a read that never answers is given up on once - not retried three more times by the library', async () => {
  const calls = [];
  const client = createDatabaseClient('https://example.supabase.co', 'key', { fetch: hangingFetch(calls), timeoutMs: 80 });
  const started = Date.now();
  const { error } = await client.from('bookings').select('*').eq('chat_id', 'wa:1');
  const took = Date.now() - started;
  assert.ok(isTimeout(error));
  assert.equal(calls.length, 1, 'postgrest-js retries a failed GET unless it was an abort');
  assert.ok(took < 1000, `took ${took} ms`);
});

test('the deadline is about four and a half seconds unless SUPABASE_TIMEOUT_MS says otherwise', async () => {
  assert.ok(DEFAULT_DB_TIMEOUT_MS >= 4000 && DEFAULT_DB_TIMEOUT_MS <= 5000);
  const saved = process.env.SUPABASE_TIMEOUT_MS;
  process.env.SUPABASE_TIMEOUT_MS = '60';
  try {
    const fetchWithDeadline = deadlineFetch({ base: hangingFetch() });
    const started = Date.now();
    await assert.rejects(fetchWithDeadline('https://example.supabase.co/rest/v1/clients?id=eq.1'), /timed out after 60 ms/);
    assert.ok(Date.now() - started < 1000);
  } finally {
    if (saved === undefined) delete process.env.SUPABASE_TIMEOUT_MS;
    else process.env.SUPABASE_TIMEOUT_MS = saved;
  }
});

test('a call slower than a second is logged with its table and method; a quick one is not', async () => {
  const slow = (input, init) => new Promise((resolve) => setTimeout(() => resolve(new Response('[]', {
    status: 200, headers: { 'content-type': 'application/json' },
  })), 60));
  const client = createDatabaseClient('https://example.supabase.co', 'key', { fetch: slow, timeoutMs: 1000, slowMs: 30 });
  const lines = await capturingLog(async () => {
    await client.from('conversation_sessions').upsert({ id: 'x' }, { onConflict: 'id' });
  });
  const logged = lines.find((l) => l.event === 'db_slow');
  assert.ok(logged, JSON.stringify(lines));
  assert.equal(logged.table, 'conversation_sessions');
  assert.equal(logged.method, 'POST');
  assert.ok(Number(logged.ms) >= 30);

  const quick = createDatabaseClient('https://example.supabase.co', 'key', {
    fetch: async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }), slowMs: 1000,
  });
  const none = await capturingLog(async () => { await quick.from('bookings').select('*'); });
  assert.equal(none.filter((l) => l.event === 'db_slow').length, 0);

  // A timed-out call is logged too, saying so.
  const hung = createDatabaseClient('https://example.supabase.co', 'key', { fetch: hangingFetch(), timeoutMs: 50, slowMs: 10 });
  const timedOutLines = await capturingLog(async () => { await hung.rpc('claim_whatsapp_message', { p_message_id: 'x' }); });
  const t = timedOutLines.find((l) => l.event === 'db_slow');
  assert.equal(t.table, 'rpc:claim_whatsapp_message');
  assert.equal(t.status, 'timeout');
});

test('which table a request is for, from the path only - never the values in the query', () => {
  assert.deepEqual(
    describeRequest('https://x.supabase.co/rest/v1/conversation_sessions?id=eq.whatsapp%3Awa%3A201005551234', { method: 'PATCH' }),
    { table: 'conversation_sessions', method: 'PATCH', storage: false },
  );
  assert.equal(describeRequest('https://x.supabase.co/rest/v1/rpc/claim_whatsapp_message', { method: 'POST' }).table, 'rpc:claim_whatsapp_message');
  const upload = describeRequest('https://x.supabase.co/storage/v1/object/booking-docs/7/MKY-BKG-1/inv.pdf', { method: 'POST' });
  assert.equal(upload.table, 'storage:booking-docs');
  assert.equal(upload.storage, true, 'a file upload gets the longer deadline');
});

test('an idempotent write that timed out is made once more; anything else is not retried', async () => {
  let calls = 0;
  const ok = await retryOnTimeout(async () => (++calls === 1 ? timedOut() : { data: [], error: null }), 'test');
  assert.equal(calls, 2);
  assert.equal(ok.error, null);

  calls = 0;
  const refused = await retryOnTimeout(async () => { calls++; return { data: null, error: { code: '23505', message: 'duplicate key' } }; });
  assert.equal(calls, 1, 'a refusal is an answer, not a timeout');
  assert.equal(refused.error.code, '23505');

  calls = 0;
  await retryOnTimeout(async () => { calls++; return timedOut(); });
  assert.equal(calls, 2, 'once more, and only once');
});

/** The fake database, with the first `times` matching calls failing as the deadline fails them. */
function timingOut(db, match, times = 1) {
  let left = times;
  const from = db.from.bind(db);
  db.from = (name) => {
    const q = from(name);
    const run = q.run.bind(q);
    q.run = async () => (left > 0 && match(name, q) ? (left--, timedOut()) : run());
    return q;
  };
  return db;
}

test('the session write and the window stamp survive one timed-out attempt', async () => {
  const db = timingOut(createFakeDb(), (name, q) => name === 'conversation_sessions' && ['upsert', 'update', 'insert'].includes(q.op), 1);
  setClientForTests(db);
  const { saveSession } = await import('../lib/flow/store.js');
  await saveSession({ id: 'telegram:555', channel: 'telegram', chat_id: '555', current_state: 'MAIN_MENU', context: {} },
    { current_state: 'TRACK_IDENTIFIER' });
  assert.equal(db._tables.conversation_sessions.find((s) => s.id === 'telegram:555').current_state, 'TRACK_IDENTIFIER');

  const stampDb = timingOut(createFakeDb({
    conversation_sessions: [{ id: 'whatsapp:wa:201005551234', channel: 'whatsapp', chat_id: 'wa:201005551234', current_state: 'MAIN_MENU' }],
  }), (name, q) => name === 'conversation_sessions' && q.op === 'update', 1);
  setClientForTests(stampDb);
  const { stampClientMessage, resetChannelsForTests } = await import('../lib/channels.js');
  resetChannelsForTests();
  const stamped = await stampClientMessage({ chatId: 'wa:201005551234' });
  assert.equal(stamped.ok, true);
  assert.ok(stampDb._tables.conversation_sessions[0].last_client_message_at);
});

test('a session read waits for that session\'s write still in flight, and writes land in the order they were made', async () => {
  const db = createFakeDb();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let first = true;
  const from = db.from.bind(db);
  db.from = (name) => {
    const q = from(name);
    const run = q.run.bind(q);
    q.run = async () => {
      if (name === 'conversation_sessions' && q.op === 'upsert' && first) { first = false; await gate; }
      return run();
    };
    return q;
  };
  setClientForTests(db);
  const { startSessionWrite, loadSession } = await import('../lib/flow/store.js');
  const session = { id: 'whatsapp:wa:9', channel: 'whatsapp', chat_id: 'wa:9', current_state: 'MAIN_MENU', context: {} };

  const one = startSessionWrite(session, { current_state: 'TRACK_IDENTIFIER' });
  const two = startSessionWrite(session, { current_state: 'BOOK_VIN' });
  let read = null;
  const reading = loadSession({ channel: 'whatsapp', chatId: 'wa:9' }).then((r) => { read = r; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(read, null, 'the read waits while a write is still on its way');
  release();
  await Promise.all([one, two, reading]);
  assert.equal(read.session.current_state, 'BOOK_VIN', 'it reads the last write, made last');
  assert.equal(db._tables.conversation_sessions[0].current_state, 'BOOK_VIN');
});
