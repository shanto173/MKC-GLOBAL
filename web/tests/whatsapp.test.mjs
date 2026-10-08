/**
 * The WhatsApp webhook, end to end against an in-memory database and a fake
 * Meta: proving the request came from Meta, answering each message through the
 * same state machine as Telegram, files, receipts, STOP, floods - and the
 * Telegram transport, which now runs in the client's language and logs every
 * message, still saying exactly what it said before to a client who never chose.
 *
 *   npm test
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// lib/config.js reads these once, when first imported - so before anything.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';
process.env.WHATSAPP_ACCESS_TOKEN = 'wa-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'PNID';
process.env.WHATSAPP_APP_SECRET = 'app-secret';
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
process.env.TELEGRAM_BOT_TOKEN = 'tg-token';
process.env.TELEGRAM_WEBHOOK_SECRET = 'tg-secret';
process.env.OPENAI_API_KEY ||= 'test';
process.env.OPERATIONS_PHONE ||= '';

const WEB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const realFetch = globalThis.fetch;

const { createFakeDb } = await import('./helpers/fake-db.mjs');
const {
  fakeNetwork, sign, mockRes, serverReq, vercelReq, inbound, receipts,
  withWhatsAppClaims, withoutSchema, MIGRATION_COLUMNS, gateCalls, waitUntil, sleep,
} = await import('./helpers/whatsapp.mjs');
const { provideWaitUntil, settle, createApp, loadRoutes, loadRewrites } = await import('../server.js');
const { setClientForTests } = await import('../lib/supabase.js');
const { invalidateSettings } = await import('../lib/settings.js');
const { resetFlowReady } = await import('../lib/flow/ready.js');
const { resetLanguageSupportForTests } = await import('../lib/flow/language.js');
const { withLanguage } = await import('../lib/lang.js');
const { M } = await import('../lib/flow/messages.js');
const { S } = await import('../lib/flow/states.js');
const { resetChannelsForTests } = await import('../lib/channels.js');
const { resetOutboxForTests } = await import('../lib/outbox.js');
const { resetChatlogForTests } = await import('../lib/chatlog.js');
const { resetClientsForTests } = await import('../lib/clients.js');
const { resetDocumentsForTests } = await import('../lib/documents.js');
const whatsapp = await import('../api/whatsapp.js');
const telegramHandler = (await import('../api/telegram.js')).default;
const healthHandler = (await import('../api/health.js')).default;
const { splitLanguages } = await import('../lib/agent.js');

const handler = whatsapp.default;
const SECRET = 'app-secret';
const WA_ID = '201005551234';
const CHAT = `wa:${WA_ID}`;

const SETTINGS = [
  { key: 'required_booking_documents', value: ['invoice', 'brief', 'mrn'] },
  { key: 'required_booking_documents_mky_mrn', value: ['invoice', 'brief'] },
  { key: 'required_mrn_documents', value: [] },
  { key: 'acid_required', value: false },
  { key: 'allowed_file_types', value: ['application/pdf', 'image/jpeg', 'image/png'] },
  { key: 'max_upload_bytes', value: 20971520 },
  { key: 'operations_phone', value: null },
  { key: 'whatsapp_window_hours', value: 24 },
  { key: 'whatsapp_templates', value: { _reopen: { name: 'mky_please_reply', params: [] } } },
];

provideWaitUntil();

let net;

function setup({ client = { language: 'en' }, seed = {}, strict = null } = {}) {
  let db = withWhatsAppClaims(createFakeDb({
    bot_settings: SETTINGS,
    clients: client ? [{ id: 7, whatsapp_id: WA_ID, phone: `+${WA_ID}`, is_blocked: false, ...client }] : [],
    ...seed,
  }));
  if (strict) db = withoutSchema(db, strict);
  setClientForTests(db);
  invalidateSettings();
  resetFlowReady(true);
  resetLanguageSupportForTests();
  resetChannelsForTests();
  resetOutboxForTests();
  resetChatlogForTests();
  resetClientsForTests();
  resetDocumentsForTests();
  whatsapp.resetWhatsappForTests();
  return db;
}

beforeEach(() => {
  net = fakeNetwork();
});

/** Posts a signed webhook the way server.js hands it over, and waits for the work. */
async function post(payload, { secret = SECRET, bytes = null, header = undefined } = {}) {
  const raw = bytes ?? Buffer.from(JSON.stringify(payload));
  const headers = header === null ? {} : { 'x-hub-signature-256': header ?? sign(raw, secret) };
  const res = mockRes();
  await handler(serverReq(raw, headers), res);
  await settle(20_000);
  return res;
}

const text = (body, extra = {}) => inbound([{ type: 'text', text: { body }, ...extra }]);
const bodies = () => net.sent().map((m) => m.text?.body ?? m.interactive?.body?.text ?? m.document?.caption ?? `[${m.type}]`);

// ---------------------------------------------------------------------------
// Proving it is Meta
// ---------------------------------------------------------------------------

