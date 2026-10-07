/**
 * One language per conversation (docs/WHATSAPP-AND-DESK.md §2.1 and §5).
 *
 * A client chooses English or Arabic once; from then on everything the bot
 * says is in that language alone. These tests drive the same state machine as
 * flow.test.mjs, on Telegram, WhatsApp and the website, against the in-memory
 * database - including one that has not had the language migration applied,
 * because production can be deployed before its migration is.
 *
 *   npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';
process.env.OPERATIONS_PHONE ||= '';

import { createFakeDb } from './helpers/fake-db.mjs';
import { setClientForTests } from '../lib/supabase.js';
import { invalidateSettings } from '../lib/settings.js';
import { resetFlowReady } from '../lib/flow/ready.js';
import { runFlow } from '../lib/flow/machine.js';
import * as kb from '../lib/flow/keyboards.js';
import { parseCallback } from '../lib/flow/keyboards.js';
import { M } from '../lib/flow/messages.js';
import { S } from '../lib/flow/states.js';
import { resetLanguageSupportForTests, languageSupported } from '../lib/flow/language.js';
import { withLanguage, withTurn } from '../lib/lang.js';
import { normalizeVin } from '../lib/bookings.js';
import { bookingLanguage } from '../lib/i18n.js';
import { shipmentCard, departmentsCard, documentsCard } from '../lib/format.js';
import { splitLanguages, systemPrompt, contactIntent } from '../lib/agent.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const SETTINGS = [
  { key: 'required_booking_documents', value: ['invoice', 'brief', 'mrn'] },
  { key: 'required_booking_documents_mky_mrn', value: ['invoice', 'brief'] },
  { key: 'required_mrn_documents', value: [] },
  { key: 'acid_required', value: false },
  { key: 'allow_submit_while_mrn_pending', value: true },
  { key: 'allowed_file_types', value: ['application/pdf', 'image/jpeg'] },
  { key: 'max_upload_bytes', value: 20971520 },
  { key: 'allow_unowned_shipment_tracking', value: false },
  { key: 'operations_phone', value: null },
  // ask_language_first is deliberately absent: absent means ask.
];

const IN_HOURS = new Date('2026-09-16T12:00:00Z');
const WA = '201005551234';
const PHONE = '+20 100 555 1234';
const VIN = 'W1T96340310484233';
const RULE = '━';

/**
 * A database without migration 20261007090000: every read or write that names
 * a `language` column fails the way PostgREST fails it, and the rest works.
 */
function withoutLanguageColumns(db) {
  return {
    ...db,
    from(name) {
      const q = db.from(name);
      let broken = false;
      const select = q.select.bind(q);
      const update = q.update.bind(q);
      const upsert = q.upsert.bind(q);
      const run = q.run.bind(q);
      q.select = (cols, opts) => { if (/\blanguage\b/.test(String(cols ?? ''))) broken = true; return select(cols, opts); };
      q.update = (patch) => { if (patch && 'language' in patch) broken = true; return update(patch); };
      q.upsert = (rows, opts) => {
        if ([].concat(rows).some((r) => r && 'language' in r)) broken = true;
        return upsert(rows, opts);
      };
      q.run = async () => (broken
        ? { data: null, error: { code: '42703', message: `column ${name}.language does not exist` }, count: null }
        : run());
      return q;
    },
  };
}

function harness({ channel = 'telegram', settings = [], seed = {}, wrap = null, clientId } = {}) {
  let db = createFakeDb({
    bot_settings: [...SETTINGS, ...settings],
    clients: [
      { id: 1, telegram_user_id: 999, telegram_chat_id: 555, display_name: 'Arif' },
      { id: 2, whatsapp_id: WA, display_name: 'Mona' },
    ],
    ...seed,
  });
  const raw = db;
  if (wrap) db = wrap(db);
  setClientForTests(db);
  invalidateSettings();
  resetFlowReady(true);
  resetLanguageSupportForTests();

  const ctx = {
    telegram: { channel: 'telegram', chatId: '555', clientId: 1, telegramUserId: 999, userName: 'Arif' },
    whatsapp: { channel: 'whatsapp', chatId: `wa:${WA}`, waId: WA, clientId: 2, userName: 'Mona' },
    web: { channel: 'web', chatId: 'web-1', clientId: null, userName: null },
  }[channel];
  Object.assign(ctx, { correlationId: 'test', now: IN_HOURS });
  if (clientId !== undefined) ctx.clientId = clientId;

  const send = (input) => runFlow(input, ctx);
  const tables = raw._tables;

  return {
    db: raw,
    ctx,
    send,
    text: (t) => send({ kind: 'text', text: t }),
    tap: (data) => send({ kind: 'callback', callback: { ...parseCallback(data), id: 'cbq' } }),
    command: (c, text = c) => send({ kind: 'command', command: c, text }),
    file: (doc, extra = {}) => send({ kind: 'document', document: doc, ...extra }),
    upload(docType, { vin = null } = {}) {
      tables.booking_documents ??= [];
      const id = 1000 + tables.booking_documents.length;
      tables.booking_documents.push({
        id, chat_id: ctx.chatId, client_id: ctx.clientId, channel, booking_ref: null,
        doc_type: docType, file_name: 'f.pdf', vin, vin_norm: normalizeVin(vin), status: 'received',
        extraction_ok: true, uploaded_at: new Date().toISOString(),
      });
      return { document: { id, doc_type: docType } };
    },
    booking: () => tables.bookings?.[tables.bookings.length - 1] ?? null,
    session: () => (tables.conversation_sessions ?? []).find((s) => s.id === `${channel}:${ctx.chatId}`) ?? null,
    client: () => (tables.clients ?? []).find((c) => c.id === ctx.clientId) ?? null,
    setSetting(key, value) {
      const row = tables.bot_settings.find((r) => r.key === key);
      if (row) row.value = value; else tables.bot_settings.push({ key, value });
      invalidateSettings();
    },
  };
}

