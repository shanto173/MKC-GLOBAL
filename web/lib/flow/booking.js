/**
 * The booking conversation, as a state machine, in the three steps MKY
 * describes it to clients:
 *
 *   1. who is booking   - a name, and a number to call
 *   2. the vehicle      - the chassis check, make, route, MRN, and the papers
 *   3. the booking      - the card, the yes, and the reference they keep
 *
 * Nothing in this file asks a language model what to do next. Which question
 * comes next, whether a chassis may be booked, which documents are outstanding
 * and whether a request may be submitted are all decided from database rows.
 * The model's only job in a booking is reading values out of a sentence when a
 * client types prose instead of tapping - and every value it returns is
 * validated here before it is written.
 *
 * The shape of every handler is the same: take the session and the input,
 * return the messages to send and the patch to apply to the session. Handlers
 * do not send anything themselves, which is what makes them testable without a
 * Telegram token.
 */

import { S, FLOWS, BASIC_FIELDS } from './states.js';
import { M, FIELD_LABELS, DOC_LABELS, both, pair, portName } from './messages.js';
import { pick, routeArrow, currentLanguage } from '../lang.js';
import * as kb from './keyboards.js';
import {
  findDraft, createDraft, updateDraft, bookingByRef, missingBasics,
  lookupVehicle, submitDraft, cancelDraft, cancelAllDrafts, draftIsBlank,
  looksLikeVin, normalizeVin, matchPort,
} from '../bookings.js';
import { bookingDocumentState, fileDocuments, looseDocuments, bookingRefsOf, SET_ASIDE } from '../documents.js';
import { canonicalMake, latinizeName } from '../tools.js';
import { parsePastedFields, looksLikePaste, splitMakeModel, extractField } from './paste.js';
import { classify, fieldsIn, answerIn } from './understand.js';
import { understand, nluAvailable } from './nlu.js';
import { openMrnRequest, mrnRequestFor, addSuppliedInformation } from '../mrn.js';
import { operationsNotifier } from '../operations.js';
import { enqueue } from '../outbox.js';
import { notifyBooking } from '../notify.js';
import { settings } from '../settings.js';
import { normalizePhone, looksLikePhone } from '../phone.js';
import { rememberClientContact, phoneOnFile } from '../clients.js';
import { DESTINATION_PORTS } from '../config.js';
import { audit, logEvent } from '../audit.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const say = (text, inline = null) => ({ text, ...(inline ? { inline } : {}) });
const reply = (messages, patch = {}) => ({
  messages: Array.isArray(messages) ? messages : [messages],
  patch,
});

/** A client answering "yes" - used only where a yes/no question was asked. */
const isYes = (text) => /^(y|yes|yeah|yep|ok|okay|sure|correct|right|confirm|تمام|نعم|ايوه|أيوه|ماشي|أكيد|صح)\b/i
  .test(String(text ?? '').trim());

/** An email address, wherever it sits in a message. */
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;

/**
 * The number a WhatsApp client is writing from, "+201005551234" - or null on
 * any other channel. WhatsApp identifies a sender BY their number, so unlike a
 * Telegram chat id this one can be dialled.
 */
export function whatsappNumber(ctx) {
  const digits = String(ctx?.waId ?? '');
  return ctx?.channel === 'whatsapp' && /^\d{8,15}$/.test(digits) ? `+${digits}` : null;
}

/**
 * The phone question, with the button that answers it.
 *
 * Telegram only hands a bot a verified number through a reply-keyboard contact
 * button, so on Telegram this is the one prompt in the booking that is not an
 * inline keyboard. WhatsApp has no such button and needs none: the number the
 * client is writing from is offered back to them. The website widget has
 * neither; there the client types the number.
 */
function phonePrompt(ctx, text) {
  if (ctx.channel === 'telegram') return { text, keyboard: kb.sharePhoneKeyboard(), oneTime: true };
  const own = whatsappNumber(ctx);
  if (own) return say(text, kb.phoneChoice(own));
  return say(text, kb.homeOnly());
}

/**
 * The number on file, offered back with "reply yes". Not on WhatsApp when it
 * is the number being written from - the button offers that one already, and
 * naming it twice asks the same thing twice.
 */
async function suggestedPhone(ctx) {
  const held = await phoneOnFile(ctx).catch(() => null);
  if (held && normalizePhone(held) === whatsappNumber(ctx)) return null;
  return held;
}

// ---------------------------------------------------------------------------
// Step 1 - who is booking
// ---------------------------------------------------------------------------

/**
 * Entry point for "Book my shipment".
 *
 * An unfinished request is never silently thrown away and never silently
 * resumed: the client is shown what they have and chooses. Discarding it would
 * lose the documents they already sent.
 */
export async function startBooking(session, ctx) {
  const { draft, error } = await findDraft(ctx.chatId);
  if (error) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));

  // A draft with nothing on it - a Book tap that went nowhere - is not worth
  // an "unfinished request" question. It is simply the request, from the top.
  if (draft && draftIsBlank(draft)) return openBooking(draft, ctx);

  if (draft) {
    return reply(
      say(M.draftFound(draft.booking_ref, draft.vin), kb.resumeDraft()),
      { active_flow: FLOWS.BOOKING, current_state: S.BOOK_DRAFT_RESUME, active_booking_ref: draft.booking_ref },
    );
  }

  return newDraft(session, ctx);
}

/**
 * The first thing a booking says, and the first thing it asks.
 *
 * TWO QUESTIONS THAT ARE NO LONGER ASKED.
 *
 * On WhatsApp the person's name and the number they are writing from arrive
 * with every message. The flow asked for both anyway - offering what it already
 * had and waiting to be told it was right - which is two exchanges to learn
 * nothing. They are taken, said back in the opening so a wrong one is visible
 * at once, and either can be changed on the confirmation card before the
 * booking is submitted.
 *
 * Telegram hands over no number, so there the question stands.
 *
 * What is asked first is the vehicle, and the quickest answer to it is a
 * document: the chassis, the make, the model and the loading port are all
 * printed on the invoice and on the Brief, and adoptFromPapers takes them.
 */
async function openBooking(draft, ctx) {
  const patch = {};
  const name = ctx.userName ? latinizeName(ctx.userName) || String(ctx.userName).trim() : null;
  if (name && !draft.customer_name) patch.customer_name = name.slice(0, 120);
  const phone = whatsappNumber(ctx);
  if (phone && !looksLikePhone(draft.customer_contact)) patch.customer_contact = phone;

  // Best effort: a draft that would not take the name is not worth failing a
  // booking over - the questions below simply ask for what is still missing.
  const saved = Object.keys(patch).length
    ? await updateDraft(draft.booking_ref, patch, { chatId: ctx.chatId }).catch(() => ({ ok: false }))
    : { ok: true, draft };
  const current = saved.ok ? (saved.draft ?? draft) : draft;

  // Whatever could not be taken is asked for in the usual order, under the
  // opening it belongs to: a chat that taps Book and is answered with a bare
  // "and a mobile number?" has not been told a booking has started. Telegram
  // hands over no number, so this is its ordinary path, not an edge case.
  const missing = missingBasics(current);
  if (missing.includes('customer_name')) {
    return reply(
      say(M.bookingStartAskName(ctx.userName ?? null), kb.homeOnly()),
      { active_flow: FLOWS.BOOKING, current_state: S.BOOK_CLIENT_NAME, active_booking_ref: current.booking_ref, context: {} },
    );
  }
  if (missing.includes('customer_contact')) {
    const next = await askNextBasic(current, ctx, { intro: true });
    return reply(
      [say(M.bookingStartYourDetails(current.customer_name ?? null)), ...next.messages],
      { active_flow: FLOWS.BOOKING, active_booking_ref: current.booking_ref, context: {}, ...next.patch },
    );
  }

  return reply(
    say(M.bookingStartSendPapers(current.customer_name ?? null, current.customer_contact ?? null), kb.homeOnly()),
    {
      active_flow: FLOWS.BOOKING,
      current_state: S.BOOK_VIN,
      active_booking_ref: current.booking_ref,
      context: {},
    },
  );
}

async function newDraft(session, ctx) {
  // Both callers have just established there is no draft to replace, so the
  // sweep for one is skipped: it is a round trip on the tap the client is
  // waiting on, and it never found anything.
  const created = await createDraft({
    chatId: ctx.chatId,
    clientId: ctx.clientId ?? null,
    channel: ctx.channel,
    telegramUserId: ctx.telegramUserId ?? null,
    replaceExisting: false,
    language: currentLanguage(),
  });
  if (!created.ok) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));

  return openBooking(created.draft, ctx);
}

/** "I will type it" - the reply keyboard's other button, not a number. */
const WANTS_TO_TYPE = /^\s*(?:✏️\s*)?(?:هكتبه بنفسي|i will type it)/i;

/**
 * Step 1, the number.
 *
 * Three ways it arrives: shared through Telegram's contact button, which is a
 * verified number and the one to prefer; typed, in either digit system, with or
 * without a country code; or "yes" to the number we already hold for this
 * person. Whatever the route, one shape is stored (see lib/phone.js) and the
 * client's own record is updated, so the next booking and the next request for
 * an agent have it without asking.
 *
 * `aside` is a number shared while some OTHER question was open: it is kept and
 * that question is asked again, rather than the booking being abandoned for a
 * support ticket - which is what a shared contact used to start.
 */
export async function handlePhone(session, text, ctx, { editing = false, shared = false, aside = false } = {}) {
  const typed = String(text ?? '').trim();
  const ref = session.active_booking_ref;

  if (!shared && WANTS_TO_TYPE.test(typed)) {
    return reply(say(M.phoneTypeIt(), kb.homeOnly()));
  }

  // Telegram vouches for a shared number and gives it in international form,
  // sometimes without the "+". Put it back, so the same number typed and shared
  // is stored the same way.
  let phone = shared ? normalizePhone(/^\+/.test(typed) ? typed : `+${typed}`) : null;

  // "yes" to the number on file - or, on WhatsApp, to the one being written
  // from, which is what the question there offers.
  if (!phone && !shared && isYes(typed)) {
    phone = (await phoneOnFile(ctx).catch(() => null)) ?? whatsappNumber(ctx);
  }

  // A pasted block: the number is in it, and probably everything else too.
  if (!phone && !shared && !editing && looksLikePaste(typed)) {
    const pasted = await handlePaste(session, typed, ctx);
    if (pasted) return pasted;
  }

  if (!phone && !shared) {
    // A chassis number has digits enough to pass for a phone, so it is ruled
    // out first and read as what it is.
    phone = looksLikeVin(typed) ? null : normalizePhone(typed);

    if (!phone) {
      // Not a number: a chassis, a question, a request to be elsewhere, an
      // email, or "I have not got one".
      const understood = await handleUnexpected(session, 'customer_contact', typed, ctx);
      if (understood?.passToAssistant || understood?.switchTo) return understood;
      if (understood?.messages) return reply(understood.messages, understood.patch ?? {});
      phone = understood?.answer ? normalizePhone(understood.answer) : null;
    }
  }

  if (!phone) return reply(phonePrompt(ctx, M.phoneInvalid()));

  const saved = await updateDraft(ref, { customer_contact: phone }, { chatId: ctx.chatId });
  if (!saved.ok) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));
  await rememberClientContact(ctx.clientId, { phone }).catch(() => null);
  logEvent('booking_information_updated', { booking_ref: ref, field: 'customer_contact' });

  if (editing) return backToConfirmation(session, ctx, { lead: M.editSaved() });
  if (aside) return backToConfirmation(session, ctx, { lead: M.phoneNoted(phone) });
  return askNextBasic(saved.draft, ctx);
}

