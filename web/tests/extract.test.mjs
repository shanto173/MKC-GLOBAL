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

test('a consignment note is a transport document, not the invoice it names', () => {
  assert.equal(guessDocType(CMR), 'brief');
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
  assert.equal(guessDocType(asNote), 'brief');
});

test('the transport document is recognised under its other names', () => {
  for (const heading of [
    'BILL OF LADING', 'SEA WAYBILL', 'PACKING LIST',
    'INTERNATIONALER FRACHTBRIEF', 'LETTRE DE VOITURE INTERNATIONALE',
  ]) {
    assert.equal(guessDocType(`${heading}\nNo. 12345\nVIN W1T96340310484233`), 'brief', heading);
  }
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
    'test-cmr-transport.pdf': 'brief',
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
