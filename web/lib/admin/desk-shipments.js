/**
 * Shipments on the desk: the list, a page at a time, and one shipment.
 *
 * The list read every column of the 300 most recently updated shipments and
 * then filtered them in JavaScript by what was typed in the box - so once
 * there were more than 300, a search for an older one found nothing, and
 * every refresh carried 300 whole rows. It now reads the columns it shows,
 * filters in the database, and pages by (updated_at, shipment_id): "Show
 * more" asks for the rows after the last one shown, which stays right while
 * rows above it are updated - an offset would skip or repeat them.
 */

import { db } from '../supabase.js';
import { channelOf } from '../channels.js';
import { SHIPMENT_MILESTONES, shipmentTone } from '../ops/workflow.js';
import { customerFor, deniedReason, shipmentVersion } from './desk-shared.js';
import { shortPort } from './desk-inbox.js';

export const PAGE = 100;
const MAX_PAGE = 300;

/** What the list shows of a shipment, and what its version is made of. */
const LIST_COLUMNS = 'shipment_id, booking_ref, customer_name, make, model, vin, origin_port, destination_port, status, eta, vessel, channel, updated_at';

/** Characters that mean something to PostgREST's or() syntax. */
const SYNTAX = /[%_,()*"\\]/;

/**
 * "2026-10-08T10:00:00.000Z~MKY-26014" - where the next page starts. Opaque
 * to the desk; checked here, so a hand-made cursor cannot inject a filter.
 */
const cursorOf = (row) => `${row.updated_at}~${row.shipment_id}`;
function parseCursor(raw) {
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2}))~([A-Za-z0-9_.-]{1,64})$/.exec(String(raw ?? ''));
  return m ? { at: m[1], id: m[2] } : null;
}

/** GET view=shipments&filter=active|delivered|all&q=&limit=&after= */
export async function shipmentList(req, res) {
  const filter = String(req.query.filter ?? 'active');
  const q = String(req.query.q ?? '').trim();
  const needle = q.toLowerCase();
  const limit = Math.min(Math.max(Number(req.query.limit) || PAGE, 1), MAX_PAGE);
  const after = parseCursor(req.query.after);

  let query = db().from('shipments').select(LIST_COLUMNS)
    .order('updated_at', { ascending: false }).order('shipment_id', { ascending: false });
  if (filter === 'delivered') query = query.eq('delivery_status', 'Complete');
  else if (filter !== 'all') query = query.neq('delivery_status', 'Complete');
  // Searched in the database when what was typed can be said there exactly;
  // otherwise - a % or a comma in it - over the page, as before.
  const pushed = q && !SYNTAX.test(q);
  const search = pushed ? ['shipment_id', 'booking_ref', 'customer_name', 'vin', 'vessel'].map((c) => `${c}.ilike.%${q}%`).join(',') : null;
  // Rows after the cursor in (updated_at, shipment_id) order: one write can
  // give many shipments the same updated_at, so the time alone is not a place.
  const rest = after ? `updated_at.lt."${after.at}",and(updated_at.eq."${after.at}",shipment_id.lt."${after.id}")` : null;
  if (search && rest) query = query.or(`and(or(${search}),or(${rest}))`);
  else if (search || rest) query = query.or(search ?? rest);
  query = query.limit(limit + 1);

  // How many each filter holds, whichever is shown, so the filter tabs can
  // carry their numbers. Counted, not fetched; not again for a next page.
  const [{ data, error }, all, delivered] = await Promise.all([
    query,
    after ? { count: null } : db().from('shipments').select('shipment_id', { count: 'exact', head: true }),
    after ? { count: null } : db().from('shipments').select('shipment_id', { count: 'exact', head: true }).eq('delivery_status', 'Complete'),
  ]);
  if (error) return res.status(500).json({ error: 'We could not load shipments.' });
  const counts = after || all.error || delivered.error ? null : {
    active: (all.count ?? 0) - (delivered.count ?? 0),
    delivered: delivered.count ?? 0,
    all: all.count ?? 0,
  };

  const page = (data ?? []).slice(0, limit);
  let rows = page.map((s) => ({
    shipment_id: s.shipment_id,
    booking_ref: s.booking_ref ?? null,
    customer_name: s.customer_name,
    vehicle: [s.make, s.model].filter(Boolean).join(' ') || null,
    vin: s.vin ?? null,
    route: `${shortPort(s.origin_port)} → ${shortPort(s.destination_port)}`,
    status: s.status,
    tone: shipmentTone(s.status),
    eta: s.eta ?? null,
    vessel: s.vessel ?? null,
    channel: s.channel ?? null,
    updated_at: s.updated_at,
    version: shipmentVersion(s),
  }));
  if (q && !pushed) {
    rows = rows.filter((s) => [s.shipment_id, s.booking_ref, s.customer_name, s.vin, s.vessel]
      .some((v) => String(v ?? '').toLowerCase().includes(needle)));
  }
  const next = (data ?? []).length > limit && page.length ? cursorOf(page.at(-1)) : null;
  res.status(200).json({ filter, total: rows.length, counts, milestones: SHIPMENT_MILESTONES, rows, next });
}

/** GET view=shipment&id= */
export async function shipmentDetail(req, res, who) {
  const id = String(req.query.id ?? '').trim();
  const { data: s, error } = await db().from('shipments').select('*').eq('shipment_id', id).maybeSingle();
  if (error) return res.status(500).json({ error: 'We could not load this shipment.' });
  if (!s) return res.status(404).json({ error: `There is no shipment ${id}.` });

  const [{ data: events }, { data: booking }] = await Promise.all([
    db().from('shipment_events').select('*').eq('shipment_id', id).order('event_time', { ascending: false }).limit(60),
    s.booking_ref ? db().from('bookings').select('booking_ref, client_id, chat_id, channel, customer_name, customer_contact')
      .eq('booking_ref', s.booking_ref).maybeSingle() : { data: null },
  ]);
  const customer = await customerFor({
    clientId: booking?.client_id, channel: s.channel ?? booking?.channel ?? channelOf(s.chat_id ?? booking?.chat_id), chatId: s.chat_id ?? booking?.chat_id,
    name: s.customer_name, contact: booking?.customer_contact,
  });

  res.status(200).json({
    shipment: { ...s, tone: shipmentTone(s.status) },
    version: shipmentVersion(s),
    events: (events ?? []).map((e) => ({ at: e.event_time, description: e.description, location: e.location ?? null, operator: e.operator ?? null })),
    milestones: SHIPMENT_MILESTONES,
    customer,
    can_update: who.can('booking'),
    update_reason: who.can('booking') ? null : deniedReason('booking', who.role),
  });
}
