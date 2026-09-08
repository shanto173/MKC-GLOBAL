/**
 * The booking conversation: roadmap steps 1 to 4, as a state machine.
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

import { S, FLOWS } from './states.js';
import { M, FIELD_LABELS, DOC_LABELS, both } from './messages.js';
import * as kb from './keyboards.js';
import {
  findDraft, createDraft, updateDraft, bookingByRef, missingBasics,
  lookupVehicle, submitDraft, cancelDraft, looksLikeVin, normalizeVin, matchPort,
} from '../bookings.js';
import { bookingDocumentState } from '../documents.js';
import { parsePastedFields, looksLikePaste, splitMakeModel, extractField } from './paste.js';
import { openMrnRequest, mrnRequestFor, addSuppliedInformation } from '../mrn.js';
import { operationsNotifier } from '../operations.js';
import { enqueue } from '../outbox.js';
import { notifyBooking } from '../notify.js';
import { settings } from '../settings.js';
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

// ---------------------------------------------------------------------------
// Step 1 - starting, and the chassis check
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

  if (draft) {
    return reply(
      say(M.draftFound(draft.booking_ref, draft.vin), kb.resumeDraft()),
      { active_flow: FLOWS.BOOKING, current_state: S.BOOK_DRAFT_RESUME, active_booking_ref: draft.booking_ref },
    );
  }

  return newDraft(session, ctx);
}

async function newDraft(session, ctx) {
  const created = await createDraft({
    chatId: ctx.chatId,
    clientId: ctx.clientId ?? null,
    channel: ctx.channel,
    telegramUserId: ctx.telegramUserId ?? null,
  });
  if (!created.ok) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));

  return reply(
    say(M.askVin(), kb.homeOnly()),
    {
      active_flow: FLOWS.BOOKING,
      current_state: S.BOOK_VIN,
      active_booking_ref: created.draft.booking_ref,
      context: {},
    },
  );
}

/**
 * The chassis number, and the three-way verdict the roadmap defines.
 *
 * `excludeBookingRef` matters when a client is EDITING the chassis on their own
 * unfinished request: their own draft must not be reported as a clash with
 * itself.
 */
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
    return reply(say(M.vinTooShort(), kb.homeOnly()));
  }

  const ref = session.active_booking_ref;
  const result = await lookupVehicle(typed, { excludeBookingRef: ref });
  if (!result.ok) {
    if (result.reason === 'too_short') return reply(say(M.vinTooShort(), kb.homeOnly()));
    return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));
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
    return reply(
      say(M.vinAlreadyBooked(b), kb.alreadyBooked()),
      { active_flow: null, current_state: S.MAIN_MENU, active_booking_ref: null, context: {} },
    );
  }

  // Branches A and B both continue; B pre-fills from what we already hold, so
  // the client is not asked for a make we have on file.
  const patch = { vin: typed.toUpperCase().replace(/\s+/g, ''), current_step: S.BOOK_MAKE };
  const v = result.vehicle;
  if (v?.make && !editing) patch.make = v.make;
  if (v?.model && !editing) patch.model = v.model;

  const saved = await updateDraft(ref, patch, { chatId: ctx.chatId });
  if (!saved.ok) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));

  const opening = editing
    ? M.editSaved()
    : result.verdict === 'new'
      ? M.vinNew()
      : `${M.vinKnown()}\n\n${M.vinKnownContinue()}`;

  if (editing) {
    return backToConfirmation(session, ctx, { lead: opening });
  }

  const next = await askNextBasic(saved.draft, ctx, { listMissing: true });
  return reply([say(opening), ...next.messages], next.patch);
}

// ---------------------------------------------------------------------------
// Step 2 - the basics
// ---------------------------------------------------------------------------

/**
 * Asks for the next thing this request is missing, in a fixed order.
 *
 * One question at a time, as the roadmap has it. The bulk list is reserved for
 * the case where several are missing at once - after an edit, or after a client
 * pasted a half-filled form - because a wall of questions is what people ignore.
 */
