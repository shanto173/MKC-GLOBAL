/**
 * Booking confirmation PDF, in English or Arabic, generated in memory
 * (the serverless filesystem is read-only outside /tmp).
 *
 * Arabic needs an embedded font - the built-in Helvetica has no Arabic glyphs
 * and would silently print blank boxes - plus run-level bidi reordering, which
 * lives in ./rtl.js. Amiri is used whenever Arabic appears anywhere in the
 * booking, even on an otherwise English document, so a customer who types their
 * name in Arabic still gets a readable PDF.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { config } from './config.js';
import { t, bookingLanguage } from './i18n.js';
import { hasArabic, drawBidiLine, drawBidiParagraph, ARABIC_WORD_SPACING } from './rtl.js';

const FONT_DIR = fileURLToPath(new URL('../assets/fonts/', import.meta.url));
const AMIRI = path.join(FONT_DIR, 'Amiri-Regular.ttf');
const AMIRI_BOLD = path.join(FONT_DIR, 'Amiri-Bold.ttf');

const INK = '#12202e';
const MUTED = '#5b6b7c';
const BRAND = '#0b4a6f';
const LINE = '#d8e0e8';

const LEFT = 50;
const RIGHT = 545;
const LABEL_W = 150;
const TOP = 60;          // where content starts on a continuation page
const BOTTOM = 735;      // last y a line may start on, above the footer

/**
 * @param {object} b a row from the bookings table
 * @param {{lang?: 'en'|'ar'}} [opts]
 * @returns {Promise<Buffer>}
 */
