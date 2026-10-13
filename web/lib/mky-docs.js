/**
 * The papers MKY issues itself: the CMR, and the MRN declaration sheet.
 *
 * Every other document in this system is one a customer sent us. These go the
 * other way - Operations fills a form in, saves it, comes back to it, and
 * issues it as a PDF when it is right. The issued PDF is filed against the
 * booking like any other paper, so it is listed, opened, printed and sent from
 * the same places.
 *
 * WHY THE FIELDS LIVE HERE AND NOT IN THE BROWSER.
 *
 * The desk draws the form from this list, and the server fills the PDF from
 * the same list. One description of what a CMR is, so a field added here
 * appears on the screen and on the paper together, and neither can quietly
 * stop matching the other.
 *
 * Nothing is invented. Every value is prefilled from the booking, its
 * documents or the desk's settings, and anything we do not hold is left blank
 * for a person to type - a forwarding document with a guessed weight on it is
 * worse than one with a gap.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { db } from './supabase.js';
import { storeAt, BUCKET } from './storage.js';
import { companyPhone } from './settings.js';
import { config } from './config.js';

const ASSETS = fileURLToPath(new URL('../assets/', import.meta.url));
const FONT_DIR = path.join(ASSETS, 'fonts');
const AMIRI = path.join(FONT_DIR, 'Amiri-Regular.ttf');
const LOGO = path.join(ASSETS, 'mky-logo.png');

// The CMR is a red form the world over, and MKY's is the same red. The blue is
// theirs, read out of the label they print, and the two together are what their
// paperwork looks like.
const CMR_RED = '#d80b00';
const BRAND_BLUE = '#0070c0';
const INK = '#101820';
const MUTED = '#5b6b7c';
const RULE = '#9aa7b4';

// ---------------------------------------------------------------------------
// What is on each form
// ---------------------------------------------------------------------------

/**
 * `box` is the number printed on a real CMR, so a forwarder reading the screen
 * and a driver reading the paper are looking at the same thing.
 */
export const FORMS = {
  cmr: {
    title: 'CMR — international consignment note',
    note: 'The transport document for the road leg. MKY issues this one; it is not something the customer has to send.',
    fields: [
      { key: 'sender', label: 'Sender', box: 1, lines: 3, hint: 'Name, address, country' },
      { key: 'consignee', label: 'Consignee', box: 2, lines: 3, hint: 'Name, address, country' },
      { key: 'delivery_place', label: 'Place of delivery', box: 3, hint: 'Where the goods are delivered' },
      { key: 'taking_over', label: 'Place and date of taking over the goods', box: 4 },
      { key: 'annexed', label: 'Documents attached', box: 5, hint: 'Invoice, Brief, MRN…' },
      { key: 'marks', label: 'Marks and numbers', box: 6, hint: 'Usually the chassis number' },
      { key: 'packages', label: 'Number of packages', box: 7 },
      { key: 'packing', label: 'Method of packing', box: 8 },
      { key: 'goods', label: 'Nature of the goods', box: 9, lines: 2 },
      { key: 'weight', label: 'Gross weight', box: 11 },
      { key: 'instructions', label: 'Sender’s instructions', box: 13, lines: 2 },
      { key: 'carrier', label: 'Carrier', box: 16, lines: 3, hint: 'Name, address, country' },
      { key: 'reservations', label: 'Carrier’s reservations and observations', box: 18, lines: 2 },
      { key: 'agreements', label: 'Special agreements', box: 19, lines: 2 },
      { key: 'established', label: 'Established in', box: 21, hint: 'Place and date' },
    ],
  },
  mrn: {
    title: 'MRN — export declaration sheet',
    note: 'What was lodged, and the number that came back. The MRN itself is never generated here: it is typed exactly as customs issued it.',
    fields: [
      { key: 'mrn_number', label: 'MRN', hint: 'Exactly as issued, e.g. 26LTVR12345678901' },
      { key: 'office', label: 'Customs office of export' },
      { key: 'declaration_date', label: 'Date of declaration' },
      { key: 'exporter', label: 'Exporter', lines: 3 },
      { key: 'consignee', label: 'Consignee', lines: 3 },
      { key: 'vehicle', label: 'Vehicle', lines: 2, hint: 'Make, model, chassis' },
      { key: 'value', label: 'Value' },
      { key: 'origin_country', label: 'Country of origin' },
      { key: 'route', label: 'Route', hint: 'Port of loading → port of discharge' },
      { key: 'notes', label: 'Notes', lines: 2 },
    ],
  },
};

