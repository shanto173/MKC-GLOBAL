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
import { companyPhone, settings } from './settings.js';
import { letterhead } from './letterhead.js';
import { code128 } from './code128.js';
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
  // The letterhead's contact line, from the desk's Settings - never a default.
  const [phone, table] = await Promise.all([
    companyPhone().catch(() => null),
    settings().catch(() => ({})),
  ]);
  const buffer = await render(kind, {
    fields, documentNo, bookingRef, issuedAt: at, context,
    phone, email: table.operations_email || config.companyEmail || null,
  });
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
 * One labelled box of the form, with its CMR number in the corner.
 *
 * `strong` draws the heavy border the CMR uses for the boxes the carrier fills
 * and the EAD uses around the MRN.
 */
function box(doc, { x, y, w, h, box: n, label, sub = null, value, strong = false }) {
  doc.save().lineWidth(strong ? 1.6 : 0.7).strokeColor(strong ? INK : RULE).rect(x, y, w, h).stroke().restore();
  doc.font('Helvetica-Bold').fontSize(6).fillColor(MUTED)
    .text(latin(`${n ? `${n}  ` : ''}${label}`), x + 4, y + 3, { width: w - 8, lineBreak: false });
  // The second language, as the international forms carry it.
  if (sub) {
    doc.font('Helvetica-Oblique').fontSize(5.5).fillColor(MUTED)
      .text(latin(sub), x + 4, y + 11, { width: w - 8, lineBreak: false });
  }
  const body = String(value ?? '').trim();
  if (!body) return;
  const arabic = hasArabicText(body);
  doc.font(arabic ? 'ar' : 'Helvetica-Bold').fontSize(9).fillColor(INK)
    .text(arabic ? body : latin(body), x + 4, y + (sub ? 20 : 13), { width: w - 8, height: h - (sub ? 23 : 16), ellipsis: true });
}

/**
 * The route is stored with an arrow - "Monfalcone > Alexandria" reads worse on
 * screen - and Helvetica's encoding has no arrow, so pdfkit printed it as two
 * punctuation marks. Written in the characters the font actually has.
 */
const latin = (v) => String(v ?? '').replace(/→/g, '>').replace(/←/g, '<');

const L = 36;
const W = 523;

/**
 * The head every issued paper carries: MKY's letterhead, then what the sheet
 * is and its number.
 */
function sheetHead(doc, { title, subtitle, documentNo, phone, email, colour }) {
  let y = letterhead(doc, { left: L, right: L + W, top: 30, phone, email }) + 4;

  doc.font('Helvetica-Bold').fontSize(14).fillColor(colour).text(title, L, y, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
    .text(documentNo, L, y + 2, { width: W, align: 'right' });
  y += 17;
  doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED).text(subtitle, L, y, { lineBreak: false });
  return y + 16;
}