test('the subscription handshake echoes the challenge only for the right verify token', async () => {
  const ok = mockRes();
  await handler({ method: 'GET', headers: {}, query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '1158201444' } }, ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body, '1158201444');
  assert.match(ok.headers['content-type'], /text\/plain/);

  for (const query of [
    { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' },
    { 'hub.mode': 'unsubscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '1' },
    { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me' },
    { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '<script>alert(1)</script>' },
  ]) {
    const res = mockRes();
    await handler({ method: 'GET', headers: {}, query }, res);
    assert.equal(res.statusCode, 403, JSON.stringify(query));
  }
});

test('a correctly signed webhook is accepted and answered', async () => {
  setup();
  const res = await post(text('menu'));
  assert.equal(res.statusCode, 200);
  assert.ok(net.sent().length >= 1, 'the client got an answer');
});

test('a tampered body, a missing signature or the wrong secret is refused and nothing is read', async () => {
  const db = setup();
  const original = Buffer.from(JSON.stringify(text('menu')));
  const tampered = Buffer.from(JSON.stringify(text('cancel')));

  const altered = await post(null, { bytes: tampered, header: sign(original, SECRET) });
  assert.equal(altered.statusCode, 401);

  const unsigned = await post(null, { bytes: original, header: null });
  assert.equal(unsigned.statusCode, 401);

  const wrongSecret = await post(null, { bytes: original, header: sign(original, 'someone-else') });
  assert.equal(wrongSecret.statusCode, 401);

  const garbage = await post(null, { bytes: original, header: 'sha256=not-hex' });
  assert.equal(garbage.statusCode, 401);

  assert.equal(net.sent().length, 0);
  assert.equal(db._tables.processed_whatsapp_messages, undefined, 'nothing was even claimed');
});

test('the signature is checked over the bytes Meta sent, not the JSON parsed back out', async () => {
  setup();
  // Meta escapes non-ASCII. Parsed and serialised again, these are different
  // bytes - so a check over req.body would refuse every Arabic message.
  const raw = Buffer.from(
    '{"object":"whatsapp_business_account","entry":[{"id":"WABA","changes":[{"field":"messages","value":'
    + '{"metadata":{"phone_number_id":"PNID"},"contacts":[{"profile":{"name":"\\u0623\\u062d\\u0645\\u062f"},"wa_id":"201005551234"}],'
    + '"messages":[{"from":"201005551234","id":"wamid.unicode","timestamp":"1790000000","type":"text",'
    + '"text":{"body":"\\u0627\\u0644\\u0642\\u0627\\u0626\\u0645\\u0629"}}]}}]}]}',
  );
  assert.notEqual(JSON.stringify(JSON.parse(raw.toString())), raw.toString());

  const res = await post(null, { bytes: raw });
  assert.equal(res.statusCode, 200);
  assert.ok(net.sent().length >= 1, '"القائمة" was answered');
});

test('on Vercel the raw bytes are read from the replayed stream, not from req.body', async () => {
  setup();
  const raw = Buffer.from(JSON.stringify(text('menu')));
  const req = await vercelReq(raw, { 'x-hub-signature-256': sign(raw, SECRET) });
  const res = mockRes();
  await handler(req, res);
  await settle(20_000);
  assert.equal(res.statusCode, 200);
  assert.ok(net.sent().length >= 1);

  const bad = await vercelReq(raw, { 'x-hub-signature-256': sign(Buffer.from('x'), SECRET) });
  const refused = mockRes();
  await handler(bad, refused);
  assert.equal(refused.statusCode, 401);
});

test('on a plain Node server, and through server.js, the same bytes are checked', async () => {
  setup();
  const raw = Buffer.from(JSON.stringify(text('menu')));
  const headers = { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw, SECRET) };

  // A bare http server: nothing has read the stream before the handler.
  const bare = http.createServer((req, res) => {
    const helpers = mockRes();
    handler(Object.assign(req, { query: {} }), helpers).then(() => {
      res.writeHead(helpers.statusCode, { 'content-type': 'application/json' });
      res.end(JSON.stringify(helpers.body ?? {}));
    });
  });
  // server.js: reads the stream itself and keeps the bytes on req.rawBody.
  const app = http.createServer(createApp({
    routes: new Map([['/api/whatsapp', handler]]), publicDir: WEB, logger: { log() {}, error() {} },
  }));

  for (const server of [bare, app]) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/whatsapp`;
    const good = await realFetch(url, { method: 'POST', headers, body: raw });
    assert.equal(good.status, 200);
    const bad = await realFetch(url, { method: 'POST', headers, body: Buffer.from(JSON.stringify(text('help'))) });
    assert.equal(bad.status, 401);
    await new Promise((resolve) => server.close(resolve));
  }
  await settle(20_000);
});

// ---------------------------------------------------------------------------
// One message, once, through the machine
// ---------------------------------------------------------------------------

test('a message Meta delivers twice is answered once', async () => {
  const db = setup();
  const payload = text('menu', { id: 'wamid.same' });
  await post(payload);
  const first = net.sent().length;
  assert.ok(first >= 1);
  await post(payload);
  assert.equal(net.sent().length, first, 'the retry was claimed already');
  assert.equal(db._tables.processed_whatsapp_messages.length, 1);
  assert.equal(db._tables.processed_whatsapp_messages[0].status, 'processed');
});

test('"menu" runs the state machine and comes back as reply buttons with short titles', async () => {
  const db = setup();
  await post(text('menu'));

  const last = net.sent().at(-1);
  assert.equal(last.type, 'interactive');
  assert.equal(last.interactive.type, 'button');
  assert.equal(last.to, WA_ID);
  const ids = last.interactive.action.buttons.map((b) => b.reply.id);
  assert.deepEqual(ids, ['menu:book', 'menu:track', 'menu:contact']);
  for (const b of last.interactive.action.buttons) assert.ok(b.reply.title.length <= 20);

  // Read and "typing…" in one call, on the message we answered.
  const read = net.calls.find((c) => c.json?.status === 'read');
  assert.ok(read);
  assert.deepEqual(read.json.typing_indicator, { type: 'text' });

  // The window is stamped, the conversation is logged both ways.
  const session = db._tables.conversation_sessions.find((s) => s.id === `whatsapp:${CHAT}`);
  assert.ok(session.last_client_message_at);
  const log = db._tables.chat_messages;
  assert.ok(log.some((m) => m.direction === 'in' && m.body === 'menu' && m.author === 'client'));
  assert.ok(log.some((m) => m.direction === 'out' && m.author === 'bot' && m.kind === 'buttons'));
});

test('a new client is asked their language, and the answer to the tap is drawn in it', async () => {
  const db = setup({ client: null });
  await post(text('hi'));
  const question = net.sent().at(-1);
  assert.equal(question.type, 'interactive');
  assert.deepEqual(question.interactive.action.buttons.map((b) => b.reply.id), ['lang:en', 'lang:ar']);

  net.reset();
  await post(inbound([{ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'lang:ar', title: 'العربية' } } }]));
  const client = db._tables.clients.find((c) => c.whatsapp_id === WA_ID);
  assert.equal(client.language, 'ar', 'the choice is kept on the client');
  const answer = net.sent().at(-1);
  const titles = answer.interactive.action.buttons.map((b) => b.reply.title);
  assert.ok(titles.every((t) => /[؀-ۿ]/.test(t)), `Arabic titles straight after choosing: ${titles}`);
  assert.doesNotMatch(answer.interactive.body.text, /[A-Za-z]{4,} [A-Za-z]{4,}/, 'no English sentence');
});

test('a tapped reply button and a chosen list row arrive as the engine\'s callbacks', async () => {
  const db = setup();
  await post(inbound([{ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'menu:track', title: 'Track' } } }]));
  let session = db._tables.conversation_sessions.find((s) => s.id === `whatsapp:${CHAT}`);
  assert.equal(session.current_state, S.TRACK_IDENTIFIER);

  await post(inbound([{ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'menu:home', title: 'Menu' } } }]));
  session = db._tables.conversation_sessions.find((s) => s.id === `whatsapp:${CHAT}`);
  assert.equal(session.current_state, S.MAIN_MENU);
});

test('a new number becomes a client, with its WhatsApp number as the phone on file', async () => {
  const db = setup({ client: null });
  await post(inbound([{ type: 'text', text: { body: 'menu' } }], { waId: '201112223334', name: 'Nile Motors' }));
  const client = db._tables.clients.find((c) => c.whatsapp_id === '201112223334');
  assert.ok(client);
  assert.equal(client.phone, '+201112223334');
  assert.equal(client.whatsapp_name, 'Nile Motors');

  const { phoneOnFile } = await import('../lib/clients.js');
  assert.equal(await phoneOnFile({ chatId: 'wa:201112223334', clientId: client.id }), '+201112223334');
  assert.equal(await phoneOnFile({ chatId: 'wa:209998887776' }), '+209998887776', 'the chat itself is the number');
  assert.equal(await phoneOnFile({ chatId: '555' }), null, 'a Telegram chat id is never a phone');
});

test('voice notes, stickers, videos and locations get a polite answer and the menu; reactions get nothing', async () => {
  const db = setup();
  for (const type of ['audio', 'sticker', 'video', 'location', 'unsupported']) {
    net.reset();
    await post(inbound([{ type, [type]: {} }]));
    const [answer] = net.sent();
    assert.match(answer.interactive.body.text, /I can read text, PDFs and photos/, type);
    assert.equal(answer.interactive.action.buttons[0].reply.id, 'menu:book');
  }

  net.reset();
  const claims = db._tables.processed_whatsapp_messages.length;
  await post(inbound([{ type: 'reaction', reaction: { message_id: 'wamid.x', emoji: '👍' } }]));
  assert.equal(net.sent().length, 0);
  assert.equal(db._tables.processed_whatsapp_messages.length, claims, 'a reaction is not even claimed');
});

test('a blocked client gets one message and nothing else happens', async () => {
  const db = setup({ client: { is_blocked: true } });
  await post(text('menu'));
  assert.deepEqual(bodies(), [M.blocked()]);
  assert.equal(db._tables.conversation_sessions.find((s) => s.id === `whatsapp:${CHAT}`)?.current_state ?? 'MAIN_MENU', 'MAIN_MENU');
});

test('"reset" clears our side, says the chat itself stays, and keeps the window open', async () => {
  const db = setup({ seed: { bookings: [{ booking_ref: 'MKY-BKG-D1', chat_id: CHAT, status: 'draft', channel: 'whatsapp' }] } });
  await post(text('reset'));
  const said = bodies();
  assert.match(said[0], /cleared our side/);
  assert.match(said[0], /dropped 1 unconfirmed booking/);
  assert.match(said[0], /WhatsApp does not let us delete messages/);
  assert.equal(db._tables.bookings.length, 0, 'the draft is gone');
  assert.ok(db._tables.conversation_sessions.find((s) => s.id === `whatsapp:${CHAT}`)?.last_client_message_at);
  assert.equal(net.telegram('deleteMessages').length, 0, 'no Telegram sweep for a WhatsApp chat');
});

// ---------------------------------------------------------------------------
// The client's language, for everything said this turn
// ---------------------------------------------------------------------------

test('everything said in a turn - including outside the machine - is in the client\'s language', async () => {
  setup({ client: { language: 'ar' } });
  await post(inbound([{ type: 'audio', audio: { id: 'a1' } }]));
  const [answer] = net.sent();
  assert.equal(answer.interactive.body.text, withLanguage('ar', () => whatsapp.T.unsupported()));
  assert.doesNotMatch(answer.interactive.body.text, /I can read/);

  // The machine's own messages follow the same language once lib/flow speaks
  // one at a time; until then they are bilingual, as before.
  setup({ client: { language: 'ar', is_blocked: true } });
  net.reset();
  await post(text('menu'));
  assert.deepEqual(bodies(), [withLanguage('ar', () => M.blocked())]);
});

// ---------------------------------------------------------------------------
// STOP, START, floods
// ---------------------------------------------------------------------------

test('STOP is recorded and confirmed once; START undoes it and shows the menu', async () => {
  const db = setup();
  await post(text('STOP'));
  const client = db._tables.clients.find((c) => c.id === 7);
  assert.ok(client.opted_out_at);
  assert.equal(net.sent().length, 1);
  assert.match(bodies()[0], /will not message you again/);

  net.reset();
  await post(text('stop'));
  assert.equal(net.sent().length, 0, 'a second STOP is not confirmed again');

  net.reset();
  await post(text('START'));
  assert.equal(client.opted_out_at, null);
  // One message: "welcome back" and the menu together. The live test got two
  // - two notifications - for one word.
  assert.equal(net.sent().length, 1, JSON.stringify(bodies()));
  assert.match(bodies()[0], /Welcome back/);
  assert.match(bodies()[0], /How can we help you today/);
  assert.equal(net.sent().at(-1).interactive.action.buttons[0].reply.id, 'menu:book');
});

test('a flood is cut off with one "slow down" and the rest ignored', async () => {
  const now = new Date().toISOString();
  const db = setup({
    seed: {
      processed_whatsapp_messages: Array.from({ length: 20 }, (_, i) => ({
        message_id: `wamid.flood.${i}`, chat_id: CHAT, status: 'processed', created_at: now, processed_at: now,
      })),
    },
  });
  await post(inbound([{ type: 'text', text: { body: 'menu' } }, { type: 'text', text: { body: 'menu' } }]));
  assert.equal(net.sent().length, 1, 'one reply for two messages over the limit');
  assert.match(bodies()[0], /lot of messages/);
  const ignored = db._tables.processed_whatsapp_messages.filter((r) => r.status === 'ignored');
  assert.equal(ignored.length, 2);
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const INVOICE = readFileSync(path.join(WEB, 'data', 'takeA-invoice.pdf'));
const CMR = readFileSync(path.join(WEB, 'data', 'takeA-cmr-transport.pdf'));

function offerMedia(id, buffer, { mime = 'application/pdf', urls = null } = {}) {
  const list = urls ?? [`https://media.test/${id}`];
  net.media.set(id, list.map((url) => ({ url, mime_type: mime, file_size: buffer.length, sha256: `sha-${id}` })));
  return list;
}

test('two papers sent together are each read, and answered once', async () => {
  const db = setup();
  for (const [id, buffer] of [['m-inv', INVOICE], ['m-cmr', CMR]]) {
    const [url] = offerMedia(id, buffer);
    net.files.set(url, { status: 200, buffer });
  }
  await post(inbound([
    { type: 'document', document: { id: 'm-inv', filename: 'invoice.pdf', mime_type: 'application/pdf', sha256: 'sha-m-inv' } },
    { type: 'document', document: { id: 'm-cmr', filename: 'cmr.pdf', mime_type: 'application/pdf', sha256: 'sha-m-cmr' } },
  ]));

  const docs = db._tables.booking_documents;
  assert.equal(docs.length, 2);
  for (const d of docs) {
    assert.equal(d.channel, 'whatsapp');
    assert.equal(d.chat_id, CHAT);
    assert.equal(d.extracted.pending, false, 'read, not stuck "still reading"');
    assert.match(d.whatsapp_media_sha256, /^sha-/);
  }
  const downloads = net.calls.filter((c) => c.host === 'media.test');
  assert.equal(downloads.length, 2);
  for (const d of downloads) assert.equal(d.headers.authorization, 'Bearer wa-token', 'media needs the token');

  const replies = net.sent();
  assert.equal(replies.length, 1, `one answer for the batch, got: ${JSON.stringify(bodies())}`);
});

// The live test, 2026-10-08: the customer's own MRN export declaration was
// read, and the booking's mrn_number stayed empty.
const MRN_PAPER = readFileSync(path.join(WEB, 'data', 'takeA-mrn-export-declaration.pdf'));
const MRN_CHASSIS = 'WMA06XZZ8KM745219';
const MRN_ON_PAPER = '26LTVR375677905219';

test('the MRN read from the customer\'s own export declaration goes on a booking that has none', async () => {
  const draft = (extra = {}) => ({
    booking_ref: 'MKY-BKG-M1', chat_id: CHAT, client_id: 7, channel: 'whatsapp', status: 'draft', vin: MRN_CHASSIS,
    make: 'MAN', customer_name: 'Nile Motors', origin_port: 'Vilnius', destination_port: 'Port Said', mrn_choice: 'existing', ...extra,
  });
  const session = { id: `whatsapp:${CHAT}`, channel: 'whatsapp', chat_id: CHAT, client_id: 7, active_flow: 'booking', current_state: S.BOOK_DOCUMENTS, active_booking_ref: 'MKY-BKG-M1', context: {} };
  const send = async (db) => {
    net.model = '{"doc_type":"mrn"}';
    const [url] = offerMedia('m-mrn', MRN_PAPER);
    net.files.set(url, { status: 200, buffer: MRN_PAPER });
    await post(inbound([{ type: 'document', document: { id: 'm-mrn', filename: 'mrn.pdf', mime_type: 'application/pdf', sha256: 'sha-m-mrn' } }]));
    return db._tables.bookings.find((b) => b.booking_ref === 'MKY-BKG-M1');
  };

  let db = setup({ seed: { bookings: [draft()], conversation_sessions: [{ ...session }] } });
  assert.equal((await send(db)).mrn_number, MRN_ON_PAPER);

  // One already recorded is kept.
  db = setup({ seed: { bookings: [draft({ mrn_number: '26DEE2E0000000001' })], conversation_sessions: [{ ...session }] } });
  assert.equal((await send(db)).mrn_number, '26DEE2E0000000001');

  // A paper for another chassis gives this booking nothing.
  db = setup({ seed: { bookings: [draft({ vin: 'YV2RT40A8FB712905' })], conversation_sessions: [{ ...session }] } });
  assert.ok(!(await send(db)).mrn_number);
});

test('a media link that has expired is asked for again, once', async () => {
  const db = setup();
  offerMedia('m-old', INVOICE, { urls: ['https://media.test/expired', 'https://media.test/fresh'] });
  net.files.set('https://media.test/expired', { status: 404 });
  net.files.set('https://media.test/fresh', { status: 200, buffer: INVOICE });

  await post(inbound([{ type: 'document', document: { id: 'm-old', filename: 'invoice.pdf', mime_type: 'application/pdf' } }]));

  const asked = net.calls.filter((c) => c.host === 'graph.facebook.com' && c.method === 'GET' && c.path.endsWith('/m-old'));
  assert.equal(asked.length, 2, 'once to record it, once more after the 404');
  assert.deepEqual(net.calls.filter((c) => c.host === 'media.test').map((c) => c.path), ['/expired', '/fresh']);
  assert.equal(db._tables.booking_documents[0].extracted.pending, false);
});

test('a file that cannot be fetched at all is reported politely, not left reading', async () => {
  const db = setup();
  offerMedia('m-gone', INVOICE, { urls: ['https://media.test/gone1', 'https://media.test/gone2'] });
  net.files.set('https://media.test/gone1', { status: 404 });
  net.files.set('https://media.test/gone2', { status: 404 });

  await post(inbound([{ type: 'document', document: { id: 'm-gone', filename: 'invoice.pdf', mime_type: 'application/pdf' } }]));
  assert.deepEqual(bodies(), [withLanguage('en', () => M.documentSaveFailed())], 'in the client\'s language');
  assert.equal(db._tables.booking_documents[0].extracted.pending, false);
});

test('a file of the wrong type or size is refused before anything is downloaded', async () => {
  setup();
  await post(inbound([{ type: 'document', document: { id: 'm-zip', filename: 'x.zip', mime_type: 'application/zip' } }]));
  assert.match(bodies()[0], /application\/zip/);
  assert.equal(net.calls.filter((c) => c.method === 'GET' && c.host === 'graph.facebook.com').length, 0, 'not even asked about');

  net.reset();
  net.media.set('m-big', { url: 'https://media.test/big', mime_type: 'application/pdf', file_size: 50 * 1048576 });
  await post(inbound([{ type: 'document', document: { id: 'm-big', filename: 'big.pdf', mime_type: 'application/pdf' } }]));
  assert.equal(bodies()[0], withLanguage('en', () => M.documentTooBig(20)));
  assert.equal(net.calls.filter((c) => c.host === 'media.test').length, 0, 'never downloaded');
});

test('a photo is a document too, read by the model', async () => {
  const db = setup();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
  const [url] = offerMedia('m-photo', jpeg, { mime: 'image/jpeg' });
  net.files.set(url, { status: 200, buffer: jpeg });
  net.model = 'COMMERCIAL INVOICE No. 4471';

  await post(inbound([{ type: 'image', image: { id: 'm-photo', mime_type: 'image/jpeg', caption: '' } }]));
  const [doc] = db._tables.booking_documents;
  assert.match(doc.file_name, /^photo-.*\.jpg$/);
  assert.equal(doc.mime_type, 'image/jpeg');
  assert.equal(doc.extracted.pending, false);
  assert.equal(doc.extracted.read_via, 'vision');
});

// ---------------------------------------------------------------------------
// Delivery receipts
// ---------------------------------------------------------------------------

test('receipts mark the chat log and the outbox row delivered, read or failed', async () => {
  const db = setup({
    seed: {
      chat_messages: [
        { channel: 'whatsapp', chat_id: CHAT, direction: 'out', author: 'system', provider_message_id: 'wamid.out.A', status: 'sent' },
        { channel: 'whatsapp', chat_id: CHAT, direction: 'out', author: 'bot', provider_message_id: 'wamid.out.B', status: 'sent' },
      ],
      notification_outbox: [{
        id: 50, channel: 'whatsapp', chat_id: CHAT, event_type: 'booking_confirmed', status: 'sent', attempt_count: 1,
        idempotency_key: 'k', payload: {}, provider_message_id: 'wamid.out.A', delivery_status: 'sent', available_at: new Date().toISOString(),
      }],
    },
  });

  await post(receipts([{ id: 'wamid.out.A', status: 'delivered' }, { id: 'wamid.out.B', status: 'read' }]));
  await post(receipts([{ id: 'wamid.out.A', status: 'read' }]));
  const [a, b] = db._tables.chat_messages;
  assert.equal(a.status, 'read');
  assert.equal(b.status, 'read');
  assert.equal(db._tables.notification_outbox[0].delivery_status, 'read');

  await post(receipts([{
    id: 'wamid.out.B', status: 'failed',
    errors: [{ code: 131026, title: 'Message undeliverable', error_data: { details: 'Not on WhatsApp' } }],
  }]));
  assert.equal(b.status, 'read', 'a read message does not go back to failed');
  assert.equal(net.sent().length, 0, 'receipts are never answered');
});

// ---------------------------------------------------------------------------
// Before the migration
// ---------------------------------------------------------------------------

test('before the migration WhatsApp still answers, de-duplicating in memory', async () => {
  const db = setup({
    client: null,
    strict: {
      columns: MIGRATION_COLUMNS,
      tables: ['chat_messages', 'processed_whatsapp_messages'],
      rpcs: ['claim_whatsapp_message'],
    },
  });
  const payload = text('menu', { id: 'wamid.premigration' });
  await post(payload);
  const first = net.sent().length;
  assert.ok(first >= 1, 'answered without a client row, a claim table or a chat log');
  await post(payload);
  assert.equal(net.sent().length, first, 'the retry was recognised by this instance');
  assert.equal(db._tables.chat_messages, undefined);
});

// ---------------------------------------------------------------------------
// The Telegram transport, now language-aware and logged
// ---------------------------------------------------------------------------

async function telegram(update) {
  const res = mockRes();
  await telegramHandler({
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' }, query: {}, body: update,
  }, res);
  await settle(20_000);
  return res;
}

const tgMessage = (textBody, id = 101) => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: { message_id: id, chat: { id: 555 }, from: { id: 999, first_name: 'Arif' }, text: textBody },
});

