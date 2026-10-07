/**
 * Who is on the operations desk.
 *
 *   GET  /api/admin/users     the people who may decide bookings
 *   POST /api/admin/users     { operator, name, role } register, or reactivate, one
 *   POST /api/admin/users     { operator, name, active: false } retire one
 *
 * `operator` must be an active administrator - the same rule the desk's own
 * Settings page enforces - except on an empty desk, whose first person has
 * nobody to ask. Roles are the database's vocabulary (ops_agent, ops_supervisor,
 * admin, read_only); the old "operator" and "supervisor" are read as their
 * successors, because writing them as they were is refused by the role check.
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

/** What may be asked for, and what it is stored as. */
const ROLES = {
  ops_agent: 'ops_agent', operator: 'ops_agent', agent: 'ops_agent',
  ops_supervisor: 'ops_supervisor', supervisor: 'ops_supervisor',
  admin: 'admin', administrator: 'admin',
  read_only: 'read_only',
};

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
    const active = req.body?.active !== false;
    if (name.length < 2) return res.status(400).json({ error: 'A name of at least two characters is required' });

    const asked = req.body?.role == null ? null : ROLES[String(req.body.role).trim().toLowerCase()];
    if (req.body?.role != null && !asked) {
      return res.status(400).json({ error: `Unknown role "${req.body.role}". Use ops_agent, ops_supervisor, admin or read_only.` });
    }

    const { data: team, error: readErr } = await db().from('ops_users').select('name, role, active');
    if (readErr) return res.status(500).json({ error: readErr.message });
    const everyone = team ?? [];
    if (everyone.some((u) => u.active)) {
      const by = String(req.body?.operator ?? '').trim().toLowerCase();
      const admin = everyone.find((u) => u.active && u.role === 'admin' && u.name.toLowerCase() === by);
      if (!admin) return res.status(403).json({ error: 'Only an active administrator can change the team.' });
    }

    // A person being reactivated or retired keeps the role they had: an
    // upsert carrying a default role demoted an administrator who was only
    // being switched back on. A new person with no role given is an agent.
    const existing = everyone.find((u) => u.name.toLowerCase() === name.toLowerCase());
    const row = { name: existing?.name ?? name, active, ...(asked ? { role: asked } : existing ? {} : { role: 'ops_agent' }) };

    const { data, error } = await db()
      .from('ops_users')
      .upsert(row, { onConflict: 'name' })
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