export function bookingConfirmationPdf(b, opts = {}) {
  const lang = opts.lang ?? bookingLanguage(b);
  const s = t(lang);
  const rtl = s.dir === 'rtl';

  // Any Arabic anywhere means we cannot use Helvetica for that text.
  const anyArabic =
    rtl ||
    hasArabic(
      [b.customer_name, b.company, b.cargo_description, b.notes, b.origin_port, b.destination_port]
        .filter(Boolean)
        .join(' '),
    );

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, autoFirstPage: true });
    const parts = [];
    doc.on('data', (c) => parts.push(c));
    doc.on('end', () => resolve(Buffer.concat(parts)));
    doc.on('error', reject);

    let REG = 'Helvetica';
    let BOLD = 'Helvetica-Bold';
    if (anyArabic) {
      doc.registerFont('body', AMIRI);
      doc.registerFont('bodyBold', AMIRI_BOLD);
      REG = 'body';
      BOLD = 'bodyBold';
    }

    // ---- helpers ---------------------------------------------------------
    // Everything routes through these so alignment flips with the language.

    // Extra word spacing only where Arabic is actually being drawn; Latin text
    // does not need it and would look loose.
    const spacingFor = (text) => (anyArabic && hasArabic(text) ? ARABIC_WORD_SPACING : 0);

    const line = (text, x, y, width, { align, size, font, color } = {}) => {
      doc.font(font ?? REG).fontSize(size ?? 10).fillColor(color ?? INK);
      drawBidiLine(doc, text, x, y, width, {
        align: align ?? (rtl ? 'right' : 'left'),
        baseDir: s.dir,
        wordSpacing: spacingFor(text),
      });
    };

    const newPage = () => {
      doc.addPage();
      return TOP;
    };

    /** Starts a new page when the next block would not fit above the footer. */
    const ensureSpace = (needed) => {
      if (y + needed > BOTTOM) y = newPage();
    };

    const para = (text, x, y, width, { size, font, color, lineGap = 3 } = {}) => {
      doc.font(font ?? REG).fontSize(size ?? 10).fillColor(color ?? INK);
      return drawBidiParagraph(doc, text, x, y, width, {
        align: rtl ? 'right' : 'left',
        baseDir: s.dir,
        lineGap,
        wordSpacing: spacingFor(text),
        maxY: BOTTOM,
        onPageBreak: newPage,
      });
    };

    // ---- header ----------------------------------------------------------
    doc.rect(0, 0, 595, 96).fill(BRAND);

    line(config.companyName, LEFT, 28, RIGHT - LEFT, {
      align: rtl ? 'right' : 'left', size: 20, font: BOLD, color: '#ffffff',
    });
    line(s.tagline, LEFT, 56, RIGHT - LEFT, {
      align: rtl ? 'right' : 'left', size: 9.5, color: '#cfe2ee',
    });
    line(s.docTitle, LEFT, 28, RIGHT - LEFT, {
      align: rtl ? 'left' : 'right', size: 15, font: BOLD, color: '#ffffff',
    });
    // The reference is a Latin identifier on the bill of lading - never translated.
    line(b.booking_ref, LEFT, 54, RIGHT - LEFT, {
      align: rtl ? 'left' : 'right', size: 11, color: '#cfe2ee',
    });

    let y = 118;

    // ---- status banner ---------------------------------------------------
    doc.roundedRect(LEFT, y, RIGHT - LEFT, 32, 5).fill('#fff5e0');
    line(s.statusBanner, LEFT + 14, y + 6, RIGHT - LEFT - 28, { size: 10, font: BOLD, color: '#8a5a00' });
    line(s.statusNote, LEFT + 14, y + 19, RIGHT - LEFT - 28, { size: 8.5, color: '#8a5a00' });
    y += 42;

    // ---- section heading + label/value rows -------------------------------
    const heading = (text) => {
      ensureSpace(46);   // heading, rule, and at least one row beneath it
      line(text, LEFT, y, RIGHT - LEFT, { size: 11, font: BOLD, color: BRAND });
      y += 15;
      doc.moveTo(LEFT, y).lineTo(RIGHT, y).strokeColor(LINE).lineWidth(1).stroke();
      y += 8;
    };

    const row = (label, value) => {
      if (value === null || value === undefined || value === '') return;
      const text = String(value);
      ensureSpace(20);

      if (rtl) {
        // Label hugs the right edge; the value sits to its left.
        line(label, RIGHT - LABEL_W, y, LABEL_W, { align: 'right', size: 9.5, color: MUTED });
        const end = para(text, LEFT, y, RIGHT - LABEL_W - 12, { size: 10, font: BOLD });
        y = Math.max(end, y + 14);
      } else {
        line(label, LEFT, y, LABEL_W, { align: 'left', size: 9.5, color: MUTED });
        const end = para(text, LEFT + LABEL_W + 5, y, RIGHT - LEFT - LABEL_W - 5, { size: 10, font: BOLD });
        y = Math.max(end, y + 14);
      }
      y += 1;
    };

    heading(s.customer);
    row(s.name, b.customer_name);
    row(s.company, b.company);
    row(s.contact, b.customer_contact);
    y += 3;

    heading(s.route);
    row(s.originCountry, b.origin_country);
    row(s.originPort, b.origin_port);
    row(s.destinationPort, b.destination_port);
    row(s.incoterm, b.incoterm);
    y += 3;

    heading(s.cargo);
    // The chassis number identifies the unit on every other document in the
    // file - invoice, MRN, ACID, bill of lading - so it belongs at the top of
    // the cargo block, not only in the database.
    const vehicle = [b.make, b.model].filter(Boolean).join(' ');
    row(s.chassis, b.vin);
    row(s.vehicle, vehicle);
    row(s.condition, b.engine_condition ?? b.raw?.engine_condition ?? null);
    // Skip a description that only repeats the vehicle line above it.
    row(s.description, b.cargo_description === vehicle ? null : b.cargo_description);
    row(s.grossWeight, b.gross_weight_kg ? `${fmt(b.gross_weight_kg)} ${s.kg}` : null);
    row(s.volume, b.volume_cbm ? `${fmt(b.volume_cbm)} ${s.cbm}` : null);
    row(s.readyDate, b.ready_date);
    row(s.mrn, b.mrn_number);
    row(s.acid, b.acid_number);
    row(s.notes, b.notes);
    y += 3;

    // ---- document checklist ----------------------------------------------
    heading(s.documents);
    // Two columns. Six documents down one side pushed an Arabic booking - whose
    // script sets taller than Latin - onto a second page for two lines of text.
    const HALF = (RIGHT - LEFT) / 2;
    const perColumn = Math.ceil(s.docList.length / 2);
    ensureSpace(perColumn * 13 + 6);
    const listTop = y;
    s.docList.forEach((item, i) => {
      const second = i >= perColumn;
      // The first column is the right-hand one when the page reads right to left.
      const colLeft = LEFT + (rtl === second ? 0 : HALF);
      const rowY = listTop + (i % perColumn) * 13;
      // The bullet is drawn as a shape rather than a character, so bidi cannot
      // move it to the wrong side of the line.
      doc.circle(rtl ? colLeft + HALF - 5 : colLeft + 3, rowY + 5, 1.6).fill(BRAND);
      para(item, rtl ? colLeft : colLeft + 14, rowY, HALF - 14, { size: 9 });
    });
    y = listTop + perColumn * 13 + 6;

    // ---- next steps -------------------------------------------------------
    heading(s.next);
    y = para(s.nextBody, LEFT, y, RIGHT - LEFT, { size: 9, lineGap: 2 });

    // ---- footer -----------------------------------------------------------
    // Drawn on whatever page the content ended on, never on top of it.
    const fy = 762;
    doc.moveTo(LEFT, fy).lineTo(RIGHT, fy).strokeColor(LINE).stroke();
    const when = new Date(b.created_at ?? Date.now()).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    line(`${config.companyName}  ·  ${config.companyEmail}  ·  ${config.companyPhone}`,
      LEFT, fy + 8, RIGHT - LEFT, { align: 'center', size: 8, color: MUTED });
    line(`${s.receivedVia(when, b.channel)}  ·  ${s.reference} ${b.booking_ref}`,
      LEFT, fy + 20, RIGHT - LEFT, { align: 'center', size: 8, color: MUTED });

    doc.end();
  });
}

function fmt(n) {
  return Number(n).toLocaleString('en-US');
}
