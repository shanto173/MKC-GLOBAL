/**
 * server.js - the same app, off Vercel.
 *
 * Moving host is only safe if every handler sees what Vercel gave it: the same
 * route for the same file, the same rewrites, the same req.query and req.body,
 * the same res.status().json(). And the server must not hand out anything from
 * outside public/, where .env sits one directory up.
 *
 * The handlers here are stand-ins that report what they received. One test
 * loads the real api/ directory, so a handler that would not load on the new
 * host fails here first.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitUntil } from '@vercel/functions';
import { createApp, loadRewrites, loadRoutes, provideWaitUntil, settle } from '../server.js';

const WEB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const quiet = { log() {}, error() {} };

// A public/ with a secret beside it, where .env would be.
const site = mkdtempSync(path.join(os.tmpdir(), 'mky-server-'));
const publicDir = path.join(site, 'public');
mkdirSync(path.join(publicDir, 'ops'), { recursive: true });
writeFileSync(path.join(publicDir, 'index.html'), '<h1>widget</h1>');
writeFileSync(path.join(publicDir, 'ops', 'index.html'), '<h1>console</h1>');
writeFileSync(path.join(publicDir, 'ops', 'app.js'), 'console.log(1)');
writeFileSync(path.join(site, 'secret.txt'), 'TELEGRAM_BOT_TOKEN=do-not-serve');

const seen = [];
let finished = false;

const routes = new Map([
  ['/api/echo', (req, res) => {
    seen.push({ method: req.method, query: req.query, body: req.body });
    res.status(201).json({ ok: true });
  }],
  ['/api/admin/ops', (req, res) => res.status(200).json({ query: req.query })],
  ['/api/pdf', (req, res) => {
    res.setHeader('content-type', 'application/pdf');
    res.status(200).send(Buffer.from('%PDF-1.4 bytes'));
  }],
  ['/api/boom', () => { throw new Error('handler exploded'); }],
  ['/api/later', (req, res) => {
    waitUntil(new Promise((resolve) => setTimeout(() => { finished = true; resolve(); }, 150)));
    waitUntil(Promise.reject(new Error('background failure is logged, not thrown')));
    res.status(200).json({ answered: true });
  }],
]);

const rewrites = new Map([
  ['/', '/index.html'],
  ['/api/cron/outbox', '/api/admin/ops?resource=outbox'],
]);

let server;
let base;

before(async () => {
  provideWaitUntil();
  server = http.createServer(createApp({ routes, rewrites, publicDir, bodyLimit: 64, logger: quiet }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(site, { recursive: true, force: true });
});

/** A request with the path sent exactly as written - fetch would tidy it first. */
function raw(pathname) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// The real project
// ---------------------------------------------------------------------------

test('every file under api/ loads and becomes the route Vercel gave it', async () => {
  const real = await loadRoutes(path.join(WEB, 'api'));
  for (const route of ['/api/telegram', '/api/chat', '/api/health', '/api/status',
                       '/api/admin/bookings', '/api/admin/ops', '/api/admin/label', '/api/admin/setup']) {
    assert.equal(typeof real.get(route), 'function', `${route} is routed`);
  }
});

test('the rewrites come from vercel.json, so the two hosts cannot disagree', () => {
  const real = loadRewrites(path.join(WEB, 'vercel.json'));
  assert.equal(real.get('/api/cron/outbox'), '/api/admin/ops?resource=outbox');
  assert.equal(real.get('/api/admin/tasks'), '/api/admin/ops?resource=tasks');
  assert.equal(real.get('/'), '/index.html');
});

test('a rewrite this server cannot apply stops it starting, rather than answering 404', () => {
  const file = path.join(site, 'vercel.json');
  writeFileSync(file, JSON.stringify({ rewrites: [{ source: '/b/:ref', destination: '/api/booking?ref=:ref' }] }));
  assert.throws(() => loadRewrites(file), /only exact local paths/);
  writeFileSync(file, JSON.stringify({ rewrites: [{ source: '/x', destination: 'https://elsewhere.example/x' }] }));
  assert.throws(() => loadRewrites(file), /only exact local paths/);
});