test('Telegram /reset says exactly what it always said to a client who never chose a language', async () => {
  setup({ client: null, seed: { clients: [{ id: 1, telegram_user_id: 999, telegram_chat_id: 555 }] } });
  await telegram(tgMessage('/reset'));
  const [first] = net.telegram('sendMessage');
  const legacy = splitLanguages(
    'تمام، مسحت المحادثة ورسايلها. حجوزاتك المؤكدة وشحناتك زي ما هي. '
    + 'الرسايل الأقدم من يومين بتفضل ظاهرة - تليجرام مبيسمحش للبوت يمسحها. |'
    + 'Done - cleared our conversation and the messages above. Your confirmed bookings '
    + 'and shipments are untouched. Anything older than two days stays visible - Telegram does '
    + 'not let a bot delete it.',
  );
  assert.equal(first.text, legacy);
  assert.deepEqual(first.reply_markup, { remove_keyboard: true });
});

test('a Telegram turn runs in the client\'s language and is logged both ways', async () => {
  const db = setup({ client: null, seed: { clients: [{ id: 1, telegram_user_id: 999, telegram_chat_id: 555, language: 'ar' }] } });
  await telegram(tgMessage('/reset', 202));
  const [first] = net.telegram('sendMessage');
  assert.match(first.text, /^تمام، مسحت المحادثة/);
  assert.doesNotMatch(first.text, /Done - cleared/, 'Arabic only');

  const log = db._tables.chat_messages;
  assert.ok(log.some((m) => m.channel === 'telegram' && m.direction === 'in' && m.provider_message_id === '555:202'));
  assert.ok(log.some((m) => m.channel === 'telegram' && m.direction === 'out' && /^555:\d+$/.test(m.provider_message_id)));
});

