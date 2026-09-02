/**
 * The tools the model may call. Every fact the bot states about a shipment or a
 * booking comes from one of these, i.e. straight out of Postgres - never from
 * the model's own memory.
 */

import { db } from './supabase.js';
import { embed, embeddingsAvailable } from './llm.js';
import { config, DESTINATION_PORTS, ORIGIN_COUNTRIES, DEPARTMENTS } from './config.js';

export const toolDefinitions = [
  {
    name: 'track_shipment',
    description:
      'Look up live shipment status in the company database. Accepts a shipment reference ' +
      '(MKC-24001), an ACID number, a Bill of Lading number, a container number, or a ' +
      'customer name. Always use this before answering any question about where a shipment is.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The reference or customer name to search for.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_knowledge',
    description:
      'Search the company knowledge base (services, ports, required documents, customs rules, ' +
      'payment terms, office contacts, cut-off times). Use for any general company question.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The user question, in full.' },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_booking',
    description:
      'Create a freight booking request in the database once ALL required details are collected. ' +
      'Do not invent values - ask the customer for anything missing. Returns a booking reference.',
    parameters: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'Full name of the person booking.' },
        customer_contact: { type: 'string', description: 'Email address or phone number.' },
        company: { type: 'string', description: 'Company name, if any.' },
        origin_country: {
          type: 'string',
          description: `Origin region. One of: ${ORIGIN_COUNTRIES.join(', ')}.`,
        },
        origin_port: { type: 'string', description: 'Port or city of loading, e.g. Rotterdam.' },
        destination_port: {
          type: 'string',
          description: `Egyptian destination port. One of: ${DESTINATION_PORTS.join(', ')}.`,
        },
        cargo_description: { type: 'string', description: 'What is being shipped.' },
        gross_weight_kg: { type: 'number', description: 'Gross weight in kilograms.' },
        volume_cbm: { type: 'number', description: 'Volume in cubic metres.' },
        incoterm: { type: 'string', description: 'Incoterm such as EXW, FOB, CIF, DAP.' },
        ready_date: { type: 'string', description: 'Cargo ready date, YYYY-MM-DD.' },
        notes: { type: 'string', description: 'Anything else the customer mentioned.' },
      },
      required: [
        'customer_name',
        'customer_contact',
        'origin_country',
        'origin_port',
        'destination_port',
        'cargo_description',
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'list_my_bookings',
    description: 'List booking requests previously made from this chat.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_support_ticket',
    description:
      'Escalate to a human department when the customer is unhappy, asks for a person, or the ' +
      'question cannot be answered from the database or knowledge base.',
    parameters: {
      type: 'object',
      properties: {
        department: { type: 'string', enum: DEPARTMENTS },
        summary: { type: 'string', description: 'One paragraph describing the issue.' },
        contact: { type: 'string', description: 'Customer email or phone, if known.' },
        customer: { type: 'string', description: 'Customer name, if known.' },
      },
      required: ['department', 'summary'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

const executors = {
  async track_shipment({ query }) {
    const q = String(query || '').trim();
    if (!q) return { error: 'No search term supplied.' };

    const { data, error } = await db().rpc('find_shipments', { q, match_count: 5 });
    if (error) return { error: error.message };
    if (!data?.length) {
      return {
        found: false,
        message: `No shipment matches "${q}". Ask the customer to double-check the reference, or offer to raise a ticket with the Tracking Desk.`,
      };
    }

    const shipments = [];
    for (const s of data) {
      const { data: events } = await db()
        .from('shipment_events')
        .select('event_time, location, description')
        .eq('shipment_id', s.shipment_id)
        .order('event_time', { ascending: false })
        .limit(5);
      shipments.push({ ...s, recent_events: events ?? [] });
    }
    return { found: true, count: shipments.length, shipments };
  },

  async search_knowledge({ question }) {
    const q = String(question || '').trim();
    if (!q) return { error: 'No question supplied.' };

    if (embeddingsAvailable()) {
      try {
        const [vector] = await embed(q);
        const { data, error } = await db().rpc('match_documents', {
          query_embedding: vector,
          match_count: 5,
          min_similarity: 0.15,
        });
        if (!error && data?.length) {
          return { matches: data.map(strip) };
        }
      } catch (err) {
        console.error('vector search failed, falling back to FTS:', err.message);
      }
    }

    const { data, error } = await db().rpc('search_documents_fts', {
      query_text: q,
      match_count: 5,
    });
    if (error) return { error: error.message };
    if (!data?.length) {
      return { matches: [], message: 'Nothing in the knowledge base covers this. Offer a human handoff.' };
    }
    return { matches: data.map(strip) };
  },

  async create_booking(args, ctx) {
    const required = [
      'customer_name',
      'customer_contact',
      'origin_country',
      'origin_port',
      'destination_port',
      'cargo_description',
    ];
    const missing = required.filter((k) => !String(args[k] ?? '').trim());
    if (missing.length) {
      return { ok: false, missing_fields: missing, message: 'Ask the customer for the missing fields, then call this tool again.' };
    }

    const port = matchPort(args.destination_port);
    if (!port) {
      return {
        ok: false,
        message: `"${args.destination_port}" is not a port we serve. Supported destinations: ${DESTINATION_PORTS.join(', ')}.`,
      };
    }

    // The model sometimes calls this twice for one shipment (once when it has
    // the details, again when the customer says "yes, book it"). Return the
    // existing reference instead of creating a duplicate on the ops desk.
    const cargo = args.cargo_description.trim().toLowerCase();
    const since = new Date(Date.now() - 30 * 60_000).toISOString();
    const { data: recent } = await db()
      .from('bookings')
      .select('booking_ref, status, cargo_description, destination_port, created_at')
      .eq('chat_id', String(ctx.chatId))
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(5);

    const duplicate = (recent ?? []).find(
      (b) => b.destination_port === port && b.cargo_description.trim().toLowerCase() === cargo,
    );
    if (duplicate) {
      return {
        ok: true,
        duplicate: true,
        booking_ref: duplicate.booking_ref,
        status: duplicate.status,
        next_step:
          'This booking was already created moments ago. Give the customer the SAME reference above. ' +
          'Do not tell them a new booking was made.',
      };
    }

    const row = {
      booking_ref: makeRef('BKG'),
      channel: ctx.channel,
      chat_id: String(ctx.chatId),
      customer_name: args.customer_name.trim(),
      customer_contact: args.customer_contact.trim(),
      company: args.company?.trim() || null,
      origin_country: args.origin_country.trim(),
      origin_port: args.origin_port.trim(),
      destination_port: port,
      cargo_description: args.cargo_description.trim(),
      gross_weight_kg: numOrNull(args.gross_weight_kg),
      volume_cbm: numOrNull(args.volume_cbm),
      incoterm: args.incoterm?.trim() || null,
      ready_date: dateOrNull(args.ready_date),
      notes: args.notes?.trim() || null,
      status: 'pending_review',
      raw: args,
    };

    const { data, error } = await db().from('bookings').insert(row).select().single();
    if (error) return { ok: false, error: error.message };

    return {
      ok: true,
      booking_ref: data.booking_ref,
      status: data.status,
      next_step:
        'Tell the customer the booking reference, that Booking Operations will confirm by email ' +
        'within one business day, and which documents to prepare (MRN, ACID, commercial invoice, packing list).',
      booking_form_url: config.bookingFormUrl || undefined,
    };
  },

  async list_my_bookings(_args, ctx) {
    const { data, error } = await db()
      .from('bookings')
      .select('booking_ref, status, origin_port, destination_port, cargo_description, created_at')
      .eq('chat_id', String(ctx.chatId))
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) return { error: error.message };
    return { count: data.length, bookings: data };
  },

  async create_support_ticket(args, ctx) {
    const department = DEPARTMENTS.includes(args.department) ? args.department : 'Customer Care';
    const row = {
      ticket_ref: makeRef('TKT'),
      channel: ctx.channel,
      chat_id: String(ctx.chatId),
      department,
      customer: args.customer?.trim() || ctx.userName || null,
      contact: args.contact?.trim() || null,
      summary: String(args.summary || '').trim() || 'No summary supplied.',
    };
    const { data, error } = await db().from('support_tickets').insert(row).select().single();
    if (error) return { ok: false, error: error.message };
    return {
      ok: true,
      ticket_ref: data.ticket_ref,
      department,
      next_step: 'Give the customer the ticket reference and say the department will reply during business hours.',
    };
  },
};

/** Run one tool call. Never throws - errors come back as data for the model. */
export async function runTool(name, args, ctx) {
  const fn = executors[name];
  if (!fn) return { error: `Unknown tool: ${name}` };
  try {
    return await fn(args ?? {}, ctx);
  } catch (err) {
    console.error(`tool ${name} failed:`, err);
    return { error: `Tool ${name} failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function strip(row) {
  return { source: row.source, title: row.title, content: row.content };
}

function matchPort(value) {
  const v = String(value).toLowerCase();
  return (
    DESTINATION_PORTS.find((p) => p.toLowerCase() === v) ||
    DESTINATION_PORTS.find((p) => p.toLowerCase().includes(v) || v.includes(p.split(' ')[0].toLowerCase())) ||
    null
  );
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Cargo-ready dates must be in the future. Models routinely emit the wrong year
 * for a bare "15 September", so roll it forward rather than storing a date in
 * the past that ops would have to chase.
 */
function dateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const graceDays = 7; // allow "ready last Friday" for cargo already waiting
  const floor = new Date(today.getTime() - graceDays * 86_400_000);

  while (d < floor) {
    d.setFullYear(d.getFullYear() + 1);
    if (d.getFullYear() > today.getFullYear() + 2) return null; // nonsense input
  }
  return d.toISOString().slice(0, 10);
}

function makeRef(prefix) {
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `MKC-${prefix}-${stamp}-${rand}`;
}
