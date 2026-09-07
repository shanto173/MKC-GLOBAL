/**
 * Inline keyboards, and the callback payloads behind them.
 *
 * Telegram caps callback_data at 64 BYTES and silently refuses the whole
 * keyboard if one button exceeds it, so every payload here is a short prefixed
 * code rather than anything human-readable, and `cb()` asserts the limit at
 * build time instead of letting a keyboard vanish in production.
 *
 * A callback payload is untrusted input: it comes back from a client who can
 * replay an old message's buttons at any time. Nothing here carries authority -
 * the payload says which button was pressed, and the state machine decides
 * whether that is a legal move from the state the conversation is actually in.
 */

const MAX_CALLBACK_BYTES = 64;

/** One button. Throws in development if the payload would be silently dropped. */
export function cb(text, data) {
  const bytes = Buffer.byteLength(String(data), 'utf8');
  if (bytes > MAX_CALLBACK_BYTES) {
    throw new Error(`callback_data too long (${bytes}b > ${MAX_CALLBACK_BYTES}): ${data}`);
  }
  return { text, callback_data: String(data) };
}

/** Parses "bk:edit:vin" into { ns: 'bk', action: 'edit', arg: 'vin' }. */
export function parseCallback(data) {
  const raw = String(data ?? '');
  const [ns = '', action = '', ...rest] = raw.split(':');
  return { ns, action, arg: rest.join(':'), raw };
}

const rows = (...buttons) => buttons.map((b) => (Array.isArray(b) ? b : [b]));

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------

export const MENU_HOME = cb('🏠 القائمة الرئيسية / Main menu', 'menu:home');

export function mainMenu() {
  return rows(
    cb('📦 احجز شحنة / Book my shipment', 'menu:book'),
    cb('🚚 تتبع شحنتي / Track my shipment', 'menu:track'),
    cb('💬 تواصل مع فريقنا / Contact our team', 'menu:contact'),
  );
}

export function homeOnly() {
  return rows(MENU_HOME);
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

/** Offered when a client starts a booking while an unfinished one exists. */
export function resumeDraft() {
  return rows(
    cb('▶️ كمّل الطلب / Continue booking', 'bk:draft:continue'),
    cb('🔄 ابدأ من جديد / Start over', 'bk:draft:restart'),
    MENU_HOME,
  );
}

export function alreadyBooked() {
  return rows(
    cb('🚚 تتبع الشحنة / Track shipment', 'menu:track'),
    MENU_HOME,
  );
}

export function mrnChoice() {
  return rows(
    cb('1️⃣ عندي MRN / I already have an MRN', 'bk:mrn:existing'),
    cb('2️⃣ MKY تستخرجه / I need MKY to issue the MRN', 'bk:mrn:mky_issue'),
    MENU_HOME,
  );
}

/** Shown while documents are outstanding, so a client is never trapped. */
export function documentStep({ canSkip = false } = {}) {
  const buttons = [];
  if (canSkip) buttons.push(cb('⏭️ أكمل من غيرها / Continue without them', 'bk:docs:later'));
  buttons.push(cb('❌ إلغاء الطلب / Cancel request', 'bk:cancel:ask'));
  buttons.push(MENU_HOME);
  return rows(...buttons);
}

/** When a file arrives that we cannot classify, the client tells us what it is. */
export function classifyDocument(types) {
  const buttons = types.map((t) => cb(labelFor(t), `bk:doctype:${t}`));
  buttons.push(cb('🚫 مش من دول / None of these', 'bk:doctype:other'));
  return rows(...buttons);
}

function labelFor(type) {
  const map = {
    invoice: '🧾 الفاتورة / Invoice',
    brief: '📑 مستند النقل / Brief',
    mrn: '📄 MRN',
    acid: '🆔 ACID',
    eur1: '📜 EUR.1',
  };
  return map[type] ?? type;
}

export function confirmBooking() {
  return rows(
    cb('✅ أكّد / Confirm', 'bk:confirm'),
    cb('✏️ عدّل البيانات / Edit information', 'bk:edit'),
    cb('❌ إلغاء / Cancel', 'bk:cancel:ask'),
  );
}

export function editMenu() {
  return rows(
    cb('1️⃣ الشاسيه / Chassis · VIN', 'bk:edit:vin'),
    cb('2️⃣ الماركة / Make', 'bk:edit:make'),
    cb('3️⃣ اسم العميل / Client name', 'bk:edit:customer_name'),
    cb('4️⃣ خط الشحن / Route', 'bk:edit:route'),
    cb('5️⃣ المستندات / Documents', 'bk:edit:documents'),
    cb('6️⃣ رجوع للمراجعة / Back to confirmation', 'bk:edit:back'),
  );
}

export function cancelConfirm() {
  return rows(
    cb('نعم، ألغِ / Yes, cancel it', 'bk:cancel:yes'),
    cb('لا، كمّل / No, keep going', 'bk:cancel:no'),
  );
}

export function afterSubmitted() {
  return rows(
    cb('🚚 تتبع الشحنة / Track shipment', 'menu:track'),
    cb('📦 احجز وحدة تانية / Book another', 'menu:book'),
    MENU_HOME,
  );
}

/** Sent with the "your booking is confirmed" message from Operations. */
export function afterConfirmed() {
  return afterSubmitted();
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

export function trackingNotFound() {
  return rows(
    cb('🔄 جرب تاني / Try again', 'tr:retry'),
    cb('💬 تواصل مع فريقنا / Contact our team', 'menu:contact'),
    MENU_HOME,
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
  if (key) buttons.push(cb('🔄 حدّث الحالة / Refresh status', `tr:refresh:${key}`));
  buttons.push(cb('👨‍💼 تواصل مع العمليات / Contact Operations', 'ct:ops'));
  buttons.push(MENU_HOME);
  return rows(...buttons);
}

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

export function contactMenu() {
  return rows(
    cb('1️⃣ 📦 الحجز / Booking', 'ct:booking'),
    cb('2️⃣ 🚚 تتبع الشحنة / Shipment tracking', 'ct:tracking'),
    cb('3️⃣ 📄 المستندات / Documents', 'ct:docs'),
    cb('4️⃣ 👨‍💼 كلّم العمليات / Talk to Operations', 'ct:ops'),
  );
}

export function documentsHelpMenu() {
  return rows(
    cb('1️⃣ رفع مستندات / Upload documents', 'ct:docs:upload'),
    cb('2️⃣ المستندات الناقصة / Missing documents', 'ct:docs:missing'),
    cb('3️⃣ طلب مستند / Request a document', 'ct:docs:request'),
    cb('4️⃣ حاجة تانية / Other', 'ct:docs:other'),
    MENU_HOME,
  );
}

export function errorRecovery() {
  return rows(
    cb('🔄 جرب تاني / Try again', 'menu:retry'),
    MENU_HOME,
    cb('💬 تواصل مع فريقنا / Contact our team', 'menu:contact'),
  );
}

/**
 * The one keyboard that is NOT inline: Telegram only hands a bot a verified
 * phone number through a reply-keyboard contact button, so this stays a reply
 * keyboard. It is one-time, so it does not sit under the chat afterwards.
 */
export const SHARE_PHONE_KEYBOARD = [
  [{ text: '📱 شارك رقمي / Share my number', request_contact: true }],
  [{ text: '✏️ هكتبه بنفسي / I will type it' }],
];
