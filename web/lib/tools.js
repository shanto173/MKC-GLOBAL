/**
 * The tools the model may call. Every fact the bot states about a shipment or a
 * booking comes from one of these, i.e. straight out of Postgres - never from
 * the model's own memory.
 */

import { db } from './supabase.js';
import { embed, embeddingsAvailable } from './llm.js';
import { config, DESTINATION_PORTS, DEPARTMENTS } from './config.js';
import { notifyBooking } from './notify.js';

export const toolDefinitions = [
  {
    name: 'track_shipment',
    description:
      'Look up live shipment status in the company database. Accepts a chassis / VIN number, ' +
      'a booking reference, a shipment reference, an ACID number, a Bill of Lading number, a ' +
      'container number, or a customer name. Always use this before answering any question about ' +
      'where a vehicle or shipment is.',
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
    name: 'lookup_vehicle',
    description:
      'FIRST STEP OF EVERY BOOKING. Look up a chassis / VIN number to find out whether we already ' +
      'know this unit and whether it is already booked. Call this the moment the customer gives a ' +
      'chassis number, before asking them anything else. Never ask a customer for details we already hold.',
    parameters: {
      type: 'object',
      properties: {
        vin: {
          type: 'string',
          description: 'The chassis or VIN number, exactly as the customer typed it.',
        },
      },
      required: ['vin'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_booking',
    description:
      'Create a booking request for one vehicle, once the required details are collected and the ' +
      'customer has confirmed the summary. Call lookup_vehicle first. Do not invent values - ask ' +
      'the customer for anything missing. Returns a booking reference.',
    parameters: {
      type: 'object',
      properties: {
        vin: { type: 'string', description: 'Chassis / VIN number of the vehicle being shipped.' },
        make: { type: 'string', description: 'Manufacturer, e.g. Mercedes-Benz, Volvo, Scania.' },
        model: { type: 'string', description: 'Model, e.g. Actros 1845.' },
        vehicle_type: { type: 'string', description: 'truck, tractor unit, trailer, van or car.' },
        engine_condition: {
          type: 'string',
          description: 'Any stated damage or defect, e.g. "damaged engine". Leave out if the vehicle is sound.',
        },
        customer_name: { type: 'string', description: 'Full name of the person booking.' },
        customer_contact: { type: 'string', description: 'Email address or phone number, if given.' },
        company: { type: 'string', description: 'Company name, if any.' },
        origin_country: { type: 'string', description: 'Country the vehicle ships from, e.g. Poland, Lithuania.' },
        origin_port: { type: 'string', description: 'Port or city of loading, e.g. Rotterdam, Monfalcone.' },
        destination_port: {
          type: 'string',
          description: `Egyptian destination port. One of: ${DESTINATION_PORTS.join(', ')}.`,
        },
        gross_weight_kg: { type: 'number', description: 'Gross weight in kilograms.' },
        value_amount: { type: 'number', description: 'Declared value from the invoice.' },
        value_currency: { type: 'string', description: 'Currency of the declared value, e.g. EUR.' },
        incoterm: { type: 'string', description: 'Incoterm such as EXW, FOB, CIF, DAP.' },
        mrn_number: { type: 'string', description: 'MRN from the export country, if the customer has one.' },
        acid_number: { type: 'string', description: 'Egyptian ACID number, 19 digits, if known.' },
        mrn_needed: {
          type: 'boolean',
          description: 'True when the customer asked MKY to obtain the MRN for them.',
        },
        ready_date: { type: 'string', description: 'Cargo ready date, YYYY-MM-DD.' },
        notes: { type: 'string', description: 'Anything else the customer mentioned.' },
        language: {
          type: 'string',
          enum: ['en', 'ar'],
          description: 'Language the customer is using, so their paperwork matches.',
        },
      },
      required: ['vin', 'make', 'customer_name', 'origin_port', 'destination_port'],
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

  async lookup_vehicle({ vin }) {
    const norm = normalizeVin(vin);
    if (norm.length < 6) {
      return { error: 'That does not look like a chassis number. Ask the customer to send it again.' };
    }

    const [vehicle, booking, shipment] = await Promise.all([
      db().from('vehicles').select('*').eq('vin_norm', norm).maybeSingle(),
      db().from('bookings')
        .select('booking_ref, status, origin_port, destination_port, created_at, customer_name')
        .eq('vin_norm', norm).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      db().from('shipments')
        .select('shipment_id, status, origin_port, destination_port, eta, vessel')
        .eq('vin_norm', norm).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
    ]);

    for (const r of [vehicle, booking, shipment]) {
      if (r.error) return { error: r.error.message };
    }

    const known = Boolean(vehicle.data || booking.data || shipment.data);
    // An open booking means the unit is already in the pipeline. Sending a
    // second request for it creates duplicate work on the operations desk.
    const openBooking = booking.data && !['cancelled', 'rejected'].includes(booking.data.status)
      ? booking.data
      : null;

    let verdict;
    let next_step;
    if (openBooking) {
      verdict = 'already_booked';
      next_step =
        `This unit is ALREADY BOOKED under ${openBooking.booking_ref} ` +
        `(${openBooking.origin_port} to ${openBooking.destination_port}, status ${openBooking.status}). ` +
        'Tell the customer this, give them the reference, and say there is no need to submit another ' +
        'request. Do not start a new booking. Offer to track it or connect them to Operations instead.';
    } else if (known) {
      verdict = 'known_not_booked';
      next_step =
        'We already hold this unit but it has no open booking. Confirm the details we have back to ' +
        'the customer rather than asking them again, then continue with anything still missing.';
    } else {
      verdict = 'new';
      next_step =
        'This unit is new to us. Continue with the booking: ask for make and model, the customer name, ' +
        'and the route (city of loading and Egyptian destination port).';
    }

    return {
      verdict,
      vin: vehicle.data?.vin ?? booking.data?.vin ?? shipment.data?.vin ?? String(vin).toUpperCase(),
      known,
      vehicle: vehicle.data ?? null,
      existing_booking: openBooking,
      existing_shipment: shipment.data ?? null,
      next_step,
    };
  },

  async create_booking(args, ctx) {
    const required = ['vin', 'make', 'customer_name', 'origin_port', 'destination_port'];
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

    const vinNorm = normalizeVin(args.vin);

    // One VIN, one open booking. Guards a customer re-requesting a unit somebody
    // has already booked, which would duplicate work on the operations desk.
    // Drafts are excluded - they are this conversation's own unconfirmed row.
    const { data: clash } = await db()
      .from('bookings')
      .select('booking_ref, status, origin_port, destination_port, chat_id, created_at')
      .eq('vin_norm', vinNorm)
      .not('status', 'in', '("cancelled","rejected","draft")')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (clash) {
      const sameChat = String(clash.chat_id) === String(ctx.chatId);
      const justNow = Date.now() - new Date(clash.created_at).getTime() < 30 * 60_000;

      if (sameChat && justNow) {
        return {
          ok: true,
          duplicate: true,
          booking_ref: clash.booking_ref,
          status: clash.status,
          next_step:
            'This booking was already created moments ago. Give the customer the SAME reference ' +
            'above. Do not tell them a new booking was made.',
        };
      }

      return {
        ok: false,
        already_booked: true,
        booking_ref: clash.booking_ref,
        message:
          `Chassis ${String(args.vin).toUpperCase()} is already booked under ${clash.booking_ref} ` +
          `(${clash.origin_port} to ${clash.destination_port}, status ${clash.status}). Give the ` +
          'customer that reference instead of creating a second booking, and offer to track it.',
      };
    }

    // A booking lands on the operations desk, so it must not be created off the
    // model's own momentum. Neither prompt wording nor a "customer_confirmed"
    // argument held - the model set that flag itself before the customer had
    // answered. So confirmation is structural: the first call only saves a
    // draft, and only a LATER customer message can promote it. ctx.turnId
    // changes with every incoming message and the model cannot forge it.
    const { data: draft } = await db()
      .from('bookings')
      .select('booking_ref, raw, created_at')
      .eq('chat_id', String(ctx.chatId))
      .eq('vin_norm', vinNorm)
      .eq('status', 'draft')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const proposedThisTurn = draft?.raw?.turn_id === ctx.turnId;

    if (!draft || proposedThisTurn) {
      const draftRef = draft?.booking_ref ?? makeRef('BKG');
      const { error: draftErr } = await db().from('bookings').upsert({
        booking_ref: draftRef,
        channel: ctx.channel,
        chat_id: String(ctx.chatId),
        customer_name: args.customer_name.trim(),
        customer_contact: args.customer_contact?.trim() || `${ctx.channel}:${ctx.chatId}`,
        // The draft carries the same shape as the final row. It previously
        // omitted origin_country, which is NOT NULL in the original schema, so
        // every draft insert failed and the bot asked for a country the tool
        // never required.
        origin_country: args.origin_country?.trim() || countryForPort(latinizeName(args.origin_port)),
        origin_port: latinizeName(args.origin_port),
        destination_port: port,
        vin: String(args.vin).toUpperCase().replace(/\s+/g, ''),
        make: latinizeName(args.make),
        model: latinizeName(args.model) || null,
        status: 'draft',
        raw: { ...args, turn_id: ctx.turnId },
      }, { onConflict: 'booking_ref' });
      if (draftErr) {
        console.error('booking draft insert failed:', draftErr.message);
        return {
          ok: false,
          error: draftErr.message,
          message:
            'Saving the booking failed for a technical reason, not because the customer is ' +
            'missing information. Do NOT ask them for more details. Apologise briefly and offer ' +
            'to pass this to Booking Operations.',
        };
      }

      return {
        ok: false,
        needs_confirmation: true,
        message:
          'NOT booked yet. Read this summary back to the customer and ask them to confirm: ' +
          `Chassis ${String(args.vin).toUpperCase()}; ` +
          `vehicle ${[args.make, args.model].filter(Boolean).join(' ') || 'not stated'}; ` +
          `route ${args.origin_port} to ${port}; ` +
          `customer ${args.customer_name}. ` +
          'When they reply agreeing, call create_booking again with the same details. ' +
          'Do not tell the customer a booking exists until then.',
      };
    }

    const row = {
      booking_ref: draft.booking_ref,
      channel: ctx.channel,
      chat_id: String(ctx.chatId),
      customer_name: args.customer_name.trim(),
      // On Telegram we may not have an email or phone. Falling back to the chat
      // keeps the booking valid; Operations can always reply in the same thread.
      customer_contact: args.customer_contact?.trim() || `${ctx.channel}:${ctx.chatId}`,
      company: args.company?.trim() || null,
      origin_country: args.origin_country?.trim() || countryForPort(latinizeName(args.origin_port)),
      origin_port: latinizeName(args.origin_port),
      destination_port: port,
      vin: String(args.vin).toUpperCase().replace(/\s+/g, ''),
      make: latinizeName(args.make),
      model: latinizeName(args.model) || null,
      cargo_description: [args.make, args.model, args.vehicle_type].map(latinizeName).filter(Boolean).join(' ').trim() || null,
      gross_weight_kg: numOrNull(args.gross_weight_kg),
      incoterm: args.incoterm?.trim() || null,
      mrn_number: args.mrn_number?.trim() || null,
      acid_number: args.acid_number?.trim() || null,
      mrn_needed: Boolean(args.mrn_needed),
      language: args.language === 'ar' ? 'ar' : 'en',
      ready_date: dateOrNull(args.ready_date),
      notes: args.notes?.trim() || null,
      status: 'pending_review',
      raw: args,
    };

    // Promotes the draft row in place, so the reference the customer was shown
    // during confirmation is the reference they end up with.
    const { data, error } = await db()
      .from('bookings')
      .upsert(row, { onConflict: 'booking_ref' })
      .select()
      .single();
    if (error) return { ok: false, error: error.message };

    // Remember the unit so a later enquiry about this chassis recognises it,
    // even if it comes from a different customer or channel.
    const { error: vehErr } = await db().from('vehicles').upsert({
      vin: row.vin,
      make: row.make,
      model: row.model,
      vehicle_type: latinizeName(args.vehicle_type) || null,
      engine_condition: args.engine_condition?.trim() || null,
      gross_weight_kg: row.gross_weight_kg,
      value_amount: numOrNull(args.value_amount),
      value_currency: args.value_currency?.trim() || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'vin' });
    if (vehErr) console.error('vehicle upsert failed:', vehErr.message);

    // Confirmation PDF by email to the customer and the ops desk, plus a ping
    // to the staff group. Never allowed to fail the booking itself.
    const notified = await notifyBooking(data).catch((err) => {
      console.error('notifyBooking threw:', err);
      return { errors: [err.message] };
    });
    if (notified.errors?.length) console.error('booking notification issues:', notified.errors);

    return {
      ok: true,
      booking_ref: data.booking_ref,
      status: data.status,
      confirmation_emailed: notified.customer_email === true,
      next_step:
        'Tell the customer the booking reference, that a confirmation PDF has been emailed to them, '
        + 'that Booking Operations will confirm by email ' +
        'within one business day, and which documents to prepare (MRN, ACID, commercial invoice, packing list).',
      booking_form_url: config.bookingFormUrl || undefined,
    };
  },

  async list_my_bookings(_args, ctx) {
    const { data, error } = await db()
      .from('bookings')
      .select('booking_ref, status, vin, make, model, origin_port, destination_port, created_at')
      .eq('chat_id', String(ctx.chatId))
      // Drafts are unconfirmed proposals, not bookings. Showing one to the
      // customer would tell them a unit is booked when it is not.
      .neq('status', 'draft')
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

/** Customers type a chassis number with spaces, dashes and lower case. */
export function normalizeVin(v) {
  return String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Makes, models and places written in Arabic, mapped to the Latin spelling used
 * on the invoice, the bill of lading and the customs declaration.
 *
 * The customer is answered in Arabic, but the stored value has to match the
 * paperwork or nobody can reconcile the two. Asking the model to transliterate
 * did not work - it kept passing Arabic through - so it is done here, where the
 * result is predictable. Anything not in this table is left exactly as the
 * customer wrote it, because a wrong Latin guess is worse than Arabic.
 */
const LATIN_NAMES = new Map(Object.entries({
  // manufacturers
  'مرسيدس': 'Mercedes-Benz', 'مرسيدس بنز': 'Mercedes-Benz', 'أكتروس': 'Actros', 'اكتروس': 'Actros',
  'فولفو': 'Volvo', 'سكانيا': 'Scania', 'مان': 'MAN', 'داف': 'DAF', 'ايفيكو': 'Iveco', 'إيفيكو': 'Iveco',
  'رينو': 'Renault', 'هينو': 'Hino', 'ايسوزو': 'Isuzu', 'إيسوزو': 'Isuzu', 'فورد': 'Ford',
  // vehicle types
  'جرار': 'tractor unit', 'شاحنة': 'truck', 'مقطورة': 'trailer', 'قاطرة': 'tractor unit',
  'عربية': 'vehicle', 'سيارة': 'car', 'فان': 'van', 'أتوبيس': 'bus', 'اتوبيس': 'bus',
  // loading places we actually see on this lane
  'فيلنيوس': 'Vilnius', 'كلايبيدا': 'Klaipeda', 'روتردام': 'Rotterdam', 'أنتويرب': 'Antwerp',
  'انتويرب': 'Antwerp', 'هامبورغ': 'Hamburg', 'هامبورج': 'Hamburg', 'مونفالكوني': 'Monfalcone',
  'كوبر': 'Koper', 'كونستانتا': 'Constanta', 'برشلونة': 'Barcelona', 'فالنسيا': 'Valencia',
  'جنوة': 'Genoa', 'فيليكستو': 'Felixstowe', 'بريمين': 'Bremen', 'زيبروجه': 'Zeebrugge',
  'الإسكندرية': 'Alexandria', 'الاسكندرية': 'Alexandria', 'بورسعيد': 'Port Said',
  'دمياط': 'Damietta', 'العين السخنة': 'Ain Sokhna', 'السويس': 'Suez',
}));

/**
 * The country a loading port sits in, so a customer who says "from Vilnius" is
 * not interrogated about Lithuania. Only ports we actually load from; anything
 * unknown stays null rather than being guessed.
 */
const PORT_COUNTRY = new Map(Object.entries({
  vilnius: 'Lithuania', klaipeda: 'Lithuania',
  rotterdam: 'Netherlands', antwerp: 'Belgium', zeebrugge: 'Belgium',
  hamburg: 'Germany', bremen: 'Germany', bremerhaven: 'Germany',
  felixstowe: 'United Kingdom', 'london gateway': 'United Kingdom', southampton: 'United Kingdom',
  monfalcone: 'Italy', genoa: 'Italy', livorno: 'Italy', trieste: 'Italy',
  koper: 'Slovenia', constanta: 'Romania', gdansk: 'Poland', gdynia: 'Poland',
  barcelona: 'Spain', valencia: 'Spain', bilbao: 'Spain',
  savannah: 'United States', 'new york': 'United States', 'los angeles': 'United States',
  piraeus: 'Greece', marseille: 'France', 'le havre': 'France',
}));

export function countryForPort(port) {
  const key = String(port ?? '').toLowerCase().trim();
  if (!key) return null;
  return PORT_COUNTRY.get(key) ?? [...PORT_COUNTRY.entries()].find(([p]) => key.includes(p))?.[1] ?? null;
}

/** Rewrites Arabic words to their Latin equivalents, leaving the rest alone. */
export function latinizeName(value) {
  const text = String(value ?? '').trim();
  if (!text || !/[؀-ۿ]/.test(text)) return text;

  const direct = LATIN_NAMES.get(text);
  if (direct) return direct;

  const words = text.split(/\s+/).map((w) => {
    const bare = w.replace(/^(ال)(?=[؀-ۿ]{3,})/, '');
    return LATIN_NAMES.get(w) ?? LATIN_NAMES.get(bare) ?? w;
  });
  return words.join(' ');
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
  return `${config.refPrefix}-${prefix}-${stamp}-${rand}`;
}
