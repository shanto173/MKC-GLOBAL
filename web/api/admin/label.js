/**
 * The shipping label: the sheet that goes on the windscreen.
 *
 *   GET /api/admin/label?ref=MKY-BKG-...&secret=...
 *
 * This is MKY's own label, rebuilt from the one they print: A4 landscape, the
 * logo and the two red rules, the route across the top, then the marks, the
 * chassis and the reference in type you can read from across a yard, and the
 * delivery instructions - the terminal's hours and the forwarding agent at the
 * port - at the foot.
 *
 * WHAT IS NOT ON IT.
 *
 * The old version of this file printed an internal checklist: which documents
 * were outstanding, the status, the weight, the incoterm. None of that belongs
 * on a label a driver reads in the rain - it is on the case page, where the
 * person who needs it is. A label says which vehicle this is and where it
 * goes.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { config } from '../../lib/config.js';
import { hasArabic, drawBidiLine, ARABIC_WORD_SPACING } from '../../lib/rtl.js';
import { db } from '../../lib/supabase.js';
import { companyPhone, settings } from '../../lib/settings.js';

const ASSETS = fileURLToPath(new URL('../../assets/', import.meta.url));
const FONT_DIR = path.join(ASSETS, 'fonts');
const LOGO = path.join(ASSETS, 'mky-logo.png');

// MKY's own two, taken from the label they print.
const RED = '#c00000';
const BLUE = '#0070c0';
const INK = '#101010';

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

  const { data: shipment } = await db().from('shipments')
    .select('shipment_id, status, vessel, eta').eq('booking_ref', ref).maybeSingle();

  // The desk's number from Settings, or none: never a default nobody answers.
  const [phone, table] = await Promise.all([
    companyPhone().catch(() => null),
    settings().catch(() => ({})),
  ]);

  const pdf = await buildLabel(booking, {
    shipment,
    phone,
    email: table.operations_email || config.companyEmail || null,
    terminalHours: table.label_terminal_hours || null,
    agent: table.label_agent || null,
  });

  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `inline; filename="${ref}-label.pdf"`);
  res.status(200).send(pdf);
}

function buildLabel(b, { shipment, phone = null, email = null, terminalHours = null, agent = null }) {
  return new Promise((resolve, reject) => {
    // A4 landscape, as MKY's own label is.
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
    const parts = [];
    doc.on('data', (c) => parts.push(c));
    doc.on('end', () => resolve(Buffer.concat(parts)));
    doc.on('error', reject);

    // Helvetica has no Arabic glyphs, so an Arabic customer name printed as
    // nothing at all - silently, with no error. Amiri is registered whenever
    // Arabic appears anywhere on the label.
    const arabicSomewhere = hasArabic([b.customer_name, b.company, b.origin_port, b.destination_port].filter(Boolean).join(' '));
    if (arabicSomewhere) {
      doc.registerFont('ar', path.join(FONT_DIR, 'Amiri-Regular.ttf'));
      doc.registerFont('arBold', path.join(FONT_DIR, 'Amiri-Bold.ttf'));
    }
    const face = (bold) => (arabicSomewhere ? (bold ? 'arBold' : 'ar') : (bold ? 'Helvetica-Bold' : 'Helvetica'));

    const L = 40;
    const R = 802;
    const W = R - L;

    /** A value that may be Arabic, written right-to-left without a wrapper. */
    const value = (txt, x, y, size, width = 420) => {
      doc.font(face(true)).fontSize(size).fillColor(INK);
      if (hasArabic(txt)) {
        drawBidiLine(doc, String(txt), x, y, width, { align: 'left', baseDir: 'rtl', wordSpacing: ARABIC_WORD_SPACING });
      } else {
        doc.text(String(txt), x, y, { lineBreak: false });
      }
    };

    // -- the head: the logo, the name, and how to reach us ------------------
    try {
      if (fs.existsSync(LOGO)) doc.image(LOGO, L, 30, { height: 70 });
    } catch { /* the label is still a label without it */ }

    doc.font('Helvetica-Bold').fontSize(20).fillColor(INK)
      .text(config.companyName.toUpperCase(), L + 96, 44, { lineBreak: false });

    doc.font('Helvetica').fontSize(11).fillColor(INK);
    const contact = [phone ? `phone: ${phone}` : null, email ? `Email: ${email}` : null].filter(Boolean);
    contact.forEach((line, i) => {
      doc.text(line, R - doc.widthOfString(line), 48 + i * 16, { lineBreak: false });
    });

    // The two red rules that run under the head on MKY's label.
    const rules = (y) => {
      doc.save().lineWidth(2.4).strokeColor(RED).moveTo(L, y).lineTo(R, y).stroke();
      doc.lineWidth(2.4).strokeColor(RED).moveTo(L, y + 7).lineTo(R, y + 7).stroke().restore();
    };
    rules(112);

    // -- the three lines anyone reads from a distance ------------------------
    const labelX = L + 6;
    const valueX = L + 210;
    let y = 150;

    const line = (label, text, size = 22) => {
      doc.font('Helvetica-Bold').fontSize(15).fillColor(BLUE)
        .text(label, labelX, y + (size - 15) / 2 + 1, { lineBreak: false });
      value(text || '—', valueX, y, size);
      y += size + 22;
    };

    // The route, as MKY writes it: the loading port, then where it is bound.
    line(`${String(b.origin_port ?? 'LOADING').toUpperCase()}-:`, String(b.destination_port ?? '').toUpperCase(), 22);
    line('MARKS :', [b.make, b.model].filter(Boolean).join(' ').toUpperCase(), 22);
    line('CHASS. N°', b.vin ?? '', 22);

    // The reference, alone and large: the one thing a yard calls out.
    doc.font('Helvetica-Bold').fontSize(26).fillColor(INK)
      .text(shipment?.shipment_id || b.booking_ref, labelX, y + 6, { lineBreak: false });
    y += 52;

    // -- delivery instructions ----------------------------------------------
    rules(y);
    y += 24;

    doc.font('Helvetica-Bold').fontSize(14).fillColor(BLUE).text('Delivery Instructions:', labelX, y, { lineBreak: false });
    y += 24;

    if (terminalHours) {
      doc.font('Helvetica').fontSize(12).fillColor(INK).text(terminalHours, labelX, y, { width: W - 12 });
      y = doc.y + 8;
    }
    if (agent) {
      for (const row of String(agent).split('\n').filter(Boolean)) {
        doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(row, labelX, y, { lineBreak: false });
        y += 17;
      }
    }

    // The customer, quietly at the foot: the label is about the vehicle, but
    // whose it is settles an argument on a quay.
    const who = [b.customer_name, b.booking_ref].filter(Boolean).join('  ·  ');
    doc.font('Helvetica').fontSize(9).fillColor('#666666');
    doc.text(who, R - doc.widthOfString(who), 545, { lineBreak: false });

    doc.end();
  });
}