// ---------------------------------------------------------------------------
// Step 2 - the vehicle: the chassis check first
// ---------------------------------------------------------------------------

/**
 * The chassis check, wherever the number came from.
 *
 * A chassis number decides whether a booking may happen at all, so it is never
 * simply written down. Whether it arrived as the answer to the chassis
 * question, inside a block pasted at the name step, or in a sentence three
 * questions later, it comes through here and faces the same lookup. Banking one
 * sideways used to skip that: a client who mentioned the chassis early was
 * never told the unit was already booked, and the desk found the duplicate
 * instead.
 *
 * `excludeBookingRef` matters when a client is EDITING the chassis on their own
 * unfinished request: their own draft must not be reported as a clash with
 * itself.
 *
 * @returns {Promise<{ok: true, draft: object, verdict: string}
 *                   |{ok: false, ended?: boolean, reply: object}>}
 */
async function settleVin(session, typed, ctx, { editing = false } = {}) {
  const ref = session.active_booking_ref;
  const result = await lookupVehicle(typed, { excludeBookingRef: ref });
  if (!result.ok) {
    if (result.reason === 'too_short') return { ok: false, reply: reply(say(M.vinTooShort(), kb.homeOnly())) };
    return { ok: false, reply: reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery())) };
  }

  // Branch C: a live booking exists. No second request, and the flow ends here
  // with the reference and route the client actually needs.
  if (result.verdict === 'already_booked') {
    const b = result.booking;
    await audit({
      actor_type: 'client', actor_id: ctx.chatId,
      action: 'duplicate_booking_detected',
      entity_type: 'booking', entity_id: b.booking_ref,
      metadata: { vin: normalizeVin(typed) },
    });
    // The draft this conversation was building is abandoned, not left lying
    // around to be resumed into a duplicate later.
    if (ref) await cancelDraft(ref, ctx.chatId);
    return {
      ok: false,
      ended: true,
      reply: reply(
        say(M.vinAlreadyBooked(b), kb.alreadyBooked()),
        { active_flow: null, current_state: S.MAIN_MENU, active_booking_ref: null, context: {} },
      ),
    };
  }

  // Branches A and B both continue; B pre-fills from what we already hold, so
  // the client is not asked for a make we have on file.
  const patch = { vin: String(typed).toUpperCase().replace(/\s+/g, '') };
  const v = result.vehicle;
  if (v?.make && !editing) patch.make = v.make;
  if (v?.model && !editing) patch.model = v.model;

  const saved = await updateDraft(ref, patch, { chatId: ctx.chatId });
  if (!saved.ok) return { ok: false, reply: reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery())) };

  return { ok: true, draft: saved.draft, verdict: result.verdict };
}

/** The chassis number, as the answer to the chassis question. */
export async function handleVin(session, text, ctx, { editing = false } = {}) {
  let typed = String(text ?? '').trim();

  // A block pasted at the chassis step carries the chassis and everything else.
  // The other fields are stored first, then the chassis goes through the normal
  // lookup below - it is the one value that decides whether a booking may
  // happen at all, so it is never simply written down.
  let pastedNote = null;
  if (!editing && looksLikePaste(typed)) {
    const { patch, vin } = await applyPastedFields(session, typed, ctx);
    if (Object.keys(patch).length) {
      await updateDraft(session.active_booking_ref, patch, { chatId: ctx.chatId }).catch(() => null);
      pastedNote = Object.keys(patch);
    }
    if (vin) typed = vin;
  }

  // A chassis number arrives inside whatever sentence the client wrote around
  // it - "here is my chasis number : WMA06XZZ8KM745219". The word test rejects
  // anything over four words, so a polite client was told their real chassis
  // number was not one. Find the number in the message instead.
  typed = extractField('vin', typed);

  if (!looksLikeVin(typed)) {
    // Not a chassis number - but it may still be something. A destination, a
    // phone number, a question, or a request to go somewhere else.
    const understood = await handleUnexpected(session, 'vin', text, ctx);
    if (understood?.passToAssistant || understood?.switchTo) return understood;
    if (understood?.messages) return reply(understood.messages, understood.patch ?? {});
    // The model found a chassis number the patterns missed. It still goes
    // through the lookup below - being recovered by a model buys it nothing.
    if (understood?.answer && looksLikeVin(understood.answer)) typed = understood.answer;
    else return reply(say(M.vinTooShort(), kb.homeOnly()));
  }

  const settled = await settleVin(session, typed, ctx, { editing });
  if (!settled.ok) return settled.reply;

  // "chassis X from Klaipeda going to Alexandria" names three things. Asking
  // for the other two afterwards is what makes a bot tiring to use.
  const rest = editing
    ? { saved: [] }
    : await bankTheRest(session, text, ctx, { except: 'vin' }).catch(() => ({ saved: [] }));

  const opening = editing
    ? M.editSaved()
    : settled.verdict === 'new'
      ? M.vinNew()
      : `${M.vinKnown()}\n\n${M.vinKnownContinue()}`;

  if (editing) {
    return backToConfirmation(session, ctx, { lead: opening });
  }

  // Re-read, so whatever the sentence supplied alongside the chassis is not
  // asked for again a moment later - and is read back, so the client can see
  // it landed.
  const draft = (await bookingByRef(settled.draft.booking_ref)) ?? settled.draft;
  const noted = notedDetails(draft, rest.saved ?? []);
  const next = await askNextBasic(draft, ctx, { listMissing: true });
  return reply([
    say(opening),
    ...(noted.en.length ? [say(M.notedFromMessage(noted.ar, noted.en))] : []),
    ...next.messages,
  ], next.patch);
}

/**
 * The details a message supplied, read back from the row so the client sees
 * what actually landed: "client Giza Freight Lines · chassis X · make DAF XF
 * 480 FT · route Rotterdam → Damietta Port".
 *
 * @param {object} booking the row as it now stands
 * @param {string[]} fields what the message supplied, as bankFound reports it
 * @returns {{ar: string[], en: string[]}}
 */
function notedDetails(booking, fields) {
  const set = new Set(fields ?? []);
  const ar = [];
  const en = [];
  if (!booking) return { ar, en };

  if (set.has('customer_name') && booking.customer_name) {
    ar.push(`العميل ${booking.customer_name}`);
    en.push(`client ${booking.customer_name}`);
  }
  if (set.has('contact') && looksLikePhone(booking.customer_contact)) {
    ar.push(`الموبايل ${booking.customer_contact}`);
    en.push(`number ${booking.customer_contact}`);
  }
  if (set.has('vin') && booking.vin) {
    ar.push(`الشاسيه ${booking.vin}`);
    en.push(`chassis ${booking.vin}`);
  }
  if ((set.has('make') || set.has('model')) && booking.make) {
    const vehicle = [booking.make, booking.model].filter(Boolean).join(' ');
    ar.push(`الماركة ${vehicle}`);
    en.push(`make ${vehicle}`);
  }
  if (set.has('origin_port') || set.has('destination_port')) {
    // One end of the route on its own is said as that end, not as a route with
    // a dash where the other half should be: the papers name where a vehicle
    // loads and almost never which Egyptian port it is bound for, so a line
    // reading "route Klaipeda → —" would be the common case, not the rare one.
    const from = booking.origin_port || null;
    const to = booking.destination_port || null;
    if (from && to) {
      ar.push(`خط الشحن ${from} ← ${to}`);
      en.push(`route ${from} → ${to}`);
    } else if (from) {
      ar.push(`الشحن من ${from}`);
      en.push(`loading ${from}`);
    } else if (to) {
      ar.push(`ميناء الوصول ${to}`);
      en.push(`destination ${to}`);
    }
  }
  return { ar, en };
}

// ---------------------------------------------------------------------------
// Step 2 - the rest of the basics
// ---------------------------------------------------------------------------


/**
 * A make, as it should be stored, wherever it came from.
 *
 * Transliterate BEFORE splitting: the manufacturer table is Latin, so
 * "مرسيدس أكتروس" split first finds no known make and the whole phrase becomes
 * one field with the model lost. Then one spelling per manufacturer, because
 * the operations list has to sort and "scania" and "Scania" are one company.
 *
 * Used by every path that can set a make - a single answer, a paste, a sentence
 * the model read - so they cannot disagree about what "مرسيدس" means.
 */
function normaliseMake(value) {
  const latin = latinizeName(value) || String(value);
  const { make, model } = splitMakeModel(latin);
  const out = {};
  if (make && make.length <= 120) out.make = canonicalMake(make) || make;
  if (model) out.model = model;
  return out;
}

/**
 * A loading city, as it appears on the paperwork.
 *
 * فيلنيوس is Vilnius on the bill of lading and the customs entry, and a value
 * that has to match the rest of the file cannot be in another script. A place
 * not in the table is left exactly as written - a wrong Latin guess is worse
 * than Arabic somebody can read.
 */
function normalisePlace(value) {
  return latinizeName(value) || String(value).trim();
}

/** What each field is called when we ask for it again. */
const NEED = {
  customer_name: ['اسم العميل', 'the client name'],
  customer_contact: ['رقم الموبايل', 'the mobile number'],
  vin: ['رقم الشاسيه', 'the chassis / VIN number'],
  make: ['الماركة', 'the make'],
  origin_port: ['ميناء أو مدينة الشحن', 'the port of loading'],
  destination_port: ['ميناء الوصول المصري', 'the Egyptian destination port'],
};

const GOT = {
  vin: ['رقم الشاسيه', 'the chassis number'],
  model: ['الموديل', 'the model'],
  contact: ['وسيلة التواصل', 'your contact details'],
  make: ['الماركة', 'the make'],
  customer_name: ['اسم العميل', 'the client name'],
  origin_port: ['ميناء الشحن', 'the loading point'],
  destination_port: ['ميناء الوصول', 'the destination'],
};

