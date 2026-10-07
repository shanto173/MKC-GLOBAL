/**
 * Who we are talking to.
 *
 * A Telegram user id - or, on WhatsApp, the number (wa_id) - is the only
 * stable identity a person has here. Usernames change, display names are not a
 * business name, and a chat id identifies a conversation rather than a person.
 * So every booking, document and ticket hangs off a client row keyed by that
 * id, and ownership questions - "may this chat see that shipment?" - are
 * answered from it. One person on both apps is two rows; nothing links them.
 *
 * The Telegram display name is deliberately NOT the booking's client name. The
 * name on the paperwork is a business fact the client tells us in the flow.
 */

import { db } from './supabase.js';
import { looksLikePhone } from './phone.js';
import { isSchemaMissing } from './chatlog.js';

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

// Whether clients.whatsapp_id (migration 20261007090000) exists. Learned once.
let whatsappColumns = null;

/** For tests: forget what was learned about the schema. */
export function resetClientsForTests() {
  whatsappColumns = null;
}

const WHATSAPP_CLIENT = 'id, is_blocked, display_name, phone, language, opted_out_at, whatsapp_id, whatsapp_name';

/**
 * Finds or creates the client behind a WhatsApp number, refreshing the
 * profile name WhatsApp sends with every message.
 *
 * On WhatsApp the sender IS their phone number (the wa_id: E.164 digits, no
 * plus), and WhatsApp vouches for it - so it becomes the client's phone when
 * none is on file. A number the client later types for a booking replaces it
 * there (rememberClientContact), and that is the one used from then on.
 *
 * Not an upsert: the unique index on whatsapp_id is partial (only where it is
 * set), and Postgres will not use a partial index as an ON CONFLICT target.
 * An update, then an insert, then - if a first-time client's two messages
 * raced - a read of the row the other one made.
 *
 * Null until the migration that adds whatsapp_id is applied; the transport
 * then runs without a client row, as a Telegram chat with no user would.
 *
 * @param {{waId: string, profileName?: string|null}} who
 * @returns {Promise<{id: number, is_blocked: boolean, phone: string|null,
 *                    language: string|null, opted_out_at: string|null}|null>}
 */
export async function upsertWhatsAppClient({ waId, profileName = null } = {}) {
  const id = String(waId ?? '').replace(/\D/g, '');
  if (!id || whatsappColumns === false) return null;
  const name = String(profileName ?? '').trim().slice(0, 120) || null;
  const now = new Date().toISOString();

  const updated = await db().from('clients')
    .update({ ...(name ? { whatsapp_name: name } : {}), updated_at: now })
    .eq('whatsapp_id', id)
    .select(WHATSAPP_CLIENT);
  if (updated.error) {
    if (isSchemaMissing(updated.error)) whatsappColumns = false;
    else console.error('whatsapp client update failed:', updated.error.message);
    return null;
  }
  whatsappColumns = true;

  let client = updated.data?.[0] ?? null;
  if (!client) {
    const inserted = await db().from('clients').insert({
      whatsapp_id: id,
      whatsapp_name: name,
      display_name: name,
      phone: `+${id}`,
      updated_at: now,
    }).select(WHATSAPP_CLIENT).single();
    if (inserted.error) {
      if (inserted.error.code !== '23505') console.error('whatsapp client insert failed:', inserted.error.message);
      const { data } = await db().from('clients').select(WHATSAPP_CLIENT).eq('whatsapp_id', id).maybeSingle();
      return data ?? null;
    }
    return inserted.data;
  }

  if (!looksLikePhone(client.phone)) {
    const { data } = await db().from('clients').update({ phone: `+${id}` }).eq('id', client.id).select(WHATSAPP_CLIENT);
    client = data?.[0] ?? { ...client, phone: `+${id}` };
  }
  return client;
}

/**
 * STOP and START. Returns whether the stored state changed, so a second STOP
 * is not confirmed a second time.
 *
 * @returns {Promise<{ok: boolean, changed?: boolean, unsupported?: boolean}>}
 */
export async function setOptOut(clientId, optedOut) {
  if (!clientId) return { ok: false };
  const { data: current, error: readErr } = await db().from('clients')
    .select('opted_out_at').eq('id', clientId).maybeSingle();
  if (readErr) return { ok: false, unsupported: isSchemaMissing(readErr) };
  const isOut = Boolean(current?.opted_out_at);
  if (isOut === Boolean(optedOut)) return { ok: true, changed: false };

  const { error } = await db().from('clients')
    .update({ opted_out_at: optedOut ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
    .eq('id', clientId);
  if (error) {
    console.error('opt-out update failed:', error.message);
    return { ok: false, unsupported: isSchemaMissing(error) };
  }
  return { ok: true, changed: true };
}

/**
 * A number or an email the client gave us, kept on their record.
 *
 * The booking holds the contact for THAT booking; this is the person. It is
 * what lets the next booking say "is +20… still your number?" and lets a
 * request for an agent go straight to the agent instead of asking for a number
 * the client gave us last week.
 */
export async function rememberClientContact(clientId, { phone = null, email = null } = {}) {
  if (!clientId) return;
  const patch = {};
  if (phone) patch.phone = String(phone).trim();
  if (email) patch.email = String(email).trim();
  if (!Object.keys(patch).length) return;

  const { error } = await db()
    .from('clients')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', clientId);
  if (error) console.error('client contact update failed:', error.message);
}

/**
 * The number we already hold for whoever is in this chat: their client record
 * first, then the newest booking they gave a number on, then - on WhatsApp
 * only - the number they are writing from. Null when there is none.
 *
 * A Telegram chat id is never read as a phone number. A WhatsApp chat id is
 * one: "wa:201005551234" is the number WhatsApp itself vouches for, which is
 * why the phone step there can offer it instead of asking.
 */
export async function phoneOnFile({ chatId, clientId = null }) {
  if (clientId) {
    const { data } = await db().from('clients').select('phone').eq('id', clientId).maybeSingle();
    if (looksLikePhone(data?.phone)) return String(data.phone).trim();
  }

  const { data: bookings } = await db()
    .from('bookings')
    .select('customer_contact, created_at')
    .eq('chat_id', String(chatId))
    .order('created_at', { ascending: false })
    .limit(5);

  for (const b of bookings ?? []) {
    if (looksLikePhone(b.customer_contact)) return String(b.customer_contact).trim();
  }

  const wa = whatsappNumber(chatId);
  return wa && looksLikePhone(wa) ? wa : null;
}

/**
 * The client behind a chat id: a WhatsApp chat by its number, anything else
 * by Telegram chat id (the web widget has no client row of its own).
 */
export async function clientForChat(chatId) {
  const wa = whatsappNumber(chatId);
  if (wa) {
    if (whatsappColumns === false) return null;
    const { data, error } = await db()
      .from('clients')
      .select('id, is_blocked, display_name, telegram_user_id, whatsapp_id')
      .eq('whatsapp_id', wa.slice(1))
      .maybeSingle();
    if (error && isSchemaMissing(error)) whatsappColumns = false;
    return data ?? null;
  }
  const { data } = await db()
    .from('clients')
    .select('id, is_blocked, display_name, telegram_user_id')
    .eq('telegram_chat_id', toBigint(chatId) ?? -1)
    .maybeSingle();
  return data ?? null;
}

/** "+201005551234" for a "wa:201005551234" chat id; null for any other. */
function whatsappNumber(chatId) {
  const s = String(chatId ?? '');
  if (!s.startsWith('wa:')) return null;
  const digits = s.slice(3).replace(/\D/g, '');
  return digits ? `+${digits}` : null;
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
