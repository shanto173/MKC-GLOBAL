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

/**
 * PostgREST's logic trees, as `or()` receives them: `a.eq.1,b.in.(x,y),and(c.gte.2,d.is.null)`.
 * Split at the top level only - a comma inside parentheses or quotes is part
 * of a value or of a nested group.
 */
function splitTop(text) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '(') depth++;
    else if (!quoted && ch === ')') depth--;
    if (!quoted && depth === 0 && ch === ',') { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const unquote = (v) => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

/** One condition of a logic tree, as a predicate over a row. */
function condition(part, note) {
  const group = /^(and|or)\((.*)\)$/s.exec(part);
  if (group) {
    const inner = splitTop(group[2]).map((p) => condition(p, note));
    return group[1] === 'and' ? (r) => inner.every((c) => c(r)) : (r) => inner.some((c) => c(r));
  }
  const first = part.indexOf('.');
  const col = part.slice(0, first);
  let rest = part.slice(first + 1);
  let negate = false;
  if (rest.startsWith('not.')) { negate = true; rest = rest.slice(4); }
  const dot = rest.indexOf('.');
  const op = rest.slice(0, dot);
  const raw = rest.slice(dot + 1);
  const value = unquote(raw);
  note([col]);
  let test;
  switch (op) {
    case 'eq': test = (r) => String(r[col] ?? ' ') === value; break;
    case 'neq': test = (r) => String(r[col] ?? '') !== value; break;
    case 'gt': test = (r) => r[col] != null && r[col] > value; break;
    case 'gte': test = (r) => r[col] != null && r[col] >= value; break;
    case 'lt': test = (r) => r[col] != null && r[col] < value; break;
    case 'lte': test = (r) => r[col] != null && r[col] <= value; break;
    case 'ilike': { const re = toRegex(value); test = (r) => re.test(String(r[col] ?? '')); break; }
    case 'is': test = value === 'null' ? (r) => r[col] == null : (r) => String(r[col]) === value; break;
    case 'in': {
      const set = new Set(splitTop(raw.replace(/^\(|\)$/g, '')).map(unquote));
      test = (r) => r[col] != null && set.has(String(r[col]));
      break;
    }
    default: throw new Error(`fake-db: or(${op}) is not implemented`);
  }
  return negate ? (r) => !test(r) : test;
}

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
      const clauses = splitTop(String(expression)).map((part) => condition(part, note));
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
