/**
 * The desk's polling, in the browser's own module (public/desk/ui.js), with
 * the clock, the page and the server replaced: how often it asks, what it
 * fetches again, and what it leaves alone.
 *
 * The promises it keeps: a desk where nothing changes asks one small question
 * per tick and fetches nothing; a change fetches exactly the screens that show
 * it; a hidden tab asks nothing; a failing server is asked less and less
 * often; one refresh of a screen is ever in flight; an answer that has not
 * changed comes back as the same object, so nothing is redrawn.
 */

import test, { mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// -- a page, without a browser ----------------------------------------------
const listeners = {};
const on = (target) => (type, fn) => { (listeners[`${target}:${type}`] ??= []).push(fn); };
const fire = (target, type) => { for (const fn of listeners[`${target}:${type}`] ?? []) fn({ type }); };
globalThis.document = { hidden: false, addEventListener: on('document'), querySelector: () => null };
globalThis.window = { addEventListener: on('window') };

// -- a server: the pulse, and views with ETags ------------------------------
const server = {
  versions: { bookings: 1, customers: 1, history: 1, messages: 1, outbox: 1, problems: 1, requests: 1, shipments: 1, team: 1 },
  supported: true,
  failing: false,
  calls: [],
  delayMs: 0,
};
const json = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});
globalThis.fetch = async (url, init = {}) => {
  const q = Object.fromEntries(new URL(url, 'http://desk').searchParams);
  server.calls.push({ view: q.view, inm: init.headers?.['if-none-match'] ?? null, watch: q.watch ?? null });
  if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  // A read that never answers, until it is aborted.
  if (server.hang === q.view) {
    return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  }
  // Headers, then the body cut off: by the connection, or by the screen being left.
  if (server.cutBody === q.view) {
    return {
      status: 200, ok: true, headers: { get: (k) => (k.toLowerCase() === 'etag' ? 'W/"cut"' : null) },
      json: () => new Promise((_, reject) => {
        const aborted = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (server.cutBy !== 'abort') reject(new SyntaxError('Unexpected end of JSON input'));
        else if (init.signal?.aborted) aborted();
        else init.signal?.addEventListener('abort', aborted);
      }),
    };
  }
  if (server.failOnce === q.view) { server.failOnce = null; return json(500, { error: 'boom' }); }
  if (server.delayMs && (!server.slowView || server.slowView === q.view)) await new Promise((r) => setTimeout(r, server.delayMs));
  if (server.failing) return json(500, { error: 'boom' });
  if (q.view === 'pulse') return server.supported ? json(200, { supported: true, versions: { ...server.versions } }) : json(400, { error: 'Unknown view "pulse"' });
  const etag = `W/"${q.view}-${server.versions.bookings}"`;
  if (init.headers?.['if-none-match'] === etag) return json(304, null);
  return json(200, { view: q.view, at: server.versions.bookings }, { etag });
};

const ui = await import('../public/desk/ui.js');
const { RHYTHM, pollDelay, changed } = await import('../public/desk/live.js');

const views = (name) => server.calls.filter((c) => c.view === name).length;

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  server.calls.length = 0;
  server.failing = false;
  server.supported = true;
  server.delayMs = 0;
  server.slowView = null;
  server.hang = null;
  server.cutBody = null;
  server.cutBy = null;
  server.failOnce = null;
  globalThis.document.hidden = false;
  ui.session.name = 'Sara';
  ui.session.secret = 's';
  ui.forgetAnswers();
});
afterEach(() => {
  ui.stopLive();
  mock.timers.reset();
});

