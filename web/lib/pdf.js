/**
 * Booking confirmation PDF, generated in memory (no temp files - the serverless
 * filesystem is read-only apart from /tmp).
 */

import PDFDocument from 'pdfkit';
import { config } from './config.js';

const INK = '#12202e';
const MUTED = '#5b6b7c';
const BRAND = '#0b4a6f';
const LINE = '#d8e0e8';

/**
 * @param {object} b a row from the bookings table
 * @returns {Promise<Buffer>}
 */
export function bookingConfirmationPdf(b) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const parts = [];
    doc.on('data', (c) => parts.push(c));
    doc.on('end', () => resolve(Buffer.concat(parts)));
    doc.on('error', reject);

    const left = 50;
    const right = 545;

    // -- header --------------------------------------------------------------
    doc.rect(0, 0, 595, 96).fill(BRAND);
    doc.fillColor('#ffffff').fontSize(20).font('Helvetica-Bold').text(config.companyName, left, 30);
    doc.fontSize(9.5).font('Helvetica').fillColor('#cfe2ee')
      .text('Freight forwarding and customs clearance into Egypt', left, 56);
    doc.fontSize(15).font('Helvetica-Bold').fillColor('#ffffff')
      .text('BOOKING REQUEST', left, 30, { width: right - left, align: 'right' });
    doc.fontSize(11).font('Helvetica').fillColor('#cfe2ee')
      .text(b.booking_ref, left, 52, { width: right - left, align: 'right' });

    doc.fillColor(INK);
    let y = 128;

    // -- status banner -------------------------------------------------------
    doc.roundedRect(left, y, right - left, 34, 5).fill('#fff5e0');
    doc.fillColor('#8a5a00').fontSize(10).font('Helvetica-Bold')
      .text('STATUS: AWAITING CONFIRMATION', left + 14, y + 8);
    doc.fontSize(8.5).font('Helvetica')
      .text('This is a request, not a confirmed booking. Space and pricing are confirmed by Booking Operations.', left + 14, y + 20);
    doc.fillColor(INK);
    y += 54;

    // -- helpers -------------------------------------------------------------
    const heading = (text) => {
      doc.fontSize(11).font('Helvetica-Bold').fillColor(BRAND).text(text, left, y);
      y += 16;
      doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(1).stroke();
      y += 10;
    };

    const row = (label, value) => {
      if (value === null || value === undefined || value === '') return;
      doc.fontSize(9.5).font('Helvetica').fillColor(MUTED).text(label, left, y, { width: 150 });
      doc.fontSize(10).font('Helvetica-Bold').fillColor(INK)
        .text(String(value), left + 155, y, { width: right - left - 155 });
      y = doc.y + 7;
    };

    // -- content -------------------------------------------------------------
    heading('CUSTOMER');
    row('Name', b.customer_name);
    row('Company', b.company);
    row('Contact', b.customer_contact);
    y += 8;

    heading('ROUTE');
    row('Origin country', b.origin_country);
    row('Port of loading', b.origin_port);
    row('Destination port', b.destination_port);
    row('Incoterm', b.incoterm);
    y += 8;

    heading('CARGO');
    row('Description', b.cargo_description);
    row('Gross weight', b.gross_weight_kg ? `${fmt(b.gross_weight_kg)} kg` : null);
    row('Volume', b.volume_cbm ? `${fmt(b.volume_cbm)} cbm` : null);
    row('Cargo ready date', b.ready_date);
    row('Notes', b.notes);
    y += 8;

    heading('DOCUMENTS TO PREPARE');
    doc.fontSize(9.5).font('Helvetica').fillColor(INK);
    for (const item of [
      'Commercial invoice',
      'Packing list',
      'ACID number (registered on the Nafeza platform before shipping)',
      'MRN from the export country',
      'Bill of Lading or Air Waybill',
      'Certificate of origin',
    ]) {
      doc.text(`•  ${item}`, left + 4, y);
      y = doc.y + 3;
    }
    y += 12;

    heading('WHAT HAPPENS NEXT');
    doc.fontSize(9.5).font('Helvetica').fillColor(INK).text(
      'Booking Operations will review this request and confirm space, schedule and pricing by email within ' +
      'one business day. Please have the documents above ready. The ACID number must be issued before the ' +
      'goods are shipped; cargo arriving without a valid ACID cannot be cleared.',
      left, y, { width: right - left, align: 'justify', lineGap: 2 },
    );

    // -- footer --------------------------------------------------------------
    const fy = 760;
    doc.moveTo(left, fy).lineTo(right, fy).strokeColor(LINE).stroke();
    doc.fontSize(8).font('Helvetica').fillColor(MUTED).text(
      `${config.companyName}  ·  bookings@mkcglobal.example  ·  +20 3 555 0143\n` +
      `Received ${new Date(b.created_at ?? Date.now()).toUTCString()} via ${b.channel}  ·  Reference ${b.booking_ref}`,
      left, fy + 8, { width: right - left, align: 'center' },
    );

    doc.end();
  });
}

function fmt(n) {
  return Number(n).toLocaleString('en-US');
}
