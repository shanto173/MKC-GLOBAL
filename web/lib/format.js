/**
 * Fixed layouts for the answers that carry data.
 *
 * The roadmap specifies what a tracking answer contains - status, vessel,
 * location, ETA - and a booking summary likewise. Left to write those freely
 * the model varies the wording, the order and sometimes which fields it
 * mentions at all, which is bad for a customer comparing two shipments and
 * worse for an operator reading a screenshot.
 *
 * So the block is built here, from the database row, and the model is told to
 * reproduce it verbatim and add at most one sentence around it. Labels are
 * bilingual on one line - "الحالة / Status" - rather than the whole card being
 * printed twice, which is what a bar-separated translation would mean.
 */

const L = {
  reference:   ['رقم الشحنة', 'Reference'],
  booking:     ['رقم الحجز', 'Booking'],
  chassis:     ['الشاسيه', 'Chassis'],
  vehicle:     ['المركبة', 'Vehicle'],
  condition:   ['حالة المركبة', 'Condition'],
  status:      ['الحالة', 'Status'],
  vessel:      ['السفينة', 'Vessel'],
  location:    ['الموقع', 'Location'],
  route:       ['خط الشحن', 'Route'],
  eta:         ['الوصول المتوقع', 'ETA'],
  etd:         ['المغادرة المتوقعة', 'ETD'],
  customer:    ['العميل', 'Customer'],
  company:     ['الشركة', 'Company'],
  contact:     ['وسيلة التواصل', 'Contact'],
  notes:       ['ملاحظات', 'Notes'],
  weight:      ['الوزن', 'Weight'],
  incoterm:    ['شرط التسليم', 'Incoterm'],
  ready:       ['تاريخ الجاهزية', 'Cargo ready'],
  mrn:         ['رقم MRN', 'MRN'],
  acid:        ['رقم ACID', 'ACID'],
  payment:     ['الدفع', 'Payment'],
  delivery:    ['التسليم', 'Delivery'],
  documents:   ['المستندات', 'Documents'],
  received:    ['وصلنا', 'Received'],
  missing:     ['ناقص', 'Still needed'],
  lastUpdate:  ['آخر تحديث', 'Last update'],
};

/**
 * Labels always carry both languages, whichever language the customer wrote in.
 * These cards get forwarded to drivers, brokers and customs agents who read one
 * or the other, and a card that arrives in the wrong one is useless to them.
 * The `lang` argument is kept because callers pass it; it no longer changes the
 * label, only which side reads first to the person holding the phone.
 */
const label = (key) => `${L[key][0]} / ${L[key][1]}`;

/** One "field: value" line, dropped entirely when there is no value. */
function line(key, value, lang) {
  if (value === null || value === undefined || value === '') return null;
  return `${label(key, lang)}: ${value}`;
}

const block = (title, lines) => [title, ...lines.filter(Boolean)].join('\n');

/**
 * The tracking answer. Roadmap section 2: status, vessel, location, ETA.
 * @param {object} s a shipments row, with recent_events attached
 */
export function shipmentCard(s, lang = 'en') {
  const vehicle = [s.make, s.model].filter(Boolean).join(' ') || s.cargo_description;
  const latest = s.recent_events?.[0];

  return block(`📦 ${s.shipment_id}${vehicle ? ` — ${vehicle}` : ''}`, [
    line('chassis', s.vin, lang),
    line('status', s.status, lang),
    line('vessel', s.vessel, lang),
    line('location', latest?.location, lang),
    line('route', `${s.origin_port} → ${s.destination_port}`, lang),
    line('etd', s.etd, lang),
    line('eta', s.eta, lang),
    line('payment', s.payment_status, lang),
    line('delivery', s.delivery_status, lang),
    line('booking', s.booking_ref, lang),
    latest ? line('lastUpdate', `${latest.description}${latest.event_time ? ` (${String(latest.event_time).slice(0, 10)})` : ''}`, lang) : null,
  ]);
}

/**
 * The booking summary, used both when asking the customer to confirm and when
 * telling them it is done. Roadmap step 4 lists chassis, make, route, client
 * and documents.
 */
