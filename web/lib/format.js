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

const label = (key, lang) => (lang === 'ar' ? `${L[key][0]} / ${L[key][1]}` : L[key][1]);

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

/** The document checklist: what arrived, what is still needed. */
export function documentsCard(status, lang = 'en') {
  const received = (status.received ?? []).map((d) => d.label).join(', ');
  const missing = (status.missing_labels ?? []).join(', ');

  return block(`📄 ${label('documents', lang)}`, [
    line('received', received || (lang === 'ar' ? 'لا شيء بعد' : 'nothing yet'), lang),
    line('missing', missing || (lang === 'ar' ? 'لا شيء — مكتمل' : 'nothing — complete'), lang),
  ]);
}
