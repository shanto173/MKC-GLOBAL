/**
 * The state machine: one place where every transition is decided.
 *
 * The rule the whole design rests on - a transition is chosen by (current
 * state, event), both of which are facts, and never by asking a model what it
 * thinks should happen next. A model may read a chassis number out of a
 * sentence; it may not decide that the chassis number is acceptable, that the
 * booking is complete, or that it should be submitted.
 *
 * Handlers return { messages, patch } and send nothing themselves. This
 * function applies the patch, saves the session, and hands the messages back to
 * the transport. That is what makes the entire conversation testable without a
 * Telegram token and without a network.
 *
 * When the machine has nothing to say - free text while nothing is being asked
 * - it returns handled:false and the caller falls back to the knowledge
 * assistant. The flow's state is left untouched, so asking a question in the
 * middle of a booking does not lose the booking.
 */

import { S, FLOWS, AWAITING_TEXT, ACCEPTS_DOCUMENTS } from './states.js';
import { loadSession, saveSession, resetSession } from './store.js';
import { flowReady } from './ready.js';
import { M } from './messages.js';
import * as kb from './keyboards.js';
import { parseCallback } from './keyboards.js';
import * as booking from './booking.js';
import * as tracking from './tracking.js';
import * as contact from './contact.js';
import { bookingByRef, findDraft } from '../bookings.js';
import { logEvent } from '../audit.js';

const say = (text, inline = null) => ({ text, ...(inline ? { inline } : {}) });
const reply = (messages, patch = {}) => ({ messages: [].concat(messages), patch });

/**
 * @typedef {{kind: 'command'|'text'|'callback'|'document'|'contact',
 *            text?: string, command?: string,
 *            callback?: {ns: string, action: string, arg: string, id: string, messageId: number},
 *            document?: object, phone?: string}} FlowInput
 */

/**
 * @param {FlowInput} input
 * @param {{channel: string, chatId: string|number, clientId?: number|null,
 *          userName?: string, telegramUserId?: number|null, correlationId?: string}} ctx
 * @returns {Promise<{handled: boolean, messages: Array, state: string}>}
 */
export async function runFlow(input, ctx) {
  // Migration 008 not applied: the flow has nowhere to keep its state, so it
  // stands aside completely and the previous engine answers. Returning
  // handled:false rather than an error is what keeps the bot alive through a
  // deploy that beat its migration.
  if (!(await flowReady())) {
    return { handled: false, messages: [], state: S.MAIN_MENU, degraded: true };
  }

  const { session, error } = await loadSession(ctx);

  // A session we could not read is not an empty session. Saying so beats
  // silently restarting a booking the client has spent five minutes on.
  if (error) {
    return {
      handled: true,
      state: session.current_state,
      messages: [say(M.recoverableError(ctx.correlationId), kb.errorRecovery())],
    };
  }

  // The client row may have appeared since the session was created.
  if (ctx.clientId && session.client_id !== ctx.clientId) session.client_id = ctx.clientId;

  const result = await dispatch(session, input, ctx);

  if (!result.handled) {
    return { handled: false, messages: [], state: session.current_state };
  }

  // Remember which buttons were offered.
  //
  // Two things need this. The website widget has no inline keyboards, so a
  // client there answers "2" and it has to mean the second button. And a
  // Telegram client whose keyboard has scrolled away types the number too.
  // Recorded from what was actually sent, so it cannot drift from the buttons.
  const offered = (result.messages ?? [])
    .flatMap((m) => (m.inline ?? []).flat())
    .map((b) => ({ label: b.text, data: b.callback_data }));

  const patch = { ...(result.patch ?? {}) };
  patch.context = { ...(patch.context ?? session.context ?? {}), offered };

  const saved = await saveSession(session, patch);
  logEvent('flow_transition', {
    chat_id: String(ctx.chatId),
    from: session.current_state,
    to: saved.current_state,
    kind: input.kind,
    correlation_id: ctx.correlationId,
  });

  return { handled: true, messages: result.messages ?? [], state: saved.current_state, offered };
}

// ---------------------------------------------------------------------------