test('Telegram is sent the buttons it always knew - the WhatsApp title stays out of them', async () => {
  setup({ client: null, seed: { clients: [{ id: 1, telegram_user_id: 999, telegram_chat_id: 555, language: 'en' }] } });
  await telegram(tgMessage('/menu', 303));
  const sent = net.telegram('sendMessage');
  const kb = await import('../lib/flow/keyboards.js');
  const expected = withLanguage('en', () => kb.mainMenu())
    .map((row) => row.map((b) => ({ text: b.text, callback_data: b.callback_data })));
  assert.deepEqual(sent.at(-1).reply_markup, { inline_keyboard: expected });
  assert.equal(sent.at(-1).chat_id, 555);
});

// ---------------------------------------------------------------------------
// /api/status folded into /api/health, and the function cap
// ---------------------------------------------------------------------------

test('/api/status still answers, through the rewrite, on server.js', async () => {
  setup({ seed: { bookings: [{ booking_ref: 'MKY-BKG-S1', chat_id: 'web-session-1', status: 'pending_review', origin_port: 'Koper', destination_port: 'Suez Port' }] } });
  const routes = await loadRoutes(path.join(WEB, 'api'));
  const rewrites = loadRewrites(path.join(WEB, 'vercel.json'));
  const server = http.createServer(createApp({ routes, rewrites, publicDir: path.join(WEB, 'public'), logger: { log() {}, error() {} } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const status = await realFetch(`${base}/api/status?sessionId=web-session-1`);
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.count, 1);
  assert.equal(body.items[0].ref, 'MKY-BKG-S1');
  assert.equal(status.headers.get('cache-control'), 'no-store');

  const missing = await realFetch(`${base}/api/status`);
  assert.equal(missing.status, 400);
  await new Promise((resolve) => server.close(resolve));
});

test('/api/health reports WhatsApp settings and whether its migration is applied', async () => {
  setup();
  const res = mockRes();
  await healthHandler({ method: 'GET', headers: {}, query: {} }, res);
  assert.equal(res.body.whatsapp.status, 'configured');
  assert.equal(res.body.whatsapp.app_secret, true);
  assert.match(res.body.whatsapp.token_check, /not checked/);
  assert.equal(res.body.whatsapp.schema.migration, 'ok');
  assert.equal(net.calls.filter((c) => c.host === 'graph.facebook.com').length, 0, 'Meta is not called by default');

  const deep = mockRes();
  await healthHandler({ method: 'GET', headers: {}, query: { deep: '1' } }, deep);
  assert.equal(deep.body.whatsapp.token_check, 'ok');

  setup({ strict: { columns: MIGRATION_COLUMNS, tables: ['chat_messages', 'processed_whatsapp_messages'], rpcs: ['claim_whatsapp_message'] } });
  const before = mockRes();
  await healthHandler({ method: 'GET', headers: {}, query: {} }, before);
  assert.match(before.body.whatsapp.schema.migration, /^20261007090000 not applied/);
});

// ---------------------------------------------------------------------------
// Answering what the desk asked
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const agoIso = (ms) => new Date(Date.now() - ms).toISOString();
const modelCalls = () => net.calls.filter((c) => c.host === 'api.openai.com').length;

/** A booking the desk handed back to the customer an hour ago, asking for something. */
const WAITING_BOOKING = {
  booking_ref: 'MKY-BKG-ASK1', status: 'needs_client_action', channel: 'whatsapp', chat_id: CHAT, client_id: 7,
  customer_name: 'Delta Trans', vin: 'YV2RT40A8FB712905', make: 'Volvo', origin_port: 'Klaipeda', destination_port: 'Port Said',
  needs_client_action: { requested: 'The exporter\'s full address', at: agoIso(HOUR), by: 'Sara' },
  created_at: agoIso(5 * HOUR),
};

test('a WhatsApp answer to "ask for information" is kept on the booking, which goes back to the desk', async () => {
  const db = setup({ seed: { bookings: [{ ...WAITING_BOOKING }] } });
  await post(text('Baltic Trucks UAB, Savanoriu 12, Vilnius'));

  const booking = db._tables.bookings[0];
  assert.equal(booking.status, 'under_review', 'back with the desk - "Needs us"');
  assert.ok(booking.client_responded_at);
  assert.equal(booking.needs_client_action.requested, 'The exporter\'s full address', 'what was asked stays beside it');
  assert.equal(booking.needs_client_action.answers.at(-1).text, 'Baltic Trucks UAB, Savanoriu 12, Vilnius');
  assert.ok((db._tables.operations_tasks ?? []).some((t) => t.task_type === 'client_action_response' && t.booking_ref === 'MKY-BKG-ASK1'));

  const said = bodies();
  assert.equal(said.length, 1);
  assert.match(said[0], /MKY-BKG-ASK1/);
  assert.match(said[0], /passed it on/i);
  assert.doesNotMatch(said[0], /[؀-ۿ]/, 'in English, the language they chose');
  assert.equal(modelCalls(), 0, 'not handed to the assistant as a fresh chat');
});

test('a second message moments later is more of the same answer, not a fresh question for the assistant', async () => {
  const db = setup({ seed: { bookings: [{ ...WAITING_BOOKING }] } });
  await post(text('Baltic Trucks UAB'));
  net.reset();
  await post(text('Savanoriu 12, Vilnius, Lithuania'));

  const answers = db._tables.bookings[0].needs_client_action.answers;
  assert.deepEqual(answers.map((a) => a.text), ['Baltic Trucks UAB', 'Savanoriu 12, Vilnius, Lithuania']);
  assert.match(bodies()[0], /added/i);
  assert.equal(modelCalls(), 0);
});

test('a document sent for an MRN application is recorded on it, and the customer hears so in their language', async () => {
  const db = setup({
    client: { language: 'ar' },
    seed: {
      bookings: [{ ...WAITING_BOOKING, booking_ref: 'MKY-BKG-M1', status: 'under_review', mrn_choice: 'mky_issue', needs_client_action: null }],
      mrn_requests: [{
        id: 41, request_ref: 'MKY-MRN-41', booking_ref: 'MKY-BKG-M1', chat_id: CHAT, client_id: 7, status: 'missing_information',
        missing_information: ['The export invoice'], supplied_information: {}, updated_at: agoIso(HOUR), created_at: agoIso(3 * HOUR),
      }],
    },
  });
  const [url] = offerMedia('m-ans', INVOICE);
  net.files.set(url, { status: 200, buffer: INVOICE });
  await post(inbound([{ type: 'document', document: { id: 'm-ans', filename: 'export-invoice.pdf', mime_type: 'application/pdf', sha256: 'sha-m-ans' } }]));

  const mrn = db._tables.mrn_requests[0];
  assert.equal(mrn.status, 'under_review', 'no longer "Waiting for the customer"');
  assert.match(mrn.supplied_information.notes.at(-1).text, /export-invoice\.pdf/);
  assert.equal(db._tables.booking_documents[0].booking_ref, 'MKY-BKG-M1', 'the file itself is on the booking');

  const said = bodies();
  assert.equal(said.length, 1, `one answer: ${JSON.stringify(said)}`);
  assert.match(said[0], /MKY-MRN-41/);
  assert.match(said[0], /[؀-ۿ]/);
  assert.doesNotMatch(said[0], /passed/i, 'Arabic only');
});

test('on Telegram the answer is kept the same way, and the customer is told it was passed on', async () => {
  const db = setup({
    client: null,
    seed: {
      clients: [{ id: 1, telegram_user_id: 999, telegram_chat_id: 555, language: 'en' }],
      bookings: [{ ...WAITING_BOOKING, channel: 'telegram', chat_id: '555', client_id: 1 }],
    },
  });
  await telegram(tgMessage('The exporter is Baltic Trucks UAB, Vilnius.', 404));

  const booking = db._tables.bookings[0];
  assert.equal(booking.status, 'under_review');
  assert.match(booking.needs_client_action.answers.at(-1).text, /Baltic Trucks/);
  const sent = net.telegram('sendMessage').at(-1);
  assert.match(sent.text, /MKY-BKG-ASK1/);
  assert.match(sent.text, /passed it on/i);
  assert.equal(modelCalls(), 0);
});

// ---------------------------------------------------------------------------
// The number we give out
// ---------------------------------------------------------------------------

/** The instructions the assistant was given for its last answer. */
const lastPrompt = () => net.calls.filter((c) => c.host === 'api.openai.com').at(-1)?.json?.messages?.[0]?.content ?? '';

test('with no number configured, the assistant is never handed the example number - it is told to give none', async () => {
  setup();
  await post(text('How long does customs clearance take at Port Said?'));
  const prompt = lastPrompt();
  assert.ok(prompt, 'the assistant answered this one');
  assert.doesNotMatch(prompt, /555 ?0143/, 'the .env.example illustration is not a phone number');
  assert.match(prompt, /no phone number has been set/i);
});

test('the number set in the desk\'s Settings is the one the assistant gives', async () => {
  const db = setup();
  db._tables.bot_settings.find((s) => s.key === 'operations_phone').value = '+20 3 111 2222';
  invalidateSettings();
  await post(text('How long does customs clearance take at Port Said?'));
  assert.match(lastPrompt(), /\+20 3 111 2222/);
});

test('the booking PDF prints the desk number from Settings, and no number at all when none is set', async () => {
  const { bookingConfirmationPdf } = await import('../lib/pdf.js');
  const { pdfText } = await import('../lib/read-file.js');
  const booking = {
    booking_ref: 'MKY-BKG-PDF1', status: 'pending_review', channel: 'whatsapp', customer_name: 'Delta Trans',
    vin: 'YV2RT40A8FB712905', make: 'Volvo', origin_port: 'Klaipeda', destination_port: 'Port Said',
  };

  const db = setup();
  const bare = await pdfText(await bookingConfirmationPdf(booking, { lang: 'en' }));
  assert.match(bare, /MKY-BKG-PDF1/, 'the text layer is readable');
  assert.doesNotMatch(bare, /555 ?0143/);

  db._tables.bot_settings.find((s) => s.key === 'operations_phone').value = '+20 3 111 2222';
  invalidateSettings();
  const set = await pdfText(await bookingConfirmationPdf(booking, { lang: 'en' }));
  assert.match(set, /\+20 3 111 2222/);
});

test('the project stays within Vercel Hobby\'s twelve functions', () => {
  const count = (dir) => readdirSync(dir).reduce((n, name) => {
    if (/^[_.]/.test(name)) return n;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return n + count(full);
    return n + (name.endsWith('.js') ? 1 : 0);
  }, 0);
  const functions = count(path.join(WEB, 'api'));
  assert.ok(functions <= 12, `api/ has ${functions} functions; the Hobby plan allows 12`);
});

test('one reply is as few WhatsApp messages as it fits in: plain steps fold into what follows', async () => {
  const { coalesce } = await import('../api/whatsapp.js');
  const ask = { text: 'What is the make?', inline: [[{ text: 'Main menu', callback_data: 'menu:home', title: 'Main menu' }]] };

  // "unit is new", "still need…", "what is the make?" - one buzz, not three.
  const out = coalesce([{ text: 'This unit is new.' }, { text: 'We still need the make.' }, ask]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'This unit is new.\n\nWe still need the make.\n\nWhat is the make?');
  assert.deepEqual(out[0].inline, ask.inline);

  // Over an interactive body's 1024 characters: left apart, so the buttons
  // keep their own question rather than a generic prompt.
  assert.equal(coalesce([{ text: 'x'.repeat(1010) }, ask]).length, 2);
  assert.equal(coalesce([{ text: 'x'.repeat(1000) }, ask]).length, 1, '1019 characters still fit');

  // A file is never folded into; plain messages alone become one.
  assert.equal(coalesce([{ text: 'Here it is' }, { text: '', document: { buffer: Buffer.from('x') } }]).length, 2);
  assert.deepEqual(coalesce([{ text: 'a' }, { text: 'b' }]), [{ text: 'a\n\nb' }]);
  assert.deepEqual(coalesce([]), []);
});

// ---------------------------------------------------------------------------
// A slow database must not hold the reply (live test, 2026-10-08: one session
// write hung 17 s, one window stamp 6 s, and the customer waited for both)
// ---------------------------------------------------------------------------

const tap = (id, title, extra = {}) => inbound([{ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } }, ...extra }]);

