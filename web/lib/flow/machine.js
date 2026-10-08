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
 *
 * Every turn runs in the client's language (lib/lang.js): the one they chose,
 * or both when they never have. The result says which, as `language`, so the
 * assistant answering a handled:false turn speaks it too.
 */

import { S, FLOWS, AWAITING_TEXT, ACCEPTS_DOCUMENTS } from './states.js';
import { loadSession, startSessionWrite, sessionAfter } from './store.js';
import { defer } from '../background.js';
import { flowReady } from './ready.js';
import { storedLanguage, rememberLanguage, languageSupported } from './language.js';
import { M, DOC_LABELS } from './messages.js';
import * as kb from './keyboards.js';
import { parseCallback } from './keyboards.js';
import * as booking from './booking.js';
import * as tracking from './tracking.js';
import * as contact from './contact.js';
import { findVin } from './paste.js';
import { bookingByRef, findDraft, openBookingFor, setDraftLanguage } from '../bookings.js';
import { setting } from '../settings.js';
import {
  withTurn, withLanguage, currentLanguage, normaliseLanguage, detectLanguage, languageFromChoice, looksFrancoArabic,
} from '../lang.js';
import { logEvent } from '../audit.js';
import { waitingOn, recordAnswer, FOLLOW_UP_MINUTES } from '../answers.js';

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
 *          userName?: string, telegramUserId?: number|null, correlationId?: string,
 *          waId?: string, language?: 'en'|'ar'|null}} ctx
 *   `waId` is a WhatsApp sender's number (E.164 digits, no +); `language` is
 *   one the transport already knows, used when none is stored.
 * @param {{awaitSave?: boolean}} [opts]
 *   awaitSave  false hands the result back as soon as the reply is decided,
 *              with the session write still going: `saved` resolves when it
 *              has landed. The transports send first and wait for `saved`
 *              before they mark the message done, so a slow write delays the
 *              bookkeeping, not the customer. Everything else - the website,
 *              scripts, tests - keeps the old contract by default.
 * @returns {Promise<{handled: boolean, messages: Array, state: string, language: 'en'|'ar'|null,
 *                    saved: Promise<void>}>}
 */
export async function runFlow(input, ctx, { awaitSave = true } = {}) {
  // Migration 008 not applied: the flow has nowhere to keep its state, so it
  // stands aside completely and the previous engine answers. Returning
  // handled:false rather than an error is what keeps the bot alive through a
  // deploy that beat its migration.
  if (!(await flowReady())) {
    return { handled: false, messages: [], state: S.MAIN_MENU, degraded: true, saved: Promise.resolve() };
  }

  // The session and the client's language are read side by side: one wait on
  // every message, not two.
  const [{ session, error }, stored] = await Promise.all([loadSession(ctx), turnLanguage(ctx)]);
  const language = stored ?? normaliseLanguage(ctx.language);

  // Everything said this turn is said in that language, and worded for that
  // channel - including what the handlers say from deep inside.
  const result = await withTurn({ lang: language, channel: ctx.channel }, () => turn(session, error, input, ctx, language));
  const saved = result.saved ?? Promise.resolve();
  // Whatever the caller does next, the function does not return before the
  // write has landed (lib/background.js): a write left running when the
  // response goes out may never happen at all on a serverless platform.
  defer(saved);
  if (awaitSave) await saved;
  return { ...result, saved };
}

/** The client's stored choice. The website widget is never asked, so has none. */
async function turnLanguage(ctx) {
  if (!CHOOSING_CHANNELS.has(ctx.channel)) return null;
  return storedLanguage(ctx).catch(() => null);
}

