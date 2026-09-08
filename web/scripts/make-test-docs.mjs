/**
 * A matched set of test documents for one vehicle.
 *
 *   npm run testdocs                          the default test unit
 *   npm run testdocs -- W1T96340310484233     any chassis you like
 *
 * Three files land in data/: a commercial invoice, an EU export declaration
 * carrying an MRN, and a Nafeza ACID registration in Arabic. They all name the
 * SAME chassis number, so sending them to the bot gives a clean match instead
 * of the mismatch warnings a mixed pile of real paperwork produces.
 *
 * They are plainly marked as specimens. They are for exercising the reader -
 * text layer, Arabic, the identifier patterns - not for any real shipment.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { drawBidiLine, drawBidiParagraph, ARABIC_WORD_SPACING } from '../lib/rtl.js';

const FONT_DIR = fileURLToPath(new URL('../assets/fonts/', import.meta.url));
const AMIRI = path.join(FONT_DIR, 'Amiri-Regular.ttf');
const AMIRI_BOLD = path.join(FONT_DIR, 'Amiri-Bold.ttf');
const OUT = fileURLToPath(new URL('../data/', import.meta.url));

const INK = '#101820';
const MUTED = '#5b6b7c';
const RULE = '#c9d3dd';

// One vehicle, one set of numbers, so the cross-check has something to agree on.
let VIN = (process.argv[2] || 'WDB96340310777421').toUpperCase();
const NAME = process.argv[3] || 'MKY Global Forwarding';

/**
 * Every set gets its own MRN and ACID, derived from the chassis.
 *
 * Two people testing at once with the same numbers would collide: an ACID is
 * unique across shipments, so the second confirmation would fail to open one.
 */
const seed = [...VIN].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 1e12, 7);
const digits = (n, len) => String(n).padStart(len, '0').slice(-len);
const MRN = `26LTVR${digits(seed, 8)}${VIN.slice(-4)}`;   // year, country, 13+ alphanumerics
const ACID = `54033${digits(seed * 7, 14)}`;              // Egyptian ACID: 19 digits
const EUR1 = `AA ${digits(seed, 7)}`;

// Make, model and loading point are arguments too, so a second test unit is
// genuinely a different vehicle on a different lane rather than the same truck
// with a new chassis number. Everything defaults to the original set.
const unit = {
  make: process.argv[4] || 'Mercedes-Benz',
  model: process.argv[5] || 'Actros 1845 LS',
  year: '2016',
  type: 'Tractor unit / used commercial vehicle',
  weight: '8,266 kg',
  value: '18,500.00',
  currency: 'EUR',
};

/** Where it loads, and the port it leaves from. */
const LOADING_CITY = process.argv[6] || 'Vilnius';
const LOADING_PORT = process.argv[7] || 'Klaipeda';

const seller = {
  name: 'UAB V.I.P INVESTMENT',
  address: 'Ramybes 4-70, LT-02103 Vilnius, Lithuania',
  vat: 'LT305659566',
};

const buyer = {
  name: NAME,
  address: '15 El Horreya Road, Alexandria, Egypt',
  vat: 'EG-334-889-021',
};

// ---------------------------------------------------------------------------

function newDoc({ arabic = false } = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  if (arabic) {
    doc.registerFont('body', AMIRI);
    doc.registerFont('bodyBold', AMIRI_BOLD);
  }
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  return { doc, done: new Promise((r) => doc.on('end', () => r(Buffer.concat(chunks)))) };
}

/** Every specimen says so, on the page, so one can never be mistaken for real. */
function watermark(doc) {
  doc.save();
  doc.rotate(-30, { origin: [300, 430] });
  doc.font('Helvetica-Bold').fontSize(58).fillColor('#000000').opacity(0.06);
  doc.text('SPECIMEN', 60, 400, { width: 520, align: 'center' });
  doc.opacity(1).restore();
}

function row(doc, label, value, y, { labelW = 150, size = 10 } = {}) {
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(label, 50, y, { width: labelW });
  doc.font('Helvetica-Bold').fontSize(size).fillColor(INK)
    .text(value, 50 + labelW, y - 1, { width: 545 - 50 - labelW });
  return y + 18;
}

function heading(doc, text, y) {
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0b4a6f').text(text, 50, y);
  doc.moveTo(50, y + 15).lineTo(545, y + 15).strokeColor(RULE).lineWidth(1).stroke();
  return y + 26;
}