/** Starts a webhook without waiting for the work behind it. */
async function postNoWait(payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  const res = mockRes();
  await handler(serverReq(raw, { 'x-hub-signature-256': sign(raw, SECRET) }), res);
  return res;
}

const sessionOf = (db, chat = CHAT) => db._tables.conversation_sessions?.find((s) => s.id === `whatsapp:${chat}`);

test('a slow session write does not hold the reply, and the message is done only once the write lands', async () => {
  const db = setup();
  const held = gateCalls(db, (table, q) => table === 'conversation_sessions' && q.op === 'upsert');
  try {
    await postNoWait(tap('menu:track', 'Track', { id: 'wamid.slowsave' }));
    const replied = await waitUntil(() => bodies().some((b) => /VIN \/ Chassis number or Booking Reference/.test(b)));
    assert.ok(replied, `the reply went out while the session write was still held; sent: ${JSON.stringify(bodies())}`);
    assert.equal(held.waiting, 1, 'the write is the one being held');
    const claim = db._tables.processed_whatsapp_messages.find((r) => r.message_id === 'wamid.slowsave');
    assert.equal(claim.status, 'processing', 'not done while the state the next message reads is still being written');
    assert.notEqual(sessionOf(db)?.current_state, S.TRACK_IDENTIFIER);
  } finally {
    held.release();
  }
  await settle(20_000);
  assert.equal(db._tables.processed_whatsapp_messages.find((r) => r.message_id === 'wamid.slowsave').status, 'processed');
  assert.equal(sessionOf(db).current_state, S.TRACK_IDENTIFIER);
});

