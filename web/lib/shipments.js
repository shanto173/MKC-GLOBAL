/**
 * Turning a confirmed booking into a shipment - roadmap step 4, "Create Booking
 * in the system".
 *
 * Without this the loop is broken: a customer books, Operations confirms, and
 * then tracking their own chassis tells them we have never heard of it, because
 * bookings and shipments were separate tables with nothing between them.
 */

import { db } from './supabase.js';

/** Milestones a shipment moves through, in order. */
export const SHIPMENT_STATUSES = [
  'Booking confirmed, awaiting cargo',
  'Awaiting pickup at origin',
  'Received at origin warehouse',
  'Loaded on vessel',
  'Vessel departed',
  'In transit',
  'Arrived at destination port',
  'Customs clearance in progress',
  'Customs cleared',
  'Out for delivery',
  'Delivered',
  'On hold',
];

/**
 * Creates the shipment for a booking, or returns the one that already exists.
 * Safe to call twice - Operations clicking confirm again must not produce a
 * second shipment for the same vehicle.
 */
export async function createShipmentFromBooking(booking, { operator = 'operations' } = {}) {
  const { data: existing } = await db()
    .from('shipments')
    .select('shipment_id, status')
    .eq('booking_ref', booking.booking_ref)
    .maybeSingle();
  if (existing) return { ok: true, existed: true, shipment_id: existing.shipment_id };

  const { data: idRow, error: idErr } = await db().rpc('next_shipment_id', { prefix: 'MKY' });
  if (idErr) return { ok: false, error: `could not allocate a shipment id: ${idErr.message}` };
  const shipmentId = idRow;

  const row = {
    shipment_id: shipmentId,
    booking_ref: booking.booking_ref,
    chat_id: booking.chat_id,
    channel: booking.channel,
    vin: booking.vin,
    make: booking.make,
    model: booking.model,
    customer_name: booking.customer_name,
    customer_email: extractEmail(booking.customer_contact),
    customer_phone: extractPhone(booking.customer_contact),
    origin_port: booking.origin_port,
    destination_port: booking.destination_port,
    mode: 'Sea RoRo',
    status: SHIPMENT_STATUSES[0],
    mrn_status: booking.mrn_number ? 'Submitted' : booking.mrn_needed ? 'MKY to obtain' : 'Pending',
    payment_status: 'Pending',
    delivery_status: 'Not yet',
    cargo_description: [booking.make, booking.model].filter(Boolean).join(' ') || booking.cargo_description,
    gross_weight_kg: booking.gross_weight_kg,
    incoterm: booking.incoterm,
    engine_condition: booking.raw?.engine_condition ?? null,
    acid_id: booking.acid_number || null,
    etd: booking.ready_date || null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await db().from('shipments').insert(row);
  if (error) return { ok: false, error: error.message };

  await addEvent(shipmentId, {
    description: `Booking ${booking.booking_ref} confirmed by ${operator}. Shipment opened.`,
    location: booking.origin_port,
  });

  return { ok: true, existed: false, shipment_id: shipmentId };
}

/** Records a milestone. The customer sees these when they track. */
export async function addEvent(shipmentId, { description, location = null, at = null }) {
  const { error } = await db().from('shipment_events').insert({
    shipment_id: shipmentId,
    description,
    location,
    event_time: at ?? new Date().toISOString(),
  });
  if (error) console.error('shipment event insert failed:', error.message);
  return !error;
}

/**
 * Moves a shipment on. Every change writes an event as well as the new status,
 * so the customer sees a history rather than a single value that quietly
 * changed under them.
 */
export async function updateShipmentStatus(shipmentId, changes, { operator = 'operations', note = '' } = {}) {
  const { data: current, error: readErr } = await db()
    .from('shipments')
    .select('*')
    .eq('shipment_id', shipmentId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!current) return { ok: false, error: `No shipment ${shipmentId}` };

  const allowed = ['status', 'location', 'vessel', 'eta', 'etd', 'mrn_status', 'payment_status',
    'delivery_status', 'acid_id', 'bl_number', 'container_no'];
  const patch = {};
  for (const key of allowed) {
    if (changes[key] === undefined || changes[key] === '' || changes[key] === current[key]) continue;
    patch[key] = changes[key];
  }
  // `location` is not a shipments column - it belongs on the event.
  const location = patch.location ?? null;
  delete patch.location;

  if (!Object.keys(patch).length && !note && !location) {
    return { ok: true, unchanged: true, shipment_id: shipmentId };
  }

  patch.updated_at = new Date().toISOString();
  const { data: updated, error } = await db()
    .from('shipments')
    .update(patch)
    .eq('shipment_id', shipmentId)
    .select()
    .single();
  if (error) return { ok: false, error: error.message };

  const described = Object.entries(patch)
    .filter(([k]) => k !== 'updated_at')
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
    .join('; ');

  await addEvent(shipmentId, {
    description: note || described || 'Updated',
    location: location ?? null,
  });

  return { ok: true, shipment: updated, changed: described, event_note: note || null };
}

function extractEmail(contact) {
  const m = String(contact ?? '').match(/[^\s<>@]+@[^\s<>@]+\.[a-z]{2,}/i);
  return m ? m[0] : null;
}

function extractPhone(contact) {
  const s = String(contact ?? '');
  if (/@/.test(s)) return null;
  const m = s.match(/\+?[\d\s().-]{7,}/);
  return m ? m[0].trim() : null;
}
