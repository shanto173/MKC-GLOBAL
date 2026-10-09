/**
 * Files in a conversation, both ways, end to end against the fake database, a
 * fake Supabase Storage, a fake Meta and a fake Telegram:
 *
 *   - what a customer sends that the bot does not read (a voice note, a video,
 *     a sticker, a Word file) is kept for the desk, or the desk is told why not;
 *   - every file message finds its stored copy - by WhatsApp media id or hash,
 *     by Telegram file id or message id, on a booking or on none - and the desk
 *     gets ten-minute links to it, a smaller copy for a big photo;
 *   - the desk sends papers and photos on the customer's channel: checked
 *     against what the channel takes and against their own bytes, once however
 *     often Send is pressed, refused outside the WhatsApp window and after
 *     STOP, logged with where the file is kept, and filed on the booking as an
 *     MKY document when asked;
 *   - a read-only member of the team can look at files and send none.
 *
 * lib/channels.js is the real one here (desk.test.mjs replaces it): these
 * tests are about what actually reaches Meta and Telegram.
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';
process.env.ADMIN_SECRET = 'desk-secret';
process.env.WHATSAPP_ACCESS_TOKEN = 'wa-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'PNID';
process.env.WHATSAPP_APP_SECRET = 'app-secret';
process.env.TELEGRAM_BOT_TOKEN = 'tg-token';
process.env.TELEGRAM_WEBHOOK_SECRET = 'tg-secret';
process.env.OPENAI_API_KEY ||= 'test';

const { createDeskDb, withViews } = await import('./helpers/desk-db.mjs');
const { fakeStorage } = await import('./helpers/fake-storage.mjs');
const { sign, mockRes, serverReq, inbound, withWhatsAppClaims } = await import('./helpers/whatsapp.mjs');
const { provideWaitUntil, settle } = await import('../server.js');
const { setClientForTests } = await import('../lib/supabase.js');
const { invalidateSettings } = await import('../lib/settings.js');
const { resetFlowReady } = await import('../lib/flow/ready.js');
const { resetLanguageSupportForTests } = await import('../lib/flow/language.js');
const { resetChannelsForTests } = await import('../lib/channels.js');
const { resetOutboxForTests } = await import('../lib/outbox.js');
const { resetChatlogForTests } = await import('../lib/chatlog.js');
const { resetClientsForTests } = await import('../lib/clients.js');
const { resetDocumentsForTests, bookingDocumentState } = await import('../lib/documents.js');
const { flush } = await import('../lib/background.js');
const { default: consoleApi } = await import('../lib/admin/console.js');
const whatsapp = await import('../api/whatsapp.js');
const { default: telegramHook } = await import('../api/telegram.js');
const {
  planOutbound, sniff, bytesMatch, outboundPath, isOutboundPathFor, CHAT_MEDIA_MAX_BYTES,
} = await import('../lib/chat-files.js');

provideWaitUntil();

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const MB = 1024 * 1024;
const WA_ID = '201005551234';
const WA = `wa:${WA_ID}`;
const CLOSED = 'wa:201009990000';
const STOPPED = 'wa:201007770000';
const TG = '555';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]), Buffer.alloc(64)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);

// ---------------------------------------------------------------------------
// Meta, Telegram and the files they serve - recorded, never reached
// ---------------------------------------------------------------------------

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let net;
function fakeNet() {
  const n = { calls: [], media: new Map(), files: new Map(), failWa: [], failTg: [], id: 1 };
  n.wa = () => n.calls.filter((c) => c.host === 'graph.facebook.com' && c.path.endsWith('/messages') && c.json?.type).map((c) => c.json);
  n.waUploads = () => n.calls.filter((c) => c.host === 'graph.facebook.com' && c.path.endsWith('/media'));
  n.tg = (method) => n.calls.filter((c) => c.host === 'api.telegram.org' && c.path.endsWith(`/${method}`));
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    let body = null;
    if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    const call = { host: url.host, path: url.pathname, method: init.method ?? 'GET', json: body, form: init.body instanceof FormData ? init.body : null };
    n.calls.push(call);
    if (url.host === 'graph.facebook.com') {
      if (call.method === 'POST' && url.pathname.endsWith('/media')) return json(200, { id: `media-${n.id++}` });
      if (call.method === 'POST' && url.pathname.endsWith('/messages')) {
        if (body?.status === 'read') return json(200, { success: true });
        const fail = n.failWa.shift();
        if (fail) return json(400, { error: { code: fail, message: 'refused' } });
        return json(200, { messages: [{ id: `wamid.out.${n.id++}` }] });
      }
      const id = decodeURIComponent(url.pathname.split('/').pop());
      if (n.media.has(id)) return json(200, { id, ...n.media.get(id) });
      return json(200, { verified_name: 'MKY' });
    }
    if (url.host === 'api.telegram.org') {
      if (url.pathname.startsWith('/file/')) {
        const f = n.files.get(url.pathname.split('/').pop());
        return f ? new Response(f, { status: 200 }) : new Response('gone', { status: 404 });
      }
      const method = url.pathname.split('/').pop();
      if (method === 'getFile') return json(200, { ok: true, result: { file_path: `voice/${body.file_id}.oga`, file_size: 4000 } });
      const fail = ['sendPhoto', 'sendDocument'].includes(method) ? n.failTg.shift() : null;
      if (fail) return json(400, { ok: false, error_code: 400, description: fail });
      return json(200, { ok: true, result: { message_id: n.id++ } });
    }
    if (n.files.has(String(input))) return new Response(n.files.get(String(input)), { status: 200 });
    if (url.host === 'api.openai.com') {
      if (n.aiDown) throw new TypeError('fetch failed');   // the reader's model unreachable
      return json(200, { choices: [{ message: { content: '{"doc_type":"other"}' } }] });
    }
    return json(404, { error: 'not mocked' });
  };
  return n;
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

function seed(extra = {}) {
  return withViews({
    ops_users: [
      { name: 'Ariful', role: 'admin', active: true },
      { name: 'Sara', role: 'ops_agent', active: true },
      { name: 'Rita', role: 'read_only', active: true },
    ],
    bot_settings: [
      { key: 'required_booking_documents', value: ['invoice', 'brief', 'mrn'] },
      { key: 'required_booking_documents_mky_mrn', value: ['invoice', 'brief'] },
      { key: 'required_mrn_documents', value: [] },
      { key: 'allowed_file_types', value: ['application/pdf', 'image/jpeg', 'image/png'] },
      { key: 'max_upload_bytes', value: 20 * MB },
      { key: 'whatsapp_window_hours', value: 24 },
      { key: 'whatsapp_templates', value: { _reopen: { name: 'mky_please_reply', params: [] } } },
    ],
    clients: [
      { id: 7, whatsapp_id: WA_ID, whatsapp_name: 'أحمد', phone: `+${WA_ID}`, language: 'ar', is_blocked: false },
      { id: 8, telegram_user_id: 99, telegram_chat_id: 555, display_name: 'Red Sea Haulage', language: 'en', is_blocked: false },
      { id: 9, whatsapp_id: '201007770000', whatsapp_name: 'Stopped', language: 'en', opted_out_at: iso(2 * 86400_000), is_blocked: false },
      { id: 10, whatsapp_id: '201009990000', whatsapp_name: 'Quiet', language: 'en', is_blocked: false },
    ],
    conversation_sessions: [
      { id: `whatsapp:${WA}`, channel: 'whatsapp', chat_id: WA, client_id: 7, current_state: 'MAIN_MENU', last_client_message_at: iso(3600_000), updated_at: iso(3600_000) },
      { id: `whatsapp:${CLOSED}`, channel: 'whatsapp', chat_id: CLOSED, client_id: 10, current_state: 'MAIN_MENU', last_client_message_at: iso(30 * 3600_000), updated_at: iso(30 * 3600_000) },
      { id: `whatsapp:${STOPPED}`, channel: 'whatsapp', chat_id: STOPPED, client_id: 9, current_state: 'MAIN_MENU', last_client_message_at: iso(3 * 86400_000), updated_at: iso(3 * 86400_000) },
      { id: `telegram:${TG}`, channel: 'telegram', chat_id: TG, client_id: 8, current_state: 'MAIN_MENU', updated_at: iso(3600_000) },
    ],
    bookings: [
      {
        booking_ref: 'MKY-BKG-F1', status: 'under_review', channel: 'whatsapp', chat_id: WA, client_id: 7, customer_name: 'Delta Nile', customer_contact: `+${WA_ID}`,
        vin: 'WDB9634031L764201', make: 'Mercedes-Benz', origin_port: 'Hamburg', destination_port: 'Port Said', mrn_choice: 'existing', priority: 'normal',
        created_at: iso(5 * 3600_000), edit_history: [],
      },
      {
        booking_ref: 'MKY-BKG-OTHER', status: 'under_review', channel: 'telegram', chat_id: TG, client_id: 8, customer_name: 'Red Sea Haulage', customer_contact: '+20 65',
        vin: 'WMA06XZZ0LM438865', make: 'MAN', origin_port: 'Antwerp', destination_port: 'Alexandria Port (incl. El Dekheila)', mrn_choice: 'existing', priority: 'normal',
        created_at: iso(5 * 3600_000), edit_history: [],
      },
    ],
    booking_documents: [], chat_messages: [], notification_outbox: [], audit_logs: [],
    ...extra,
  });
}

let db;
let storage;
function setup(extra = {}, files = {}) {
  db = withWhatsAppClaims(createDeskDb(seed(extra)));
  storage = fakeStorage(files);
  db.storage = storage;
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
beforeEach(() => { net = fakeNet(); setup(); });

const rows = (name) => (db._tables[name] ??= []);

async function call({ method = 'GET', query = {}, body, operator = 'Ariful' }) {
  const req = {
    method,
    query: { resource: 'console', ...(method === 'GET' ? { operator } : {}), ...query },
    headers: { 'x-admin-secret': 'desk-secret' },
    body: method === 'POST' ? { operator, ...body } : undefined,
  };
  let status = 200;
  let payload;
  const res = { status(c) { status = c; return this; }, json(p) { payload = p; return this; }, setHeader() { return this; } };
  await consoleApi(req, res);
  await flush();
  return { status, body: payload };
}
const view = (query, operator) => call({ query, operator });
const act = (body, operator) => call({ method: 'POST', body, operator });

/** The desk's two steps for one file: ask where, and put it there. */
async function uploaded(target, name, bytes, mime, key = `k-${Math.random().toString(36).slice(2, 8)}`, operator = 'Ariful') {
  const r = await act({ action: 'chat_upload', ...target, file_name: name, mime_type: mime, size: bytes.length, action_key: key }, operator);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  storage.put(r.body.upload_url, bytes, mime);
  return { path: r.body.path, file_name: name, mime_type: mime };
}