test('a slow window stamp does not hold the reply; the outbox still waits for it', async () => {
  const db = setup();
  const held = gateCalls(db, (table, q) => table === 'conversation_sessions' && q.op === 'update'
    && Object.hasOwn(q.payload ?? {}, 'last_client_message_at'));
  try {
    await postNoWait(text('menu', { id: 'wamid.slowstamp' }));
    const replied = await waitUntil(() => net.sent().some((m) => m.interactive?.action?.buttons?.[0]?.reply?.id === 'menu:book'));
    assert.ok(replied, 'the menu went out while the stamp was still held');
    const claim = db._tables.processed_whatsapp_messages.find((r) => r.message_id === 'wamid.slowstamp');
    assert.equal(claim.status, 'processing', 'the drain, and so the claim, wait for the stamp');
  } finally {
    held.release();
  }
  await settle(20_000);
  assert.equal(db._tables.processed_whatsapp_messages.find((r) => r.message_id === 'wamid.slowstamp').status, 'processed');
  assert.ok(sessionOf(db).last_client_message_at, 'and the window was stamped');
});

test('two quick messages are still answered in order while the first one\'s write is slow', async () => {
  const db = setup();
  gateCalls(db, (table, q) => table === 'conversation_sessions' && q.op === 'upsert', { delayMs: 400, times: 1 });
  await postNoWait(tap('menu:track', 'Track', { id: 'wamid.order1' }));
  await sleep(30);
  await postNoWait(text('MKY-BKG-000000-ZZZZ', { id: 'wamid.order2' }));
  await settle(20_000);
  const said = bodies();
  assert.match(said.at(-1), /could not find a shipment/, `the reference was read as the answer to "which shipment?": ${JSON.stringify(said)}`);
  assert.equal(said.length, 2);
  const claims = db._tables.processed_whatsapp_messages;
  assert.ok(claims.every((r) => r.status === 'processed'));
});

