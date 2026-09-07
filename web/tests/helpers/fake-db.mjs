/**
 * An in-memory stand-in for the Supabase client.
 *
 * The state machine is worth testing precisely because it must give the same
 * answer every time, and that is only checkable against a database whose
 * contents the test controls. This implements the slice of the PostgREST query
 * builder the application actually uses - and nothing more, so an unsupported
 * call is a loud error in a test rather than a silent wrong answer.
 *
 * It is deliberately strict about the things the real database is strict about:
 * unique constraints raise 23505 with the same shape the code branches on, and
 * a conditional update that matches no row returns an empty array rather than
 * pretending to have worked. Those two behaviours are what the concurrency
 * guards are built from, so a double that got them wrong would test nothing.
 */

/** Unique constraints, as the migrations define them. */
const UNIQUE = {
  bookings: [['booking_ref']],
  clients: [['telegram_user_id']],
  operations_tasks: [['task_ref'], ['idempotency_key']],
  mrn_requests: [['request_ref']],
  notification_outbox: [['idempotency_key']],
  support_tickets: [['ticket_ref']],
  processed_updates: [['update_id']],
  conversation_sessions: [['id']],
  conversations: [['id']],
  shipments: [['shipment_id']],
  bot_settings: [['key']],
  vehicles: [['vin']],
};

/** Generated columns the database maintains, recomputed on every write. */
const GENERATED = {
  bookings: { vin_norm: (r) => normVin(r.vin) },
  shipments: { vin_norm: (r) => normVin(r.vin) },
  vehicles: { vin_norm: (r) => normVin(r.vin) },
  booking_documents: { vin_norm: (r) => normVin(r.vin) },
  mrn_requests: { vin_norm: (r) => normVin(r.vin) },
};

/**
 * Column defaults the migrations declare.
 *
 * Without these a seeded row has `attempt_count: undefined` where Postgres
 * would give 0, and arithmetic on it silently becomes NaN - which is exactly
 * the class of bug a double is supposed to expose rather than hide.
 */
const DEFAULTS = {
  notification_outbox: { status: 'pending', attempt_count: 0 },
  operations_tasks: { status: 'open', priority: 'normal' },
  mrn_requests: { status: 'draft', missing_information: [], supplied_information: {} },
  booking_documents: { status: 'received', storage_bucket: 'booking-docs' },
  bookings: { status: 'draft' },
  support_tickets: { status: 'open' },
  clients: { is_blocked: false },
};

/**
 * CHECK constraints, as the migrations declare them.
 *
 * Worth carrying in the double because a constraint is exactly the kind of rule
 * that application code forgets: cancelling a draft that never got past the
 * chassis number violated bookings_complete_when_submitted, every test passed,
 * and it would have failed on the first real client who walked away.
 */
const CHECKS = {
  bookings: [
    {
      name: 'bookings_status_check',
      ok: (r) => r.status === undefined || [
        'draft', 'pending_review', 'under_review', 'needs_client_action',
        'confirmed', 'rejected', 'cancelled', 'expired',
      ].includes(r.status),
    },
    {
      name: 'bookings_complete_when_submitted',
      ok: (r) => ['draft', 'cancelled', 'expired'].includes(r.status)
        || ['vin', 'make', 'customer_name', 'origin_port', 'destination_port']
             .every((c) => String(r[c] ?? '').trim() !== ''),
    },
    {
      name: 'bookings_mrn_choice_check',
      ok: (r) => r.mrn_choice == null || ['existing', 'mky_issue', 'unknown'].includes(r.mrn_choice),
    },
  ],
  booking_documents: [
    {
      name: 'booking_documents_status_check',
      ok: (r) => r.status === undefined
        || ['received', 'pending_verification', 'verified', 'rejected', 'replacement_requested'].includes(r.status),
    },
  ],
  notification_outbox: [
    {
      name: 'notification_outbox_status_check',
      ok: (r) => ['pending', 'sending', 'sent', 'failed', 'dead'].includes(r.status),
    },
  ],
  operations_tasks: [
    {
      name: 'operations_tasks_status_check',
      ok: (r) => ['open', 'in_progress', 'done', 'cancelled'].includes(r.status),
    },
  ],
  mrn_requests: [
    {
      name: 'mrn_requests_status_check',
      ok: (r) => ['draft', 'submitted', 'under_review', 'missing_information',
                  'approved', 'issued', 'rejected', 'cancelled'].includes(r.status),
    },
  ],
};

