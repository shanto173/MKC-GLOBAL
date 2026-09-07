/**
 * The booking label from roadmap step 4, "Create Booking Label".
 *
 *   GET /api/admin/label?ref=MKY-BKG-...&secret=...
 *
 * A single sheet an operator prints and puts on the file or the windscreen:
 * reference and chassis large enough to read across a yard, route, customer,
 * and which documents are still outstanding.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { config } from '../../lib/config.js';
import { hasArabic, drawBidiLine, ARABIC_WORD_SPACING } from '../../lib/rtl.js';
import { db } from '../../lib/supabase.js';

export default async function handler(req, res) {
  const secret = req.query.secret ?? req.headers['x-admin-secret'];
  if (!config.adminSecret || secret !== config.adminSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ref = String(req.query.ref ?? '').trim();
  if (!ref) return res.status(400).json({ error: 'ref is required' });

  const { data: booking, error } = await db().from('bookings').select('*').eq('booking_ref', ref).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!booking) return res.status(404).json({ error: `No booking ${ref}` });

  const [{ data: docs }, { data: shipment }] = await Promise.all([
    db().from('booking_documents').select('doc_type').eq('booking_ref', ref),
    db().from('shipments').select('shipment_id, status, vessel, eta').eq('booking_ref', ref).maybeSingle(),
  ]);

  const have = new Set((docs ?? []).map((d) => d.doc_type));
  if (have.has('eur1')) have.add('brief');
  const required = [['invoice', 'Commercial invoice'], ['brief', 'Transport document / EUR.1'], ['mrn', 'MRN'], ['acid', 'ACID']];

  const pdf = await buildLabel(booking, { required, have, shipment });

  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `inline; filename="${ref}-label.pdf"`);
  res.status(200).send(pdf);
}

function buildLabel(b, { required, have, shipment }) {
  return new Promise((resolve, reject) => {
    // A5 landscape: fits an A4 sheet folded, or prints two to a page.
    const doc = new PDFDocument({ size: [595, 421], margin: 28 });
    const parts = [];
    doc.on('data', (c) => parts.push(c));
    doc.on('end', () => resolve(Buffer.concat(parts)));
    doc.on('error', reject);

    // Helvetica has no Arabic glyphs, so an Arabic customer name printed as
    // nothing at all - silently, with no error. Amiri is registered whenever
    // Arabic appears anywhere on the label.
    const FONT_DIR = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));
    const arabicSomewhere = hasArabic([b.customer_name, b.company, b.origin_port, b.destination_port, b.notes].filter(Boolean).join(' '));
    if (arabicSomewhere) {
      doc.registerFont('ar', path.join(FONT_DIR, 'Amiri-Regular.ttf'));
      doc.registerFont('arBold', path.join(FONT_DIR, 'Amiri-Bold.ttf'));
    }
    const face = (bold) => (arabicSomewhere ? (bold ? 'arBold' : 'ar') : (bold ? 'Helvetica-Bold' : 'Helvetica'));

    const L = 28, R = 567;

    /** Writes a value that may be Arabic, right-to-left, without a wrapper. */
    const value = (text, x, y, size, bold = true, width = 250) => {
      doc.font(face(bold)).fontSize(size).fillColor('#12202e');
      if (hasArabic(text)) {
        drawBidiLine(doc, String(text), x, y, width, { align: 'left', baseDir: 'rtl', wordSpacing: ARABIC_WORD_SPACING });
      } else {
        doc.text(String(text), x, y, { lineBreak: false });
      }
    };

    doc.rect(0, 0, 595, 62).fill('#0b4a6f');
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(15).text(config.companyName, L, 18, { lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor('#cfe2ee').text('Booking label', L, 38, { lineBreak: false });
    const stamp = new Date().toISOString().slice(0, 10);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#fff');
    doc.text(stamp, R - doc.widthOfString(stamp), 22, { lineBreak: false });

    // The two things anyone reads from a distance.
    doc.fillColor('#12202e').font('Helvetica').fontSize(8).text('BOOKING REFERENCE', L, 78, { lineBreak: false });
    doc.font(face(true)).fontSize(21).text(b.booking_ref, L, 90, { lineBreak: false });

    doc.font('Helvetica').fontSize(8).fillColor('#12202e').text('CHASSIS / VIN', L, 124, { lineBreak: false });
    doc.font(face(true)).fontSize(19).text(b.vin || '—', L, 136, { lineBreak: false });

    const row = (label, text, x, y, w = 250) => {
      doc.font('Helvetica').fontSize(7.5).fillColor('#5b6b7c').text(label, x, y, { lineBreak: false });
      value(text || '—', x, y + 10, 10, true, w);
    };

    let y = 176;
    row('VEHICLE', [b.make, b.model].filter(Boolean).join(' '), L, y);
    row('CUSTOMER', b.customer_name, L + 270, y);
    y += 32;
    row('PORT OF LOADING', b.origin_port, L, y);
    row('DESTINATION', b.destination_port, L + 270, y);
    y += 32;
    row('GROSS WEIGHT', b.gross_weight_kg ? `${Number(b.gross_weight_kg).toLocaleString('en-US')} kg` : '', L, y);
    row('INCOTERM', b.incoterm, L + 140, y, 110);
    row('CARGO READY', b.ready_date, L + 270, y, 120);
    row('STATUS', b.status.replace('_', ' '), L + 400, y, 140);
    y += 34;

    if (shipment?.shipment_id) {
      row('SHIPMENT', `${shipment.shipment_id} — ${shipment.status}`, L, y, 300);
      row('VESSEL / ETA', [shipment.vessel, shipment.eta].filter(Boolean).join(' · '), L + 310, y, 230);
      y += 32;
    }

    // Documents as a checklist, because the label's real job in a yard is
    // telling somebody what is still missing.
    doc.moveTo(L, y).lineTo(R, y).strokeColor('#d8e0e8').lineWidth(1).stroke();
    y += 9;
    doc.font('Helvetica').fontSize(7.5).fillColor('#5b6b7c').text('DOCUMENTS', L, y);
    y += 11;
    let x = L;
    for (const [key, label] of required) {
      const ok = have.has(key) || (key === 'mrn' && b.mrn_number) || (key === 'acid' && b.acid_number);
      doc.roundedRect(x, y, 11, 11, 2).lineWidth(1).strokeColor(ok ? '#1b7357' : '#ac4a1a').stroke();
      if (ok) {
        doc.moveTo(x + 2.5, y + 5.5).lineTo(x + 4.5, y + 8).lineTo(x + 8.5, y + 3)
          .strokeColor('#1b7357').lineWidth(1.6).stroke();
      }
      doc.font('Helvetica').fontSize(9).fillColor(ok ? '#12202e' : '#ac4a1a').text(label, x + 16, y + 1);
      x += 138;
    }

    // No `width` and no `align`: PDFKit routes text through its LineWrapper the
    // moment a width is given, and that wrapper starts a new page once the
    // cursor passes the bottom margin - which put this footer on a page 2 that
    // nobody wanted on a printed label. Centred by measuring instead.
    const footer = `${config.companyName} · ${config.companyEmail} · ${config.companyPhone}`;
    doc.font('Helvetica').fontSize(7.5).fillColor('#5b6b7c');
    const footerX = L + (R - L - doc.widthOfString(footer)) / 2;
    doc.text(footer, footerX, 392, { lineBreak: false });

    doc.end();
  });
}
