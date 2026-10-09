/**
 * Counts the round trips a piece of code makes to the database.
 *
 * Wraps any of the fake databases (fake-db.mjs, desk-db.mjs, the WhatsApp
 * helpers' variants) and records every call that would have been one HTTP
 * request to PostgREST: a query when it runs, an rpc, a storage call. Each
 * record says the table, what kind of call it was and the filters it carried,
 * so a test can say "a refresh with nothing new is one cheap call" and a person
 * reading a failure can see which call came back.
 *
 * The count is the thing that matters on a small Supabase instance. Each call
 * is a transaction on PostgREST's pool (BEGIN, four set_config()s, the
 * statement, COMMIT); the statements themselves take a tenth of a millisecond
 * on tables this size. Fewer calls is less load, and less waiting behind the
 * desk for the bot's writes.
 */

/** Wraps `db` in place and returns the recorder. */
export function countCalls(db) {
  const rec = {
    calls: [],
    /** Forgets what was recorded so far. */
    reset() { rec.calls.length = 0; },
    get count() { return rec.calls.length; },
    /** How many calls touched each table, e.g. { bookings: 2, 'rpc:claim': 1 }. */
    byTable() {
      const out = {};
      for (const c of rec.calls) out[c.table] = (out[c.table] ?? 0) + 1;
      return out;
    },
    /** One line per call, for an assertion message. */
    lines() {
      return rec.calls.map((c) => `${c.op} ${c.table}${c.where.length ? ` [${c.where.join(' ')}]` : ''}`);
    },
  };

  const from = db.from.bind(db);
  db.from = (name) => {
    const q = from(name);
    const where = [];
    let op = 'select';
    const wrap = (method, describe) => {
      const original = q[method];
      if (typeof original !== 'function') return;
      q[method] = (...args) => {
        const d = describe(...args);
        if (d) where.push(d);
        return original.apply(q, args);
      };
    };
    for (const m of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'ilike']) wrap(m, (col) => `${col}:${m}`);
    wrap('in', (col, values) => `${col}:in(${(values ?? []).length})`);
    wrap('or', () => 'or(…)');
    wrap('select', (cols, opts) => (opts?.head ? 'count' : null));
    for (const m of ['insert', 'update', 'upsert', 'delete']) wrap(m, () => { op = m; return null; });

    const run = q.run?.bind(q);
    if (run) {
      q.run = async () => {
        rec.calls.push({ table: name, op, where });
        return run();
      };
    }
    return q;
  };

  if (typeof db.rpc === 'function') {
    const rpc = db.rpc.bind(db);
    db.rpc = async (name, args) => {
      rec.calls.push({ table: `rpc:${name}`, op: 'rpc', where: [] });
      return rpc(name, args);
    };
  }

  if (db.storage?.from) {
    const storageFrom = db.storage.from.bind(db.storage);
    db.storage = {
      ...db.storage,
      from(bucket) {
        const b = storageFrom(bucket);
        const out = {};
        for (const [k, fn] of Object.entries(b)) {
          out[k] = typeof fn === 'function'
            ? async (...args) => { rec.calls.push({ table: `storage:${bucket}`, op: k, where: [] }); return fn.apply(b, args); }
            : fn;
        }
        return out;
      },
    };
  }
  return rec;
}
