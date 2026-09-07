/**
 * Booking requests: the record, and the rules the record must obey.
 *
 * Everything here is deterministic. No call in this file consults a language
 * model, and none of it can be talked into a different answer: whether a unit
 * is already booked, what is still missing, and whether a request may be
 * submitted are decided from rows in Postgres and from nothing else.
 *
 * The conversation layer (lib/flow/booking.js) decides what to SAY. This decides
 * what is TRUE.
 */

import { db } from './supabase.js';
import { config, DESTINATION_PORTS } from './config.js';
import { audit, logEvent } from './audit.js';
import { makeTaskRef } from './operations.js';

export const BASIC_REQUIRED = ['vin', 'make', 'customer_name', 'origin_port', 'destination_port'];

/** Statuses in which a booking occupies its chassis. A draft does not. */
export const LIVE_STATUSES = ['pending_review', 'under_review', 'needs_client_action', 'confirmed'];

export function makeBookingRef() {
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${config.refPrefix}-BKG-${stamp}-${rand}`;
}

export function normalizeVin(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Is this plausibly a chassis number?
 *
 * Deliberately permissive. A 17-character VIN check would reject the older and
 * non-standard chassis numbers that actually arrive on this lane, and rejecting
 * a real client's real number is far worse than accepting an odd one - the
 * lookup that follows will simply find nothing.
 *
 * What it does reject is the things that are certainly not a chassis number: a
 * menu digit, a phone number, a sentence.
 */
export function looksLikeVin(value) {
  const v = normalizeVin(value);
  if (v.length < 6 || v.length > 25) return false;
  // All digits is a reference, a phone number or a quantity - never a chassis.
  if (!/[A-Z]/.test(v)) return false;
  // More than a handful of words is prose, whatever characters it contains.
  if (String(value).trim().split(/\s+/).length > 4) return false;
  return true;
}

/**
 * Which of our five Egyptian ports the client means.
 *
 * The previous matcher tested `typed.includes(firstWordOfPort)`, and the first
 * word of "Port Said" is "port" - so "Damietta port" matched Port Said and a
 * booking was routed to the wrong city. Matching is now on the distinctive part
 * of each port name, longest first, with the Arabic spellings included because
 * half the clients type them.
 */
const PORT_ALIASES = [
  ['Alexandria Port (incl. El Dekheila)', ['alexandria', 'alex', 'dekheila', 'el dekheila', 'الإسكندرية', 'الاسكندرية', 'اسكندرية', 'الدخيلة']],
  ['Port Said', ['port said', 'portsaid', 'said', 'بورسعيد', 'بور سعيد']],
  ['Damietta Port', ['damietta', 'dumyat', 'domyat', 'دمياط']],
  ['Ain Sokhna Port', ['ain sokhna', 'sokhna', 'ain al sokhna', 'السخنة', 'العين السخنة']],
  ['Suez Port', ['suez', 'السويس']],
];

export function matchPort(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;

  const exact = DESTINATION_PORTS.find((p) => p.toLowerCase() === raw);
  if (exact) return exact;

  // Longest alias first, so "port said" is tested before "said" and
  // "ain sokhna" before "suez" can steal a message mentioning both.
  const candidates = PORT_ALIASES
    .flatMap(([port, aliases]) => aliases.map((a) => ({ port, alias: a })))
    .sort((a, b) => b.alias.length - a.alias.length);

  for (const { port, alias } of candidates) {
    if (raw.includes(alias)) return port;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** The unfinished request this chat is in the middle of, if any. */
export async function findDraft(chatId) {
  const { data, error } = await db()
    .from('bookings')
    .select('*')
    .eq('chat_id', String(chatId))
    .eq('status', 'draft')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('draft lookup failed:', error.message);
    return { draft: null, error: error.message };
  }
  return { draft: data ?? null, error: null };
}

export async function bookingByRef(ref) {
  const { data } = await db().from('bookings').select('*').eq('booking_ref', String(ref)).maybeSingle();
  return data ?? null;
}

/**
 * Starts a request. One draft per conversation: an older one is dropped, so a
 * client cannot end up with two half-finished requests neither of which they
 * can see.
 */
export async function createDraft({ chatId, clientId = null, channel = 'telegram', telegramUserId = null }) {
  await db().from('bookings').delete().eq('chat_id', String(chatId)).eq('status', 'draft');

  const row = {
    booking_ref: makeBookingRef(),
    channel,
    chat_id: String(chatId),
    client_id: clientId,
    telegram_user_id: telegramUserId,
    status: 'draft',
    current_step: 'BOOK_VIN',
    // Never our own routing address if we can help it, but a booking has to be
    // reachable somehow and on Telegram the chat is a real way to reach them.
    customer_contact: `${channel}:${chatId}`,
    raw: {},
  };

  const { data, error } = await db().from('bookings').insert(row).select().single();
  if (error) {
    console.error('draft create failed:', error.message);
    return { ok: false, error: error.message };
  }

  logEvent('booking_draft_created', { booking_ref: data.booking_ref, chat_id: String(chatId) });
  await audit({
    actor_type: 'client', actor_id: chatId,
    action: 'booking_draft_created',
    entity_type: 'booking', entity_id: data.booking_ref,
  });
  return { ok: true, draft: data };
}

/**
 * Writes fields onto a draft.
 *
 * Refuses to touch anything that is no longer a draft, so a retried callback
 * cannot edit a request an operator is already reading.
 */
export async function updateDraft(ref, patch, { chatId } = {}) {
  const clean = { ...patch, updated_at: undefined };
  delete clean.updated_at;

  const query = db()
    .from('bookings')
    .update(clean)
    .eq('booking_ref', ref)
    .eq('status', 'draft');
  if (chatId != null) query.eq('chat_id', String(chatId));

  const { data, error } = await query.select();
  if (error) {
    console.error('draft update failed:', error.message);
    return { ok: false, error: error.message };
  }
  if (!data?.length) {
    return { ok: false, error: 'that request is no longer a draft', stale: true };
  }
  return { ok: true, draft: data[0] };
}

/** Which of the five basics this request still lacks. */
export function missingBasics(booking) {
  return BASIC_REQUIRED.filter((f) => !String(booking?.[f] ?? '').trim());
}

// ---------------------------------------------------------------------------
// Step 1 - the chassis check
// ---------------------------------------------------------------------------

/**
 * What we know about a chassis number, and whether it may be booked again.
 *
 * The three verdicts are exactly the roadmap's three branches:
 *   new                - nothing on file, continue
 *   known_not_booked   - we hold the unit, no live booking, continue with what we have
 *   already_booked     - a live booking exists; do NOT start another
 *
 * A draft belonging to THIS conversation is not a blocker - it is the request
 * being built. A draft belonging to another chat is not one either: nobody has
 * committed to anything yet.
 */
export async function lookupVehicle(vin, { excludeBookingRef = null } = {}) {
  const norm = normalizeVin(vin);
  if (norm.length < 6) return { ok: false, reason: 'too_short' };

  const [vehicle, booking, shipment] = await Promise.all([
    db().from('vehicles').select('*').eq('vin_norm', norm).maybeSingle(),
    db().from('bookings')
      .select('booking_ref, status, vin, make, model, origin_port, destination_port, customer_name, chat_id, client_id, created_at')
      .eq('vin_norm', norm)
      .in('status', LIVE_STATUSES)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db().from('shipments')
      .select('shipment_id, status, origin_port, destination_port, eta, vessel, booking_ref')
      .eq('vin_norm', norm)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  for (const r of [vehicle, booking, shipment]) {
    if (r.error) return { ok: false, reason: 'database', error: r.error.message };
  }

  const live = booking.data && booking.data.booking_ref !== excludeBookingRef ? booking.data : null;

  if (live) {
    logEvent('duplicate_booking_detected', { vin_norm: norm, booking_ref: live.booking_ref });
    return { ok: true, verdict: 'already_booked', booking: live, vehicle: vehicle.data ?? null, shipment: shipment.data ?? null };
  }

  const known = Boolean(vehicle.data || shipment.data);
  return {
    ok: true,
    verdict: known ? 'known_not_booked' : 'new',
    booking: null,
    vehicle: vehicle.data ?? null,
    shipment: shipment.data ?? null,
  };
}

// ---------------------------------------------------------------------------
// Step 4 - submission
// ---------------------------------------------------------------------------

/**
 * Sends the request to Operations.
 *
 * The whole thing happens inside one Postgres function: the ownership check,
 * the duplicate check, the status change and the Operations task are one
 * transaction, so a double tap, a retried webhook and two workers racing all
 * produce one submission and one task.
 *
 * @returns {Promise<{ok: boolean, already?: boolean, reason?: string,
 *                    booking_ref?: string, task_created?: boolean}>}
 */
export async function submitDraft(ref, chatId) {
  const { data, error } = await db().rpc('submit_booking_request', {
    p_booking_ref: String(ref),
    p_chat_id: String(chatId),
    p_task_ref: makeTaskRef(),
  });

  if (error) {
    console.error('submit_booking_request failed:', error.message);
    return { ok: false, reason: 'database', error: error.message };
  }

  const result = data ?? { ok: false, reason: 'no_result' };
  if (result.ok && !result.already) {
    logEvent('booking_request_submitted', { booking_ref: result.booking_ref, chat_id: String(chatId) });
    await audit({
      actor_type: 'client', actor_id: chatId,
      action: 'booking_request_submitted',
      entity_type: 'booking', entity_id: result.booking_ref,
      metadata: { task_created: result.task_created },
    });
  }
  return result;
}

/** The client withdrawing an unfinished request. Never touches a live booking. */
export async function cancelDraft(ref, chatId) {
  const { data, error } = await db()
    .from('bookings')
    .update({ status: 'cancelled', current_step: null })
    .eq('booking_ref', ref)
    .eq('chat_id', String(chatId))
    .eq('status', 'draft')
    .select();

  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, notDraft: true };

  await audit({
    actor_type: 'client', actor_id: chatId,
    action: 'booking_draft_cancelled',
    entity_type: 'booking', entity_id: ref,
  });
  return { ok: true, booking: data[0] };
}

// ---------------------------------------------------------------------------
// Lookup by identifier, with ownership
// ---------------------------------------------------------------------------

/**
 * Finds a booking by reference or chassis, for a client who is asking about it.
 *
 * The ownership rule is the reason this is not a plain select: a booking
 * reference is short, quotable and gets forwarded, and without this anyone
 * holding one could read another company's route, client name and schedule.
 * Not-found and not-yours deliberately return the SAME answer to the client, so
 * the bot cannot be used to test whether a reference exists.
 */
export async function findBookingForClient(identifier, viewer) {
  const raw = String(identifier ?? '').trim();
  if (!raw) return { found: false };

  const norm = normalizeVin(raw);
  const byRef = await db()
    .from('bookings')
    .select('*')
    .eq('booking_ref', raw.toUpperCase())
    .neq('status', 'draft')
    .maybeSingle();

  let row = byRef.data ?? null;

  if (!row && norm.length >= 6) {
    const byVin = await db()
      .from('bookings')
      .select('*')
      .eq('vin_norm', norm)
      .neq('status', 'draft')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    row = byVin.data ?? null;
  }

  if (!row) return { found: false };

  const sameChat = String(row.chat_id ?? '') === String(viewer.chatId);
  const sameClient = row.client_id != null && viewer.clientId != null
    && Number(row.client_id) === Number(viewer.clientId);

  if (!sameChat && !sameClient) {
    logEvent('booking_access_denied', { booking_ref: row.booking_ref, chat_id: String(viewer.chatId) });
    return { found: false, denied: true };
  }

  return { found: true, booking: row };
}