export const KINDS = Object.keys(FORMS);

/** Every blank a form has, as empty strings - the shape the desk draws. */
const blank = (kind) => Object.fromEntries(FORMS[kind].fields.map((f) => [f.key, '']));

// ---------------------------------------------------------------------------
// What we already know
// ---------------------------------------------------------------------------

const text = (v) => String(v ?? '').trim();
const join = (...parts) => parts.map(text).filter(Boolean).join('\n');

/**
 * The form as it would be if nobody had typed anything: filled from the
 * booking, the papers the customer sent and the desk's own settings.
 *
 * A reading from a document is used only where the document is the authority
 * on it - the seller on the invoice IS the sender, the weight on the invoice
 * IS the weight. Nothing is guessed from a resemblance.
 */
export async function prefill(kind, { booking = {}, documents = [], mrn = null } = {}) {
  // The carrier block starts as our name and whatever number the desk has set
  // for paperwork; the address is the operator's to type, because MKY loads
  // from more than one place and a wrong one on a CMR follows the lorry.
  const phone = await companyPhone().catch(() => null);
  const company = join(config.companyName || 'MKY Global Forwarding', phone ? `Tel ${phone}` : '');

  // The reader's best copy of each value, from the papers that carry it.
  const read = (key, types) => {
    for (const type of types) {
      const doc = documents.find((d) => d.doc_type === type && d.extracted?.[key]);
      if (doc) return text(doc.extracted[key]);
    }
    return '';
  };
  const seller = read('seller', ['invoice', 'cmr', 'brief']);
  const buyer = read('buyer', ['invoice', 'cmr']);
  const weight = read('gross_weight_kg', ['invoice', 'cmr', 'brief']);
  const amount = read('value_amount', ['invoice']);
  const currency = read('value_currency', ['invoice']);
  const originCountry = read('seller_country', ['invoice']);
  const attached = [...new Set(documents.map((d) => d.doc_type))]
    .filter((t) => ['invoice', 'brief', 'mrn', 'eur1', 'acid'].includes(t))
    .map((t) => ({ invoice: 'Invoice', brief: 'Brief', mrn: 'MRN', eur1: 'EUR.1', acid: 'ACID' }[t]))
    .join(', ');

  const vehicle = join([booking.make, booking.model].filter(Boolean).join(' '), booking.vin ? `Chassis ${booking.vin}` : '');

  if (kind === 'cmr') {
    return {
      ...blank('cmr'),
      sender: seller,
      consignee: buyer || text(booking.customer_name),
      delivery_place: text(booking.origin_port),
      annexed: attached,
      marks: text(booking.vin),
      packages: '1',
      packing: 'Unpacked, self-propelled',
      goods: [booking.make, booking.model].filter(Boolean).join(' '),
      weight: weight ? `${weight} kg` : '',
      carrier: company,
      established: text(booking.origin_port),
    };
  }

  return {
    ...blank('mrn'),
    mrn_number: text(booking.mrn_number || mrn?.mrn_number),
    exporter: seller,
    consignee: buyer || text(booking.customer_name),
    vehicle,
    value: amount ? `${amount}${currency ? ` ${currency}` : ''}` : '',
    origin_country: originCountry,
    route: [booking.origin_port, booking.destination_port].filter(Boolean).join(' → '),
  };
}

// ---------------------------------------------------------------------------
// Reading and writing the form
// ---------------------------------------------------------------------------

