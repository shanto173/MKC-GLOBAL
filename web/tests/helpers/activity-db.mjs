/**
 * The desk_activity triggers, in the fake database.
 *
 * supabase/migrations/20261009120000_desk_activity.sql moves a version
 * whenever a row it stands for is written - an area of the desk, or one
 * record (booking:<ref>, chat:<channel>:<chat id>, …). The fake has no
 * triggers, so this does the same after each write the fake runs - by the
 * same rules (desk_activity_keys, desk_activity_touch), and straight into the
 * table's rows, so a test counting round trips does not count the bumps (in
 * Postgres they are part of the write, not a call). Each key moves once per
 * statement, as the trigger moves it once per transaction.
 *
 * tests/desk-activity-sql.test.mjs runs the real trigger on a real Postgres
 * and holds these rules to it.
 */

import { chatKey } from '../../public/desk/live.js';

const AREAS = ['bookings', 'customers', 'history', 'messages', 'outbox', 'problems', 'requests', 'shipments', 'team'];

const same = (a, b, ignore) => {
  const strip = (r) => Object.fromEntries(Object.entries(r ?? {}).filter(([k]) => k !== ignore));
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
};
const key = (prefix, value) => (value == null || value === '' ? null : `${prefix}:${value}`);

/** The keys one row stands for, as desk_activity_keys() works them out. */
export function keysFor(table, r, tables = {}) {
  if (!r) return [];
  switch (table) {
    case 'bookings':
      return ['bookings', key('booking', r.booking_ref), chatKey(r.channel, r.chat_id)];
    case 'booking_documents':
      return ['bookings', key('booking', r.booking_ref)];
    case 'mrn_requests':
      return ['bookings', key('mrn', r.request_ref), key('booking', r.booking_ref)];
    case 'support_tickets':
      return ['requests', key('request', r.ticket_ref), chatKey(r.channel, r.chat_id)];
    case 'notification_outbox':
      return ['outbox', { booking: key('booking', r.entity_id), support_ticket: key('request', r.entity_id), shipment: key('shipment', r.entity_id) }[r.entity_type] ?? null];
    case 'chat_messages':
      return ['messages', chatKey(r.channel, r.chat_id), r.status === 'failed' ? 'problems' : null];
    case 'conversation_sessions':
      return [chatKey(r.channel, r.chat_id)];
    case 'audit_logs': {
      const keys = ['history'];
      const id = String(r.entity_id ?? '');
      if (r.entity_type === 'problem') {
        keys.push('problems');
        if (id.startsWith('chat:')) keys.push(id);
        else if (/^message:\d{1,18}$/.test(id)) {
          const m = (tables.chat_messages ?? []).find((x) => String(x.id) === id.slice(8));
          keys.push(m ? chatKey(m.channel, m.chat_id) : null);
        }
      } else if (r.entity_type === 'booking') keys.push(key('booking', id));
      else if (r.entity_type === 'booking_document') {
        const ref = r.metadata?.booking_ref ?? (/^\d{1,18}$/.test(id) ? (tables.booking_documents ?? []).find((d) => String(d.id) === id)?.booking_ref : null);
        keys.push(key('booking', ref));
      } else if (r.entity_type === 'mrn_request') {
        const ref = r.metadata?.booking_ref ?? (tables.mrn_requests ?? []).find((m) => m.request_ref === id)?.booking_ref;
        keys.push(key('mrn', id), key('booking', ref));
      } else if (r.entity_type === 'support_ticket') keys.push(key('request', id));
      else if (r.entity_type === 'shipment') keys.push(key('shipment', id));
      return keys;
    }
    case 'internal_notes':
      return ['history', r.booking_ref ? key('booking', r.booking_ref)
        : r.entity_type === 'support_ticket' ? key('request', r.entity_id)
          : r.entity_type === 'mrn_request' ? key('mrn', r.entity_id) : null];
    case 'clients':
      return ['customers', r.whatsapp_id ? chatKey('whatsapp', `wa:${r.whatsapp_id}`) : null, r.telegram_chat_id != null ? chatKey('telegram', String(r.telegram_chat_id)) : null];
    case 'shipments':
      return ['shipments', key('shipment', r.shipment_id), key('booking', r.booking_ref)];
    case 'shipment_events':
      return ['shipments', key('shipment', r.shipment_id)];
    case 'ops_users':
    case 'bot_settings':
      return ['team'];
    default:
      return [];
  }
}

/** The keys one row's change moves, as desk_activity_touch() decides them. */
export function scopesFor(table, op, before, after, tables = {}) {
  if (op === 'update') {
    if (table === 'bookings' && before?.status === 'draft' && after?.status === 'draft') return [];
    if (table === 'notification_outbox' && before?.status === 'sent' && after?.status === 'sent') return [];
    if (table === 'clients' && same(before, after, 'updated_at')) return [];
    if (table === 'ops_users' && same(before, after, 'last_seen')) return [];
  }
  // What the row stood for, and what it stands for now.
  const keys = [...keysFor(table, after, tables), ...keysFor(table, before, tables)];
  return [...new Set(keys.filter(Boolean))].sort();
}

/**
 * Seeds desk_activity and moves it on every write, as the triggers would.
 * Returns { versions(), bump(key) } for assertions and hand-made changes.
 */
export function withActivity(db) {
  const rows = (db._tables.desk_activity ??= []);
  if (!rows.length) for (const scope of AREAS) rows.push({ scope, version: 0, changed_at: new Date().toISOString() });
  const bump = (scope) => {
    let row = rows.find((r) => r.scope === scope);
    if (!row) { row = { scope, version: 0 }; rows.push(row); }
    row.version += 1;
    row.changed_at = new Date().toISOString();
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
      const add = (keys) => { for (const k of keys) changed.add(k); };
      if (q.op === 'update') {
        for (const [live, old] of before ?? []) add(scopesFor(name, 'update', old, live, db._tables));
      } else if (q.op === 'delete') {
        for (const old of before?.values() ?? []) add(scopesFor(name, 'delete', old, null, db._tables));
      } else {
        const made = Array.isArray(result?.data) ? result.data : result?.data ? [result.data] : [];
        for (const r of made) add(scopesFor(name, q.op === 'upsert' ? 'upsert' : 'insert', null, r, db._tables));
      }
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
