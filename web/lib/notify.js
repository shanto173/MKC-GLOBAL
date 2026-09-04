/**
 * Booking notifications: emails the confirmation PDF to the customer and to the
 * ops desk, and pings a staff Telegram group.
 *
 * Nothing here is allowed to break a booking. Every failure is logged and
 * swallowed - the row is already safely in the database by the time we run.
 */

import { config } from './config.js';
import { bookingConfirmationPdf } from './pdf.js';
import { sendDocument, sendMessage } from './telegram.js';

/**
 * @param {object} booking row from the bookings table
 * @returns {Promise<{pdf: boolean, customer_email: boolean, ops_email: boolean, staff_telegram: boolean, errors: string[]}>}
 */
export async function notifyBooking(booking) {
  const result = { pdf: false, customer_email: false, ops_email: false, staff_telegram: false, errors: [] };

  let pdf = null;
  try {
    pdf = await bookingConfirmationPdf(booking);
    result.pdf = true;
  } catch (err) {
    result.errors.push(`pdf: ${err.message}`);
    console.error('booking pdf failed:', err);
  }

  const filename = `${booking.booking_ref}.pdf`;
  const attachments = pdf ? [{ filename, content: pdf.toString('base64') }] : [];

  // -- email the customer ----------------------------------------------------
  const customerEmail = extractEmail(booking.customer_contact);
  const opsRecipients = (config.mail.opsEmail ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  // While testing, the person booking is often the ops inbox itself, which meant
  // two near-identical emails for one booking. One address, one email: the ops
  // copy wins, because it carries reply-to and the full detail.
  const customerIsOps = customerEmail && opsRecipients.includes(customerEmail.toLowerCase());
  if (customerIsOps) {
    result.errors.push('customer address is the ops inbox - sent one email instead of two');
  }

  if (customerEmail && !customerIsOps && config.mail.apiKey) {
    try {
      await sendEmail({
        to: [customerEmail],
        subject: `Booking request received - ${booking.booking_ref}`,
        html: customerHtml(booking),
        attachments,
      });
      result.customer_email = true;
    } catch (err) {
      result.errors.push(`customer email: ${err.message}`);
      console.error('customer email failed:', err.message);
    }
  }

  // -- email the ops desk ----------------------------------------------------
  if (config.mail.opsEmail && config.mail.apiKey) {
    try {
      await sendEmail({
        to: opsRecipients,
        subject: `NEW BOOKING ${booking.booking_ref} - ${booking.origin_port} to ${booking.destination_port}`,
        html: opsHtml(booking),
        attachments,
        replyTo: customerEmail || undefined,
      });
      result.ops_email = true;
    } catch (err) {
      result.errors.push(`ops email: ${err.message}`);
      console.error('ops email failed:', err.message);
    }
  }

  // -- ping the staff Telegram group ----------------------------------------
  if (config.staffChatId) {
    try {
      const caption =
        `NEW BOOKING  ${booking.booking_ref}\n` +
        `${booking.customer_name} (${booking.customer_contact})\n` +
        `${booking.origin_port} -> ${booking.destination_port}\n` +
        `${booking.cargo_description}` +
        (booking.gross_weight_kg ? `\n${Number(booking.gross_weight_kg).toLocaleString('en-US')} kg` : '') +
        (booking.volume_cbm ? ` / ${booking.volume_cbm} cbm` : '') +
        (booking.incoterm ? `\nIncoterm ${booking.incoterm}` : '') +
        (booking.ready_date ? `\nReady ${booking.ready_date}` : '') +
        `\nvia ${booking.channel}`;

      if (pdf) await sendDocument(config.staffChatId, pdf, filename, caption);
      else await sendMessage(config.staffChatId, caption);
      result.staff_telegram = true;
    } catch (err) {
      result.errors.push(`staff telegram: ${err.message}`);
      console.error('staff telegram failed:', err.message);
    }
  }

  return result;
}

/**
 * Tells the customer what Operations decided. This is roadmap step 5, and it is
 * the step that closes the loop: until now a booking sat at pending_review and
 * the customer only heard back if somebody remembered to email them.
 *
 * The message goes to the chat they booked from, so it lands where they are,
 * and by email as well when we have an address.
 *
 * @param {object} booking
 * @param {'confirmed'|'rejected'} decision
 * @param {string} [note] reason or instructions from Operations
 */
export async function notifyBookingDecision(booking, decision, note = '') {
  const result = { telegram: false, email: false, errors: [] };
  const confirmed = decision === 'confirmed';

  const detail =
    `${booking.booking_ref}\n` +
    `${[booking.make, booking.model].filter(Boolean).join(' ')}\n` +
    `${booking.vin ? `Chassis ${booking.vin}\n` : ''}` +
    `${booking.origin_port} to ${booking.destination_port}`;

  const arabic = confirmed
    ? `تم تأكيد حجزك.\n\n${detail}\n\n${note ? note + '\n\n' : ''}شكراً لاختيارك ${config.companyName}.`
    : `للأسف مقدرناش نأكد الحجز ${booking.booking_ref} دلوقتي.\n\n${note || 'فريق عمليات الحجز هيتواصل معاك بالتفاصيل.'}`;

  const english = confirmed
    ? `Your booking is confirmed.\n\n${detail}\n\n${note ? note + '\n\n' : ''}Thank you for choosing ${config.companyName}.`
    : `We could not confirm booking ${booking.booking_ref} at this time.\n\n${note || 'Booking Operations will contact you with details.'}`;

  // The customer booked in one language; send both, as the chat already does.
  if (booking.chat_id && booking.channel === 'telegram' && config.telegram.token) {
    try {
      await sendMessage(booking.chat_id, `${arabic}\n|\n${english}`);
      result.telegram = true;
    } catch (err) {
      result.errors.push(`telegram: ${err.message}`);
      console.error('decision telegram failed:', err.message);
    }
  }

  const email = extractEmail(booking.customer_contact);
  if (email && config.mail.apiKey) {
    try {
      await sendEmail({
        to: [email],
        subject: confirmed
          ? `Booking confirmed - ${booking.booking_ref}`
          : `Booking ${booking.booking_ref} - action needed`,
        html: wrap(`
          <div style="font-size:16px;font-weight:700;margin-bottom:4px">
            ${confirmed ? 'Your booking is confirmed' : 'We could not confirm this booking yet'}
          </div>
          <div style="font-size:13px;color:#475569;margin-bottom:18px">
            ${escapeHtml(note || (confirmed
              ? 'Our Operations team has accepted this shipment.'
              : 'Booking Operations will contact you with details.'))}
          </div>
          ${detailTable(booking)}`),
      });
      result.email = true;
    } catch (err) {
      result.errors.push(`email: ${err.message}`);
      console.error('decision email failed:', err.message);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Resend (https://resend.com) - free tier, no domain needed for testing.
// ---------------------------------------------------------------------------

async function sendEmail({ to, subject, html, attachments = [], replyTo }) {
  const body = { from: config.mail.from, to, subject, html };
  if (attachments.length) body.attachments = attachments;
  if (replyTo) body.reply_to = replyTo;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.mail.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`resend ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const wrap = (inner) => `<!doctype html><html><body style="margin:0;background:#f5f7fa;padding:24px;
  font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#12202e">
  <table role="presentation" width="100%" style="max-width:600px;margin:0 auto;background:#fff;
    border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
    <tr><td style="background:#0b4a6f;padding:20px 24px;color:#fff">
      <div style="font-size:17px;font-weight:700">${escapeHtml(config.companyName)}</div>
      <div style="font-size:12px;opacity:.8;margin-top:2px">Freight forwarding and customs clearance into Egypt</div>
    </td></tr>
    <tr><td style="padding:24px">${inner}</td></tr>
    <tr><td style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;
      font-size:11px;color:#64748b">This message was generated automatically by the ${escapeHtml(config.companyName)} assistant.</td></tr>
  </table></body></html>`;

function detailTable(b) {
  const rows = [
    ['Reference', b.booking_ref],
    ['Customer', b.customer_name],
    ['Company', b.company],
    ['Contact', b.customer_contact],
    ['Origin country', b.origin_country],
    ['Port of loading', b.origin_port],
    ['Destination', b.destination_port],
    ['Cargo', b.cargo_description],
    ['Gross weight', b.gross_weight_kg ? `${Number(b.gross_weight_kg).toLocaleString('en-US')} kg` : null],
    ['Volume', b.volume_cbm ? `${b.volume_cbm} cbm` : null],
    ['Incoterm', b.incoterm],
    ['Cargo ready', b.ready_date],
    ['Notes', b.notes],
    ['Received via', b.channel],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');

  return `<table role="presentation" width="100%" style="border-collapse:collapse;font-size:13px">${rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 0;color:#64748b;width:150px">${escapeHtml(k)}</td>
         <td style="padding:6px 0;font-weight:600">${escapeHtml(String(v))}</td></tr>`,
    )
    .join('')}</table>`;
}

function customerHtml(b) {
  return wrap(`
    <div style="font-size:16px;font-weight:700;margin-bottom:4px">Thank you — we have your booking request</div>
    <div style="font-size:13px;color:#475569;margin-bottom:18px">
      Reference <strong>${escapeHtml(b.booking_ref)}</strong>. This is a request, not yet a confirmed booking.
      Our Booking Operations team will confirm space, schedule and pricing by email within one business day.
    </div>
    ${detailTable(b)}
    <div style="margin-top:20px;padding:14px;background:#f1f5f9;border-radius:8px;font-size:13px">
      <strong>Please prepare:</strong> commercial invoice, packing list, ACID number, MRN,
      Bill of Lading or Air Waybill, and certificate of origin.<br><br>
      The ACID must be issued <strong>before</strong> the goods are shipped — cargo arriving without a
      valid ACID cannot be cleared.
    </div>
    <div style="margin-top:16px;font-size:12px;color:#64748b">
      The attached PDF is your copy of this request. Reply to this email if anything is wrong.
    </div>`);
}

function opsHtml(b) {
  return wrap(`
    <div style="font-size:16px;font-weight:700;margin-bottom:4px">New booking request</div>
    <div style="font-size:13px;color:#475569;margin-bottom:18px">
      Captured by the assistant via <strong>${escapeHtml(b.channel)}</strong>. Status
      <strong>${escapeHtml(b.status)}</strong> — needs a human to confirm space and price.
    </div>
    ${detailTable(b)}
    <div style="margin-top:18px;font-size:12px;color:#64748b">
      Reply to this email to reach the customer directly.
    </div>`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function extractEmail(contact) {
  const m = String(contact || '').match(/[^\s<>@]+@[^\s<>@]+\.[a-z]{2,}/i);
  return m ? m[0] : null;
}