export async function askNextBasic(booking, ctx, { listMissing = false } = {}) {
  const missing = missingBasics(booking);

  if (!missing.length) {
    return reply(
      [say(M.basicsComplete()), say(M.askMrnChoice(), kb.mrnChoice())],
      { current_state: S.BOOK_MRN_CHOICE },
    );
  }

  const [next] = missing;

  // The list of what is outstanding is shown ONCE, on the way into step 2, so
  // the client knows how much is coming. Repeating it after every answer - which
  // it did - reads as being asked for the same things over and over, which is
  // the single complaint this flow exists to stop.
  const preface = listMissing && missing.length > 1
    ? [say(M.missingBasics(
        missing.map((f) => FIELD_LABELS[f][0]),
        missing.map((f) => FIELD_LABELS[f][1]),
      ))]
    : [];

  const prompts = {
    vin: () => say(M.askVin(), kb.homeOnly()),
    make: () => say(M.askMake(), kb.homeOnly()),
    customer_name: () => say(M.askClientName(ctx.userName ?? null), kb.homeOnly()),
    origin_port: () => say(M.askPol(), kb.homeOnly()),
    destination_port: () => say(M.askDestination(DESTINATION_PORTS), kb.homeOnly()),
  };

  const states = {
    vin: S.BOOK_VIN,
    make: S.BOOK_MAKE,
    customer_name: S.BOOK_CLIENT_NAME,
    origin_port: S.BOOK_POL,
    destination_port: S.BOOK_DESTINATION,
  };

  await updateDraft(booking.booking_ref, { current_step: states[next] }, { chatId: ctx.chatId })
    .catch(() => null);

  return reply([...preface, prompts[next]()], { current_state: states[next] });
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
    const { make, model } = splitMakeModel(parsed.make);
    if (make.length <= 120) {
      patch.make = make;
      if (model) patch.model = model;
    }
  }

  if (parsed.customer_name && parsed.customer_name.length <= 120) {
    patch.customer_name = parsed.customer_name;
  }

  if (parsed.origin_port && parsed.origin_port.length <= 120) {
    patch.origin_port = parsed.origin_port;
  }

  if (parsed.destination_port) {
    const port = matchPort(parsed.destination_port);
    if (port) patch.destination_port = port;
    else rejected.push(parsed.destination_port);
  }

  // The chassis is deliberately NOT taken from a paste. It decides whether the
  // unit may be booked at all, and that verdict runs through handleVin - which
  // has to look it up, not just store it.
  return { patch, rejected, vin: parsed.vin ?? null };
}

/** Make, client name and port of loading: free text, stored as given. */
export async function handleBasicField(session, field, text, ctx, { editing = false } = {}) {
  const value = String(text ?? '').trim();
  if (!value) return reply(say(M.notUnderstood(), kb.homeOnly()));

  // A pasted block of details, answering several questions at once. Taking it
  // beats refusing it: everything asked for is in the message, and a client who
  // is told "that is rather long" has to retype what they already sent.
  if (!editing && looksLikePaste(value)) {
    const { patch, rejected } = await applyPastedFields(session, value, ctx);

    if (Object.keys(patch).length) {
      const saved = await updateDraft(session.active_booking_ref, patch, { chatId: ctx.chatId });
      if (!saved.ok) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));

      logEvent('booking_information_pasted', {
        booking_ref: session.active_booking_ref, fields: Object.keys(patch),
      });

      const messages = [];
      // A port we do not serve is said out loud rather than silently dropped,
      // or the client sees us ask for a destination they believe they gave.
      for (const bad of rejected) {
        messages.push(say(M.destinationNotServed(bad, DESTINATION_PORTS)));
      }

      const next = await askNextBasic(saved.draft, ctx);
      return reply([...messages, ...next.messages], next.patch);
    }
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

  const fields = { [field]: resolved };
  if (field === 'make') {
    const { make, model } = splitMakeModel(resolved);
    fields.make = make;
    if (model) fields.model = model;
  }

  const saved = await updateDraft(session.active_booking_ref, fields, { chatId: ctx.chatId });
  if (!saved.ok) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));

  logEvent('booking_information_updated', { booking_ref: session.active_booking_ref, field });

  if (editing) return backToConfirmation(session, ctx, { lead: M.editSaved() });
  return askNextBasic(saved.draft, ctx);
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
    return reply(say(M.destinationNotServed(String(text).trim(), DESTINATION_PORTS), kb.homeOnly()));
  }

  const saved = await updateDraft(session.active_booking_ref, { destination_port: port }, { chatId: ctx.chatId });
  if (!saved.ok) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));

  if (editing) return backToConfirmation(session, ctx, { lead: M.editSaved() });
  return askNextBasic(saved.draft, ctx);
}

// ---------------------------------------------------------------------------
// Step 3 - MRN and documents
// ---------------------------------------------------------------------------

export async function handleMrnChoice(session, choice, ctx) {
  if (!['existing', 'mky_issue'].includes(choice)) {
    return reply(say(M.askMrnChoice(), kb.mrnChoice()));
  }

  const saved = await updateDraft(
    session.active_booking_ref,
    { mrn_choice: choice, mrn_needed: choice === 'mky_issue', current_step: S.BOOK_DOCUMENTS },
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
 * A file arrived while a booking is in progress.
 *
 * The caller has already stored it; this reports what it was and what is left.
 * Only what the database says was stored is acknowledged - "received" is never
 * said on the strength of an upload having been attempted.
 */
export async function handleDocumentArrived(session, { ingested }, ctx) {
  const booking = await bookingByRef(session.active_booking_ref);
  if (!booking) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));

  const type = ingested?.document?.doc_type ?? 'other';
  const messages = [];

  if (type === 'other') {
    // We will not guess. The client says what it is, and until they do the
    // file is stored but counted as nothing.
    const state = await bookingDocumentState({
      bookingRef: booking.booking_ref, chatId: ctx.chatId,
      vin: booking.vin, mrnChoice: booking.mrn_choice ?? 'existing',
    });
    const choices = state.ok && state.missing.length ? state.missing : ['invoice', 'brief', 'mrn'];
    return reply(
      say(M.documentUnknownType(), kb.classifyDocument(choices)),
      { current_state: S.BOOK_DOCUMENT_CLASSIFY, context: { ...session.context, pending_document_id: ingested?.document?.id ?? null } },
    );
  }

  messages.push(say(M.documentReceived(DOC_LABELS[type]?.[0] ?? type, DOC_LABELS[type]?.[1] ?? type)));
  logEvent('document_received', { booking_ref: booking.booking_ref, doc_type: type });

  const next = await documentPrompt(booking, ctx);
  return reply([...messages, ...next.messages], next.patch);
}

