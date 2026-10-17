/**
 * The document classifier.
 *
 * These exist because of one failure: a CMR consignment note was read as an
 * invoice. Freight paperwork cross-references everything else in the file - a
 * consignment note lists the invoice number and the MRN, an invoice cites the
 * EUR.1 - so counting keyword hits anywhere in the text classifies documents by
 * what they MENTION rather than what they ARE. The client was then asked for a
 * transport document they had already sent, and the invoice requirement was
 * satisfied by something that was not an invoice.
 *
 *   npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { guessDocType } from '../lib/extract.js';

const CMR = `CMR
INTERNATIONAL CONSIGNMENT NOTE
Lettre de voiture internationale
No. CMR-6101726    Date: 2026-09-19

1 · SENDER
Name  UAB V.I.P INVESTMENT
6-12 · GOODS
Marks and numbers  VIN W1T96340310484233
Attached documents  Invoice INV-2026-4471, EUR.1 AA 1017269, MRN 26LTVR610172694233
16 · CARRIER
Name  UAB Baltic Auto Logistics`;

const INVOICE = `COMMERCIAL INVOICE
Handelsrechnung
No. INV-2026-4471    Date: 2026-09-18

SELLER
Name  UAB V.I.P INVESTMENT
GOODS
VIN / Chassis No.  W1T96340310484233
Total amount  18,500.00 EUR
EUR.1 certificate  EUR.1 Nr. AA 1017269`;

const DECLARATION = `UNIUNEA EUROPEANĂ
DOCUMENT DE ÎNSOŢIRE DE EXPORT
EXPORT ACCOMPANYING DOCUMENT · AUSFUHRBEGLEITDOKUMENT
MRN  26LTVR610172694233
Declarant  UAB V.I.P INVESTMENT
Invoice  INV-2026-4471`;

test('a consignment note is a CMR, not the invoice it names - and not a Brief', () => {
  // The Brief is the vehicle's title; a CMR is the journey. They were one type
  // until an owner pointed out that the desk was calling a registration
  // document a transport document.
  assert.equal(guessDocType(CMR), 'cmr');
});

test('an invoice is an invoice, even though it cites a EUR.1', () => {
  assert.equal(guessDocType(INVOICE), 'invoice');
});

test('an export declaration is an MRN, even though it names the invoice', () => {
  assert.equal(guessDocType(DECLARATION), 'mrn');
});

test('the heading decides, not a passing mention further down', () => {
  // Same body, opposite headings. If the classifier read the body it would give
  // the same answer twice.
  const asInvoice = `COMMERCIAL INVOICE\nNo. 1\n\n${CMR.split('\n').slice(4).join('\n')}`;
  const asNote = `CMR CONSIGNMENT NOTE\nNo. 1\n\n${INVOICE.split('\n').slice(3).join('\n')}`;

  assert.equal(guessDocType(asInvoice), 'invoice');
  assert.equal(guessDocType(asNote), 'cmr');
});

test('the transport document is recognised under its other names', () => {
  for (const heading of [
    'BILL OF LADING', 'SEA WAYBILL', 'PACKING LIST',
    'INTERNATIONALER FRACHTBRIEF', 'LETTRE DE VOITURE INTERNATIONALE',
  ]) {
    assert.equal(guessDocType(`${heading}\nNo. 12345\nVIN W1T96340310484233`), 'cmr', heading);
  }
});

test('and the vehicle title is recognised under its own names, which are different papers', () => {
  for (const heading of [
    'FAHRZEUGBRIEF', 'ZULASSUNGSBESCHEINIGUNG TEIL II', 'CARTE GRISE',
    'VEHICLE REGISTRATION CERTIFICATE', 'LIBRETTO DI CIRCOLAZIONE',
  ]) {
    assert.equal(guessDocType(`${heading}\nNr. 12345\nFahrgestellnummer W1T96340310484233`), 'brief', heading);
  }
  // "brief" is inside both of these words and the match is a plain substring:
  // a Frachtbrief is a CMR and must not be read as the vehicle's title.
  assert.equal(guessDocType('INTERNATIONALER FRACHTBRIEF\nNo. 1\nVIN W1T96340310484233'), 'cmr');
  assert.equal(guessDocType('VRACHTBRIEF\nNo. 1\nVIN W1T96340310484233'), 'cmr');
});

test('a document with no evidence at all is "other", not a guess', () => {
  assert.equal(guessDocType('Dear sir, please find attached the paperwork. Regards.'), 'other');
  assert.equal(guessDocType(''), 'other');
  assert.equal(guessDocType(null), 'other');
});

test('two types with identical evidence is "other", not whichever came first', () => {
  // One mention each, both in the body, nothing in the heading. Before the fix
  // this returned "invoice" purely because invoice is first in the list.
  const ambiguous = 'Page 2 of 3\n\nSee the invoice and the CMR attached.';
  assert.equal(guessDocType(ambiguous), 'other');
});

// ---------------------------------------------------------------------------
// The generated specimens, end to end. Skipped when they have not been built.
// ---------------------------------------------------------------------------

const DATA = new URL('../data/', import.meta.url);
const specimen = (name) => path.join(DATA.pathname.replace(/^\/([A-Za-z]:)/, '$1'), name);
const built = fs.existsSync(specimen('test-cmr-transport.pdf'));

test('the specimen PDFs classify as the flow expects', { skip: built ? false : 'run: npm run testdocs' }, async () => {
  const { readDocument } = await import('../lib/read-file.js');

  const expected = {
    'test-invoice.pdf': 'invoice',
    'test-brief-vehicle-title.pdf': 'brief',
    'test-cmr-transport.pdf': 'cmr',
    'test-mrn-export-declaration.pdf': 'mrn',
    'test-acid-nafeza.pdf': 'acid',
  };

  for (const [file, type] of Object.entries(expected)) {
    const buffer = fs.readFileSync(specimen(file));
    const read = await readDocument({ buffer, mimeType: 'application/pdf', fileName: file });
    assert.ok(read.text, `${file} produced no text layer`);
    assert.equal(guessDocType(read.text), type, file);
  }
});

test('the mismatched specimen really does name a different chassis', { skip: built ? false : 'run: npm run testdocs' }, async () => {
  const { readDocument } = await import('../lib/read-file.js');
  const { extractIdentifiers } = await import('../lib/extract.js').then(
    (m) => ({ extractIdentifiers: m.extractIdentifiers ?? null }),
  ).catch(() => ({ extractIdentifiers: null }));

  const good = await readDocument({
    buffer: fs.readFileSync(specimen('test-invoice.pdf')),
    mimeType: 'application/pdf', fileName: 'good.pdf',
  });
  const bad = await readDocument({
    buffer: fs.readFileSync(specimen('test-invoice-WRONG-CHASSIS.pdf')),
    mimeType: 'application/pdf', fileName: 'bad.pdf',
  });

  const vinOf = (text) => text.match(/\b[A-HJ-NPR-Z0-9]{17}\b/)?.[0] ?? null;
  const a = vinOf(good.text);
  const b = vinOf(bad.text);

  assert.ok(a, 'the matched invoice names a chassis');
  assert.ok(b, 'the mismatched invoice names a chassis');
  assert.notEqual(a, b, 'and they are different, which is the whole point of it');
});

/**
 * Which way up a scan is, before anyone tries to read it.
 *
 * Four vehicle registration certificates arrived from one customer as scans
 * fed through the scanner sideways. The reader got one chassis number out of
 * the four right: WKESD000000510879 came back as WKE5KD000001510879, and
 * WSM00000005106764 as nothing at all. Turned upright first, the same reader
 * and the same model read all four correctly. The turn is decided here,
 * without asking anybody.
 */