/** Lets the timers run `ms` forward, and every promise they start settle. */
async function pass(ms) {
  const step = 500;
  for (let t = 0; t < ms; t += step) {
    mock.timers.tick(Math.min(step, ms - t));
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
}

/** A screen subscribed to `scopes` that fetches `view` when asked. */
function screen(view, scopes) {
  const s = { loads: 0, data: null };
  s.sub = ui.subscribe(scopes, async () => {
    s.loads += 1;
    s.data = await ui.api({ view });
    return true;
  });
  return s;
}

test('the rhythm: 15 s while used, a minute when idle, doubling after errors, spread so desks do not ask in step', () => {
  const mid = () => 0.5;
  assert.equal(pollDelay({ random: mid }), RHYTHM.activeMs);
  assert.equal(pollDelay({ idleForMs: RHYTHM.idleAfterMs, random: mid }), RHYTHM.idleMs);
  assert.equal(pollDelay({ errors: 1, random: mid }), RHYTHM.activeMs * 2);
  assert.equal(pollDelay({ errors: 10, random: mid }), RHYTHM.maxBackoffMs);
  assert.equal(pollDelay({ supported: false, random: mid }), RHYTHM.fallbackMs);
  const spread = [0, 1].map((r) => pollDelay({ random: () => r }));
  assert.deepEqual(spread, [RHYTHM.activeMs * (1 - RHYTHM.jitter), RHYTHM.activeMs * (1 + RHYTHM.jitter)]);
  assert.equal(changed(['bookings'], { bookings: '1' }, { bookings: '1' }), false);
  assert.equal(changed(['bookings'], { bookings: '1' }, { bookings: '2' }), true);
  assert.equal(changed(['bookings'], null, { bookings: '1' }), true, 'nothing seen yet: fetch');
  assert.equal(changed(['bookings'], {}, { bookings: '1' }), true, 'a scope that appeared: fetch');
  assert.equal(changed(['unknown'], { bookings: '1' }, { bookings: '1' }), false, 'a scope the server does not have: left to MAX_AGE');
});

test('a subscription with a minimum gap is not refreshed more often than that, however often its scopes move', async () => {
  ui.primeLive({ supported: true, versions: { ...server.versions } });
  const at = [];
  ui.subscribe(['messages'], async () => { at.push(Date.now()); return true; }, { minGapMs: 20_000 });
  ui.startLive();
  for (let i = 0; i < 16; i++) { server.versions.messages += 1; await pass(7_500); }
  assert.ok(at.length >= 3 && at.length <= 6, `${at.length} refreshes in two minutes of constant change`);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 20_000, 'never closer than the gap');
});

test('nothing changing: one pulse a tick, and no screen fetched', async () => {
  ui.primeLive({ supported: true, versions: { ...server.versions } });
  const inbox = screen('inbox', ['bookings', 'requests']);
  ui.startLive();
  await pass(60_000);
  assert.equal(inbox.loads, 0);
  assert.ok(views('pulse') >= 3 && views('pulse') <= 5, `${views('pulse')} pulses in a minute`);
  assert.equal(server.calls.length, views('pulse'), 'nothing but the pulse');
});

test('a change fetches the screens that show it, once, and only those', async () => {
  ui.primeLive({ supported: true, versions: { ...server.versions } });
  const inbox = screen('inbox', ['bookings', 'requests']);
  const ships = screen('shipments', ['shipments']);
  ui.startLive();
  server.versions.bookings += 1;
  await pass(20_000);
  assert.equal(inbox.loads, 1);
  assert.equal(ships.loads, 0);
  await pass(30_000);
  assert.equal(inbox.loads, 1, 'and not again while nothing else moves');
});

test('a hidden tab asks nothing; showing it asks at once', async () => {
  ui.primeLive({ supported: true, versions: { ...server.versions } });
  screen('inbox', ['bookings']);
  ui.startLive();
  globalThis.document.hidden = true;
  fire('document', 'visibilitychange');
  server.calls.length = 0;
  await pass(120_000);
  assert.equal(server.calls.length, 0);
  globalThis.document.hidden = false;
  fire('document', 'visibilitychange');
  await pass(100);
  assert.equal(views('pulse'), 1);
});

test('a failing server is asked less and less often', async () => {
  ui.primeLive({ supported: true, versions: { ...server.versions } });
  ui.startLive();
  server.failing = true;
  await pass(240_000);
  // 15 s, then 30, 60, 120, 120…: about five asks in four minutes, not sixteen.
  assert.ok(views('pulse') <= 6, `${views('pulse')} asks`);
  assert.ok(ui.liveState().errors >= 3);
  server.failing = false;
  await pass(130_000);
  assert.equal(ui.liveState().errors, 0, 'and back to normal once it answers');
});

test('one refresh of a screen in flight: asked again meanwhile, it runs once more after', async () => {
  ui.primeLive({ supported: true, versions: { ...server.versions } });
  const inbox = screen('inbox', ['bookings']);
  server.delayMs = 3000;
  inbox.sub.now();
  inbox.sub.now();
  inbox.sub.now();
  await pass(10_000);
  assert.equal(inbox.loads, 2, 'the first, and one more for everything asked meanwhile');
});

