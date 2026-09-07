/**
 * Support tickets for the operations desk.
 *
 *   GET  /api/admin/tickets?status=open|resolved|all     newest first
 *   POST /api/admin/tickets   { ticket_ref, action: 'resolve'|'reopen', note, operator }
 *
 * A customer who asks for a person gives us what the problem is and a number to
 * call them on. The desk reads that here, calls them, and marks the ticket
 * resolved - which tells the customer in the chat they raised it from.
 */

import { config } from '../../lib/config.js';
import { db } from '../../lib/supabase.js';
import { notifyTicketResolved } from '../../lib/notify.js';
import { knownOperator } from './users.js';

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
  const status = req.query.status ?? 'open';
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const query = db()
    .from('support_tickets')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (status !== 'all') query.eq('status', status);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const tickets = (data ?? []).map((t) => ({
    ...t,
    age_hours: Math.round((Date.now() - new Date(t.created_at).getTime()) / 36e5),
  }));

  res.status(200).json({
    status,
    count: tickets.length,
    total: count ?? tickets.length,
    offset,
    limit,
    has_more: offset + tickets.length < (count ?? 0),
    tickets,
  });
}

async function decide(req, res) {
  const { ticket_ref: ref, action, note = '', operator = 'operations' } = req.body ?? {};
  if (!ref || !['resolve', 'reopen'].includes(action)) {
    return res.status(400).json({ error: 'ticket_ref and action (resolve | reopen) are required' });
  }

  const who = await knownOperator(operator);
  if (!who.ok) return res.status(400).json({ error: who.error });

  const { data: ticket, error } = await db().from('support_tickets').select('*').eq('ticket_ref', ref).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!ticket) return res.status(404).json({ error: `No ticket ${ref}` });

  const status = action === 'resolve' ? 'resolved' : 'open';
  if (ticket.status === status) {
    return res.status(409).json({ error: `${ref} is already ${status}` });
  }

  // The resolution columns arrived in a later migration. Until it is applied
  // the status alone is written, so the desk is never blocked by a schema it
  // has not run yet - and once it is, the record is complete.
  const full = {
    status,
    resolved_at: status === 'resolved' ? new Date().toISOString() : null,
    resolved_by: status === 'resolved' ? (who.name ?? String(operator).slice(0, 80)) : null,
    ...(note ? { resolution_note: String(note).slice(0, 1000) } : {}),
  };
  let { error: updErr } = await db().from('support_tickets').update(full).eq('ticket_ref', ref);
  // Postgres says "column ... does not exist"; PostgREST, in front of it, says
  // "Could not find the '...' column ... in the schema cache". Either means the
  // migration has not been run yet.
  if (updErr && /column .* does not exist|could not find the '.*' column/i.test(updErr.message)) {
    ({ error: updErr } = await db().from('support_tickets').update({ status }).eq('ticket_ref', ref));
  }
  if (updErr) return res.status(500).json({ error: updErr.message });

  let told = null;
  if (status === 'resolved') {
    told = await notifyTicketResolved({ ...ticket, resolution_note: note }, { operator: who.name ?? operator });
    if (told.telegram) {
      await db().from('support_tickets').update({ customer_told_at: new Date().toISOString() }).eq('ticket_ref', ref)
        .then(() => {}, () => {});   // absent before the migration; not worth failing over
    }
  }

  res.status(200).json({ ok: true, ticket_ref: ref, status, customer_told: told });
}
