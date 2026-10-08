/**
 * What the WhatsApp tests share: a network that answers like Meta, Telegram and
 * the model would (and records what it was asked), requests signed the way
 * Meta signs them, and a database double that can pretend a migration has not
 * been applied.
 *
 * No test here touches a real network. globalThis.fetch is replaced; anything
 * it does not recognise is a 404, so a call nobody expected fails loudly in an
 * assertion rather than quietly reaching the internet.
 */

import { createHmac } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// The network
// ---------------------------------------------------------------------------

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

/**
 * Replaces fetch. Returns the recorder:
 *   calls            every request, in order
 *   sent()           WhatsApp messages we sent (not read receipts)
 *   telegram(method) Telegram calls by method
 *   failNext(code)   the next WhatsApp send fails with that Meta error code
 *   media            media id -> { url, mime_type, file_size, sha256 }
 *   files            url -> { status, buffer } (a list is served in order)
 *   model            the text the model "answers" with
 */
export function fakeNetwork() {
  const net = {
    calls: [],
    failures: [],
    media: new Map(),
    files: new Map(),
    model: '{"doc_type":"other"}',
    nextId: 1,
  };

  net.sent = () => net.calls
    .filter((c) => c.host === 'graph.facebook.com' && c.path.endsWith('/messages') && c.json?.type)
    .map((c) => c.json);
  net.telegram = (method) => net.calls
    .filter((c) => c.host === 'api.telegram.org' && c.path.endsWith(`/${method}`))
    .map((c) => c.json);
  net.failNext = (code, message = 'refused') => { net.failures.push({ code, message }); };
  net.reset = () => {
    net.calls.length = 0;
    net.failures.length = 0;
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    let body = null;
    if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const call = {
      url: String(input), host: url.host, path: url.pathname, method: init.method ?? 'GET',
      json: body, form: init.body instanceof FormData ? init.body : null, headers: init.headers ?? {},
    };
    net.calls.push(call);

    if (url.host === 'graph.facebook.com') {
      if (call.method === 'POST' && url.pathname.endsWith('/media')) return json(200, { id: `media-up-${net.nextId++}` });
      if (call.method === 'POST' && url.pathname.endsWith('/messages')) {
        if (body?.status === 'read') return json(200, { success: true });
        const failure = net.failures.shift();
        if (failure) {
          return json(400, { error: { code: failure.code, message: failure.message, type: 'OAuthException' } });
        }
        return json(200, {
          messaging_product: 'whatsapp',
          contacts: [{ input: body?.to, wa_id: body?.to }],
          messages: [{ id: `wamid.out.${net.nextId++}` }],
        });
      }
      if (call.method === 'GET') {
        const id = decodeURIComponent(url.pathname.split('/').pop());
        const media = net.media.get(id);
        if (media) {
          const current = Array.isArray(media) ? media.shift() ?? media.at(-1) : media;
          return json(200, { messaging_product: 'whatsapp', id, ...current });
        }
        if (id) return json(200, { display_phone_number: '+20 3 555 0000', verified_name: 'MKY', quality_rating: 'GREEN' });
      }
      return json(404, { error: { code: 100, message: 'unknown path' } });
    }

    if (net.files.has(call.url)) {
      const entry = net.files.get(call.url);
      const served = Array.isArray(entry) ? entry.shift() : entry;
      if (!served || served.status !== 200) return new Response('expired', { status: served?.status ?? 404 });
      return new Response(served.buffer, { status: 200 });
    }

    if (url.host === 'api.telegram.org') {
      if (url.pathname.endsWith('/sendMessage')) return json(200, { ok: true, result: { message_id: net.nextId++ } });
      if (url.pathname.endsWith('/getChat')) return json(200, { ok: true, result: {} });
      return json(200, { ok: true, result: true });
    }

    if (url.host === 'api.openai.com') {
      return json(200, { choices: [{ message: { content: net.model } }] });
    }

    return json(404, { error: 'not mocked' });
  };

  return net;
}

// ---------------------------------------------------------------------------
// Requests, signed as Meta signs them
// ---------------------------------------------------------------------------

export const sign = (bytes, secret) => `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`;

/** A response object with the helpers Vercel and server.js give a handler. */
export function mockRes() {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (value) => { res.body = value; return res; };
  res.send = (value) => { res.body = value; return res; };
  res.setHeader = (key, value) => { res.headers[String(key).toLowerCase()] = value; };
  return res;
}

/** As server.js hands it over: the bytes kept on req.rawBody, the body parsed. */
export function serverReq(bytes, headers = {}) {
  return {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    query: {}, rawBody: bytes, body: JSON.parse(bytes.toString('utf8')),
  };
}

/**
 * As Vercel's Node runtime hands it over: the stream already read (to offer
 * req.body) and then replayed through 'data'/'end' listeners - this is
 * restoreBody() from @vercel/node's serverless-functions/helpers.ts.
 */
export async function vercelReq(bytes, headers = {}) {
  const req = Readable.from([bytes]);
  for await (const chunk of req) void chunk;   // consumed, as Vercel's serializeBody does

  const replicateBody = new PassThrough();
  const on = replicateBody.on.bind(replicateBody);
  const originalOn = req.on.bind(req);
  req.read = replicateBody.read.bind(replicateBody);
  req.on = req.addListener = (name, cb) => (name === 'data' || name === 'end' ? on(name, cb) : originalOn(name, cb));
  replicateBody.write(bytes);
  replicateBody.end();

  req.method = 'POST';
  req.headers = { 'content-type': 'application/json', ...headers };
  req.query = {};
  // Lazy, like Vercel's: the parsed body exists, but it is not what is signed.
  Object.defineProperty(req, 'body', { get: () => JSON.parse(bytes.toString('utf8')) });
  return req;
}

