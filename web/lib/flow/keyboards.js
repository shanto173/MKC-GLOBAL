/**
 * Inline keyboards, and the callback payloads behind them.
 *
 * Telegram caps callback_data at 64 BYTES and silently refuses the whole
 * keyboard if one button exceeds it, so every payload here is a short prefixed
 * code rather than anything human-readable, and `cb()` asserts the limit at
 * build time instead of letting a keyboard vanish in production.
 *
 * WhatsApp has its own ceiling, on what the button SAYS: a reply button's
 * title is at most 20 characters (a list row's, 24), and a message carrying a
 * longer one is refused whole. So every button also carries a `title` - short,
 * one language - and `cb()` asserts that too. The transport renders `title` on
 * WhatsApp and `text` everywhere else.
 *
 * Labels follow the turn's language (lib/lang.js): one language once the client
 * has chosen, both - "عربي / English" - until then, exactly as they always
 * read. Which is why nothing here is a module-level constant any more: a
 * constant is built at import, outside any turn, and would be bilingual for
 * everyone.
 *
 * A callback payload is untrusted input: it comes back from a client who can
 * replay an old message's buttons at any time. Nothing here carries authority -
 * the payload says which button was pressed, and the state machine decides
 * whether that is a legal move from the state the conversation is actually in.
 */

import { currentLanguage } from '../lang.js';
import { displayPhone } from '../phone.js';

const MAX_CALLBACK_BYTES = 64;

/** WhatsApp's limit for a reply button's title; a list row allows 24. */
export const MAX_TITLE_CHARS = 20;

/**
 * One button. Throws if the payload would be silently dropped. Throws, too, in
 * development and tests if WhatsApp would refuse the title; in production an
 * over-long title is cut instead - a button reading "Continue without th…"
 * beats a message that never arrives - and the log says so.
 *
 * @param {string} text  what Telegram and the website show
 * @param {string} data  the callback payload
 * @param {string} [title] what WhatsApp shows; taken from `text` when omitted
 */
export function cb(text, data, title = null) {
  const bytes = Buffer.byteLength(String(data), 'utf8');
  if (bytes > MAX_CALLBACK_BYTES) {
    throw new Error(`callback_data too long (${bytes}b > ${MAX_CALLBACK_BYTES}): ${data}`);
  }

  let short = String(title ?? titleFrom(text)).trim();
  if (short.length > MAX_TITLE_CHARS) {
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(`button title too long (${short.length} > ${MAX_TITLE_CHARS}): ${short}`);
    }
    console.error(`button title cut to ${MAX_TITLE_CHARS} characters: ${short}`);
    short = fit(short);
  }
  return { text, callback_data: String(data), title: short };
}

/** Parses "bk:edit:vin" into { ns: 'bk', action: 'edit', arg: 'vin' }. */
export function parseCallback(data) {
  const raw = String(data ?? '');
  const [ns = '', action = '', ...rest] = raw.split(':');
  return { ns, action, arg: rest.join(':'), raw };
}

const rows = (...buttons) => buttons.map((b) => (Array.isArray(b) ? b : [b]));

