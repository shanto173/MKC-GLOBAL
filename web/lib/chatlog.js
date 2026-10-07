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