const said = (r) => r.messages.map((m) => m.text).join('\n---\n');
const buttons = (r) => r.messages.flatMap((m) => (m.inline ?? []).flat());
const datas = (r) => buttons(r).map((b) => b.callback_data);

const ARABIC = /[؀-ۿ]/;
/** Words only an English sentence has - never a port name, a make or a reference. */
const ENGLISH_PROSE = /\b(?:please|your|step|thank|which|what|we|you|is|the)\b/i;

/** Every message and every button in one language: no divider, no other half. */
function assertArabicOnly(r, label = '') {
  for (const m of r.messages) {
    assert.ok(!m.text.includes(RULE), `${label}: no divider - ${m.text}`);
    assert.doesNotMatch(m.text, ENGLISH_PROSE, `${label}: no English half - ${m.text}`);
    assert.match(m.text, ARABIC, `${label}: Arabic - ${m.text}`);
  }
  for (const b of buttons(r)) {
    assert.ok(!b.text.includes(' / '), `${label}: one-language button - ${b.text}`);
    assert.doesNotMatch(b.text, ENGLISH_PROSE, `${label}: Arabic button - ${b.text}`);
  }
}

function assertEnglishOnly(r, label = '') {
  for (const m of r.messages) {
    assert.ok(!m.text.includes(RULE), `${label}: no divider - ${m.text}`);
    assert.doesNotMatch(m.text, ARABIC, `${label}: no Arabic half - ${m.text}`);
  }
  for (const b of buttons(r)) assert.doesNotMatch(b.text, ARABIC, `${label}: English button - ${b.text}`);
}

/** Walks a booking from the menu to the confirmation card, returning every reply. */
async function bookToCard(h, { name = 'Nile Motors' } = {}) {
  const replies = [];
  replies.push(await h.tap('menu:book'));
  replies.push(await h.text(name));
  replies.push(await h.text(PHONE));
  replies.push(await h.text(VIN));
  replies.push(await h.text('Mercedes-Benz'));
  replies.push(await h.text('Vilnius'));
  replies.push(await h.text('Alexandria'));
  replies.push(await h.tap('bk:mrn:existing'));
  for (const type of ['invoice', 'brief', 'mrn']) replies.push(await h.file(h.upload(type, { vin: VIN })));
  return replies;
}

// ---------------------------------------------------------------------------
// The first question
// ---------------------------------------------------------------------------

test('first contact asks which language, in both, with two buttons', async () => {
  const h = harness();
  const r = await h.command('/start');

  assert.match(said(r), /Which language would you like\?/);
  assert.match(said(r), /تحب نكمل بأنهي لغة؟/);
  assert.match(said(r), /Welcome Arif to MKY Forwarding/, 'it is the welcome too');
  assert.ok(said(r).includes(RULE), 'said before a choice, so in both');
  assert.deepEqual(datas(r), ['lang:en', 'lang:ar']);
  assert.deepEqual(buttons(r).map((b) => b.title), ['English', 'العربية']);
  assert.equal(r.state, S.CHOOSE_LANGUAGE);
  assert.equal(r.language, null);
});

test('tapping العربية answers with the menu in Arabic only, and remembers it', async () => {
  const h = harness();
  await h.command('/start');
  const r = await h.tap('lang:ar');

  assertArabicOnly(r, 'menu');
  assert.match(said(r), /أهلاً Arif بيك في MKY Forwarding/);
  assert.deepEqual(datas(r), ['menu:book', 'menu:track', 'menu:contact']);
  assert.deepEqual(buttons(r).map((b) => b.text), ['📦 احجز شحنة', '🚚 تتبع شحنتي', '💬 كلّم موظف']);
  assert.deepEqual(buttons(r).map((b) => b.title), ['احجز شحنة', 'تتبع شحنتي', 'كلّم موظف']);
  assert.equal(r.state, S.MAIN_MENU);
  assert.equal(r.language, 'ar');

  assert.equal(h.client().language, 'ar', 'on the client, so the next channel and the PDF follow');
  assert.equal(h.session().language, 'ar', 'and on the session');

  // The next turn reads it back: still Arabic, with nothing passed in.
  const next = await h.tap('menu:book');
  assertArabicOnly(next, 'booking start');
  assert.match(said(next), /الخطوة الأولى من 3/);
  assert.equal(next.language, 'ar');
});

