/**
 * Renders a sample booking confirmation PDF and, if configured, actually sends
 * the email and the staff Telegram ping.
 *
 *   npm run test:pdf              PDF only, written to data/sample-booking.pdf
 *   npm run test:pdf -- --send    also send the email and Telegram message
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bookingConfirmationPdf } from '../lib/pdf.js';
import { notifyBooking } from '../lib/notify.js';
import { config } from '../lib/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'data', 'sample-booking.pdf');

const sample = {
  booking_ref: 'MKY-BKG-260907-SAMPLE',
  status: 'pending_review',
  channel: 'telegram',
  customer_name: 'Ariful Islam',
  customer_contact: 'ariful81848@gmail.com',
  company: 'MKY Global Forwarding',
  origin_country: 'Lithuania',
  origin_port: 'Vilnius',
  destination_port: 'Alexandria Port (incl. El Dekheila)',
  // A real unit, because that is what the business ships: one used commercial
  // vehicle identified by its chassis number.
  vin: 'W1T96340310484233',
  make: 'Mercedes-Benz',
  model: 'Actros 1845',
  engine_condition: 'Engine damaged, unit does not run',
  cargo_description: 'Mercedes-Benz Actros 1845 tractor unit',
  gross_weight_kg: 8266,
  volume_cbm: null,
  incoterm: 'FOB',
  ready_date: '2026-09-20',
  mrn_number: '25LTVR000012345678',
  acid_number: '5403381091024510014',
  notes: 'Customer will send the invoice and packing list once the unit is loaded.',
  language: 'en',
  created_at: new Date().toISOString(),
};

const pdf = await bookingConfirmationPdf(sample);
fs.writeFileSync(out, pdf);
console.log(`PDF written: ${out}  (${(pdf.length / 1024).toFixed(1)} KB)`);

// The Arabic layout is the one that breaks, so it is rendered every time too.
const arOut = out.replace(/\.pdf$/, '-ar.pdf');
const arPdf = await bookingConfirmationPdf({
  ...sample,
  language: 'ar',
  customer_name: 'عارف إسلام',
  company: 'إم كيه واي جلوبال للشحن',
  engine_condition: 'المحرك تالف والوحدة لا تعمل',
  notes: 'العميل هيبعت الفاتورة وقائمة التعبئة بعد تحميل الوحدة.',
});
fs.writeFileSync(arOut, arPdf);
console.log(`Arabic PDF : ${arOut}  (${(arPdf.length / 1024).toFixed(1)} KB)`);

console.log('\nConfiguration:');
console.log('  RESEND_API_KEY :', config.mail.apiKey ? 'set' : 'NOT SET - emails are skipped');
console.log('  MAIL_FROM      :', config.mail.from);
console.log('  OPS_EMAIL      :', config.mail.opsEmail || 'NOT SET - ops email skipped');
console.log('  STAFF_CHAT_ID  :', config.staffChatId || 'NOT SET - Telegram ping skipped');

if (process.argv.includes('--send')) {
  console.log('\nSending for real...');
  const result = await notifyBooking(sample);
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('\nAdd --send to actually deliver the email and Telegram message.');
}
