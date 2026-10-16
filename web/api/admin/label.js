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
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { config } from '../../lib/config.js';
import { letterhead, marksBlock, rules, BLUE, INK } from '../../lib/letterhead.js';
import { hasArabic, drawBidiLine, ARABIC_WORD_SPACING } from '../../lib/rtl.js';
import { db } from '../../lib/supabase.js';
import { letterheadContact, settings } from '../../lib/settings.js';

const FONT_DIR = path.join(fileURLToPath(new URL('../../assets/', import.meta.url)), 'fonts');

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

  // MKY's own contacts, as their label carries them; the desk's Settings win.
  const [contact, table] = await Promise.all([
    letterheadContact().catch(() => ({})),
    settings().catch(() => ({})),
  ]);

  const pdf = await buildLabel(booking, {
    shipment,
    phone: contact.phone ?? null,
    email: contact.email ?? null,
    terminalHours: table.label_terminal_hours || null,
    agent: table.label_agent || null,
  });

  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `inline; filename="${ref}-label.pdf"`);
  res.status(200).send(pdf);
}

/** Exported so a test can read the label itself, not only this file's source. */
export function buildLabel(b, { shipment, phone = null, email = null, terminalHours = null, agent = null }) {
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

    // -- the head, and the three lines anyone reads from a distance ----------
    let y = letterhead(doc, { left: L, right: R, top: 30, phone, email, scale: 1.4 }) + 14;
    const labelX = L + 6;

    y = marksBlock(doc, {
      left: L, right: R, y,
      // The route, as MKY writes it: the loading port, then where it is bound.
      route: [`${String(b.origin_port ?? 'LOADING').toUpperCase()}-:`, String(b.destination_port ?? '').toUpperCase()],
      marks: ['MARKS :', [b.make, b.model].filter(Boolean).join(' ').toUpperCase()],
      chassis: ['CHASS. N°', b.vin ?? ''],
      size: 22,
      labelSize: 15,
      write: (text, x, ty, size) => value(text, x, ty, size),
    }) + 6;

    // The reference, alone and large: the one thing a yard calls out.
    doc.font('Helvetica-Bold').fontSize(26).fillColor(INK)
      .text(shipment?.shipment_id || b.booking_ref, labelX, y + 6, { lineBreak: false });
    y += 52;

    // -- delivery instructions ----------------------------------------------
    rules(doc, { left: L, right: R, y, scale: 1.4 });
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