test('typing the language works as well as tapping it', async () => {
  for (const [typed, lang] of [['عربي', 'ar'], ['English', 'en'], ['en', 'en'], ['العربية', 'ar']]) {
    const h = harness();
    await h.command('/start');
    const r = await h.text(typed);
    assert.equal(r.language, lang, typed);
    assert.equal(r.state, S.MAIN_MENU, typed);
    if (lang === 'ar') assertArabicOnly(r, typed);
    else assertEnglishOnly(r, typed);
  }
});

test('a typed "1" at the question is its first button: English', async () => {
  const h = harness();
  await h.command('/start');
  const r = await h.text('1');
  assert.equal(r.language, 'en');
  assertEnglishOnly(r, '"1"');
  assert.match(said(r), /Welcome Arif to MKY Forwarding/);
});

test('"hi" first is asked; an answer in words is read for its script and then dealt with', async () => {
  const h = harness();
  const asked = await h.text('hi');
  assert.deepEqual(datas(asked), ['lang:en', 'lang:ar']);

  // "I want to book" answers the question AND starts the booking, in English.
  const r = await h.text('I want to book');
  assert.equal(r.language, 'en');
  assert.equal(r.state, S.BOOK_CLIENT_NAME);
  assertEnglishOnly(r, 'booking');
  assert.match(said(r), /Step 1 of 3/);
  assert.equal(h.client().language, 'en');
});

test('a hello, however it is said, is asked; a hello with something in it is acted on', async () => {
  for (const hello of ['hi there', 'Hello!! 👋', 'السلام عليكم ورحمة الله وبركاته', 'صباح الخير', 'good morning team']) {
    const h = harness({ channel: 'whatsapp' });
    const r = await h.text(hello);
    assert.equal(r.state, S.CHOOSE_LANGUAGE, hello);
  }
  const h = harness({ channel: 'whatsapp' });
  const r = await h.text('hi, I want to book');
  assert.notEqual(r.state, S.CHOOSE_LANGUAGE, 'more than a hello');
  assert.equal(r.language, 'en');
});

test('WhatsApp\'s hello arrives as a command with words: asked, then the words decide', async () => {
  const h = harness({ channel: 'whatsapp' });
  const asked = await h.command('/start', 'hi');
  assert.equal(asked.state, S.CHOOSE_LANGUAGE);

  const r = await h.command('/start', 'مرحبا');
  assert.equal(r.language, 'ar');
  assertArabicOnly(r, 'welcome');
  assert.equal(r.state, S.MAIN_MENU);
});

// ---------------------------------------------------------------------------
// Never dropping what the client sent
// ---------------------------------------------------------------------------

test('a first message with a chassis number is handled, in the language it was written in', async () => {
  for (const vin of ['WMA06XZZ8KM745219', VIN]) {
    const h = harness({ channel: 'whatsapp', clientId: null });
    const r = await h.text(vin);
    // Nothing being asked and not a menu word: the assistant answers it - in
    // English, which is what the transport is told.
    assert.equal(r.handled, false, vin);
    assert.equal(r.language, 'en', `${vin}: Latin script is English`);
    // No client row: the session carries the choice.
    assert.equal(h.session()?.language, 'en', `${vin}: kept`);
  }
});

test('"I want to book" as the very first message starts the booking - no question first', async () => {
  const h = harness({ channel: 'whatsapp' });
  const r = await h.text('I want to book');
  assert.equal(r.state, S.BOOK_CLIENT_NAME);
  assert.equal(r.language, 'en');
  assertEnglishOnly(r, 'first message');

  const ar = harness({ channel: 'whatsapp' });
  const r2 = await ar.text('عايز أحجز شحنة');
  assert.equal(r2.state, S.BOOK_CLIENT_NAME);
  assert.equal(r2.language, 'ar');
  assertArabicOnly(r2, 'first message in Arabic');
});

test('Franco-Arabic is Arabic; a hello in it is still just a hello', async () => {
  const h = harness({ channel: 'whatsapp' });
  const r = await h.text('3ayez a7gez 3arabeya');
  assert.equal(r.language, 'ar', '"3ayez a7gez" is Arabic in Latin letters');

  const g = harness({ channel: 'whatsapp' });
  const hello = await g.text('ahlan');
  assert.equal(hello.state, S.CHOOSE_LANGUAGE);

  // The assistant's own reading is unchanged by the move into lib/lang.js.
  const { detectLanguage } = await import('../lib/agent.js');
  assert.equal(detectLanguage('el sha7na fen?'), 'ar');
  assert.equal(detectLanguage('where is TESTTBLMTR2LC19'), 'en', 'a chassis number is not Franco-Arabic');
});

