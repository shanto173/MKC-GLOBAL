/**
 * The conversation as the customer saw it: every message in and out, on every
 * channel, in chat_messages.
 *
 * The desk shows a customer's chat from this table - what they wrote, what the
 * bot said, what a person sent and whether it arrived. That makes it a record,
 * not a dependency: a reply is never held up by it and never lost because of
 * it. Every function here is best effort and swallows its own failures.
 *
 * The table arrives with migration 20261007090000. Until it is applied each
 * call is a silent no-op - learned once per process from the first refusal,
 * so an unmigrated deployment does not pay a failing round trip per message.
 */

import { db } from './supabase.js';

/**
 * Is this PostgREST/Postgres error "that table, column or function is not
 * there"? Every new piece of schema is feature-detected through this, so a
 * deploy that lands before its migration degrades to today's behaviour
 * rather than failing.
 *
 *   42P01 / PGRST205  relation (table) missing
 *   42703 / PGRST204  column missing (select / write)
 *   42883 / PGRST202  function missing
 */
export function isSchemaMissing(error) {
  if (!error) return false;
  const code = String(error.code ?? '');
  if (['42P01', '42703', '42883', 'PGRST202', 'PGRST204', 'PGRST205'].includes(code)) return true;
  return /does not exist|could not find the .* (column|table|function)|schema cache/i
    .test(String(error.message ?? ''));
}

// null: not yet known. false: the table is missing, stop trying.
let tablePresent = null;

/** For tests: forget what was learned about the schema. */
export function resetChatlogForTests() {
  tablePresent = null;
}

/** Whether chat_messages has been seen to exist (null until first use). */
export function chatlogAvailable() {
  return tablePresent;
}

const clip = (value, max) => (value == null ? null : String(value).slice(0, max));

async function insert(row) {
  if (tablePresent === false) return { ok: false, skipped: true };
  try {
    const { error } = await db().from('chat_messages').insert(row);
    if (error) {
      if (isSchemaMissing(error)) { tablePresent = false; return { ok: false, skipped: true }; }
      // 23505: the same provider message logged twice - a retried webhook
      // that was claimed again after a failure. The first copy stands.
      if (error.code !== '23505') console.error('chat log write failed:', error.message);
      return { ok: false };
    }
    tablePresent = true;
    return { ok: true };
  } catch (err) {
    console.error('chat log write threw:', err?.message);
    return { ok: false };
  }
}

/**
 * A message from the client.
 *
 * @param {{channel: string, chatId: string|number, clientId?: number|null, kind?: string,
 *          body?: string|null, payload?: object, language?: string|null,
 *          bookingRef?: string|null, providerMessageId?: string|null}} m
 */
export function logInbound(m) {
  return insert({
    channel: m.channel,
    chat_id: String(m.chatId),
    client_id: m.clientId ?? null,
    direction: 'in',
    author: 'client',
    kind: m.kind ?? 'text',
    body: clip(m.body, 8000),
    payload: m.payload ?? {},
    language: m.language ?? null,
    booking_ref: m.bookingRef ?? null,
    provider_message_id: clip(m.providerMessageId, 300),
    status: 'received',
  });
}

/**
 * A message to the client - from the bot, a person at the desk, or the outbox.
 *
 * @param {{channel: string, chatId: string|number, clientId?: number|null,
 *          author?: 'bot'|'staff'|'system', staffName?: string|null, kind?: string,
 *          body?: string|null, payload?: object, language?: string|null,
 *          bookingRef?: string|null, providerMessageId?: string|null,
 *          status?: 'queued'|'sent'|'failed', error?: string|null}} m
 */
export function logOutbound(m) {
  return insert({
    channel: m.channel,
    chat_id: String(m.chatId),
    client_id: m.clientId ?? null,
    direction: 'out',
    author: ['bot', 'staff', 'system'].includes(m.author) ? m.author : 'bot',
    staff_name: m.staffName ?? null,
    kind: m.kind ?? 'text',
    body: clip(m.body, 8000),
    payload: m.payload ?? {},
    language: m.language ?? null,
    booking_ref: m.bookingRef ?? null,
    provider_message_id: clip(m.providerMessageId, 300),
    status: m.status ?? 'sent',
    error: clip(m.error, 500),
  });
}