test('a database call that never answers is given up on, and the customer still gets a reply', async () => {
  const db = setup();
  // The write fails the way the deadline fails it, twice: the reply has
  // already gone, the failure is logged, and the message is still finished.
  const timedOut = { data: null, error: { message: 'AbortError: database call timed out after 4500 ms (POST conversation_sessions)', code: '' } };
  let attempts = 0;
  const from = db.from.bind(db);
  db.from = (name) => {
    const q = from(name);
    const run = q.run.bind(q);
    q.run = async () => (name === 'conversation_sessions' && q.op === 'upsert' ? (attempts++, timedOut) : run());
    return q;
  };
  await post(tap('menu:track', 'Track', { id: 'wamid.deadline' }));
  assert.ok(bodies().some((b) => /VIN \/ Chassis number/.test(b)));
  assert.equal(attempts, 2, 'a timed-out upsert is tried once more, and only once');
  assert.equal(db._tables.processed_whatsapp_messages.find((r) => r.message_id === 'wamid.deadline').status, 'processed');
});

test('on Telegram too, the reply goes out before the session write lands, and the update is answered after it', async () => {
  const db = setup({ client: null, seed: { clients: [{ id: 1, telegram_user_id: 999, telegram_chat_id: 555, language: 'en' }] } });
  const held = gateCalls(db, (table, q) => table === 'conversation_sessions' && q.op === 'upsert');
  const res = mockRes();
  const update = tgMessage('/menu', 404);
  let answered = false;
  const handling = telegramHandler({
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' }, query: {}, body: update,
  }, res).then(() => { answered = true; });
  try {
    const replied = await waitUntil(() => net.telegram('sendMessage').length > 0);
    assert.ok(replied, 'the menu went out while the write was held');
    assert.equal(answered, false, 'Telegram is not answered - and sends nothing more for this chat - until the write lands');
    const claim = db._tables.processed_updates.find((r) => String(r.update_id) === String(update.update_id));
    assert.equal(claim.status, 'processing');
  } finally {
    held.release();
  }
  await handling;
  await settle(20_000);
  assert.equal(res.body?.ok, true);
  assert.equal(db._tables.processed_updates.find((r) => String(r.update_id) === String(update.update_id)).status, 'processed');
  assert.equal(db._tables.conversation_sessions.find((s) => s.id === 'telegram:555').current_state, S.MAIN_MENU);
});