export function bookingCard(b, lang = 'en', { documents = null } = {}) {
  const vehicle = [b.make, b.model].filter(Boolean).join(' ');
  // "telegram:6284..." is our own routing address, not something a customer
  // recognises as their contact details.
  const contact = /^(telegram|web|whatsapp):/i.test(String(b.customer_contact ?? ''))
    ? null
    : b.customer_contact;

  return block(`📋 ${b.booking_ref ?? ''}`.trim(), [
    line('chassis', b.vin, lang),
    line('vehicle', vehicle, lang),
    // Damage belongs on the summary the customer approves. It has been the
    // single most expensive thing to get wrong on a declaration.
    line('condition', b.engine_condition, lang),
    line('customer', b.customer_name, lang),
    // Everything the customer told us is on the card, because the card is what
    // they are agreeing to - and what is on the card is what gets compared if
    // they change something before confirming.
    line('company', b.company, lang),
    line('contact', contact, lang),
    line('route', `${b.origin_port} → ${b.destination_port}`, lang),
    line('weight', b.gross_weight_kg ? `${Number(b.gross_weight_kg).toLocaleString('en-US')} kg` : null, lang),
    line('incoterm', b.incoterm, lang),
    line('ready', b.ready_date, lang),
    line('mrn', b.mrn_number, lang),
    line('acid', b.acid_number, lang),
    line('notes', b.notes, lang),
    line('status', b.status?.replace(/_/g, ' '), lang),
    documents ? line('documents', documents, lang) : null,
  ]);
}

/**
 * The card pinned at the top of a chat. Deliberately terse: it is read at a
 * glance, over and over, by somebody who does not want to open anything.
 * Bilingual labels, because the pin is read by whoever opens the chat.
 */
export function pinnedCard(rows, extra = 0) {
  const blocks = rows.map((r) => {
    const head = [r.ref, r.vehicle].filter(Boolean).join(' · ');
    return [
      head,
      line('status', r.status, 'ar'),
      line('route', r.route, 'ar'),
      r.vessel ? line('vessel', r.vessel, 'ar') : null,
      r.eta ? line('eta', r.eta, 'ar') : null,
    ].filter(Boolean).join('\n');
  });

  const more = extra > 0 ? [`+${extra} أخرى / more`] : [];
  return [
    '📌 شحنتك / Your shipment',
    ...blocks,
    ...more,
    'اكتب 2 للتفاصيل / Send 2 for details',
  ].join('\n\n');
}

/**
 * "Here is what we still need." A short bilingual list, one item per line.
 *
 * Written here rather than by the model because the model writes it as a
 * paragraph - "please provide the make and model, your full name, the city or
 * port of loading, and..." - which nobody reads on a phone. Every line is one
 * thing, in both languages, so the customer can work down it.
 */
export function checklistCard(sections) {
  const blocks = sections
    .filter((s) => s.items?.length)
    .map((s) => [s.title, ...s.items.map((i) => `\u2022 ${i}`)].join('\n'));
  return blocks.join('\n\n');
}

/**
 * The departments, numbered, as the roadmap's contact panel has them.
 *
 * "Tell me what kind of help you need" is not a menu: the customer has to guess
 * what our desks are called. They pick a number instead, and the number cannot
 * be mistaken for the main menu because of what was on screen before it.
 */
export const DEPARTMENT_MENU = [
  ['\u0627\u0644\u062d\u062c\u0648\u0632\u0627\u062a', 'Booking Operations', '\u0637\u0644\u0628 \u062c\u062f\u064a\u062f\u060c \u062a\u0639\u062f\u064a\u0644 \u062d\u062c\u0632\u060c \u0645\u0633\u0627\u062d\u0629 \u0648\u0645\u0648\u0627\u0639\u064a\u062f', 'new requests, changes, space and schedules'],
  ['\u0627\u0644\u062d\u0633\u0627\u0628\u0627\u062a \u0648\u0627\u0644\u0645\u062f\u0641\u0648\u0639\u0627\u062a', 'Accounts & Payments', '\u0641\u0648\u0627\u062a\u064a\u0631\u060c \u062a\u062d\u0648\u064a\u0644\u0627\u062a\u060c \u0623\u0631\u0635\u062f\u0629', 'invoices, transfers, balances'],
  ['\u0645\u062a\u0627\u0628\u0639\u0629 \u0627\u0644\u0634\u062d\u0646\u0627\u062a', 'Tracking Desk', '\u0627\u0644\u0634\u062d\u0646\u0629 \u0641\u064a\u0646\u060c \u0645\u0648\u0627\u0639\u064a\u062f \u0627\u0644\u0648\u0635\u0648\u0644', 'where a shipment is, arrival dates'],
  ['\u0627\u0644\u0645\u0633\u062a\u0646\u062f\u0627\u062a \u0627\u0644\u062c\u0645\u0631\u0643\u064a\u0629', 'Customs Documentation', 'ACID\u060c MRN\u060c \u0634\u0647\u0627\u062f\u0627\u062a \u0627\u0644\u0645\u0646\u0634\u0623', 'ACID, MRN, certificates of origin'],
  ['\u062e\u062f\u0645\u0629 \u0627\u0644\u0639\u0645\u0644\u0627\u0621', 'Customer Care', '\u0623\u064a \u062d\u0627\u062c\u0629 \u062a\u0627\u0646\u064a\u0629 \u0623\u0648 \u0634\u0643\u0648\u0649', 'anything else, or a complaint'],
];

