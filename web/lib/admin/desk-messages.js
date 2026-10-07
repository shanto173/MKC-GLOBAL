/**
 * The words the desk puts in front of a customer, and the words it uses to
 * explain to an operator why something did not reach them.
 *
 * THE PREVIEW IS THE MESSAGE. Before anything is sent the operator is shown it,
 * in the customer's language. That promise only holds if the preview is made
 * by the same code that makes the message, so for anything the outbox sends
 * this calls the outbox's own renderer, inside the customer's language; and
 * for the two messages the desk composes itself (a shipment update, a reply)
 * the composing function here is also the one the sender uses.
 */

import { render } from '../outbox.js';
import { withTurn } from '../lang.js';
import { both } from '../flow/messages.js';
import { splitLanguages } from '../agent.js';
import { DOC_LABEL } from '../ops/workflow.js';

/** One language, or both stacked the way the bot speaks before a choice is made. */
export function inLanguage(language, ar, en) {
  if (language === 'ar') return ar;
  if (language === 'en') return en;
  return both(ar, en);
}

// ---------------------------------------------------------------------------
// Document replacement
// ---------------------------------------------------------------------------

const DOC_AR = {
  invoice: 'الفاتورة',
  brief: 'مستند النقل (CMR أو البوليصة)',
  mrn: 'مستند الـ MRN',
  acid: 'شهادة ACID',
  eur1: 'شهادة EUR.1',
  other: 'المستند',
};

/** The reasons offered when asking for a new copy, in the order the desk lists them. */
export const REPLACEMENT_REASONS = [
  { code: 'unreadable', words: 'Unreadable', en: 'the one we have is unreadable', ar: 'النسخة اللي عندنا مش مقروءة' },
  { code: 'wrong_vin', words: 'Wrong vehicle (chassis differs)', en: 'the one we have is for a different chassis', ar: 'النسخة اللي عندنا لشاسيه تاني' },
  { code: 'wrong_document', words: 'Wrong document', en: 'the one we have is the wrong document', ar: 'المستند اللي وصلنا مش هو المطلوب' },
  { code: 'expired', words: 'Expired', en: 'the one we have is out of date', ar: 'النسخة اللي عندنا منتهية' },
  { code: 'incomplete', words: 'Incomplete (pages missing)', en: 'the one we have is incomplete', ar: 'النسخة اللي عندنا ناقصة' },
  { code: 'other', words: 'Other', en: 'the one we have cannot be used', ar: 'النسخة اللي عندنا مش صالحة' },
];

const reasonFor = (code) => REPLACEMENT_REASONS.find((r) => r.code === code) ?? REPLACEMENT_REASONS.at(-1);

/**
 * What the customer is asked for when a document is sent back, in both
 * languages: the outbox renderer picks the half that matches the customer.
 */
export function replacementRequest(docType, code, note = '') {
  const label = DOC_LABEL[docType] ?? 'document';
  const r = reasonFor(code);
  const extra = String(note ?? '').trim();
  return {
    requested: `A new ${label} — ${extra || r.en}.`,
    requested_ar: `نسخة جديدة من ${DOC_AR[docType] ?? DOC_AR.other} — ${extra || r.ar}.`,
  };
}

// ---------------------------------------------------------------------------
// Outbox events, rendered exactly as the outbox will
// ---------------------------------------------------------------------------

/**
 * The text the outbox will send for this event, in this customer's language
 * and worded for their channel - rendered inside the same kind of turn the
 * outbox's drain renders it in (lib/outbox.js: withTurn({ lang, channel })).
 * null when the outbox has no renderer for it, which the caller reports rather
 * than inventing a stand-in.
 */
export function renderEvent(eventType, payload, language = null, channel = null) {
  const row = { event_type: eventType, payload, language, channel };
  const out = withTurn({ lang: language, channel }, () => render(row));
  return out?.text ?? null;
}

// ---------------------------------------------------------------------------
// Messages the desk composes itself
// ---------------------------------------------------------------------------

const MILESTONE_AR = {
  'Booking confirmed, awaiting cargo': 'الحجز اتأكد، ومستنيين الشحنة',
  'Awaiting pickup at origin': 'مستنية الاستلام من بلد التحميل',
  'Received at origin warehouse': 'وصلت مخزن بلد التحميل',
  'Loaded on vessel': 'اتحملت على المركب',
  'Vessel departed': 'المركب اتحرك',
  'In transit': 'في الطريق',
  'Arrived at destination port': 'وصلت ميناء الوصول',
  'Customs clearance in progress': 'التخليص الجمركي شغال',
  'Customs cleared': 'خلص التخليص الجمركي',
  'Out for delivery': 'خرجت للتسليم',
  'Delivered': 'اتسلمت',
  'On hold': 'متوقفة مؤقتاً',
};

/**
 * "Update on your shipment …" - what the customer reads when the desk moves a
 * shipment with "tell the customer" ticked. The operator's own note, when
 * there is one, is the news; otherwise the new milestone is.
 */
export function shipmentUpdateText(shipment, { status = null, eta = null, note = '' } = {}, language = null) {
  const id = shipment?.shipment_id ?? '';
  const vin = shipment?.vin ?? null;
  const milestone = status || shipment?.status || '';
  const when = eta || shipment?.eta || null;
  const said = String(note ?? '').trim();

  // A date inside Arabic text is isolated (LRI … PDI): left to the bidi
  // algorithm, 2026-10-12 is shown as 12-10-2026 in a right-to-left line.
  const ar = [
    `تحديث على شحنتك ${id}${vin ? ` (شاسيه ${vin})` : ''}:`,
    said || MILESTONE_AR[milestone] || milestone,
    when ? `الوصول المتوقع: ⁦${when}⁩` : null,
  ].filter(Boolean).join('\n');
  const en = [
    `Update on your shipment ${id}${vin ? ` (chassis ${vin})` : ''}:`,
    said || milestone,
    when ? `Estimated arrival: ${when}` : null,
  ].filter(Boolean).join('\n');
  return inLanguage(language, ar, en);
}

