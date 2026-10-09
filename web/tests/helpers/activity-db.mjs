/**
 * The desk_activity triggers, in the fake database.
 *
 * supabase/migrations/20261009120000_desk_activity.sql bumps a scope's
 * version whenever a row in it is written. The fake has no triggers, so this
 * does the same after each write the fake runs - by the same rules, and
 * straight into the table's rows, so a test counting round trips does not
 * count the bumps (in Postgres they are part of the write, not a call).
 */

const SCOPES = ['bookings', 'customers', 'history', 'messages', 'outbox', 'problems', 'requests', 'shipments', 'team'];

const same = (a, b, ignore) => {
  const strip = (r) => Object.fromEntries(Object.entries(r ?? {}).filter(([k]) => k !== ignore));
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
};

/** The scopes one row's change bumps, as desk_activity_touch() decides them. */
export function scopesFor(table, op, before, after) {
  const nu = after ?? null;
  const old = before ?? null;
  switch (table) {
    case 'bookings':
      if (op === 'update' && old?.status === 'draft' && nu?.status === 'draft') return [];
      return ['bookings'];
    case 'booking_documents':
    case 'mrn_requests':
      return ['bookings'];
    case 'support_tickets':
      return ['requests'];
    case 'notification_outbox':
      if (op === 'update' && old?.status === 'sent' && nu?.status === 'sent') return [];
      return ['outbox'];
    case 'chat_messages':
      return nu?.status === 'failed' || old?.status === 'failed' ? ['messages', 'problems'] : ['messages'];
    case 'audit_logs':
      return nu?.entity_type === 'problem' || old?.entity_type === 'problem' ? ['history', 'problems'] : ['history'];
    case 'internal_notes':
      return ['history'];
    case 'clients':
      if (op === 'update' && same(old, nu, 'updated_at')) return [];
      return ['customers'];
    case 'shipments':
    case 'shipment_events':
      return ['shipments'];
    case 'ops_users':
      if (op === 'update' && same(old, nu, 'last_seen')) return [];
      return ['team'];
    case 'bot_settings':
      return ['team'];
    default:
      return [];
  }
}

/**
 * Seeds desk_activity and bumps it on every write, as the triggers would.
 * Returns { versions(), bump(scope) } for assertions and hand-made changes.
 */
export function withActivity(db) {
  const rows = (db._tables.desk_activity ??= []);
  if (!rows.length) for (const scope of SCOPES) rows.push({ scope, version: 0, changed_at: new Date().toISOString() });
  const bump = (scope) => {
    const row = rows.find((r) => r.scope === scope);
    if (row) { row.version += 1; row.changed_at = new Date().toISOString(); }
  };

  const from = db.from.bind(db);
  db.from = (name) => {
    const q = from(name);
    const run = q.run?.bind(q);
    if (!run || name === 'desk_activity') return q;
    q.run = async () => {
      const writing = ['insert', 'update', 'upsert', 'delete'].includes(q.op);
      // What the rows were before an update or a delete changed them.
      const before = writing && (q.op === 'update' || q.op === 'delete') && typeof q.matching === 'function'
        ? new Map(q.matching().map((r) => [r, { ...r }]))
        : null;
      const result = await run();
      if (!writing || result?.error) return result;
      const changed = new Set();
      if (q.op === 'update') {
        for (const [live, old] of before ?? []) for (const s of scopesFor(name, 'update', old, live)) changed.add(s);
      } else if (q.op === 'delete') {
        for (const old of before?.values() ?? []) for (const s of scopesFor(name, 'delete', old, null)) changed.add(s);
      } else {
        const made = Array.isArray(result?.data) ? result.data : result?.data ? [result.data] : [];
        for (const r of made) for (const s of scopesFor(name, q.op === 'upsert' ? 'upsert' : 'insert', null, r)) changed.add(s);
      }
      // In name order, as the trigger takes its rows.
      for (const s of [...changed].sort()) bump(s);
      return result;
    };
    return q;
  };

  return {
    versions: () => Object.fromEntries(rows.map((r) => [r.scope, r.version])),
    bump,
  };
}
