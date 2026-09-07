/**
 * Tracking: "where is my vehicle".
 *
 * Every value shown here is read from the shipment row in the same request. A
 * field the database has not filled in reads "Not available yet" - it is never
 * inferred, never carried over from an earlier answer, and Refresh always goes
 * back to Postgres rather than repeating what the conversation last said.
 *
 * The access rule matters as much as the data. A booking reference is short,
 * quotable and gets forwarded between brokers; without an ownership check
 * anyone holding one could read another company's route, vessel and arrival
 * date. Not-found and not-yours give the SAME answer, so the bot cannot be used
 * to discover whether a reference exists.
 */

import { db } from '../supabase.js';
import { S, FLOWS } from './states.js';
import { M, NOT_AVAILABLE, NOT_ASSIGNED, both } from './messages.js';
import * as kb from './keyboards.js';
import { normalizeVin } from '../bookings.js';
import { setting } from '../settings.js';
import { logEvent } from '../audit.js';

const say = (text, inline = null) => ({ text, ...(inline ? { inline } : {}) });
const reply = (messages, patch = {}) => ({ messages: [].concat(messages), patch });

export function askIdentifier(session) {
  return reply(say(M.askTrackingId(), kb.homeOnly()), {
    active_flow: FLOWS.TRACKING,
    current_state: S.TRACK_IDENTIFIER,
  });
}

/**
 * Finds the shipment behind a chassis number or a reference, if this client is
 * allowed to see it.
 *
 * @returns {Promise<{found: boolean, shipment?: object, booking?: object, denied?: boolean}>}
 */
export async function lookupForClient(identifier, viewer) {
  const raw = String(identifier ?? '').trim();
  if (!raw) return { found: false };

  const upper = raw.toUpperCase();
  const norm = normalizeVin(raw);

  // Exact matches only, and never on customer name: matching a name meant a
  // client typing a single letter was handed five other companies' shipments.
  const filters = [
    `shipment_id.eq.${upper}`,
    `booking_ref.eq.${upper}`,
    `acid_id.eq.${upper}`,
    `bl_number.eq.${upper}`,
    `container_no.eq.${upper}`,
  ];
  if (norm.length >= 6) filters.push(`vin_norm.eq.${norm}`);

  const { data, error } = await db()
    .from('shipments')
    .select('*')
    .or(filters.join(','))
    .order('updated_at', { ascending: false })
    .limit(5);

  if (error) {
    console.error('shipment lookup failed:', error.message);
    return { found: false, error: error.message };
  }

  for (const shipment of data ?? []) {
    const allowed = await mayView(shipment, viewer);
    if (allowed) {
      const events = await recentEvents(shipment.shipment_id);
      return { found: true, shipment: { ...shipment, recent_events: events } };
    }
  }

  if (data?.length) {
    logEvent('shipment_access_denied', { chat_id: String(viewer.chatId), identifier: upper.slice(0, 40) });
    // Same answer as not-found, deliberately.
    return { found: false, denied: true };
  }

  // No shipment. There may still be a booking they own that has not become one
  // yet - a client who booked this morning and is quoting the reference we gave
  // them must not be told we have never heard of it.
  const booking = await ownedBooking(upper, norm, viewer);
  if (booking) return { found: false, booking };

  return { found: false };
}

async function mayView(shipment, viewer) {
  if (String(shipment.chat_id ?? '') === String(viewer.chatId)) return true;

  if (shipment.booking_ref) {
    const { data: booking } = await db()
      .from('bookings')
      .select('chat_id, client_id')
      .eq('booking_ref', shipment.booking_ref)
      .maybeSingle();
    if (booking) {
      if (String(booking.chat_id ?? '') === String(viewer.chatId)) return true;
      if (booking.client_id != null && viewer.clientId != null
          && Number(booking.client_id) === Number(viewer.clientId)) return true;
    }
  }

  // A row belonging to nobody is demo data. Off in production; a demo
  // environment turns it on deliberately and knows what it is showing.
  const ownerless = !shipment.chat_id && !shipment.booking_ref;
  if (ownerless) return (await setting('allow_unowned_shipment_tracking')) === true;

  return false;
}

async function ownedBooking(upper, norm, viewer) {
  const filters = [`booking_ref.eq.${upper}`];
  if (norm.length >= 6) filters.push(`vin_norm.eq.${norm}`);

  const { data } = await db()
    .from('bookings')
    .select('booking_ref, status, vin, make, model, origin_port, destination_port, chat_id, client_id, ops_notes')
    .or(filters.join(','))
    .neq('status', 'draft')
    .order('created_at', { ascending: false })
    .limit(3);

  return (data ?? []).find((b) =>
    String(b.chat_id ?? '') === String(viewer.chatId)
    || (b.client_id != null && viewer.clientId != null && Number(b.client_id) === Number(viewer.clientId)),
  ) ?? null;
}

