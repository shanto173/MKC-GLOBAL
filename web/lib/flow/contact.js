/**
 * "Contact our team" - the four routes the roadmap defines.
 *
 * Two rules run through all of it. A client is never asked to guess what our
 * desks are called: they pick from a list. And the Operations contact details
 * are read from configuration; when nobody has configured them the bot says it
 * cannot give a number rather than inventing one, which is the single worst
 * thing it could do.
 */

import { db } from '../supabase.js';
import { S, FLOWS } from './states.js';
import { M, both, DOC_LABELS } from './messages.js';
import * as kb from './keyboards.js';
import { config, DEPARTMENTS } from '../config.js';
import { operationsContact } from '../settings.js';
import { operationsNotifier, createTask } from '../operations.js';
import { findBookingForClient } from '../bookings.js';
import { bookingDocumentState } from '../documents.js';
import { lookupForClient, shipmentCard, bookingCard } from './tracking.js';
import { audit, logEvent } from '../audit.js';

const say = (text, inline = null) => ({ text, ...(inline ? { inline } : {}) });
const reply = (messages, patch = {}) => ({ messages: [].concat(messages), patch });

/**
 * Asking for a phone number is the one place a REPLY keyboard beats an inline
 * one: Telegram only hands a bot a verified number through a contact button,
 * and a typed number arrives with a digit missing often enough to matter.
 */
const askForContact = () => ({
  text: M.askProblemAndPhone(),
  keyboard: kb.SHARE_PHONE_KEYBOARD,
  oneTime: true,
});

/** Which desk each route belongs to. Named here so a ticket is never mis-filed. */
const DEPARTMENT_FOR = {
  booking: 'Booking Operations',
  tracking: 'Tracking Desk',
  documents: 'Customs Documentation',
  operations: 'Booking Operations',
  other: 'Customer Care',
};

export function contactMenu() {
  return reply(say(M.contactMenu(), kb.contactMenu()), {
    active_flow: FLOWS.CONTACT,
    current_state: S.CONTACT_MENU,
  });
}

// ---------------------------------------------------------------------------
// 1 - Booking
// ---------------------------------------------------------------------------

export function askBookingIdentifier(session) {
  return reply(say(M.contactAskBookingId(), kb.homeOnly()), {
    current_state: S.CONTACT_BOOKING_IDENTIFIER,
  });
}

export async function handleBookingIdentifier(session, text, ctx) {
  const result = await findBookingForClient(text, { chatId: ctx.chatId, clientId: ctx.clientId ?? null });

  if (!result.found) {
    return reply(say(M.trackingNotFound(), kb.trackingNotFound()), {
      current_state: S.CONTACT_BOOKING_IDENTIFIER,
    });
  }

  const b = result.booking;
  const docs = await bookingDocumentState({
    bookingRef: b.booking_ref, chatId: ctx.chatId, vin: b.vin,
    mrnChoice: b.mrn_choice ?? 'existing',
  });

  const card = [
    `📋 ${b.booking_ref}`,
    b.vin ? `الشاسيه / Chassis: ${b.vin}` : null,
    `الماركة / Make: ${[b.make, b.model].filter(Boolean).join(' ') || '—'}`,
    `العميل / Client: ${b.customer_name ?? '—'}`,
    `خط الشحن / Route: ${b.origin_port ?? '—'} → ${b.destination_port ?? '—'}`,
    `الحالة / Status: ${String(b.status).replace(/_/g, ' ')}`,
    docs.ok && docs.missing.length
      ? `ناقص / Outstanding: ${docs.missing.map((t) => DOC_LABELS[t]?.[1] ?? t).join(', ')}`
      : docs.ok ? 'المستندات / Documents: ✅' : null,
  ].filter(Boolean).join('\n');

  return reply([
    say(card),
    say(M.contactMenu(), kb.contactMenu()),
  ], { current_state: S.CONTACT_MENU });
}

// ---------------------------------------------------------------------------
// 2 - Shipment tracking
// ---------------------------------------------------------------------------