test('digits only: asked, asked again once, then English and the message dealt with', async () => {
  const h = harness();
  const first = await h.text('12345');
  assert.equal(first.state, S.CHOOSE_LANGUAGE, 'nothing to go on: asked');

  const again = await h.text('67890');
  assert.equal(again.state, S.CHOOSE_LANGUAGE);
  assert.match(said(again), /which language first/);
  assert.deepEqual(datas(again), ['lang:en', 'lang:ar']);
  assert.equal(h.session().context.language_asked, 2);

  const third = await h.text('😀');
  assert.equal(third.language, 'en', 'the second time, English');
  assert.equal(third.handled, false, 'and the message goes on to the assistant');
  assert.equal(h.session().current_state, S.MAIN_MENU, 'the question is closed');
  assert.equal(h.client().language, 'en');
});

test('a file or an old button sent instead of an answer is dealt with, not dropped', async () => {
  const h = harness();
  await h.command('/start');
  const r = await h.tap('menu:book');
  assert.equal(r.state, S.BOOK_CLIENT_NAME, 'the booking starts');
  assert.ok(said(r).includes(RULE), 'in both languages - nothing said which');
  assert.equal(h.client().language ?? null, null, 'and nothing was chosen for them');

  const g = harness();
  await g.command('/start');
  const filed = await g.file(g.upload('invoice'));
  assert.equal(filed.handled, true, 'a file is answered');
  assert.equal(filed.state, S.MAIN_MENU);
});

// ---------------------------------------------------------------------------
// Switching, from anywhere
// ---------------------------------------------------------------------------

test('switching language mid-booking keeps the booking and asks the open question again', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('lang:en');
  await h.tap('menu:book');
  await h.text('Nile Motors');
  await h.text(PHONE);
  const atMake = await h.text(VIN);
  assert.equal(atMake.state, S.BOOK_MAKE);
  const ref = h.booking().booking_ref;

  const r = await h.text('عربي');
  assertArabicOnly(r, 'switched');
  assert.match(said(r), /تمام، هنكمل بالعربي/);
  assert.match(said(r), /الماركة إيه؟/, 'the question that was open');
  assert.equal(r.state, S.BOOK_MAKE, 'still there');
  assert.equal(r.messages.length, 1, 'one message, not two');
  assert.equal(h.booking().booking_ref, ref);
  assert.equal(h.booking().vin, VIN, 'nothing lost');
  assert.equal(h.booking().make ?? null, null, '"عربي" is not a make');

  const next = await h.text('Volvo');
  assertArabicOnly(next, 'next question');
  assert.equal(h.booking().make, 'Volvo');
  assert.equal(next.state, S.BOOK_POL);
});

test('/language from inside a booking asks, without moving the booking', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('lang:en');
  await h.tap('menu:book');
  await h.text('Nile Motors');

  // Telegram sends a command it does not know as text; WhatsApp sends the word.
  for (const ask of [{ kind: 'text', text: '/language' }, { kind: 'command', command: '/language', text: '/language' }, { kind: 'text', text: 'اللغة' }]) {
    const r = await h.send(ask);
    assert.deepEqual(datas(r), ['lang:en', 'lang:ar'], JSON.stringify(ask));
    assert.doesNotMatch(said(r), /Welcome/, 'just the question');
    assert.equal(r.state, S.BOOK_CLIENT_PHONE, 'the booking stays put');
  }

  const r = await h.tap('lang:ar');
  assertArabicOnly(r, 'after /language');
  assert.match(said(r), /رقم الموبايل/, 'the phone question, again');
  assert.equal(r.state, S.BOOK_CLIENT_PHONE);
  // On Telegram the phone question keeps its share button, now in Arabic.
  const keyboard = r.messages.find((m) => m.keyboard)?.keyboard;
  assert.equal(keyboard?.[0]?.[0]?.text, '📱 شارك رقمي');
  assert.equal(keyboard?.[0]?.[0]?.request_contact, true);

  const direct = await h.text('/language en');
  assert.equal(direct.language, 'en', '"/language en" chooses outright');
});

test('a language button from an old message is harmless', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('lang:ar');
  await h.tap('menu:book');
  await h.text('شركة النيل');
  const before = { ...h.booking() };

  const same = await h.tap('lang:ar');
  assert.equal(same.state, S.BOOK_CLIENT_PHONE);
  assertArabicOnly(same, 'same language again');

  const other = await h.tap('lang:en');
  assert.equal(other.state, S.BOOK_CLIENT_PHONE, 'still at the phone step');
  assertEnglishOnly(other, 'switched by an old button');
  assert.equal(h.booking().booking_ref, before.booking_ref);
  assert.equal(h.booking().customer_name, before.customer_name);

  const nonsense = await h.tap('lang:fr');
  assert.deepEqual(datas(nonsense), ['lang:en', 'lang:ar'], 'an unknown one asks');
  assert.equal(nonsense.state, S.BOOK_CLIENT_PHONE);
});

test('a sentence that starts with "language" is a sentence', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('lang:en');
  const r = await h.text('Language is not a problem, can you ship to Port Said?');
  assert.equal(r.handled, false, 'the assistant answers it');
  assert.equal(r.state, S.MAIN_MENU);
});