async function turn(session, error, input, ctx, language) {
  // A session we could not read is not an empty session. Saying so beats
  // silently restarting a booking the client has spent five minutes on.
  if (error) {
    return {
      handled: true,
      state: session.current_state,
      messages: [say(M.recoverableError(ctx.correlationId), kb.errorRecovery())],
      language,
    };
  }

  // The client row may have appeared since the session was created.
  if (ctx.clientId && session.client_id !== ctx.clientId) session.client_id = ctx.clientId;

  const result = await dispatch(session, input, ctx);

  // A language chosen this turn, or read from what the client wrote, is the
  // language of the rest of it - the assistant's answer included.
  const spoken = result.language ?? language;

  if (!result.handled) {
    // Nothing to say - the assistant answers. But a language just learned from
    // the message, and the language question it closed, are still worth
    // writing down.
    const saved = Object.keys(result.patch ?? {}).length ? startSessionWrite(session, result.patch) : undefined;
    return { handled: false, messages: [], state: result.patch?.current_state ?? session.current_state, language: spoken, saved };
  }

  // A turn that said nothing and changed nothing - one file of several, read
  // in parallel with its siblings - writes nothing back. Saving would put a
  // copy of the session loaded moments ago over whatever the file that speaks
  // has written since.
  if (!(result.messages ?? []).length && !Object.keys(result.patch ?? {}).length) {
    return {
      handled: true, messages: [], state: session.current_state, offered: session.context?.offered ?? [], language: spoken,
    };
  }

  // Remember which buttons were offered.
  //
  // Two things need this. The website widget has no inline keyboards, so a
  // client there answers "2" and it has to mean the second button. And a
  // Telegram client whose keyboard has scrolled away types the number too.
  // Recorded from what was actually sent, so it cannot drift from the buttons.
  //
  // A turn that said nothing - one file of several, whose reply another file
  // gives - leaves the last offer standing rather than forgetting it.
  const offered = (result.messages ?? []).length
    ? (result.messages ?? [])
        .flatMap((m) => (m.inline ?? []).flat())
        .map((b) => ({ label: b.text, data: b.callback_data }))
    : (session.context?.offered ?? []);

  const patch = { ...(result.patch ?? {}) };
  patch.context = { ...(patch.context ?? session.context ?? {}), offered };

  // Started, not waited for: the reply is decided, and the caller chooses
  // whether to send it before the write lands (see runFlow).
  const next = sessionAfter(session, patch);
  const saved = startSessionWrite(session, patch);
  logEvent('flow_transition', {
    chat_id: String(ctx.chatId),
    from: session.current_state,
    to: next.current_state,
    kind: input.kind,
    correlation_id: ctx.correlationId,
  });

  return { handled: true, messages: result.messages ?? [], state: next.current_state, offered, language: spoken, saved };
}

// ---------------------------------------------------------------------------

async function dispatch(session, input, ctx) {
  // 0. Which language. Ahead of everything, because it decides how everything
  //    else is said - and because "عربي" typed mid-booking is a choice, not a
  //    client's name.
  const language = await languageStep(session, input, ctx);
  if (language) return language;

  return dispatchInput(session, input, ctx);
}