const gotAr = (fields) => fields.map((f) => GOT[f]?.[0] ?? f).join(' و ');
const gotEn = (fields) => fields.map((f) => GOT[f]?.[1] ?? f).join(' and ');

/**
 * The client said something that was not the answer to the question asked.
 *
 * Refusing it is the easy thing and the wrong one: "I want my car to go to Port
 * Said" contains a destination, "how long does it take" deserves an answer, and
 * a phone number is worth keeping. So work out what it was and act on it, then
 * ask the original question again.
 *
 * @returns {object|null} a reply, or null to fall through to the plain refusal
 */
async function handleUnexpected(session, field, text, ctx) {
  const verdict = classify(field, text);

  switch (verdict.kind) {
    // A question. The knowledge assistant answers it and the booking is left
    // exactly where it was - asking something mid-form must not cost the form.
    case 'question':
      return { passToAssistant: true };

    // They want to be somewhere else. The machine takes them.
    case 'intent':
      return { switchTo: verdict.value };

    // A value for another field: keep it, say so, ask again for this one. A
    // chassis among them faces the duplicate check like any other; if the unit
    // turns out to be booked already, that verdict is the whole answer.
    case 'other_field': {
      const banked = await bankFound(session, fieldsIn(text), ctx, { except: field });
      if (banked.ended) return { messages: banked.ended.messages, patch: banked.ended.patch };
      if (!banked.saved.length) return null;
      return {
        messages: [say(M.notedNowNeed(gotAr(banked.saved), gotEn(banked.saved), NEED[field][0], NEED[field][1]), kb.homeOnly())],
      };
    }

    case 'contact': {
      const noted = await noteContact(session, verdict.value, ctx);
      if (!noted) return null;
      if (field === 'customer_contact') {
        // Asked for a phone number. A number IS the answer; an email is kept,
        // and the number is still wanted.
        if (noted.kind === 'phone') return { answer: noted.value };
        return { messages: [phonePrompt(ctx, M.emailNotedNeedPhone(noted.value))] };
      }
      // "Ariful and my number is +49 …" at the name question: the number is
      // kept, and the name is the answer - both from one message, which is
      // how MKY describes step 1 to clients.
      const also = answerIn(field, verdict.rest);
      if (also) return { answer: also, noted };
      return {
        messages: [say(M.contactNoted(noted.value, NEED[field][0], NEED[field][1]), kb.homeOnly())],
      };
    }

    // They have not got it. The chassis and a number to call are the two
    // things a booking genuinely cannot go on without.
    case 'refusal':
      if (field === 'vin' || field === 'customer_contact') {
        return { messages: [say(M.cannotSkip(NEED[field][0], NEED[field][1]), kb.mainMenu())] };
      }
      return null;

    // The patterns made nothing of it. Ask the model - and only here, so a
    // normal booking never waits on one.
    default:
      return askTheModel(session, field, text, ctx);
  }
}

/**
 * The model's reading of a message the patterns could not place.
 *
 * It EXTRACTS. Every value it returns has already been through the same
 * validation as a typed one by the time it arrives here, so the worst a wrong
 * answer can do is fill a field with something the client then corrects - never
 * skip a rule, never satisfy a requirement.
 *
 * If no model is configured, or it is slow, or it returns nothing usable, this
 * gives back null and the client gets the plain "I need X". Degrading to the
 * previous behaviour is the intended failure.
 */
async function askTheModel(session, field, text, ctx) {
  if (!nluAvailable()) return null;

  const read = await understand(text, { asked: NEED[field]?.[1] ?? field }).catch(() => null);
  if (!read?.used) return null;

  if (read.intent && ['track', 'contact', 'menu', 'cancel'].includes(read.intent)) {
    return { switchTo: read.intent };
  }

  // A question, and nothing in it we can use: the assistant answers.
  if (read.question && !Object.keys(read.fields).length) return { passToAssistant: true };

  const found = { ...read.fields };
  // A name the model finds in an answer to some other question is kept only
  // as the customer wrote it, never as the model re-spelled or shortened it.
  if (field !== 'customer_name' && found.customer_name && !String(text).includes(found.customer_name)) {
    delete found.customer_name;
  }
  if (!Object.keys(found).length) return null;

  // The model reports a number or an email as "contact"; the booking calls
  // that column customer_contact.
  const key = field === 'customer_contact' ? 'contact' : field;

  // It answered the question that was asked.
  if (found[key]) {
    const rest = { ...found };
    delete rest[key];
    let answer = found[key];
    // A name is the customer's to spell. The model may say the message IS a
    // name; it may not decide which part of it is. In the live test it read
    // "E2E TEST – ignore شركة بيتا للنقل" as "شركة بيتا للنقل", and that is
    // what went on the paperwork. So a message that is only a name is stored
    // as typed; one that also carries other details keeps the model's cut only
    // when it is the customer's own words, character for character.
    if (field === 'customer_name') {
      const typed = extractField(field, text).trim();
      answer = Object.keys(rest).length && typed.includes(String(answer).trim()) ? String(answer).trim() : typed;
    }
    const banked = await bankFound(session, rest, ctx, { except: field }).catch(() => ({ saved: [], ended: null }));
    if (banked.ended) return { messages: banked.ended.messages, patch: banked.ended.patch };
    return { answer };
  }

  // It supplied something else. Keep it and ask again.
  const banked = await bankFound(session, found, ctx, { except: field });
  if (banked.ended) return { messages: banked.ended.messages, patch: banked.ended.patch };
  if (!banked.saved.length) return null;

  return {
    messages: [say(M.notedNowNeed(gotAr(banked.saved), gotEn(banked.saved), NEED[field][0], NEED[field][1]), kb.homeOnly())],
  };
}

/**
 * Stores every field a message supplied, validating each one exactly as if it
 * had been typed on its own.
 *
 * Two fields are deliberately NOT written here. A chassis has to be looked up,
 * not stored (settleVin); a contact has rules about what may replace what
 * (noteContact). bankFound() routes them; this handles the rest.
 *
 * @returns {Promise<string[]>} the fields actually written
 */
async function bankFields(session, found, ctx, { except = null } = {}) {
  const patch = {};

  for (const [field, value] of Object.entries(found)) {
    if (field === except) continue;
    if (field === 'destination_port') {
      const port = matchPort(value);
      if (port) patch.destination_port = port;
    } else if (field === 'make' && String(value).trim()) {
      Object.assign(patch, normaliseMake(String(value).trim()));
    } else if (field === 'origin_port' && String(value).trim() && String(value).length <= 120) {
      patch.origin_port = normalisePlace(String(value).trim());
    } else if (['model', 'customer_name'].includes(field)
               && String(value).trim() && String(value).length <= 120) {
      patch[field] = String(value).trim();
    }
  }

  if (!Object.keys(patch).length) return [];
  const saved = await updateDraft(session.active_booking_ref, patch, { chatId: ctx.chatId });
  return saved.ok ? Object.keys(patch) : [];
}

/**
 * Everything a message supplied, each value by its own rule.
 *
 * @returns {Promise<{saved: string[], ended: object|null}>} the fields written,
 *   and - when a chassis among them turned out to be booked already - the reply
 *   that ends the flow, which replaces whatever the caller was about to say.
 */
async function bankFound(session, found, ctx, { except = null } = {}) {
  const rest = { ...found };
  const vin = except !== 'vin' && rest.vin ? rest.vin : null;
  const contact = except !== 'customer_contact' && rest.contact ? rest.contact : null;
  delete rest.vin;
  delete rest.contact;

  const saved = await bankFields(session, rest, ctx, { except });

  if (contact) {
    const noted = await noteContact(session, contact, ctx);
    if (noted) saved.push('contact');
  }

  if (vin && looksLikeVin(vin)) {
    const settled = await settleVin(session, vin, ctx);
    if (!settled.ok && settled.ended) return { saved, ended: settled.reply };
    if (settled.ok) saved.push('vin');
  }

  return { saved, ended: null };
}

/**
 * Everything else a message said, beyond the answer it was read for.
 *
 * The patterns first: a chassis, the ports, a make, a client named in the
 * sentence. Then, when the message is long enough to be saying more and the
 * request is still missing something, the model reads it too - and, as
 * everywhere, only supplies candidates that go through the same checks. Doing
 * the second part only when the first found nothing was how "DAF XF 480 FT,
 * client Giza Freight Lines, chassis …" kept its chassis and lost its make.
 */
async function bankTheRest(session, text, ctx, { except = null } = {}) {
  const banked = await bankFound(session, fieldsIn(text), ctx, { except });
  if (banked.ended) return banked;

  const words = String(text ?? '').trim().split(/\s+/).length;
  if (words < 5 || !nluAvailable()) return banked;

  const booking = await bookingByRef(session.active_booking_ref);
  if (!booking || !missingBasics(booking).some((f) => f !== except)) return banked;

  const read = await understand(text).catch(() => null);
  if (!read?.used || !Object.keys(read.fields).length) return banked;

  const more = await bankFound(session, read.fields, ctx, { except });
  if (more.ended) return more;
  return { saved: [...banked.saved, ...more.saved], ended: null };
}

/**
 * A phone number or an email, said when something else was asked.
 *
 * A number replaces whatever the booking held and goes on the client's record.
 * An email goes on the client's record too, but stands in as the booking's
 * contact only while there is no number: the desk phones people, and an email
 * mentioned in passing must not overwrite the number given a minute earlier.
 *
 * @returns {Promise<{kind: 'phone'|'email', value: string}|null>}
 */
async function noteContact(session, value, ctx) {
  const raw = String(value ?? '').trim();
  const email = raw.includes('@') ? raw.match(EMAIL)?.[0] ?? null : null;
  const phone = email ? null : normalizePhone(raw);

  if (phone) {
    const saved = await updateDraft(session.active_booking_ref, { customer_contact: phone }, { chatId: ctx.chatId })
      .catch(() => ({ ok: false }));
    if (!saved.ok) return null;
    await rememberClientContact(ctx.clientId, { phone }).catch(() => null);
    return { kind: 'phone', value: phone };
  }

  if (!email) return null;
  await rememberClientContact(ctx.clientId, { email }).catch(() => null);
  const booking = await bookingByRef(session.active_booking_ref);
  if (booking && !looksLikePhone(booking.customer_contact)) {
    await updateDraft(session.active_booking_ref, { customer_contact: email }, { chatId: ctx.chatId })
      .catch(() => null);
  }
  return { kind: 'email', value: email };
}

