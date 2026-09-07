/**
 * Who has been dealing with us, and what they have in flight.
 *
 *   GET /api/admin/customers?secret=...        everyone who has booked
 *   GET /api/admin/customers?secret=...&q=...  search by name, contact or chassis
 *
 * Built from bookings and shipments rather than a customers table, because a
 * customer only exists here once they have actually asked for something.
 */

import { config } from '../../lib/config.js';
import { db } from '../../lib/supabase.js';

export default async function handler(req, res) {
  const secret = req.query.secret ?? req.headers['x-admin-secret'];
  if (!config.adminSecret || secret !== config.adminSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const q = (req.query.q ?? '').trim().toLowerCase();

  const [{ data: bookings, error: bErr }, { data: shipments, error: sErr }] = await Promise.all([
    db().from('bookings')
      .select('booking_ref, status, customer_name, customer_contact, company, chat_id, channel, vin, make, model, origin_port, destination_port, created_at')
      .neq('status', 'draft')
      .order('created_at', { ascending: false })
      .limit(500),
    db().from('shipments')
      .select('shipment_id, booking_ref, status, customer_name, customer_email, customer_phone, vin, make, origin_port, destination_port, eta, delivery_status')
      .order('updated_at', { ascending: false })
      .limit(500),
  ]);
  if (bErr) return res.status(500).json({ error: bErr.message });
  if (sErr) return res.status(500).json({ error: sErr.message });

  // One person may appear under several spellings; the contact is the stable
  // identity, falling back to the chat they wrote from.
  const people = new Map();
  const keyFor = (name, contact, chatId) =>
    (contact || chatId || name || 'unknown').toString().trim().toLowerCase();

  for (const b of bookings ?? []) {
    const key = keyFor(b.customer_name, b.customer_contact, b.chat_id);
    if (!people.has(key)) {
      people.set(key, {
        key,
        name: b.customer_name,
        contact: b.customer_contact,
        company: b.company ?? null,
        channel: b.channel,
        chat_id: b.chat_id,
        first_seen: b.created_at,
        last_seen: b.created_at,
        bookings: [],
        shipments: [],
      });
    }
    const p = people.get(key);
    p.company = p.company ?? b.company;
    if (b.created_at > p.last_seen) p.last_seen = b.created_at;
    if (b.created_at < p.first_seen) p.first_seen = b.created_at;
    p.bookings.push({
      booking_ref: b.booking_ref, status: b.status, vin: b.vin,
      vehicle: [b.make, b.model].filter(Boolean).join(' '),
      route: `${b.origin_port} → ${b.destination_port}`,
      created_at: b.created_at,
    });
  }

  const byRef = new Map((bookings ?? []).map((b) => [b.booking_ref, keyFor(b.customer_name, b.customer_contact, b.chat_id)]));
  for (const s of shipments ?? []) {
    const key = byRef.get(s.booking_ref) ?? keyFor(s.customer_name, s.customer_email ?? s.customer_phone, null);
    if (!people.has(key)) {
      people.set(key, {
        key, name: s.customer_name, contact: s.customer_email ?? s.customer_phone,
        company: null, channel: null, chat_id: null,
        first_seen: null, last_seen: null, bookings: [], shipments: [],
      });
    }
    people.get(key).shipments.push({
      shipment_id: s.shipment_id, status: s.status, vin: s.vin,
      vehicle: s.make, route: `${s.origin_port} → ${s.destination_port}`,
      eta: s.eta, delivered: s.delivery_status === 'Complete',
    });
  }

  let customers = [...people.values()].map((p) => ({
    ...p,
    booking_count: p.bookings.length,
    shipment_count: p.shipments.length,
    open_shipments: p.shipments.filter((s) => !s.delivered).length,
    awaiting_review: p.bookings.filter((b) => b.status === 'pending_review').length,
  }));

  if (q) {
    customers = customers.filter((c) =>
      [c.name, c.contact, c.company, ...c.bookings.map((b) => b.vin + b.booking_ref), ...c.shipments.map((s) => s.vin + s.shipment_id)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }

  customers.sort((a, b) => String(b.last_seen ?? '').localeCompare(String(a.last_seen ?? '')));

  res.status(200).json({ count: customers.length, customers });
}
