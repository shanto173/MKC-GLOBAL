/**
 * The desk_activity triggers, in the fake database.
 *
 * supabase/migrations/20261009120000_desk_activity.sql moves a version
 * whenever a row it stands for is written - an area of the desk, or one
 * record (booking:<ref>, chat:<channel>:<chat id>, …). The fake has no
 * triggers, so this does the same after each write the fake runs - by the
 * same rules, and straight into the table's rows, so a test counting round
 * trips does not count the bumps (in Postgres they are part of the write,
 * not a call). Each key moves once per statement, as the trigger moves it
 * once per transaction.
 */

import { chatKey } from '../../public/desk/live.js';

const AREAS = ['bookings', 'customers', 'history', 'messages', 'outbox', 'problems', 'requests', 'shipments', 'team'];

const same = (a, b, ignore) => {
  const strip = (r) => Object.fromEntries(Object.entries(r ?? {}).filter(([k]) => k !== ignore));
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
};
const key = (prefix, value) => (value == null || value === '' ? null : `${prefix}:${value}`);

/** The keys one row's change moves, as desk_activity_touch() decides them. */
export function scopesFor(table, op, before, after, tables = {}) {
  const nu = after ?? null;
  const old = before ?? null;
  const r = nu ?? old ?? {};
  let keys;
  switch (table) {
    case 'bookings':
      if (op === 'update' && old?.status === 'draft' && nu?.status === 'draft') return [];
      keys = ['bookings', key('booking', r.booking_ref), chatKey(r.channel, r.chat_id)];
      break;
    case 'booking_documents':
      keys = ['bookings', key('booking', r.booking_ref)];
      break;
    case 'mrn_requests':
      keys = ['bookings', key('mrn', r.request_ref), key('booking', r.booking_ref)];
      break;
    case 'support_tickets':
      keys = ['requests', key('request', r.ticket_ref), chatKey(r.channel, r.chat_id)];
      break;
    case 'notification_outbox':
      if (op === 'update' && old?.status === 'sent' && nu?.status === 'sent') return [];
      keys = ['outbox', { booking: key('booking', r.entity_id), support_ticket: key('request', r.entity_id), shipment: key('shipment', r.entity_id) }[r.entity_type] ?? null];
      break;
    case 'chat_messages':
      keys = ['messages', chatKey(r.channel, r.chat_id), ...(nu?.status === 'failed' || old?.status === 'failed' ? ['problems'] : [])];
      break;
    case 'conversation_sessions':
      keys = [chatKey(r.channel, r.chat_id)];
      break;
    case 'audit_logs': {
      keys = ['history', ...(r.entity_type === 'problem' ? ['problems'] : [])];
      const bookingOf = (fromTable, match) => r.metadata?.booking_ref ?? (tables[fromTable] ?? []).find(match)?.booking_ref ?? null;
      if (r.entity_type === 'booking') keys.push(key('booking', r.entity_id));
      else if (r.entity_type === 'booking_document') keys.push(key('booking', bookingOf('booking_documents', (d) => String(d.id) === String(r.entity_id))));
      else if (r.entity_type === 'mrn_request') keys.push(key('mrn', r.entity_id), key('booking', bookingOf('mrn_requests', (m) => m.request_ref === r.entity_id)));
      else if (r.entity_type === 'support_ticket') keys.push(key('request', r.entity_id));
      else if (r.entity_type === 'shipment') keys.push(key('shipment', r.entity_id));
      break;
    }
    case 'internal_notes':
      keys = ['history', r.booking_ref ? key('booking', r.booking_ref)
        : r.entity_type === 'support_ticket' ? key('request', r.entity_id)
          : r.entity_type === 'mrn_request' ? key('mrn', r.entity_id) : null];
      break;
    case 'clients':
      if (op === 'update' && same(old, nu, 'updated_at')) return [];
      keys = ['customers', r.whatsapp_id ? chatKey('whatsapp', `wa:${r.whatsapp_id}`) : null, r.telegram_chat_id != null ? chatKey('telegram', String(r.telegram_chat_id)) : null];
      break;
    case 'shipments':
      keys = ['shipments', key('shipment', r.shipment_id), key('booking', r.booking_ref)];
      break;
    case 'shipment_events':
      keys = ['shipments', key('shipment', r.shipment_id)];
      break;
    case 'ops_users':
      if (op === 'update' && same(old, nu, 'last_seen')) return [];
      keys = ['team'];
      break;
    case 'bot_settings':
      keys = ['team'];
      break;
    default:
      return [];
  }
  return [...new Set(keys.filter(Boolean))];
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