async function dispatchInput(session, input, ctx) {
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

  // 3. A shared phone number - Telegram sends it as its own kind of message.
  //    While a booking is being filled in it is the booking's number: the
  //    answer to step 1 when that is what was asked, and otherwise kept with
  //    the question that was open asked again. Anywhere else it is the number
  //    for a ticket.
  if (input.kind === 'contact') {
    const phone = String(input.phone ?? '').trim();
    const state = session.current_state;
    if (state === S.BOOK_CLIENT_PHONE || state === S.BOOK_EDIT_CLIENT_PHONE) {
      return {
        handled: true,
        ...(await booking.handlePhone(session, phone, ctx, { shared: true, editing: state === S.BOOK_EDIT_CLIENT_PHONE })),
      };
    }
    if (session.active_flow === FLOWS.BOOKING && session.active_booking_ref) {
      return { handled: true, ...(await booking.handlePhone(session, phone, ctx, { shared: true, aside: true })) };
    }
    // A shared number is a number, not a problem description. Treating it as
    // both raised tickets that told the desk a phone number and nothing else.
    return { handled: true, ...(await contact.handleSharedPhone(session, phone, ctx)) };
  }

  // 4. What was written on a file, ahead of the file itself.
  //
  // The transport reads the caption the moment a file is recorded, before the
  // slow part - so that when several files arrive together, whichever of them
  // speaks finds the details already on the request.
  if (input.kind === 'caption') {
    let target = ACCEPTS_DOCUMENTS.has(session.current_state) && session.active_booking_ref ? session : null;
    if (!target) {
      const { draft } = await findDraft(ctx.chatId);
      if (draft) target = { ...session, active_booking_ref: draft.booking_ref };
    }
    if (!target) return { handled: true, messages: [], patch: {} };

    const absorbed = await booking.absorbCaption(target, input.text, ctx);
    if (absorbed?.ended) return { handled: true, ...absorbed.reply };

    const patch = target === session ? {} : { active_flow: FLOWS.BOOKING, active_booking_ref: target.active_booking_ref };
    // What the caption supplied is remembered on the session, so whichever
    // file of the batch speaks can read it back with the files.
    const saved = absorbed?.saved ?? [];
    if (saved.length) {
      patch.context = {
        ...(target.context ?? {}),
        caption_noted: [...new Set([...(target.context?.caption_noted ?? []), ...saved])],
      };
    }
    return { handled: true, messages: [], patch };
  }

  // 5. A file.
  if (input.kind === 'document') {
    // Which request does it belong to? The one being worked on - or, sent
    // outside the document step, the one this chat has open. Refusing a file
    // sent from the menu was wrong: a client who sends their invoice a day
    // later is sending it for the request they have open, and being told "I
    // did not follow that" while the file sits unattached in storage is how
    // paperwork gets lost.
    let target = ACCEPTS_DOCUMENTS.has(session.current_state) && session.active_booking_ref ? session : null;
    if (!target) {
      const { draft } = await findDraft(ctx.chatId);
      if (draft) target = { ...session, active_booking_ref: draft.booking_ref };
    }

    // No draft - but a request already with the desk, which is where papers
    // sent after submission go: the replacement MRN Operations asked for, a
    // paper that arrived late. The transport has filed it; the client hears
    // that it is filed, not "I did not follow that".
    if (!target) {
      if (input.speak === false) return { handled: true, messages: [], patch: {} };
      // Sent because the desk asked for it: recorded as the answer, and the
      // request goes back to the desk. The file that speaks answers for its batch.
      const answered = await answerDesk(session, input, ctx);
      if (answered) return answered;
      const arrived = { ingested: input.document, batch: input.batch ?? [] };
      const submitted = await openBookingFor(ctx.chatId);
      // A request still with the desk: the paper is filed on it, and said so.
      if (submitted && submitted.status !== 'confirmed') {
        return { handled: true, ...(await booking.papersForSubmitted(submitted, arrived)) };
      }
      // Nothing open - or only a booking already confirmed, which this paper
      // may or may not be for. Kept, said so, and the next step offered;
      // never filed against a booking the client was not thinking about.
      return { handled: true, ...booking.papersWithNoRequest(arrived, submitted ?? null) };
    }

    // Nothing to write when the session already points at this request.
    const claim = target === session
      ? {}
      : { active_flow: FLOWS.BOOKING, active_booking_ref: target.active_booking_ref };

    // Details written on the file are read first, by every one of a batch -
    // the caption travels with one file, and the one that speaks may not be it.
    let noted = [...(target.context?.caption_noted ?? [])];
    if (input.caption) {
      const absorbed = await booking.absorbCaption(target, input.caption, ctx);
      if (absorbed?.ended) return { handled: true, ...absorbed.reply };
      noted = [...new Set([...noted, ...(absorbed?.saved ?? [])])];
    }

    // Several files sent together: only the last to finish being read
    // answers, for all of them. The others have done their part.
    if (input.speak === false) return { handled: true, messages: [], patch: claim };

    const handled = await booking.handleDocumentArrived(
      target, { ingested: input.document, batch: input.batch ?? [], noted }, ctx,
    );
    // Read back once, with the files; not again with the next one.
    const context = { ...(handled.patch?.context ?? target.context ?? {}) };
    delete context.caption_noted;
    return { handled: true, messages: handled.messages, patch: { ...handled.patch, ...claim, context } };
  }

  // 6. Text. Only an answer when something was asked - by the bot, or by the
  //    desk. The desk's question, when it is the more recent one, comes first:
  //    otherwise the reply to "send us the exporter's address" was read as
  //    whatever the bot last asked, or handed to the assistant as a new chat.
  if (input.kind === 'text') {
    const answered = await answerDesk(session, input, ctx);
    if (answered) return answered;
  }

  // This comes FIRST, before the numbered-button shortcut below: a client being
  // asked for their company name may perfectly well answer "7", and that is a
  // name, not a menu choice.
  if (AWAITING_TEXT.has(session.current_state)) {
    const result = await handleText(session, input.text ?? '', ctx);

    // The handler recognised a question. The assistant answers it and the
    // session is left untouched, so asking something mid-form does not cost
    // the form.
    if (result?.passToAssistant) return { handled: false };

    // Or a request to be somewhere else entirely.
    if (result?.switchTo) {
      if (result.switchTo === 'cancel') return handleCommand(session, '/cancel', ctx);
      const started = await startFlow(session, result.switchTo, ctx);
      if (started) return { handled: true, ...started };
    }

    return { handled: true, ...result };
  }

  // 6b. A number standing in for a button. The website widget has no inline
  // keyboards at all, and this is how a client there answers.
  const picked = pickByNumber(input.text, session.context?.offered);
  if (picked) {
    const handled = await handleCallback(session, parseCallback(picked), ctx);
    return { handled: true, ...handled };
  }

  // 7. Text that starts a flow, from the menu or from anywhere idle.
  const intent = quickIntent(input.text);
  if (intent) {
    const started = await startFlow(session, intent, ctx);
    if (started) return { handled: true, ...started };
  }

  // Nothing to do: the knowledge assistant answers.
  return { handled: false };
}

// ---------------------------------------------------------------------------
// The answer to something the desk asked
// ---------------------------------------------------------------------------

/**
 * Where nothing of the bot's is under way, so an answer leaves the client in
 * ANSWERING_DESK, from which a further message is taken as more of it.
 */
const ANSWER_IDLE = new Set([S.MAIN_MENU, S.BOOK_SUBMITTED, S.TRACK_RESULTS, S.ANSWERING_DESK, S.CHOOSE_LANGUAGE]);

