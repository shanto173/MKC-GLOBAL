/**
 * The bot on a plain Node server, for any host that is not Vercel.
 *
 * Vercel does four things for this project, and this file does the same four:
 *
 *   1. every file under api/ is a route - api/admin/bookings.js answers
 *      /api/admin/bookings;
 *   2. public/ is served as it is - the website widget and the ops console;
 *   3. the rewrites in vercel.json apply - read from that file, so the two
 *      hosts cannot drift apart;
 *   4. work handed to waitUntil() finishes after the reply has gone.
 *
 * No handler changes. They are (req, res) functions, and the few helpers they
 * use on top of Node's own - req.query, req.body, res.status, res.json,
 * res.send - are added here, plus req.rawBody (the unparsed bytes), which
 * the WhatsApp webhook needs to check Meta's signature.
 *
 * And one thing Vercel's free plan would not do: retry the notification outbox
 * every few minutes (OUTBOX_EVERY_MINUTES, default 5; 0 turns it off).
 *
 *   node server.js        listens on PORT, default 3000
 */

import http from 'node:http';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** Vercel refuses a request body over 4.5 MB, and so does this, with the same 413. */
const BODY_LIMIT = 4.5 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------------------
// waitUntil
// ---------------------------------------------------------------------------

/** Work still running after its reply went out. A shutdown waits for it. */
const background = new Set();

/**
 * api/telegram.js answers Telegram first and reads a document afterwards,
 * handing the reading to waitUntil() from @vercel/functions. That function
 * looks for Vercel's request context under this symbol and, finding none, does
 * nothing. The work still runs, because this process stays up - but nothing
 * knows it is running, and a restart would cut it off mid-read and leave the
 * client's paper "still reading" for good. So the context is provided here, and
 * a restart waits for that work first.
 */
export function provideWaitUntil() {
  globalThis[Symbol.for('@vercel/request-context')] = { get: () => ({ waitUntil: keep }) };
}

function keep(promise) {
  const p = Promise.resolve(promise)
    .catch((err) => console.error('background work failed:', err?.message ?? err))
    .finally(() => background.delete(p));
  background.add(p);
}

/**
 * Waits for background work - including work started meanwhile - for at most
 * `ms`. Returns how much was still running when it gave up.
 */
export async function settle(ms) {
  const deadline = Date.now() + ms;
  while (background.size && Date.now() < deadline) {
    let timer;
    await Promise.race([
      Promise.all(background),
      new Promise((resolve) => { timer = setTimeout(resolve, deadline - Date.now()); }),
    ]);
    clearTimeout(timer);
  }
  return background.size;
}

// ---------------------------------------------------------------------------
// Routes and rewrites
// ---------------------------------------------------------------------------

/**
 * Every file under api/ as a route, the way Vercel maps them - including its
 * rule that a name starting with "_" or "." is not a route. Imported up front,
 * so a handler that fails to load stops the server starting rather than
 * failing the first client who reaches it.
 */
export async function loadRoutes(dir, prefix = '/api') {
  const routes = new Map();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (/^[_.]/.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [route, handler] of await loadRoutes(file, `${prefix}/${entry.name}`)) routes.set(route, handler);
    } else if (entry.name.endsWith('.js')) {
      const { default: handler } = await import(pathToFileURL(file).href);
      if (typeof handler !== 'function') throw new Error(`${file} has no default export to route to`);
      routes.set(`${prefix}/${entry.name.slice(0, -3)}`, handler);
    }
  }
  return routes;
}

/**
 * The rewrites in vercel.json. Only exact paths are used there today. A
 * pattern (":ref", "(.*)") or a rewrite to another site would need more than
 * this file does, so either stops the server starting rather than quietly
 * answering 404.
 */