/**
 * Asks for the next thing this request is missing, in a fixed order.
 *
 * One question at a time, as the roadmap has it. The bulk list is reserved for
 * the case where several are missing at once - after an edit, or after a client
 * pasted a half-filled form - because a wall of questions is what people ignore.
 */
export async function askNextBasic(booking, ctx, { listMissing = false, notedPhone = null, intro = true } = {}) {
  const missing = missingBasics(booking);

  if (!missing.length) {
    return reply(
      [say(M.basicsComplete()), say(M.askMrnChoice(), kb.mrnChoice())],
      { current_state: S.BOOK_MRN_CHOICE },
    );
  }

  const [next] = missing;

  // The list of what is outstanding is shown ONCE, on the way into the vehicle
  // questions, so the client knows how much is coming. Repeating it after every
  // answer - which it did - reads as being asked for the same things over and
  // over, which is the single complaint this flow exists to stop.
  const preface = listMissing && missing.length > 1
    ? [say(M.missingBasics(
        missing.map((f) => FIELD_LABELS[f][0]),
        missing.map((f) => FIELD_LABELS[f][1]),
      ))]
    : [];

  // The number we already hold for this person, offered back rather than
  // asked for again. Null on a first booking - never guessed.
  const suggestion = next === 'customer_contact' ? await suggestedPhone(ctx) : null;

  const prompts = {
    customer_name: () => say(M.askClientName(ctx.userName ?? null), kb.homeOnly()),
    customer_contact: () => phonePrompt(ctx, M.askPhone(suggestion, whatsappNumber(ctx))),
    // Step 2 opens the moment the person is known and the vehicle is not. One
    // message: where they are, that everything may come at once with the
    // papers attached, and the chassis question. A number given in the same
    // breath as the name is read back here rather than in a message of its own.
    // Asked again later - after a file arrived first, say - it is just the
    // question; the client has already read where they are.
    vin: () => say(
      intro ? M.detailsCompleteAskVin(booking.customer_name ?? null, notedPhone) : M.askVin(),
      kb.homeOnly(),
    ),
    make: () => say(M.askMake(), kb.homeOnly()),
    origin_port: () => say(M.askPol(), kb.homeOnly()),
    destination_port: () => say(M.askDestination(DESTINATION_PORTS), kb.homeOnly()),
  };

  const states = Object.fromEntries(BASIC_FIELDS.map((f) => [f.field, f.state]));

  await updateDraft(booking.booking_ref, { current_step: states[next] }, { chatId: ctx.chatId })
    .catch(() => null);

  // A number noted alongside some other answer, when the next question is not
  // the one that reads it back.
  const lead = notedPhone && next !== 'vin' ? [say(M.phoneNoted(notedPhone))] : [];

  return reply([...lead, ...preface, prompts[next]()], { current_state: states[next] });
}

/**
 * Details written on a file - the caption under an attachment - read exactly
 * as a typed message would be, before the file itself is counted.
 *
 * "Send it all in one message and attach the papers" is what step 2 invites,
 * and the caption is where "all" goes. A chassis in it faces the duplicate
 * check like any other; if the unit is already booked, that is the reply.
 *
 * @returns {Promise<{ended: boolean, reply?: object, saved?: string[]}|null>}
 *   `saved` names the fields the caption supplied, so the reply that follows
 *   the files can read them back
 */
export async function absorbCaption(session, text, ctx) {
  const value = String(text ?? '').trim();
  const ref = session.active_booking_ref;
  if (!value || !ref) return null;

  const booking = await bookingByRef(ref);
  if (!booking || booking.status !== 'draft') return null;

  if (looksLikePaste(value)) {
    const { patch, vin } = await applyPastedFields(session, value, ctx);
    const saved = Object.keys(patch).map((f) => (f === 'customer_contact' ? 'contact' : f));
    if (Object.keys(patch).length) {
      await updateDraft(ref, patch, { chatId: ctx.chatId }).catch(() => null);
      logEvent('booking_information_pasted', { booking_ref: ref, fields: Object.keys(patch), via: 'caption' });
    }
    if (vin && looksLikeVin(vin)) {
      const settled = await settleVin(session, vin, ctx);
      if (!settled.ok && settled.ended) return { ended: true, reply: settled.reply };
      if (settled.ok) saved.push('vin');
    }
    return { ended: false, saved };
  }

  const banked = await bankTheRest(session, value, ctx);
  if (banked.ended) return { ended: true, reply: banked.ended };
  return { ended: false, saved: banked.saved ?? [] };
}

/**
 * The next question, from what the request actually has.
 *
 * Papers can arrive at any point now - attached to the very message that
 * gives the chassis - so after a file the flow does not assume it is at the
 * document step. Whatever is missing first is asked for first: a basic, then
 * the MRN choice, then the papers; and when nothing is, the card.
 */
async function continueFrom(booking, ctx, { leads = [] } = {}) {
  const missing = missingBasics(booking);
  if (missing.length) {
    const next = await askNextBasic(booking, ctx, { listMissing: true, intro: false });
    return reply([...leads, ...next.messages], next.patch);
  }

  if (!booking.mrn_choice) {
    // A client who has just sent their MRN has answered "do you have one".
    // Asking anyway is the kind of thing that makes a bot tiring to use.
    const state = await bookingDocumentState({
      bookingRef: booking.booking_ref, chatId: ctx.chatId, vin: booking.vin, mrnChoice: 'existing',
    });
    if (state.ok && state.received_types.includes('mrn')) {
      const saved = await updateDraft(booking.booking_ref, { mrn_choice: 'existing', mrn_needed: false }, { chatId: ctx.chatId });
      if (saved.ok) {
        const next = await documentPrompt(saved.draft, ctx);
        return reply([...leads, ...next.messages], next.patch);
      }
    }
    return reply([...leads, say(M.askMrnChoice(), kb.mrnChoice())], { current_state: S.BOOK_MRN_CHOICE });
  }

  const next = await documentPrompt(booking, ctx);
  return reply([...leads, ...next.messages], next.patch);
}

/**
 * Everything in a pasted block that survives validation.
 *
 * The parser suggests; this decides. A port still has to be one of the five and
 * a chassis still has to look like a chassis, exactly as if each value had been
 * typed on its own - a paste is a faster way to answer, never a way around the
 * checks.
 */
async function applyPastedFields(session, text, ctx) {
  const parsed = parsePastedFields(text);
  const patch = {};
  const rejected = [];

  if (parsed.make) {
    Object.assign(patch, normaliseMake(parsed.make));
  }

  if (parsed.customer_name && parsed.customer_name.length <= 120) {
    patch.customer_name = parsed.customer_name;
  }

  if (parsed.origin_port && parsed.origin_port.length <= 120) {
    patch.origin_port = normalisePlace(parsed.origin_port);
  }

  if (parsed.destination_port) {
    const port = matchPort(parsed.destination_port);
    if (port) patch.destination_port = port;
    else rejected.push(parsed.destination_port);
  }

  // A number in the block is the booking's number, in the one stored shape.
  if (parsed.customer_contact) {
    const phone = normalizePhone(parsed.customer_contact);
    if (phone) {
      patch.customer_contact = phone;
      await rememberClientContact(ctx.clientId, { phone }).catch(() => null);
    }
  }

  // The chassis is deliberately NOT taken from a paste. It decides whether the
  // unit may be booked at all, and that verdict runs through settleVin - which
  // has to look it up, not just store it.
  return { patch, rejected, vin: parsed.vin ?? null };
}

/**
 * A pasted block of details, answering several questions at once.
 *
 * Taking it beats refusing it: everything asked for is in the message, and a
 * client who is told "that is rather long" has to retype what they already
 * sent. Whatever the block did not contain is asked for next, as usual.
 *
 * @returns {Promise<object|null>} the reply, or null when the block held
 *   nothing usable and the caller should read the message as a plain answer
 */
async function handlePaste(session, value, ctx) {
  const { patch, rejected, vin } = await applyPastedFields(session, value, ctx);
  if (!Object.keys(patch).length && !vin) return null;

  let draft = null;
  if (Object.keys(patch).length) {
    const saved = await updateDraft(session.active_booking_ref, patch, { chatId: ctx.chatId });
    if (!saved.ok) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));
    draft = saved.draft;

    logEvent('booking_information_pasted', {
      booking_ref: session.active_booking_ref, fields: Object.keys(patch),
    });
  }

  const messages = [];
  // A port we do not serve is said out loud rather than silently dropped,
  // or the client sees us ask for a destination they believe they gave.
  for (const bad of rejected) {
    messages.push(say(M.destinationNotServed(bad, DESTINATION_PORTS)));
  }

  // The chassis in the block is looked up, exactly as if it had been typed at
  // the chassis question. A block pasted at the name step with a unit that is
  // already booked ends the flow right here, with the existing reference.
  if (vin && looksLikeVin(vin)) {
    const settled = await settleVin(session, vin, ctx);
    if (!settled.ok) return settled.reply;
    draft = settled.draft;
  }

  if (!draft) draft = await bookingByRef(session.active_booking_ref);
  if (!draft) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));

  const next = await askNextBasic(draft, ctx);
  return reply([...messages, ...next.messages], next.patch);
}

/** Make, client name and port of loading: free text, stored as given. */
export async function handleBasicField(session, field, text, ctx, { editing = false } = {}) {
  const value = String(text ?? '').trim();
  if (!value) return reply(say(M.notUnderstood(), kb.homeOnly()));

  if (!editing && looksLikePaste(value)) {
    const pasted = await handlePaste(session, value, ctx);
    if (pasted) return pasted;
  }

  // The answer to the question that was asked, out of whatever was written
  // around it: a labelled row, a sentence, or the bare value.
  const bare = extractField(field, value);

  // "yes" to the suggested name means the suggestion, not the word "yes".
  const resolved = field === 'customer_name' && isYes(bare) && ctx.userName ? ctx.userName : bare;

  if (resolved.length > 120) {
    return reply(say(both(
      'الرد ده طويل أوي. ابعت القيمة بس - أو ابعت البيانات كلها في جدول والاسم قدام كل قيمة.',
      'That is rather long. Send just the value - or paste the whole table with a label in front of each value.',
    ), kb.homeOnly()));
  }

  // Before storing free text, check it is not a question, another field, or a
  // request to go elsewhere. Without this "what makes do you accept?" becomes
  // the manufacturer.
  let resolvedValue = resolved;
  let notedPhone = null;
  const verdict = classify(field, value);
  if (verdict.kind !== 'answer') {
    const understood = await handleUnexpected(session, field, value, ctx);
    if (understood?.passToAssistant || understood?.switchTo) return understood;
    if (understood?.messages) return reply(understood.messages, understood.patch ?? {});
    if (understood?.answer) resolvedValue = understood.answer;
    if (understood?.noted?.kind === 'phone') notedPhone = understood.noted.value;
  }

  const fields = { [field]: resolvedValue };

  // One normaliser per field, shared with the paste and sentence paths, so all
  // three agree about what مرسيدس and فيلنيوس mean.
  if (field === 'make') Object.assign(fields, normaliseMake(resolvedValue));
  if (field === 'origin_port') fields.origin_port = normalisePlace(resolvedValue);

  const saved = await updateDraft(session.active_booking_ref, fields, { chatId: ctx.chatId });
  if (!saved.ok) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));

  logEvent('booking_information_updated', { booking_ref: session.active_booking_ref, field });

  if (editing) return backToConfirmation(session, ctx, { lead: M.editSaved() });
  return askNextBasic(saved.draft, ctx, { notedPhone });
}