/**
 * A message answering what the desk asked - a booking handed back for
 * something, an MRN application waiting for information - is kept on that
 * request, the request goes back to the desk, and the client hears it was
 * passed on (lib/answers.js). Until this existed the message went to the
 * assistant as a fresh chat and the request went on waiting.
 *
 * When both the bot and the desk have a question open, the later one is the
 * one being answered: a client asked by the desk for a paper while half-way
 * through a new booking answers the desk; one the desk asked yesterday, who
 * has since started tracking a shipment, answers the bot.
 *
 * @returns {Promise<object|null>} the turn's result, or null when this is not an answer
 */
async function answerDesk(session, input, ctx) {
  const isText = input.kind === 'text';
  const text = String((isText ? input.text : input.caption) ?? '').trim();
  const documents = isText ? [] : filesOf(input);
  if (isText ? !mayAnswer(text) : !documents.length) return null;

  // The bot's own open question, and when it was put: the session moves on
  // every turn the bot speaks in.
  const botAsking = isText && (AWAITING_TEXT.has(session.current_state) || Boolean(pickByNumber(text, session.context?.offered)));
  const botAskedSince = (at) => Boolean(session.updated_at && at && new Date(session.updated_at) > new Date(at));

  const who = { chatId: ctx.chatId, clientId: ctx.clientId ?? session.client_id ?? null, text, documents };
  const waiting = (await waitingOn(ctx.chatId).catch(() => [])).filter((w) => !(botAsking && botAskedSince(w.askedAt)));
  if (waiting.length) {
    const answered = await recordAnswer(waiting, { ...who, reopen: true });
    if (answered.length) return acknowledge(session, answered, documents, ctx, { first: true });
  }

  // Moments after an answer, a further message is more of it - "Baltic Trucks
  // UAB", then "Savanoriu 12, Vilnius" - as long as nothing else has happened
  // in between: anything the bot does moves the conversation out of
  // ANSWERING_DESK.
  const last = session.context?.answered;
  const recent = last?.at && Date.now() - new Date(last.at).getTime() < FOLLOW_UP_MINUTES * 60_000;
  if (session.current_state === S.ANSWERING_DESK && last?.refs?.length && recent && !botAsking) {
    const added = await recordAnswer(last.refs, { ...who, reopen: false });
    if (added.length) return acknowledge(session, added, documents, ctx, { first: false });
  }
  return null;
}

/**
 * Could this text be an answer at all? Not a hello, and not a request to be
 * somewhere else ("menu", "track my shipment") - those mean what they always
 * meant. A bare digit can be: "2" is a perfectly good answer to "how many?".
 */
function mayAnswer(text) {
  if (!text || onlyHello({ kind: 'text', text })) return false;
  const intent = quickIntent(text);
  return !intent || /^[0-9٠-٩]$/.test(text.replace(/️|⃣/g, ''));
}

/** The papers of a document turn: the whole batch when several came together. */
function filesOf(input) {
  const arrived = input.batch?.length ? input.batch : [input.document?.document].filter(Boolean);
  return arrived.map((d) => ({ id: d.id ?? null, file_name: d.file_name ?? null, doc_type: d.doc_type ?? null }));
}

/**
 * "Passed on", in the client's language. From an idle conversation the client
 * is left in ANSWERING_DESK, so a second message is more of the answer; from
 * the middle of something of the bot's, its question is put again and nothing
 * moves - the booking they were filling in is where it was.
 */
async function acknowledge(session, answered, documents, ctx, { first }) {
  const known = documents.filter((d) => d.doc_type && d.doc_type !== 'other');
  const named = [...new Set(known.map((d) => d.doc_type))];
  const labelsAr = [...named.map((t) => DOC_LABELS[t]?.[0] ?? t), ...documents.filter((d) => !known.includes(d)).map((d) => d.file_name ?? DOC_LABELS.other[0])];
  const labelsEn = [...named.map((t) => DOC_LABELS[t]?.[1] ?? t), ...documents.filter((d) => !known.includes(d)).map((d) => d.file_name ?? DOC_LABELS.other[1])];
  const words = first ? M.answerPassedOn(answered, labelsAr, labelsEn) : M.answerAdded(answered);

  if (ANSWER_IDLE.has(session.current_state)) {
    return {
      handled: true,
      ...reply(say(words, kb.homeOnly()), {
        active_flow: null,
        current_state: S.ANSWERING_DESK,
        context: { answered: { refs: answered.map(({ kind, ref }) => ({ kind, ref })), at: new Date().toISOString() } },
      }),
    };
  }
  const again = await repeatQuestion(session, ctx);
  return { handled: true, messages: [say(words), ...again.messages], patch: again.patch ?? {} };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function handleCommand(session, command, ctx) {
  switch (command) {
    // No separate reset write first: the patch below is that reset, and the
    // turn writes it once. A second write in front of the reply was a second
    // chance for a slow database to hold the menu back.
    case '/start':
    case '/menu':
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

    // Reached only where a language cannot be chosen - the website, or a
    // database without the column. The open question again, rather than
    // "/language" being taken as its answer.
    case '/language':
      return repeatQuestion(session, ctx);

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
      // The patch is the reset; see /menu above.
      case 'home':
        return reply(say(M.menu(), kb.mainMenu()), {
          active_flow: null, current_state: S.MAIN_MENU, active_booking_ref: null, context: {},
        });
      case 'book':
        return booking.startBooking(session, ctx);
      case 'track':
        return tracking.askIdentifier(session);
      case 'contact':
        return contact.talkToAgent(session, ctx);
      case 'retry':
        return reply(say(M.menu(), kb.mainMenu()), { current_state: S.MAIN_MENU, active_flow: null });
      default:
        return reply(say(M.notUnderstood(), kb.mainMenu()));
    }
  }

  if (ns === 'bk') return bookingCallback(session, action, arg, ctx);
  if (ns === 'tr') return trackingCallback(session, action, arg, ctx);
  if (ns === 'ct') return contactCallback(session, action, arg, ctx);

  // A language button, reached only where a language cannot be chosen (the
  // website, or a database without the column): the menu, as it is.
  if (ns === 'lang') {
    return reply(say(M.menu(), kb.mainMenu()), { active_flow: null, current_state: S.MAIN_MENU });
  }

  return reply(say(M.notUnderstood(), kb.mainMenu()));
}

