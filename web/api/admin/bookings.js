/**
 * The Operations queue - roadmap step 4.
 *
 *   GET  /api/admin/bookings?secret=...            pending requests, oldest first
 *   GET  /api/admin/bookings?secret=...&status=... any status
 *   POST /api/admin/bookings?secret=...            { booking_ref, action, note, operator }
 *
 * A confirm or reject writes the decision and tells the customer, in the chat
 * they booked from and by email. That is the loop that was missing: a booking
 * used to sit at pending_review until somebody remembered to write to them.
 */

import { config } from '../../lib/config.js';
import { db } from '../../lib/supabase.js';
import { notifyBookingDecision } from '../../lib/notify.js';
import { signedUrl } from '../../lib/storage.js';
import { createShipmentFromBooking } from '../../lib/shipments.js';
import { knownOperator } from './users.js';
import { refreshPinSafely } from '../../lib/pinned.js';

const ACTIONS = { confirm: 'confirmed', reject: 'rejected', cancel: 'cancelled' };

export default async function handler(req, res) {
  const secret = req.query.secret ?? req.headers['x-admin-secret'];
  if (!config.adminSecret || secret !== config.adminSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') return list(req, res);
  if (req.method === 'POST') {
    // Retrying a shipment that failed to open is not a decision - the booking
    // is already confirmed - so it has its own path rather than a second
    // decision that the conflict guard would rightly refuse.
    if (req.body?.action === 'open_shipment') return openShipment(req, res);
    return decide(req, res);
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

async function list(req, res) {
  const status = req.query.status ?? 'pending_review';
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  // count: 'exact' asks Postgres how many rows MATCH, not how many were sent.
  // The console used to print the length of the page as the total, so a desk
  // with 60 requests waiting was told it had 50.
  const query = db()
    .from('bookings')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);

  // "all" still hides drafts: they are unconfirmed proposals, not requests.
  if (status === 'all') query.neq('status', 'draft');
  else query.eq('status', status);

  const { data, error, count: total } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Attach each booking's paperwork, with links an operator can actually open.
  const refs = data.map((b) => b.booking_ref);
  const { data: docs } = refs.length
    ? await db()
        .from('booking_documents')
        .select('booking_ref, doc_type, file_name, storage_path, vin, extraction_ok')
        .in('booking_ref', refs)
    : { data: [] };

  const bookings = [];
  for (const b of data) {
    const mine = (docs ?? []).filter((d) => d.booking_ref === b.booking_ref);
    bookings.push({
      ...b,
      age_hours: Math.round((Date.now() - new Date(b.created_at).getTime()) / 36e5),
      documents: await Promise.all(
        mine.map(async (d) => ({
          type: d.doc_type,
          file: d.file_name,
          readable: d.extraction_ok,
          url: d.storage_path ? await signedUrl(d.storage_path, 60 * 60 * 24) : null,
        })),
      ),
    });
  }

  res.status(200).json({
    status,
    count: bookings.length,
    total: total ?? bookings.length,
    offset,
    limit,
    has_more: offset + bookings.length < (total ?? 0),
    bookings,
  });
}

async function openShipment(req, res) {
  const { booking_ref: ref, operator = 'operations' } = req.body ?? {};
  if (!ref) return res.status(400).json({ error: 'booking_ref is required' });

  // Whose decision is this? A name nobody can check is not a signature.
  const who = await knownOperator(operator);
  if (!who.ok) return res.status(400).json({ error: who.error });

  const { data: booking, error } = await db().from('bookings').select('*').eq('booking_ref', ref).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!booking) return res.status(404).json({ error: `No booking ${ref}` });
  if (booking.status !== 'confirmed') {
    return res.status(409).json({ error: `${ref} is ${booking.status}; only a confirmed booking has a shipment` });
  }

  const shipment = await createShipmentFromBooking(booking, { operator });
  if (!shipment.ok) return res.status(500).json({ error: shipment.error });
  res.status(200).json({ ok: true, booking_ref: ref, shipment });
}

async function decide(req, res) {
  const { booking_ref: ref, action, note = '', operator = 'operations' } = req.body ?? {};
  const status = ACTIONS[action];

  if (!ref || !status) {
    return res.status(400).json({ error: `booking_ref and action are required. action is one of: ${Object.keys(ACTIONS).join(', ')}` });
  }

  // Whose decision is this? A name nobody can check is not a signature.
  const who = await knownOperator(operator);
  if (!who.ok) return res.status(400).json({ error: who.error });

  const { data: booking, error } = await db().from('bookings').select('*').eq('booking_ref', ref).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!booking) return res.status(404).json({ error: `No booking ${ref}` });

  // A positive guard, not a negative one: only a request actually awaiting
  // review may be decided. Listing the finished states missed `draft`, which
  // let an unsubmitted half-filled proposal be confirmed through the API.
  if (booking.status !== 'pending_review') {
    return res.status(409).json({
      error: `${ref} is ${booking.status}, not awaiting review`,
      decided_at: booking.confirmed_at,
      decided_by: booking.confirmed_by,
    });
  }

  // The status is repeated in the WHERE clause so the database, not the earlier
  // read, decides who wins. Two operators clicking Confirm together both passed
  // the check above and both updates succeeded, producing two shipments and two
  // contradictory messages to the customer. Now the second update matches no
  // row and is reported as the conflict it is.
  const { data: updatedRows, error: updErr } = await db()
    .from('bookings')
    .update({
      status,
      // Only overwrite the ops note when one was actually given, or a decision
      // made without a note erases what a colleague wrote earlier.
      ...(note ? { ops_notes: note } : {}),
      confirmed_at: new Date().toISOString(),
      confirmed_by: who.name ?? String(operator).slice(0, 80),
    })
    .eq('booking_ref', ref)
    .eq('status', 'pending_review')
    .select();
  if (updErr) return res.status(500).json({ error: updErr.message });

  if (!updatedRows?.length) {
    const { data: now } = await db().from('bookings').select('status, confirmed_by').eq('booking_ref', ref).maybeSingle();
    return res.status(409).json({
      error: `${ref} was decided by someone else a moment ago (now ${now?.status ?? 'unknown'})`,
      decided_by: now?.confirmed_by ?? null,
    });
  }
  const updated = updatedRows[0];

  // Roadmap step 4: confirming opens the shipment, so the customer can track
  // what they booked. Until this existed, a confirmed booking was invisible to
  // tracking by either its reference or its chassis number.
  let shipment = null;
  const warnings = [];
  if (status === 'confirmed') {
    shipment = await createShipmentFromBooking(updated, { operator });
    if (!shipment.ok) {
      // This used to be logged and nothing else: the operator saw a green
      // "confirmed, customer told" while the customer had a confirmed booking
      // they could not track, and the 409 guard blocked every retry. It is now
      // reported, and /api/admin/bookings?action=open_shipment can retry it.
      console.error('shipment creation failed:', shipment.error);
      warnings.push(
        `The booking is confirmed but the shipment could NOT be opened (${shipment.error}). ` +
        'The customer cannot track it yet. Use "Open shipment" to retry.',
      );
    }
  }

  // Telling the customer must never undo the decision, so failures are reported
  // rather than thrown - the booking stays decided either way.
  const told = status === 'cancelled'
    ? { telegram: false, email: false, errors: ['cancelled bookings are not announced'] }
    : await notifyBookingDecision(
        updated,
        status,
        // The shipment reference is what they will track with, so it goes in
        // the message that tells them the booking is confirmed.
        shipment?.ok && shipment.shipment_id
          ? `${note ? note + ' ' : ''}Track it with ${shipment.shipment_id} or your chassis number.`
          : note,
      );

  // A cancellation is not announced to the customer, so nothing else would have
  // refreshed the card at the top of their chat - and it would have gone on
  // showing a booking that no longer exists.
  if (updated.channel === 'telegram' && updated.chat_id) {
    await refreshPinSafely(updated.chat_id);
  }

  if (told.telegram || told.email) {
    await db().from('bookings').update({ customer_told_at: new Date().toISOString() }).eq('booking_ref', ref);
  }

  if (!told.telegram && !told.email && status !== 'cancelled') {
    warnings.push('The customer could NOT be told - contact them directly.');
  }

  res.status(200).json({
    ok: true,
    booking_ref: ref,
    status,
    shipment: shipment?.ok ? { shipment_id: shipment.shipment_id, existed: shipment.existed } : null,
    shipment_error: shipment && !shipment.ok ? shipment.error : null,
    warnings,
    customer_told: told,
  });
}