/** Cut to a WhatsApp title, with an ellipsis so the cut is visible. */
function fit(text, max = MAX_TITLE_CHARS) {
  const s = String(text ?? '').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** A title for a button built without one: the English words, no emoji. */
function titleFrom(text) {
  const s = String(text ?? '');
  const english = s.includes(' / ') ? s.slice(s.lastIndexOf(' / ') + 3) : s;
  return english.replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

/**
 * The words on a button, in the turn's language. Before a choice, both, the
 * way they always read; a word that is the same in both ("MRN") once.
 */
function label(ar, en, emoji = '') {
  const lang = currentLanguage();
  const words = lang === 'ar' ? ar : lang === 'en' ? en : ar === en ? en : `${ar} / ${en}`;
  return emoji ? `${emoji} ${words}` : words;
}

/** The WhatsApp title: Arabic for an Arabic conversation, English otherwise. */
function title(ar, en) {
  return currentLanguage() === 'ar' ? ar : en;
}

/**
 * One button in the turn's language. `short` holds the titles for labels too
 * long to be one - "I already have an MRN" is 21 characters.
 */
function button(emoji, ar, en, data, short = {}) {
  return cb(label(ar, en, emoji), data, title(short.ar ?? ar, short.en ?? en));
}

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------

export function homeButton() {
  return button('🏠', 'القائمة الرئيسية', 'Main menu', 'menu:home');
}

/**
 * The third button goes straight to a person. "Other question or help = agent
 * right away" is how MKY put it, and a menu of four things to pick from first
 * is the opposite of right away.
 */
export function agentButton() {
  return button('💬', 'كلّم موظف', 'Talk to an agent', 'menu:contact');
}

export function mainMenu() {
  return rows(
    button('📦', 'احجز شحنة', 'Book my shipment', 'menu:book'),
    button('🚚', 'تتبع شحنتي', 'Track my shipment', 'menu:track'),
    agentButton(),
  );
}

export function homeOnly() {
  return rows(homeButton());
}

/**
 * The language question. Each choice is written in its own language, because
 * it is read by someone who has not chosen yet.
 */
export function languageChoice() {
  return rows([
    cb('English', 'lang:en', 'English'),
    cb('العربية', 'lang:ar', 'العربية'),
  ]);
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

/** Offered when a client starts a booking while an unfinished one exists. */
export function resumeDraft() {
  return rows(
    button('▶️', 'كمّل الطلب', 'Continue booking', 'bk:draft:continue'),
    button('🔄', 'ابدأ من جديد', 'Start over', 'bk:draft:restart'),
    homeButton(),
  );
}

export function alreadyBooked() {
  return rows(
    button('🚚', 'تتبع الشحنة', 'Track shipment', 'menu:track'),
    homeButton(),
  );
}

export function mrnChoice() {
  return rows(
    button('1️⃣', 'عندي MRN', 'I already have an MRN', 'bk:mrn:existing', { en: 'I have an MRN' }),
    button('2️⃣', 'MKY تستخرجه', 'I need MKY to issue the MRN', 'bk:mrn:mky_issue', { en: 'MKY issues my MRN' }),
    homeButton(),
  );
}

/** Shown while documents are outstanding, so a client is never trapped. */
export function documentStep({ canSkip = false } = {}) {
  const buttons = [];
  if (canSkip) {
    buttons.push(button('⏭️', 'أكمل من غيرها', 'Continue without them', 'bk:docs:later', { en: 'Skip for now' }));
  }
  buttons.push(button('❌', 'إلغاء الطلب', 'Cancel request', 'bk:cancel:ask'));
  buttons.push(homeButton());
  return rows(...buttons);
}

/** When a file arrives that we cannot classify, the client tells us what it is. */
export function classifyDocument(types) {
  const buttons = types.map((t) => labelFor(t));
  buttons.push(button('🚫', 'مش من دول', 'None of these', 'bk:doctype:other'));
  return rows(...buttons);
}

function labelFor(type) {
  const map = {
    invoice: ['🧾', 'الفاتورة', 'Invoice'],
    brief: ['📑', 'مستند النقل', 'Brief'],
    mrn: ['📄', 'MRN', 'MRN'],
    acid: ['🆔', 'ACID', 'ACID'],
    eur1: ['📜', 'EUR.1', 'EUR.1'],
  };
  const known = map[type];
  // A type the settings name but this table does not is shown as it is
  // spelled there, and its title cut to fit rather than refused.
  if (!known) return cb(String(type), `bk:doctype:${type}`, fit(type));
  const [emoji, ar, en] = known;
  return button(emoji, ar, en, `bk:doctype:${type}`);
}

export function confirmBooking() {
  return rows(
    button('✅', 'أكّد', 'Confirm', 'bk:confirm'),
    button('✏️', 'عدّل البيانات', 'Edit information', 'bk:edit'),
    button('❌', 'إلغاء', 'Cancel', 'bk:cancel:ask'),
  );
}

export function editMenu() {
  return rows(
    button('1️⃣', 'اسم العميل', 'Client name', 'bk:edit:customer_name'),
    button('2️⃣', 'رقم الموبايل', 'Mobile number', 'bk:edit:phone'),
    button('3️⃣', 'الشاسيه', 'Chassis · VIN', 'bk:edit:vin'),
    button('4️⃣', 'الماركة', 'Make', 'bk:edit:make'),
    button('5️⃣', 'خط الشحن', 'Route', 'bk:edit:route'),
    button('6️⃣', 'المستندات', 'Documents', 'bk:edit:documents'),
    button('7️⃣', 'رجوع للمراجعة', 'Back to confirmation', 'bk:edit:back', { en: 'Back to summary' }),
  );
}

export function cancelConfirm() {
  return rows(
    button('', 'نعم، ألغِ', 'Yes, cancel it', 'bk:cancel:yes'),
    button('', 'لا، كمّل', 'No, keep going', 'bk:cancel:no'),
  );
}

export function afterSubmitted() {
  return rows(
    button('🚚', 'تتبع الشحنة', 'Track shipment', 'menu:track'),
    button('📦', 'احجز وحدة تانية', 'Book another', 'menu:book'),
    homeButton(),
  );
}

/** Sent with the "your booking is confirmed" message from Operations. */
export function afterConfirmed() {
  return afterSubmitted();
}

/**
 * The phone question on WhatsApp.
 *
 * WhatsApp has no "share my number" button - and needs none: the client is
 * writing FROM their number, so it is offered back to them. `number` is the
 * sender's number in international form, "+201005551234".
 */
/**
 * WhatsApp's answer to the phone question. The number itself is in the
 * question (M.askPhone), not on the button: a 20-character title cut
 * "استخدم +20 100 555 1234" to "استخدم +20 100 555…", which asked the client
 * to confirm a number they could not see the end of.
 */
export function phoneChoice(number) {
  const shown = displayPhone(number);
  return rows(
    cb(label(`استخدم ${shown}`, `Use ${shown}`, '📱'), 'bk:phone:use', title('استخدم الرقم ده', 'Use this number')),
    button('✏️', 'رقم تاني', 'Another number', 'bk:phone:other'),
    homeButton(),
  );
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

export function trackingNotFound() {
  return rows(
    button('🔄', 'جرب تاني', 'Try again', 'tr:retry'),
    agentButton(),
    homeButton(),
  );
}

/**
 * The reference is carried in the payload so Refresh re-queries the database
 * for THAT shipment rather than replaying whatever the conversation last said.
 * Trimmed to fit the 64-byte ceiling; a reference longer than this cannot be
 * refreshed by button and falls back to the client typing it again.
 */
export function trackingFound(reference) {
  const key = String(reference ?? '').slice(0, 40);
  const buttons = [];
  if (key) buttons.push(button('🔄', 'حدّث الحالة', 'Refresh status', `tr:refresh:${key}`));
  buttons.push(agentButton());
  buttons.push(homeButton());
  return rows(...buttons);
}

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

export function contactMenu() {
  return rows(
    button('1️⃣ 📦', 'الحجز', 'Booking', 'ct:booking'),
    button('2️⃣ 🚚', 'تتبع الشحنة', 'Shipment tracking', 'ct:tracking'),
    button('3️⃣ 📄', 'المستندات', 'Documents', 'ct:docs'),
    button('4️⃣ 👨‍💼', 'كلّم العمليات', 'Talk to Operations', 'ct:ops'),
  );
}

/** After hours: does this wait for the desk, or does the client need someone now? */
export function urgencyChoice() {
  return rows(
    button('🚨', 'أيوه، مستعجل', 'Yes, it is urgent', 'ct:urgent:yes'),
    button('🕘', 'لا، يستنى لبكرة', 'No, it can wait', 'ct:urgent:no'),
    homeButton(),
  );
}

export function documentsHelpMenu() {
  return rows(
    button('1️⃣', 'رفع مستندات', 'Upload documents', 'ct:docs:upload'),
    button('2️⃣', 'المستندات الناقصة', 'Missing documents', 'ct:docs:missing'),
    button('3️⃣', 'طلب مستند', 'Request a document', 'ct:docs:request'),
    button('4️⃣', 'حاجة تانية', 'Other', 'ct:docs:other'),
    homeButton(),
  );
}

export function errorRecovery() {
  return rows(
    button('🔄', 'جرب تاني', 'Try again', 'menu:retry'),
    homeButton(),
    agentButton(),
  );
}

/**
 * The one keyboard that is NOT inline: Telegram only hands a bot a verified
 * phone number through a reply-keyboard contact button, so this stays a reply
 * keyboard. It is one-time, so it does not sit under the chat afterwards.
 * Telegram only - WhatsApp has no such button (see phoneChoice).
 */
export function sharePhoneKeyboard() {
  return [
    [{ text: label('شارك رقمي', 'Share my number', '📱'), request_contact: true }],
    [{ text: label('هكتبه بنفسي', 'I will type it', '✏️') }],
  ];
}