/**
 * A message that was waiting for the customer to write, now that it has gone.
 *
 * WhatsApp will not carry a new message to somebody who has not written for 24
 * hours, so one a person at the desk sends outside that window is kept - shown
 * in the chat as queued - and sent the moment the customer replies. When it
 * goes, THIS row becomes the sent one. Logging the delivery as a second
 * message would show the colleague's one sentence twice, hours apart, which
 * reads like it was sent twice.
 *
 * `queuedKey` is the desk's own idempotency key for that send, carried in the
 * row's payload. Returns `updated: false` when there is no such row, and the
 * caller logs the delivery as a new message, which is the old behaviour.
 */
export async function deliverQueued({ channel, chatId, queuedKey, providerMessageId = null, status = 'sent', error = null }) {
  if (!queuedKey || tablePresent === false) return { ok: false, updated: false };
  try {
    const { data, error: readErr } = await db().from('chat_messages')
      .select('id')
      .eq('channel', channel).eq('chat_id', String(chatId)).eq('status', 'queued')
      .eq('payload->>queued_key', String(queuedKey))
      .limit(1);
    if (readErr) {
      if (isSchemaMissing(readErr)) tablePresent = false;
      else console.error('queued message read failed:', readErr.message);
      return { ok: false, updated: false };
    }
    const row = data?.[0];
    if (!row) return { ok: true, updated: false };

    const { error: writeErr } = await db().from('chat_messages')
      .update({
        status,
        error: clip(error, 500),
        provider_message_id: clip(providerMessageId, 300),
      })
      .eq('id', row.id);
    if (writeErr) {
      console.error('queued message update failed:', writeErr.message);
      return { ok: false, updated: false };
    }
    return { ok: true, updated: true };
  } catch (err) {
    console.error('queued message update threw:', err?.message);
    return { ok: false, updated: false };
  }
}

/**
 * Adds to the payload of one logged message, found by the provider's id: where
 * a voice note was stored, or why it was not. The row is written in the
 * background, so it is looked for a few times before giving up.
 *
 * @returns {Promise<{ok: boolean, missing?: boolean}>}
 */
export async function patchChatMessage(channel, providerMessageId, patch, { attempts = 4 } = {}) {
  if (!providerMessageId || tablePresent === false) return { ok: false };
  try {
    for (let i = 0; i < attempts; i++) {
      const { data, error } = await db().from('chat_messages').select('id, payload')
        .eq('channel', channel).eq('provider_message_id', String(providerMessageId)).maybeSingle();
      if (error) {
        if (isSchemaMissing(error)) tablePresent = false;
        else console.error('chat log read failed:', error.message);
        return { ok: false };
      }
      if (data) {
        const { error: writeError } = await db().from('chat_messages')
          .update({ payload: { ...(data.payload ?? {}), ...patch }, updated_at: new Date().toISOString() })
          .eq('id', data.id);
        if (writeError) console.error('chat log patch failed:', writeError.message);
        return { ok: !writeError };
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (i + 1)));
    }
    return { ok: false, missing: true };
  } catch (err) {
    console.error('chat log patch threw:', err?.message);
    return { ok: false };
  }
}

/**
 * Where each delivery status may come from. WhatsApp's receipts can arrive
 * out of order - "delivered" after "read" is common - so a status only ever
 * moves forward: a late "delivered" must not turn a read message unread.
 */
const MAY_FOLLOW = {
  sent: ['queued'],
  delivered: ['queued', 'sent'],
  read: ['queued', 'sent', 'delivered'],
  failed: ['queued', 'sent', 'delivered'],
};

/** Meta's statuses, in the table's words. "played" is a voice note heard. */
export function normaliseDeliveryStatus(status) {
  const s = String(status ?? '').toLowerCase();
  if (s === 'played') return 'read';
  return MAY_FOLLOW[s] ? s : null;
}

/**
 * A delivery receipt: the message we sent with this provider id was
 * delivered, read, or failed.
 *
 * @returns {Promise<{ok: boolean, updated?: number}>}
 */
export async function markDelivery(channel, providerMessageId, status, error = null) {
  const next = normaliseDeliveryStatus(status);
  if (!providerMessageId || !next || tablePresent === false) return { ok: false };
  try {
    const { data, error: dbError } = await db()
      .from('chat_messages')
      .update({
        status: next,
        ...(error ? { error: String(error).slice(0, 500) } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('channel', channel)
      .eq('provider_message_id', String(providerMessageId))
      .in('status', MAY_FOLLOW[next])
      .select('id');
    if (dbError) {
      if (isSchemaMissing(dbError)) tablePresent = false;
      else console.error('chat log delivery update failed:', dbError.message);
      return { ok: false };
    }
    return { ok: true, updated: data?.length ?? 0 };
  } catch (err) {
    console.error('chat log delivery update threw:', err?.message);
    return { ok: false };
  }
}
