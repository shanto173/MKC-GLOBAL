/**
 * Loads data/MKC_Global_Operations.xlsx into Supabase.
 *
 *   npm run seed
 *   npm run seed -- --file data/my-real-export.xlsx
 *
 * Upserts, so it is safe to run again after you edit the workbook. This is the
 * script your ops team re-runs whenever they export fresh data from your TMS.
 */

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { db } from '../lib/supabase.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fileArg = argValue('--file');
const XLSX_PATH = fileArg
  ? path.resolve(process.cwd(), fileArg)
  : path.join(here, '..', 'data', 'MKC_Global_Operations.xlsx');

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(XLSX_PATH);
console.log(`Reading ${XLSX_PATH}`);

// --- Shipments --------------------------------------------------------------
const shipments = rows(wb.getWorksheet('Shipments')).map((r) => ({
  shipment_id: r.shipment_id,
  acid_id: r.acid_id || null,
  bl_number: r.bl_number || null,
  container_no: r.container_no || null,
  customer_name: r.customer_name,
  customer_email: r.customer_email || null,
  customer_phone: r.customer_phone || null,
  origin_port: r.origin_port,
  destination_port: r.destination_port,
  mode: r.mode || 'Sea FCL',
  status: r.status,
  mrn_status: r.mrn_status || null,
  payment_status: r.payment_status || null,
  delivery_status: r.delivery_status || null,
  cargo_description: r.cargo_description || null,
  gross_weight_kg: num(r.gross_weight_kg),
  volume_cbm: num(r.volume_cbm),
  vessel: r.vessel || null,
  etd: date(r.etd),
  eta: date(r.eta),
  updated_at: new Date().toISOString(),
})).filter((s) => s.shipment_id);

const { error: shipErr } = await db().from('shipments').upsert(shipments, { onConflict: 'shipment_id' });
if (shipErr) throw new Error(`shipments upsert failed: ${shipErr.message}`);
console.log(`  shipments      ${shipments.length}`);

// --- Tracking events --------------------------------------------------------
const eventSheet = wb.getWorksheet('Tracking Events');
if (eventSheet) {
  const ids = shipments.map((s) => s.shipment_id);
  // Replace the event history for the shipments in this workbook.
  await db().from('shipment_events').delete().in('shipment_id', ids);

  const events = rows(eventSheet)
    .filter((r) => r.shipment_id && r.description)
    .map((r) => ({
      shipment_id: r.shipment_id,
      event_time: new Date(date(r.event_date) ?? Date.now()).toISOString(),
      location: r.location || null,
      description: r.description,
    }));

  if (events.length) {
    const { error } = await db().from('shipment_events').insert(events);
    if (error) throw new Error(`events insert failed: ${error.message}`);
  }
  console.log(`  events         ${events.length}`);
}

// --- Clients ----------------------------------------------------------------
const clientSheet = wb.getWorksheet('Clients');
if (clientSheet) {
  const clients = rows(clientSheet)
    .filter((r) => r.full_name)
    .map((r) => ({ full_name: r.full_name, email: r.email || null, phone: r.phone || null }));

  for (const c of clients) {
    const { data } = await db().from('clients').select('id').eq('full_name', c.full_name).maybeSingle();
    if (data) await db().from('clients').update(c).eq('id', data.id);
    else await db().from('clients').insert(c);
  }
  console.log(`  clients        ${clients.length}`);
}

console.log('\nSeed complete.');

// ---------------------------------------------------------------------------

function rows(sheet) {
  if (!sheet) return [];
  const headers = [];
  sheet.getRow(1).eachCell((cell, col) => {
    headers[col] = String(text(cell.value)).trim();
  });
  const out = [];
  sheet.eachRow((row, idx) => {
    if (idx === 1) return;
    const obj = {};
    let empty = true;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const key = headers[col];
      if (!key) return;
      const v = text(cell.value);
      obj[key] = v;
      if (String(v).trim() !== '') empty = false;
    });
    if (!empty) out.push(obj);
  });
  return out;
}

/** ExcelJS cells can hold rich text, formulas or hyperlink objects. */
function text(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('text' in value) return value.text;
    if ('result' in value) return value.result;
    if ('richText' in value) return value.richText.map((t) => t.text).join('');
    if ('hyperlink' in value) return value.hyperlink;
  }
  return value;
}

function num(v) {
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && String(v).trim() !== '' ? n : null;
}

function date(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}