// ---------------------------------------------------------------------------
// What a handler receives
// ---------------------------------------------------------------------------

test('a handler gets req.query and a parsed JSON body, and res.status().json() answers', async () => {
  seen.length = 0;
  const res = await fetch(`${base}/api/echo?ref=MKY-1&tag=a&tag=b`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ n: 1 }),
  });
  assert.equal(res.status, 201);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(seen[0], { method: 'POST', query: { ref: 'MKY-1', tag: ['a', 'b'] }, body: { n: 1 } });
});

test('no body is null, a form is an object, a trailing slash still routes', async () => {
  seen.length = 0;
  await fetch(`${base}/api/echo/`);
  await fetch(`${base}/api/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'a=1&b=two',
  });
  assert.equal(seen[0].body, null);
  assert.deepEqual(seen[1].body, { a: '1', b: 'two' });
});

test('a rewrite keeps the caller\'s parameters, and its own win', async () => {
  const res = await fetch(`${base}/api/cron/outbox?secret=s3&resource=tasks`);
  assert.deepEqual(await res.json(), { query: { secret: 's3', resource: 'outbox' } });
});

test('broken JSON is a 400 and never reaches the handler', async () => {
  seen.length = 0;
  const res = await fetch(`${base}/api/echo`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"n":',
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Invalid JSON' });
  assert.equal(seen.length, 0);
});

test('a body over the limit is a 413', async () => {
  const res = await fetch(`${base}/api/echo`, {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(65),
  });
  assert.equal(res.status, 413);
});

test('res.send(buffer) sends the bytes under the handler\'s own content type', async () => {
  const res = await fetch(`${base}/api/pdf`);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), '%PDF-1.4 bytes');
});

test('a handler that throws is a 500 and the server carries on', async () => {
  const res = await fetch(`${base}/api/boom`);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'Internal server error' });
  assert.equal((await fetch(`${base}/api/pdf`)).status, 200);
});

test('an unknown api route is a JSON 404', async () => {
  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Not found' });
});

test('work handed to waitUntil finishes after the reply, and settle() waits for it', async () => {
  finished = false;
  const res = await fetch(`${base}/api/later`);
  assert.deepEqual(await res.json(), { answered: true });
  assert.equal(finished, false, 'the reply did not wait for the work');
  assert.equal(await settle(2000), 0, 'nothing left running');
  assert.equal(finished, true);
});

// ---------------------------------------------------------------------------
// public/
// ---------------------------------------------------------------------------

test('/ is the widget, /ops/ the console, /ops/app.js a script', async () => {
  assert.equal(await (await fetch(`${base}/`)).text(), '<h1>widget</h1>');
  assert.equal(await (await fetch(`${base}/ops/`)).text(), '<h1>console</h1>');
  const js = await fetch(`${base}/ops/app.js`);
  assert.match(js.headers.get('content-type'), /text\/javascript/);
  assert.equal(await js.text(), 'console.log(1)');
});

test('/ops redirects to /ops/, so the console\'s relative script paths resolve', async () => {
  const res = await fetch(`${base}/ops?x=1`, { redirect: 'manual' });
  assert.equal(res.status, 308);
  assert.equal(res.headers.get('location'), '/ops/?x=1');
});

test('the redirect stays on this site whatever path was asked', async () => {
  const res = await raw('/.//ops');
  assert.ok(!String(res.headers.location ?? '').startsWith('//'), `location ${res.headers.location}`);
});

test('nothing outside public/ is served, however the path is spelled', async () => {
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/ops/%2e%2e/%2e%2e/secret.txt',
                   '/..%2fsecret.txt', '/ops/..%5c..%5csecret.txt', '/%00']) {
    const res = await raw(p);
    assert.equal(res.status, 404, p);
    assert.ok(!res.body.includes('do-not-serve'), p);
  }
});

test('a missing file is 404, a POST to a file is 405, HEAD has no body', async () => {
  assert.equal((await fetch(`${base}/missing.html`)).status, 404);
  assert.equal((await fetch(`${base}/index.html`, { method: 'POST' })).status, 405);
  const head = await fetch(`${base}/index.html`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String('<h1>widget</h1>'.length));
  assert.equal(await head.text(), '');
});
