/**
 * Builds the two demo source files:
 *   data/MKC_Global_Company_Profile.pdf   -> knowledge base for RAG
 *   data/MKC_Global_Operations.xlsx       -> shipments + events + clients + contacts
 *
 * Run:  npm run gen:data
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { COMPANY, DEPARTMENT_CONTACTS, SHIPMENTS, KNOWLEDGE_SECTIONS } from './demo-dataset.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const PDF_PATH = path.join(dataDir, 'MKC_Global_Company_Profile.pdf');
const XLSX_PATH = path.join(dataDir, 'MKC_Global_Operations.xlsx');

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------
function buildPdf() {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    const stream = fs.createWriteStream(PDF_PATH);
    doc.pipe(stream);

    doc.fontSize(24).font('Helvetica-Bold').text(COMPANY.name);
    doc.moveDown(0.2);
    doc.fontSize(12).font('Helvetica').fillColor('#555').text(COMPANY.tagline);
    doc.moveDown(0.2);
    doc.fontSize(9).text(`${COMPANY.hq}  |  ${COMPANY.phone}  |  ${COMPANY.email}`);
    doc.fillColor('#000');
    doc.moveDown(1);
    doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor('#cccccc').stroke();
    doc.moveDown(1);

    doc.fontSize(10).font('Helvetica-Oblique').fillColor('#666')
      .text('Company profile and service handbook. This document is the source of the chatbot knowledge base.');
    doc.fillColor('#000');
    doc.moveDown(1.2);

    for (const section of KNOWLEDGE_SECTIONS) {
      if (doc.y > 700) doc.addPage();
      doc.fontSize(13).font('Helvetica-Bold').text(section.title);
      doc.moveDown(0.35);
      doc.fontSize(10.5).font('Helvetica').text(section.body, { align: 'justify', lineGap: 2 });
      doc.moveDown(1);
    }

    doc.addPage();
    doc.fontSize(13).font('Helvetica-Bold').text('Department contact directory');
    doc.moveDown(0.6);
    for (const [name, email, phone, scope] of DEPARTMENT_CONTACTS) {
      doc.fontSize(11).font('Helvetica-Bold').text(name);
      doc.fontSize(10).font('Helvetica').fillColor('#444').text(`${scope}`);
      doc.fillColor('#000').text(`${email}   ${phone}`);
      doc.moveDown(0.7);
    }

    doc.moveDown(0.5);
    doc.fontSize(13).font('Helvetica-Bold').text('Sample shipment references');
    doc.moveDown(0.4);
    doc.fontSize(9.5).font('Helvetica');
    for (const s of SHIPMENTS) {
      doc.text(`${s.shipment_id}  |  ${s.acid_id}  |  ${s.customer_name}  |  ${s.origin_port} to ${s.destination_port}  |  ${s.status}`);
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------
async function buildXlsx() {
  const wb = new ExcelJS.Workbook();
  wb.creator = COMPANY.name;
  wb.created = new Date();

  const header = (sheet, columns) => {
    sheet.columns = columns;
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  };

  // -- Shipments ------------------------------------------------------------
  const ship = wb.addWorksheet('Shipments');
  header(ship, [
    { header: 'shipment_id', key: 'shipment_id', width: 14 },
    { header: 'acid_id', key: 'acid_id', width: 15 },
    { header: 'bl_number', key: 'bl_number', width: 18 },
    { header: 'container_no', key: 'container_no', width: 18 },
    { header: 'customer_name', key: 'customer_name', width: 20 },
    { header: 'customer_email', key: 'customer_email', width: 34 },
    { header: 'customer_phone', key: 'customer_phone', width: 18 },
    { header: 'origin_port', key: 'origin_port', width: 22 },
    { header: 'destination_port', key: 'destination_port', width: 32 },
    { header: 'mode', key: 'mode', width: 10 },
    { header: 'status', key: 'status', width: 32 },
    { header: 'mrn_status', key: 'mrn_status', width: 12 },
    { header: 'payment_status', key: 'payment_status', width: 14 },
    { header: 'delivery_status', key: 'delivery_status', width: 14 },
    { header: 'cargo_description', key: 'cargo_description', width: 36 },
    { header: 'gross_weight_kg', key: 'gross_weight_kg', width: 15 },
    { header: 'volume_cbm', key: 'volume_cbm', width: 12 },
    { header: 'vessel', key: 'vessel', width: 26 },
    { header: 'etd', key: 'etd', width: 12 },
    { header: 'eta', key: 'eta', width: 12 },
  ]);
  for (const s of SHIPMENTS) {
    const { events, ...row } = s;
    ship.addRow(row);
  }

  // -- Tracking events ------------------------------------------------------
  const ev = wb.addWorksheet('Tracking Events');
  header(ev, [
    { header: 'shipment_id', key: 'shipment_id', width: 14 },
    { header: 'event_date', key: 'event_date', width: 14 },
    { header: 'location', key: 'location', width: 20 },
    { header: 'description', key: 'description', width: 60 },
  ]);
  for (const s of SHIPMENTS) {
    for (const [date, location, description] of s.events) {
      ev.addRow({ shipment_id: s.shipment_id, event_date: date, location, description });
    }
  }

  // -- Clients --------------------------------------------------------------
  const cl = wb.addWorksheet('Clients');
  header(cl, [
    { header: 'full_name', key: 'full_name', width: 22 },
    { header: 'email', key: 'email', width: 34 },
    { header: 'phone', key: 'phone', width: 18 },
    { header: 'shipments', key: 'shipments', width: 30 },
  ]);
  const byCustomer = new Map();
  for (const s of SHIPMENTS) {
    const entry = byCustomer.get(s.customer_name) ?? { email: s.customer_email, phone: s.customer_phone, refs: [] };
    entry.refs.push(s.shipment_id);
    byCustomer.set(s.customer_name, entry);
  }
  for (const [full_name, v] of byCustomer) {
    cl.addRow({ full_name, email: v.email, phone: v.phone, shipments: v.refs.join(', ') });
  }

  // -- Departments ----------------------------------------------------------
  const dp = wb.addWorksheet('Departments');
  header(dp, [
    { header: 'department', key: 'department', width: 24 },
    { header: 'email', key: 'email', width: 34 },
    { header: 'phone', key: 'phone', width: 18 },
    { header: 'handles', key: 'handles', width: 55 },
  ]);
  for (const [department, email, phone, handles] of DEPARTMENT_CONTACTS) {
    dp.addRow({ department, email, phone, handles });
  }

  // -- Company facts (also ingested into the knowledge base) ----------------
  const info = wb.addWorksheet('Company Info');
  header(info, [
    { header: 'topic', key: 'topic', width: 34 },
    { header: 'detail', key: 'detail', width: 110 },
  ]);
  for (const section of KNOWLEDGE_SECTIONS) {
    info.addRow({ topic: section.title, detail: section.body });
  }

  await wb.xlsx.writeFile(XLSX_PATH);
}

await buildPdf();
await buildXlsx();

console.log('Created:');
console.log('  ' + PDF_PATH);
console.log('  ' + XLSX_PATH);
console.log('\nNext: npm run seed   (load shipments into Supabase)');
console.log('      npm run ingest (load the knowledge base into Supabase)');