async function cmrPdf({ fields, documentNo, bookingRef, issuedAt, phone = null, email = null }) {
  const { doc, done } = newDoc();
  const half = W / 2 - 3;
  const right = L + W / 2 + 3;

  let y = sheetHead(doc, {
    title: 'CMR — INTERNATIONAL CONSIGNMENT NOTE',
    subtitle: 'Lettre de voiture internationale · Convention CMR, Geneva 1956. Copy 1 sender · Copy 2 consignee · Copy 3 carrier.',
    documentNo, phone, email, colour: CMR_RED,
  });

  const F = (key) => fields[key] ?? '';

  // Left column is the sender's to fill, right column the carrier's - which is
  // why the right-hand boxes carry the heavy border on the printed form.
  box(doc, { x: L, y, w: half, h: 62, box: 1, label: 'Sender', sub: 'Expéditeur (name, address, country)', value: F('sender') });
  box(doc, { x: right, y, w: half, h: 62, box: 16, label: 'Carrier', sub: 'Transporteur (name, address, country)', value: F('carrier'), strong: true });
  y += 62;
  box(doc, { x: L, y, w: half, h: 62, box: 2, label: 'Consignee', sub: 'Destinataire (name, address, country)', value: F('consignee') });
  box(doc, { x: right, y, w: half, h: 62, box: 17, label: 'Successive carriers', sub: 'Transporteurs successifs', value: '', strong: true });
  y += 62;
  box(doc, { x: L, y, w: half, h: 38, box: 3, label: 'Place of delivery of the goods', sub: 'Lieu prévu pour la livraison', value: F('delivery_place') });
  box(doc, { x: right, y, w: half, h: 54, box: 18, label: 'Carrier’s reservations and observations', sub: 'Réserves et observations du transporteur', value: F('reservations'), strong: true });
  y += 38;
  box(doc, { x: L, y, w: half, h: 38, box: 4, label: 'Place and date of taking over the goods', sub: 'Lieu et date de la prise en charge', value: F('taking_over') });
  y += 16;
  box(doc, { x: right, y, w: half, h: 38, box: 19, label: 'Special agreements', sub: 'Conventions particulières', value: F('agreements') });
  y += 22;
  box(doc, { x: L, y, w: half, h: 38, box: 5, label: 'Documents attached', sub: 'Documents annexés', value: F('annexed') });
  box(doc, { x: right, y, w: half, h: 38, box: 13, label: 'Sender’s instructions', sub: 'Instructions de l’expéditeur', value: F('instructions') });
  y += 38;

  // The goods, across the full width as the form has them. The boxes we hold no
  // value for are drawn empty rather than left off: a CMR missing box 10 or 12
  // is not a CMR, and a driver fills them by hand.
  const cols = [
    { w: 128, box: 6, label: 'Marks and Nos', sub: 'Marques et numéros', key: 'marks' },
    { w: 52, box: 7, label: 'Packages', sub: 'Nombre', key: 'packages' },
    { w: 85, box: 8, label: 'Method of packing', sub: 'Mode d’emballage', key: 'packing' },
    { w: 118, box: 9, label: 'Nature of the goods', sub: 'Nature de la marchandise', key: 'goods' },
    { w: 70, box: 10, label: 'Statistical No', sub: 'No statistique', key: null },
    { w: 70, box: 11, label: 'Gross weight kg', sub: 'Poids brut', key: 'weight' },
  ];
  let x = L;
  for (const c of cols) {
    box(doc, { x, y, w: c.w, h: 58, box: c.box, label: c.label, sub: c.sub, value: c.key ? F(c.key) : '' });
    x += c.w;
  }
  y += 58;

  const third = W / 3;
  box(doc, { x: L, y, w: third, h: 34, box: 12, label: 'Volume m³', sub: 'Cubage', value: '' });
  box(doc, { x: L + third, y, w: third, h: 34, box: 14, label: 'Directions to freight payment', sub: 'Prescriptions d’affranchissement', value: '' });
  box(doc, { x: L + third * 2, y, w: third, h: 34, box: 15, label: 'Reimbursement', sub: 'Remboursement', value: '' });
  y += 34;

  box(doc, { x: L, y, w: half, h: 46, box: 20, label: 'To be paid by', sub: 'À payer par — sender / consignee', value: '' });
  box(doc, { x: right, y, w: half, h: 46, box: 21, label: 'Established in', sub: 'Établie à — place and date', value: F('established') });
  y += 46;

  // The three signatures a CMR carries, left for ink.
  const sigW = W / 3;
  const sigs = [
    [22, 'Signature and stamp of the sender', 'Signature et timbre de l’expéditeur'],
    [23, 'Signature and stamp of the carrier', 'Signature et timbre du transporteur'],
    [24, 'Goods received — signature of consignee', 'Réception des marchandises'],
  ];
  for (const [i, [n, label, sub]] of sigs.entries()) {
    box(doc, { x: L + i * sigW, y, w: sigW, h: 78, box: n, label, sub, value: '' });
  }
  y += 78;

  doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(
    `Issued by ${config.companyName || 'MKY Global Forwarding'} for booking ${bookingRef} on ${String(issuedAt).slice(0, 10)}. `
    + 'This carriage is subject notwithstanding any clause to the contrary to the Convention on the Contract for the '
    + 'International Carriage of Goods by Road (CMR).',
    L, y + 8, { width: W },
  );

  doc.end();
  return done;
}