test('a page whose lines of text run down the side is seen as sideways, and an upright one is left alone', async () => {
  const { createCanvas } = await import('@napi-rs/canvas');
  const { looksSideways } = await import('../lib/read-file.js');

  /** A ruled page of text, drawn either way up. */
  const page = (sideways) => {
    const canvas = createCanvas(600, 800);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 600, 800);
    ctx.fillStyle = '#000000';
    // Lines of text: bands of ink along the baseline, white between them.
    for (let line = 0; line < 20; line++) {
      if (sideways) ctx.fillRect(40 + line * 28, 60, 10, 680);
      else ctx.fillRect(60, 40 + line * 38, 480, 10);
    }
    // And the form's own rules, which band both directions at once.
    for (let n = 0; n < 20; n++) {
      ctx.fillRect(30, 30 + n * 38, 540, 2);
      ctx.fillRect(30 + n * 28, 30, 2, 740);
    }
    return canvas;
  };

  assert.equal(looksSideways(page(true)), true, 'text running down the page is sideways');
  assert.equal(looksSideways(page(false)), false, 'text running across it is not');

  // A blank page has no lines either way: leave it as it came, never guess.
  const blank = createCanvas(600, 800);
  const ctx = blank.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 600, 800);
  assert.equal(looksSideways(blank), false, 'nothing on the page is not a reason to turn it');
});