/**
 * Editing "the route" - the loading point, then the destination.
 *
 * It cannot go through handleBasicField: that one asks for whatever is missing
 * NEXT, and on a complete request the next thing is the MRN question. A client
 * correcting their port of loading was shown "Perfect, let us continue" and the
 * MRN buttons, while the flow was actually waiting for a destination. Two
 * explicit steps, no reuse.
 */
export async function handleEditPol(session, text, ctx) {
  const value = String(text ?? '').trim();
  if (!value) return reply(say(M.askPol(), kb.homeOnly()));

  const saved = await updateDraft(session.active_booking_ref, { origin_port: value }, { chatId: ctx.chatId });
  if (!saved.ok) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));

  return reply(
    say(M.askDestination(DESTINATION_PORTS), kb.homeOnly()),
    { current_state: S.BOOK_EDIT_DESTINATION },
  );
}

/** The Egyptian destination, which must be one of the five we serve. */
export async function handleDestination(session, text, ctx, { editing = false } = {}) {
  const port = matchPort(text);
  if (!port) {
    const understood = await handleUnexpected(session, 'destination_port', text, ctx);
    if (understood?.passToAssistant || understood?.switchTo) return understood;
    if (understood?.messages) return reply(understood.messages, understood.patch ?? {});
    // A port the model recovered is still checked against the five we serve.
    const recovered = understood?.answer ? matchPort(understood.answer) : null;
    if (!recovered) {
      return reply(say(M.destinationNotServed(String(text).trim(), DESTINATION_PORTS), kb.homeOnly()));
    }
    const saved = await updateDraft(session.active_booking_ref, { destination_port: recovered }, { chatId: ctx.chatId });
    if (!saved.ok) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));
    if (editing) return backToConfirmation(session, ctx, { lead: M.editSaved() });
    return askNextBasic(saved.draft, ctx);
  }

  const saved = await updateDraft(session.active_booking_ref, { destination_port: port }, { chatId: ctx.chatId });
  if (!saved.ok) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));

  if (editing) return backToConfirmation(session, ctx, { lead: M.editSaved() });
  return askNextBasic(saved.draft, ctx);
}

// ---------------------------------------------------------------------------
// Step 3 - MRN and documents
// ---------------------------------------------------------------------------

export async function handleMrnChoice(session, answer, ctx) {
  if (!['existing', 'mky_issue', 'mky_both'].includes(answer)) {
    return reply(say(M.askMrnChoice(), kb.mrnChoice()));
  }

  // One question, two answers: who obtains the MRN (which decides what the
  // customer must send), and whether MKY issues the CMR as well. A customer
  // with their own MRN who wants our CMR is rare enough to arrange in the
  // chat; the desk can set it either way.
  const choice = answer === 'mky_both' ? 'mky_issue' : answer;
  const cmr = answer === 'mky_both' ? 'mky_issue' : 'own';

  const saved = await updateDraft(
    session.active_booking_ref,
    { mrn_choice: choice, cmr_choice: cmr, mrn_needed: choice === 'mky_issue', current_step: S.BOOK_DOCUMENTS },
    { chatId: ctx.chatId },
  );
  if (!saved.ok) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));

  await audit({
    actor_type: 'client', actor_id: ctx.chatId,
    action: 'mrn_choice_set',
    entity_type: 'booking', entity_id: session.active_booking_ref,
    metadata: { choice },
  });

  if (choice === 'mky_issue') {
    // The application is opened now, so the customs desk sees it even if the
    // client never sends another message.
    const opened = await openMrnRequest({
      bookingRef: saved.draft.booking_ref,
      clientId: ctx.clientId ?? null,
      chatId: ctx.chatId,
      vin: saved.draft.vin,
    });

    const messages = [say(M.mrnMkyChosen())];
    if (cmr === 'mky_issue') messages.push(say(M.cmrMkyChosen()));
    if (opened.ok && opened.request) {
      messages.push(say(M.mrnRequestOpened(opened.request.request_ref)));
      operationsNotifier().notifyMRNRequest(opened.request, saved.draft).catch(() => null);
    }
    messages.push(say(M.mrnMkyNeedsInfo(), kb.documentStep({ canSkip: true })));
    return reply(messages, { current_state: S.BOOK_MRN_SUPPORTING_INFO });
  }

  return documentPrompt(saved.draft, ctx, { lead: null });
}

/** Free-text detail for an MRN application MKY is making on the client's behalf. */
export async function handleMrnSupportingInfo(session, text, ctx) {
  const request = await mrnRequestFor(session.active_booking_ref);
  if (request) await addSuppliedInformation(request.request_ref, text);

  const booking = await bookingByRef(session.active_booking_ref);
  if (!booking) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));

  return documentPrompt(booking, ctx, {
    lead: both('تمام، سجلت التفاصيل مع طلب الـ MRN.', 'Noted — that is on your MRN request.'),
  });
}

/** Says which documents are still wanted, in the roadmap's two shapes. */
export async function documentPrompt(booking, ctx, { lead = null } = {}) {
  const state = await bookingDocumentState({
    bookingRef: booking.booking_ref,
    chatId: ctx.chatId,
    vin: booking.vin,
    mrnChoice: booking.mrn_choice ?? 'existing',
  });

  if (!state.ok) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));

  const messages = [];
  if (lead) messages.push(say(lead));

  // A paper for a different vehicle is its own problem, raised before anything
  // else: a chassis mismatch is what gets a customs declaration rejected.
  //
  // One warning per WRONG CHASSIS, not per file. Correcting the chassis after
  // sending three papers made all three mismatch at once, and the client got
  // the identical sentence three times running.
  const warnedAbout = new Set();
  for (const wrong of state.mismatched) {
    if (warnedAbout.has(wrong.vin)) continue;
    warnedAbout.add(wrong.vin);
    messages.push(say(M.documentWrongChassis(wrong.vin, booking.vin)));
  }

  if (state.complete) {
    messages.push(say(M.documentsComplete()));
    const card = await confirmationCard(booking, state);
    messages.push(say(card, kb.confirmBooking()));
    await updateDraft(booking.booking_ref, { current_step: S.BOOK_FINAL_CONFIRMATION }, { chatId: ctx.chatId })
      .catch(() => null);
    return reply(messages, { current_state: S.BOOK_FINAL_CONFIRMATION });
  }

  const ar = state.missing.map((t) => DOC_LABELS[t]?.[0] ?? t);
  const en = state.missing.map((t) => DOC_LABELS[t]?.[1] ?? t);

  // Nothing received yet is a first ask, not a nag; after that the wording
  // changes with how much is left, which is what tells a client they are nearly
  // finished rather than back at the beginning.
  if (!state.received_types.length) {
    messages.push(say(M.mrnExistingChosen(ar, en), kb.documentStep({ canSkip: false })));
  } else if (state.missing.length === 1) {
    messages.push(say(M.documentsOneMissing(ar[0], en[0]), kb.documentStep({ canSkip: false })));
  } else {
    messages.push(say(M.documentsStillMissing(ar, en), kb.documentStep({ canSkip: false })));
  }

  return reply(messages, { current_state: S.BOOK_DOCUMENTS });
}

/**
 * A file arrived while a booking is in progress - or several did, together.
 *
 * The transport has already stored and read it; this reports what it was and
 * asks the next question. Only what the database says was stored is
 * acknowledged - "received" is never said on the strength of an upload having
 * been attempted.
 *
 * `batch` is every file that arrived with this one. Three papers sent as one
 * album are three webhook calls; the transport lets only the last to finish
 * reading come here, and it brings the others along, so the client gets one
 * "received: invoice, brief, MRN" and one next question - not three answers,
 * each with a shorter list of what is missing.
 */
export async function handleDocumentArrived(session, { ingested, batch = [], noted = [] }, ctx) {
  let booking = await bookingByRef(session.active_booking_ref);
  if (!booking) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));

  const mine = ingested?.document ?? null;
  const arrived = batch.length ? batch : [mine].filter(Boolean);
  const known = arrived.filter((d) => d.doc_type && d.doc_type !== 'other');
  const unknown = arrived.filter((d) => !d.doc_type || d.doc_type === 'other');

  // What the message with the files said, read back alongside them.
  const details = notedDetails(booking, noted);

  const leads = [];
  if (arrived.length === 1 && known.length === 1 && !details.en.length) {
    const type = known[0].doc_type;
    leads.push(say(M.documentReceived(DOC_LABELS[type]?.[0] ?? type, DOC_LABELS[type]?.[1] ?? type)));
  } else if (known.length) {
    const types = [...new Set(known.map((d) => d.doc_type))];
    leads.push(say(M.documentsReceived(
      types.map((t) => DOC_LABELS[t]?.[0] ?? t),
      types.map((t) => DOC_LABELS[t]?.[1] ?? t),
      details.ar,
      details.en,
    )));
  } else if (details.en.length) {
    leads.push(say(M.notedFromMessage(details.ar, details.en)));
  }
  for (const d of known) logEvent('document_received', { booking_ref: booking.booking_ref, doc_type: d.doc_type });

  // What the papers say, onto a draft that does not say it yet - so the next
  // question is the one thing they do not answer, not the four they do.
  const read = await adoptFromPapers(session, booking, known, ctx);
  if (read.ended) return reply([...leads, ...read.reply.messages], read.reply.patch);
  booking = read.booking;
  if (read.filled.length) {
    const fromPapers = notedDetails(booking, read.filled);
    if (fromPapers.en.length) leads.push(say(M.notedFromPapers(fromPapers.ar, fromPapers.en)));
  }

  // A file we could not tell the type of is not guessed at. The client says
  // what it is - one at a time when several came together - and until they do
  // the file is stored but counted as nothing.
  if (unknown.length) {
    const [first, ...rest] = unknown;
    return askWhatItIs(session, booking, ctx, { document: first, remaining: rest.map((d) => d.id), leads });
  }

  // A second copy of a paper we already hold waits to be asked about rather
  // than taking the first one's place.
  const again = await duplicatesAmong(booking, known, ctx);
  if (again.length) {
    const [first, ...rest] = again;
    return askReplaces(session, booking, ctx, { pair: first, remaining: rest, leads });
  }

  return continueFrom(booking, ctx, { leads });
}