// --- 1. commercial invoice --------------------------------------------------

async function invoice() {
  const { doc, done } = newDoc();
  watermark(doc);

  doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text('COMMERCIAL INVOICE', 50, 50);
  doc.font('Helvetica').fontSize(10).fillColor(MUTED)
    .text('Handelsrechnung · Faktura handlowa', 50, 76);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
    .text('No. INV-2026-4471    Date: 2026-09-18', 50, 96);

  let y = heading(doc, 'SELLER / VERKÄUFER', 126);
  y = row(doc, 'Name', seller.name, y);
  y = row(doc, 'Address', seller.address, y);
  y = row(doc, 'VAT / Tax No.', seller.vat, y);

  y = heading(doc, 'BUYER / CONSIGNEE', y + 8);
  y = row(doc, 'Name', buyer.name, y);
  y = row(doc, 'Address', buyer.address, y);
  y = row(doc, 'Tax No.', buyer.vat, y);

  y = heading(doc, 'GOODS', y + 8);
  y = row(doc, 'Description', `${unit.make} ${unit.model}, ${unit.year}`, y);
  y = row(doc, 'Type', unit.type, y);
  y = row(doc, 'VIN / Chassis No.', VIN, y, { size: 11 });
  y = row(doc, 'Gross weight', unit.weight, y);
  y = row(doc, 'Quantity', '1 unit', y);
  y = row(doc, 'Unit price', `${unit.value} ${unit.currency}`, y);
  y = row(doc, 'Total amount', `${unit.value} ${unit.currency}`, y, { size: 12 });
  y = row(doc, 'Incoterm', `FOB ${LOADING_PORT}`, y);
  y = row(doc, 'Country of origin', 'Lithuania (EU)', y);
  y = row(doc, 'EUR.1 certificate', `EUR.1 Nr. ${EUR1}`, y);

  y = heading(doc, 'PAYMENT', y + 8);
  y = row(doc, 'Terms', '100% by bank transfer before loading', y);
  y = row(doc, 'Bank', 'Swedbank AB, IBAN LT12 7300 0101 2345 6789', y);

  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
    .text('Specimen document generated for testing the MKY Global assistant. Not a real invoice, '
      + 'no goods and no payment are represented.', 50, y + 24, { width: 495 });

  doc.end();
  return done;
}

// --- 1b. transport document (CMR) - the flow's "brief" -----------------------
//
// The booking flow asks for an invoice, a BRIEF and an MRN. Nothing here made a
// brief, so a tester who sent all three of the old files was still told
// "Almost there - we just need your Brief" and had nothing to send. A CMR
// consignment note is what actually accompanies a truck out of Lithuania, and
// the reader classifies it as `brief` from the letters CMR.

async function transportDocument() {
  const { doc, done } = newDoc();
  watermark(doc);

  doc.font('Helvetica-Bold').fontSize(19).fillColor(INK).text('CMR', 50, 50);
  doc.fontSize(13).text('INTERNATIONAL CONSIGNMENT NOTE', 50, 74);
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED)
    .text('Lettre de voiture internationale · Internationaler Frachtbrief', 50, 93);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
    .text(`No. CMR-${digits(seed, 7)}    Date: 2026-09-19`, 50, 112);

  let y = heading(doc, '1 · SENDER / EXPÉDITEUR', 142);
  y = row(doc, 'Name', seller.name, y);
  y = row(doc, 'Address', seller.address, y);

  y = heading(doc, '2 · CONSIGNEE / DESTINATAIRE', y + 8);
  y = row(doc, 'Name', buyer.name, y);
  y = row(doc, 'Address', buyer.address, y);

  y = heading(doc, '3 · PLACE OF DELIVERY', y + 8);
  y = row(doc, 'Place', `${LOADING_PORT} Port, Lithuania`, y);
  y = row(doc, 'Place of loading', `${LOADING_CITY}, Lithuania`, y);
  y = row(doc, 'Date of loading', '2026-09-19', y);

  y = heading(doc, '6-12 · GOODS', y + 8);
  y = row(doc, 'Marks and numbers', `VIN ${VIN}`, y, { size: 11 });
  y = row(doc, 'Number of packages', '1 unit, unpacked (self-propelled)', y);
  y = row(doc, 'Description', `${unit.make} ${unit.model}, ${unit.year} — ${unit.type}`, y);
  y = row(doc, 'Gross weight', unit.weight, y);
  y = row(doc, 'Attached documents', `Invoice INV-2026-4471, EUR.1 ${EUR1}, MRN ${MRN}`, y);

  y = heading(doc, '16 · CARRIER / TRANSPORTEUR', y + 8);
  y = row(doc, 'Name', 'UAB Baltic Auto Logistics', y);
  y = row(doc, 'Vehicle', 'Volvo FH 460, plate LT ABC 123', y);

  y = heading(doc, '21 · ESTABLISHED IN', y + 8);
  y = row(doc, 'Place and date', `${LOADING_CITY}, 2026-09-19`, y);

  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
    .text('Specimen consignment note generated for testing the MKY Global assistant. '
      + 'No carriage is represented and no carrier is bound by it.', 50, y + 24, { width: 495 });

  doc.end();
  return done;
}