/**
 * The same update as the parameters of WhatsApp's "shipment update" template,
 * for when the 24-hour window has closed and only the template can carry it.
 */
export function shipmentUpdatePayload(shipment, { status = null, eta = null, note = '' } = {}, language = null) {
  const said = String(note ?? '').trim();
  const milestone = status || shipment?.status || '';
  return {
    reference: shipment?.shipment_id ?? null,
    shipment_id: shipment?.shipment_id ?? null,
    vin: shipment?.vin ?? null,
    eta: eta || shipment?.eta || null,
    update: said || (language === 'ar' ? MILESTONE_AR[milestone] || milestone : milestone),
  };
}

/**
 * The message a customer gets when their request is marked resolved.
 *
 * Mirrors notifyTicketResolved in lib/notify.js, which sends this inline on
 * Telegram (WhatsApp goes through the outbox's ticket_resolved renderer, and
 * its preview is rendered from there). A test compares the two, so if that
 * wording changes the preview cannot quietly go on promising the old one.
 */
export function ticketResolvedText(ticket, note = '', language = null) {
  const said = String(note ?? '').trim();
  const ar = `✅ تم حل طلبك ${ticket.ticket_ref} (${ticket.department}).`
    + (said ? `\n\n${said}` : '')
    + '\n\nلو لسه في حاجة، ابعت 3 وهنفتح طلب جديد.';
  const en = `✅ Your ticket ${ticket.ticket_ref} (${ticket.department}) has been resolved.`
    + (said ? `\n\n${said}` : '')
    + '\n\nIf anything is still outstanding, reply 3 and we will open a new one.';
  if (language === 'ar') return ar;
  if (language === 'en') return en;
  // Exactly how notify.js joins the two halves, emoji mirroring included.
  return splitLanguages(`${ar} | ${en}`);
}

// ---------------------------------------------------------------------------
// Why a message did not arrive, in words
// ---------------------------------------------------------------------------

/**
 * Meta's and Telegram's error texts, translated for the person at the desk.
 * The raw text is kept beside it for whoever has to report it upstream.
 */
export function failureWords(error, { status = null, template = null } = {}) {
  const e = String(error ?? '');
  if (status === 'needs_template' || /131047|re-?engagement|24.?hour/i.test(e)) {
    return 'The customer hasn’t written in 24 hours, so WhatsApp only allows an approved template.';
  }
  if (status === 'opted_out' || /opted.?out|\bSTOP\b/i.test(e)) return 'The customer asked us not to message them (they wrote STOP).';
  if (/131026/.test(e)) return 'This number is not on WhatsApp.';
  if (/131021/.test(e)) return 'WhatsApp will not send a message from our number to itself.';
  if (/130429|131056|rate.?limit|too many/i.test(e)) return 'WhatsApp is limiting how fast we send. It will be tried again.';
  if (/131051/.test(e)) return 'WhatsApp does not support this kind of message.';
  if (/\b132\d{3}\b/.test(e)) return `WhatsApp refused the template${template ? ` “${template}”` : ''}. Check it in WhatsApp Manager.`;
  if (/\b190\b|oauth|access token|token.*expired/i.test(e)) return 'Our WhatsApp connection has expired. Tell the administrator.';
  if (/bot was blocked/i.test(e)) return 'The customer blocked the bot on Telegram.';
  if (/chat not found|user is deactivated/i.test(e)) return 'This Telegram chat no longer exists.';
  if (/not.?connected/i.test(e)) return 'WhatsApp sending isn’t connected yet.';
  if (!e) return 'It did not go through.';
  return `It did not go through: ${e.slice(0, 160)}`;
}

// ---------------------------------------------------------------------------
// Saved replies
// ---------------------------------------------------------------------------

/**
 * Replies the desk writes over and over, until an administrator sets their own
 * in Settings (bot_settings.saved_replies). Arabic in the same voice the bot
 * uses; nothing here promises a date, a price or a requirement.
 */
export const DEFAULT_SAVED_REPLIES = [
  {
    title: 'Documents received',
    en: 'Thank you, we have received your documents. We are checking them now and will come back to you shortly.',
    ar: 'شكراً، وصلتنا المستندات. بنراجعها دلوقتي وهنرجعلك قريب.',
  },
  {
    title: 'Clearer copy, please',
    en: 'The copy you sent is hard to read. Could you send a clearer photo, or the PDF, please?',
    ar: 'النسخة اللي بعتها مش واضحة. ممكن تبعت صورة أوضح أو ملف PDF من فضلك؟',
  },
  {
    title: 'We will call you',
    en: 'We will call you shortly on the number you gave us.',
    ar: 'هنتصل بيك قريب على الرقم اللي إديتهولنا.',
  },
  {
    title: 'Checking, one moment',
    en: 'Thank you for your patience. We are looking into this and will reply as soon as we can.',
    ar: 'شكراً على صبرك. بنشوف الموضوع وهنرد عليك في أقرب وقت.',
  },
  {
    title: 'Anything else?',
    en: 'Is there anything else we can help you with?',
    ar: 'في أي حاجة تانية نقدر نساعدك فيها؟',
  },
];