/**
 * What the papers themselves say, written onto a draft that does not say it.
 *
 * WHY THIS EXISTS. In the live test a client sent an invoice, a CMR and an
 * export declaration. All three were read; all three named the chassis, the
 * make, the model and where the vehicle loads; the reading was stored on every
 * document row - and the next thing the bot said was "we are missing some
 * information: chassis, make, port of loading". Asking somebody for what they
 * have just sent you is the fastest way to make a booking assistant feel like
 * a form that does not listen.
 *
 * WHAT IT WILL AND WILL NOT TAKE.
 *
 * Only a field the draft has not got: anything the client typed, or the desk
 * set, outranks a reading, always.
 *
 * The chassis goes through settleVin - the same door a typed one goes through
 * - so the duplicate check, the audit entry and the "already booked" ending
 * are the ones they have always been, and a vehicle we already hold still
 * fills in its own make. Only when the papers agree with each other: two
 * chassis numbers across one batch is the mismatch the desk exists to catch,
 * and adopting either would hide it.
 *
 * The destination is never taken. An invoice names the buyer's office, a CMR
 * names where the lorry unloads - in this test, "Klaipeda Port, Lithuania",
 * the port it SAILS FROM. A forwarder that guessed the discharge port from an
 * address would be wrong at exactly the moment it mattered, so that one
 * question is still asked.
 */
async function adoptFromPapers(session, booking, papers, ctx) {
  const filled = [];
  let current = booking;
  if (!papers.length || current.status !== 'draft') return { booking: current, filled };

  // The invoice first: its loading place comes from the Incoterm - "FOB
  // Klaipeda" - which is the agreed port. A CMR's is wherever the lorry was
  // loaded, a yard inland, which is a city and not a port.
  const ordered = [...papers].sort((a, b) => (a.doc_type === 'invoice' ? -1 : 0) - (b.doc_type === 'invoice' ? -1 : 0));
  const said = (key) => {
    for (const d of ordered) {
      const value = String(d?.extracted?.[key] ?? '').trim();
      if (value && value.length <= 120) return value;
    }
    return null;
  };

  if (!String(current.vin ?? '').trim()) {
    // Seventeen characters exactly, not the six a typed answer is allowed:
    // nobody is here to confirm a reading, so a half-caught number off a bad
    // photograph has to fall through to the question rather than be written
    // down as this vehicle's identity.
    const vins = [...new Set(ordered
      .map((d) => normalizeVin(d?.extracted?.vin ?? d?.vin ?? ''))
      .filter((v) => v.length === 17 && looksLikeVin(v)))];
    if (vins.length === 1) {
      const settled = await settleVin(session, vins[0], ctx);
      // Already booked ends the conversation with the existing reference, as a
      // typed chassis does. Any other refusal - a database that did not answer
      // - just leaves the chassis to be asked for, which is where we were.
      if (settled.ended) return { booking: current, filled, ended: true, reply: settled.reply };
      if (settled.ok) {
        current = settled.draft;
        filled.push('vin');
      }
    }
  }

  const patch = {};
  if (!String(current.make ?? '').trim()) {
    const make = said('make');
    // The same normaliser the typed and pasted answers use, so مرسيدس, a
    // reading and a typed "mercedes benz" all become one make.
    if (make) Object.assign(patch, normaliseMake(make));
  }
  if (!String(current.model ?? '').trim() && !patch.model) {
    const model = said('model');
    if (model) patch.model = model;
  }
  if (!String(current.origin_port ?? '').trim()) {
    const place = said('origin_place');
    if (place) patch.origin_port = normalisePlace(place);
  }

  if (Object.keys(patch).length) {
    const saved = await updateDraft(current.booking_ref, patch, { chatId: ctx.chatId });
    if (saved.ok) {
      current = saved.draft;
      filled.push(...Object.keys(patch));
      logEvent('booking_information_from_documents', {
        booking_ref: current.booking_ref, fields: Object.keys(patch),
      });
    }
  }

  return { booking: current, filled: [...new Set(filled)] };
}

/**
 * A file for a request that is already with the desk.
 *
 * There is no step to continue: the transport has filed it against the
 * booking and the desk sees it in the console - and when the desk had asked
 * for it, the state machine has already recorded it as the answer and said so
 * (lib/answers.js), so this is the paper nobody asked for. What the
 * client needs is to hear that - not "I did not follow that", which is what a
 * flow that only knew about drafts had to say.
 */
export function acknowledgeForSubmitted(booking, { ingested, batch = [] }) {
  const { labelsAr, labelsEn } = paperLabels({ ingested, batch });
  return reply(say(M.documentsForBooking(booking.booking_ref, labelsAr, labelsEn), kb.afterSubmitted()));
}

/** The papers of one arrival - a file, or a batch - and what to call them in each language. */
function paperLabels({ ingested, batch = [] }) {
  const arrived = batch.length ? batch : [ingested?.document].filter(Boolean);
  const types = [...new Set(arrived.map((d) => d.doc_type).filter((t) => t && t !== 'other'))];
  const unknown = arrived.filter((d) => !d.doc_type || d.doc_type === 'other');
  return {
    ids: arrived.map((d) => d.id).filter((id) => id != null),
    labelsAr: [...types.map((t) => DOC_LABELS[t]?.[0] ?? t), ...unknown.map((d) => d.file_name ?? DOC_LABELS.other[0])],
    labelsEn: [...types.map((t) => DOC_LABELS[t]?.[1] ?? t), ...unknown.map((d) => d.file_name ?? DOC_LABELS.other[1])],
  };
}

/**
 * Papers for a request already with the desk: filed on it, and said so. They
 * were said to be "received for booking X" but left on no booking - so the
 * desk, which reads a case's papers by reference, never saw them.
 */
export async function papersForSubmitted(booking, { ingested, batch = [] }) {
  const { ids } = paperLabels({ ingested, batch });
  await fileDocuments(ids, { bookingRef: booking.booking_ref, vin: booking.vin });
  return acknowledgeForSubmitted(booking, { ingested, batch });
}

/**
 * Papers sent with nothing open to put them on. Kept, and said so: "I did not
 * follow that", which is what the customer heard in the live test, sounded as
 * if the paper was lost. With no booking at all, the way to start one - the
 * paper then counts for it, as every loose paper from the chat does. With a
 * confirmed booking, the question of which: theirs, or a new one.
 */
export function papersWithNoRequest({ ingested, batch = [] }, confirmed = null) {
  const { ids, labelsAr, labelsEn } = paperLabels({ ingested, batch });
  if (confirmed) {
    return reply(
      say(M.fileWhichBooking(confirmed.booking_ref, labelsAr, labelsEn), kb.fileToChoice(confirmed.booking_ref)),
      { context: { unfiled_document_ids: ids } },
    );
  }
  return reply(say(M.fileNoBooking(labelsAr, labelsEn), kb.mainMenu()));
}

/**
 * Papers from a client whose booking is confirmed. Read as naming its chassis,
 * lib/documents.js has already filed them on it, and that is said; anything
 * still loose may be for a new booking, so they are asked which.
 */
export async function papersForConfirmed(confirmed, arrived) {
  const { ids } = paperLabels(arrived);
  const on = await bookingRefsOf(ids);
  if (ids.length && ids.every((id) => on.get(Number(id)) === confirmed.booking_ref)) {
    return acknowledgeForSubmitted(confirmed, arrived);
  }
  return papersWithNoRequest(arrived, confirmed);
}

/**
 * "Add to that booking": the papers just sent go on the client's own booking.
 * The reference comes back from a button, so it is checked to be this chat's.
 */
export async function fileToBooking(session, ref, ctx) {
  const target = await bookingByRef(ref);
  if (!target || String(target.chat_id) !== String(ctx.chatId)) return reply(say(M.notUnderstood(), kb.mainMenu()));

  const asked = session.context?.unfiled_document_ids ?? [];
  const ids = asked.length ? asked : (await looseDocuments(ctx.chatId)).map((d) => d.id);
  const { filed } = await fileDocuments(ids, { bookingRef: target.booking_ref, vin: target.vin });
  if (filed.length) {
    audit({
      actor_type: 'client', actor_id: ctx.chatId,
      action: 'documents_filed_by_client',
      entity_type: 'booking', entity_id: target.booking_ref,
      metadata: { document_ids: filed },
    });
  }
  return reply(say(M.filedTo(target.booking_ref), kb.afterSubmitted()), {
    active_flow: null, current_state: S.MAIN_MENU, active_booking_ref: null, context: {},
  });
}

async function askWhatItIs(session, booking, ctx, { document, remaining = [], leads = [] }) {
  const state = await bookingDocumentState({
    bookingRef: booking.booking_ref, chatId: ctx.chatId,
    vin: booking.vin, mrnChoice: booking.mrn_choice ?? 'existing',
  });
  const choices = state.ok && state.missing.length ? state.missing : ['invoice', 'brief', 'mrn'];

  const context = { ...session.context, pending_document_id: document?.id ?? null };
  if (remaining.length) context.unclassified_document_ids = remaining;
  else delete context.unclassified_document_ids;

  return reply(
    [...leads, say(M.documentUnknownType(document?.file_name ?? null), kb.classifyDocument(choices))],
    { current_state: S.BOOK_DOCUMENT_CLASSIFY, context },
  );
}

/**
 * Papers that have arrived of a type this booking already holds.
 *
 * WHY THE CUSTOMER IS ASKED RATHER THAN THE NEWEST SIMPLY WINNING.
 *
 * One type arriving twice is ordinary: a clearer scan of a dark photograph,
 * the right vehicle's invoice after the wrong one, the same file sent again
 * because they were not sure it arrived. Which of those it is, only they know.
 * The newest used to win silently, which changed the booking under Operations
 * - sometimes replacing a paper they had already checked - and told nobody.
 *
 * The new one is set aside the moment it is spotted, so nothing counts it
 * until the question is answered.
 */