// --- 2. export declaration (MRN) -------------------------------------------

async function exportDeclaration() {
  const { doc, done } = newDoc();
  watermark(doc);

  doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text('UNIUNEA EUROPEANĂ', 50, 50);
  doc.fontSize(17).text('DOCUMENT DE ÎNSOŢIRE DE EXPORT', 50, 70);
  doc.font('Helvetica').fontSize(10).fillColor(MUTED)
    .text('EXPORT ACCOMPANYING DOCUMENT · AUSFUHRBEGLEITDOKUMENT', 50, 92);

  doc.font('Helvetica-Bold').fontSize(13).fillColor('#0b4a6f')
    .text(`MRN: ${MRN}`, 50, 116);

  let y = heading(doc, 'EXPEDITOR / EXPORTER [13 01]', 146);
  y = row(doc, 'Nr / No', seller.vat, y);
  y = row(doc, 'Nume / Name', seller.name, y);
  y = row(doc, 'Adresa / Address', seller.address, y);

  y = heading(doc, 'DESTINATAR / CONSIGNEE [13 02]', y + 8);
  y = row(doc, 'Nume / Name', buyer.name, y);
  y = row(doc, 'Adresa / Address', buyer.address, y);
  y = row(doc, 'Ţara / Country', 'EG - Egipt / Egypt', y);

  y = heading(doc, 'MĂRFURI / GOODS', y + 8);
  y = row(doc, 'Descriere / Description', `${unit.make} ${unit.model} - vehicul rutier folosit`, y);
  y = row(doc, 'Sasiu / Chassis', VIN, y, { size: 11 });
  y = row(doc, 'Cod marfă / HS code', '8701 20 10', y);
  y = row(doc, 'Masa brută / Gross mass', unit.weight, y);
  y = row(doc, 'Valoare / Value', `${unit.value} ${unit.currency}`, y);
  y = row(doc, 'Birou vamal / Office', 'LTVR1400 - Vilnius', y);
  y = row(doc, 'Data / Date', '2026-09-19', y);

  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
    .text('Specimen document generated for testing. Not a customs declaration and not valid for '
      + 'any movement of goods.', 50, y + 24, { width: 495 });

  doc.end();
  return done;
}

// --- 3. ACID registration, in Arabic ---------------------------------------