// ---------------------------------------------------------------------------
// Never interrupting
// ---------------------------------------------------------------------------

test('a client mid-booking from before is not interrupted, and stays bilingual', async () => {
  const h = harness({ settings: [{ key: 'ask_language_first', value: false }] });
  await h.command('/start');
  await h.tap('menu:book');
  await h.text('Nile Motors');
  await h.text(PHONE);
  await h.text(VIN);

  // The deploy lands: the question is switched on, mid-booking.
  h.setSetting('ask_language_first', true);

  const r = await h.text('Mercedes-Benz');
  assert.equal(r.state, S.BOOK_POL, 'the answer is taken');
  assert.ok(said(r).includes(RULE), 'in both languages, as before');
  assert.ok(!datas(r).some((d) => d.startsWith('lang:')), 'no question');

  // Back at the menu with a draft open: still a booking under way.
  const menu = await h.command('/menu');
  assert.equal(menu.state, S.MAIN_MENU);
  assert.ok(!datas(menu).some((d) => d.startsWith('lang:')));
  assert.ok(said(menu).includes(RULE));
});

test('the setting off: never asked, both languages, as before', async () => {
  const h = harness({ settings: [{ key: 'ask_language_first', value: false }] });
  const r = await h.command('/start');
  assert.deepEqual(datas(r), ['menu:book', 'menu:track', 'menu:contact']);
  assert.ok(said(r).includes(RULE));
  // An explicit choice is still honoured.
  const chosen = await h.text('arabic');
  assert.equal(chosen.language, 'ar');
});

test('the website widget never asks, and stays bilingual', async () => {
  const h = harness({ channel: 'web' });
  for (const input of [
    { kind: 'command', command: '/start', text: '/start' },
    { kind: 'text', text: 'hi' },
    { kind: 'text', text: '12345' },
    { kind: 'text', text: 'english' },
    { kind: 'command', command: '/language', text: '/language' },
  ]) {
    const r = await h.send(input);
    assert.ok(!datas(r).some((d) => d.startsWith('lang:')), JSON.stringify(input));
    assert.notEqual(r.state, S.CHOOSE_LANGUAGE);
    assert.equal(r.language ?? null, null);
  }
  const welcome = await h.command('/start');
  assert.ok(said(welcome).includes(RULE));
});

// ---------------------------------------------------------------------------
// The migration not applied yet
// ---------------------------------------------------------------------------

test('without the language columns: never asked, bilingual, no loop, sessions still saved', async () => {
  const h = harness({ wrap: withoutLanguageColumns });

  const r = await h.command('/start');
  assert.deepEqual(datas(r), ['menu:book', 'menu:track', 'menu:contact'], 'the menu, not the question');
  assert.ok(said(r).includes(RULE));
  assert.equal(languageSupported(), false, 'learned from the failed read');

  for (const text of ['hi', 'hello', '12345', 'عربي']) {
    const again = await h.text(text);
    assert.ok(!datas(again).some((d) => d.startsWith('lang:')), `${text}: never asked`);
    assert.notEqual(again.state, S.CHOOSE_LANGUAGE);
  }

  // An old language button: the menu, as it is.
  const stale = await h.tap('lang:ar');
  assert.ok(said(stale).includes(RULE));

  // And the conversation still moves and is still saved - without the column.
  const booked = await h.tap('menu:book');
  assert.equal(booked.state, S.BOOK_CLIENT_NAME);
  const row = h.session();
  assert.equal(row.current_state, S.BOOK_CLIENT_NAME);
  assert.equal('language' in row, false, 'never named in a write');
});

// ---------------------------------------------------------------------------
// One language, all the way through
// ---------------------------------------------------------------------------

test('an Arabic booking is Arabic from the menu to the card - no English half anywhere', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('lang:ar');
  const replies = await bookToCard(h, { name: 'شركة النيل' });

  replies.forEach((r, i) => assertArabicOnly(r, `step ${i}`));
  const card = said(replies[replies.length - 1]);
  assert.match(card, /راجع بيانات الحجز/);
  assert.match(card, /العميل: شركة النيل/);
  assert.match(card, /Vilnius ← Alexandria Port/, 'the Arabic arrow');
  assert.doesNotMatch(card, /Please confirm|Client|Route/);
  assert.equal(replies[replies.length - 1].state, S.BOOK_FINAL_CONFIRMATION);

  const done = await h.tap('bk:confirm');
  assertArabicOnly(done, 'submitted');
  assert.match(said(done), /اتأكد طلب الحجز/);
});

test('an English booking is English from the menu to the card - no Arabic anywhere', async () => {
  const h = harness({ channel: 'whatsapp' });
  await h.command('/start', 'hi');
  await h.tap('lang:en');
  const replies = await bookToCard(h);

  replies.forEach((r, i) => assertEnglishOnly(r, `step ${i}`));
  const card = said(replies[replies.length - 1]);
  assert.match(card, /Please confirm your booking details/);
  assert.match(card, /Route: Vilnius → Alexandria Port/);
});

