/**
 * Talking to a client on any channel: how the engine's messages are drawn on
 * WhatsApp, the 24-hour window, templates, and the outbox that has to respect
 * both - and keep delivering Telegram notifications on a database that has
 * not had the WhatsApp migration yet.
 *
 *   npm test
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Read by lib/config.js when it is first imported, so set before any import of
// application code - which is why everything below is imported dynamically.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';
process.env.WHATSAPP_ACCESS_TOKEN = 'wa-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'PNID';
process.env.WHATSAPP_APP_SECRET = 'app-secret';
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
process.env.TELEGRAM_BOT_TOKEN = 'tg-token';
process.env.ADMIN_SECRET = 'desk-secret';

const { createFakeDb } = await import('./helpers/fake-db.mjs');
const { fakeNetwork, withoutSchema, mockRes, MIGRATION_COLUMNS } = await import('./helpers/whatsapp.mjs');
const { setClientForTests } = await import('../lib/supabase.js');
const { invalidateSettings } = await import('../lib/settings.js');
const { withLanguage } = await import('../lib/lang.js');
const { resetLanguageSupportForTests } = await import('../lib/flow/language.js');
const { M } = await import('../lib/flow/messages.js');
const kb = await import('../lib/flow/keyboards.js');
const {
  renderWhatsApp, splitText, fitText, sendToChat, windowState, sendReopenTemplate, stampClientMessage,
  channelOf, waIdOf, whatsappChatId, templateParams, resetChannelsForTests, LIMITS,
} = await import('../lib/channels.js');
const { enqueue, drain, render, releaseHeld, noteDeliveryStatus, resetOutboxForTests } = await import('../lib/outbox.js');
const { markDelivery, resetChatlogForTests } = await import('../lib/chatlog.js');
const { flush } = await import('../lib/background.js');

const WA = 'wa:201005551234';
const SESSION = `whatsapp:${WA}`;
const HOUR = 3_600_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const TEMPLATES = {
  booking_confirmed: { name: 'mky_booking_confirmed', params: ['booking_ref', 'shipment_id'] },
  booking_confirmed_pdf: { name: 'mky_booking_confirmed_doc', params: ['booking_ref'], header: 'document' },
  missing_information_requested: { name: 'mky_information_needed', params: ['booking_ref', 'what'] },
  _reopen: { name: 'mky_please_reply', params: [] },
};

const BOOKING = {
  booking_ref: 'MKY-BKG-261007-A1', status: 'confirmed', chat_id: WA, client_id: 7, channel: 'whatsapp',
  vin: 'YV2RT40A8FB712905', make: 'Volvo', model: 'FH', customer_name: 'Delta Trans',
  customer_contact: '+201005551234', origin_port: 'Klaipeda', destination_port: 'Alexandria Port (incl. El Dekheila)',
};

let net;

function setup({ seed = {}, lastWrote = 1 * HOUR, templates = TEMPLATES, strict = null } = {}) {
  const sessions = lastWrote === null ? [] : [{
    id: SESSION, channel: 'whatsapp', chat_id: WA, current_state: 'MAIN_MENU', context: {},
    last_client_message_at: ago(lastWrote),
  }];
  let db = createFakeDb({
    bot_settings: [
      { key: 'whatsapp_templates', value: templates },
      { key: 'whatsapp_window_hours', value: 24 },
    ],
    clients: [{ id: 7, whatsapp_id: '201005551234', phone: '+201005551234', is_blocked: false }],
    conversation_sessions: sessions,
    ...seed,
  });
  if (strict) db = withoutSchema(db, strict);
  setClientForTests(db);
  invalidateSettings();
  resetLanguageSupportForTests();
  resetChannelsForTests();
  resetOutboxForTests();
  resetChatlogForTests();
  return db;
}

beforeEach(() => {
  net = fakeNetwork();
});

const buttonsOf = (n) => Array.from({ length: n }, (_, i) => kb.cb(`${i + 1}️⃣ خيار رقم ${i + 1} / Option number ${i + 1}`, `x:opt:${i + 1}`));

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test('a WhatsApp chat id is the number with a prefix, and never mistaken for Telegram', () => {
  assert.equal(whatsappChatId('201005551234'), WA);
  assert.equal(waIdOf(WA), '201005551234');
  assert.equal(waIdOf('201005551234'), null, 'a bare number is a Telegram chat id');
  assert.equal(channelOf(WA), 'whatsapp');
  assert.equal(channelOf('555'), 'telegram');
});

// ---------------------------------------------------------------------------
// Drawing the engine's messages on WhatsApp
// ---------------------------------------------------------------------------

test('three choices or fewer are reply buttons, showing each button\'s short title', () => {
  const steps = renderWhatsApp({ text: M.menu(), inline: kb.mainMenu() }, { language: null });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, 'buttons');
  assert.deepEqual(steps[0].buttons.map((b) => b.id), ['menu:book', 'menu:track', 'menu:contact']);
  for (const b of steps[0].buttons) assert.ok(b.title.length <= LIMITS.buttonTitle, `"${b.title}" fits`);

  // The engine writes the title in the conversation's language.
  const en = withLanguage('en', () => renderWhatsApp({ text: 'How can we help?', inline: kb.mainMenu() }));
  assert.deepEqual(en[0].buttons.map((b) => b.title), ['Book my shipment', 'Track my shipment', 'Talk to an agent']);
  const ar = withLanguage('ar', () => renderWhatsApp({ text: 'نقدر نساعدك في إيه؟', inline: kb.mainMenu() }));
  assert.equal(ar[0].buttons[0].title, 'احجز شحنة');
});

test('a button with no title of its own gets the half of its label in the conversation\'s language', () => {
  const inline = [[{ text: '📦 احجز شحنة / Book my shipment', callback_data: 'menu:book' }]];
  assert.equal(renderWhatsApp({ text: 'Hi', inline }, { language: 'en' })[0].buttons[0].title, '📦 Book my shipment');
  assert.equal(renderWhatsApp({ text: 'Hi', inline }, { language: 'ar' })[0].buttons[0].title, '📦 احجز شحنة');
  assert.equal(renderWhatsApp({ text: 'Hi', inline }, { language: null })[0].buttons[0].title, '📦 احجز شحنة');
});

test('a button that brings its own short title keeps it', () => {
  const inline = [[{ text: '📦 احجز شحنة / Book my shipment', callback_data: 'menu:book', title: 'Book' }]];
  const [step] = renderWhatsApp({ text: 'Hi', inline }, { language: 'en' });
  assert.deepEqual(step.buttons, [{ id: 'menu:book', title: 'Book' }]);
});

test('four to ten choices are one list, rows within 24 characters, the long label kept underneath', () => {
  const steps = withLanguage('en', () => renderWhatsApp({ text: 'What would you like to change?', inline: kb.editMenu() }));
  assert.equal(steps.length, 1);
  const [list] = steps;
  assert.equal(list.type, 'list');
  assert.equal(list.button, 'Choose');
  const rows = list.sections.flatMap((s) => s.rows);
  assert.equal(rows.length, 7);
  for (const row of rows) {
    assert.ok(row.title.length <= LIMITS.rowTitle, `"${row.title}" fits a row`);
    if (row.description) assert.ok(row.description.length <= LIMITS.rowDescription);
  }
  for (const s of list.sections) assert.ok(s.title.length <= 24);
  assert.equal(rows[6].id, 'bk:edit:back');
  // "Back to summary" fits; the full wording goes underneath it.
  assert.equal(rows[6].title, 'Back to summary');
  assert.equal(rows[6].description, '7️⃣ Back to confirmation');
  assert.equal(rows[0].description, undefined, 'nothing repeated under "Client name"');

  // Before a choice the row carries both languages under its title.
  const both = renderWhatsApp({ text: 'Edit', inline: kb.editMenu() }, { language: null });
  assert.match(both[0].sections[0].rows[0].description, /اسم العميل/);

  const arabic = withLanguage('ar', () => renderWhatsApp({ text: 'تحب تعدل إيه؟', inline: kb.editMenu() }));
  assert.equal(arabic[0].button, 'اختار');
});

test('more than ten choices are split across several lists', () => {
  const steps = renderWhatsApp({ text: 'Pick one', inline: buttonsOf(13).map((b) => [b]) }, { language: 'en' });
  assert.deepEqual(steps.map((s) => s.type), ['list', 'list']);
  assert.equal(steps[0].sections[0].rows.length, 10);
  assert.equal(steps[1].sections[0].rows.length, 3);
  assert.equal(steps[0].body, 'Pick one');
  assert.match(steps[1].body, /More options/);
  const ids = steps.flatMap((s) => s.sections[0].rows.map((r) => r.id));
  assert.equal(new Set(ids).size, 13, 'every choice is offered exactly once');
});

test('a body too long for buttons goes first as text, and the buttons follow under a short prompt', () => {
  const long = `${'A review card line. '.repeat(70)}`.trim();
  assert.ok(long.length > 1024);
  const steps = renderWhatsApp({ text: long, inline: kb.confirmBooking() }, { language: 'en' });
  assert.deepEqual(steps.map((s) => s.type), ['text', 'buttons']);
  assert.equal(steps[0].body, long);
  assert.ok(steps[1].body.length <= 1024);
  assert.match(steps[1].body, /Choose an option/);
});

test('text longer than WhatsApp allows is split on paragraph boundaries, nothing lost', () => {
  const paragraph = 'Line of the documents checklist.\n'.repeat(30).trim();
  const text = Array.from({ length: 8 }, () => paragraph).join('\n\n');
  assert.ok(text.length > 4096);
  const parts = splitText(text);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= 4096);
  assert.equal(parts.join('\n\n'), text, 'split only where a blank line was');

  const steps = renderWhatsApp({ text }, { language: 'en' });
  assert.ok(steps.every((s) => s.type === 'text'));
  assert.equal(steps.length, parts.length);
});

test('labels are shortened between whole characters, never through an emoji', () => {
  const cut = fitText('3️⃣ الشاسيه / Chassis · VIN and everything else', 20);
  assert.ok(cut.length <= 20);
  assert.ok(cut.endsWith('…'));
  assert.ok(!/[\uD800-\uDBFF]$/.test(cut.slice(0, -1)), 'no half surrogate pair before the ellipsis');
  assert.equal(fitText('Short', 20), 'Short');
});

test('a reply keyboard has no WhatsApp form and is not sent', () => {
  const steps = renderWhatsApp({ text: 'Your phone number?', keyboard: kb.sharePhoneKeyboard(), oneTime: true }, { language: 'en' });
  assert.deepEqual(steps, [{ type: 'text', body: 'Your phone number?' }]);
});

// ---------------------------------------------------------------------------
// sendToChat
// ---------------------------------------------------------------------------

test('sendToChat draws and sends on WhatsApp, and logs every message it sent', async () => {
  const db = setup();
  const result = await sendToChat({ channel: 'whatsapp', chatId: WA, clientId: 7 },
    { text: 'Hello', inline: kb.mainMenu() }, { language: 'en' });
  await flush();

  assert.equal(result.ok, true);
  assert.equal(result.status, 'sent');
  assert.match(result.providerMessageId, /^wamid\.out\./);
  const [sent] = net.sent();
  assert.equal(sent.to, '201005551234', 'the prefix is stripped only when calling Meta');
  assert.equal(sent.type, 'interactive');
  assert.equal(sent.interactive.type, 'button');

  const logged = db._tables.chat_messages;
  assert.equal(logged.length, 1);
  assert.equal(logged[0].direction, 'out');
  assert.equal(logged[0].author, 'bot');
  assert.equal(logged[0].provider_message_id, result.providerMessageId);
});

test('sendToChat on Telegram sends exactly what lib/telegram.js always sent', async () => {
  setup();
  const result = await sendToChat({ channel: 'telegram', chatId: 555 }, { text: M.menu(), inline: kb.mainMenu() });
  await flush();
  assert.equal(result.ok, true);
  const [payload] = net.telegram('sendMessage');
  // Telegram's buttons are text and callback_data, as they always were: the
  // WhatsApp title the engine adds is not Telegram's business.
  const telegramButtons = kb.mainMenu().map((row) => row.map(({ text, callback_data }) => ({ text, callback_data })));
  assert.deepEqual(payload, {
    chat_id: 555, text: M.menu(), disable_web_page_preview: true,
    reply_markup: { inline_keyboard: telegramButtons },
  });
});

test('a WhatsApp chat id handed to Telegram goes nowhere', async () => {
  setup();
  const { sendMessage } = await import('../lib/telegram.js');
  const res = await sendMessage(WA, 'hello', { returnMessage: true });
  assert.equal(res.ok, false);
  assert.equal(net.telegram('sendMessage').length, 0);
});

// ---------------------------------------------------------------------------
// The 24-hour window
// ---------------------------------------------------------------------------

test('the window is open within 24 hours of the client\'s last message and closed after', async () => {
  setup({ lastWrote: 2 * HOUR });
  const open = await windowState({ channel: 'whatsapp', chatId: WA });
  assert.equal(open.applies, true);
  assert.equal(open.open, true);
  assert.ok(new Date(open.closesAt) > new Date());

  setup({ lastWrote: 25 * HOUR });
  assert.equal((await windowState({ channel: 'whatsapp', chatId: WA })).open, false);

  setup({ lastWrote: null });
  assert.equal((await windowState({ channel: 'whatsapp', chatId: WA })).open, false, 'never wrote: closed');

  assert.equal((await windowState({ channel: 'telegram', chatId: 555 })).applies, false);
});

test('outside the window a person\'s free text is not sent: needs_template', async () => {
  setup({ lastWrote: 30 * HOUR });
  const result = await sendToChat({ channel: 'whatsapp', chatId: WA, clientId: 7 },
    { text: 'Hi, about your booking' }, { author: 'staff', staffName: 'Sara' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'needs_template');
  assert.equal(net.sent().length, 0, 'nothing went to Meta');
});

test('the bot answering the client is never held by the window', async () => {
  setup({ lastWrote: null });
  const result = await sendToChat({ channel: 'whatsapp', chatId: WA }, { text: 'Hello' }, { author: 'bot' });
  assert.equal(result.status, 'sent');
});

test('a client writing stamps the window, creating the session row when there is none', async () => {
  const db = setup({ lastWrote: null });
  await stampClientMessage({ channel: 'whatsapp', chatId: WA, clientId: 7 });
  const row = db._tables.conversation_sessions.find((s) => s.id === SESSION);
  assert.ok(row);
  assert.equal(row.current_state, 'MAIN_MENU');
  assert.equal((await windowState({ channel: 'whatsapp', chatId: WA })).open, true);
});

test('the "please reply" template reopens a closed window, in the client\'s language', async () => {
  setup({ lastWrote: 40 * HOUR });
  const result = await sendReopenTemplate({ chatId: WA, clientId: 7 }, { staffName: 'Sara', language: 'en' });
  assert.equal(result.ok, true);
  assert.equal(result.templateName, 'mky_please_reply');
  const [sent] = net.sent();
  assert.equal(sent.type, 'template');
  assert.equal(sent.template.name, 'mky_please_reply');
  assert.equal(sent.template.language.code, 'en');
});

test('template parameters come from the payload, in the template\'s order, never empty', () => {
  const params = templateParams(
    { params: ['booking_ref', 'what', 'missing'] },
    { booking_ref: 'MKY-1', requested: 'A clearer invoice.\nPage 2 please', requested_ar: 'فاتورة أوضح' },
    'en',
  );
  assert.deepEqual(params, ['MKY-1', 'A clearer invoice. Page 2 please', '—']);
  assert.equal(templateParams({ params: ['what'] }, { requested: 'x', requested_ar: 'فاتورة' }, 'ar')[0], 'فاتورة');

  // Long enough to push the template past Meta's 1024: cut, visibly.
  const [long] = templateParams({ params: ['message'] }, { text: 'word '.repeat(300) });
  assert.ok(long.length <= 400);
  assert.ok(long.endsWith('…'));
});

test('a desk message outside the window goes as the team-message template, about its booking', async () => {
  setup({
    lastWrote: 30 * HOUR,
    templates: { ...TEMPLATES, operations_message: { name: 'mky_message_from_team', params: ['reference', 'message'] } },
  });
  await enqueue({
    chatId: WA, clientId: 7, eventType: 'operations_message', entityType: 'booking', entityId: 'MKY-BKG-9',
    idempotencyKey: 'ops:9', payload: { text: 'We have your documents.\nChecking them now.' },
  });
  assert.equal((await drain()).sent, 1);
  const [sent] = net.sent();
  assert.equal(sent.template.name, 'mky_message_from_team');
  assert.deepEqual(sent.template.components[0].parameters.map((p) => p.text),
    ['MKY-BKG-9', 'We have your documents. Checking them now.']);
});

// ---------------------------------------------------------------------------
// The outbox on WhatsApp
// ---------------------------------------------------------------------------

async function queueConfirmation(extra = {}) {
  return enqueue({
    chatId: WA, clientId: 7, eventType: 'booking_confirmed', entityType: 'booking', entityId: BOOKING.booking_ref,
    idempotencyKey: `booking_confirmed:${BOOKING.booking_ref}`,
    payload: {
      booking_ref: BOOKING.booking_ref, vin: BOOKING.vin, make: 'Volvo FH',
      origin_port: BOOKING.origin_port, destination_port: BOOKING.destination_port, shipment_id: 'MKY-26001',
    },
    ...extra,
  });
}

test('a WhatsApp chat\'s outbox row knows its channel, and has no Telegram id', async () => {
  const db = setup();
  await queueConfirmation();
  const [row] = db._tables.notification_outbox;
  assert.equal(row.channel, 'whatsapp');
  assert.equal(row.telegram_chat_id, null, 'the number is not a Telegram chat id');
  assert.equal(row.chat_id, WA);
});

test('inside the window a confirmation goes as an ordinary message with its buttons', async () => {
  const db = setup({ lastWrote: 2 * HOUR });
  await queueConfirmation();
  const result = await drain();
  assert.equal(result.sent, 1);

  const [sent] = net.sent();
  assert.equal(sent.type, 'interactive');
  assert.match(sent.interactive.body.text, /MKY-BKG-261007-A1/);
  const row = db._tables.notification_outbox[0];
  assert.equal(row.status, 'sent');
  assert.equal(row.delivery_status, 'sent');
  assert.match(row.provider_message_id, /^wamid\.out\./);
});

test('outside the window it goes as the approved template, filled from the payload', async () => {
  const db = setup({ lastWrote: 30 * HOUR, seed: { clients: [{ id: 7, whatsapp_id: '201005551234', language: 'ar' }] } });
  await queueConfirmation();
  const result = await drain();
  assert.equal(result.sent, 1);

  const [sent] = net.sent();
  assert.equal(sent.type, 'template');
  assert.equal(sent.template.name, 'mky_booking_confirmed');
  assert.equal(sent.template.language.code, 'ar', 'the client chose Arabic');
  assert.deepEqual(sent.template.components[0].parameters.map((p) => p.text), [BOOKING.booking_ref, 'MKY-26001']);
  const row = db._tables.notification_outbox[0];
  assert.equal(row.template_name, 'mky_booking_confirmed');
  assert.equal(row.status, 'sent');
});

test('outside the window with no template, the row waits - no free text, no retry spent', async () => {
  const db = setup({ lastWrote: 30 * HOUR });
  await enqueue({
    chatId: WA, clientId: 7, eventType: 'operations_message', entityId: 'MKY-1',
    idempotencyKey: 'ops:1', payload: { text: 'Your truck is at the port.' },
  });
  const result = await drain();
  assert.equal(result.held, 1);
  assert.equal(result.sent, 0);
  assert.equal(net.sent().length, 0, 'nothing was sent to Meta');

  const row = db._tables.notification_outbox[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.delivery_status, 'needs_template');
  assert.equal(row.attempt_count, 0, 'the claim was not counted as an attempt');
  assert.ok(new Date(row.available_at) > new Date(), 'not picked again at once');

  // The client writes: the window opens and the message goes as free text.
  await stampClientMessage({ channel: 'whatsapp', chatId: WA });
  const released = await releaseHeld(WA);
  assert.equal(released.released, 1);
  const again = await drain();
  assert.equal(again.sent, 1);
  assert.equal(net.sent()[0].type, 'interactive');
  assert.match(net.sent()[0].interactive.body.text, /truck is at the port/);
});

test('a PDF outside the window goes as a template with the PDF as its document header', async () => {
  setup({ lastWrote: 30 * HOUR, seed: { bookings: [BOOKING] } });
  await enqueue({
    chatId: WA, clientId: 7, eventType: 'booking_confirmed_pdf', entityId: BOOKING.booking_ref,
    idempotencyKey: `booking_confirmed_pdf:${BOOKING.booking_ref}`, payload: { booking_ref: BOOKING.booking_ref },
  });
  const result = await drain();
  assert.equal(result.sent, 1);

  const upload = net.calls.find((c) => c.path.endsWith('/media') && c.method === 'POST');
  assert.ok(upload, 'the PDF was uploaded first');
  const [sent] = net.sent();
  assert.equal(sent.type, 'template');
  const header = sent.template.components.find((c) => c.type === 'header');
  assert.equal(header.parameters[0].type, 'document');
  assert.match(header.parameters[0].document.filename, /MKY-BKG-261007-A1\.pdf/);
});

test('inside the window a PDF is uploaded and sent as a document with its caption', async () => {
  setup({ lastWrote: 1 * HOUR, seed: { bookings: [BOOKING] } });
  await withLanguage('en', () => enqueue({
    chatId: WA, clientId: 7, eventType: 'booking_request_pdf', entityId: BOOKING.booking_ref,
    idempotencyKey: 'pdf:1', payload: { booking_ref: BOOKING.booking_ref },
  }));
  const result = await drain();
  assert.equal(result.sent, 1);
  const [sent] = net.sent();
  assert.equal(sent.type, 'document');
  assert.equal(sent.document.caption, `Booking request ${BOOKING.booking_ref} - your PDF copy`,
    'queued inside an English turn, captioned in English only');
});

test('Meta saying the window has closed sends the template instead', async () => {
  setup({ lastWrote: 23 * HOUR });
  await queueConfirmation();
  net.failNext(131047, 'Re-engagement message');
  const result = await drain();
  assert.equal(result.sent, 1);
  const types = net.sent().map((m) => m.type);
  assert.deepEqual(types, ['interactive', 'template']);
});

test('a permanent Meta error ends the row; a throughput limit retries it later', async () => {
  const db = setup();
  await queueConfirmation();
  net.failNext(131026, 'Message undeliverable');
  let result = await drain();
  assert.equal(result.dead, 1);
  assert.equal(db._tables.notification_outbox[0].status, 'dead');

  setup();
  await queueConfirmation();
  net.failNext(130429, 'Rate limit hit');
  result = await drain();
  assert.equal(result.retried, 1);
  const { db: current } = await import('../lib/supabase.js');
  const row = current()._tables.notification_outbox[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.attempt_count, 1);
});

test('a client who wrote STOP gets nothing proactive, but still their own PDF', async () => {
  const db = setup({
    seed: {
      clients: [{ id: 7, whatsapp_id: '201005551234', opted_out_at: ago(3 * HOUR) }],
      bookings: [BOOKING],
    },
    lastWrote: 5 * HOUR,
  });
  await queueConfirmation();
  await enqueue({
    chatId: WA, clientId: 7, eventType: 'booking_request_pdf', entityId: BOOKING.booking_ref,
    idempotencyKey: 'pdf:2', payload: { booking_ref: BOOKING.booking_ref },
  });
  const result = await drain();
  assert.equal(result.held, 1);
  assert.equal(result.sent, 1);
  const confirmation = db._tables.notification_outbox.find((r) => r.event_type === 'booking_confirmed');
  assert.equal(confirmation.delivery_status, 'opted_out');
  assert.deepEqual(net.sent().map((m) => m.type), ['document']);
});

test('delivery receipts move the chat log and the outbox row forward, never back', async () => {
  const db = setup();
  await queueConfirmation();
  await drain();
  const row = db._tables.notification_outbox[0];
  const id = row.provider_message_id;

  await noteDeliveryStatus({ providerMessageId: id, status: 'read' });
  await noteDeliveryStatus({ providerMessageId: id, status: 'delivered' });
  assert.equal(row.delivery_status, 'read', 'a late "delivered" does not undo "read"');

  await markDelivery('whatsapp', id, 'delivered');
  await markDelivery('whatsapp', id, 'read');
  await markDelivery('whatsapp', id, 'delivered');
  const logged = db._tables.chat_messages.find((m) => m.provider_message_id === id);
  assert.equal(logged.status, 'read');
});

test('a free-form message Meta later reports as outside the window waits for a template', async () => {
  const db = setup();
  await queueConfirmation();
  await drain();
  const row = db._tables.notification_outbox[0];
  await noteDeliveryStatus({ providerMessageId: row.provider_message_id, status: 'failed', code: 131047, error: 'Re-engagement' });
  assert.equal(row.status, 'pending');
  assert.equal(row.delivery_status, 'needs_template');

  // Our clock still says open; the row is not sent as free text again until
  // the client writes.
  net.reset();
  await drain();
  assert.deepEqual(net.sent().map((m) => m.type), ['template']);
});

// ---------------------------------------------------------------------------
// The desk deciding a WhatsApp booking: was the customer told?
// ---------------------------------------------------------------------------

const decideBooking = (await import('../api/admin/bookings.js')).default;
const ticketsApi = (await import('../api/admin/tickets.js')).default;

/** A WhatsApp booking with the desk, and a desk with one person on it. */
function deskSetup({ lastWrote = 1 * HOUR, seed = {} } = {}) {
  return setup({
    lastWrote,
    seed: {
      bookings: [{ ...BOOKING, status: 'under_review' }],
      ops_users: [{ name: 'Sara', role: 'ops_agent', active: true }],
      ...seed,
    },
  });
}