/**
 * The MRN sheet, drawn as an Export Accompanying Document is drawn.
 *
 * The EU printout guidelines put the MRN in a heavy-bordered box with the
 * number repeated as a Code 128-B bar code beside it, and that bar code is what
 * a customs office scans at the office of exit. Everything else is MKY's own
 * letterhead, because this sheet is MKY's own record of what was lodged - the
 * MRN itself is only ever the number customs issued, typed as issued.
 */
async function mrnPdf({ fields, documentNo, bookingRef, issuedAt, phone = null, email = null }) {
  const { doc, done } = newDoc();

  let y = sheetHead(doc, {
    title: 'EXPORT ACCOMPANYING DOCUMENT',
    subtitle: 'Document d’accompagnement export · Declaration lodged with the customs office of export.',
    documentNo, phone, email, colour: BRAND_BLUE,
  });

  // The MRN, in the box the guidelines describe, with the bar code under it.
  const mrnNumber = String(fields.mrn_number ?? '').trim();
  const mrnH = 56;
  box(doc, { x: L, y, w: W, h: mrnH, label: 'MRN — MOVEMENT REFERENCE NUMBER', sub: 'Numéro de référence du mouvement', value: '', strong: true });
  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK)
    .text(mrnNumber || '—', L + 8, y + 24, { lineBreak: false });
  if (mrnNumber) code128(doc, mrnNumber, { x: L + W / 2, y: y + 18, width: W / 2 - 10, height: 30 });
  y += mrnH;

  // The declaration's own boxes, two to a row where they are short.
  const half = W / 2;
  const pairs = [
    [['office', 'Customs office of export', 'Bureau de douane d’exportation'], ['declaration_date', 'Date of declaration', 'Date de la déclaration']],
    [['exporter', 'Consignor / Exporter', 'Expéditeur / Exportateur'], ['consignee', 'Consignee', 'Destinataire']],
    [['origin_country', 'Country of export', 'Pays d’exportation'], ['value', 'Statistical value', 'Valeur statistique']],
  ];
  for (const [left, rightCol] of pairs) {
    const h = left[0] === 'exporter' ? 70 : 32;
    box(doc, { x: L, y, w: half, h, label: left[1], sub: left[2], value: fields[left[0]] ?? '' });
    box(doc, { x: L + half, y, w: half, h, label: rightCol[1], sub: rightCol[2], value: fields[rightCol[0]] ?? '' });
    y += h;
  }

  box(doc, { x: L, y, w: W, h: 48, box: 31, label: 'Packages and description of goods', sub: 'Colis et désignation des marchandises', value: fields.vehicle ?? '' });
  y += 48;
  box(doc, { x: L, y, w: W, h: 32, label: 'Route', sub: 'Port of loading → port of discharge', value: fields.route ?? '' });
  y += 32;
  box(doc, { x: L, y, w: W, h: 44, box: 44, label: 'Additional information, documents produced', sub: 'Mentions spéciales, documents produits', value: fields.notes ?? '' });
  y += 44;

  // Where the office of export writes its result, as the EAD has it.
  box(doc, { x: L, y, w: W, h: 56, label: 'CONTROL BY THE OFFICE OF EXPORT', sub: 'Résultat du contrôle · stamp, date and signature', value: '', strong: true });
  y += 56;

  doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(
    `Issued by ${config.companyName || 'MKY Global Forwarding'} for booking ${bookingRef} on ${String(issuedAt).slice(0, 10)}. `
    + 'The MRN is the number issued by customs and is recorded here exactly as issued.',
    L, y + 10, { width: W },
  );

  doc.end();
  return done;
}
