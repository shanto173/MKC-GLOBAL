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

const ACTIONS = { confirm: 'confirmed', reject: 'rejected', cancel: 'cancelled' };

export default async function handler(req, res) {
  const secret = req.query.secret ?? req.headers['x-admin-secret'];
  if (!config.adminSecret || secret !== config.adminSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') return list(req, res);
  if (req.method === 'POST') return decide(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function list(req, res) {
  const status = req.query.status ?? 'pending_review';
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  const query = db()
    .from('bookings')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(limit);

  // "all" still hides drafts: they are unconfirmed proposals, not requests.
  if (status === 'all') query.neq('status', 'draft');
  else query.eq('status', status);

  const { data, error } = await query;
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

  res.status(200).json({ status, count: bookings.length, bookings });
}

async function decide(req, res) {
  const { booking_ref: ref, action, note = '', operator = 'operations' } = req.body ?? {};
  const status = ACTIONS[action];

  if (!ref || !status) {
    return res.status(400).json({ error: `booking_ref and action are required. action is one of: ${Object.keys(ACTIONS).join(', ')}` });
  }

  const { data: booking, error } = await db().from('bookings').select('*').eq('booking_ref', ref).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!booking) return res.status(404).json({ error: `No booking ${ref}` });

  // Deciding twice would message the customer twice for one decision.
  if (['confirmed', 'rejected', 'cancelled'].includes(booking.status)) {
    return res.status(409).json({
      error: `${ref} is already ${booking.status}`,
      decided_at: booking.confirmed_at,
      decided_by: booking.confirmed_by,
    });
  }

  const { data: updated, error: updErr } = await db()
    .from('bookings')
    .update({
      status,
      ops_notes: note || null,
      confirmed_at: new Date().toISOString(),
      confirmed_by: String(operator).slice(0, 80),
    })
    .eq('booking_ref', ref)
    .select()
    .single();
  if (updErr) return res.status(500).json({ error: updErr.message });

  // Telling the customer must never undo the decision, so failures are reported
  // rather than thrown - the booking stays decided either way.
  const told = status === 'cancelled'
    ? { telegram: false, email: false, errors: ['cancelled bookings are not announced'] }
    : await notifyBookingDecision(updated, status, note);

  if (told.telegram || told.email) {
    await db().from('bookings').update({ customer_told_at: new Date().toISOString() }).eq('booking_ref', ref);
  }

  res.status(200).json({ ok: true, booking_ref: ref, status, customer_told: told });
}