/** A signed WhatsApp webhook, as server.js hands it over, with its background work waited for. */
async function webhook(payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  const res = mockRes();
  await whatsapp.default(serverReq(raw, { 'x-hub-signature-256': sign(raw, 'app-secret') }), res);
  await settle(20_000);
  await flush();
  return res;
}

async function telegram(message) {
  const res = mockRes();
  await telegramHook({
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' }, query: {},
    body: { update_id: Math.floor(Math.random() * 1e9), message: { message_id: 7000 + Math.floor(Math.random() * 999), chat: { id: 555 }, from: { id: 99, first_name: 'Red' }, date: 1, ...message } },
  }, res);
  await settle(20_000);
  await flush();
  return res;
}

// ---------------------------------------------------------------------------
// What a channel takes
// ---------------------------------------------------------------------------

test('each channel takes what Meta and Telegram take, and says why not in words', () => {
  assert.deepEqual(planOutbound({ channel: 'whatsapp', mimeType: 'image/jpeg', size: 4 * MB, fileName: 'truck.jpg' }), { ok: true, kind: 'image', mime: 'image/jpeg', ext: 'jpg' });
  const bigPhoto = planOutbound({ channel: 'whatsapp', mimeType: 'image/jpeg', size: 6 * MB, fileName: 'truck.jpg' });
  assert.equal(bigPhoto.ok, false);
  assert.match(bigPhoto.words, /photos of up to 5 MB; truck\.jpg is 6 MB/);
  assert.equal(planOutbound({ channel: 'telegram', mimeType: 'image/jpeg', size: 12 * MB, fileName: 'truck.jpg' }).kind, 'document', 'Telegram takes a big photo as a file');
  assert.equal(planOutbound({ channel: 'whatsapp', mimeType: '', size: 3 * MB, fileName: 'Quote.DOCX' }).mime,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a type from the extension when the browser gave none');
  assert.equal(planOutbound({ channel: 'telegram', mimeType: 'application/pdf', size: 51 * MB, fileName: 'x.pdf' }).reason, 'size');
  assert.match(planOutbound({ channel: 'whatsapp', mimeType: 'application/zip', size: 10, fileName: 'x.zip' }).words, /A \.zip file cannot be sent/);
  assert.equal(planOutbound({ channel: 'whatsapp', mimeType: 'application/pdf', size: 0, fileName: 'x.pdf' }).reason, 'empty');
});

test('a file is held to its own bytes, and its storage path is safe and this customer\'s', () => {
  assert.equal(sniff(PDF), 'pdf');
  assert.equal(sniff(JPEG), 'jpeg');
  assert.equal(sniff(PNG), 'png');
  assert.equal(sniff(DOCX), 'zip');
  assert.ok(bytesMatch('docx', DOCX));
  assert.ok(!bytesMatch('pdf', PNG), 'a picture renamed .pdf is not a PDF');

  const path = outboundPath({ clientId: 7, chatId: WA, key: 'abc', fileName: 'تأكيد-الحجز.png', ext: 'png' });
  assert.match(path, /^7\/outbound\/abc-[\w.-]+\.png$/, 'Arabic letters do not reach the path, the type does');
  assert.ok(isOutboundPathFor(path, { clientId: 7, chatId: WA }));
  assert.ok(!isOutboundPathFor('8/outbound/abc-x.pdf', { clientId: 7, chatId: WA }), 'another customer\'s file');
  assert.ok(!isOutboundPathFor('7/MKY-BKG-F1/invoice.pdf', { clientId: 7, chatId: WA }), 'a customer\'s own paper is not something the desk uploaded');
  assert.ok(!isOutboundPathFor('7/outbound/../8/x.pdf', { clientId: 7, chatId: WA }));
});

// ---------------------------------------------------------------------------
// In: what customers send
// ---------------------------------------------------------------------------

test('a WhatsApp voice note is kept for the desk to play, and the customer still hears what the bot can read', async () => {
  net.media.set('aud-1', { url: 'https://media.test/aud-1', mime_type: 'audio/ogg; codecs=opus', file_size: 9000, sha256: 'h1' });
  net.files.set('https://media.test/aud-1', Buffer.from('OggS voice'));
  await webhook(inbound([{ id: 'wamid.voice1', type: 'audio', audio: { id: 'aud-1', mime_type: 'audio/ogg; codecs=opus', voice: true } }]));

  const logged = rows('chat_messages').find((m) => m.provider_message_id === 'wamid.voice1');
  assert.equal(logged.kind, 'audio');
  assert.equal(logged.payload.voice, true);
  assert.match(logged.payload.storage_path, /^7\/chat-media\/.+\.ogg$/);
  assert.equal(storage.objects.get(logged.payload.storage_path).buffer.toString(), 'OggS voice');
  assert.ok(net.wa().some((m) => /I can read text/.test(m.text?.body ?? m.interactive?.body?.text ?? '')
    || /أقدر أقرا/.test(m.text?.body ?? m.interactive?.body?.text ?? '')), 'the bot says what it can read');

  const chat = await view({ view: 'chat', channel: 'whatsapp', chat_id: WA });
  const m = chat.body.messages.find((x) => x.id === logged.id);
  assert.equal(m.file.kind, 'audio');
  assert.equal(m.file.voice, true);
  assert.equal(m.file.ref, `msg:${logged.id}`);
  const links = await view({ view: 'chat_files', refs: m.file.ref, variant: 'full' }, 'Rita');
  assert.equal(links.status, 200, 'a read-only member of the team can listen');
  assert.match(links.body.files[m.file.ref].url, /^https:\/\/storage\.test\/sign\//);
});

test('a video too big to keep is not downloaded, and an archive is not even asked about - both say why', async () => {
  net.media.set('vid-1', { url: 'https://media.test/vid-1', mime_type: 'video/mp4', file_size: CHAT_MEDIA_MAX_BYTES + 1 });
  await webhook(inbound([
    { id: 'wamid.vid1', type: 'video', video: { id: 'vid-1', mime_type: 'video/mp4', caption: 'Walk-around' } },
    { id: 'wamid.zip1', type: 'document', document: { id: 'zip-1', filename: 'papers.zip', mime_type: 'application/zip' } },
  ]));
  assert.equal(net.calls.filter((c) => c.host === 'media.test').length, 0, 'nothing downloaded');
  assert.ok(!net.calls.some((c) => c.method === 'GET' && c.path.endsWith('/zip-1')), 'the archive is not looked up');

  const chat = await view({ view: 'chat', channel: 'whatsapp', chat_id: WA });
  const video = chat.body.messages.find((x) => x.kind === 'video');
  assert.equal(video.file.stored, false);
  assert.match(video.file.missing, /Not kept: .*more than the 16 MB the desk keeps/);
  assert.equal(video.body, 'Walk-around');
  const zip = chat.body.messages.find((x) => x.kind === 'document');
  assert.match(zip.file.missing, /not this kind of file/);
});

test('on Telegram a voice note is kept and answered; an animated sticker is not fetched', async () => {
  net.files.set('tgv-1.oga', Buffer.from('OggS tg'));
  await telegram({ message_id: 501, voice: { file_id: 'tgv-1', file_unique_id: 'U1', duration: 4, mime_type: 'audio/ogg', file_size: 4000 } });
  await telegram({ message_id: 502, sticker: { file_id: 'st-1', file_unique_id: 'S1', emoji: '👍', is_animated: true } });

  const voice = rows('chat_messages').find((m) => m.provider_message_id === `${TG}:501`);
  assert.equal(voice.kind, 'audio');
  assert.equal(voice.payload.duration, 4);
  assert.match(voice.payload.storage_path, /^8\/chat-media\//);
  const sticker = rows('chat_messages').find((m) => m.provider_message_id === `${TG}:502`);
  assert.equal(sticker.kind, 'sticker');
  assert.equal(sticker.payload.not_stored, 'not_kept');
  assert.equal(net.calls.filter((c) => c.json?.file_id === 'st-1').length, 0, 'the sticker is not fetched');
  // Before, a voice note on Telegram got silence.
  assert.ok(net.tg('sendMessage').some((c) => /I can read text/.test(c.json?.text ?? '')));
});

test('every file message finds its stored copy: by media id, by hash after a re-send, by Telegram message id, on no booking', async () => {
  setup({
    booking_documents: [
      // WhatsApp: the same paper sent twice - the row carries the second media id, the hash finds the first message.
      { id: 31, booking_ref: 'MKY-BKG-F1', chat_id: WA, channel: 'whatsapp', doc_type: 'invoice', status: 'received', file_name: 'فاتورة.pdf', mime_type: 'application/pdf', size_bytes: 4000,
        storage_path: '7/MKY-BKG-F1/u-invoice.pdf', whatsapp_media_id: 'm-second', whatsapp_media_sha256: 'same-bytes', extraction_ok: true, extracted: { ok: true }, uploaded_at: iso(60_000) },
      // A photo with no booking open, in unfiled/.
      { id: 32, booking_ref: null, chat_id: WA, channel: 'whatsapp', doc_type: 'other', status: 'received', file_name: 'photo-abcdef123456.jpg', mime_type: 'image/jpeg', size_bytes: 5 * MB,
        storage_path: '7/unfiled/u-photo.jpg', whatsapp_media_id: 'wamid-abcdef123456', extracted: { ok: false }, uploaded_at: iso(50_000) },
      // A download that failed: on file, nothing stored.
      { id: 33, booking_ref: 'MKY-BKG-F1', chat_id: WA, channel: 'whatsapp', doc_type: 'other', status: 'received', file_name: 'EORI.pdf', mime_type: 'application/pdf',
        storage_path: null, whatsapp_media_id: 'm-gone', extracted: { pending: false, ok: false, message: 'download failed: HTTP 404' }, uploaded_at: iso(40_000) },
      // Telegram, logged before files carried ids: found by the message id.
      { id: 34, booking_ref: 'MKY-BKG-OTHER', chat_id: TG, channel: 'telegram', doc_type: 'other', status: 'received', file_name: 'photo-AgAD.jpg', mime_type: 'image/jpeg', size_bytes: 3000,
        storage_path: '8/MKY-BKG-OTHER/u-photo.jpg', telegram_message_id: 501, extracted: { ok: false }, uploaded_at: iso(30_000) },
    ],
    chat_messages: [
      { id: 1, channel: 'whatsapp', chat_id: WA, client_id: 7, direction: 'in', author: 'client', kind: 'document', body: 'الفاتورة', status: 'received', created_at: iso(70_000),
        payload: { file_name: 'فاتورة.pdf', media_id: 'm-first', sha256: 'same-bytes' } },
      { id: 2, channel: 'whatsapp', chat_id: WA, client_id: 7, direction: 'in', author: 'client', kind: 'image', body: null, status: 'received', created_at: iso(50_000),
        payload: { mime_type: 'image/jpeg', media_id: 'wamid-abcdef123456' } },
      { id: 3, channel: 'whatsapp', chat_id: WA, client_id: 7, direction: 'in', author: 'client', kind: 'document', body: null, status: 'received', created_at: iso(40_000),
        payload: { file_name: 'EORI.pdf', media_id: 'm-gone' } },
      { id: 4, channel: 'whatsapp', chat_id: WA, client_id: 7, direction: 'in', author: 'client', kind: 'location', body: 'Gate 3', status: 'received', created_at: iso(30_000),
        payload: { latitude: 51.9497, longitude: 4.0516, name: 'Gate 3', address: 'Europaweg 875' } },
      { id: 5, channel: 'telegram', chat_id: TG, client_id: 8, direction: 'in', author: 'client', kind: 'image', body: 'Loaded', status: 'received', created_at: iso(30_000), provider_message_id: `${TG}:501` },
    ],
  }, { '7/MKY-BKG-F1/u-invoice.pdf': { buffer: PDF, mime: 'application/pdf' }, '8/MKY-BKG-OTHER/u-photo.jpg': { buffer: JPEG, mime: 'image/jpeg' } });

  const wa = (await view({ view: 'chat', channel: 'whatsapp', chat_id: WA })).body.messages;
  const byId = (id) => wa.find((m) => m.id === id);
  assert.equal(byId(1).file.ref, 'doc:31', 'the first copy of a re-sent paper still opens');
  assert.equal(byId(1).file.paper.label, 'Invoice');
  assert.equal(byId(1).file.paper.status_words, 'Received — not verified yet');
  assert.equal(byId(1).file.kind, 'pdf');
  assert.equal(byId(2).file.ref, 'doc:32', 'a photo logged before names were');
  assert.equal(byId(2).file.paper.booking_ref, null);
  assert.equal(byId(2).file.thumb, true, 'a 5 MB photo is shown through a smaller copy');
  assert.equal(byId(3).file.stored, false);
  assert.match(byId(3).file.missing, /WhatsApp would not hand the file over/);
  assert.match(byId(4).location.map_url, /google\.com\/maps.*51\.949700,4\.051600/);
  const tg = (await view({ view: 'chat', channel: 'telegram', chat_id: TG })).body.messages;
  assert.equal(tg.find((m) => m.id === 5).file.ref, 'doc:34');

  // The photo is missing from storage: said so, not a broken image.
  const links = await view({ view: 'chat_files', refs: 'doc:31,doc:32,doc:34' });
  assert.match(links.body.files['doc:31'].url, /u-invoice\.pdf/);
  assert.equal(links.body.files['doc:32'].error, 'The file is missing from storage.');
  assert.ok(links.body.expires_at);
});

test('a photo the reader could not read is still kept, and the desk shows it', async () => {
  net.aiDown = true;
  net.media.set('img-down', { url: 'https://media.test/img-down', mime_type: 'image/jpeg', file_size: JPEG.length, sha256: 'pd' });
  net.files.set('https://media.test/img-down', JPEG);
  await webhook(inbound([{ id: 'wamid.photo-down', type: 'image', image: { id: 'img-down', mime_type: 'image/jpeg', sha256: 'pd' } }]));

  const doc = rows('booking_documents').find((d) => d.whatsapp_media_id === 'img-down');
  assert.ok(doc, 'the paper row is there');
  assert.equal(doc.extracted.pending, false, 'no longer "still reading"');
  assert.ok(doc.storage_path, 'and it says where the bytes are');
  assert.equal(storage.objects.get(doc.storage_path).buffer.length, JPEG.length);
  const chat = await view({ view: 'chat', channel: 'whatsapp', chat_id: WA });
  const m = chat.body.messages.find((x) => x.kind === 'image' && x.direction === 'in');
  assert.equal(m.file.ref, `doc:${doc.id}`, 'the operator can open it');
  assert.equal(m.file.stored, true);
});

test('a big photo is shown through a smaller copy, made once and kept', async () => {
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(1600, 1200);
  canvas.getContext('2d').fillRect(0, 0, 800, 600);
  const big = canvas.toBuffer('image/jpeg', 90);
  setup({
    booking_documents: [{ id: 41, booking_ref: null, chat_id: WA, channel: 'whatsapp', doc_type: 'other', status: 'received', file_name: 'p.jpg', mime_type: 'image/jpeg',
      size_bytes: 6 * MB, storage_path: '7/unfiled/p.jpg', extracted: { ok: false }, uploaded_at: iso(1000) }],
  }, { '7/unfiled/p.jpg': { buffer: big, mime: 'image/jpeg' } });

  const first = await view({ view: 'chat_files', refs: 'doc:41' });
  assert.equal(first.body.files['doc:41'].thumb, true);
  assert.match(first.body.files['doc:41'].url, /thumbs%2F/);
  const thumbPath = [...storage.objects.keys()].find((p) => p.startsWith('thumbs/'));
  assert.ok(thumbPath, 'the smaller copy is kept');
  const { loadImage } = await import('@napi-rs/canvas');
  assert.equal((await loadImage(storage.objects.get(thumbPath).buffer)).width, 640);

  const downloads = storage.calls.download.length;
  await view({ view: 'chat_files', refs: 'doc:41' });
  assert.equal(storage.calls.download.length, downloads, 'not made twice');
  const full = await view({ view: 'chat_files', refs: 'doc:41', variant: 'full' });
  assert.match(full.body.files['doc:41'].url, /unfiled%2Fp\.jpg/, 'the full photo on request');
});

// ---------------------------------------------------------------------------
// Out: the desk sends files
// ---------------------------------------------------------------------------

test('an upload address is handed out only for a file the channel takes, while a message could go', async () => {
  const ok = await act({ action: 'chat_upload', channel: 'whatsapp', chat_id: WA, file_name: 'quote.pdf', mime_type: 'application/pdf', size: PDF.length, action_key: 'upload-key-1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.path, '7/outbound/upload-key-1-quote.pdf');
  assert.match(ok.body.upload_url, /^https:\/\/storage\.test\/upload\/sign\//);
  assert.equal(ok.body.kind, 'document');
  const again = await act({ action: 'chat_upload', channel: 'whatsapp', chat_id: WA, file_name: 'quote.pdf', mime_type: 'application/pdf', size: PDF.length, action_key: 'upload-key-1' });
  assert.equal(again.body.path, ok.body.path, 'a retried upload goes to the same place');

  const big = await act({ action: 'chat_upload', channel: 'whatsapp', chat_id: WA, file_name: 'truck.jpg', mime_type: 'image/jpeg', size: 6 * MB, action_key: 'upload-key-2' });
  assert.equal(big.status, 400);
  assert.match(big.body.error, /photos of up to 5 MB/);
  const exe = await act({ action: 'chat_upload', channel: 'telegram', chat_id: TG, file_name: 'tool.exe', mime_type: 'application/x-msdownload', size: 100, action_key: 'upload-key-3' });
  assert.equal(exe.status, 400);

  const closed = await act({ action: 'chat_upload', channel: 'whatsapp', chat_id: CLOSED, file_name: 'q.pdf', mime_type: 'application/pdf', size: 10, action_key: 'upload-key-4' });
  assert.equal(closed.status, 409);
  assert.equal(closed.body.status, 'needs_template');
  assert.equal(closed.body.composer.mode, 'template_only', 'the screen is told to offer the template instead');
  const stopped = await act({ action: 'chat_upload', channel: 'whatsapp', chat_id: STOPPED, file_name: 'q.pdf', mime_type: 'application/pdf', size: 10, action_key: 'upload-key-5' });
  assert.equal(stopped.status, 409);
  assert.match(stopped.body.error, /wrote STOP/);

  const ro = await act({ action: 'chat_upload', channel: 'whatsapp', chat_id: WA, file_name: 'q.pdf', mime_type: 'application/pdf', size: 10, action_key: 'upload-key-6' }, 'Rita');
  assert.equal(ro.status, 403);
  assert.equal(storage.calls.signedUpload.length, 2, 'only the allowed requests (the first, and its retry) got an address');
});

test('a photo and a paper go to WhatsApp as a photo and a document, Arabic name and caption intact, logged with where they are kept', async () => {
  const photo = await uploaded({ channel: 'whatsapp', chat_id: WA }, 'شاحنة.jpg', JPEG, 'image/jpeg');
  const paper = await uploaded({ channel: 'whatsapp', chat_id: WA }, 'عرض-السعر.pdf', PDF, 'application/pdf');
  const r = await act({ action: 'send_files', channel: 'whatsapp', chat_id: WA, files: [photo, paper], caption: 'دي صورة الشاحنة وعرض السعر', action_key: 'batch1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sent, 2);

  const [first, second] = net.wa();
  assert.equal(first.type, 'image');
  assert.equal(first.image.caption, 'دي صورة الشاحنة وعرض السعر', 'the words go with the first file');
  assert.equal(second.type, 'document');
  assert.equal(second.document.filename, 'عرض-السعر.pdf');
  assert.equal(second.document.caption, undefined, 'and only the first');
  assert.equal(net.waUploads().length, 2, 'both uploaded to Meta first');

  const logged = rows('chat_messages').filter((m) => m.direction === 'out');
  assert.deepEqual(logged.map((m) => m.kind), ['image', 'document']);
  assert.equal(logged[0].author, 'staff');
  assert.equal(logged[0].staff_name, 'Ariful');
  assert.equal(logged[0].payload.storage_path, photo.path);
  assert.equal(logged[0].payload.outbound, true);
  assert.equal(logged[1].payload.file_name, 'عرض-السعر.pdf');

  const chat = await view({ view: 'chat', channel: 'whatsapp', chat_id: WA });
  const shown = chat.body.messages.filter((m) => m.direction === 'out');
  assert.equal(shown[0].file.kind, 'image');
  assert.equal(shown[1].file.kind, 'pdf');
  assert.equal(shown[1].file.ref, `msg:${logged[1].id}`);
  assert.ok(rows('audit_logs').some((a) => a.action === 'client_file_sent' && Number(a.metadata.files) === 2));
});

test('a paper too big to push through one request is given to WhatsApp as a link it fetches', async () => {
  const big = Buffer.concat([PDF, Buffer.alloc(17 * MB, 0x20)]);
  const paper = await uploaded({ channel: 'whatsapp', chat_id: WA }, 'scan.pdf', big, 'application/pdf');
  const r = await act({ action: 'send_files', channel: 'whatsapp', chat_id: WA, files: [paper], caption: 'The scan', action_key: 'big-link-1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [sent] = net.wa();
  assert.equal(sent.type, 'document');
  assert.match(sent.document.link, /^https:\/\/storage\.test\/sign\/.+expires=3600$/, 'a signed link that lasts an hour');
  assert.equal(sent.document.filename, 'scan.pdf');
  assert.equal(sent.document.caption, 'The scan');
  assert.equal(net.waUploads().length, 0, 'not uploaded to Meta');
});

test('Send pressed twice sends each file once', async () => {
  const paper = await uploaded({ channel: 'whatsapp', chat_id: WA }, 'quote.pdf', PDF, 'application/pdf');
  const body = { action: 'send_files', channel: 'whatsapp', chat_id: WA, files: [paper], caption: 'Quote', action_key: 'same-key' };
  const [a, b] = await Promise.all([act(body), act(body)]);
  assert.equal(net.wa().length, 1, 'one message reached Meta');
  assert.ok([a, b].every((r) => r.status === 200));
  assert.ok([a, b].some((r) => r.body.results[0].duplicate), 'the second press is recognised');
  const third = await act(body);
  assert.equal(third.body.results[0].duplicate, true);
  assert.equal(net.wa().length, 1);
});

test('a file that is not what it says, not this customer\'s, or never uploaded is refused before anything is sent', async () => {
  const fake = await uploaded({ channel: 'whatsapp', chat_id: WA }, 'invoice.pdf', PNG, 'application/pdf');
  const r1 = await act({ action: 'send_files', channel: 'whatsapp', chat_id: WA, files: [fake], action_key: 'b1' });
  assert.equal(r1.body.results[0].ok, false);
  assert.match(r1.body.results[0].words, /is not really a PDF file/);

  storage.objects.set('8/outbound/x-their.pdf', { buffer: PDF, mime: 'application/pdf' });
  const r2 = await act({ action: 'send_files', channel: 'whatsapp', chat_id: WA, files: [{ path: '8/outbound/x-their.pdf', file_name: 'their.pdf', mime_type: 'application/pdf' }], action_key: 'b2' });
  assert.match(r2.body.results[0].words, /was not uploaded for this conversation/);

  const r3 = await act({ action: 'send_files', channel: 'whatsapp', chat_id: WA, files: [{ path: '7/outbound/nothing-here.pdf', file_name: 'x.pdf', mime_type: 'application/pdf' }], action_key: 'b3' });
  assert.match(r3.body.results[0].words, /did not finish uploading/);
  assert.equal(net.wa().length, 0, 'nothing reached the customer');
});

test('a file filed on the booking becomes an MKY document - apart from the customer\'s papers, never one they owe', async () => {
  const quote = await uploaded({ booking_ref: 'MKY-BKG-F1' }, 'MKY-quote.pdf', PDF, 'application/pdf');
  const r = await act({ action: 'send_files', booking_ref: 'MKY-BKG-F1', files: [quote], caption: 'Our quote', file_on_booking: true, action_key: 'q1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.filed_on, 'MKY-BKG-F1');

  const doc = rows('booking_documents').find((d) => d.doc_type === 'mky');
  assert.ok(doc);
  assert.equal(doc.booking_ref, 'MKY-BKG-F1');
  assert.equal(doc.chat_id, null, 'not one of the chat\'s papers');
  assert.equal(doc.status, 'verified');
  assert.equal(doc.storage_path, quote.path);
  assert.equal(rows('chat_messages').find((m) => m.direction === 'out').payload.document_id, doc.id, 'the message points at it');

  const kase = await view({ view: 'case', type: 'booking', ref: 'MKY-BKG-F1' });
  assert.deepEqual(kase.body.mky_documents.map((d) => d.id), [doc.id]);
  assert.match(kase.body.mky_documents[0].status_words, /^Sent by MKY · Ariful$/);
  assert.ok(!kase.body.other_documents.some((d) => d.id === doc.id));
  assert.ok(kase.body.checklist.every((c) => c.document_id !== doc.id));
  const state = await bookingDocumentState({ bookingRef: 'MKY-BKG-F1', chatId: WA });
  assert.ok(!state.received_types.includes('mky'), 'the bot never counts it as theirs');

  const elsewhere = await act({ action: 'send_files', channel: 'whatsapp', chat_id: WA, files: [quote], file_on_booking: 'MKY-BKG-OTHER', action_key: 'q2' });
  assert.equal(elsewhere.status, 400);
  assert.match(elsewhere.body.error, /not this customer’s booking/);
});

test('WhatsApp closing the window mid-send stops the rest; the failed file can be sent again once it is open', async () => {
  const a = await uploaded({ channel: 'whatsapp', chat_id: WA }, 'a.pdf', PDF, 'application/pdf');
  const b = await uploaded({ channel: 'whatsapp', chat_id: WA }, 'b.pdf', PDF, 'application/pdf');
  net.failWa.push(131047);
  const r = await act({ action: 'send_files', channel: 'whatsapp', chat_id: WA, files: [a, b], action_key: 'w1' });
  assert.equal(r.status, 409);
  assert.equal(r.body.status, 'needs_template');
  assert.equal(r.body.results[1].status, 'not_sent');
  assert.equal(net.wa().length, 1, 'the second was not tried');

  const failed = rows('chat_messages').find((m) => m.status === 'failed');
  assert.equal(failed.payload.storage_path, a.path, 'kept, so it can go again');
  const chat = await view({ view: 'chat', channel: 'whatsapp', chat_id: WA });
  assert.equal(chat.body.messages.find((m) => m.id === failed.id).retryable, true);

  const again = await act({ action: 'retry_message', message_id: failed.id, action_key: 'r1' });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(net.wa().length, 2);
  assert.equal(net.wa()[1].document.filename, 'a.pdf');
  assert.ok(rows('audit_logs').some((x) => x.action === 'message_retried' && x.entity_id === `message:${failed.id}`));
});

test('on Telegram a photo goes as a photo, a Word file as a document, and a photo Telegram refuses goes as a file', async () => {
  const photo = await uploaded({ channel: 'telegram', chat_id: TG }, 'truck.png', PNG, 'image/png');
  const word = await uploaded({ channel: 'telegram', chat_id: TG }, 'Booking.docx', DOCX, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const r = await act({ action: 'send_files', channel: 'telegram', chat_id: TG, files: [photo, word], caption: 'Loaded', action_key: 't1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [sentPhoto] = net.tg('sendPhoto');
  assert.equal(sentPhoto.form.get('caption'), 'Loaded');
  assert.equal(sentPhoto.form.get('photo').type, 'image/png');
  const [sentDoc] = net.tg('sendDocument');
  assert.equal(sentDoc.form.get('document').name, 'Booking.docx');
  assert.equal(sentDoc.form.get('document').type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const logged = rows('chat_messages').filter((m) => m.direction === 'out');
  assert.deepEqual(logged.map((m) => m.kind), ['image', 'document']);
  assert.match(logged[0].provider_message_id, /^555:\d+$/);

  net.failTg.push('Bad Request: PHOTO_INVALID_DIMENSIONS');
  const odd = await uploaded({ channel: 'telegram', chat_id: TG }, 'panorama.jpg', JPEG, 'image/jpeg');
  const r2 = await act({ action: 'send_files', channel: 'telegram', chat_id: TG, files: [odd], action_key: 't2' });
  assert.equal(r2.body.results[0].ok, true);
  assert.equal(net.tg('sendDocument').length, 2, 'sent as a file instead');
});

test('a read-only member of the team sends nothing; a long caption and too many files are refused in words', async () => {
  const paper = await uploaded({ channel: 'whatsapp', chat_id: WA }, 'q.pdf', PDF, 'application/pdf');
  const ro = await act({ action: 'send_files', channel: 'whatsapp', chat_id: WA, files: [paper], action_key: 'ro' }, 'Rita');
  assert.equal(ro.status, 403);
  assert.match(ro.body.error, /read only/);

  const long = await act({ action: 'send_files', channel: 'whatsapp', chat_id: WA, files: [paper], caption: 'x'.repeat(1025), action_key: 'lc' });
  assert.equal(long.status, 400);
  assert.match(long.body.error, /at most 1024 characters/);

  const many = await act({ action: 'send_files', channel: 'whatsapp', chat_id: WA, files: Array.from({ length: 11 }, () => paper), action_key: 'mf' });
  assert.equal(many.status, 400);
  assert.equal(net.wa().length, 0);
});

// ---------------------------------------------------------------------------
// Files and the desk's change signal (desk_activity, lib/admin/desk-live.js)
//
// An open conversation is fetched again only when its chat's version moves,
// and answers 304 - one pulse read, no papers read - while it does not. So
// every write that changes what a conversation shows of its files must move
// that version: the message, where its file was kept, the paper the bot made
// of it, the paper checked at the desk, a file the desk sent and the MKY
// document filed from it. And nothing that hands out a signed link or an
// upload address may ever be kept.
// ---------------------------------------------------------------------------

const { withActivity } = await import('./helpers/activity-db.mjs');
const { countCalls } = await import('./helpers/count-db.mjs');
const { scopesOf, chatKey } = await import('../public/desk/live.js');
const { resetLiveForTests } = await import('../lib/admin/desk-live.js');

/** call(), with the headers the desk sends and gets. */
async function callH({ method = 'GET', query = {}, body, operator = 'Ariful', headers = {} }) {
  const req = {
    method,
    query: { resource: 'console', ...(method === 'GET' ? { operator } : {}), ...query },
    headers: { 'x-admin-secret': 'desk-secret', ...headers },
    body: method === 'POST' ? { operator, ...body } : undefined,
  };
  let status = 200;
  let payload;
  const sent = {};
  const res = {
    status(c) { status = c; return this; },
    json(p) { payload = p; return this; },
    setHeader(k, v) { sent[String(k).toLowerCase()] = v; return this; },
    send(p) { payload = p; return this; },
    end() { return this; },
  };
  await consoleApi(req, res);
  await flush();
  return { status, body: payload, headers: sent };
}

/** The desk_activity triggers on this test's database; a key's version, as the pulse reads it. */
function live() {
  resetLiveForTests();
  const activity = withActivity(db);
  return { activity, version: (key) => activity.versions()[key] ?? 0 };
}

const WA_KEY = chatKey('whatsapp', WA);
const chatQ = { view: 'chat', channel: 'whatsapp', chat_id: WA };

test('a photo and a paper from the customer move their conversation; with nothing new it is one read and no papers', async () => {
  const { version } = live();
  const first = await callH({ query: chatQ });
  assert.equal(first.status, 200);
  assert.ok(first.headers.etag, 'tagged with the chat\'s version');

  const rec = countCalls(db);
  const same = await callH({ query: chatQ, headers: { 'if-none-match': first.headers.etag } });
  assert.equal(same.status, 304, 'nothing happened in the chat');
  assert.deepEqual(rec.calls.map((c) => c.table), ['desk_activity'], `one pulse read, nothing else:\n${rec.lines().join('\n')}`);

  net.media.set('img-1', { url: 'https://media.test/img-1', mime_type: 'image/jpeg', file_size: JPEG.length, sha256: 'p1' });
  net.files.set('https://media.test/img-1', JPEG);
  net.media.set('pdf-1', { url: 'https://media.test/pdf-1', mime_type: 'application/pdf', file_size: PDF.length, sha256: 'd1' });
  net.files.set('https://media.test/pdf-1', PDF);
  const was = version(WA_KEY);
  await webhook(inbound([
    { id: 'wamid.photo1', type: 'image', image: { id: 'img-1', mime_type: 'image/jpeg', sha256: 'p1', caption: 'The truck' } },
    { id: 'wamid.pdf1', type: 'document', document: { id: 'pdf-1', filename: 'invoice.pdf', mime_type: 'application/pdf', sha256: 'd1' } },
  ]));
  assert.ok(version(WA_KEY) > was, 'their conversation moved');
  const papers = rows('booking_documents').filter((d) => d.chat_id === WA);
  assert.equal(papers.length, 2, 'the bot kept both as papers');

  const after = await callH({ query: chatQ, headers: { 'if-none-match': first.headers.etag } });
  assert.equal(after.status, 200, 'an open conversation is fetched again on the next tick');
  const files = after.body.messages.filter((m) => m.direction === 'in' && m.file).map((m) => m.file);
  assert.deepEqual(files.map((f) => f.kind).sort(), ['image', 'pdf']);
  assert.ok(files.every((f) => /^doc:\d+$/.test(f.ref)), 'each linked to the paper it became');
  assert.ok(!JSON.stringify(after.body).includes('storage.test/'), 'what is kept under the ETag names files, never a signed link');

  // A colleague checks the paper: the chip beside the message says so.
  const pdf = papers.find((d) => d.file_name === 'invoice.pdf');
  const before = version(WA_KEY);
  await db.from('booking_documents').update({ status: 'verified', verified_by: 'Sara', verified_at: new Date().toISOString() }).eq('id', pdf.id);
  assert.ok(version(WA_KEY) > before, 'a paper checked moves the conversation it came in');
  const checked = await callH({ query: chatQ, headers: { 'if-none-match': after.headers.etag } });
  assert.equal(checked.status, 200);
  const chip = checked.body.messages.find((m) => m.file?.ref === `doc:${pdf.id}`).file.paper;
  assert.equal(chip.status_words, 'Verified by Sara');
});

test('a file the desk sends, and the MKY document filed from it, move the conversation and the case', async () => {
  const { version } = live();
  const quote = await uploaded({ booking_ref: 'MKY-BKG-F1' }, 'MKY-quote.pdf', PDF, 'application/pdf');
  const chatWas = version(WA_KEY);
  const caseWas = version('booking:MKY-BKG-F1');
  const r = await act({ action: 'send_files', booking_ref: 'MKY-BKG-F1', files: [quote], caption: 'Our quote', file_on_booking: true, action_key: 'live-q1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(version(WA_KEY) > chatWas, 'the conversation shows the file');
  assert.ok(version('booking:MKY-BKG-F1') > caseWas, 'the case lists it under "Sent by MKY"');

  // Filed with no chat on purpose; taking it off the case still changes the conversation's chip.
  const doc = rows('booking_documents').find((d) => d.doc_type === 'mky');
  assert.equal(doc.chat_id, null);
  const tagged = await callH({ query: chatQ });
  const before = version(WA_KEY);
  await db.from('booking_documents').update({ deleted_at: new Date().toISOString() }).eq('id', doc.id);
  assert.ok(version(WA_KEY) > before, 'an MKY document moves its booking\'s conversation');
  const now = await callH({ query: chatQ, headers: { 'if-none-match': tagged.headers.etag } });
  assert.equal(now.status, 200);
  assert.equal(now.body.messages.find((m) => m.direction === 'out' && m.file?.paper).file.paper.status_words, 'Removed from the case');
});

test('signed links and upload addresses are never kept: no ETag, never 304, no-store', async () => {
  live();
  assert.equal(scopesOf('chat_files', { refs: 'doc:1' }), null, 'not a view the desk polls');
  assert.equal(scopesOf('document_url', { id: 1 }), null);

  const upload = await callH({ method: 'POST', body: { action: 'chat_upload', channel: 'whatsapp', chat_id: WA, file_name: 'q.pdf', mime_type: 'application/pdf', size: PDF.length, action_key: 'nostore-1' } });
  assert.equal(upload.status, 200);
  assert.equal(upload.headers['cache-control'], 'no-store', 'an upload address');
  assert.equal(upload.headers.etag, undefined);
  storage.put(upload.body.upload_url, PDF, 'application/pdf');
  const sent = await callH({ method: 'POST', body: { action: 'send_files', channel: 'whatsapp', chat_id: WA, files: [{ path: upload.body.path, file_name: 'q.pdf', mime_type: 'application/pdf' }], action_key: 'nostore-2' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.headers['cache-control'], 'no-store');

  const msg = rows('chat_messages').find((m) => m.direction === 'out' && m.payload?.storage_path);
  for (const headers of [{}, { 'if-none-match': '*' }, { 'if-none-match': 'W/"anything"' }]) {
    const links = await callH({ query: { view: 'chat_files', refs: `msg:${msg.id}`, variant: 'full' }, headers });
    assert.equal(links.status, 200, 'always worked out afresh');
    assert.equal(links.headers.etag, undefined);
    assert.equal(links.headers['cache-control'], 'no-store');
    assert.match(links.body.files[`msg:${msg.id}`].url, /expires=600$/, 'ten minutes');
  }
  db._tables.booking_documents.push({ id: 900, booking_ref: 'MKY-BKG-F1', chat_id: WA, doc_type: 'invoice', status: 'received', storage_path: '7/MKY-BKG-F1/x.pdf', file_name: 'x.pdf', mime_type: 'application/pdf' });
  storage.objects.set('7/MKY-BKG-F1/x.pdf', { buffer: PDF, mime: 'application/pdf' });
  const docUrl = await callH({ query: { view: 'document_url', id: 900 }, headers: { 'if-none-match': '*' } });
  assert.equal(docUrl.status, 200);
  assert.equal(docUrl.headers.etag, undefined);
  assert.equal(docUrl.headers['cache-control'], 'no-store');
});

test('a conversation whose papers could not be read is shown, but never kept under its version', async () => {
  live();
  db._tables.chat_messages.push({ id: 801, channel: 'whatsapp', chat_id: WA, client_id: 7, direction: 'in', author: 'client', kind: 'document', body: null, status: 'received', created_at: iso(60_000), payload: { file_name: 'eori.pdf', media_id: 'm-801' } });
  db._tables.booking_documents.push({ id: 801, booking_ref: 'MKY-BKG-F1', chat_id: WA, channel: 'whatsapp', doc_type: 'other', status: 'received', file_name: 'eori.pdf', mime_type: 'application/pdf', storage_path: '7/MKY-BKG-F1/eori.pdf', whatsapp_media_id: 'm-801', uploaded_at: iso(60_000) });
  const from = db.from.bind(db);
  let failNext = true;
  db.from = (name) => {
    const q = from(name);
    if (name === 'booking_documents' && failNext) {
      failNext = false;
      q.run = async () => ({ data: null, error: { message: 'connection reset' } });
    }
    return q;
  };
  const broken = await callH({ query: chatQ });
  assert.equal(broken.status, 200);
  assert.equal(broken.body.partial, true);
  assert.equal(broken.headers.etag, undefined, 'nothing to vouch for it');
  assert.equal(broken.headers['cache-control'], 'no-store');
  assert.equal(broken.body.messages.find((m) => m.id === 801).file.ref, null, 'drawn without the paper');

  const whole = await callH({ query: chatQ });
  assert.equal(whole.body.partial, undefined);
  assert.ok(whole.headers.etag);
  assert.equal(whole.body.messages.find((m) => m.id === 801).file.ref, 'doc:801', 'and whole on the next ask');
});