/** The client telling us what an unreadable file was. */
export async function handleDocumentClassified(session, type, ctx) {
  const id = session.context?.pending_document_id;
  const booking = await bookingByRef(session.active_booking_ref);
  if (!booking) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));

  if (id && type && type !== 'other') {
    const { db } = await import('../supabase.js');
    await db().from('booking_documents').update({ doc_type: type }).eq('id', id);
    logEvent('document_classified_by_client', { booking_ref: booking.booking_ref, doc_type: type });
  }

  const context = { ...session.context };
  delete context.pending_document_id;

  const next = await documentPrompt(booking, ctx, {
    lead: type && type !== 'other'
      ? M.documentReceived(DOC_LABELS[type]?.[0] ?? type, DOC_LABELS[type]?.[1] ?? type)
      : null,
  });
  return reply(next.messages, { ...next.patch, context });
}

// ---------------------------------------------------------------------------
// Step 4 - the summary, the edit menu, the yes
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

  const docLines = (state?.required ?? []).map((type) => {
    const have = state.received_types?.includes(type);
    const label = `${DOC_LABELS[type]?.[0] ?? type} / ${DOC_LABELS[type]?.[1] ?? type}`;
    return `${have ? '✅' : '❌'} ${label}`;
  });

  if (booking.mrn_choice === 'mky_issue') {
    docLines.push('🕒 MRN — MKY تستخرجه / MKY is obtaining it');
  }

  const lines = [
    M.confirmHeaderAr,
    M.confirmHeaderEn,
    '',
    `🚘 الشاسيه / Chassis · VIN: ${booking.vin ?? '—'}`,
    `🚗 الماركة / Make: ${[booking.make, booking.model].filter(Boolean).join(' ') || '—'}`,
    `👤 العميل / Client: ${booking.customer_name ?? '—'}`,
    `🌍 خط الشحن / Route: ${booking.origin_port ?? '—'} → ${booking.destination_port ?? '—'}`,
    '',
    '📄 المستندات / Documents:',
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

const EDIT_TARGETS = {
  vin: { state: S.BOOK_EDIT_VIN, ask: () => M.askVin() },
  make: { state: S.BOOK_EDIT_MAKE, ask: () => M.askMake() },
  customer_name: { state: S.BOOK_EDIT_CLIENT_NAME, ask: () => M.askClientName(null) },
  route: { state: S.BOOK_EDIT_POL, ask: () => M.askPol() },
};

export async function handleEditChoice(session, target, ctx) {
  if (target === 'back') return backToConfirmation(session, ctx);

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

  // Told through the outbox rather than sent from here, so a Telegram hiccup
  // retries instead of losing the only acknowledgement the client gets.
  await enqueue({
    chatId: ctx.chatId,
    clientId: ctx.clientId ?? null,
    eventType: 'booking_request_submitted',
    entityType: 'booking',
    entityId: ref,
    idempotencyKey: `booking_request_submitted:${ref}`,
    payload: { booking_ref: ref },
  });

  // And their copy of the paperwork. A separate row with its own key: the
  // client should get the PDF even if the text failed, and vice versa.
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
    say(M.submitted(), kb.afterSubmitted()),
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

  return reply(say(text, kb.mainMenu()), {
    active_flow: null, current_state: S.MAIN_MENU, active_booking_ref: null, context: {},
  });
}

export async function resumeDraft(session, decision, ctx) {
  if (decision === 'restart') {
    if (session.active_booking_ref) await cancelDraft(session.active_booking_ref, ctx.chatId);
    return newDraft(session, ctx);
  }

  const booking = await bookingByRef(session.active_booking_ref);
  if (!booking || booking.status !== 'draft') return newDraft(session, ctx);

  const missing = missingBasics(booking);
  if (missing.length) return askNextBasic(booking, ctx, { listMissing: true });
  if (!booking.mrn_choice) {
    return reply(say(M.askMrnChoice(), kb.mrnChoice()), { current_state: S.BOOK_MRN_CHOICE });
  }
  return backToConfirmation(session, ctx);
}