export function loadRewrites(file) {
  const { rewrites = [] } = JSON.parse(readFileSync(file, 'utf8'));
  const table = new Map();
  for (const { source, destination } of rewrites) {
    if (/[:(*]/.test(source) || !destination.startsWith('/')) {
      throw new Error(`server.js cannot apply the rewrite "${source}" -> "${destination}": only exact local paths are supported`);
    }
    table.set(source, destination);
  }
  return table;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * The request listener. Everything it needs is passed in, so the tests can run
 * it against handlers and files of their own.
 */
export function createApp({ routes, rewrites = new Map(), publicDir, bodyLimit = BODY_LIMIT, logger = console }) {
  const root = path.resolve(publicDir);

  return async function app(req, res) {
    const started = Date.now();
    let asked = '?';
    // The path only. A query string can carry ?secret=, and logs outlive it.
    res.on('finish', () => logger.log(`${req.method} ${asked} ${res.statusCode} ${Date.now() - started}ms`));

    try {
      const url = new URL(req.url, 'http://localhost');
      asked = url.pathname;

      let pathname = url.pathname;
      const query = new URLSearchParams(url.search);
      const rewrite = rewrites.get(pathname);
      if (rewrite) {
        const target = new URL(rewrite, 'http://localhost');
        pathname = target.pathname;
        // The rewrite's own parameters win: /api/cron/outbox is the outbox
        // however it is called.
        for (const [key, value] of target.searchParams) query.set(key, value);
      }

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        const handler = routes.get(pathname.replace(/\/+$/, ''));
        if (!handler) return reply(res, 404, { error: 'Not found' });
        return await callApi(handler, req, res, query, bodyLimit, logger);
      }
      return await serveStatic(root, pathname, url.search, req, res);
    } catch (err) {
      // An exception must not escape: in a long-lived process it would take
      // every other conversation down with this one.
      logger.error(`${req.method} ${asked} failed:`, err);
      if (!res.headersSent) reply(res, 500, { error: 'Internal server error' });
      else res.end();
    }
  };
}

async function callApi(handler, req, res, query, bodyLimit, logger) {
  req.query = toQuery(query);
  try {
    const raw = await readBody(req, bodyLimit);
    // The bytes exactly as they arrived. A signed webhook (api/whatsapp.js) is
    // verified over these: the parsed body, serialised again, is not the same
    // bytes, and the stream they came from has been read.
    req.rawBody = raw;
    req.body = parseBody(req.headers['content-type'], raw);
  } catch (err) {
    if (!err.status) throw err;
    return reply(res, err.status, { error: err.message });
  }

  addHelpers(res);
  try {
    await handler(req, res);
  } catch (err) {
    logger.error(`${req.method} ${req.url?.split('?')[0]} failed:`, err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    else res.end();
  }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw httpError(413, 'Request body too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Parsed as Vercel parses it: JSON, a form, text, or the bytes; null when empty. */
function parseBody(type = '', raw) {
  if (!raw.length) return null;
  const mime = type.split(';')[0].trim().toLowerCase();
  if (mime === 'application/json' || mime.endsWith('+json')) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      throw httpError(400, 'Invalid JSON');
    }
  }
  if (mime === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  if (mime.startsWith('text/')) return raw.toString('utf8');
  return raw;
}

/** A repeated parameter is an array, a single one a string - as on Vercel. */
function toQuery(params) {
  const query = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    query[key] = values.length > 1 ? values : values[0];
  }
  return query;
}

function addHelpers(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (value) => {
    if (!res.hasHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(value));
    return res;
  };
  res.send = (body) => {
    if (body !== null && typeof body === 'object' && !(body instanceof Uint8Array)) return res.json(body);
    if (!res.hasHeader('content-type')) {
      res.setHeader('content-type', typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/octet-stream');
    }
    if (body == null) res.end();
    else res.end(typeof body === 'number' ? String(body) : body);
    return res;
  };
}

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function statOrNull(file) {
  try {
    return await stat(file);
  } catch {
    return null;
  }
}

async function serveStatic(root, pathname, search, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, { error: 'Method not allowed' });

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return reply(res, 404, { error: 'Not found' });
  }

  // path.join resolves "..", so anything that lands outside public/ - .env,
  // the code, the keys - is answered exactly like a file that does not exist.
  let file = path.join(root, decoded);
  if (file !== root && !file.startsWith(root + path.sep)) return reply(res, 404, { error: 'Not found' });

  let info = await statOrNull(file);
  if (info?.isDirectory()) {
    if (!pathname.endsWith('/')) {
      // /ops has to become /ops/, or the console's "./app.js" resolves to
      // /app.js. Built from the file's place under public/, not from what was
      // asked, so a path like "//site" cannot turn into an off-site redirect.
      const clean = path.relative(root, file).split(path.sep).join('/');
      res.writeHead(308, { location: `/${clean}/${search}` });
      return res.end();
    }
    file = path.join(file, 'index.html');
    info = await statOrNull(file);
  }
  if (!info?.isFile()) return reply(res, 404, { error: 'Not found' });

  res.writeHead(200, {
    'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    // Vercel's own default: a file is re-checked on every load, so a new
    // version of the console reaches staff without anyone clearing a cache.
    'cache-control': 'public, max-age=0, must-revalidate',
  });
  if (req.method === 'HEAD') return res.end();
  // pipeline, not pipe: a read error must not become an unhandled 'error' event
  // that takes the process down, and a client who leaves mid-download must not
  // leave the file open behind them.
  pipeline(createReadStream(file), res, () => {});
}

// ---------------------------------------------------------------------------
// The process
// ---------------------------------------------------------------------------

/**
 * Retries the notification outbox. On Vercel's free plan nothing did, so a
 * message that failed its first send waited for the next client to write in.
 * The drain claims each row before sending it, so this and the drain inside a
 * request cannot both send the same message.
 */
async function retryOutbox(config) {
  const raw = process.env.OUTBOX_EVERY_MINUTES;
  const minutes = raw === undefined || raw === '' ? 5 : Number(raw);
  if (!(minutes > 0)) {
    console.log('outbox retry: off (OUTBOX_EVERY_MINUTES=0)');
    return () => {};
  }
  if (!config.supabase.url) {
    console.log('outbox retry: off (no database configured)');
    return () => {};
  }

  const { drain } = await import('./lib/outbox.js');
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    keep(
      drain({ limit: 50 })
        .then((r) => { if (!r.ok || r.sent || r.retried || r.dead) console.log('outbox retry:', JSON.stringify(r)); })
        .finally(() => { running = false; }),
    );
  }, minutes * 60_000);
  console.log(`outbox retry: every ${minutes} min`);
  return () => clearInterval(timer);
}