async function bookingCallback(session, action, arg, ctx) {
  // Every branch below needs a live draft. A button pressed on a card from
  // yesterday, whose request has since been submitted or cancelled, must not
  // silently start editing something else.
  const needsDraft = ['mrn', 'confirm', 'edit', 'docs', 'doctype', 'cancel', 'draft', 'phone'].includes(action);
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

    // "Add to that booking", for papers sent with nothing open.
    case 'fileto':
      return booking.fileToBooking(session, arg, ctx);

    case 'confirm':
      return booking.handleConfirm(session, ctx);

    case 'edit':
      if (!arg) return booking.editMenu(session);
      return booking.handleEditChoice(session, arg, ctx);

    case 'cancel':
      if (arg === 'ask') return booking.askCancel(session, ctx);
      return booking.handleCancelDecision(session, arg, ctx);

    // WhatsApp's answer to the phone question: the number being written from,
    // or "another" - which is simply typed next. Only while the number is what
    // is being asked; from an older message, the open question is asked again.
    case 'phone': {
      const state = session.current_state;
      if (state !== S.BOOK_CLIENT_PHONE && state !== S.BOOK_EDIT_CLIENT_PHONE) return repeatQuestion(session, ctx);
      const own = booking.whatsappNumber(ctx);
      if (arg === 'use' && own) {
        // As good as a shared contact: WhatsApp vouches for the sender's number.
        return booking.handlePhone(session, own, ctx, { shared: true, editing: state === S.BOOK_EDIT_CLIENT_PHONE });
      }
      return reply(say(M.phoneTypeIt(), kb.homeOnly()));
    }

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
    case 'ops': return contact.talkToAgent(session, ctx);
    case 'urgent': return contact.handleUrgency(session, arg, ctx);
    default: return reply(say(M.notUnderstood(), kb.mainMenu()));
  }
}

// ---------------------------------------------------------------------------
// Text, when something was asked
// ---------------------------------------------------------------------------

async function handleText(session, text, ctx) {
  switch (session.current_state) {
    case S.BOOK_CLIENT_NAME: return booking.handleBasicField(session, 'customer_name', text, ctx);
    case S.BOOK_CLIENT_PHONE: return booking.handlePhone(session, text, ctx);
    case S.BOOK_VIN: return booking.handleVin(session, text, ctx);
    case S.BOOK_MAKE: return booking.handleBasicField(session, 'make', text, ctx);
    case S.BOOK_POL: return booking.handleBasicField(session, 'origin_port', text, ctx);
    case S.BOOK_DESTINATION: return booking.handleDestination(session, text, ctx);
    case S.BOOK_MRN_SUPPORTING_INFO: return booking.handleMrnSupportingInfo(session, text, ctx);

    case S.BOOK_EDIT_VIN: return booking.handleVin(session, text, ctx, { editing: true });
    case S.BOOK_EDIT_MAKE: return booking.handleBasicField(session, 'make', text, ctx, { editing: true });
    case S.BOOK_EDIT_CLIENT_NAME: return booking.handleBasicField(session, 'customer_name', text, ctx, { editing: true });
    case S.BOOK_EDIT_CLIENT_PHONE: return booking.handlePhone(session, text, ctx, { editing: true });
    case S.BOOK_EDIT_POL: return booking.handleEditPol(session, text, ctx);
    case S.BOOK_EDIT_DESTINATION: return booking.handleDestination(session, text, ctx, { editing: true });

    case S.TRACK_IDENTIFIER: return tracking.handleIdentifier(session, text, ctx);

    case S.CONTACT_BOOKING_IDENTIFIER: return contact.handleBookingIdentifier(session, text, ctx);
    case S.CONTACT_TRACKING_IDENTIFIER: return contact.handleTrackingIdentifier(session, text, ctx);
    case S.CONTACT_DOCUMENT_REQUEST: return contact.handleDocumentRequest(session, text, ctx);
    case S.CONTACT_URGENCY: return contact.handleUrgencyText(session, text, ctx);
    case S.CONTACT_TICKET_DETAILS: return contact.handleTicketDetails(session, text, ctx);

    default:
      return reply(say(M.notUnderstood(), kb.mainMenu()), { current_state: S.MAIN_MENU, active_flow: null });
  }
}

