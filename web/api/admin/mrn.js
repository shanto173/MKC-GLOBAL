/**
 * MRN applications MKY is making on a client's behalf.
 *
 *   GET  /api/admin/mrn?secret=...&status=submitted
 *   POST /api/admin/mrn?secret=...  { request_ref, action, operator, ... }
 *
 * actions:
 *   review        take it into review
 *   need_info     ask the client for something  { requested }
 *   issue         record the MRN                { mrn_number }
 *   reject        decline it                    { note }
 *
 * `issue` is the one that matters: it writes the number onto the request AND
 * onto the booking, and tells the client. The number is whatever the operator
 * types - it is never derived, generated or guessed here, because an MRN is a
 * customs identifier and a wrong one gets a declaration rejected.
 */

import { config } from '../../lib/config.js';
import { db } from '../../lib/supabase.js';
import { knownOperator } from './users.js';
import { enqueue, drain } from '../../lib/outbox.js';
import { completeTask } from '../../lib/operations.js';
import { audit } from '../../lib/audit.js';

export default async function handler(req, res) {
  const secret = req.query.secret ?? req.headers['x-admin-secret'];
  if (!config.adminSecret || secret !== config.adminSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') return list(req, res);
  if (req.method === 'POST') return act(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function list(req, res) {
  const status = req.query.status ?? 'open';
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  const query = db()
    .from('mrn_requests')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: true })
    .limit(limit);

  if (status === 'open') query.in('status', ['draft', 'submitted', 'under_review', 'missing_information']);
  else if (status !== 'all') query.eq('status', status);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.status(200).json({ status, count: data?.length ?? 0, total: count ?? 0, requests: data ?? [] });
}

async function act(req, res) {
  const { request_ref: ref, action, operator = 'operations' } = req.body ?? {};
  if (!ref || !action) return res.status(400).json({ error: 'request_ref and action are required' });

  const who = await knownOperator(operator);
  if (!who.ok) return res.status(400).json({ error: who.error });

  const { data: request, error } = await db()
    .from('mrn_requests').select('*').eq('request_ref', ref).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!request) return res.status(404).json({ error: `No MRN request ${ref}` });

  const FINISHED = ['issued', 'rejected', 'cancelled'];
  if (FINISHED.includes(request.status)) {
    return res.status(409).json({ error: `${ref} is already ${request.status}` });
  }

  const patch = { updated_at: new Date().toISOString() };
  let queued = null;

  switch (action) {
    case 'review':
      patch.status = 'under_review';
      break;

    case 'need_info': {
      const requested = String(req.body?.requested ?? '').trim();
      if (!requested) return res.status(400).json({ error: 'requested is required for need_info' });
      patch.status = 'missing_information';
      patch.missing_information = requested.split('\n').map((l) => l.trim()).filter(Boolean);
      patch.operations_notes = requested;
      queued = {
        eventType: 'missing_information_requested',
        payload: { booking_ref: request.booking_ref, requested },
        key: `mrn_need_info:${ref}:${Date.now().toString(36)}`,
      };
      break;
    }

    case 'issue': {
      const number = String(req.body?.mrn_number ?? '').trim();
      if (!number) return res.status(400).json({ error: 'mrn_number is required for issue' });
      patch.status = 'issued';
      patch.mrn_number = number;
      patch.issued_at = new Date().toISOString();
      queued = {
        eventType: 'mrn_issued',
        payload: { mrn_number: number, booking_ref: request.booking_ref },
        key: `mrn_issued:${ref}`,
      };
      break;
    }

    case 'reject':
      patch.status = 'rejected';
      patch.operations_notes = String(req.body?.note ?? '').trim() || null;
      break;

    default:
      return res.status(400).json({ error: 'action is one of: review, need_info, issue, reject' });
  }

  // The status this row must still hold, so two operators issuing at once
  // produce one winner rather than two different MRNs on one booking.
  const { data: updated, error: updErr } = await db()
    .from('mrn_requests')
    .update(patch)
    .eq('request_ref', ref)
    .not('status', 'in', `(${FINISHED.map((s) => `"${s}"`).join(',')})`)
    .select();
  if (updErr) return res.status(500).json({ error: updErr.message });
  if (!updated?.length) {
    return res.status(409).json({ error: `${ref} was decided by someone else a moment ago` });
  }

  // The number belongs on the booking too - that is where the rest of the
  // system reads it from.
  if (action === 'issue' && request.booking_ref) {
    await db().from('bookings')
      .update({ mrn_number: patch.mrn_number })
      .eq('booking_ref', request.booking_ref);
  }

  if (['issued', 'rejected'].includes(patch.status)) {
    await completeTask(`mrn:${ref}`, { operator: who.name ?? String(operator) }).catch(() => null);
    await db().from('operations_tasks')
      .update({ status: 'done', completed_at: new Date().toISOString(), completed_by: who.name ?? String(operator) })
      .eq('mrn_request_id', request.id)
      .in('status', ['open', 'in_progress']);
  }

  if (queued && request.chat_id) {
    await enqueue({
      chatId: request.chat_id,
      clientId: request.client_id ?? null,
      eventType: queued.eventType,
      entityType: 'mrn_request',
      entityId: ref,
      idempotencyKey: queued.key,
      payload: queued.payload,
    });
    await drain({ limit: 5 }).catch(() => null);
  }

  await audit({
    actor_type: 'operator',
    actor_id: who.name ?? String(operator),
    action: `mrn_${action}`,
    entity_type: 'mrn_request',
    entity_id: ref,
    metadata: { booking_ref: request.booking_ref, status: patch.status },
  });

  res.status(200).json({ ok: true, request: updated[0] });
}
