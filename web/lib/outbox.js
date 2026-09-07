/**
 * The notification outbox.
 *
 * Nothing important is sent from inside the handler that caused it. The handler
 * writes down what has to be said, in the same breath as the change it is
 * announcing; a separate drain delivers it and retries until it lands.
 *
 * Two failures this replaces, both seen in the field:
 *   - Operations confirmed a booking, the Telegram call timed out, the operator
 *     saw "customer told" and the customer heard nothing, ever.
 *   - A retried webhook re-ran the confirmation and the customer was told
 *     twice, with two different shipment references in the two messages.
 *
 * The idempotency key is what fixes both: one event produces one row, and the
 * unique index means a retry is a no-op rather than a second message.
 */

import { db } from './supabase.js';
import { sendMessage, sendDocument } from './telegram.js';
import { audit, logEvent } from './audit.js';
import { M } from './flow/messages.js';
import * as kb from './flow/keyboards.js';

/** Retry schedule, in minutes, indexed by attempt. Beyond the end: dead. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 240, 720];

/**
 * Records something that must be said to a client.
 *
 * @param {{chatId: string|number, clientId?: number|null, eventType: string,
 *          entityType?: string, entityId?: string, payload?: object,
 *          idempotencyKey: string, channel?: string}} event
 * @returns {Promise<{ok: boolean, queued: boolean, error?: string}>}
 */
export async function enqueue(event) {
  if (!event?.chatId || !event?.eventType || !event?.idempotencyKey) {
    return { ok: false, queued: false, error: 'chatId, eventType and idempotencyKey are required' };
  }

  const row = {
    client_id: event.clientId ?? null,
    channel: event.channel ?? 'telegram',
    telegram_chat_id: numeric(event.chatId),
    chat_id: String(event.chatId),
    event_type: event.eventType,
    entity_type: event.entityType ?? null,
    entity_id: event.entityId != null ? String(event.entityId) : null,
    payload: event.payload ?? {},
    status: 'pending',
    idempotency_key: String(event.idempotencyKey).slice(0, 200),
    available_at: new Date().toISOString(),
  };

  const { error } = await db().from('notification_outbox').insert(row);
  if (error) {
    // 23505 = the unique index on idempotency_key. This exact event has already
    // been queued; that is the mechanism working, not a failure.
    if (error.code === '23505') return { ok: true, queued: false };
    console.error('outbox enqueue failed:', error.message);
    return { ok: false, queued: false, error: error.message };
  }

  logEvent('outbox_queued', { event_type: event.eventType, entity_id: row.entity_id });
  return { ok: true, queued: true };
}

/**
 * Sends what is due.
 *
 * Safe to run concurrently: a row is claimed with a conditional update, so two
 * drains racing for the same message produce one delivery and one no-op.
 *
 * @param {{limit?: number, send?: Function}} options
 *   `send` exists so the retry behaviour can be tested against a transport that
 *   fails on demand. Delivery guarantees that have never been seen to fail are
 *   not guarantees.
 */