test('before a choice, every message and card is exactly as bilingual as before', async () => {
  const h = harness({ settings: [{ key: 'ask_language_first', value: false }] });
  await h.command('/start');
  const replies = await bookToCard(h);
  const card = said(replies[replies.length - 1]);
  assert.match(card, /📋 راجع بيانات الحجز من فضلك\n📋 Please confirm your booking details/);
  assert.match(card, /👤 العميل \/ Client: Nile Motors/);
  assert.match(card, /🌍 خط الشحن \/ Route: Vilnius → Alexandria Port/);
  assert.match(card, /✅ الفاتورة التجارية \/ Invoice/);
  for (const r of replies) {
    for (const m of r.messages) {
      if (/[A-Za-z]{4}/.test(m.text) && ARABIC.test(m.text)) continue;   // both halves present
      assert.fail(`a message missing a half: ${m.text}`);
    }
  }
});

// ---------------------------------------------------------------------------
// WhatsApp's phone step
// ---------------------------------------------------------------------------

test('on WhatsApp the phone step offers the number being written from', async () => {
  const h = harness({ channel: 'whatsapp' });
  await h.command('/start', 'hi');
  await h.tap('lang:en');
  await h.tap('menu:book');
  const asked = await h.text('Nile Motors');

  assert.equal(asked.state, S.BOOK_CLIENT_PHONE);
  assert.ok(asked.messages.every((m) => !m.keyboard), 'no Telegram reply keyboard');
  assert.deepEqual(datas(asked), ['bk:phone:use', 'bk:phone:other', 'menu:home']);
  // The number is said in full in the question; the button only has room to
  // point at it - cut to 20 characters it hid the digits being confirmed.
  assert.deepEqual(buttons(asked).map((b) => b.title), ['Use this number', 'Another number', 'Main menu']);
  assert.doesNotMatch(said(asked), /Share my number/);
  assert.match(said(asked), /the number you are writing from \(\+20 100 555 1234\)/);

  const used = await h.tap('bk:phone:use');
  assert.equal(h.booking().customer_contact, '+201005551234', 'the sender\'s number, in the one stored shape');
  assert.equal(used.state, S.BOOK_VIN);

  // From an older message, the button is stale: the open question again.
  const stale = await h.tap('bk:phone:use');
  assert.equal(stale.state, S.BOOK_VIN);
  assert.match(said(stale), /VIN \/ Chassis number/);
});

test('on WhatsApp "Another number" asks for it, and "yes" means the number being written from', async () => {
  const h = harness({ channel: 'whatsapp' });
  await h.command('/start', 'hi');
  await h.tap('lang:ar');
  await h.tap('menu:book');
  const asked = await h.text('شركة النيل');
  assertArabicOnly(asked, 'Arabic phone step');
  assert.doesNotMatch(said(asked), /شارك رقمي/);
  assert.equal(buttons(asked)[0].title.length <= 20, true);

  const other = await h.tap('bk:phone:other');
  assert.equal(other.state, S.BOOK_CLIENT_PHONE);
  assert.match(said(other), /اكتب رقمك/);

  const typed = await h.text('+49 176 67221612');
  assert.equal(typed.state, S.BOOK_VIN);
  assert.equal(h.booking().customer_contact, '+4917667221612');

  const g = harness({ channel: 'whatsapp' });
  await g.command('/start', 'hi');
  await g.tap('lang:en');
  await g.tap('menu:book');
  await g.text('Nile Motors');
  const yes = await g.text('yes');
  assert.equal(yes.state, S.BOOK_VIN);
  assert.equal(g.booking().customer_contact, '+201005551234');
});

test('on WhatsApp the edited number is offered the same way', async () => {
  const h = harness({ channel: 'whatsapp' });
  await h.command('/start', 'hi');
  await h.tap('lang:en');
  await bookToCard(h);
  const edit = await h.tap('bk:edit:phone');
  assert.equal(edit.state, S.BOOK_EDIT_CLIENT_PHONE);
  assert.deepEqual(datas(edit).slice(0, 2), ['bk:phone:use', 'bk:phone:other']);

  const r = await h.tap('bk:phone:use');
  assert.equal(r.state, S.BOOK_FINAL_CONFIRMATION, 'back to the card');
});

test('on Telegram the phone step is unchanged: the share button', async () => {
  const h = harness();
  await h.command('/start');
  await h.tap('lang:en');
  await h.tap('menu:book');
  const asked = await h.text('Nile Motors');
  const keyboard = asked.messages.find((m) => m.keyboard)?.keyboard;
  assert.equal(keyboard[0][0].text, '📱 Share my number');
  assert.equal(keyboard[0][0].request_contact, true);
  assert.match(said(asked), /Share my number/);

  // And the WhatsApp buttons mean nothing here: there is no sender's number
  // to use, so the number is simply asked for.
  const before = h.booking().customer_contact;
  const stray = await h.tap('bk:phone:use');
  assert.equal(stray.state, S.BOOK_CLIENT_PHONE);
  assert.equal(h.booking().customer_contact, before);
  assert.match(said(stray), /type your number/);
});