/**
 * Where the threshold sits, which is the part a drawn page cannot check.
 *
 * A page drawn in code is too clean to stand in for a scan: its text bands
 * perfectly, so it leans towards sideways by a factor of five or more, and any
 * threshold under that passes. A real vehicle registration certificate is
 * ruled in both directions and photographed crooked, so on its side it leans
 * by barely a fifth - while a page the right way up leans the other way
 * overwhelmingly. The two sides are not symmetrical, and that is the whole
 * difficulty.
 *
 * These two numbers are the measurement: 90 specimen pages rendered each way,
 * plus the four scans this was written for, at five render scales each.
 * Upright never came out above 0.80, sideways never below 1.20. A threshold
 * outside that gap reads one of the two the wrong way round every time - which
 * is what a first attempt at this did, at 1.2, and the scans stayed lying down.
 */
test('the sideways threshold sits in the gap between what upright pages and sideways pages measure', async () => {
  const { SIDEWAYS_RATIO } = await import('../lib/read-file.js');

  const HIGHEST_UPRIGHT = 0.80;
  const LOWEST_SIDEWAYS = 1.20;

  assert.ok(
    SIDEWAYS_RATIO > HIGHEST_UPRIGHT,
    `threshold ${SIDEWAYS_RATIO} is at or below ${HIGHEST_UPRIGHT}, so upright pages get turned over`,
  );
  assert.ok(
    SIDEWAYS_RATIO < LOWEST_SIDEWAYS,
    `threshold ${SIDEWAYS_RATIO} is at or above ${LOWEST_SIDEWAYS}, so sideways scans are left lying down`,
  );
});

/**
 * A Spanish vehicle paper is not an Egyptian customs registration.
 *
 * "aci" was listed as a word meaning ACID. The match is a plain substring, and
 * "aci" sits inside "capacidad" - the load capacity, printed on every Spanish
 * vehicle document - so a registration certificate for a trailer came back as
 * an ACID registration, and the booking believed it held customs paperwork the
 * client had never sent. The same trap as bare "brief" inside "frachtbrief",
 * which this file already guards against.
 */
test('a Spanish vehicle document is not read as an ACID just because it states a capacidad', () => {
  const spanish = `CERTIFICADO DE CARACTERISTICAS
Schmitz Cargobull Iberica, S.A.
SEMIRREMOLQUE FRIGORIFICO
Capacidad de carga: 42000 kg
Masa en servicio: 8069 kg`;

  assert.notEqual(guessDocType(spanish), 'acid', 'capacidad is a load capacity, not a customs registration');
  assert.notEqual(guessDocType('CAPACIDAD'), 'acid', 'nor is the bare word');

  // And the real thing is still recognised, which is the point of the entry.
  assert.equal(guessDocType('ACID Registration\nNafeza single window\nEgypt'), 'acid');
});