async function dispatch(session, input, ctx) {
  // 1. Commands come first, from any state. /cancel has to work when a client
  //    is stuck, which means it cannot be a transition out of one state only.
  if (input.kind === 'command') {
    const handled = await handleCommand(session, input.command, ctx);
    if (handled) return { handled: true, ...handled };
  }

  // 2. A tapped button. The payload says which button; this decides whether
  //    that is a legal move from where the conversation actually is.
  if (input.kind === 'callback') {
    const handled = await handleCallback(session, input.callback, ctx);
    return { handled: true, ...handled };
  }

  // 3. A shared phone number is an answer to the ticket question, wherever we
  //    are - Telegram sends it as its own kind of message.
  if (input.kind === 'contact') {
    return {
      handled: true,
      ...(await contact.handleTicketDetails(
        session,
        `${session.context?.pending_problem ?? 'The client asked to speak to someone.'} ${input.phone}`,
        { ...ctx, sharedPhone: input.phone },
      )),
    };
  }

  // 4. A file.
  if (input.kind === 'document') {
    if (ACCEPTS_DOCUMENTS.has(session.current_state)) {
      return { handled: true, ...(await booking.handleDocumentArrived(session, { ingested: input.document }, ctx)) };
    }

    // Sent outside the document step. Refusing it outright was wrong: a client
    // who sends their invoice a day later, from the menu, is sending it for the
    // request they have open, and being told "I did not follow that" while the
    // file sits unattached in storage is how paperwork gets lost. If there is a
    // request it can belong to, it belongs to that one.
    const { draft } = await findDraft(ctx.chatId);
    if (draft) {
      const resumed = { ...session, active_booking_ref: draft.booking_ref };
      const handled = await booking.handleDocumentArrived(resumed, { ingested: input.document }, ctx);
      return {
        handled: true,
        messages: handled.messages,
        patch: { ...handled.patch, active_flow: FLOWS.BOOKING, active_booking_ref: draft.booking_ref },
      };
    }

    // Nothing it could belong to. Say so rather than filing it against a
    // booking the client was not thinking about.
    return { handled: true, ...reply(say(M.notUnderstood(), kb.mainMenu())) };
  }

  // 5. Text. Only an answer when something was asked.
  //
  // This comes FIRST, before the numbered-button shortcut below: a client being
  // asked for their company name may perfectly well answer "7", and that is a
  // name, not a menu choice.
  if (AWAITING_TEXT.has(session.current_state)) {
    return { handled: true, ...(await handleText(session, input.text ?? '', ctx)) };
  }

  // 5b. A number standing in for a button. The website widget has no inline
  // keyboards at all, and this is how a client there answers.
  const picked = pickByNumber(input.text, session.context?.offered);
  if (picked) {
    const handled = await handleCallback(session, parseCallback(picked), ctx);
    return { handled: true, ...handled };
  }

  // 6. Text that starts a flow, from the menu or from anywhere idle.
  const intent = quickIntent(input.text);
  if (intent) {
    const started = await startFlow(session, intent, ctx);
    if (started) return { handled: true, ...started };
  }

  // Nothing to do: the knowledge assistant answers.
  return { handled: false };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function handleCommand(session, command, ctx) {
  switch (command) {
    case '/start':
    case '/menu':
      await resetSession(session);
      return reply(say(M.welcome(ctx.userName), kb.mainMenu()), {
        active_flow: null, current_state: S.MAIN_MENU, active_booking_ref: null, context: {},
      });

    case '/help':
      return reply(say(M.help(), kb.mainMenu()));

    case '/book':
      return booking.startBooking(session, ctx);

    case '/track':
      return tracking.askIdentifier(session);

    case '/cancel': {
      // Cancelling means the thing in progress, not the conversation. A
      // confirmed booking is never touched by it.
      if (session.active_flow === FLOWS.BOOKING && session.active_booking_ref) {
        return booking.askCancel(session, ctx);
      }
      const { draft } = await findDraft(ctx.chatId);
      if (draft) {
        return booking.askCancel({ ...session, active_booking_ref: draft.booking_ref }, ctx);
      }
      return reply(say(M.nothingToCancel(), kb.mainMenu()), {
        active_flow: null, current_state: S.MAIN_MENU, active_booking_ref: null, context: {},
      });
    }

    default:
      return null;      // /reset and friends are handled by the transport
  }
}

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

async function handleCallback(session, callback, ctx) {
  const { ns, action, arg } = callback;

  if (ns === 'menu') {
    switch (action) {
      case 'home':
        await resetSession(session);
        return reply(say(M.menu(), kb.mainMenu()), {
          active_flow: null, current_state: S.MAIN_MENU, active_booking_ref: null, context: {},
        });
      case 'book':
        return booking.startBooking(session, ctx);
      case 'track':
        return tracking.askIdentifier(session);
      case 'contact':
        return contact.contactMenu();
      case 'retry':
        return reply(say(M.menu(), kb.mainMenu()), { current_state: S.MAIN_MENU, active_flow: null });
      default:
        return reply(say(M.notUnderstood(), kb.mainMenu()));
    }
  }

  if (ns === 'bk') return bookingCallback(session, action, arg, ctx);
  if (ns === 'tr') return trackingCallback(session, action, arg, ctx);
  if (ns === 'ct') return contactCallback(session, action, arg, ctx);

  return reply(say(M.notUnderstood(), kb.mainMenu()));
}

async function bookingCallback(session, action, arg, ctx) {
  // Every branch below needs a live draft. A button pressed on a card from
  // yesterday, whose request has since been submitted or cancelled, must not
  // silently start editing something else.
  const needsDraft = ['mrn', 'confirm', 'edit', 'docs', 'doctype', 'cancel', 'draft'].includes(action);
  if (needsDraft && session.active_booking_ref) {
    const current = await bookingByRef(session.active_booking_ref);
    if (!current) {
      return reply(say(M.notUnderstood(), kb.mainMenu()), {
        active_flow: null, current_state: S.MAIN_MENU, active_booking_ref: null, context: {},
      });
    }
    if (current.status !== 'draft' && action !== 'confirm') {
      return reply(say(M.submittedAlready(current.booking_ref), kb.afterSubmitted()), {
        active_flow: null, current_state: S.MAIN_MENU, active_booking_ref: null, context: {},
      });
    }
  }

  switch (action) {
    case 'draft':
      return booking.resumeDraft(session, arg, ctx);

    case 'mrn':
      return booking.handleMrnChoice(session, arg, ctx);

    case 'docs':
      if (arg === 'later') {
        const b = await bookingByRef(session.active_booking_ref);
        return b ? booking.documentPrompt(b, ctx) : reply(say(M.notUnderstood(), kb.mainMenu()));
      }
      return reply(say(M.notUnderstood(), kb.mainMenu()));

    case 'doctype':
      return booking.handleDocumentClassified(session, arg, ctx);

    case 'confirm':
      return booking.handleConfirm(session, ctx);

    case 'edit':
      if (!arg) return booking.editMenu(session);
      return booking.handleEditChoice(session, arg, ctx);

    case 'cancel':
      if (arg === 'ask') return booking.askCancel(session, ctx);
      return booking.handleCancelDecision(session, arg, ctx);

    default:
      return reply(say(M.notUnderstood(), kb.mainMenu()));
  }
}

async function trackingCallback(session, action, arg, ctx) {
  if (action === 'refresh') return tracking.handleRefresh(session, arg, ctx);
  if (action === 'retry') return tracking.askIdentifier(session);
  return reply(say(M.notUnderstood(), kb.mainMenu()));
}

async function contactCallback(session, action, arg, ctx) {
  switch (action) {
    case 'booking': return contact.askBookingIdentifier(session);
    case 'tracking': return contact.askTrackingIdentifier(session);
    case 'docs':
      if (!arg) return contact.documentsMenu();
      return contact.handleDocumentsChoice(session, arg, ctx);
    case 'ops': return contact.talkToOperations(session, ctx);
    default: return reply(say(M.notUnderstood(), kb.mainMenu()));
  }
}

// ---------------------------------------------------------------------------
// Text, when something was asked
// ---------------------------------------------------------------------------

async function handleText(session, text, ctx) {
  switch (session.current_state) {
    case S.BOOK_VIN: return booking.handleVin(session, text, ctx);
    case S.BOOK_MAKE: return booking.handleBasicField(session, 'make', text, ctx);
    case S.BOOK_CLIENT_NAME: return booking.handleBasicField(session, 'customer_name', text, ctx);
    case S.BOOK_POL: return booking.handleBasicField(session, 'origin_port', text, ctx);
    case S.BOOK_DESTINATION: return booking.handleDestination(session, text, ctx);
    case S.BOOK_MRN_SUPPORTING_INFO: return booking.handleMrnSupportingInfo(session, text, ctx);

    case S.BOOK_EDIT_VIN: return booking.handleVin(session, text, ctx, { editing: true });
    case S.BOOK_EDIT_MAKE: return booking.handleBasicField(session, 'make', text, ctx, { editing: true });
    case S.BOOK_EDIT_CLIENT_NAME: return booking.handleBasicField(session, 'customer_name', text, ctx, { editing: true });
    case S.BOOK_EDIT_POL: return booking.handleEditPol(session, text, ctx);
    case S.BOOK_EDIT_DESTINATION: return booking.handleDestination(session, text, ctx, { editing: true });

    case S.TRACK_IDENTIFIER: return tracking.handleIdentifier(session, text, ctx);

    case S.CONTACT_BOOKING_IDENTIFIER: return contact.handleBookingIdentifier(session, text, ctx);
    case S.CONTACT_TRACKING_IDENTIFIER: return contact.handleTrackingIdentifier(session, text, ctx);
    case S.CONTACT_DOCUMENT_REQUEST: return contact.handleDocumentRequest(session, text, ctx);
    case S.CONTACT_TICKET_DETAILS: return contact.handleTicketDetails(session, text, ctx);

    default:
      return reply(say(M.notUnderstood(), kb.mainMenu()), { current_state: S.MAIN_MENU, active_flow: null });
  }
}

async function startFlow(session, intent, ctx) {
  if (intent === 'book') return booking.startBooking(session, ctx);
  if (intent === 'track') return tracking.askIdentifier(session);
  if (intent === 'contact') return contact.contactMenu();
  if (intent === 'menu') {
    return reply(say(M.welcome(ctx.userName), kb.mainMenu()), {
      active_flow: null, current_state: S.MAIN_MENU, active_booking_ref: null, context: {},
    });
  }
  return null;
}

/**
 * Intent from the client's own words, decided by keyword rather than by a model.
 *
 * Deliberately narrow: it only fires on phrasings that cannot mean anything
 * else. Anything less certain is left to the knowledge assistant, which can ask
 * - a wrong guess here drops someone into a booking they did not ask for.
 *
 * The bare digits are here because the numbered menu is what the operations
 * team trained clients to expect, and typed answers must keep working alongside
 * the buttons.
 */
/**
 * "2" when two buttons were offered means the second one.
 *
 * Only ever an INDEX into what was last offered, never a guess: a number
 * outside the range returns nothing, so the main menu's "1/2/3" keeps working
 * through quickIntent rather than being caught by a stale three-button list.
 */
export function pickByNumber(text, offered) {
  const s = String(text ?? '').trim();
  if (!Array.isArray(offered) || !offered.length) return null;

  // Western and Arabic-Indic digits, alone or as a keycap emoji.
  const normalised = s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
                      .replace(/️|⃣/g, '');
  if (!/^[1-9]$/.test(normalised)) return null;

  const index = Number(normalised) - 1;
  return offered[index]?.data ?? null;
}

export function quickIntent(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return null;

  if (/^(1|١|1️⃣)$/.test(s)) return 'book';
  if (/^(2|٢|2️⃣)$/.test(s)) return 'track';
  if (/^(3|٣|3️⃣)$/.test(s)) return 'contact';
  if (/^(menu|main menu|home|القائمة|الرئيسية)$/i.test(s)) return 'menu';

  // The reply-keyboard labels the old build shipped, so a client whose keyboard
  // is still on screen from before the upgrade is not left tapping dead buttons.
  if (/book my shipment|احجز شحنة/i.test(s)) return 'book';
  if (/track my shipment|تتبع شحنتي/i.test(s)) return 'track';
  if (/contact our team|تواصل مع فريقنا/i.test(s)) return 'contact';

  if (/^(book|new booking|i want to book|make a booking)\b/i.test(s)) return 'book';
  if (/^(track|tracking|where is my)\b/i.test(s)) return 'track';
  if (/^(help me|support|talk to (a )?(human|person|someone|agent))\b/i.test(s)) return 'contact';
  if (/عايز أحجز|عاوز احجز|عايز احجز|أحجز شحنة/i.test(s)) return 'book';
  if (/الشحنة فين|شحنتي فين|عايز أتتبع/i.test(s)) return 'track';
  if (/عايز أكلم|عايز اكلم|خدمة العملاء|موظف/i.test(s)) return 'contact';

  return null;
}