test('on WhatsApp an agent is reached with the number being written from - never asked for it', async () => {
  const h = harness({ channel: 'whatsapp' });
  await h.command('/start', 'hi');
  await h.tap('lang:en');
  const r = await h.tap('menu:contact');
  assert.ok(r.messages.every((m) => !m.keyboard), 'no share keyboard');
  assert.match(said(r), /I have your number \(\+201005551234\)/);
});

// ---------------------------------------------------------------------------
// Wording per channel
// ---------------------------------------------------------------------------

test('WhatsApp wording names words, not slash commands', async () => {
  const wa = harness({ channel: 'whatsapp' });
  await wa.command('/start', 'hi');
  await wa.tap('lang:en');
  const help = await wa.command('/help', 'help');
  assert.match(said(help), /^menu - the main menu$/m);
  assert.match(said(help), /^language - English or Arabic$/m);
  assert.doesNotMatch(said(help), /\/menu|\/start/);

  const lost = await withTurn({ lang: 'en', channel: 'whatsapp' }, () => M.notUnderstood());
  assert.match(lost, /send "menu"/);

  const tg = harness();
  await tg.command('/start');
  await tg.tap('lang:en');
  const tgHelp = await tg.command('/help');
  assert.match(said(tgHelp), /\/start or \/menu/);
  assert.match(said(tgHelp), /\/language - English or Arabic/);
});

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

const KEYBOARDS = {
  mainMenu: () => kb.mainMenu(),
  homeOnly: () => kb.homeOnly(),
  languageChoice: () => kb.languageChoice(),
  resumeDraft: () => kb.resumeDraft(),
  alreadyBooked: () => kb.alreadyBooked(),
  mrnChoice: () => kb.mrnChoice(),
  documentStep: () => kb.documentStep({ canSkip: true }),
  classifyDocument: () => kb.classifyDocument(['invoice', 'brief', 'mrn', 'acid', 'eur1', 'certificate_of_origin_form_a']),
  confirmBooking: () => kb.confirmBooking(),
  editMenu: () => kb.editMenu(),
  cancelConfirm: () => kb.cancelConfirm(),
  afterSubmitted: () => kb.afterSubmitted(),
  afterConfirmed: () => kb.afterConfirmed(),
  phoneChoiceEgypt: () => kb.phoneChoice('+201005551234'),
  phoneChoiceLong: () => kb.phoneChoice('+491766722161234'),
  trackingNotFound: () => kb.trackingNotFound(),
  trackingFound: () => kb.trackingFound('MKY-BKG-261007-A1'),
  contactMenu: () => kb.contactMenu(),
  urgencyChoice: () => kb.urgencyChoice(),
  documentsHelpMenu: () => kb.documentsHelpMenu(),
  errorRecovery: () => kb.errorRecovery(),
};

test('every button carries a WhatsApp title of 20 characters or fewer, in every language', () => {
  for (const lang of [null, 'en', 'ar']) {
    for (const [name, build] of Object.entries(KEYBOARDS)) {
      const rows = withLanguage(lang, build);
      for (const b of rows.flat()) {
        assert.equal(typeof b.title, 'string', `${name}/${lang}`);
        assert.ok(b.title.length > 0 && b.title.length <= kb.MAX_TITLE_CHARS, `${name}/${lang}: "${b.title}"`);
        assert.ok(Buffer.byteLength(b.callback_data) <= 64, `${name}/${lang}: ${b.callback_data}`);
        if (lang === 'en' && name !== 'languageChoice') assert.doesNotMatch(`${b.text} ${b.title}`, ARABIC, `${name}: "${b.text}"`);
        if (lang) assert.ok(!b.text.includes(' / '), `${name}/${lang}: one language - "${b.text}"`);
      }
    }
  }
});

test('before a choice the buttons read exactly as they did', () => {
  const labels = (rows) => rows.flat().map((b) => b.text);
  assert.deepEqual(labels(kb.mainMenu()), [
    '📦 احجز شحنة / Book my shipment', '🚚 تتبع شحنتي / Track my shipment', '💬 كلّم موظف / Talk to an agent',
  ]);
  assert.deepEqual(labels(kb.cancelConfirm()), ['نعم، ألغِ / Yes, cancel it', 'لا، كمّل / No, keep going']);
  assert.deepEqual(labels(kb.classifyDocument(['mrn'])), ['📄 MRN', '🚫 مش من دول / None of these']);
  assert.deepEqual(kb.sharePhoneKeyboard(), [
    [{ text: '📱 شارك رقمي / Share my number', request_contact: true }],
    [{ text: '✏️ هكتبه بنفسي / I will type it' }],
  ]);
  // Bilingual titles are the English ones.
  assert.deepEqual(kb.mrnChoice().flat().map((b) => b.title), ['I have an MRN', 'MKY issues my MRN', 'Main menu']);
});

