/**
 * Shipment management for Operations.
 *
 *   GET  /api/admin/shipments?secret=...            active shipments
 *   GET  /api/admin/shipments?secret=...&q=...      search by ref, VIN or customer
 *   POST /api/admin/shipments?secret=...            { shipment_id, ...changes, note, operator, tell_customer }
 *
 * Every change writes a tracking event as well as the new value, so a customer
 * asking "where is it" sees a history rather than a figure that silently moved.
 */

import { config } from '../../lib/config.js';
import { db } from '../../lib/supabase.js';
import { updateShipmentStatus, addEvent, SHIPMENT_STATUSES } from '../../lib/shipments.js';
import { sendMessage } from '../../lib/telegram.js';

export default async function handler(req, res) {
  const secret = req.query.secret ?? req.headers['x-admin-secret'];
  if (!config.adminSecret || secret !== config.adminSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method === 'GET') return list(req, res);
  if (req.method === 'POST') return update(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function list(req, res) {
  const q = (req.query.q ?? '').trim();
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  let rows;
  if (q) {
    const { data, error } = await db().rpc('find_shipments', { q, match_count: limit });
    if (error) return res.status(500).json({ error: error.message });
    rows = data ?? [];
  } else {
    const query = db().from('shipments').select('*').order('updated_at', { ascending: false }).limit(limit);
    // "Delivered" is the end of the road; hide it unless asked for explicitly.
    if (req.query.status === 'delivered') query.eq('delivery_status', 'Complete');
    else if (req.query.status && req.query.status !== 'all') query.eq('status', req.query.status);
    else if (!req.query.status) query.neq('delivery_status', 'Complete');
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    rows = data ?? [];
  }

  const ids = rows.map((s) => s.shipment_id);
  const { data: events } = ids.length
    ? await db()
        .from('shipment_events')
        .select('shipment_id, event_time, location, description')
        .in('shipment_id', ids)
        .order('event_time', { ascending: false })
    : { data: [] };

  const shipments = rows.map((s) => ({
    ...s,
    events: (events ?? []).filter((e) => e.shipment_id === s.shipment_id).slice(0, 8),
  }));

  res.status(200).json({ count: shipments.length, statuses: SHIPMENT_STATUSES, shipments });
}

async function update(req, res) {
  const {
    shipment_id: id,
    note = '',
    operator = 'operations',
    tell_customer: tellCustomer = false,
    event_only: eventOnly = false,
    ...changes
  } = req.body ?? {};

  if (!id) return res.status(400).json({ error: 'shipment_id is required' });

  // An event with no field change is a legitimate update - "held at customs for
  // inspection" is worth recording even though nothing else moved.
  const result = eventOnly
    ? { ok: await addEvent(id, { description: note || 'Updated', location: changes.location ?? null }), event_only: true }
    : await updateShipmentStatus(id, changes, { operator, note });

  if (!result.ok) return res.status(400).json({ error: result.error ?? 'update failed' });

  let told = null;
  if (tellCustomer) {
    const { data: s } = await db().from('shipments').select('*').eq('shipment_id', id).maybeSingle();
    if (s?.chat_id && s.channel === 'telegram' && config.telegram.token) {
      const arabic =
        `تحديث على شحنتك ${s.shipment_id}${s.vin ? ` (شاسيه ${s.vin})` : ''}:\n` +
        `${note || s.status}\n` +
        `${s.eta ? `الوصول المتوقع ${s.eta}` : ''}`.trim();
      const english =
        `Update on your shipment ${s.shipment_id}${s.vin ? ` (chassis ${s.vin})` : ''}:\n` +
        `${note || s.status}\n` +
        `${s.eta ? `Estimated arrival ${s.eta}` : ''}`.trim();
      try {
        await sendMessage(s.chat_id, `${arabic}\n|\n${english}`);
        told = { telegram: true };
      } catch (err) {
        told = { telegram: false, error: err.message };
        console.error('shipment update message failed:', err.message);
      }
    } else {
      told = { telegram: false, error: 'no Telegram chat on this shipment' };
    }
  }

  res.status(200).json({ ok: true, shipment_id: id, ...result, customer_told: told });
}