export async function drain({ limit = 20, send = sendMessage, sendFile = sendDocument } = {}) {
  const now = new Date().toISOString();
  const { data: due, error } = await db()
    .from('notification_outbox')
    .select('*')
    .eq('status', 'pending')
    .lte('available_at', now)
    .order('available_at', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('outbox read failed:', error.message);
    return { ok: false, error: error.message };
  }

  const result = { ok: true, considered: due?.length ?? 0, sent: 0, retried: 0, dead: 0, skipped: 0 };

  for (const row of due ?? []) {
    // Read as a number, not trusted as one. A null or missing attempt_count -
    // a row written by an older deployment, or by hand - made this NaN, and
    // `NaN >= BACKOFF.length` is false, so the row could never reach the
    // dead-letter cap and would have been retried for ever on an invalid date.
    const attempts = Number.isFinite(Number(row.attempt_count)) ? Number(row.attempt_count) : 0;

    // Claim it. `.eq('status','pending')` is the whole guard: the second drain
    // matches no row and moves on rather than sending a duplicate.
    const { data: claimed } = await db()
      .from('notification_outbox')
      .update({ status: 'sending', attempt_count: attempts + 1, updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id');

    if (!claimed?.length) { result.skipped++; continue; }

    const message = render(row);
    if (!message) {
      await finish(row, 'dead', `no renderer for event ${row.event_type}`);
      result.dead++;
      continue;
    }

    try {
      if (message.document) {
        // A PDF is its own outbox row with its own key, never a second send
        // bolted onto a text row: that way each is delivered exactly once and
        // a failure retries only the half that failed.
        const file = await buildDocument(message.document);
        if (!file) throw new Error(`could not build ${message.document.kind}`);
        await sendFile(row.chat_id, file.buffer, file.filename, file.caption);
      } else {
        // returnMessage, because sendMessage LOGS a Telegram-level failure and
        // resolves anyway. Without reading ok back, every undelivered message
        // would be marked sent and the retry would never happen - which is the
        // exact failure this table exists to prevent.
        const sent = await send(row.chat_id, message.text, {
          inline: message.inline,
          returnMessage: true,
        });
        if (!sent?.ok) {
          throw new Error(sent?.description || `Telegram refused the message (${sent?.error_code ?? 'no response'})`);
        }
      }
      await finish(row, 'sent');
      result.sent++;
      await audit({
        actor_type: 'system',
        action: 'notification_sent',
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        metadata: { event_type: row.event_type, attempt: attempts + 1 },
      });
    } catch (err) {
      const permanent = isPermanent(err?.message);
      if (permanent || attempts + 1 >= BACKOFF_MINUTES.length) {
        await finish(row, 'dead', err?.message);
        result.dead++;
      } else {
        const wait = BACKOFF_MINUTES[attempts] ?? 60;
        await db().from('notification_outbox').update({
          status: 'pending',
          last_error: String(err?.message ?? 'unknown').slice(0, 500),
          available_at: new Date(Date.now() + wait * 60_000).toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', row.id);
        result.retried++;
      }
    }
  }

  logEvent('outbox_drained', result);
  return result;
}

async function finish(row, status, error = null) {
  await db().from('notification_outbox').update({
    status,
    ...(status === 'sent' ? { sent_at: new Date().toISOString() } : {}),
    ...(error ? { last_error: String(error).slice(0, 500) } : {}),
    updated_at: new Date().toISOString(),
  }).eq('id', row.id);
}

/**
 * A client who has blocked the bot, or a chat that no longer exists, will never
 * accept this message however many times we try. Retrying those forever is how
 * an outbox turns into a permanent background load.
 */
function isPermanent(message) {
  return /bot was blocked|user is deactivated|chat not found|bot can't initiate|CHAT_WRITE_FORBIDDEN/i
    .test(String(message ?? ''));
}

/**
 * Turns a queued event into the message a client reads.
 *
 * Every value comes from the payload written at enqueue time, which came from
 * the database row. Nothing here composes a status, a vessel or a date of its
 * own - an outbox row with a missing field renders the field as absent rather
 * than filling it in.
 */
export function render(row) {
  const p = row?.payload ?? {};

  switch (row.event_type) {
    case 'booking_request_submitted':
      return { text: M.submitted(), inline: kb.afterSubmitted() };

    case 'booking_confirmed': {
      if (!p.booking_ref || !p.vin) return null;
      const text = M.bookingConfirmed({
        booking_ref: p.booking_ref,
        vin: p.vin,
        make: p.make ?? '—',
        origin_port: p.origin_port ?? '—',
        destination_port: p.destination_port ?? '—',
      });
      // The shipment reference is what they will actually track with, so it
      // goes in the message that tells them the booking is confirmed.
      const tail = p.shipment_id
        ? `\n\nرقم الشحنة للتتبع / Track with: ${p.shipment_id}`
        : '';
      return { text: text + tail, inline: kb.afterConfirmed() };
    }

    case 'booking_rejected':
      if (!p.booking_ref) return null;
      return { text: M.bookingRejected(p.booking_ref, p.reason ?? null), inline: kb.homeOnly() };

    case 'missing_information_requested':
      if (!p.booking_ref) return null;
      return {
        text: M.needsClientAction(p.booking_ref, p.requested_ar ?? p.requested ?? '', p.requested ?? ''),
        inline: kb.homeOnly(),
      };

    case 'mrn_issued':
      if (!p.mrn_number) return null;
      return {
        text: M.documentReceived(`رقم MRN ${p.mrn_number}`, `MRN ${p.mrn_number}`),
        inline: kb.homeOnly(),
      };

    case 'operations_message':
      if (!p.text) return null;
      return { text: String(p.text), inline: kb.homeOnly() };

    // The client's own copy of the paperwork, in the chat they booked from.
    // Delivered as its own row so the retry that matters - "did they actually
    // receive the PDF" - is answered separately from "did they get the text".
    case 'booking_request_pdf':
    case 'booking_confirmed_pdf':
      if (!p.booking_ref) return null;
      return {
        text: '',
        document: {
          kind: 'booking_pdf',
          booking_ref: p.booking_ref,
          caption: row.event_type === 'booking_confirmed_pdf'
            ? `تأكيد الحجز ${p.booking_ref} - نسختك بصيغة PDF\nBooking confirmation ${p.booking_ref} - your PDF copy`
            : `طلب حجز ${p.booking_ref} - نسختك بصيغة PDF\nBooking request ${p.booking_ref} - your PDF copy`,
        },
      };

    default:
      return null;
  }
}

/**
 * Builds the file a queued document row asks for.
 *
 * The booking is read fresh at delivery time on purpose: a row queued while a
 * request was pending and retried after Operations confirmed it should carry
 * the confirmation, not a stale "awaiting confirmation" sheet.
 */
async function buildDocument(spec) {
  if (spec.kind !== 'booking_pdf') return null;

  const { data: booking } = await db()
    .from('bookings').select('*').eq('booking_ref', spec.booking_ref).maybeSingle();
  if (!booking) return null;

  const { bookingConfirmationPdf } = await import('./pdf.js');
  const buffer = await bookingConfirmationPdf(booking);
  return { buffer, filename: `${booking.booking_ref}.pdf`, caption: spec.caption };
}

function numeric(value) {
  const n = Number(String(value).replace(/[^0-9-]/g, ''));
  return Number.isSafeInteger(n) ? n : null;
}