async function acidRegistration() {
  const { doc, done } = newDoc({ arabic: true });
  watermark(doc);

  const LEFT = 50;
  const RIGHT = 545;
  const W = RIGHT - LEFT;
  const ar = (text, y, { size = 11, bold = false, color = INK } = {}) => {
    doc.font(bold ? 'bodyBold' : 'body').fontSize(size).fillColor(color);
    drawBidiLine(doc, text, LEFT, y, W, { align: 'right', baseDir: 'rtl', wordSpacing: ARABIC_WORD_SPACING });
  };

  doc.rect(0, 0, 595, 90).fill('#0b4a6f');
  ar('منصة نافذة - النافذة الواحدة للتجارة الخارجية', 26, { size: 15, bold: true, color: '#ffffff' });
  ar('Nafeza - Egyptian single window for foreign trade', 54, { size: 10, color: '#cfe2ee' });

  let y = 118;
  ar('تسجيل الرقم التعريفي المسبق للشحنة (ACID)', y, { size: 13, bold: true, color: '#0b4a6f' });
  y += 26;

  doc.font('Helvetica-Bold').fontSize(14).fillColor('#0b4a6f')
    .text(`ACID: ${ACID}`, LEFT, y, { width: W, align: 'left' });
  y += 30;

  const pair = (label, value, { latin = false } = {}) => {
    ar(label, y, { size: 10, color: MUTED });
    if (latin) {
      doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
        .text(value, LEFT, y - 1, { width: W - 190, align: 'left' });
    } else {
      doc.font('bodyBold').fontSize(11).fillColor(INK);
      drawBidiLine(doc, value, LEFT, y, W - 190, { align: 'left', baseDir: 'rtl', wordSpacing: ARABIC_WORD_SPACING });
    }
    y += 22;
  };

  pair('حالة الطلب', 'مقبول - مسجل');
  pair('تاريخ التسجيل', '2026-09-19', { latin: true });
  pair('المستورد', 'إم كيه واي جلوبال للشحن');
  pair('الرقم الضريبي للمستورد', buyer.vat, { latin: true });
  pair('المصدر', seller.name, { latin: true });
  pair('بلد المنشأ', 'ليتوانيا / Lithuania', { latin: true });
  pair('ميناء الوصول', 'ميناء الإسكندرية');
  pair('وصف البضاعة', `${unit.make} ${unit.model}`, { latin: true });
  pair('رقم الشاسيه', VIN, { latin: true });
  pair('الوزن الإجمالي', unit.weight, { latin: true });
  pair('القيمة', `${unit.value} ${unit.currency}`, { latin: true });
  pair('رقم البيان الجمركي للتصدير', MRN, { latin: true });

  y += 10;
  doc.font('body').fontSize(9.5).fillColor(MUTED);
  drawBidiParagraph(
    doc,
    'مستند تجريبي تم إنشاؤه لاختبار مساعد إم كيه واي جلوبال. ليس تسجيلاً حقيقياً على منصة نافذة '
    + 'ولا يصلح لأي شحنة فعلية.',
    LEFT, y, W,
    { align: 'right', baseDir: 'rtl', lineGap: 3, wordSpacing: ARABIC_WORD_SPACING },
  );

  doc.end();
  return done;
}

// ---------------------------------------------------------------------------

/**
 * The same invoice for a DIFFERENT vehicle.
 *
 * The single most expensive mistake on this lane is paperwork that disagrees
 * about the chassis: customs rejects the declaration and nobody notices until
 * the truck is on the water. The bot is built to catch it, so there has to be
 * something to catch. Sending this alongside the matched set should produce the
 * "this document is for a different chassis" warning, and it must NOT count as
 * the invoice having been received.
 */
async function mismatchedInvoice() {
  const real = VIN;
  // One character different, in the middle, exactly as a typo looks.
  VIN = VIN.slice(0, 8) + (VIN[8] === '9' ? '8' : '9') + VIN.slice(9);
  const buffer = await invoice();
  VIN = real;
  return buffer;
}

// A prefix keeps several kits side by side. Without it every run overwrote the
// same three filenames, so filming three bookings back to back meant
// regenerating between takes - and a chassis can only be booked once, so a
// second take needs a second set anyway.
const PREFIX = (process.argv[8] || 'test').replace(/[^\w-]/g, '');

const files = [
  [`${PREFIX}-invoice.pdf`, await invoice()],
  [`${PREFIX}-cmr-transport.pdf`, await transportDocument()],
  [`${PREFIX}-mrn-export-declaration.pdf`, await exportDeclaration()],
  [`${PREFIX}-acid-nafeza.pdf`, await acidRegistration()],
  [`${PREFIX}-invoice-WRONG-CHASSIS.pdf`, await mismatchedInvoice()],
];

for (const [name, buffer] of files) {
  fs.writeFileSync(path.join(OUT, name), buffer);
  console.log(`${name.padEnd(36)} ${(buffer.length / 1024).toFixed(0)} KB`);
}

console.log(`
The matched set names chassis ${VIN}
  Make    ${unit.make} ${unit.model}
  Client  ${NAME}
  Loading ${LOADING_CITY}
  MRN   ${MRN}
  ACID  ${ACID}
  EUR.1 ${EUR1}

Send these three, in this order:
  ${PREFIX}-invoice.pdf
  ${PREFIX}-cmr-transport.pdf
  ${PREFIX}-mrn-export-declaration.pdf

${PREFIX}-acid-nafeza.pdf is only asked for when bot_settings.acid_required is
true. ${PREFIX}-invoice-WRONG-CHASSIS.pdf exercises the mismatch warning.

  npm run testdocs -- <CHASSIS> "<CLIENT>" <MAKE> "<MODEL>" <CITY> <PORT> <PREFIX>`);