export function askTrackingIdentifier(session) {
  return reply(say(M.askTrackingId(), kb.homeOnly()), {
    current_state: S.CONTACT_TRACKING_IDENTIFIER,
  });
}

export async function handleTrackingIdentifier(session, text, ctx) {
  const result = await lookupForClient(text, { chatId: ctx.chatId, clientId: ctx.clientId ?? null });

  if (result.found) {
    return reply([
      say(M.trackingFound()),
      say(shipmentCard(result.shipment), kb.trackingFound(result.shipment.shipment_id)),
    ], { current_state: S.TRACK_RESULTS, active_flow: FLOWS.TRACKING });
  }
  if (result.booking) {
    return reply(
      say(bookingCard(result.booking), kb.trackingFound(result.booking.booking_ref)),
      { current_state: S.TRACK_RESULTS, active_flow: FLOWS.TRACKING },
    );
  }
  return reply(say(M.trackingNotFound(), kb.trackingNotFound()), {
    current_state: S.CONTACT_TRACKING_IDENTIFIER,
  });
}

// ---------------------------------------------------------------------------
// 3 - Documents
// ---------------------------------------------------------------------------

export function documentsMenu() {
  return reply(say(M.contactDocumentsMenu(), kb.documentsHelpMenu()), {
    current_state: S.CONTACT_DOCUMENT_MENU,
  });
}

/**
 * What is outstanding, computed from the client's own live request. Never a
 * recited list: a client who has sent everything must not be told to send it.
 */
export async function handleDocumentsChoice(session, choice, ctx) {
  const booking = await liveBookingFor(ctx);

  if (choice === 'missing' || choice === 'upload') {
    if (!booking) {
      return reply(say(both(
        'مفيش عندك طلب حجز شغال دلوقتي عشان نعرف المستندات الناقصة. تحب تبدأ حجز جديد؟',
        'You do not have a booking request open, so there is nothing to check documents against. Would you like to start one?',
      ), kb.mainMenu()), { active_flow: null, current_state: S.MAIN_MENU });
    }

    const state = await bookingDocumentState({
      bookingRef: booking.booking_ref, chatId: ctx.chatId,
      vin: booking.vin, mrnChoice: booking.mrn_choice ?? 'existing',
    });

    if (!state.ok) return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));

    if (state.complete) {
      return reply(say(both(
        `مفيش ناقص على الطلب ${booking.booking_ref}.`,
        `Nothing is outstanding on ${booking.booking_ref}.`,
      ), kb.homeOnly()), { current_state: S.CONTACT_DOCUMENT_MENU });
    }

    const ar = state.missing.map((t) => DOC_LABELS[t]?.[0] ?? t);
    const en = state.missing.map((t) => DOC_LABELS[t]?.[1] ?? t);
    const message = state.missing.length === 1
      ? M.documentsOneMissing(ar[0], en[0])
      : M.documentsStillMissing(ar, en);

    // Uploading resumes the booking flow, so the file lands on the right
    // request rather than floating loose in the conversation.
    return reply(say(message, kb.homeOnly()), {
      active_flow: FLOWS.BOOKING,
      current_state: S.BOOK_DOCUMENTS,
      active_booking_ref: booking.booking_ref,
    });
  }

  if (choice === 'request') {
    return reply(say(both(
      'اكتبلي المستند اللي محتاجه ورقم الحجز لو معاك.',
      'Tell me which document you need, and the booking reference if you have it.',
    ), kb.homeOnly()), {
      current_state: S.CONTACT_DOCUMENT_REQUEST,
      context: { ...session.context, department: DEPARTMENT_FOR.documents },
    });
  }

  // "Other"
  return reply(askForContact(), {
    current_state: S.CONTACT_TICKET_DETAILS,
    context: { ...session.context, department: DEPARTMENT_FOR.documents },
  });
}

// ---------------------------------------------------------------------------
// 4 - Talk to Operations
// ---------------------------------------------------------------------------

