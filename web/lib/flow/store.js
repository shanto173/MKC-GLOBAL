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

import { db } from './../supabase.js';
import { S, isState } from './states.js';

export const sessionKey = (channel, chatId) => `${channel}:${chatId}`;

/** Fresh session for a chat we have not seen, or whose state we cannot trust. */
function blank(ctx) {
  return {
    id: sessionKey(ctx.channel, ctx.chatId),
    channel: ctx.channel,
    chat_id: String(ctx.chatId),
    telegram_chat_id: numeric(ctx.chatId),
    client_id: ctx.clientId ?? null,
    active_flow: null,
    current_state: S.MAIN_MENU,
    active_booking_ref: null,
    context: {},
  };
}

export async function loadSession(ctx) {
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
 */
export async function saveSession(session, patch = {}) {
  const next = { ...session, ...patch };
  const changedState = patch.current_state && patch.current_state !== session.current_state;

  const row = {
    id: next.id,
    channel: next.channel,
    chat_id: String(next.chat_id),
    telegram_chat_id: next.telegram_chat_id ?? null,
    client_id: next.client_id ?? null,
    active_flow: next.active_flow ?? null,
    current_state: next.current_state ?? S.MAIN_MENU,
    active_booking_ref: next.active_booking_ref ?? null,
    context: next.context ?? {},
    updated_at: new Date().toISOString(),
    ...(changedState ? { state_entered_at: new Date().toISOString() } : {}),
  };

  const { error } = await db().from('conversation_sessions').upsert(row, { onConflict: 'id' });
  if (error) console.error('session write failed:', error.message);
  return next;
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
  await db().from('conversation_sessions').delete().eq('id', sessionKey(channel, chatId));
}

function numeric(value) {
  const n = Number(String(value ?? '').replace(/[^0-9-]/g, ''));
  return Number.isSafeInteger(n) ? n : null;
}