/** The card. Every line is a column of the row; a blank one says so. */
export function shipmentCard(s) {
  const latest = s.recent_events?.[0] ?? null;
  const vehicle = [s.make, s.model].filter(Boolean).join(' ') || s.cargo_description || null;

  const line = (arLabel, enLabel, value, blank) =>
    `${arLabel} / ${enLabel}: ${value || `${blank.ar} / ${blank.en}`}`;

  return [
    `📦 ${s.shipment_id}${vehicle ? ` — ${vehicle}` : ''}`,
    s.vin ? `الشاسيه / Chassis: ${s.vin}` : null,
    s.booking_ref ? `رقم الحجز / Booking Ref: ${s.booking_ref}` : null,
    line('الحالة', 'Status', s.status, NOT_AVAILABLE),
    line('السفينة', 'Vessel', s.vessel, NOT_ASSIGNED),
    line('الموقع', 'Location', latest?.location, NOT_AVAILABLE),
    `خط الشحن / Route: ${s.origin_port} → ${s.destination_port}`,
    line('الوصول المتوقع', 'ETA', s.eta, NOT_AVAILABLE),
    latest?.description
      ? `آخر تحديث / Last update: ${latest.description}${latest.event_time ? ` (${String(latest.event_time).slice(0, 10)})` : ''}`
      : null,
  ].filter(Boolean).join('\n');
}

/** A booking that has not become a shipment yet: say where it actually is. */
export function bookingCard(b) {
  const status = String(b.status ?? '').replace(/_/g, ' ');
  return [
    `📋 ${b.booking_ref}`,
    b.vin ? `الشاسيه / Chassis: ${b.vin}` : null,
    `خط الشحن / Route: ${b.origin_port ?? '—'} → ${b.destination_port ?? '—'}`,
    `الحالة / Status: ${status}`,
    b.ops_notes ? `ملاحظة / Note: ${b.ops_notes}` : null,
    '',
    both(
      'لسه ما بدأتش الشحنة، فمفيش سفينة ولا موعد وصول لحد دلوقتي.',
      'The shipment has not started yet, so there is no vessel or arrival date on it.',
    ),
  ].filter((l) => l !== null).join('\n');
}

/** Handles the identifier the client typed. */
export async function handleIdentifier(session, text, ctx) {
  const result = await lookupForClient(text, { chatId: ctx.chatId, clientId: ctx.clientId ?? null });

  if (result.error) {
    return reply(say(M.recoverableError(ctx.correlationId), kb.errorRecovery()));
  }

  if (result.found) {
    return reply([
      say(M.trackingFound()),
      say(shipmentCard(result.shipment), kb.trackingFound(result.shipment.shipment_id)),
    ], {
      current_state: S.TRACK_RESULTS,
      context: { ...session.context, last_tracked: result.shipment.shipment_id },
    });
  }

  if (result.booking) {
    return reply(
      say(bookingCard(result.booking), kb.trackingFound(result.booking.booking_ref)),
      { current_state: S.TRACK_RESULTS, context: { ...session.context, last_tracked: result.booking.booking_ref } },
    );
  }

  return reply(say(M.trackingNotFound(), kb.trackingNotFound()), { current_state: S.TRACK_IDENTIFIER });
}

/**
 * Refresh.
 *
 * Re-queries by the reference carried in the button's payload. The point is
 * that it does NOT repeat the card from the conversation: a status that changed
 * two minutes ago has to show, and a client pressing Refresh is asking the
 * database, not the transcript.
 */
export async function handleRefresh(session, reference, ctx) {
  const key = reference || session.context?.last_tracked;
  if (!key) return reply(say(M.askTrackingId(), kb.homeOnly()), { current_state: S.TRACK_IDENTIFIER });

  const result = await lookupForClient(key, { chatId: ctx.chatId, clientId: ctx.clientId ?? null });

  if (result.found) {
    return reply([
      say(M.trackingLatest()),
      say(shipmentCard(result.shipment), kb.trackingFound(result.shipment.shipment_id)),
    ], { current_state: S.TRACK_RESULTS });
  }
  if (result.booking) {
    return reply([
      say(M.trackingLatest()),
      say(bookingCard(result.booking), kb.trackingFound(result.booking.booking_ref)),
    ], { current_state: S.TRACK_RESULTS });
  }
  return reply(say(M.trackingNotFound(), kb.trackingNotFound()), { current_state: S.TRACK_IDENTIFIER });
}

async function recentEvents(shipmentId) {
  const { data } = await db()
    .from('shipment_events')
    .select('event_time, location, description')
    .eq('shipment_id', shipmentId)
    .order('event_time', { ascending: false })
    .limit(5);
  return data ?? [];
}
