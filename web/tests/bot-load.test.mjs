/**
 * How many times one customer message goes to the database - on WhatsApp and
 * on Telegram - held to a budget (docs/SYSTEM-DESIGN-DB-LOAD.md).
 *
 * The turn's order and its once-only guarantees are tested where they live
 * (whatsapp.test.mjs: "two quick messages are still answered in order…",
 * "a message Meta delivers twice is answered once"); these say what the turn
 * costs, and that the reads it no longer makes are not quietly back.
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';
process.env.WHATSAPP_ACCESS_TOKEN = 'wa-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'PNID';
process.env.WHATSAPP_APP_SECRET = 'app-secret';
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
process.env.TELEGRAM_BOT_TOKEN = 'tg-token';
process.env.TELEGRAM_WEBHOOK_SECRET = 'tg-secret';
process.env.OPENAI_API_KEY ||= 'test';

const { createFakeDb } = await import('./helpers/fake-db.mjs');
const { fakeNetwork, sign, mockRes, serverReq, inbound, withWhatsAppClaims } = await import('./helpers/whatsapp.mjs');
const { countCalls } = await import('./helpers/count-db.mjs');
const { provideWaitUntil, settle } = await import('../server.js');
const { setClientForTests } = await import('../lib/supabase.js');
const { invalidateSettings } = await import('../lib/settings.js');
const { resetFlowReady } = await import('../lib/flow/ready.js');
const { resetLanguageSupportForTests } = await import('../lib/flow/language.js');
const { resetChannelsForTests } = await import('../lib/channels.js');
const { resetOutboxForTests } = await import('../lib/outbox.js');
const { resetChatlogForTests } = await import('../lib/chatlog.js');
const { resetClientsForTests } = await import('../lib/clients.js');
const whatsapp = await import('../api/whatsapp.js');
const telegram = (await import('../api/telegram.js')).default;

provideWaitUntil();

const WA_ID = '201005551234';
const CHAT = `wa:${WA_ID}`;
let net;
let db;

function setup(seed = {}) {
  net = fakeNetwork();
  db = withWhatsAppClaims(createFakeDb({
    bot_settings: [
      { key: 'required_booking_documents', value: ['invoice', 'brief', 'mrn'] },
      { key: 'whatsapp_window_hours', value: 24 },
    ],
    clients: [
      { id: 7, whatsapp_id: WA_ID, whatsapp_name: 'Ariful', phone: `+${WA_ID}`, is_blocked: false, language: 'en' },
      { id: 8, telegram_user_id: 999, telegram_chat_id: 555, language: 'en' },
    ],
    conversation_sessions: [
      { id: `whatsapp:${CHAT}`, channel: 'whatsapp', chat_id: CHAT, client_id: 7, current_state: 'MAIN_MENU', context: {}, language: 'en', last_client_message_at: new Date().toISOString() },
    ],
    ...seed,
  }));
  setClientForTests(db);
  invalidateSettings();
  resetFlowReady(true);
  resetLanguageSupportForTests();
  resetChannelsForTests();
  resetOutboxForTests();
  resetChatlogForTests();
  resetClientsForTests();
  whatsapp.resetWhatsappForTests();
}
beforeEach(() => setup());

async function wa(body, id) {
  const raw = Buffer.from(JSON.stringify(inbound([{ type: 'text', text: { body }, id }], { waId: WA_ID, name: 'Ariful' })));
  const res = mockRes();
  await whatsapp.default(serverReq(raw, { 'x-hub-signature-256': sign(raw, 'app-secret') }), res);
  await settle(20_000);
  return res;
}

async function tg(text, updateId) {
  const res = mockRes();
  await telegram({
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' }, query: {},
    body: { update_id: updateId, message: { message_id: updateId, chat: { id: 555 }, from: { id: 999, first_name: 'Arif' }, text } },
  }, res);
  await settle(20_000);
  return res;
}

test('a WhatsApp message from a customer we know is at most 11 round trips (it was 14)', async () => {
  await wa('menu', 'wamid.warm');   // a warm instance: settings and the schema are known
  const rec = countCalls(db);
  await wa('menu', 'wamid.one');
  assert.ok(net.sent().length >= 2, 'answered');
  assert.ok(rec.count <= 11, `${rec.count} calls:\n${rec.lines().join('\n')}`);
});

test('the flood check and the wait for an earlier message read the claims once between them', async () => {
  await wa('menu', 'wamid.a');
  const rec = countCalls(db);
  await wa('menu', 'wamid.b');
  const claimsReads = rec.calls.filter((c) => c.table === 'processed_whatsapp_messages' && c.op === 'select');
  assert.equal(claimsReads.length, 1, rec.lines().join('\n'));
});

test('a turn that queued nothing leaves the outbox alone for a minute; a held message is still sent the moment they write', async () => {
  await wa('menu', 'wamid.first');
  const quiet = countCalls(db);
  await wa('menu', 'wamid.second');
  assert.ok(!quiet.lines().some((l) => /^select notification_outbox/.test(l)), quiet.lines().join('\n'));

  // Something held for them until they wrote: released and sent in the same turn.
  db._tables.notification_outbox ??= [];
  db._tables.notification_outbox.push({
    id: 501, chat_id: CHAT, channel: 'whatsapp', client_id: 7, event_type: 'operations_message', entity_type: 'chat', entity_id: CHAT,
    payload: { text: 'Your booking is confirmed.' }, status: 'pending', delivery_status: 'needs_template', attempt_count: 0,
    idempotency_key: 'held-1', available_at: new Date(Date.now() + 6 * 3600_000).toISOString(), created_at: new Date().toISOString(),
  });
  await wa('hello again', 'wamid.third');
  const row = db._tables.notification_outbox.find((r) => r.id === 501);
  assert.equal(row.status, 'sent', 'released and drained in the turn that released it');
  assert.ok(row.provider_message_id, 'by WhatsApp');
});

test('a Telegram message from a customer we know is at most 9 round trips (it was 10)', async () => {
  await tg('/menu', 1001);
  const rec = countCalls(db);
  await tg('menu', 1002);
  assert.ok(rec.count <= 9, `${rec.count} calls:\n${rec.lines().join('\n')}`);
});

test('a drain that found as many as it takes leaves the next turn to drain again, not to wait a minute', async () => {
  await wa('menu', 'wamid.warm2');
  const { drain } = await import('../lib/outbox.js');
  db._tables.notification_outbox ??= [];
  for (let i = 0; i < 7; i++) {
    db._tables.notification_outbox.push({
      id: 600 + i, chat_id: CHAT, channel: 'whatsapp', client_id: 7, event_type: 'operations_message', entity_type: 'chat', entity_id: CHAT,
      payload: { text: `Note ${i}` }, status: 'pending', attempt_count: 0, idempotency_key: `many-${i}`,
      available_at: new Date(Date.now() - 1000).toISOString(), created_at: new Date().toISOString(),
    });
  }
  await drain({ limit: 5 });
  assert.equal(db._tables.notification_outbox.filter((r) => r.id >= 600 && r.status === 'pending').length, 2, 'five of seven went');
  await wa('menu', 'wamid.after');
  assert.equal(db._tables.notification_outbox.filter((r) => r.id >= 600 && r.status === 'pending').length, 0, 'the next turn sent the rest');
});