export function departmentsCard() {
  const lines = DEPARTMENT_MENU.map(([ar, en, arHint, enHint], i) =>
    `${i + 1} \u00b7 ${ar} / ${en}\n   ${arHint} / ${enHint}`);
  return [
    '\u{1F4AC} \u062a\u0648\u0627\u0635\u0644 \u0645\u0639 \u0641\u0631\u064a\u0642\u0646\u0627 / Contact our team',
    ...lines,
    '\u0627\u0628\u0639\u062a \u0631\u0642\u0645 \u0645\u0646 1 \u0644\u0640 5 / Reply with a number from 1 to 5',
  ].join('\n\n');
}

/** The document checklist: what arrived, what is still needed. */
export function documentsCard(status, lang = 'en') {
  const names = (list) => (list ?? []).map((d) => (typeof d === 'string' ? d : d.label));
  const received = [...new Set(names(status.received))];
  const wrongVehicle = status.wrong_vehicle_labels ?? [];
  const missing = status.missing_labels ?? [];
  const later = status.to_follow_labels ?? [];

  // Four buckets, because they mean four different things and a customer who
  // has sent three documents must never read "still missing" about one of them.
  const lines = [
    received.length ? `\u2705 \u0648\u0635\u0644\u0646\u0627 / Received: ${received.join(', ')}` : null,
    wrongVehicle.length
      ? `\u26a0\ufe0f \u0644\u0634\u0627\u0633\u064a\u0647 \u062a\u0627\u0646\u064a / Another chassis: ${wrongVehicle.join(', ')}`
      : null,
    missing.length
      ? `\u274c \u0644\u0633\u0647 \u0645\u062d\u062a\u0627\u062c\u064a\u0646 / Still needed: ${missing.join(', ')}`
      : `\u2705 \u0645\u0641\u064a\u0634 \u0646\u0627\u0642\u0635 / Nothing outstanding from you`,
    later.length
      ? `\u{1F552} \u0628\u0639\u062f\u064a\u0646 - \u0628\u064a\u0637\u0644\u0639 \u0645\u0646 \u0627\u0644\u0646\u0627\u0642\u0644 / Later, issued by the carrier: ${later.join(', ')}`
      : null,
  ].filter(Boolean);

  return block('\u{1F4C4} \u0627\u0644\u0645\u0633\u062a\u0646\u062f\u0627\u062a / Documents', lines);
}

/**
 * What one document turned out to be, said plainly: the file, what we read off
 * it, and whether it belongs to the vehicle being booked.
 */
export function documentReadCard(result, status, bookingVin = null) {
  const found = result?.extracted ?? {};
  const vin = found.vin ?? null;
  const mismatch = Boolean(bookingVin && vin && normalise(vin) !== normalise(bookingVin));

  const lines = [
    found.doc_type && found.doc_type !== 'other'
      ? `\u0627\u0644\u0646\u0648\u0639 / Type: ${found.doc_type.toUpperCase()}`
      : null,
    vin ? `\u0627\u0644\u0634\u0627\u0633\u064a\u0647 / Chassis: ${vin}` : null,
    found.mrn ? `\u0631\u0642\u0645 MRN / MRN: ${found.mrn}` : null,
    found.acid ? `\u0631\u0642\u0645 ACID / ACID: ${found.acid}` : null,
    mismatch
      ? `\u26a0\ufe0f \u0627\u0644\u0645\u0633\u062a\u0646\u062f \u062f\u0647 \u0644\u0634\u0627\u0633\u064a\u0647 \u062a\u0627\u0646\u064a / This document is for a different chassis (${bookingVin})`
      : null,
  ].filter(Boolean);

  const head = `\u{1F4C4} ${result?.document?.file_name ?? 'document'}`;
  return [block(head, lines.length ? lines : ['\u2014']), documentsCard(status)].join('\n\n');
}

const normalise = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