async function duplicatesAmong(booking, arrived, ctx) {
  if (!arrived.length || booking.status !== 'draft') return [];
  const { db } = await import('../supabase.js');
  const arrivedIds = new Set(arrived.map((d) => d.id));

  // The same papers bookingDocumentState counts: this booking's, and the ones
  // still loose in this chat, which is how they arrive before anything has
  // attached them. One filed against a different request is that one's.
  const { data: rows, error } = await db()
    .from('booking_documents')
    .select('id, doc_type, file_name, status, uploaded_at, booking_ref, vin')
    .eq('chat_id', String(ctx.chatId))
    .is('deleted_at', null);
  if (error || !rows?.length) return [];

  // A paper for another vehicle is not this booking's paper of that type, so a
  // right one arriving after a wrong one is not a replacement - it is the
  // first one that counts. The mismatch warning is what speaks to the wrong
  // one, and it already stops repeating itself once the right one is in.
  const norm = booking.vin ? normalizeVin(booking.vin) : null;
  const mine = (d) => !norm || !d.vin || normalizeVin(d.vin) === norm;
  const held = rows.filter((d) => (!d.booking_ref || d.booking_ref === booking.booking_ref) && mine(d));

  const pairs = [];
  const taken = new Set();
  for (const doc of arrived) {
    if (!mine(doc)) continue;
    // The oldest live paper of this type that did not arrive with this batch.
    const existing = held
      .filter((d) => d.doc_type === doc.doc_type && !arrivedIds.has(d.id) && !taken.has(d.id) && !SET_ASIDE.has(d.status))
      .sort((a, b) => String(a.uploaded_at ?? '').localeCompare(String(b.uploaded_at ?? '')))[0];
    if (!existing) continue;
    taken.add(existing.id);
    pairs.push({ incoming: doc.id, incomingFile: doc.file_name ?? null, existing: existing.id, existingFile: existing.file_name ?? null, type: doc.doc_type });
  }

  if (pairs.length) {
    const { error: parked } = await db().from('booking_documents')
      .update({ status: 'pending_replace' })
      .in('id', pairs.map((p) => p.incoming));
    if (parked) console.error('setting a repeated document aside failed:', parked.message);
    logEvent('document_repeated', {
      booking_ref: booking.booking_ref, chat_id: String(ctx.chatId), types: pairs.map((p) => p.type).join(','),
    });
  }
  return pairs;
}

/** The question itself: one pair at a time, the rest kept for after the answer. */
function askReplaces(session, booking, ctx, { pair, remaining = [], leads = [] }) {
  const label = DOC_LABELS[pair.type]?.[1] ?? 'document';
  const context = { ...session.context, pending_replace: pair };
  if (remaining.length) context.pending_replace_rest = remaining;
  else delete context.pending_replace_rest;

  return reply(
    [...leads, say(M.documentReplace(label, pair.existingFile, pair.incomingFile), kb.replaceDocument())],
    { current_state: S.BOOK_DOCUMENT_REPLACE, context },
  );
}

/** Their answer: which copy of a paper sent twice is the one that counts. */
export async function handleReplaceAnswer(session, answer, ctx) {
  const pair = session.context?.pending_replace ?? null;
  const booking = await bookingByRef(session.active_booking_ref);
  if (!booking) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));
  if (!pair) return continueFrom(booking, ctx);

  const { db } = await import('../supabase.js');
  const replace = answer === 'yes';
  const label = DOC_LABELS[pair.type]?.[1] ?? 'document';

  if (replace) {
    await db().from('booking_documents')
      .update({ status: 'received', replaces_id: pair.existing }).eq('id', pair.incoming);
    await db().from('booking_documents').update({ status: 'replaced' }).eq('id', pair.existing);
  } else {
    await db().from('booking_documents').update({ status: 'duplicate' }).eq('id', pair.incoming);
  }
  logEvent(replace ? 'document_replaced_by_client' : 'document_duplicate_kept', {
    booking_ref: booking.booking_ref, doc_type: pair.type,
  });
  await audit({
    actor_type: 'client', actor_id: ctx.chatId,
    action: replace ? 'document_replaced' : 'document_duplicate_discarded',
    entity_type: 'booking_document', entity_id: String(pair.incoming),
    metadata: { booking_ref: booking.booking_ref, doc_type: pair.type, replaces: String(pair.existing) },
  });

  const lead = say(replace ? M.documentReplaced(label) : M.documentKeptFirst(label));

  // The next one, when several of a batch were repeats.
  const rest = session.context?.pending_replace_rest ?? [];
  if (rest.length) {
    const [next, ...later] = rest;
    return askReplaces({ ...session, context: { ...session.context } }, booking, ctx, { pair: next, remaining: later, leads: [lead] });
  }

  const context = { ...session.context };
  delete context.pending_replace;
  delete context.pending_replace_rest;
  const next = await continueFrom(booking, ctx, { leads: [lead] });
  return reply(next.messages, { ...next.patch, context });
}

/** The client telling us what an unreadable file was. */
export async function handleDocumentClassified(session, type, ctx) {
  const id = session.context?.pending_document_id;
  const booking = await bookingByRef(session.active_booking_ref);
  if (!booking) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));

  const { db } = await import('../supabase.js');

  if (id && type && type !== 'other') {
    await db().from('booking_documents').update({ doc_type: type }).eq('id', id);
    logEvent('document_classified_by_client', { booking_ref: booking.booking_ref, doc_type: type });
  }

  const leads = type && type !== 'other'
    ? [say(M.documentReceived(DOC_LABELS[type]?.[0] ?? type, DOC_LABELS[type]?.[1] ?? type))]
    : [];

  // The next of the files that came together, if any is still unnamed.
  const queue = [...(session.context?.unclassified_document_ids ?? [])];
  if (queue.length) {
    const [nextId, ...rest] = queue;
    const { data: doc } = await db().from('booking_documents').select('id, file_name').eq('id', nextId).maybeSingle();
    return askWhatItIs(session, booking, ctx, { document: doc ?? { id: nextId }, remaining: rest, leads });
  }

  const context = { ...session.context };
  delete context.pending_document_id;
  delete context.unclassified_document_ids;

  const next = await continueFrom(booking, ctx, { leads });
  return reply(next.messages, { ...next.patch, context });
}

// ---------------------------------------------------------------------------
// Step 3 - the summary, the edit menu, the yes
// ---------------------------------------------------------------------------

/**
 * The card the client approves.
 *
 * Built here from the row, never written by a model, so what the client agrees
 * to is exactly what the operations desk will read back out of the database.
 * A document line says received or not received - never "verified", which is
 * Operations' word.
 */
export async function confirmationCard(booking, documentState = null) {
  const state = documentState ?? await bookingDocumentState({
    bookingRef: booking.booking_ref,
    chatId: booking.chat_id,
    vin: booking.vin,
    mrnChoice: booking.mrn_choice ?? 'existing',
  });

  // Labels on one line - "العميل / Client" - until the client has chosen a
  // language, and in that language alone after. The values are the paperwork's
  // and are never translated.
  const docLines = (state?.required ?? []).map((type) => {
    const have = state.received_types?.includes(type);
    const label = pair(DOC_LABELS[type]?.[0] ?? type, DOC_LABELS[type]?.[1] ?? type);
    return `${have ? '✅' : '❌'} ${label}`;
  });

  if (booking.mrn_choice === 'mky_issue') {
    docLines.push(`🕒 MRN — ${pair('MKY تستخرجه', 'MKY is obtaining it')}`);
  }

  // "telegram:6284…" is our own routing address, not something the client
  // recognises as their number.
  const phone = looksLikePhone(booking.customer_contact) ? booking.customer_contact : '—';

  const lines = [
    pick(M.confirmHeaderAr, M.confirmHeaderEn, '\n'),
    '',
    `👤 ${pair('العميل', 'Client')}: ${booking.customer_name ?? '—'}`,
    `📱 ${pair('الموبايل', 'Phone')}: ${phone}`,
    `🚘 ${pair('الشاسيه', 'Chassis · VIN')}: ${booking.vin ?? '—'}`,
    `🚗 ${pair('الماركة', 'Make')}: ${[booking.make, booking.model].filter(Boolean).join(' ') || '—'}`,
    // The Egyptian port in Arabic for a chat that chose Arabic; the booking
    // keeps the name customs use, and so does a card read by both.
    `🌍 ${pair('خط الشحن', 'Route')}: ${booking.origin_port ?? '—'} ${routeArrow()} ${booking.destination_port ? portName(booking.destination_port) : '—'}`,
    '',
    `📄 ${pair('المستندات', 'Documents')}:`,
    ...(docLines.length ? docLines : ['—']),
  ];

  return lines.join('\n');
}

/** Redraws the summary - after an edit, or when the client asks to see it. */
export async function backToConfirmation(session, ctx, { lead = null } = {}) {
  const booking = await bookingByRef(session.active_booking_ref);
  if (!booking) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));

  // An edit may have re-opened something: a changed chassis has to face the
  // duplicate rule again, and a changed route or MRN choice changes which
  // documents are required. Both are re-run rather than assumed.
  const missing = missingBasics(booking);
  if (missing.length) {
    const next = await askNextBasic(booking, ctx);
    const head = lead ? [say(lead)] : [];
    return reply([...head, ...next.messages], next.patch);
  }

  const state = await bookingDocumentState({
    bookingRef: booking.booking_ref, chatId: ctx.chatId,
    vin: booking.vin, mrnChoice: booking.mrn_choice ?? 'existing',
  });

  const messages = [];
  if (lead) messages.push(say(lead));

  if (state.ok && !state.complete) {
    const next = await documentPrompt(booking, ctx);
    return reply([...messages, ...next.messages], next.patch);
  }

  messages.push(say(await confirmationCard(booking, state), kb.confirmBooking()));
  return reply(messages, { current_state: S.BOOK_FINAL_CONFIRMATION });
}

export function editMenu(session) {
  return reply(say(M.askWhatToEdit(), kb.editMenu()), { current_state: S.BOOK_EDIT_MENU });
}

/**
 * The question this booking is waiting on, asked again - after the client
 * switched language, or tapped a button that belongs to another step.
 *
 * Nothing is written and nothing moves on: the state is where it was and the
 * draft is untouched, so whatever they answer next is the answer to it. Null
 * when there is no live draft behind the state, and the caller shows the menu.
 */