/**
 * A deployment or restart sends SIGTERM. Stop taking requests, let the ones in
 * flight finish, then the background work they started, then exit - within the
 * grace period, which should be shorter than the host's own before it kills
 * the process (docker stop: 10s by default; raise it to match).
 */
async function shutdown(signal, server, stopOutbox) {
  const grace = (Number(process.env.SHUTDOWN_GRACE_SECONDS) || 25) * 1000;
  const deadline = Date.now() + grace;
  console.log(`${signal}: finishing open requests and background work (up to ${grace / 1000}s)`);
  stopOutbox();

  let timer;
  await Promise.race([
    new Promise((resolve) => server.close(resolve)),
    new Promise((resolve) => { timer = setTimeout(resolve, grace); }),
  ]);
  clearTimeout(timer);

  const left = await settle(deadline - Date.now());
  if (left) console.error(`${signal}: ${left} background task(s) still running, exiting anyway`);
  process.exit(0);
}

async function main() {
  // Locally the keys are in .env. On a host they are real environment
  // variables, and those win: loadEnvFile never overwrites one already set.
  const envFile = path.join(ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  provideWaitUntil();
  // Imported only now: lib/config.js reads the environment once, on import.
  const { config } = await import('./lib/config.js');
  const routes = await loadRoutes(path.join(ROOT, 'api'));
  const rewrites = loadRewrites(path.join(ROOT, 'vercel.json'));

  const server = http.createServer(createApp({ routes, rewrites, publicDir: path.join(ROOT, 'public') }));
  // Behind a proxy (Caddy, Railway, Fly) an idle connection must outlive the
  // proxy's own reuse of it. Node's default of 5s closes first, and the request
  // the proxy sends down the closing connection comes back as a 502.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  const port = Number(process.env.PORT) || 3000;
  await new Promise((resolve) => server.listen(port, resolve));
  console.log(`listening on :${port} - ${routes.size} routes, ${rewrites.size} rewrites`);

  const stopOutbox = await retryOutbox(config);
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => shutdown(signal, server, stopOutbox));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('server failed to start:', err);
    process.exit(1);
  });
}