/** Only the keys this form has, trimmed and capped - never whatever was posted. */
export function clean(kind, values = {}) {
  const out = {};
  for (const field of FORMS[kind].fields) {
    out[field.key] = text(values[field.key]).slice(0, field.lines ? 600 : 200);
  }
  return out;
}

/** The saved form, or the prefilled one when there is none yet. */
export async function formFor(kind, bookingRef, context) {
  const { data: row, error } = await db().from('mky_documents')
    .select('*').eq('booking_ref', bookingRef).eq('kind', kind).maybeSingle();
  if (error && !isMissing(error)) console.error('mky document read failed:', error.message);

  const suggested = await prefill(kind, context);
  const saved = row?.fields ?? null;
  // A saved blank is still a blank: a field the operator cleared stays clear,
  // but one they never touched takes the suggestion.
  const values = saved
    ? Object.fromEntries(FORMS[kind].fields.map((f) => [f.key, Object.hasOwn(saved, f.key) ? text(saved[f.key]) : (suggested[f.key] ?? '')]))
    : suggested;

  return {
    kind,
    title: FORMS[kind].title,
    note: FORMS[kind].note,
    fields: FORMS[kind].fields,
    values,
    // A row at all means somebody has saved something; 'new' is only for a
    // form nobody has opened. (The column defaults to 'draft', but a saved row
    // is a draft whether or not the default did the saying.)
    status: row ? (row.status ?? 'draft') : 'new',
    document_no: row?.document_no ?? null,
    issued_at: row?.issued_at ?? null,
    issued_by: row?.issued_by ?? null,
    storage_path: row?.storage_path ?? null,
    available: !(error && isMissing(error)),
  };
}

const isMissing = (e) => /relation .* does not exist|could not find the table|42P01|PGRST205/i.test(String(e?.message ?? ''));

/** Saved, not issued: the half-filled form a person comes back to. */
export async function saveForm(kind, bookingRef, values, who) {
  const fields = clean(kind, values);
  const { error } = await db().from('mky_documents').upsert({
    booking_ref: bookingRef, kind, fields, updated_at: new Date().toISOString(),
  }, { onConflict: 'booking_ref,kind' });
  if (error) return { ok: false, unsupported: isMissing(error), error: error.message };
  return { ok: true, fields, by: who?.name ?? null };
}

/**
 * The paper itself: rendered, stored, and filed against the booking.
 *
 * The number is kept across re-issues - a CMR number that changed under a
 * driver who already has a copy is worse than no number at all.
 */
export async function issueForm(kind, bookingRef, values, who, context) {
  const fields = clean(kind, values);
  const { data: existing } = await db().from('mky_documents')
    .select('document_no, storage_path').eq('booking_ref', bookingRef).eq('kind', kind).maybeSingle();

  const documentNo = existing?.document_no ?? numberFor(kind, bookingRef);
  const at = new Date().toISOString();
  const buffer = await render(kind, { fields, documentNo, bookingRef, issuedAt: at, context });
  const fileName = `${documentNo}.pdf`;
  const storagePath = existing?.storage_path
    ?? `${context?.booking?.client_id ?? 'mky'}/${bookingRef}/${kind}-${documentNo}.pdf`;

  const stored = await storeAt(storagePath, buffer, 'application/pdf', { upsert: true });
  if (!stored?.ok && stored?.error) return { ok: false, error: stored.error };

  const { error } = await db().from('mky_documents').upsert({
    booking_ref: bookingRef, kind, fields, status: 'issued',
    document_no: documentNo, storage_path: storagePath,
    issued_at: at, issued_by: who?.name ?? null, updated_at: at,
  }, { onConflict: 'booking_ref,kind' });
  if (error) return { ok: false, unsupported: isMissing(error), error: error.message };

  await fileAgainstBooking({ kind, bookingRef, fileName, storagePath, size: buffer.length, who, context });
  return { ok: true, document_no: documentNo, storage_path: storagePath, issued_at: at, fileName };
}

