/**
 * Who we are talking to.
 *
 * A Telegram user id is the only stable identity a person has here. Usernames
 * change, display names are not a business name, and a chat id identifies a
 * conversation rather than a person. So every booking, document and ticket
 * hangs off a client row keyed by that id, and ownership questions - "may this
 * chat see that shipment?" - are answered from it.
 *
 * The Telegram display name is deliberately NOT the booking's client name. The
 * name on the paperwork is a business fact the client tells us in the flow.
 */

import { db } from './supabase.js';

/**
 * Finds or creates the client behind a Telegram user, refreshing the profile
 * fields Telegram sends with every update.
 *
 * @param {{telegramUserId: number|string, chatId: number|string, username?: string,
 *          firstName?: string, lastName?: string}} who
 * @returns {Promise<{id: number, is_blocked: boolean}|null>}
 */
export async function upsertTelegramClient(who) {
  const userId = toBigint(who?.telegramUserId);
  if (userId === null) return null;

  const display = [who.firstName, who.lastName].filter(Boolean).join(' ').trim() || null;
  const row = {
    telegram_user_id: userId,
    telegram_chat_id: toBigint(who.chatId),
    telegram_username: who.username ?? null,
    first_name: who.firstName ?? null,
    last_name: who.lastName ?? null,
    display_name: display,
    updated_at: new Date().toISOString(),
  };

  // onConflict on the telegram_user_id unique index: two messages arriving at
  // once from a first-time user both insert, and one would otherwise fail.
  const { data, error } = await db()
    .from('clients')
    .upsert(row, { onConflict: 'telegram_user_id' })
    .select('id, is_blocked, display_name')
    .single();

  if (error) {
    console.error('client upsert failed:', error.message);
    // Fall back to a read: the row may exist and only the update have failed.
    const { data: existing } = await db()
      .from('clients')
      .select('id, is_blocked, display_name')
      .eq('telegram_user_id', userId)
      .maybeSingle();
    return existing ?? null;
  }
  return data;
}

/** The client behind a web-widget session, which has no Telegram identity. */
export async function clientForChat(chatId) {
  const { data } = await db()
    .from('clients')
    .select('id, is_blocked, display_name, telegram_user_id')
    .eq('telegram_chat_id', toBigint(chatId) ?? -1)
    .maybeSingle();
  return data ?? null;
}

/**
 * May this conversation see this record?
 *
 * The rule is deliberately narrow. A record belongs to the chat that created it
 * and to the client behind that chat; a reference typed by someone else opens
 * nothing. Without this, anyone who guessed or was forwarded a booking
 * reference could read another company's route, vessel and arrival date.
 *
 * @param {{chat_id?: string|null, client_id?: number|null}} record
 * @param {{chatId: string|number, clientId?: number|null}} viewer
 */
export function ownsRecord(record, viewer) {
  if (!record) return false;
  const sameChat = record.chat_id != null && String(record.chat_id) === String(viewer.chatId);
  const sameClient = record.client_id != null && viewer.clientId != null
    && Number(record.client_id) === Number(viewer.clientId);
  return sameChat || sameClient;
}

function toBigint(value) {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/[^0-9-]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}
