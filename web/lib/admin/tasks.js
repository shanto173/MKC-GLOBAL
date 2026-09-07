/**
 * The Operations work queue.
 *
 *   GET  /api/admin/tasks?secret=...                  open work, oldest first
 *   GET  /api/admin/tasks?secret=...&status=done
 *   GET  /api/admin/tasks?secret=...&type=mrn_request
 *   POST /api/admin/tasks?secret=...  { task_ref, action, operator, notes }
 *
 * actions: claim | release | complete | cancel
 *
 * This is what makes the roadmap's "Operations receives the request" a real
 * step rather than a hope that somebody is reading a chat channel. A task is a
 * row: it can be counted, assigned, aged and reported on, and it exists whether
 * or not any notification reached anybody.
 */

import { config } from '../config.js';
import { db } from '../supabase.js';
import { knownOperator } from '../../api/admin/users.js';
import { audit } from '../audit.js';

const ACTIONS = new Set(['claim', 'release', 'complete', 'cancel']);

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
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const query = db()
    .from('operations_tasks')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);

  if (status === 'open') query.in('status', ['open', 'in_progress']);
  else if (status !== 'all') query.eq('status', status);
  if (req.query.type) query.eq('task_type', String(req.query.type));

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const tasks = (data ?? []).map((t) => ({
    ...t,
    age_hours: Math.round((Date.now() - new Date(t.created_at).getTime()) / 36e5),
  }));

  res.status(200).json({
    status,
    count: tasks.length,
    total: count ?? tasks.length,
    offset,
    limit,
    has_more: offset + tasks.length < (count ?? 0),
    tasks,
  });
}

async function act(req, res) {
  const { task_ref: ref, action, operator = 'operations', notes = null } = req.body ?? {};

  if (!ref || !ACTIONS.has(action)) {
    return res.status(400).json({ error: `task_ref and action are required. action is one of: ${[...ACTIONS].join(', ')}` });
  }

  const who = await knownOperator(operator);
  if (!who.ok) return res.status(400).json({ error: who.error });

  const patch = { updated_at: new Date().toISOString() };
  if (notes) patch.notes = notes;

  // The status a task must currently hold for this action to be legal. Stated
  // in the WHERE clause as well as checked here, so two operators clicking at
  // once produce one winner and one honest 409 rather than two silent successes.
  let from;
  switch (action) {
    case 'claim':
      patch.status = 'in_progress';
      patch.assigned_to = who.name ?? String(operator).slice(0, 80);
      from = ['open'];
      break;
    case 'release':
      patch.status = 'open';
      patch.assigned_to = null;
      from = ['in_progress'];
      break;
    case 'complete':
      patch.status = 'done';
      patch.completed_at = new Date().toISOString();
      patch.completed_by = who.name ?? String(operator).slice(0, 80);
      from = ['open', 'in_progress'];
      break;
    case 'cancel':
      patch.status = 'cancelled';
      patch.completed_at = new Date().toISOString();
      patch.completed_by = who.name ?? String(operator).slice(0, 80);
      from = ['open', 'in_progress'];
      break;
    default:
      return res.status(400).json({ error: 'unknown action' });
  }

  const { data, error } = await db()
    .from('operations_tasks')
    .update(patch)
    .eq('task_ref', ref)
    .in('status', from)
    .select();

  if (error) return res.status(500).json({ error: error.message });

  if (!data?.length) {
    const { data: now } = await db()
      .from('operations_tasks').select('status, assigned_to').eq('task_ref', ref).maybeSingle();
    if (!now) return res.status(404).json({ error: `No task ${ref}` });
    return res.status(409).json({
      error: `${ref} is ${now.status}, so it cannot be ${action}ed`,
      assigned_to: now.assigned_to,
    });
  }

  await audit({
    actor_type: 'operator',
    actor_id: who.name ?? String(operator),
    action: `task_${action}`,
    entity_type: 'operations_task',
    entity_id: ref,
  });

  res.status(200).json({ ok: true, task: data[0] });
}