async function decide(action, extra = {}) {
  const res = mockRes();
  await decideBooking({
    method: 'POST', query: { secret: 'desk-secret' }, headers: {},
    body: { booking_ref: BOOKING.booking_ref, action, operator: 'Sara', ...extra },
  }, res);
  return res;
}

const NOT_TOLD = /could NOT be told/;

test('confirming a WhatsApp booking the customer received on WhatsApp warns of nothing', async () => {
  const db = deskSetup();
  const res = await decide('confirm');
  assert.equal(res.statusCode, 200);

  const said = net.sent().map((m) => m.interactive?.body?.text ?? m.text?.body ?? '').join('\n');
  assert.match(said, /MKY-BKG-261007-A1/, 'the confirmation reached them on WhatsApp');
  assert.ok(!res.body.warnings.some((w) => NOT_TOLD.test(w)), `no false alarm: ${res.body.warnings.join(' | ')}`);
  assert.equal(res.body.customer_told.reached, 'sent');
  assert.match(res.body.customer_told.words, /WhatsApp/);
  assert.ok(db._tables.bookings[0].customer_told_at, 'recorded as told');
});

test('a rejection held for an unapproved template is queued for when they write, not "could not be told"', async () => {
  // Thirty hours since they wrote, and TEMPLATES has nothing for a rejection.
  const db = deskSetup({ lastWrote: 30 * HOUR });
  const res = await decide('reject', { note: 'The vessel is full this month.' });
  assert.equal(res.statusCode, 200);
  assert.equal(net.sent().length, 0, 'nothing went as free text outside the window');

  assert.deepEqual(res.body.warnings, []);
  assert.equal(res.body.customer_told.reached, 'held');
  assert.match(res.body.customer_told.words, /when they write/i);
  assert.equal(db._tables.bookings[0].customer_told_at ?? null, null, 'not told yet, so not recorded as told');
});