async function startFlow(session, intent, ctx) {
  if (intent === 'book') return booking.startBooking(session, ctx);
  if (intent === 'track') return tracking.askIdentifier(session);
  if (intent === 'contact') return contact.talkToAgent(session, ctx);
  if (intent === 'menu') {
    return reply(say(M.welcome(ctx.userName), kb.mainMenu()), {
      active_flow: null, current_state: S.MAIN_MENU, active_booking_ref: null, context: {},
    });
  }
  return null;
}

/**
 * The question that is open, asked again in the turn's language - after the
 * client switched language, or tapped a button that belongs to another step.
 * Nothing moves: whatever they send next is the answer to it.
 */
async function repeatQuestion(session, ctx) {
  const state = session.current_state;
  let again = null;
  if (state === S.TRACK_IDENTIFIER) again = tracking.askIdentifier(session);
  else if (state.startsWith('CONTACT_')) again = await contact.repeatQuestion(session, ctx);
  else if (state.startsWith('BOOK_')) again = await booking.repeatQuestion(session, ctx);
  if (again) return again;

  // Nothing is being asked - or the request behind the step has gone, and the
  // menu is the honest place to be.
  return reply(
    say(M.menu(), kb.mainMenu()),
    state === S.MAIN_MENU ? {} : { active_flow: null, current_state: S.MAIN_MENU },
  );
}

// ---------------------------------------------------------------------------
// Language
//
// One language per conversation, chosen once (docs/WHATSAPP-AND-DESK.md §2.1).
// Asked only of a client who never chose, and only when nothing is under way;
// a client half-way through a booking keeps both languages until their next
// menu rather than being stopped mid-question. Never asked at all when the
// choice could not be kept (languageSupported() false: the migration is not
// applied) - it would be asked again on every message.
// ---------------------------------------------------------------------------

/** Where a client chooses a language. The website widget never asks. */
const CHOOSING_CHANNELS = new Set(['telegram', 'whatsapp']);

/** Where nothing is under way, so the question interrupts nothing. */
const IDLE = new Set([S.MAIN_MENU, S.BOOK_SUBMITTED, S.TRACK_RESULTS]);

/** "Which language?", typed rather than tapped. */
const LANGUAGE_REQUEST = /^\/?(?:language|languages|lang|اللغة|اللغه|لغة|لغه)$/i;

/** Commands whose whole answer is the welcome - which, on first contact, the question is. */
const WELCOME_COMMANDS = new Set(['/start', '/menu', '/help']);

/**
 * The words a hello is made of. A message of these and nothing else - "hi
 * there", "السلام عليكم ورحمة الله وبركاته" - says hello; "hi, I want to book"
 * says more, and is acted on.
 */
const HELLO_WORD = /^(?:hi+|hello|helo|hey|hiya|there|all|team|everyone|good|morning|afternoon|evening|salam|salaam|as+alam|as+alamu|alaikum|alaykum|aleikum|ahlan|ahlen|marhaba|start|menu|mky|السلام|سلام|عليكم|ورحمة|الله|وبركاته|اهلا|أهلا|اهلاً|أهلاً|مرحبا|مرحباً|هاي|هالو|هلا|صباح|مساء|الخير|النور|ازيك|إزيك|ازيكم|إزيكم|يا)$/i;

/** The quiet parts of a batch of files: a caption read ahead, a file whose sibling speaks. */
const silent = (input) => input.kind === 'caption' || (input.kind === 'document' && input.speak === false);

/** Something written - words, digits, a hello - rather than a tap or a file. */
const written = (input) => input.kind === 'text' || (input.kind === 'command' && WELCOME_COMMANDS.has(input.command));

/**
 * @returns {Promise<object|null>} the turn's result when the message was about
 *   language, or when its language was learned and it was dealt with; null to
 *   carry on as usual
 */
