/**
 * The fake database, with the two things the desk needs that the flow tests
 * never did:
 *
 *   - `ilike`, alone and inside `or(...)`, because the desk searches by name
 *     and phone the way PostgREST does;
 *   - a database that is BEHIND the code: a table or a column the migration
 *     has not created yet, answered with the error Postgres gives. The desk
 *     must work in that state, so the tests must be able to put it there.
 *
 * Built on top of fake-db.mjs rather than inside it, so the shared double the
 * other suites rely on is not changed by this one.
 */

import { createFakeDb } from './fake-db.mjs';

const toRegex = (pattern) => new RegExp(
  `^${String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`,
  'i',
);

const missingTable = (name) => ({
  data: null, count: null,
  error: { code: '42P01', message: `relation "public.${name}" does not exist` },
});

/** A query on a table that does not exist: every call chains, every result is the error. */
function absent(name) {
  const result = missingTable(name);
  const q = new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') return (ok, bad) => Promise.resolve(result).then(ok, bad);
      if (prop === 'maybeSingle' || prop === 'single') return () => Promise.resolve(result);
      return () => q;
    },
  });
  return q;
}

/**
 * @param {object} seed                    table -> rows
 * @param {{missingTables?: string[], missingColumns?: Record<string, string[]>}} schema
 */
export function createDeskDb(seed = {}, { missingTables = [], missingColumns = {} } = {}) {
  const base = createFakeDb(seed);
  const schema = { missingTables: new Set(missingTables), missingColumns };

  function patch(q, name) {
    const gone = new Set(schema.missingColumns[name] ?? []);
    let missing = null;
    const note = (cols) => { for (const c of cols) if (gone.has(c)) missing = missing ?? c; };

    for (const m of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'in']) {
      const orig = q[m].bind(q);
      q[m] = (col, ...rest) => { note([col]); return orig(col, ...rest); };
    }
    const select = q.select.bind(q);
    q.select = (cols, opts) => {
      if (typeof cols === 'string' && cols !== '*') note(cols.split(',').map((c) => c.trim()));
      return select(cols, opts);
    };
    const update = q.update.bind(q);
    q.update = (p) => { note(Object.keys(p ?? {})); return update(p); };
    const insert = q.insert.bind(q);
    q.insert = (rows) => { for (const r of [].concat(rows)) note(Object.keys(r ?? {})); return insert(rows); };

    q.ilike = (col, pattern) => {
      note([col]);
      const re = toRegex(pattern);
      q.filters.push((r) => re.test(String(r[col] ?? '')));
      return q;
    };
    q.or = (expression) => {
      const clauses = String(expression).split(',').map((part) => {
        const [col, op, ...rest] = part.split('.');
        const value = rest.join('.');
        note([col]);
        if (op === 'eq') return (r) => String(r[col] ?? ' ') === value;
        if (op === 'ilike') { const re = toRegex(value); return (r) => re.test(String(r[col] ?? '')); }
        throw new Error(`fake-db: or(${op}) is not implemented`);
      });
      q.filters.push((r) => clauses.some((c) => c(r)));
      return q;
    };

    const run = q.run.bind(q);
    q.run = async () => (missing
      ? { data: null, count: null, error: { code: '42703', message: `column ${name}.${missing} does not exist` } }
      : run());
    return q;
  }

  return {
    ...base,
    _schema: schema,
    from(name) {
      if (schema.missingTables.has(name)) return absent(name);
      return patch(base.from(name), name);
    },
  };
}

/**
 * The views the desk reads, built from the tables the way the migrations
 * define them, so a test seeds a booking once and both the inbox (which reads
 * booking_queue) and the case page (which reads bookings) see it.
 */
export function withViews(seed) {
  const docs = seed.booking_documents ?? [];
  const mrn = seed.mrn_requests ?? [];
  const ships = seed.shipments ?? [];
  const clients = seed.clients ?? [];
  const bookings = seed.bookings ?? [];

  const booking_queue = bookings.map((b) => {
    const mine = docs.filter((d) => d.booking_ref === b.booking_ref && !d.deleted_at);
    const m = mrn.filter((r) => r.booking_ref === b.booking_ref).at(-1);
    const s = ships.find((x) => x.booking_ref === b.booking_ref);
    return {
      ...b,
      documents_received: mine.filter((d) => ['received', 'pending_verification', 'verified'].includes(d.status ?? 'received')).length,
      documents_verified: mine.filter((d) => d.status === 'verified').length,
      documents_rejected: mine.filter((d) => ['rejected', 'replacement_requested'].includes(d.status)).length,
      mrn_request_ref: m?.request_ref ?? null,
      mrn_status: m?.status ?? null,
      shipment_id: s?.shipment_id ?? null,
      shipment_status: s?.status ?? null,
    };
  });

  const client_request_queue = (seed.support_tickets ?? []).map((t) => {
    const b = bookings.find((x) => x.booking_ref === t.booking_ref);
    const c = clients.find((x) => x.id === t.client_id);
    return {
      ...t,
      request_type: t.request_type ?? 'other',
      booking_vin: b?.vin ?? null,
      booking_status: b?.status ?? null,
      booking_client: b?.customer_name ?? null,
      client_display_name: c?.display_name ?? null,
      telegram_username: c?.telegram_username ?? null,
    };
  });

  return { ...seed, booking_queue, client_request_queue };
}
