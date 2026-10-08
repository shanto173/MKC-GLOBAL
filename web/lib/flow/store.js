/**
 * Where a conversation is, kept in Postgres.
 *
 * This is the answer to "the conversation must survive a restart, a redeploy, a
 * webhook retry and a worker failure". Nothing about where we are lives in a
 * module variable: two serverless invocations a second apart are different
 * processes, and the second one reads the first one's state out of this table.
 *
 * `context` is FLOW bookkeeping only - a retry count, which prompt was last
 * sent, the message id of the card whose buttons are live. Business data goes
 * in bookings / booking_documents / mrn_requests, never here, because a jsonb
 * blob is not a record anybody can query, audit or correct.
 */

import { db, retryOnTimeout } from './../supabase.js';
import { S, isState } from './states.js';
import { languageColumnsExist } from './language.js';
import { normaliseLanguage } from '../lang.js';

export const sessionKey = (channel, chatId) => `${channel}:${chatId}`;

/**
 * Session writes still on their way to the database, by session id.
 *
 * The transports send a turn's reply without waiting for its session write
 * (lib/flow/machine.js): a write that hung for 17 seconds in the live test
 * held the reply for all of them. That is only safe if nothing in this process
 * reads the session before the write lands, and if two writes to one session
 * land in the order they were made. So each write waits for the one before it,
 * and a read waits for whatever is still being written. Across processes the
 * transports' claims do the same job: a message is not marked done until its
 * write has landed, and the next message from that chat waits for it.
 */
const writing = new Map();

/**
 * Resolves once every write already started for this session has finished,
 * whether it worked or not.
 */
export function sessionSettled(channel, chatId) {
  return writing.get(sessionKey(channel, chatId)) ?? Promise.resolve();
}

/**
 * The Telegram chat id, for a Telegram chat only. Reading the digits out of
 * any chat id turned WhatsApp's "wa:201001234567" into a Telegram id: to
 * anything reading this column, a WhatsApp conversation looked like a Telegram
 * chat with a number it never had.
 */
const telegramChatId = (channel, chatId) => (channel === 'telegram' ? numeric(chatId) : null);

/** Fresh session for a chat we have not seen, or whose state we cannot trust. */
function blank(ctx) {
  return {
    id: sessionKey(ctx.channel, ctx.chatId),
    channel: ctx.channel,
    chat_id: String(ctx.chatId),
    telegram_chat_id: telegramChatId(ctx.channel, ctx.chatId),
    client_id: ctx.clientId ?? null,
    active_flow: null,
    current_state: S.MAIN_MENU,
    active_booking_ref: null,
    context: {},
  };
}

export async function loadSession(ctx) {
  // The previous turn's write may still be in flight; reading past it would
  // answer this message from the state before the last one.
  await sessionSettled(ctx.channel, ctx.chatId);
  const { data, error } = await db()
    .from('conversation_sessions')
    .select('*')
    .eq('id', sessionKey(ctx.channel, ctx.chatId))
    .maybeSingle();

  if (error) {
    // A read failure must not silently restart the client's booking. It is
    // reported so the caller can apologise and ask them to try again, rather
    // than dropping them into MAIN_MENU with their draft apparently gone.
    console.error('session read failed:', error.message);
    return { session: blank(ctx), error: error.message };
  }

  if (!data) return { session: blank(ctx), error: null };

  // A state written by an older deployment, or hand-edited, is not one this
  // code can act on. Falling back to the menu is recoverable; dispatching on an
  // unknown string is a message the client never gets an answer to.
  if (!isState(data.current_state)) {
    console.error(`unknown session state "${data.current_state}", resetting to menu`);
    return { session: { ...data, current_state: S.MAIN_MENU, active_flow: null }, error: null };
  }

  return { session: data, error: null };
}

/**
 * Writes the session back.
 *
 * `state_entered_at` only moves when the state actually changes, so "how long
 * has this client been staring at the document step" is answerable.
 *
 * `language` is written only once the column is known to exist: an upsert
 * naming a column the database does not have fails whole, and would lose the
 * turn's state along with the language (see ./language.js).
 *
 * The upsert writes the whole row, so it lands the same however often it
 * lands, and it is tried once more if the first attempt runs out of time.
 */
export async function saveSession(session, patch = {}) {
  const next = sessionAfter(session, patch);
  await startSessionWrite(session, patch);
  return next;
}

/** The session as it will be once a patch is applied - what saveSession returns. */
export function sessionAfter(session, patch = {}) {
  return { ...session, ...patch };
}

/**
 * Starts the write and returns the promise of it, without the caller having
 * to wait. The promise never rejects: a failed write is logged, as it always
 * was, and the conversation carries on.
 */
export function startSessionWrite(session, patch = {}) {
  const next = sessionAfter(session, patch);
  const id = next.id;
  const before = writing.get(id) ?? Promise.resolve();
  const done = before.then(() => writeSession(session, patch)).catch((err) => {
    console.error('session write failed:', err?.message ?? err);
  });
  writing.set(id, done);
  done.then(() => { if (writing.get(id) === done) writing.delete(id); });
  return done;
}

async function writeSession(session, patch) {
  const next = sessionAfter(session, patch);
  const changedState = patch.current_state && patch.current_state !== session.current_state;
  const language = normaliseLanguage(next.language);

  const row = {
    id: next.id,
    channel: next.channel,
    chat_id: String(next.chat_id),
    telegram_chat_id: next.channel === 'telegram' ? (next.telegram_chat_id ?? null) : null,
    client_id: next.client_id ?? null,
    active_flow: next.active_flow ?? null,
    current_state: next.current_state ?? S.MAIN_MENU,
    active_booking_ref: next.active_booking_ref ?? null,
    context: next.context ?? {},
    updated_at: new Date().toISOString(),
    ...(changedState ? { state_entered_at: new Date().toISOString() } : {}),
    ...(language && languageColumnsExist() ? { language } : {}),
  };

  const { error } = await retryOnTimeout(
    () => db().from('conversation_sessions').upsert(row, { onConflict: 'id' }),
    'conversation_sessions upsert',
  );
  if (error) console.error('session write failed:', error.message);
}

/** Back to the menu, forgetting the flow but never the booking behind it. */
export async function resetSession(session) {
  return saveSession(session, {
    active_flow: null,
    current_state: S.MAIN_MENU,
    active_booking_ref: null,
    context: {},
  });
}

export async function clearSession(channel, chatId) {
  // A write still landing after the delete would bring the session back.
  await sessionSettled(channel, chatId);
  await db().from('conversation_sessions').delete().eq('id', sessionKey(channel, chatId));
}

function numeric(value) {
  const n = Number(String(value ?? '').replace(/[^0-9-]/g, ''));
  return Number.isSafeInteger(n) ? n : null;
}