async function languageStep(session, input, ctx) {
  if (!CHOOSING_CHANNELS.has(ctx.channel) || !languageSupported() || silent(input)) return null;

  // Chosen in so many words, from anywhere: a button (the current question's
  // or an old one's), "/language", "english", "عربي".
  const chosen = explicitChoice(input);
  if (chosen === 'ask') return askLanguage(session, ctx, { first: false });
  if (chosen) return chooseLanguage(session, chosen, ctx);

  if (session.current_state === S.CHOOSE_LANGUAGE) return answerLanguageQuestion(session, input, ctx);
  if (await mayAsk(session, ctx)) return firstWord(session, input, ctx);
  return null;
}

/**
 * A choice made in so many words: a language button, "/language ar", or the
 * name of a language on its own. 'ask' is a request to be asked.
 */
function explicitChoice(input) {
  if (input.kind === 'callback') {
    if (input.callback?.ns !== 'lang') return null;
    return normaliseLanguage(input.callback.action) ?? 'ask';
  }
  if (input.kind !== 'text' && input.kind !== 'command') return null;

  // "/language@MkyBot ar" from a Telegram group is "/language ar".
  const text = String(input.text ?? '').trim().replace(/^(\/\w+)@\w+/, '$1');
  const [head = '', ...rest] = text.split(/\s+/);
  if (LANGUAGE_REQUEST.test(head)) {
    // Only the word alone, or with a language after it: "Language is not a
    // problem for us" is a sentence, not a request.
    if (!rest.length) return 'ask';
    const named = languageFromChoice(rest.join(' '));
    if (named) return named;
  }
  if (input.kind === 'command' && input.command === '/language') return languageFromChoice(text) ?? 'ask';
  return languageFromChoice(text);
}

/**
 * What the client's own words say about their language: Arabic script is
 * Arabic, Latin is English. A slash command says nothing - "/start" is English
 * whoever types it - and neither does a tap, or a file without a caption.
 */
function languageSignal(input) {
  const text = input.kind === 'document' ? input.caption
    : input.kind === 'text' || input.kind === 'command' ? input.text
    : null;
  const s = String(text ?? '').trim();
  if (!s || s.startsWith('/')) return null;
  const script = detectLanguage(s);
  // Franco-Arabic - "3ayez a7gez" - is Latin letters and Arabic words; the
  // assistant already answers it in Arabic, and so does the choice.
  if (script === 'en' && looksFrancoArabic(s)) return 'ar';
  // A chassis number is Latin, but often without two letters side by side -
  // W1T96340310484233 - which the script test looks for.
  return script ?? (findVin(s) ? 'en' : null);
}

/**
 * May this client be asked now? Never chosen, nothing under way, and MKY has
 * not turned the question off (bot_settings.ask_language_first).
 */
async function mayAsk(session, ctx) {
  if (currentLanguage() || !IDLE.has(session.current_state)) return false;
  if ((await setting('ask_language_first')) === false) return false;
  // A draft is a booking under way even from the menu. A lookup that failed
  // is not evidence of no draft, so it does not ask either.
  const { draft, error } = await findDraft(ctx.chatId);
  return !draft && !error;
}

/**
 * The question. On first contact it is the welcome, and the conversation waits
 * on it. Asked for ("/language") from anywhere else, it is just the question:
 * the booking stays exactly where it is, because its buttons answer from any
 * state.
 */
function askLanguage(session, ctx, { first = true, again = false, asked = 1 } = {}) {
  const text = again ? M.chooseLanguageAgain() : M.chooseLanguage(ctx.userName ?? null, { first });
  const message = say(text, kb.languageChoice());
  if (!first && !again) return { handled: true, messages: [message], patch: {} };
  return {
    handled: true,
    messages: [message],
    patch: {
      active_flow: null,
      current_state: S.CHOOSE_LANGUAGE,
      active_booking_ref: null,
      context: { language_asked: asked },
    },
  };
}

/**
 * The choice, kept on the client and the session.
 *
 * The language also goes on the session patch, always: the session row is
 * written back whole at the end of the turn from the copy read at its start,
 * and without it there that write would put the old language back - or, for a
 * first message with no row yet, be the only place it is kept at all.
 */
async function remember(session, lang, ctx) {
  await Promise.all([
    rememberLanguage(
      { channel: ctx.channel, chatId: ctx.chatId, clientId: ctx.clientId ?? session.client_id ?? null },
      lang,
    ).catch((err) => console.error('language not saved:', err?.message)),
    // A booking being filled in is in this language from now on, too.
    setDraftLanguage(ctx.chatId, lang).catch(() => null),
  ]);
  logEvent('language_chosen', { chat_id: String(ctx.chatId), channel: ctx.channel, language: lang });
}