test('WhatsApp refusing the message, with no email to fall back on, is the one case that warns', async () => {
  deskSetup();
  net.failNext(131026, 'Message undeliverable');
  const res = await decide('reject', { note: 'We do not serve that port.' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.customer_told.reached, 'failed');
  assert.ok(res.body.warnings.some((w) => NOT_TOLD.test(w)), 'the desk is told to contact them');
});

test('a ticket resolved on WhatsApp is recorded as told', async () => {
  const db = setup({
    seed: {
      support_tickets: [{ ticket_ref: 'MKY-T-9', status: 'open', channel: 'whatsapp', chat_id: WA, client_id: 7, department: 'Customer Care' }],
      ops_users: [{ name: 'Sara', role: 'ops_agent', active: true }],
    },
  });
  const res = mockRes();
  await ticketsApi({
    method: 'POST', query: { secret: 'desk-secret' }, headers: {},
    body: { ticket_ref: 'MKY-T-9', action: 'resolve', note: 'We called the port; the truck is released.', operator: 'Sara' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.customer_told.reached, 'sent');
  assert.ok(db._tables.support_tickets[0].customer_told_at, 'stamped, as a Telegram ticket always was');
});

// ---------------------------------------------------------------------------
// Before the migration
// ---------------------------------------------------------------------------

test('before the migration, Telegram notifications still queue and go out', async () => {
  const db = setup({
    lastWrote: null,
    strict: {
      columns: MIGRATION_COLUMNS,
      tables: ['chat_messages', 'processed_whatsapp_messages'],
      rpcs: ['claim_whatsapp_message'],
    },
  });

  // Queued inside an Arabic turn: the outbox would like to record the language,
  // and the column is not there.
  const queued = await withLanguage('ar', () => enqueue({
    chatId: '555', clientId: null, eventType: 'booking_confirmed', entityType: 'booking', entityId: 'REF-1',
    idempotencyKey: 'booking_confirmed:REF-1',
    payload: { booking_ref: 'REF-1', vin: 'W1T9', make: 'Volvo', origin_port: 'Koper', destination_port: 'Suez Port' },
  }));
  assert.equal(queued.ok, true);
  assert.equal(queued.queued, true);
  const [row] = db._tables.notification_outbox;
  assert.equal(row.language, undefined, 'the missing column was not written');
  assert.equal(row.channel, 'telegram');
  assert.equal(row.telegram_chat_id, 555);

  const sent = [];
  const result = await drain({
    send: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); return { ok: true, result: { message_id: 9 } }; },
  });
  await flush();
  assert.equal(result.sent, 1);
  assert.equal(row.status, 'sent');
  assert.equal(row.delivery_status, undefined);
  assert.equal(sent[0].chatId, '555');
  assert.equal(sent[0].text, render(row).text, 'the bilingual text, exactly as before');
  assert.equal(db._tables.chat_messages, undefined, 'no chat log without its table');
});

test('a Telegram notification renders byte-for-byte as before when no language was chosen', () => {
  const row = {
    event_type: 'booking_confirmed',
    payload: { booking_ref: 'REF-1', vin: 'W1T9', make: 'Volvo', origin_port: 'Koper', destination_port: 'Suez Port', shipment_id: 'MKY-26002' },
  };
  const { text } = render(row);
  assert.ok(text.endsWith('\n\nرقم الشحنة للتتبع / Track with: MKY-26002'));
  const pdf = render({ event_type: 'booking_confirmed_pdf', payload: { booking_ref: 'REF-1' } });
  assert.equal(pdf.document.caption,
    'تأكيد الحجز REF-1 - نسختك بصيغة PDF\nBooking confirmation REF-1 - your PDF copy');

  const english = withLanguage('en', () => render(row));
  assert.ok(english.text.endsWith('\n\nTrack with: MKY-26002'));
});