export async function talkToOperations(session, ctx) {
  const contact = await operationsContact();

  const messages = [say(M.contactOperations())];
  messages.push(say(contact.configured ? M.operationsContact(contact) : M.operationsContactUnknown()));

  // A request to speak to a person is logged whether or not we could hand over
  // a number, so the desk can call back either way.
  await createTask({
    taskType: 'client_callback',
    clientId: ctx.clientId ?? null,
    chatId: ctx.chatId,
    channel: ctx.channel,
    priority: 'high',
    payload: { requested_at: new Date().toISOString(), contact_shown: contact.configured },
    notes: contact.configured ? null : 'No operations phone configured - the client was not given a number.',
    // One callback request per client per hour, so tapping the button five
    // times does not put five identical tasks on the desk.
    idempotencyKey: `client_callback:${ctx.chatId}:${new Date().toISOString().slice(0, 13)}`,
  });

  logEvent('operations_contact_requested', { chat_id: String(ctx.chatId), configured: contact.configured });

  messages.push(askForContact());
  return reply(messages, {
    active_flow: FLOWS.CONTACT,
    current_state: S.CONTACT_TICKET_DETAILS,
    context: { ...session.context, department: DEPARTMENT_FOR.operations },
  });
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const PHONE = /(\+?\d[\d\s().-]{7,}\d)/;

/**
 * Takes the problem and a way to reach the client, and raises the ticket.
 *
 * Both are asked for together, once. A ticket with no number is a note to
 * nobody, but a client who will not give one still gets a ticket - with the
 * chat as the contact - rather than being asked a fourth time.
 */
export async function handleTicketDetails(session, text, ctx) {
  const body = String(text ?? '').trim();
  const department = DEPARTMENTS.includes(session.context?.department)
    ? session.context.department
    : DEPARTMENT_FOR.other;

  const phone = body.match(PHONE)?.[0]?.trim() ?? null;
  const email = body.match(EMAIL)?.[0] ?? null;
  const contact = phone || email || ctx.sharedPhone || null;

  if (body.length < 8 && !contact) {
    return reply(askForContact(), { current_state: S.CONTACT_TICKET_DETAILS });
  }

  const ticketRef = `${config.refPrefix}-TKT-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const row = {
    ticket_ref: ticketRef,
    channel: ctx.channel,
    chat_id: String(ctx.chatId),
    department,
    customer: ctx.userName ?? null,
    contact: contact ?? `${ctx.channel}:${ctx.chatId}`,
    summary: body || 'The client asked to speak to someone.',
  };

  const { data, error } = await db().from('support_tickets').insert(row).select().single();
  if (error) {
    console.error('ticket insert failed:', error.message);
    return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));
  }

  await createTask({
    taskType: 'client_callback',
    clientId: ctx.clientId ?? null,
    chatId: ctx.chatId,
    channel: ctx.channel,
    priority: 'normal',
    payload: { ticket_ref: data.ticket_ref, department, contact: row.contact },
    idempotencyKey: `ticket:${data.ticket_ref}`,
  });

  operationsNotifier().notifyClientContactRequest(data).catch(() => null);

  await audit({
    actor_type: 'client', actor_id: ctx.chatId,
    action: 'support_ticket_created',
    entity_type: 'support_ticket', entity_id: data.ticket_ref,
    metadata: { department, has_phone: Boolean(phone) },
  });

  return reply(say(M.ticketOpened(data.ticket_ref, department), kb.mainMenu()), {
    active_flow: null, current_state: S.MAIN_MENU, context: {},
  });
}

/** "Request a document" - a ticket with the request in it. */
export async function handleDocumentRequest(session, text, ctx) {
  return handleTicketDetails(
    { ...session, context: { ...session.context, department: DEPARTMENT_FOR.documents } },
    `Document requested: ${String(text ?? '').trim()}`,
    ctx,
  );
}

/** The newest request this client has that documents could belong to. */
async function liveBookingFor(ctx) {
  const { data } = await db()
    .from('bookings')
    .select('*')
    .eq('chat_id', String(ctx.chatId))
    .in('status', ['draft', 'pending_review', 'under_review', 'needs_client_action'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}