/** A language chosen: answered in it at once, from wherever the client was. */
async function chooseLanguage(session, lang, ctx) {
  await remember(session, lang, ctx);

  return withLanguage(lang, async () => {
    // The answer to the first question: the welcome, now in one language.
    if (session.current_state === S.CHOOSE_LANGUAGE) {
      return {
        handled: true,
        language: lang,
        messages: [say(M.welcome(ctx.userName), kb.mainMenu())],
        patch: { active_flow: null, current_state: S.MAIN_MENU, active_booking_ref: null, context: {}, language: lang },
      };
    }

    // A switch, mid-whatever: said, and the open question asked again in the
    // new language - in one message, not two.
    const again = await repeatQuestion(session, ctx);
    const [first, ...rest] = again.messages;
    const messages = first
      ? [{ ...first, text: `${M.languageSet()}\n\n${first.text}` }, ...rest]
      : [say(M.languageSet())];
    return { handled: true, language: lang, messages, patch: { ...again.patch, language: lang } };
  });
}

/**
 * Whatever the client sent while the language question was open.
 *
 * Never a dead end: a typed "2" is the second button, words are read for their
 * script and then dealt with, and a file or a tap is dealt with in both
 * languages. Only a message with nothing to go on - digits, an emoji - is asked
 * about again, once; after that it is English, and on we go.
 */
async function answerLanguageQuestion(session, input, ctx) {
  // As far as anything they sent is concerned, the client is at the menu.
  const menu = { ...session, active_flow: null, current_state: S.MAIN_MENU, context: {} };
  const atMenu = { active_flow: null, current_state: S.MAIN_MENU, context: {} };

  // Chosen meanwhile - on the other channel, say.
  if (currentLanguage()) return fromMenu(menu, input, ctx);

  if (input.kind === 'text') {
    const picked = pickByNumber(input.text, session.context?.offered);
    const lang = picked ? normaliseLanguage(parseCallback(picked).action) : null;
    if (lang) return chooseLanguage(session, lang, ctx);
  }

  const signal = languageSignal(input);
  if (signal) return adopt(menu, signal, input, ctx, atMenu);

  if (!written(input)) return fromMenu(menu, input, ctx);

  const asked = Number(session.context?.language_asked) || 1;
  if (asked < 2) return askLanguage(session, ctx, { again: true, asked: asked + 1 });
  return adopt(menu, 'en', input, ctx, atMenu);
}

/**
 * The first message from a client who never chose, with nothing under way.
 *
 * A hello - /start, "hi", "السلام عليكم" - is answered with the question, which
 * is the welcome. A message with something in it is acted on, in the language
 * it was written in: a chassis number, "I want to book", a question. Answering
 * those with a question of our own would drop what they asked.
 */
async function firstWord(session, input, ctx) {
  if (onlyHello(input)) return askLanguage(session, ctx, { first: true });

  const signal = languageSignal(input);
  if (signal) return adopt(session, signal, input, ctx);

  // A digit that picks a button the client can see is a choice, not a hello.
  if (input.kind === 'text' && pickByNumber(input.text, session.context?.offered)) return null;
  // Digits or an emoji with nothing on screen to pick: nothing to go on.
  if (written(input)) return askLanguage(session, ctx, { first: true });
  // A file or a tap: dealt with as it always was, in both languages.
  return null;
}

function onlyHello(input) {
  if (input.kind === 'command') return WELCOME_COMMANDS.has(input.command);
  if (input.kind !== 'text') return false;
  // Letters only: "hello!! 👋" is "hello".
  const words = String(input.text ?? '').replace(/[^\p{L}\p{M}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 6 && words.every((w) => HELLO_WORD.test(w));
}

/**
 * The language read from what the client wrote, kept - and their message then
 * dealt with in it, in this same turn, so nothing they sent is lost to the
 * question.
 */
async function adopt(session, lang, input, ctx, base = {}) {
  await remember(session, lang, ctx);
  return withLanguage(lang, async () => {
    const result = await dispatchInput(session, input, ctx);
    return { ...result, language: lang, patch: { ...base, ...(result.patch ?? {}), language: lang } };
  });
}

/** Dealt with as though sent from the menu, in the turn's language; the question stays open for later. */
async function fromMenu(menu, input, ctx) {
  const result = await dispatchInput(menu, input, ctx);
  return { ...result, patch: { active_flow: null, current_state: S.MAIN_MENU, context: {}, ...(result.patch ?? {}) } };
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
  if (/contact our team|talk to an agent|تواصل مع فريقنا|كلّم موظف|كلم موظف/i.test(s)) return 'contact';

  if (/^(book|new booking|i want to book|make a booking)\b/i.test(s)) return 'book';
  if (/^(track|tracking|where is my)\b/i.test(s)) return 'track';
  if (/^(help me|support|talk to (a )?(human|person|someone|agent))\b/i.test(s)) return 'contact';
  if (/عايز أحجز|عاوز احجز|عايز احجز|أحجز شحنة/i.test(s)) return 'book';
  if (/الشحنة فين|شحنتي فين|عايز أتتبع/i.test(s)) return 'track';
  if (/عايز أكلم|عايز اكلم|خدمة العملاء|موظف/i.test(s)) return 'contact';

  return null;
}