export async function repeatQuestion(session, ctx) {
  const ref = session.active_booking_ref;
  const booking = ref ? await bookingByRef(ref) : null;
  if (!booking || booking.status !== 'draft') return null;

  switch (session.current_state) {
    case S.BOOK_DRAFT_RESUME:
      return reply(say(M.draftFound(booking.booking_ref, booking.vin), kb.resumeDraft()));
    case S.BOOK_CLIENT_NAME:
    case S.BOOK_EDIT_CLIENT_NAME:
      return reply(say(M.askClientName(session.current_state === S.BOOK_CLIENT_NAME ? ctx.userName ?? null : null), kb.homeOnly()));
    case S.BOOK_CLIENT_PHONE:
      return reply(phonePrompt(ctx, M.askPhone(await suggestedPhone(ctx), whatsappNumber(ctx))));
    case S.BOOK_EDIT_CLIENT_PHONE:
      return reply(phonePrompt(ctx, M.askPhone(null, whatsappNumber(ctx))));
    case S.BOOK_VIN:
    case S.BOOK_EDIT_VIN:
      return reply(say(M.askVin(), kb.homeOnly()));
    case S.BOOK_MAKE:
    case S.BOOK_EDIT_MAKE:
      return reply(say(M.askMake(), kb.homeOnly()));
    case S.BOOK_POL:
    case S.BOOK_EDIT_POL:
      return reply(say(M.askPol(), kb.homeOnly()));
    case S.BOOK_DESTINATION:
    case S.BOOK_EDIT_DESTINATION:
      return reply(say(M.askDestination(DESTINATION_PORTS), kb.homeOnly()));
    case S.BOOK_MRN_CHOICE:
      return reply(say(M.askMrnChoice(), kb.mrnChoice()));
    case S.BOOK_MRN_SUPPORTING_INFO:
      return reply(say(M.mrnMkyNeedsInfo(), kb.documentStep({ canSkip: true })));
    case S.BOOK_DOCUMENTS:
      return documentPrompt(booking, ctx);
    case S.BOOK_DOCUMENT_CLASSIFY:
      return askWhatItIs(session, booking, ctx, {
        document: { id: session.context?.pending_document_id ?? null },
        remaining: session.context?.unclassified_document_ids ?? [],
      });
    case S.BOOK_FINAL_CONFIRMATION:
      return backToConfirmation(session, ctx);
    case S.BOOK_EDIT_MENU:
      return editMenu(session);
    case S.BOOK_CANCEL_CONFIRM:
      return reply(say(M.cancelConfirmAsk(booking.booking_ref), kb.cancelConfirm()));
    default:
      return null;
  }
}

const EDIT_TARGETS = {
  vin: { state: S.BOOK_EDIT_VIN, ask: () => M.askVin() },
  make: { state: S.BOOK_EDIT_MAKE, ask: () => M.askMake() },
  customer_name: { state: S.BOOK_EDIT_CLIENT_NAME, ask: () => M.askClientName(null) },
  route: { state: S.BOOK_EDIT_POL, ask: () => M.askPol() },
};

export async function handleEditChoice(session, target, ctx) {
  if (target === 'back') return backToConfirmation(session, ctx);

  // The number has its own prompt: on Telegram it comes with the share button,
  // on WhatsApp with the number being written from.
  if (target === 'phone') {
    return reply(phonePrompt(ctx, M.askPhone(null, whatsappNumber(ctx))), { current_state: S.BOOK_EDIT_CLIENT_PHONE });
  }

  if (target === 'documents') {
    const booking = await bookingByRef(session.active_booking_ref);
    if (!booking) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));
    return documentPrompt(booking, ctx, {
      lead: both('ابعت المستند الجديد وهيحل محل القديم.', 'Send the new document and it will replace the old one.'),
    });
  }

  const spec = EDIT_TARGETS[target];
  if (!spec) return editMenu(session);

  return reply(say(spec.ask(), kb.homeOnly()), { current_state: spec.state });
}

/**
 * The client saying yes.
 *
 * Everything that decides whether this may happen is checked again here and
 * then again inside the database function - because the card the button is
 * attached to may be hours old, and the world may have moved since.
 */
export async function handleConfirm(session, ctx) {
  // The session may have lost its reference - a reset, an expiry, a card tapped
  // from far up the chat. The request itself is still in the database, and
  // apologising for a technical fault when nothing is broken is the worst of
  // both: the client cannot proceed and has no idea why.
  let ref = session.active_booking_ref;
  let booking = ref ? await bookingByRef(ref) : null;

  if (!booking) {
    const { draft } = await findDraft(ctx.chatId);
    booking = draft ?? null;
    ref = draft?.booking_ref ?? null;
  }

  if (!booking) {
    return reply(say(M.nothingToCancel(), kb.mainMenu()), {
      active_flow: null, current_state: S.MAIN_MENU, active_booking_ref: null, context: {},
    });
  }

  // A stale button on an already-submitted request: say so, do not resubmit.
  if (booking.status !== 'draft') {
    return reply(
      say(M.submittedAlready(booking.booking_ref), kb.afterSubmitted()),
      { active_flow: null, current_state: S.BOOK_SUBMITTED, active_booking_ref: booking.booking_ref, context: {} },
    );
  }

  const missing = missingBasics(booking);
  if (missing.length) {
    const next = await askNextBasic(booking, ctx);
    return reply([
      say(M.missingBasics(missing.map((f) => FIELD_LABELS[f][0]), missing.map((f) => FIELD_LABELS[f][1]))),
      ...next.messages,
    ], next.patch);
  }

  const docs = await bookingDocumentState({
    bookingRef: booking.booking_ref, chatId: ctx.chatId,
    vin: booking.vin, mrnChoice: booking.mrn_choice ?? 'existing',
  });

  const config = await settings();
  const mrnPending = booking.mrn_choice === 'mky_issue';
  const holdForMrn = mrnPending && config.allow_submit_while_mrn_pending === false;

  if (docs.ok && !docs.complete) {
    const ar = docs.missing.map((t) => DOC_LABELS[t]?.[0] ?? t);
    const en = docs.missing.map((t) => DOC_LABELS[t]?.[1] ?? t);
    return reply([
      say(M.submitBlockedDocuments(ar, en)),
      say(M.documentsStillMissing(ar, en), kb.documentStep({ canSkip: false })),
    ], { current_state: S.BOOK_DOCUMENTS });
  }

  if (holdForMrn) {
    return reply(say(both(
      'الطلب هيستنى لحد ما نستخرج الـ MRN، وهنبعتلك أول ما يجهز.',
      'This request will wait until the MRN has been issued. We will message you as soon as it is ready.',
    ), kb.homeOnly()), { current_state: S.BOOK_DOCUMENTS });
  }

  // The language it was booked in goes with it, whatever was set before.
  const spoken = currentLanguage();
  if (spoken && booking.language !== spoken) await updateDraft(ref, { language: spoken }, { chatId: ctx.chatId });

  const result = await submitDraft(ref, ctx.chatId);

  if (!result.ok) {
    if (result.reason === 'duplicate') {
      return reply(
        say(M.submitBlockedDuplicate(result.booking_ref), kb.alreadyBooked()),
        { active_flow: null, current_state: S.MAIN_MENU, active_booking_ref: null, context: {} },
      );
    }
    return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));
  }

  // Already submitted - a retried callback or a second tap. One message, no
  // second task, no second confirmation.
  if (result.already) {
    return reply(
      say(M.submittedAlready(result.booking_ref), kb.afterSubmitted()),
      { active_flow: null, current_state: S.BOOK_SUBMITTED, active_booking_ref: ref, context: {} },
    );
  }

  const submitted = await bookingByRef(ref);

  // The client's copy of the paperwork, through the outbox so a Telegram
  // hiccup retries rather than losing it. The text that answers the yes is
  // sent by the transport, below, with the reference in it; the PDF's caption
  // carries the reference too. Queuing the text as well sent the same
  // confirmation twice, one after the other, to every client who booked.
  await enqueue({
    chatId: ctx.chatId,
    clientId: ctx.clientId ?? null,
    eventType: 'booking_request_pdf',
    entityType: 'booking',
    entityId: ref,
    idempotencyKey: `booking_request_pdf:${ref}`,
    payload: { booking_ref: ref },
  });

  // The emails - to the client where we have an address, and to the operations
  // inbox with the PDF attached. Telegram is skipped here because the outbox
  // above owns that; sending from both would deliver the PDF twice.
  //
  // This was lost when the state machine replaced the model's booking tool:
  // create_booking used to call notifyBooking and nothing else did, so for a
  // while a client got a confirmation message and no document at all.
  if (submitted) {
    notifyBooking(submitted, { skipCustomerTelegram: true }).catch((err) => {
      console.error('booking notification failed:', err?.message);
    });
  }

  // The desk hears about it. Never allowed to affect whether the booking stuck.
  operationsNotifier()
    .notifyNewBooking(submitted ?? booking, { task_ref: null })
    .catch(() => null);

  // The reference is KEPT on the session. Cleared, a second tap on the same
  // card found no request and apologised for a technical fault, when what had
  // actually happened was that the booking went through the first time.
  return reply(
    say(M.submitted(ref), kb.afterSubmitted()),
    { active_flow: null, current_state: S.BOOK_SUBMITTED, active_booking_ref: ref, context: {} },
  );
}

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------

export async function askCancel(session, ctx) {
  const ref = session.active_booking_ref;
  if (!ref) return reply(say(M.nothingToCancel(), kb.mainMenu()), { active_flow: null, current_state: S.MAIN_MENU });

  const booking = await bookingByRef(ref);
  if (!booking || booking.status !== 'draft') {
    return reply(say(M.nothingToCancel(), kb.mainMenu()), {
      active_flow: null, current_state: S.MAIN_MENU, active_booking_ref: null, context: {},
    });
  }

  return reply(say(M.cancelConfirmAsk(ref), kb.cancelConfirm()), {
    current_state: S.BOOK_CANCEL_CONFIRM,
    context: { ...session.context, cancel_return_state: session.current_state },
  });
}

export async function handleCancelDecision(session, decision, ctx) {
  if (decision !== 'yes') {
    const back = session.context?.cancel_return_state;
    const booking = session.active_booking_ref ? await bookingByRef(session.active_booking_ref) : null;
    if (booking) {
      const resumed = await backToConfirmation(session, ctx);
      return reply(resumed.messages, resumed.patch);
    }
    return reply(say(M.menu(), kb.mainMenu()), {
      active_flow: null, current_state: back ?? S.MAIN_MENU,
    });
  }

  const ref = session.active_booking_ref;
  const result = await cancelDraft(ref, ctx.chatId);
  const text = result.ok ? M.cancelled(ref) : M.nothingToCancel();

  // And any older unfinished request behind it, or the next Book tap offers
  // that one back as if it were the client's own idea.
  await cancelAllDrafts(ctx.chatId);

  return reply(say(text, kb.mainMenu()), {
    active_flow: null, current_state: S.MAIN_MENU, active_booking_ref: null, context: {},
  });
}

export async function resumeDraft(session, decision, ctx) {
  if (decision === 'restart') {
    // Starting over means over: every unfinished request in the chat goes,
    // not only the one that was offered.
    await cancelAllDrafts(ctx.chatId);
    return newDraft(session, ctx);
  }

  const booking = await bookingByRef(session.active_booking_ref);
  if (!booking || booking.status !== 'draft') return newDraft(session, ctx);

  return continueFrom(booking, ctx);
}