/** A Meta webhook body carrying these messages from one sender. */
export function inbound(messages, { waId = '201005551234', name = 'Ariful', phoneNumberId = 'PNID' } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId },
          contacts: [{ profile: { name }, wa_id: waId }],
          messages: messages.map((m, i) => ({
            from: waId, id: m.id ?? `wamid.in.${Math.random().toString(36).slice(2)}`,
            timestamp: String(1_790_000_000 + i), ...m,
          })),
        },
      }],
    }],
  };
}

/** A Meta webhook body carrying delivery receipts. */
export function receipts(statuses, { phoneNumberId = 'PNID' } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: phoneNumberId },
      statuses: statuses.map((s) => ({ timestamp: '1790000000', recipient_id: '201005551234', ...s })),
    } }] }],
  };
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

/**
 * Adds claim_whatsapp_message() to the fake database, with the semantics of
 * the migration's function: first caller wins; a failed or stale claim may be
 * taken again.
 */
export function withWhatsAppClaims(db) {
  const rpc = db.rpc.bind(db);
  db.rpc = async (name, args = {}) => {
    if (name !== 'claim_whatsapp_message') return rpc(name, args);
    const rows = (db._tables.processed_whatsapp_messages ??= []);
    const now = new Date().toISOString();
    const existing = rows.find((r) => r.message_id === args.p_message_id);
    if (!existing) {
      rows.push({ message_id: args.p_message_id, chat_id: args.p_chat_id, status: 'processing', created_at: now, processed_at: now });
      return { data: true, error: null };
    }
    const stale = existing.status === 'processing' && Date.now() - new Date(existing.processed_at).getTime() > 120_000;
    if (existing.status === 'failed' || stale) {
      existing.status = 'processing';
      existing.processed_at = now;
      return { data: true, error: null };
    }
    return { data: false, error: null };
  };
  return db;
}

/**
 * Makes the fake database behave like one where a migration has NOT been
 * applied: naming a missing column fails the whole statement, as PostgREST
 * does, a missing table is "relation does not exist", and a missing function
 * is "could not find the function".
 *
 * @param {{columns?: Record<string, string[]>, tables?: string[], rpcs?: string[]}} missing
 */
export function withoutSchema(db, { columns = {}, tables = [], rpcs = [] } = {}) {
  const from = db.from.bind(db);
  db.from = (name) => {
    const q = from(name);
    let refusal = tables.includes(name)
      ? { code: '42P01', message: `relation "public.${name}" does not exist` }
      : null;
    const gone = columns[name] ?? [];
    const refuse = (col, code = 'PGRST204') => {
      refusal ??= code === 'PGRST204'
        ? { code, message: `Could not find the '${col}' column of '${name}' in the schema cache` }
        : { code, message: `column ${name}.${col} does not exist` };
    };
    const inspect = (row) => { for (const col of gone) if (row && Object.hasOwn(row, col)) refuse(col); };

    for (const method of ['insert', 'update', 'upsert']) {
      const original = q[method].bind(q);
      q[method] = (payload, ...rest) => { [].concat(payload).forEach(inspect); return original(payload, ...rest); };
    }
    const select = q.select.bind(q);
    q.select = (cols, ...rest) => {
      const named = String(cols ?? '').split(',').map((c) => c.trim());
      for (const col of gone) if (named.includes(col)) refuse(col, '42703');
      return select(cols, ...rest);
    };
    for (const method of ['eq', 'neq', 'in', 'is', 'gte', 'lte', 'lt', 'gt']) {
      const original = q[method].bind(q);
      q[method] = (col, ...rest) => { if (gone.includes(col)) refuse(col, '42703'); return original(col, ...rest); };
    }
    const run = q.run.bind(q);
    q.run = async () => (refusal ? { data: null, error: refusal, count: null } : run());
    return q;
  };

  const rpc = db.rpc.bind(db);
  db.rpc = async (name, args) => (rpcs.includes(name)
    ? { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name} in the schema cache` } }
    : rpc(name, args));
  return db;
}

/** Everything migration 20261007090000 (and 20261007100000) adds. */
export const MIGRATION_COLUMNS = {
  clients: ['whatsapp_id', 'whatsapp_name', 'language', 'opted_out_at'],
  conversation_sessions: ['language', 'last_client_message_at'],
  notification_outbox: ['language', 'template_name', 'provider_message_id', 'delivery_status'],
  booking_documents: ['whatsapp_media_id', 'whatsapp_media_sha256'],
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Makes chosen database calls slow, the way Supabase was in the live test:
 * every call `match(table, query)` picks waits - for `release()`, or for
 * `delayMs` when one is given - before it runs. `waiting` counts the calls
 * that have been held, so a test can see the write it is holding is there.
 *
 * `match` sees the fake's query: `q.op` is 'select' | 'insert' | 'update' |
 * 'upsert' | 'delete', `q.payload` what is being written.
 */
export function gateCalls(db, match, { delayMs = null, times = Infinity } = {}) {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const state = { waiting: 0, release: () => open() };
  const from = db.from.bind(db);
  db.from = (name) => {
    const q = from(name);
    const run = q.run.bind(q);
    q.run = async () => {
      if (state.waiting < times && match(name, q)) {
        state.waiting++;
        await (delayMs != null ? sleep(delayMs) : gate);
      }
      return run();
    };
    return q;
  };
  return state;
}

/** Polls until `check()` is true, for at most `ms`. Returns whether it became true. */
export async function waitUntil(check, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(10);
  }
  return Boolean(check());
}