/** MKY-CMR-<booking suffix>, which is short, unique per booking and readable. */
function numberFor(kind, bookingRef) {
  const tail = String(bookingRef).split('-').slice(-2).join('');
  return `${(config.refPrefix || 'MKY')}-${kind.toUpperCase()}-${tail || Date.now().toString(36).toUpperCase()}`;
}

/**
 * The issued paper, among the booking's documents - so it is listed, opened,
 * printed and sent from the same places as everything else. doc_type 'mky'
 * keeps it out of what the customer is asked for; chat_id null keeps it out of
 * the bot's own count of their papers.
 */
async function fileAgainstBooking({ kind, bookingRef, fileName, storagePath, size, who, context }) {
  const row = {
    booking_ref: bookingRef,
    chat_id: null,
    client_id: context?.booking?.client_id ?? null,
    channel: context?.booking?.channel ?? null,
    doc_type: 'mky',
    file_name: fileName,
    storage_path: storagePath,
    storage_bucket: BUCKET,
    mime_type: 'application/pdf',
    size_bytes: size,
    status: 'verified',
    uploaded_by: who?.name ?? null,
    extraction_ok: true,
    needs_ocr: false,
    extracted: { pending: false, ok: true, issued_by_mky: true, kind },
    vin: context?.booking?.vin ?? null,
  };
  const { data: already } = await db().from('booking_documents')
    .select('id').eq('booking_ref', bookingRef).eq('storage_path', storagePath).maybeSingle();
  const { error } = already
    ? await db().from('booking_documents').update({ size_bytes: size, uploaded_at: new Date().toISOString() }).eq('id', already.id)
    : await db().from('booking_documents').insert(row);
  if (error) console.error('filing an issued document failed:', error.message);
}

// ---------------------------------------------------------------------------
// The paper
// ---------------------------------------------------------------------------

/** The PDF itself. Exported so a test can read the paper, not just the row. */
export function render(kind, opts) {
  return kind === 'cmr' ? cmrPdf(opts) : mrnPdf(opts);
}

function newDoc() {
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  // Arabic in a customer's name must not print as blank boxes.
  try { doc.registerFont('ar', AMIRI); } catch { /* English only, then */ }
  return { doc, done };
}

const hasArabicText = (v) => /[؀-ۿ]/.test(String(v ?? ''));

/**
 * MKY's badge in the head of a paper they issue.
 *
 * The same one that is on their label and their confirmation sheet: a customer
 * who has seen one should recognise the others without reading a word.
 */
function badge(doc, x, y) {
  try {
    if (fs.existsSync(LOGO)) doc.image(LOGO, x + 3, y + 2, { height: 22 });
  } catch { /* the paper is still the paper without it */ }
}

/** One labelled box of the form, with its CMR number in the corner. */
function box(doc, { x, y, w, h, box: n, label, value }) {
  doc.save().lineWidth(0.7).strokeColor(RULE).rect(x, y, w, h).stroke().restore();
  doc.font('Helvetica').fontSize(6).fillColor(MUTED)
    .text(`${n ? `${n}  ` : ''}${label}`, x + 4, y + 3, { width: w - 8, lineBreak: false });
  const body = String(value ?? '').trim();
  if (!body) return;
  doc.font(hasArabicText(body) ? 'ar' : 'Helvetica-Bold').fontSize(9).fillColor(INK)
    .text(body, x + 4, y + 13, { width: w - 8, height: h - 16, ellipsis: true });
}

