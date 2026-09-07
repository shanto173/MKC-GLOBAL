/**
 * Who is on the operations desk.
 *
 *   GET  /api/admin/users     the people who may decide bookings
 *   POST /api/admin/users     { name, role } register, or reactivate, one
 *   POST /api/admin/users     { name, active: false } retire one
 *
 * The console used to take whatever name was typed into the sign-in box and
 * write it onto the booking as the decision-maker, so "confirmed_by" was worth
 * nothing: any spelling, any name, no list to check it against. Names now come
 * from ops_users, and a decision by a name that is not on that list is refused.
 *
 * This is accountability, not authentication - everyone here already holds the
 * admin secret. It makes decisions attributable to a known, spelled-one-way
 * person, and lets somebody who has left be switched off.
 */

import { config } from '../../lib/config.js';
import { db } from '../../lib/supabase.js';

export default async function handler(req, res) {
  const secret = req.query.secret ?? req.headers['x-admin-secret'];
  if (!config.adminSecret || secret !== config.adminSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
    const { data, error } = await db()
      .from('ops_users')
      .select('name, role, active')
      .order('name');
    if (error) return res.status(500).json({ error: error.message });
    const users = data ?? [];
    return res.status(200).json({
      count: users.length,
      users,
      // An empty desk has to be able to sign its first person in.
      bootstrap: users.filter((u) => u.active).length === 0,
    });
  }

  if (req.method === 'POST') {
    const name = String(req.body?.name ?? '').trim().slice(0, 80);
    const role = req.body?.role === 'supervisor' ? 'supervisor' : 'operator';
    const active = req.body?.active !== false;
    if (name.length < 2) return res.status(400).json({ error: 'A name of at least two characters is required' });

    const { data, error } = await db()
      .from('ops_users')
      .upsert({ name, role, active }, { onConflict: 'name' })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, user: data });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

/**
 * Is this a name the desk knows? Used by the endpoints that record who decided
 * something. An empty table accepts anybody, so a fresh install is not locked
 * out of its own console.
 */
export async function knownOperator(name) {
  const clean = String(name ?? '').trim();
  if (!clean) return { ok: false, error: 'No operator name was given.' };

  const { data, error } = await db().from('ops_users').select('name, active');
  if (error) return { ok: true, unchecked: true };   // never block work on a read failure
  const users = data ?? [];
  if (users.filter((u) => u.active).length === 0) return { ok: true, bootstrap: true };

  const match = users.find((u) => u.name.toLowerCase() === clean.toLowerCase());
  if (!match) return { ok: false, error: `"${clean}" is not on the operations desk. Add the name first.` };
  if (!match.active) return { ok: false, error: `"${match.name}" is no longer active.` };
  return { ok: true, name: match.name };
}
