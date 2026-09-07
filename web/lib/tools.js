/**
 * The tools the model may call. Every fact the bot states about a shipment or a
 * booking comes from one of these, i.e. straight out of Postgres - never from
 * the model's own memory.
 */

import { db } from './supabase.js';
import { embed, embeddingsAvailable } from './llm.js';
import { config, DESTINATION_PORTS, DEPARTMENTS } from './config.js';
import { notifyBooking } from './notify.js';
import { documentStatus, attachDocumentsToBooking } from './documents.js';
import { shipmentCard, bookingCard, documentsCard, checklistCard } from './format.js';

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
    name: 'update_booking',
    description:
      'Change a detail on a booking the customer has already made, while it is still awaiting ' +
      'review. Use when they say something was wrong - the chassis, the make, their name, the ' +
      'route, the ready date. Pass only the fields that change. To REMOVE a value the customer ' +
      'no longer wants recorded (a company, a note, a weight), pass "-" for that field. Only use ' +
      'this when the booking already has a reference; before that, call create_booking again.',
    parameters: {
      type: 'object',
      properties: {
        booking_ref: {
          type: 'string',
          description: 'The booking to change. If the customer did not say, look it up first.',
        },
        vin: { type: 'string', description: 'Corrected chassis / VIN number.' },
        make: { type: 'string', description: 'Corrected manufacturer.' },
        model: { type: 'string', description: 'Corrected model.' },
        customer_name: { type: 'string', description: 'Corrected customer name.' },
        customer_contact: { type: 'string', description: 'Corrected email or phone.' },
        company: { type: 'string', description: 'Corrected company name.' },
        origin_port: { type: 'string', description: 'Corrected port or city of loading.' },
        destination_port: { type: 'string', description: 'Corrected Egyptian destination port.' },
        gross_weight_kg: { type: 'number', description: 'Corrected gross weight in kilograms.' },
        incoterm: { type: 'string', description: 'Corrected Incoterm.' },
        ready_date: { type: 'string', description: 'Corrected cargo ready date, YYYY-MM-DD.' },
        notes: { type: 'string', description: 'Anything else to record.' },
      },
      required: ['booking_ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_documents',
    description:
      'Which documents the customer has sent in this conversation, which are still missing, and ' +
      'whether the chassis number agrees across all of them. Call this whenever the customer asks ' +
      'what is still needed, or before telling them a booking is complete.',
    parameters: {
      type: 'object',
      properties: {
        vin: {
          type: 'string',
          description: 'Chassis number, when known, so only that vehicle\'s papers are counted.',
        },
      },
      required: [],
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
  async track_shipment({ query }, ctx) {
    const q = String(query || '').trim();
    if (!q) return { error: 'No search term supplied.' };

    // include_names stays false: this is the customer-facing path, and matching
    // on customer_name returned other customers' rows for a query as short as
    // a single letter.
    const { data, error } = await db().rpc('find_shipments', { q, match_count: 5, include_names: false });
    if (error) return { error: error.message };

    if (!data?.length) {
      // A booking that Operations has not confirmed yet has no shipment row, so
      // the customer who booked ten minutes ago - quoting the reference we gave
      // them - was being told we had never heard of it.
      const norm = normalizeVin(q);
      const { data: booked } = await db()
        .from('bookings')
        .select('booking_ref, status, vin, make, model, origin_port, destination_port, created_at, ops_notes')
        .neq('status', 'draft')
        .or(`booking_ref.eq.${String(q).trim().toUpperCase()}${norm.length >= 6 ? `,vin_norm.eq.${norm}` : ''}`)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (booked) {
        return {
          found: false,
          booking_found: true,
          booking: booked,
          message:
            `There is no shipment yet for ${booked.booking_ref}: the booking is ${booked.status.replace(/_/g, ' ')}. ` +
            (booked.status === 'pending_review'
              ? 'Tell the customer Operations is reviewing it and that tracking begins once it is confirmed.'
              : `Tell the customer its state is ${booked.status.replace(/_/g, ' ')}.` +
                (booked.ops_notes ? ` Operations noted: ${booked.ops_notes}` : '')),
        };
      }

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
    const lang = ctx?.customerLanguage ?? 'en';
    return {
      found: true,
      count: shipments.length,
      shipments,
      // Reproduced verbatim by the model, so every tracking answer has the same
      // shape and the same fields in the same order.
      display: shipments.map((s) => shipmentCard(s, lang)).join('\n\n'),
    };
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

  async lookup_vehicle({ vin }, ctx) {
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

    // What we still need goes out as a block, one line per item, built here.
    // Left to the model it came out as a paragraph - "please provide the make
    // and model, your full name, the city or port of loading, and..." - which
    // nobody reads on a phone.
    const opening = verdict === 'new'
      ? 'الوحدة دي جديدة عندنا - دي البيانات اللي ناقصة / This unit is new to us - here is what we still need'
      : 'الوحدة دي عندنا بالفعل - دي البيانات اللي ناقصة / We already hold this unit - here is what we still need';
    const checklist = openBooking ? null : detailsNeededCard(ctx?.customerSaid, { opening });
    // Only a field the booking cannot exist without makes the list the whole
    // answer. Weight, Incoterm, ready date and damage are asked for on the same
    // list, but they must not stop the booking reaching its summary - doing so
    // left a customer who had given everything staring at a checklist.
    const missingBasics = !openBooking && missingRequiredDetails(ctx?.customerSaid);

    return {
      verdict,
      vin: vehicle.data?.vin ?? booking.data?.vin ?? shipment.data?.vin ?? String(vin).toUpperCase(),
      known,
      vehicle: vehicle.data ?? null,
      existing_booking: openBooking,
      existing_shipment: shipment.data ?? null,
      display: checklist ?? undefined,
      // The block says everything, in both languages, one line per item. A
      // sentence added to it only repeats it as a paragraph, so this reply is
      // the block by itself.
      verbatim: Boolean(checklist) && missingBasics,
      next_step: checklist ? 'The list has already gone to the customer as it is.' : next_step,
    };
  },

  async create_booking(args, ctx) {
    const required = ['vin', 'make', 'customer_name', 'origin_port', 'destination_port'];
    const missing = required.filter((k) => !String(args[k] ?? '').trim());
    if (missing.length) {
      // What IS missing is worked out here, from the values actually passed,
      // rather than left to the model's recollection of the conversation - it
      // has asked customers for details they had already given, twice.
      const have = {};
      for (const [k, v] of Object.entries(args)) {
        if (v !== null && v !== undefined && String(v).trim() !== '') have[k] = v;
      }
      const label = {
        vin: 'the chassis / VIN number',
        make: 'the manufacturer',
        customer_name: 'the name to book under',
        origin_port: 'the port or city of loading',
        destination_port: 'the Egyptian destination port',
      };
      return {
        ok: false,
        missing_fields: missing,
        already_given: have,
        message:
          `Still needed: ${missing.map((f) => label[f] ?? f).join(', ')}. ` +
          'Ask for ALL of them in ONE short message - not one at a time. ' +
          'Do NOT ask about anything under already_given: the customer has said it, ' +
          'and asking twice is the complaint we hear most. Read it back to them instead.',
      };
    }

    // A customer pasting our own field list back at us sends the menu with it:
    // "EXW / FOB / CIF / DAP" arrived as the Incoterm and went onto a summary
    // card as though they had chosen it. A value that is not one of the eleven
    // is not an answer, so it is dropped and asked about instead of recorded.
    const unclear = [];
    if (args.incoterm !== undefined && args.incoterm !== null && String(args.incoterm).trim() !== '') {
      const term = String(args.incoterm).trim().toUpperCase();
      if (!INCOTERMS.includes(term)) {
        unclear.push('incoterm');
        args = { ...args, incoterm: null };
      }
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
    // Only a draft from the conversation still happening counts. An abandoned
    // one from last week would otherwise be promoted the moment a customer
    // re-entered the same details - booked on the first call, unconfirmed.
    const DRAFT_LIFE_HOURS = 24;
    const freshSince = new Date(Date.now() - DRAFT_LIFE_HOURS * 3600_000).toISOString();
    const { data: draft } = await db()
      .from('bookings')
      .select('booking_ref, raw, created_at')
      .eq('chat_id', String(ctx.chatId))
      .eq('vin_norm', vinNorm)
      .eq('status', 'draft')
      .gt('created_at', freshSince)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const proposedThisTurn = draft?.raw?.turn_id === ctx.turnId;

    // A second call can mean two different things: "yes, book that" or "no,
    // change the Incoterm". Treating both as confirmation booked corrections
    // without asking - roadmap step 4's "Edit information" branch never ran.
    //
    // But comparing raw arguments does not work either: the model rewrites its
    // own values between turns - Mercedes one turn, Mercedes-Benz the next,
    // "Alexandria Port" then the full port name - and every one of those looked
    // like a customer edit, so an Arabic conversation that said "yes, book it"
    // was asked to confirm the very same card again.
    //
    // The honest test is the one the customer applied: would the summary they
    // approved now read differently? So both versions are rendered as the card,
    // in one language, from canonical values, and compared.
    const canonical = (a) => ({
      ...a,
      booking_ref: '',
      status: null,
      vin: normalizeVin(a.vin),
      make: canonicalMake(a.make),
      model: latinizeName(a.model),
      origin_port: latinizeName(a.origin_port),
      destination_port: matchPort(a.destination_port) ?? a.destination_port,
      gross_weight_kg: numOrNull(a.gross_weight_kg),
      incoterm: String(a.incoterm ?? '').trim().toUpperCase() || null,
      ready_date: dateOrNull(a.ready_date) ?? a.ready_date ?? null,
    });

    // Wording of the damage note drifts the same way, so for comparison only it
    // is reduced to a flag: what the customer approved is that there IS damage,
    // not the sentence describing it.
    // Free text is left out of the comparison entirely: the model rewords a
    // note between turns, and re-asking because a sentence was rephrased is
    // noise. Everything a customer would notice on the card is compared.
    const cardOf = (a) => bookingCard(
      { ...canonical(a), engine_condition: damageReported(a), notes: null },
      'en',
    );

    // Only a field the model actually sent counts. A field it simply left off
    // the second call is not the customer deleting it - it is the model being
    // terse - and anything missing is taken from the draft, so a correction
    // that mentions only the Incoterm keeps the chassis, the route and the rest.
    const provided = {};
    for (const [k, v] of Object.entries(args)) {
      if (v !== null && v !== undefined && String(v).trim() !== '') provided[k] = v;
    }
    if (draft?.raw) {
      // challenged is bookkeeping, not a booking detail: dropping it here means
      // a genuinely revised proposal gets its own safety net again.
      const { turn_id: _turn, challenged: _challenged, details_asked: _asked, ...held } = draft.raw;
      args = { ...held, ...provided };
    }

    // Asked to change EXW to FOB, the model has re-sent EXW. An Incoterm is a
    // closed list, so the customer's own words settle it rather than the
    // arguments the model chose - and the corrected card still goes back for
    // confirmation, so a misread costs a question, never a wrong booking.
    // Not only when a draft exists: the customer often corrects the Incoterm
    // before any summary has been drawn, and their word settles it either way.
    if (asksForChange(ctx?.customerSaid)) {
      // Compared against what the model just sent, not against the draft: on a
      // second call in the same turn the draft already carried the correction,
      // so the check passed and the old value went back in behind it.
      const wanted = requestedIncoterm(ctx.customerSaid);
      if (wanted && wanted !== String(args.incoterm ?? '').trim().toUpperCase()) args.incoterm = wanted;
    }

    const beforeCard = draft?.raw ? cardOf(draft.raw) : null;
    const afterCard = cardOf(args);
    const differsFromDraft = Boolean(beforeCard) && beforeCard !== afterCard;

    // Named only so the model can say what it changed; the decision above is
    // the card, not this list.
    const CARD_FIELDS = ['vin', 'make', 'model', 'engine_condition', 'customer_name', 'origin_port',
      'destination_port', 'gross_weight_kg', 'incoterm', 'ready_date', 'mrn_number', 'acid_number'];
    const changedFields = differsFromDraft
      ? CARD_FIELDS.filter((k) => {
          const before = canonical(draft.raw)[k] ?? null;
          const after = canonical(args)[k] ?? null;
          return String(before ?? '').trim().toLowerCase() !== String(after ?? '').trim().toLowerCase();
        })
      : [];

    // The model does not always carry a correction into its arguments: asked to
    // change EXW to FOB it has re-sent EXW, and because those arguments matched
    // the draft exactly, that counted as agreement and booked the wrong term.
    // So when the customer's own words ask for a change and nothing on the card
    // moved, the booking is held back once and the model is sent to read again.
    if (draft && !proposedThisTurn && !differsFromDraft && !draft.raw?.challenged
        && asksForChange(ctx?.customerSaid)) {
      await db()
        .from('bookings')
        .update({ raw: { ...draft.raw, challenged: true } })
        .eq('booking_ref', draft.booking_ref);
      return {
        ok: false,
        needs_correction: true,
        message:
          'The customer asked for a change, but every value you sent is identical to the summary ' +
          'they were already shown, so nothing would change. Read their last message again and ' +
          'call create_booking with the corrected value. If you cannot tell what they want ' +
          'changed, ask them - do not book.',
      };
    }

    if (!draft || proposedThisTurn || differsFromDraft) {
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
        make: canonicalMake(args.make),
        model: latinizeName(args.model) || null,
        status: 'draft',
        raw: { ...args, turn_id: ctx.turnId, details_asked: true },
      }, { onConflict: 'booking_ref' });
      // One conversation, one proposal on the table. Correcting the chassis
      // used to leave the old draft behind, invisible but real.
      await db()
        .from('bookings')
        .delete()
        .eq('chat_id', String(ctx.chatId))
        .eq('status', 'draft')
        .neq('booking_ref', draftRef);

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

      const lang = args.language === 'ar' ? 'ar' : ctx?.customerLanguage ?? 'en';

      // What paperwork is still outstanding comes from the documents actually
      // received, so the customer is told the whole list at once. Asked for the
      // ACID and the MRN and nothing else, they sent both - and were then asked
      // for the invoice, which is how a two-minute booking becomes four rounds.
      const docs = await documentStatus({ chatId: ctx.chatId, vin: args.vin }).catch(() => null);

      // Only five fields are needed to book, so the moment they arrived the bot
      // jumped to the summary and never asked about the weight, the Incoterm,
      // the ready date or damage at all - roadmap step 2 skipped entirely. They
      // are asked for once, alongside the summary rather than as another round
      // of questions, and never again: a customer who does not have them yet
      // should not be nagged.
      const WORTH_ASKING = [
        ['gross_weight_kg', 'the gross weight in kg'],
        ['incoterm', 'the Incoterm (EXW, FOB, CIF or DAP)'],
        ['ready_date', 'the cargo ready date'],
        ['engine_condition', 'any damage to the vehicle - engine, gearbox, accident'],
      ];
      const alreadyAsked = Boolean(draft?.raw?.details_asked);
      const alsoAsk = alreadyAsked
        ? []
        : WORTH_ASKING.filter(([k]) => String(args[k] ?? '').trim() === '').map(([, label]) => label);

      return {
        ok: false,
        needs_confirmation: true,
        documents_outstanding: docs?.missing_labels?.length ? docs.missing_labels : undefined,
        // A paper that arrived for another vehicle is not outstanding, it is
        // wrong - and the customer needs to hear which one and why.
        documents_for_another_chassis: docs?.wrong_vehicle_labels?.length ? docs.wrong_vehicle_labels : undefined,
        also_ask: alsoAsk.length ? alsoAsk : undefined,
        // Shown from the canonical values, so what the customer approves is
        // exactly what the operations desk will read back out of the database.
        display: bookingCard(canonical(args), lang),
        unclear_fields: unclear.length ? unclear : undefined,
        message:
          (alsoAsk.length
            ? `In the SAME message as the summary, ask them for: ${alsoAsk.join('; ')}. ` +
              (docs?.missing_labels?.length
                ? `And ask them to send: ${docs.missing_labels.join(', ')}. `
                : '') +
              'One message, all of it, then the summary - do not ask these one at a time and do ' +
              'not ask again later if they do not answer. '
            : '') +
          (unclear.length
            ? `The ${unclear.join(' and ')} you sent was a list of choices, not a choice, so it was left ` +
              'blank. Ask the customer which one applies, along with the confirmation. '
            : '') +
          (differsFromDraft
            ? `Updated ${changedFields.join(', ') || 'the summary'}, but NOT booked. Show the customer the corrected `
            : 'NOT booked yet. Show the customer the ') +
          'display block above EXACTLY as written and ask them to confirm it. When they reply ' +
          'agreeing, call create_booking again with the same details. Do not tell the customer a ' +
          'booking exists until then.',
        edited: differsFromDraft ? changedFields : false,
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
      make: canonicalMake(args.make),
      model: latinizeName(args.model) || null,
      cargo_description: [args.make, args.model, args.vehicle_type].map(latinizeName).filter(Boolean).join(' ').trim() || null,
      gross_weight_kg: numOrNull(args.gross_weight_kg),
      incoterm: args.incoterm?.trim().toUpperCase() || null,   // one spelling, so the card and the row agree
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

    // Any documents already sent in this chat belong to this booking.
    await attachDocumentsToBooking({ chatId: ctx.chatId, bookingRef: data.booking_ref, vin: row.vin });

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
      display: bookingCard(data, data.language === 'ar' ? 'ar' : ctx?.customerLanguage ?? 'en'),
      confirmation_emailed: notified.customer_email === true,
      confirmation_sent_in_chat: notified.customer_telegram === true,
      next_step:
        // The thank-you is written here rather than left to the model, so every
        // customer gets the same sentence in the same place.
        `Open with "🙏 Thank you for booking your freight with ${config.companyName.replace(/ Global Forwarding$/, '')}" ` +
        '(in Arabic: "🙏 شكراً لحجز شحنتك مع MKY"). Then give them the booking reference. ' +
        // Only say the copy was delivered where it actually was. Claiming an
        // email that never left is how a customer waits for a PDF that will
        // never arrive.
        (notified.customer_email
          ? 'Say the confirmation PDF has been emailed to them. '
          : notified.customer_telegram
            ? 'Say their PDF copy has just been sent here in this chat. '
            : 'Do NOT say anything was emailed or sent. ') +
        'Say Booking Operations will confirm within one business day, and list which documents to ' +
        'prepare (MRN, ACID, commercial invoice, packing list).',
      booking_form_url: config.bookingFormUrl || undefined,
    };
  },

  async update_booking(args, ctx) {
    const ref = String(args.booking_ref ?? '').trim().toUpperCase();

    // A customer correcting a detail while the summary is still on screen has
    // no booking reference - nothing has been booked. Asking them for one is a
    // dead end, so the tool says what to do instead of demanding the impossible.
    if (!ref) {
      // Which booking they mean depends on what this chat has been doing. The
      // newest row is the one on screen: if it is still a draft, nothing has
      // been created, there is no reference to quote, and asking for one - as
      // the bot did in the field - leaves the customer with nowhere to go.
      const { data: recent } = await db()
        .from('bookings')
        .select('booking_ref, status, vin, raw, created_at')
        .eq('chat_id', String(ctx.chatId))
        .not('status', 'in', '("cancelled","rejected")')
        .order('created_at', { ascending: false })
        .limit(5);

      const newest = recent?.[0];
      if (newest?.status === 'draft') {
        return {
          ok: false,
          use_create_booking: true,
          message:
            'This conversation has a booking still awaiting confirmation from the customer, not a ' +
            'created booking, so there is no reference yet. Do NOT ask the customer for one. Call ' +
            'create_booking again with every detail you already have plus their correction; it ' +
            'returns the corrected summary for them to confirm.',
          current_details: newest.raw ?? null,
        };
      }

      // Past the draft stage there IS a reference, so use it rather than making
      // the customer dig it out - but only when there is no room for doubt.
      const open = (recent ?? []).filter((b) => b.status === 'pending_review');
      if (open.length === 1) {
        return {
          ok: false,
          booking_ref: open[0].booking_ref,
          message:
            `This chat has one booking still open, ${open[0].booking_ref} (chassis ${open[0].vin}). ` +
            'Call update_booking again with that reference and the change.',
        };
      }
      if (open.length > 1) {
        return {
          ok: false,
          message:
            'This chat has more than one open booking: ' +
            open.map((b) => `${b.booking_ref} (chassis ${b.vin})`).join(', ') +
            '. Ask the customer which one they mean.',
        };
      }
      return { ok: false, message: 'Ask the customer which booking reference they mean.' };
    }

    const { data: booking, error } = await db()
      .from('bookings')
      .select('*')
      .eq('booking_ref', ref)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!booking) return { ok: false, message: `No booking with reference ${ref}. Ask them to check it.` };

    // A customer may only change their own booking, and only before Operations
    // has acted on it - otherwise a confirmed shipment could be altered under
    // the desk that already accepted it.
    if (String(booking.chat_id) !== String(ctx.chatId)) {
      return { ok: false, message: `${ref} was not created from this conversation, so it cannot be changed here. Offer to raise a ticket with Booking Operations.` };
    }
    if (!['draft', 'pending_review'].includes(booking.status)) {
      return {
        ok: false,
        message:
          `${ref} is already ${booking.status} and can no longer be edited here. Raise a ticket ` +
          'with Booking Operations describing the change the customer wants.',
      };
    }

    const editable = {
      vin: (v) => String(v).toUpperCase().replace(/\s+/g, ''),
      make: canonicalMake,
      model: latinizeName,
      customer_name: (v) => String(v).trim(),
      customer_contact: (v) => String(v).trim(),
      company: (v) => String(v).trim(),
      origin_port: latinizeName,
      destination_port: (v) => matchPort(v),
      gross_weight_kg: numOrNull,
      incoterm: (v) => String(v).trim().toUpperCase(),
      ready_date: dateOrNull,
      notes: (v) => String(v).trim(),
    };

    // A booking could be corrected but never un-filled: a company name typed by
    // mistake, a weight the customer no longer stands behind, a note that is no
    // longer true. "-" from the model means the customer wants it gone.
    const CLEAR_WORDS = new Set(['-', 'none', 'null', 'clear', 'remove', 'delete',
      'لا يوجد', 'مفيش', 'احذف', 'الغي']);
    const KEEP = new Set(['vin', 'make', 'customer_name', 'customer_contact', 'origin_port', 'destination_port']);

    const changes = {};
    const history = [];
    for (const [field, clean] of Object.entries(editable)) {
      const given = args[field];
      if (given === undefined || given === null || String(given).trim() === '') continue;

      const clearing = CLEAR_WORDS.has(String(given).trim().toLowerCase());
      if (clearing && KEEP.has(field)) {
        return {
          ok: false,
          message: `A booking cannot exist without ${field.replace(/_/g, ' ')}. Ask the customer for the correct value instead of removing it.`,
        };
      }

      const value = clearing ? null : clean(given);
      if (!clearing && (value === null || value === undefined)) continue;
      if (value === booking[field]) continue;
      changes[field] = value;
      history.push({ field, from: booking[field] ?? null, to: value, at: new Date().toISOString() });
    }

    if (args.destination_port && !changes.destination_port && matchPort(args.destination_port) === null) {
      return { ok: false, message: `"${args.destination_port}" is not a port we serve. Supported: ${DESTINATION_PORTS.join(', ')}.` };
    }
    if (!history.length) return { ok: true, unchanged: true, booking_ref: ref, message: 'Nothing was different, so nothing was changed. Confirm the current details with the customer.' };

    if (changes.origin_port) changes.origin_country = countryForPort(changes.origin_port) ?? booking.origin_country;
    if (changes.make || changes.model) {
      changes.cargo_description = [changes.make ?? booking.make, changes.model ?? booking.model].filter(Boolean).join(' ');
    }

    const { data: updated, error: updErr } = await db()
      .from('bookings')
      .update({ ...changes, edit_history: [...(booking.edit_history ?? []), ...history] })
      .eq('booking_ref', ref)
      .select()
      .single();
    if (updErr) return { ok: false, error: updErr.message };

    return {
      ok: true,
      booking_ref: ref,
      changed: history.map((h) => `${h.field}: ${h.from ?? '(empty)'} -> ${h.to}`),
      booking: {
        vin: updated.vin, make: updated.make, model: updated.model,
        customer_name: updated.customer_name,
        route: `${updated.origin_port} to ${updated.destination_port}`,
        ready_date: updated.ready_date,
      },
      next_step:
        'Read the changes back to the customer and confirm the booking reference is unchanged. ' +
        'Booking Operations sees the updated details.',
    };
  },

  async check_documents({ vin }, ctx) {
    const status = await documentStatus({ chatId: ctx.chatId, vin: vin ?? null });
    if (status.error) return { error: status.error };

    return {
      ...status,
      display: documentsCard(status, ctx?.customerLanguage ?? 'en'),
      next_step: status.problems?.length
        ? 'Tell the customer about the problem below before anything else - a chassis mismatch ' +
          'gets the customs declaration rejected.'
        : status.complete
          ? 'All required documents are in and agree with each other. The booking can proceed.'
          : `Still needed: ${status.missing_labels.join(', ')}. Ask the customer to send them.`,
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
  // TOOL_DEBUG=1 prints what the model actually asked for, which is the only
  // way to tell a wrong answer from a wrongly-called tool.
  if (process.env.TOOL_DEBUG) console.error(`[tool] ${name} ${JSON.stringify(args).slice(0, 500)}`);
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
/**
 * What still has to be asked for, given what the customer has just written.
 *
 * Deliberately cautious: a detail is only treated as given when it is
 * unmistakably there. Asking for something twice is the complaint we hear most,
 * but missing one is recoverable - create_booking asks again from the data.
 */
const DETAIL_ITEMS = [
  {
    key: 'make',
    required: true,
    ar: '\u0627\u0644\u0645\u0627\u0631\u0643\u0629 \u0648\u0627\u0644\u0645\u0648\u062f\u064a\u0644',
    en: 'Make and model',
    hint: 'Mercedes-Benz Actros 1845',
    found: (s) => /\b(mercedes|benz|volvo|scania|man|daf|iveco|renault|ford|isuzu|hino|krone|schmitz)\b/i.test(s)
      || /\b(make|model)\b\s*[:=]/i.test(s) || /\u0627\u0644\u0645\u0627\u0631\u0643\u0629/.test(s),
  },
  {
    key: 'vehicle_type',
    ar: '\u0646\u0648\u0639 \u0627\u0644\u0645\u0631\u0643\u0628\u0629',
    en: 'Vehicle type',
    hint: 'truck / tractor unit / trailer / van',
    found: (s) => /\b(truck|tractor|trailer|van|car|lorry)\b/i.test(s)
      || /\u062c\u0631\u0627\u0631|\u0645\u0642\u0637\u0648\u0631\u0629|\u0644\u0648\u0631\u064a/.test(s),
  },
  {
    key: 'engine_condition',
    ar: '\u062d\u0627\u0644\u0629 \u0627\u0644\u0645\u0631\u0643\u0628\u0629 - \u0623\u064a \u062a\u0644\u0641',
    en: 'Any damage',
    hint: 'engine, gearbox, accident - or "none"',
    found: (s) => /\b(damage|damaged|accident|not running|runs fine|no damage|condition)\b/i.test(s)
      || /\u062a\u0627\u0644\u0641|\u062d\u0627\u062f\u062b|\u0633\u0644\u064a\u0645\u0629|\u0645\u0639\u0637\u0644/.test(s),
  },
  {
    key: 'customer_name',
    required: true,
    ar: '\u0627\u0633\u0645\u0643 \u0628\u0627\u0644\u0643\u0627\u0645\u0644',
    en: 'Your full name',
    found: (s) => /\b(name)\b\s*[:=]/i.test(s) || /\bmy name is\b|\bi am\b/i.test(s)
      || /\u0627\u0633\u0645\u064a|\u0627\u0644\u0627\u0633\u0645/.test(s),
  },
  {
    key: 'origin_port',
    required: true,
    ar: '\u0645\u062f\u064a\u0646\u0629 \u0623\u0648 \u0645\u064a\u0646\u0627\u0621 \u0627\u0644\u0634\u062d\u0646',
    en: 'City or port of loading',
    hint: 'Vilnius, Klaipeda, Antwerp...',
    found: (s) => /\bfrom\b\s*[:=]?\s*\w/i.test(s) || /\u0645\u0646\s/.test(s),
  },
  {
    key: 'destination_port',
    required: true,
    ar: '\u0627\u0644\u0645\u064a\u0646\u0627\u0621 \u0627\u0644\u0645\u0635\u0631\u064a',
    en: 'Egyptian port',
    hint: 'Alexandria, Port Said, Damietta, Ain Sokhna, Suez',
    found: (s) => /\b(alexandria|port said|damietta|sokhna|suez|dekheila)\b/i.test(s)
      || /\u0627\u0644\u0625\u0633\u0643\u0646\u062f\u0631\u064a\u0629|\u0628\u0648\u0631\u0633\u0639\u064a\u062f|\u062f\u0645\u064a\u0627\u0637|\u0627\u0644\u0633\u062e\u0646\u0629|\u0627\u0644\u0633\u0648\u064a\u0633/.test(s),
  },
  {
    key: 'gross_weight_kg',
    ar: '\u0627\u0644\u0648\u0632\u0646 \u0628\u0627\u0644\u0643\u064a\u0644\u0648',
    en: 'Gross weight in kg',
    found: (s) => /\d[\d.,]*\s*(kg|kgs|kilo|tonne|ton)\b/i.test(s) || /\u0643\u062c\u0645|\u0643\u064a\u0644\u0648/.test(s),
  },
  {
    key: 'incoterm',
    ar: '\u0634\u0631\u0637 \u0627\u0644\u062a\u0633\u0644\u064a\u0645',
    en: 'Incoterm',
    hint: 'EXW / FOB / CIF / DAP',
    found: (s) => /\b(EXW|FCA|FAS|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DDP)\b/.test(String(s).toUpperCase()),
  },
  {
    key: 'ready_date',
    ar: '\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062c\u0627\u0647\u0632\u064a\u0629',
    en: 'Cargo ready date',
    found: (s) => /\d{4}-\d{2}-\d{2}/.test(s)
      || /\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s)
      || /\bready\b\s*[:=]/i.test(s) || /\u062c\u0627\u0647\u0632/.test(s),
  },
];

const DOC_ITEMS = [
  ['\u0627\u0644\u0641\u0627\u062a\u0648\u0631\u0629 \u0627\u0644\u062a\u062c\u0627\u0631\u064a\u0629', 'Commercial invoice'],
  ['\u0645\u0633\u062a\u0646\u062f \u0627\u0644\u0646\u0642\u0644 \u0623\u0648 EUR.1', 'Transport document or EUR.1'],
  ['\u0631\u0642\u0645 MRN', 'MRN from the export country'],
  ['\u0631\u0642\u0645 ACID (\u0646\u0627\u0641\u0630\u0629)', 'ACID number (Nafeza)'],
];

/** The block a customer reads when we need more from them. */
/** Is anything a booking cannot exist without still unsaid? */
export function missingRequiredDetails(said) {
  const text = String(said ?? '');
  return DETAIL_ITEMS.some((item) => item.required && !item.found(text));
}

export function detailsNeededCard(said, { includeDocuments = true, opening = null } = {}) {
  const text = String(said ?? '');
  const missing = DETAIL_ITEMS.filter((item) => !item.found(text));

  const details = missing.map((i) => `${i.ar} / ${i.en}${i.hint ? ` (${i.hint})` : ''}`);
  const documents = includeDocuments
    ? DOC_ITEMS.map(([ar, en]) => `${ar} / ${en}`)
    : [];

  if (!details.length && !documents.length) return null;

  const body = checklistCard([
    { title: '\u{1F4DD} \u0645\u062d\u062a\u0627\u062c\u064a\u0646 \u0645\u0646\u0643 / What we still need', items: details },
    { title: '\u{1F4C4} \u0627\u0644\u0645\u0633\u062a\u0646\u062f\u0627\u062a - \u0627\u0628\u0639\u062a\u0647\u0627 \u062f\u0644\u0648\u0642\u062a\u064a \u0623\u0648 \u0628\u0639\u062f\u064a\u0646 / Documents - now or later', items: documents },
  ]);

  // The opening line lives inside the block, so the whole reply can be this
  // block and nothing else. Every sentence the model wrote around it repeated
  // the same items as a paragraph, which is what we are getting rid of.
  return opening ? `${opening}\n\n${body}` : body;
}

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

/**
 * One spelling per manufacturer. Customers write "Mercedes", the model writes
 * "Mercedes-Benz" a turn later, and comparing those two as text made an
 * unchanged booking look edited. It also keeps the operations list sortable.
 */
const MAKES = new Map(Object.entries({
  mercedes: 'Mercedes-Benz', mercedesbenz: 'Mercedes-Benz', benz: 'Mercedes-Benz', merc: 'Mercedes-Benz',
  volvo: 'Volvo', volvotrucks: 'Volvo',
  scania: 'Scania', man: 'MAN', mantrucks: 'MAN', daf: 'DAF', iveco: 'Iveco',
  renault: 'Renault', renaulttrucks: 'Renault', ford: 'Ford', fordtrucks: 'Ford',
  isuzu: 'Isuzu', hino: 'Hino', mitsubishi: 'Mitsubishi', toyota: 'Toyota',
  schmitz: 'Schmitz Cargobull', schmitzcargobull: 'Schmitz Cargobull',
  krone: 'Krone', kogel: 'Kögel', wielton: 'Wielton',
}));

/**
 * Does the customer's message ask for something to be different? Deliberately
 * narrow: "correct" is not here, because "yes that is correct" is agreement.
 */
/** The eleven Incoterms, so a customer's own words can settle which one. */
const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];

function requestedIncoterm(text) {
  const found = String(text ?? '').toUpperCase().match(/[A-Z]{3}/g)?.filter((w) => INCOTERMS.includes(w));
  if (!found?.length) return null;
  // "change EXW to FOB" names the old one first and the wanted one last.
  return found[found.length - 1];
}

/**
 * A plain "yes" to the summary - not a sentence that also asks for a change.
 * Short on purpose: "yes, but make it FOB" is a correction, not agreement.
 */
export function looksLikeAgreement(text) {
  const s = String(text ?? '').trim();
  if (!s || s.length > 80) return false;
  if (asksForChange(s)) return false;
  return /^(y|yes|yes\.|yeah|yep|ok|okay|sure|correct|confirm(ed)?|go ahead|book it|please book|that( ?i?s|'s)? ?(right|correct|all correct)|all (good|correct)|perfect|fine)\b/i.test(s)
    || /(نعم|ايوه|أيوه|تمام|ماشي|موافق|أكد|اكد|احجز|اححز|زبط|مظبوط)/.test(s)
    || /^(aiwa|aywa|tamam|mashi|ok+|tmam|zabt)\b/i.test(s);
}

export { asksForChange };

/**
 * Is damage reported anywhere, whatever field it landed in?
 *
 * The model moves the same sentence between notes and engine_condition from one
 * turn to the next. Compared field by field that looks like the customer
 * changing something, so a customer who said "yes, book it" was shown the same
 * card again and asked to confirm a second time. What they approved is that the
 * vehicle IS damaged, not which box we filed it in.
 */
function damageReported(a) {
  const text = `${a.engine_condition ?? ''} ${a.notes ?? ''}`.toLowerCase().trim();
  if (!text) return null;
  if (/\bno (damage|defect)|undamaged|not damaged|سليمة/.test(text)) return null;
  return /damag|broken|accident|not running|does not run|faulty|defect|تالف|حادث|معطل|مش بتمشي/.test(text)
    ? 'reported damage'
    : String(a.engine_condition ?? '').trim() ? 'condition noted' : null;
}

function asksForChange(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  return /\b(change|changing|instead|make it|update|edit|fix|wrong|incorrect|mistake|should be|actually|rather|no,)\b/i.test(s)
    || /غير|غيّر|بدل|بدّل|تعديل|عدل|عدّل|غلط|خطأ|مش صح|مش كده/.test(s)
    || /\b(ghalat|8alat|mesh|badal|3ayez\s+a8ayar|a3'ayar|a8ayar)\b/i.test(s);
}

export function canonicalMake(value) {
  const text = latinizeName(value);
  if (!text) return text;
  const key = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  return MAKES.get(key) ?? text;
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