test('an answer that has not changed comes back as the same object, from a 304', async () => {
  const first = await ui.api({ view: 'inbox' });
  const again = await ui.api({ view: 'inbox' });
  assert.equal(again, first);
  assert.match(server.calls.at(-1).inm, /^W\//, 'the ETag was sent back');
  server.versions.bookings += 1;
  const changedAnswer = await ui.api({ view: 'inbox' });
  assert.notEqual(changedAnswer, first);
});

test('a request for a screen that has been left is cancelled, and is not "offline"', async () => {
  const leaving = new AbortController();
  leaving.abort();
  await assert.rejects(ui.api({ view: 'inbox' }, { signal: leaving.signal }), (err) => err.aborted === true && !err.offline);
  assert.equal(ui.isOffline(), false);
});

test('an older server without the pulse: every screen on the old timer, and the pulse tried again later', async () => {
  server.supported = false;
  const inbox = screen('inbox', ['bookings']);
  ui.startLive();
  await pass(65_000);
  assert.ok(inbox.loads >= 2 && inbox.loads <= 4, `${inbox.loads} loads in a minute`);
  assert.equal(views('pulse'), 1, 'asked once, then left for five minutes');
  await pass(300_000);
  assert.ok(views('pulse') >= 2, 'and asked again');
});

test('a page that shows one record asks after that record by name, and is fetched again when it moves - not when another does', async () => {
  server.versions['booking:B1'] = 1;
  server.versions['booking:B2'] = 1;
  ui.primeLive({ supported: true, versions: { ...server.versions } });
  const caseB1 = screen('case', ui.scopesOf('case', { type: 'booking', ref: 'B1' }));
  ui.startLive();
  server.versions['booking:B2'] += 1;
  await pass(20_000);
  assert.equal(caseB1.loads, 0, 'another booking moved');
  assert.match(server.calls.filter((c) => c.view === 'pulse').at(-1).watch ?? '', /booking:B1/);
  server.versions['booking:B1'] += 1;
  await pass(20_000);
  assert.equal(caseB1.loads, 1, 'its own booking moved');
  assert.deepEqual(ui.scopesOf('chat', { channel: 'telegram', chat_id: 'wa:2010' }), ['chat:whatsapp:wa:2010', 'team'], 'a WhatsApp chat id is a WhatsApp chat, whatever it was labelled');
  delete server.versions['booking:B1'];
  delete server.versions['booking:B2'];
});

test('a screen slow to load does not hold up the pulse', async () => {
  ui.primeLive({ supported: true, versions: { ...server.versions } });
  const inbox = screen('inbox', ['bookings']);
  ui.startLive();
  server.slowView = 'inbox';
  server.delayMs = 45_000;
  server.versions.bookings += 1;
  await pass(60_000);
  assert.ok(views('pulse') >= 3, `${views('pulse')} pulses while the inbox was loading`);
  assert.equal(views('inbox'), 1, 'and the inbox asked for once, not again while it is still loading');
  await pass(10_000);
  assert.equal(inbox.loads, 1);
});

test('an answer cut off mid-way is not kept, and not handed back later as "not modified"', async () => {
  server.cutBody = 'inbox';
  await assert.rejects(ui.api({ view: 'inbox' }), (err) => err.status === 502 && !err.aborted);
  server.cutBody = null;
  const whole = await ui.api({ view: 'inbox' });
  assert.equal(server.calls.at(-1).inm, null, 'nothing was kept to be validated');
  assert.equal(whole.view, 'inbox');
});

test('a screen left while its answer is arriving is cancelled, and nothing is kept', async () => {
  server.cutBody = 'inbox';
  server.cutBy = 'abort';
  const leaving = new AbortController();
  const pending = ui.api({ view: 'inbox' }, { signal: leaving.signal });
  leaving.abort();
  await assert.rejects(pending, (err) => err.aborted === true);
  server.cutBody = null;
  await ui.api({ view: 'inbox' });
  assert.equal(server.calls.at(-1).inm, null);
});

test('a read that does not answer is given up on after the time limit, and said as too slow, not offline', async () => {
  mock.timers.reset();   // AbortSignal.timeout runs on the real clock
  const before = ui.limits.getTimeoutMs;
  ui.limits.getTimeoutMs = 50;
  server.hang = 'inbox';
  try {
    await assert.rejects(ui.api({ view: 'inbox' }), (err) => err.status === 504 && !err.offline && !err.aborted);
  } finally {
    ui.limits.getTimeoutMs = before;
    server.hang = null;
  }
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
});

test('a refresh whose read failed is tried again on the next tick, even when its screen does not say so', async () => {
  ui.primeLive({ supported: true, versions: { ...server.versions } });
  let loads = 0;
  // A screen whose load swallows its errors and returns nothing, as some do.
  ui.subscribe(['bookings'], async () => { loads += 1; await ui.api({ view: 'inbox' }).catch(() => null); });
  ui.startLive();
  server.versions.bookings += 1;
  server.failOnce = 'inbox';
  await pass(20_000);
  assert.equal(loads, 1, 'the change was fetched, and failed');
  await pass(20_000);
  assert.equal(loads, 2, 'so it was fetched again, though nothing else moved');
  await pass(40_000);
  assert.equal(loads, 2, 'and then left alone');
});
