/**
 * Reads shipping paperwork and pulls out the fields a booking needs.
 *
 * Real documents from this trade lane arrive in four languages - a Polish
 * pro-forma invoice, a Romanian export accompanying document, an Arabic ACID
 * printout from Nafeza, an English EUR.1 - and some are scans with no text at
 * all. So this works in two stages:
 *
 *   1. Deterministic regex for the identifiers that have a fixed shape (VIN,
 *      MRN, ACID, EUR.1). These must never be guessed, because a wrong VIN
 *      means customs rejects the declaration.
 *   2. The language model for the soft fields (make, model, parties, route),
 *      which vary by country and template.
 *
 * Stage 1 runs first and wins: anything it finds is authoritative, and the
 * model is told not to contradict it.
 */

import { chat } from './llm.js';

// ---------------------------------------------------------------------------
// Identifier patterns
// ---------------------------------------------------------------------------

/**
 * ISO 3779 VIN: 17 characters, no I, O or Q. Real chassis numbers on older
 * trucks are sometimes shorter, so a looser fallback is tried second and
 * reported with lower confidence.
 */
const VIN_STRICT = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
const VIN_LOOSE = /\b(?:VIN|SS|CHASSIS|SASIU|NADWOZIE)[\s.:#]*([A-Z0-9]{10,20})\b/gi;

/** Egyptian ACID: 19 digits, issued by the Nafeza single window. */
const ACID = /\b\d{19}\b/g;

/** EU MRN: 2-digit year, 2-letter country, 13 alphanumerics. e.g. 26ROBU1400X38145B3 */
const MRN = /\b\d{2}[A-Z]{2}[A-Z0-9]{13,14}\b/g;

/** EUR.1 movement certificate serial, e.g. "EUR.1 Nr. AA 0039958" */
const EUR1 = /EUR\.?\s*1[^A-Z0-9]{0,12}([A-Z]{0,2}\s?\d{6,8})\b/i;

const CURRENCY = /\b(EUR|USD|PLN|RON|EGP|GBP)\b/g;

/** Words that identify the document type, across the languages we actually see. */
const DOC_TYPE_HINTS = [
  { type: 'invoice', words: ['pro forma', 'proforma', 'invoice', 'faktura', 'fattura', 'rechnung', 'facture', 'sprzedawca', 'nabywca', 'do zapłaty'] },
  { type: 'mrn', words: ['export accompanying', 'document de însoţire de export', 'document de insotire', 'ausfuhrbegleitdokument', 'mrn', 'declarant', 'b.v. export'] },
  { type: 'eur1', words: ['eur.1', 'eur 1', 'movement certificate', 'certificat de circulaţie', 'certificat de circulatie', 'circulation des marchandises'] },
  { type: 'acid', words: ['acid', 'aci', 'nafeza', 'نافذة', 'الرقم التعريفي', 'مسجل'] },
  { type: 'brief', words: ['cmr', 'bill of lading', 'waybill', 'packing list'] },
];

// ---------------------------------------------------------------------------
// Arabic text repair
// ---------------------------------------------------------------------------

/**
 * Arabic PDFs (the Nafeza ACID printout in particular) store text as
 * presentation forms in VISUAL order, so naive extraction yields reversed,
 * unjoinable text. Map the presentation forms back to their base letters and
 * reverse the run, or the knowledge base fills up with garbage.
 */
export function repairArabic(text) {
  if (!/[ﭐ-﷿ﹰ-﻿]/.test(text)) return text;

  return text
    .split('\n')
    .map((line) => {
      if (!/[ﭐ-﷿ﹰ-﻿]/.test(line)) return line;
      const normalised = line.normalize('NFKC');
      const arabic = (normalised.match(/[؀-ۿ]/g) || []).length;
      const latin = (normalised.match(/[A-Za-z0-9]/g) || []).length;
      return arabic > latin ? unreverseVisualLine(normalised) : normalised;
    })
    .join('\n');
}

/**
 * Turn one visually-ordered Arabic line back into logical order.
 *
 * Reversing the whole line is not enough: numbers and Latin words inside it run
 * left-to-right even in Arabic text, so a plain reversal turns the ACID number
 * 5403381091024510014 into 4100154201901833045. That is a valid-looking 19-digit
 * number for the wrong shipment, and nothing downstream would ever notice.
 * So we reverse the line, then flip each Latin/number run back.
 */
function unreverseVisualLine(line) {
  const reversed = [...line].reverse().join('');
  return reversed.replace(
    /[A-Za-z0-9]+(?:[ .,\/:_@+-]+[A-Za-z0-9]+)*/g,
    (run) => [...run].reverse().join(''),
  );
}

// ---------------------------------------------------------------------------
// Stage 1 - deterministic
// ---------------------------------------------------------------------------

export function extractIdentifiers(rawText) {
  const text = repairArabic(String(rawText ?? ''));
  const upper = text.toUpperCase();

  // A VIN always mixes letters and digits. A pure number is a tax id, an ACID,
  // an invoice number or a phone number - never a chassis. Getting this wrong
  // puts the wrong VIN on a customs declaration, so both patterns are filtered.
  const looksLikeVin = (s) => /[A-Z]/.test(s) && /\d/.test(s) && !/^\d+$/.test(s);

  const vins = new Set();
  for (const m of upper.matchAll(VIN_STRICT)) {
    if (looksLikeVin(m[0])) vins.add(m[0]);
  }
  const labelledVins = new Set();
  for (const m of upper.matchAll(VIN_LOOSE)) {
    if (looksLikeVin(m[1])) labelledVins.add(m[1]);
  }

  // A labelled chassis number outranks a bare 17-char match.
  const vin = [...labelledVins].find((v) => vins.has(v)) ?? [...labelledVins][0] ?? [...vins][0] ?? null;

  const mrns = [...new Set([...upper.matchAll(MRN)].map((m) => m[0]))]
    // An MRN and a VIN can both be 17-18 chars; never report the VIN as an MRN.
    .filter((m) => m !== vin);

  const acids = [...new Set([...text.matchAll(ACID)].map((m) => m[0]))];
  const eur1 = text.match(EUR1)?.[1]?.replace(/\s+/g, ' ').trim() ?? null;

  return {
    vin,
    vin_candidates: [...new Set([...labelledVins, ...vins])],
    mrn: mrns[0] ?? null,
    acid: acids[0] ?? null,
    eur1,
    currencies: [...new Set([...upper.matchAll(CURRENCY)].map((m) => m[0]))],
  };
}

export function guessDocType(rawText) {
  const text = repairArabic(String(rawText ?? '')).toLowerCase();
  let best = { type: 'other', score: 0 };
  for (const { type, words } of DOC_TYPE_HINTS) {
    const score = words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
    if (score > best.score) best = { type, score };
  }
  return best.type;
}

// ---------------------------------------------------------------------------
// Stage 2 - the model reads the soft fields
// ---------------------------------------------------------------------------

const EXTRACT_SYSTEM = `You read freight and customs paperwork for a company that
imports used commercial vehicles into Egypt. Documents arrive in English, Polish,
Romanian, Italian, Lithuanian or Arabic.

Return ONLY a JSON object, no commentary, with these keys (use null when the
document does not state something - never guess):

{
  "doc_type": "invoice" | "mrn" | "eur1" | "acid" | "brief" | "other",
  "vin": string|null,              // chassis / VIN exactly as printed
  "make": string|null,             // e.g. "Mercedes-Benz"
  "model": string|null,            // e.g. "Actros 1845"
  "vehicle_type": string|null,     // truck, tractor unit, trailer, car
  "engine_condition": string|null, // note any stated damage, in English
  "gross_weight_kg": number|null,
  "value_amount": number|null,
  "value_currency": string|null,
  "seller": string|null,           // exporter / seller company
  "seller_country": string|null,   // ISO country name in English
  "buyer": string|null,            // importer / consignee
  "buyer_country": string|null,
  "origin_place": string|null,     // city or port of loading
  "destination_place": string|null,
  "incoterm": string|null,
  "document_date": string|null,    // YYYY-MM-DD
  "notes": string|null             // anything an operator must know
}

Translate company names and places into Latin script but keep them recognisable.
Report weights in kilograms. If a value is written "8 000,00" read it as 8000.00.

NEVER CALCULATE ANYTHING. Copy figures exactly as printed. Do not convert
currencies, do not apply an exchange rate, do not add or total values. A customs
document often prints an invoice currency and a separate national accounting
currency: report the INVOICE amount and the INVOICE currency, and if you cannot
tell which is which, return null. A wrong number on a customs declaration is far
worse than a missing one. Concretely: a Romanian export document prints both
"Suma totala facturata" with "Mon.fact." (the invoice currency, which is what you
report) and a national accounting total in RON, which you must ignore.

"vin" must be a chassis number: letters and digits mixed, usually 17 characters.
A field of digits only is never a VIN - it is a tax number, an ACID, or an
invoice number. Return null rather than a number you are unsure about.`;

/**
 * Read one document. Deterministic identifiers always override the model.
 *
 * @param {string} text  the document's extracted text
 * @param {{fileName?: string}} [meta]
 */
export async function extractDocument(text, meta = {}) {
  const clean = repairArabic(String(text ?? '')).trim();
  const ids = extractIdentifiers(clean);
  const guessed = guessDocType(clean);

  if (!clean || clean.length < 40) {
    return {
      ok: false,
      needs_ocr: true,
      doc_type: guessed,
      ...ids,
      message:
        'This file has no readable text - it is a scan or a photo. It must be read by a person, or OCR must be enabled.',
    };
  }

  let model = {};
  try {
    const { content } = await chat({
      system: EXTRACT_SYSTEM,
      messages: [
        {
          role: 'user',
          content:
            `File name: ${meta.fileName ?? 'unknown'}\n` +
            `Identifiers already found by exact pattern match (these are correct, do not contradict them): ` +
            `${JSON.stringify({ vin: ids.vin, mrn: ids.mrn, acid: ids.acid, eur1: ids.eur1 })}\n\n` +
            `--- DOCUMENT TEXT ---\n${clean.slice(0, 12_000)}`,
        },
      ],
      tools: [],
    });
    model = parseJson(content);
  } catch (err) {
    console.error('document extraction failed:', err.message);
    return { ok: false, doc_type: guessed, ...ids, message: `Could not read the document: ${err.message}` };
  }

  return {
    ok: true,
    needs_ocr: false,
    // Pattern matches win over the model for anything with a fixed shape.
    doc_type: model.doc_type ?? guessed,
    // The model's VIN is accepted only if it looks like a chassis number, so a
    // tax id or an ACID can never slip through as a VIN.
    vin: ids.vin ?? (isVinShaped(model.vin) ? String(model.vin).toUpperCase() : null),
    mrn: ids.mrn ?? null,
    acid: ids.acid ?? null,
    eur1: ids.eur1 ?? null,
    make: model.make ?? null,
    model: model.model ?? null,
    vehicle_type: model.vehicle_type ?? null,
    engine_condition: model.engine_condition ?? null,
    gross_weight_kg: num(model.gross_weight_kg),
    value_amount: num(model.value_amount),
    value_currency: model.value_currency ?? ids.currencies[0] ?? null,
    seller: model.seller ?? null,
    seller_country: model.seller_country ?? null,
    buyer: model.buyer ?? null,
    buyer_country: model.buyer_country ?? null,
    origin_place: model.origin_place ?? null,
    destination_place: model.destination_place ?? null,
    incoterm: model.incoterm ?? null,
    document_date: model.document_date ?? null,
    notes: model.notes ?? null,
  };
}

/**
 * Cross-check a set of documents for one booking.
 *
 * The check that actually matters: the VIN must be identical on every document.
 * A mismatch between the invoice and the MRN gets the customs declaration
 * rejected, and it is exactly the kind of typo a human misses.
 */
export function crossCheck(docs) {
  const problems = [];
  const seen = new Map();

  for (const d of docs) {
    if (!d?.vin) continue;
    const key = String(d.vin).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(d.doc_type ?? 'document');
  }

  if (seen.size > 1) {
    problems.push({
      severity: 'blocking',
      field: 'vin',
      message:
        'The chassis number is not the same on every document: ' +
        [...seen.entries()].map(([vin, types]) => `${vin} on the ${types.join(' and ')}`).join('; ') +
        '. Customs will reject the declaration. Ask the client which is correct.',
    });
  }

  const weights = docs.map((d) => d?.gross_weight_kg).filter((w) => typeof w === 'number' && w > 0);
  if (weights.length > 1 && Math.max(...weights) - Math.min(...weights) > 1) {
    problems.push({
      severity: 'warning',
      field: 'gross_weight_kg',
      message: `Gross weight differs between documents: ${[...new Set(weights)].join(' kg, ')} kg.`,
    });
  }

  return {
    vin: seen.size === 1 ? [...seen.keys()][0] : null,
    consistent: problems.filter((p) => p.severity === 'blocking').length === 0,
    problems,
  };
}

/** Which of the required documents are still missing. */
export const REQUIRED_DOCS = ['invoice', 'brief', 'mrn'];

export function missingDocuments(docs, { mrnNeeded = false } = {}) {
  const have = new Set(docs.map((d) => d?.doc_type).filter(Boolean));
  // EUR.1 and other origin paperwork both satisfy the "brief" requirement.
  if (have.has('eur1')) have.add('brief');
  // If MKY is issuing the MRN, the client is not expected to supply one.
  const required = mrnNeeded ? REQUIRED_DOCS.filter((d) => d !== 'mrn') : REQUIRED_DOCS;
  return required.filter((d) => !have.has(d));
}

// ---------------------------------------------------------------------------

function parseJson(content) {
  const text = String(content ?? '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) return {};
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return {};
  }
}

/** A chassis number mixes letters and digits; a pure number never is one. */
function isVinShaped(v) {
  const s = String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length >= 10 && s.length <= 20 && /[A-Z]/.test(s) && /\d/.test(s);
}

function num(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}