async function cmrPdf({ fields, documentNo, bookingRef, issuedAt }) {
  const { doc, done } = newDoc();
  const L = 36;
  const W = 523;
  const half = W / 2 - 3;
  const right = L + W / 2 + 3;

  doc.save().rect(L, 36, W, 26).fill(CMR_RED).restore();
  badge(doc, L, 36);
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text('CMR', L + 30, 42);
  doc.font('Helvetica').fontSize(8).fillColor('#ffffff')
    .text('INTERNATIONAL CONSIGNMENT NOTE · LETTRE DE VOITURE INTERNATIONALE', L + 70, 45, { width: W - 180 });
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff')
    .text(documentNo, L + W - 150, 45, { width: 142, align: 'right' });

  let y = 70;
  const F = (key) => fields[key] ?? '';

  box(doc, { x: L, y, w: half, h: 54, box: 1, label: 'Sender / Expéditeur', value: F('sender') });
  box(doc, { x: right, y, w: half, h: 54, box: 16, label: 'Carrier / Transporteur', value: F('carrier') });
  y += 54;
  box(doc, { x: L, y, w: half, h: 54, box: 2, label: 'Consignee / Destinataire', value: F('consignee') });
  box(doc, { x: right, y, w: half, h: 54, box: 17, label: 'Successive carriers', value: '' });
  y += 54;
  box(doc, { x: L, y, w: half, h: 34, box: 3, label: 'Place of delivery', value: F('delivery_place') });
  box(doc, { x: right, y, w: half, h: 34, box: 18, label: 'Carrier’s reservations and observations', value: F('reservations') });
  y += 34;
  box(doc, { x: L, y, w: half, h: 34, box: 4, label: 'Place and date of taking over the goods', value: F('taking_over') });
  box(doc, { x: right, y, w: half, h: 34, box: 19, label: 'Special agreements', value: F('agreements') });
  y += 34;
  box(doc, { x: L, y, w: half, h: 34, box: 5, label: 'Documents attached', value: F('annexed') });
  box(doc, { x: right, y, w: half, h: 34, box: 13, label: 'Sender’s instructions', value: F('instructions') });
  y += 34;

  // The goods, across the full width as the form has them.
  const cols = [
    { w: 150, box: 6, label: 'Marks and numbers', key: 'marks' },
    { w: 70, box: 7, label: 'Packages', key: 'packages' },
    { w: 110, box: 8, label: 'Method of packing', key: 'packing' },
    { w: 113, box: 9, label: 'Nature of the goods', key: 'goods' },
    { w: 80, box: 11, label: 'Gross weight', key: 'weight' },
  ];
  let x = L;
  for (const c of cols) {
    box(doc, { x, y, w: c.w, h: 52, box: c.box, label: c.label, value: F(c.key) });
    x += c.w;
  }
  y += 52;

  box(doc, { x: L, y, w: W, h: 30, box: 21, label: 'Established in / Opgemaakt te', value: F('established') });
  y += 30;

  // The three signatures a CMR carries, left for ink.
  const sigW = W / 3;
  for (const [i, [n, label]] of [[22, 'Signature and stamp of the sender'], [23, 'Signature and stamp of the carrier'], [24, 'Signature and stamp of the consignee']].entries()) {
    box(doc, { x: L + i * sigW, y, w: sigW, h: 64, box: n, label, value: '' });
  }
  y += 64;

  doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(
    `Issued by ${config.companyName || 'MKY Global Forwarding'} for booking ${bookingRef} on ${String(issuedAt).slice(0, 10)}.`,
    L, y + 8, { width: W },
  );

  doc.end();
  return done;
}

async function mrnPdf({ fields, documentNo, bookingRef, issuedAt }) {
  const { doc, done } = newDoc();
  const L = 36;
  const W = 523;

  doc.save().rect(L, 36, W, 26).fill(BRAND_BLUE).restore();
  badge(doc, L, 36);
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text('EXPORT DECLARATION', L + 30, 42);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff')
    .text(documentNo, L + W - 150, 45, { width: 142, align: 'right' });

  let y = 76;
  for (const field of FORMS.mrn.fields) {
    const h = field.lines ? 18 + field.lines * 12 : 30;
    box(doc, { x: L, y, w: W, h, label: field.label, value: fields[field.key] ?? '' });
    y += h;
  }

  doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(
    `Issued by ${config.companyName || 'MKY Global Forwarding'} for booking ${bookingRef} on ${String(issuedAt).slice(0, 10)}. `
    + 'The MRN is the number issued by customs and is recorded here exactly as issued.',
    L, y + 10, { width: W },
  );

  doc.end();
  return done;
}
