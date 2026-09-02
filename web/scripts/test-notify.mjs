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
  booking_ref: 'MKC-BKG-260902-SAMPLE',
  status: 'pending_review',
  channel: 'telegram',
  customer_name: 'Arif Rahman',
  customer_contact: 'ariful81848@gmail.com',
  company: 'Rahman Trading Co.',
  origin_country: 'European Union',
  origin_port: 'Rotterdam',
  destination_port: 'Alexandria Port (incl. El Dekheila)',
  cargo_description: '20 pallets of ceramic tiles',
  gross_weight_kg: 18500,
  volume_cbm: 52,
  incoterm: 'FOB',
  ready_date: '2026-09-20',
  notes: null,
  created_at: new Date().toISOString(),
};

const pdf = await bookingConfirmationPdf(sample);
fs.writeFileSync(out, pdf);
console.log(`PDF written: ${out}  (${(pdf.length / 1024).toFixed(1)} KB)`);

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