const checkViolation = (table, name) => ({
  code: '23514',
  message: `new row for relation "${table}" violates check constraint "${name}"`,
});

const normVin = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const uniqueViolation = (table, cols) => ({
  code: '23505',
  message: `duplicate key value violates unique constraint on ${table}(${cols.join(',')})`,
});

export function createFakeDb(seed = {}) {
  /** @type {Record<string, object[]>} */
  const tables = {};
  let nextId = 1;

  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = rows.map((r) => stamp(name, { ...r }));
  }

  function table(name) {
    if (!tables[name]) tables[name] = [];
    return tables[name];
  }

  function stamp(name, row) {
    const out = { ...(DEFAULTS[name] ?? {}), ...row };
    if (out.id === undefined && name !== 'processed_updates' && name !== 'bot_settings'
        && name !== 'conversations' && name !== 'conversation_sessions') {
      out.id = nextId++;
    }
    if (out.created_at === undefined) out.created_at = new Date().toISOString();
    for (const [col, fn] of Object.entries(GENERATED[name] ?? {})) out[col] = fn(out);
    return out;
  }

  /** Returns the first violated CHECK, or null. */
  function violated(name, row) {
    for (const check of CHECKS[name] ?? []) {
      if (!check.ok(row)) return check.name;
    }
    return null;
  }

  function clashes(name, row, ignore = null) {
    for (const cols of UNIQUE[name] ?? []) {
      const values = cols.map((c) => row[c]);
      if (values.some((v) => v === undefined || v === null)) continue;
      const hit = table(name).find(
        (r) => r !== ignore && cols.every((c, i) => r[c] === values[i]),
      );
      if (hit) return { hit, cols };
    }
    return null;
  }

  class Query {
    constructor(name) {
      this.name = name;
      this.filters = [];
      this.op = 'select';
      this.payload = null;
      this.modifiers = { order: null, limit: null, range: null };
      this.wantCount = false;
      this.rowMode = null;     // 'one' | 'maybe' | null
      this.returning = false;
      this.onConflict = null;
    }

    // -- shaping ------------------------------------------------------------
    select(_cols, opts) {
      if (this.op === 'select') this.returning = true;
      else this.returning = true;              // .insert().select()
      if (opts?.count) this.wantCount = true;
      return this;
    }

    insert(rows) { this.op = 'insert'; this.payload = rows; return this; }
    update(patch) { this.op = 'update'; this.payload = patch; return this; }
    delete() { this.op = 'delete'; return this; }
    upsert(rows, opts) {
      this.op = 'upsert';
      this.payload = rows;
      this.onConflict = opts?.onConflict ?? null;
      return this;
    }

    // -- filters ------------------------------------------------------------
    eq(col, value) { this.filters.push((r) => String(r[col] ?? '') === String(value)); return this; }
    neq(col, value) { this.filters.push((r) => String(r[col] ?? '') !== String(value)); return this; }
    gt(col, value) { this.filters.push((r) => r[col] > value); return this; }
    gte(col, value) { this.filters.push((r) => r[col] >= value); return this; }
    lt(col, value) { this.filters.push((r) => r[col] < value); return this; }
    lte(col, value) { this.filters.push((r) => r[col] <= value); return this; }
    is(col, value) {
      this.filters.push((r) => (value === null ? r[col] === null || r[col] === undefined : r[col] === value));
      return this;
    }
    in(col, values) {
      const set = new Set(values.map(String));
      this.filters.push((r) => set.has(String(r[col])));
      return this;
    }
    not(col, operator, value) {
      if (operator !== 'in') throw new Error(`fake-db: not(${operator}) is not implemented`);
      const set = new Set(parseList(value));
      this.filters.push((r) => !set.has(String(r[col])));
      return this;
    }
    /** Only the flat `col.eq.value,col2.eq.value2` form the application uses. */
    or(expression) {
      const clauses = String(expression).split(',').map((part) => {
        const [col, op, ...rest] = part.split('.');
        const value = rest.join('.');
        if (op !== 'eq') throw new Error(`fake-db: or(${op}) is not implemented`);
        return (r) => String(r[col] ?? ' ') === value;
      });
      this.filters.push((r) => clauses.some((c) => c(r)));
      return this;
    }

    order(col, opts) { this.modifiers.order = { col, asc: opts?.ascending !== false }; return this; }
    limit(n) { this.modifiers.limit = n; return this; }
    range(from, to) { this.modifiers.range = [from, to]; return this; }

    maybeSingle() { this.rowMode = 'maybe'; return this.run(); }
    /** PostgREST errors unless there is exactly one row. */
    single() { this.rowMode = 'one'; return this.run(); }
    then(resolve, reject) { return this.run().then(resolve, reject); }

    // -- execution ----------------------------------------------------------
    matching() {
      return table(this.name).filter((r) => this.filters.every((f) => f(r)));
    }

    async run() {
      try {
        return await this.execute();
      } catch (err) {
        return { data: null, error: { message: err.message }, count: null };
      }
    }

    async execute() {
      const name = this.name;

      if (this.op === 'insert') {
        const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
        const made = [];
        for (const raw of rows) {
          const row = stamp(name, { ...raw });
          const bad = violated(name, row);
          if (bad) return { data: null, error: checkViolation(name, bad), count: null };
          const clash = clashes(name, row);
          if (clash) return { data: null, error: uniqueViolation(name, clash.cols), count: null };
          table(name).push(row);
          made.push(row);
        }
        return this.finish(made);
      }

      if (this.op === 'upsert') {
        const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
        const made = [];
        for (const raw of rows) {
          const keys = this.onConflict
            ? this.onConflict.split(',').map((k) => k.trim())
            : (UNIQUE[name]?.[0] ?? ['id']);
          const existing = table(name).find((r) => keys.every((k) => r[k] === raw[k]));
          if (existing) {
            const merged = { ...existing, ...raw };
            for (const [col, fn] of Object.entries(GENERATED[name] ?? {})) merged[col] = fn(merged);
            const bad = violated(name, merged);
            if (bad) return { data: null, error: checkViolation(name, bad), count: null };
            Object.assign(existing, merged);
            made.push(existing);
          } else {
            const row = stamp(name, { ...raw });
            const bad = violated(name, row);
            if (bad) return { data: null, error: checkViolation(name, bad), count: null };
            const clash = clashes(name, row);
            if (clash) return { data: null, error: uniqueViolation(name, clash.cols), count: null };
            table(name).push(row);
            made.push(row);
          }
        }
        return this.finish(made);
      }

      if (this.op === 'update') {
        // The conditional-update pattern the concurrency guards rely on: when
        // the filters match nothing, NOTHING is changed and an empty array
        // comes back. Getting this wrong would make every race test pass
        // regardless of the code.
        const rows = this.matching();
        // Validated BEFORE anything is written, like a real transaction: a
        // constraint violation must leave every row exactly as it was.
        for (const row of rows) {
          const merged = { ...row, ...this.payload };
          for (const [col, fn] of Object.entries(GENERATED[name] ?? {})) merged[col] = fn(merged);
          const bad = violated(name, merged);
          if (bad) return { data: null, error: checkViolation(name, bad), count: null };
        }
        for (const row of rows) {
          Object.assign(row, this.payload);
          for (const [col, fn] of Object.entries(GENERATED[name] ?? {})) row[col] = fn(row);
        }
        return this.finish(rows);
      }

      if (this.op === 'delete') {
        const rows = this.matching();
        tables[name] = table(name).filter((r) => !rows.includes(r));
        return this.finish(rows);
      }

      // select
      let rows = this.matching();
      const total = rows.length;

      if (this.modifiers.order) {
        const { col, asc } = this.modifiers.order;
        rows = [...rows].sort((a, b) => {
          const x = a[col] ?? '';
          const y = b[col] ?? '';
          if (x === y) return 0;
          return (x > y ? 1 : -1) * (asc ? 1 : -1);
        });
      }
      if (this.modifiers.range) rows = rows.slice(this.modifiers.range[0], this.modifiers.range[1] + 1);
      if (this.modifiers.limit != null) rows = rows.slice(0, this.modifiers.limit);

      return this.finish(rows, total);
    }

    finish(rows, total = null) {
      const data = rows.map((r) => ({ ...r }));
      if (this.rowMode === 'maybe') {
        if (data.length > 1) return { data: null, error: null, count: total };
        return { data: data[0] ?? null, error: null, count: total };
      }
      if (this.rowMode === 'one') {
        if (data.length !== 1) {
          return { data: null, error: { message: 'expected exactly one row', code: 'PGRST116' }, count: total };
        }
        return { data: data[0], error: null, count: total };
      }
      return { data, error: null, count: this.wantCount ? (total ?? data.length) : null };
    }
  }

  const rpcHandlers = {
    /** Mirrors claim_telegram_update: the first caller wins, retries do not. */
    claim_telegram_update({ p_update_id, p_chat_id }) {
      const rows = table('processed_updates');
      const existing = rows.find((r) => String(r.update_id) === String(p_update_id));
      if (!existing) {
        rows.push({ update_id: p_update_id, chat_id: p_chat_id, status: 'processing', processed_at: new Date().toISOString() });
        return true;
      }
      if (existing.status === 'failed') {
        existing.status = 'processing';
        return true;
      }
      return false;
    },

    /** Mirrors submit_booking_request, including every refusal reason. */
    submit_booking_request({ p_booking_ref, p_chat_id, p_task_ref }) {
      const booking = table('bookings').find((b) => b.booking_ref === p_booking_ref);
      if (!booking) return { ok: false, reason: 'not_found' };
      if (String(booking.chat_id ?? '') !== String(p_chat_id)) return { ok: false, reason: 'not_yours' };
      if (booking.status !== 'draft') {
        return { ok: true, already: true, status: booking.status, booking_ref: booking.booking_ref };
      }

      const LIVE = ['pending_review', 'under_review', 'needs_client_action', 'confirmed'];
      const clash = table('bookings').find(
        (b) => b.vin_norm && b.vin_norm === booking.vin_norm
          && b.booking_ref !== booking.booking_ref && LIVE.includes(b.status),
      );
      if (clash) return { ok: false, reason: 'duplicate', booking_ref: clash.booking_ref };

      booking.status = 'pending_review';
      booking.client_confirmed_at = new Date().toISOString();
      booking.submitted_at = booking.client_confirmed_at;
      booking.current_step = 'BOOK_SUBMITTED';

      const key = `booking_submitted:${booking.booking_ref}`;
      const already = table('operations_tasks').find((t) => t.idempotency_key === key);
      if (!already) {
        table('operations_tasks').push(stamp('operations_tasks', {
          task_ref: p_task_ref, task_type: 'new_booking_request', booking_ref: booking.booking_ref,
          client_id: booking.client_id ?? null, chat_id: booking.chat_id, channel: booking.channel ?? 'telegram',
          status: 'open', priority: 'normal', payload: {}, idempotency_key: key,
        }));
      }
      return { ok: true, already: false, booking_ref: booking.booking_ref, task_created: !already };
    },

    next_shipment_id({ prefix }) {
      const n = 26001 + table('shipments').length;
      return `${prefix ?? 'MKY'}-${n}`;
    },
  };

  return {
    /** The seeded tables, so a test can assert on what was actually written. */
    _tables: tables,

    from(name) { return new Query(name); },

    async rpc(name, args) {
      const fn = rpcHandlers[name];
      if (!fn) return { data: null, error: { message: `fake-db: rpc ${name} is not implemented` } };
      try {
        return { data: fn(args ?? {}), error: null };
      } catch (err) {
        return { data: null, error: { message: err.message } };
      }
    },

    storage: {
      from() {
        return {
          async upload(path) { return { data: { path }, error: null }; },
          async createSignedUrl(path) { return { data: { signedUrl: `https://example.test/${path}` }, error: null }; },
          async download() { return { data: null, error: { message: 'not implemented' } }; },
        };
      },
    },
  };
}

function parseList(value) {
  // PostgREST writes this as ("a","b","c")
  return String(value).replace(/^\(|\)$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
}