test('a title too long for WhatsApp is refused at build time', () => {
  assert.throws(() => kb.cb('x', 'menu:home', 'A title far too long for WhatsApp'), /title too long/);
  assert.throws(() => kb.cb('x', `tr:refresh:${'X'.repeat(80)}`, 'ok'), /callback_data too long/);
  // Built without a title, the English words are used - and must fit too.
  assert.equal(kb.cb('🏠 القائمة الرئيسية / Main menu', 'menu:home').title, 'Main menu');
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

test('a WhatsApp chat id is never written as a Telegram one', async () => {
  const wa = harness({ channel: 'whatsapp' });
  await wa.command('/start', 'hi');
  assert.equal(wa.session().telegram_chat_id, null);
  assert.equal(wa.session().chat_id, `wa:${WA}`);

  const tg = harness();
  await tg.command('/start');
  assert.equal(tg.session().telegram_chat_id, 555);
});

test('a transport that already knows the language is believed when nothing is stored', async () => {
  const h = harness({ channel: 'whatsapp' });
  h.ctx.language = 'ar';
  const r = await h.command('/start', 'hi');
  assert.equal(r.language, 'ar');
  assert.equal(r.state, S.MAIN_MENU, 'not asked: the language is known');
  assertArabicOnly(r, 'welcome');
});

// ---------------------------------------------------------------------------
// Outside the flow: cards, the assistant, paperwork
// ---------------------------------------------------------------------------

test('cards for the assistant follow the turn\'s language', () => {
  const s = {
    shipment_id: 'MKY-26001', make: 'Volvo', model: 'FH', vin: VIN, status: 'At sea', vessel: 'MSC Aurora',
    origin_port: 'Klaipeda', destination_port: 'Alexandria', eta: '2026-10-20', recent_events: [],
  };
  assert.match(shipmentCard(s), /الحالة \/ Status: At sea/, 'both before a choice');
  assert.match(shipmentCard(s), /Klaipeda → Alexandria/);
  const ar = withLanguage('ar', () => shipmentCard(s));
  assert.match(ar, /^الحالة: At sea$/m);
  assert.match(ar, /Klaipeda ← Alexandria/);
  assert.doesNotMatch(ar, /Status|Vessel/);
  const en = withLanguage('en', () => shipmentCard(s));
  assert.match(en, /^Status: At sea$/m);
  assert.doesNotMatch(en, ARABIC);

  const docs = { received: ['Invoice', 'Brief'], missing_labels: ['MRN', 'ACID'] };
  assert.match(withLanguage('ar', () => documentsCard(docs)), /وصلنا: Invoice، Brief/);
  assert.match(documentsCard(docs), /وصلنا \/ Received: Invoice, Brief/);

  // The department card is recognised in the language it was sent in.
  const arabicCard = withLanguage('ar', () => departmentsCard());
  assert.doesNotMatch(arabicCard, /Contact our team/);
  assert.equal(contactIntent('2', arabicCard), 'answer');
  assert.equal(contactIntent('2', departmentsCard()), 'answer');
});

test('the assistant answers in the chosen language only', () => {
  const both = 'الشحنة في الطريق | Your shipment is on its way';
  assert.match(splitLanguages(both), /━/, 'both, stacked, before a choice');
  assert.equal(withLanguage('ar', () => splitLanguages(both)), 'الشحنة في الطريق');
  assert.equal(withLanguage('en', () => splitLanguages(both)), 'Your shipment is on its way');

  const arPrompt = withTurn({ lang: 'ar', channel: 'whatsapp' }, () => systemPrompt({}));
  assert.match(arPrompt, /ARABIC ONLY/);
  assert.match(arPrompt, /customers on WhatsApp/);
  assert.match(arPrompt, /send "menu"/);
  assert.doesNotMatch(arPrompt, /EVERY REPLY CARRIES BOTH/);
  // The rule the whole design rests on is untouched.
  assert.match(arPrompt, /BOOKING - NOT YOURS TO DO/);

  const enPrompt = withTurn({ lang: 'en', channel: 'telegram' }, () => systemPrompt({}));
  assert.match(enPrompt, /ENGLISH ONLY/);
  assert.match(enPrompt, /send \/book/);

  assert.match(systemPrompt({ channel: 'telegram' }), /EVERY REPLY CARRIES BOTH/, 'unchanged before a choice');
});

test('paperwork follows the client\'s choice when the caller has it', () => {
  const booking = { customer_name: 'شركة النيل' };
  assert.equal(bookingLanguage(booking), 'ar', 'from the script, as before');
  assert.equal(bookingLanguage(booking, 'en'), 'en', 'the choice wins');
  assert.equal(bookingLanguage({ customer_name: 'Nile Motors' }, 'ar'), 'ar');
  assert.equal(bookingLanguage({ customer_name: 'Nile Motors' }, 'xx'), 'en', 'nonsense is no choice');
});

test('rendered outside any turn, a message is bilingual - the outbox before it learns the client\'s language', () => {
  assert.match(M.welcome('Arif'), /━/);
  assert.match(withLanguage('en', () => M.welcome('Arif')), /^👋 Welcome Arif/);
  assert.doesNotMatch(withLanguage('en', () => M.welcome('Arif')), ARABIC);
});
