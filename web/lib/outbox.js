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
 *
 * WhatsApp adds one more outcome besides sent and failed: HELD. Outside the
 * 24-hour window only an approved template may be sent; an event with no
 * template, or a client who wrote STOP, leaves the row pending - with its
 * retries untouched and delivery_status saying why - until the client writes
 * again (releaseHeld) or the desk acts. It is never sent as free text Meta
 * would refuse.
 *
 * Every column migration 20261007090000 adds (language, template_name,
 * provider_message_id, delivery_status) is written only once it has been seen
 * to exist. Telegram notifications in production depend on this table, and an
 * insert naming a missing column fails whole.
 */

import { db } from './supabase.js';
import { sendMessage, sendDocument } from './telegram.js';
import { audit, logEvent } from './audit.js';
import { flush } from './background.js';
import { M } from './flow/messages.js';
import * as kb from './flow/keyboards.js';
import { storedLanguage } from './flow/language.js';
import { currentLanguage, normaliseLanguage, withLanguage } from './lang.js';
import { sendToChat, channelOf, phrase } from './channels.js';
import { isSchemaMissing, normaliseDeliveryStatus } from './chatlog.js';
import { isPermanentError, WINDOW_CLOSED, TEMPLATE_MISSING } from './whatsapp.js';

/** Retry schedule, in minutes, indexed by attempt. Beyond the end: dead. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 240, 720];

/**
 * How long a held row waits before the drain looks at it again on its own. A
 * client writing releases it at once; this only catches a template being
 * approved meanwhile.
 */
const HOLD_MINUTES = { needs_template: 6 * 60, opted_out: 24 * 60 };

/**
 * Events that answer something the client just did - their PDF after they
 * confirmed - rather than starting a conversation. A client who wrote STOP
 * still gets these: they asked.
 */
const ANSWERS_CLIENT = new Set(['booking_request_pdf', 'booking_request_submitted', 'document_reply']);

// Whether the 20261007090000 columns exist on notification_outbox.
// null: not yet known, true: seen to work, false: refused once - stop asking.
let extraColumns = null;

/** For tests: forget what was learned about the schema. */
export function resetOutboxForTests() {
  extraColumns = null;
}

/**
 * Runs a write with the new columns when they may exist, and again without
 * them if the database says they do not. The first refusal is remembered, so
 * an unmigrated database costs one extra round trip per process, not per row.
 */
async function withOptionalColumns(base, extra, write) {
  const wanted = Object.fromEntries(Object.entries(extra ?? {}).filter(([, v]) => v !== undefined));
  if (extraColumns !== false && Object.keys(wanted).length) {
    const res = await write({ ...base, ...wanted });
    if (!res.error) { extraColumns = true; return res; }
    if (!isSchemaMissing(res.error)) return res;
    extraColumns = false;
  }
  return write(base);
}

/**
 * Records something that must be said to a client.
 *
 * The channel is the caller's to say; when it does not, a "wa:" chat id is a
 * WhatsApp chat and anything else is Telegram, as it always was.
 *
 * @param {{chatId: string|number, clientId?: number|null, eventType: string,
 *          entityType?: string, entityId?: string, payload?: object,
 *          idempotencyKey: string, channel?: string, language?: 'en'|'ar'}} event
 * @returns {Promise<{ok: boolean, queued: boolean, error?: string}>}
 */
export async function enqueue(event) {
  if (!event?.chatId || !event?.eventType || !event?.idempotencyKey) {
    return { ok: false, queued: false, error: 'chatId, eventType and idempotencyKey are required' };
  }

  const channel = event.channel ?? channelOf(event.chatId);
  const row = {
    client_id: event.clientId ?? null,
    channel,
    // Only a Telegram chat has a numeric Telegram id. A WhatsApp number
    // stripped of its prefix is a perfectly good integer - and the wrong one.
    telegram_chat_id: channel === 'telegram' ? numeric(event.chatId) : null,
    chat_id: String(event.chatId),
    event_type: event.eventType,
    entity_type: event.entityType ?? null,
    entity_id: event.entityId != null ? String(event.entityId) : null,
    payload: event.payload ?? {},
    status: 'pending',
    idempotency_key: String(event.idempotencyKey).slice(0, 200),
    available_at: new Date().toISOString(),
  };

  // The language the client is being answered in right now, when this is
  // queued from inside their turn; otherwise worked out when it is sent.
  const language = normaliseLanguage(event.language) ?? currentLanguage();
  const { error } = await withOptionalColumns(row, { language: language ?? undefined },
    (r) => db().from('notification_outbox').insert(r));
  if (error) {
    // 23505 = the unique index on idempotency_key. This exact event has already
    // been queued; that is the mechanism working, not a failure.
    if (error.code === '23505') return { ok: true, queued: false };
    console.error('outbox enqueue failed:', error.message);
    return { ok: false, queued: false, error: error.message };
  }

  logEvent('outbox_queued', { event_type: event.eventType, entity_id: row.entity_id, channel });
  return { ok: true, queued: true };
}

/**
 * Sends what is due.
 *
 * Safe to run concurrently: a row is claimed with a conditional update, so two
 * drains racing for the same message produce one delivery and one no-op.
 *
 * @param {{limit?: number, send?: Function, sendFile?: Function}} options
 *   `send` and `sendFile` exist so the retry behaviour can be tested against a
 *   Telegram transport that fails on demand. Delivery guarantees that have
 *   never been seen to fail are not guarantees.
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

  const result = { ok: true, considered: due?.length ?? 0, sent: 0, retried: 0, dead: 0, skipped: 0, held: 0 };

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

    const channel = row.channel ?? channelOf(row.chat_id);
    // The client's language, so a notification queued by the desk - where
    // nobody's turn is running - still speaks the language the client chose.
    // No choice, or no column yet: null, and the message is bilingual as before.
    const language = normaliseLanguage(row.language)
      ?? await storedLanguage({ channel, chatId: row.chat_id, clientId: row.client_id ?? null }).catch(() => null);

    const message = withLanguage(language, () => render(row));
    if (!message) {
      await finish(row, 'dead', `no renderer for event ${row.event_type}`);
      result.dead++;
      continue;
    }

    try {
      let outgoing = message;
      if (message.document) {
        // A PDF is its own outbox row with its own key, never a second send
        // bolted onto a text row: that way each is delivered exactly once and
        // a failure retries only the half that failed.
        const file = await buildDocument(message.document, language);
        if (!file) throw new Error(`could not build ${message.document.kind}`);
        outgoing = { text: '', document: { buffer: file.buffer, fileName: file.filename, caption: file.caption } };
      }

      const sent = await sendToChat(
        { channel, chatId: row.chat_id, clientId: row.client_id ?? null },
        outgoing,
        {
          author: 'system',
          language,
          eventType: row.event_type,
          payload: row.payload ?? {},
          bookingRef: row.payload?.booking_ref ?? null,
          allowTemplate: true,
          answering: ANSWERS_CLIENT.has(row.event_type),
          // Held because Meta said the window was closed: it stays closed until
          // the client writes again, whatever our clock says.
          closedUnlessClientWroteAfter: row.delivery_status === 'needs_template' ? row.updated_at ?? null : null,
          transport: { send, sendFile },
        },
      );

      if (sent.status === 'needs_template' || sent.status === 'opted_out') {
        await hold(row, attempts, sent);
        result.held++;
        continue;
      }
      if (!sent.ok) throw Object.assign(new Error(sent.error ?? 'send failed'), { permanent: sent.permanent, code: sent.code });

      await finish(row, 'sent', null, {
        provider_message_id: sent.providerMessageId ?? undefined,
        delivery_status: 'sent',
        template_name: sent.templateName ?? undefined,
      });
      result.sent++;
      await audit({
        actor_type: 'system',
        action: 'notification_sent',
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        metadata: { event_type: row.event_type, attempt: attempts + 1, channel, template: sent.templateName ?? null },
      });
    } catch (err) {
      const permanent = err?.permanent === true || isPermanent(err?.message);
      if (permanent || attempts + 1 >= BACKOFF_MINUTES.length) {
        await finish(row, 'dead', err?.message, { delivery_status: 'failed' });
        result.dead++;
      } else {
        const wait = BACKOFF_MINUTES[attempts] ?? 60;
        await update(row.id, {
          status: 'pending',
          last_error: String(err?.message ?? 'unknown').slice(0, 500),
          available_at: new Date(Date.now() + wait * 60_000).toISOString(),
          updated_at: new Date().toISOString(),
        });
        result.retried++;
      }
    }
  }

  // The chat log of what went out is written in the background; a drain run
  // from a cron route has nothing after it to wait for that, so it waits here.
  await flush();
  logEvent('outbox_drained', result);
  return result;
}

function update(id, base, extra = {}) {
  return withOptionalColumns(base, extra, (patch) => db().from('notification_outbox').update(patch).eq('id', id));
}

async function finish(row, status, error = null, extra = {}) {
  await update(row.id, {
    status,
    ...(status === 'sent' ? { sent_at: new Date().toISOString() } : {}),
    ...(error ? { last_error: String(error).slice(0, 500) } : {}),
    updated_at: new Date().toISOString(),
  }, extra);
}

/**
 * Puts a row back to wait without spending one of its retries: nothing was
 * wrong with the message, there was only no way to send it yet.
 */
async function hold(row, attempts, sent) {
  const minutes = HOLD_MINUTES[sent.status] ?? HOLD_MINUTES.needs_template;
  await update(row.id, {
    status: 'pending',
    attempt_count: attempts,
    last_error: String(sent.error ?? sent.status).slice(0, 500),
    available_at: new Date(Date.now() + minutes * 60_000).toISOString(),
    updated_at: new Date().toISOString(),
  }, { delivery_status: sent.status });
  logEvent('outbox_held', { event_type: row.event_type, entity_id: row.entity_id, reason: sent.status });
}

/**
 * The client wrote: anything held for them may go now. Called by the WhatsApp
 * transport on every inbound message, after the window has been stamped, and
 * before the drain that ends the turn.
 */
export async function releaseHeld(chatId) {
  if (extraColumns === false || !chatId) return { ok: false, skipped: true };
  const { data, error } = await db().from('notification_outbox')
    .update({ available_at: new Date().toISOString() })
    .eq('chat_id', String(chatId))
    .eq('status', 'pending')
    .in('delivery_status', ['needs_template', 'opted_out'])
    .select('id');
  if (error) {
    if (isSchemaMissing(error)) extraColumns = false;
    else console.error('releasing held notifications failed:', error.message);
    return { ok: false };
  }
  return { ok: true, released: data?.length ?? 0 };
}

/**
 * A WhatsApp delivery receipt for a message the outbox sent.
 *
 * Meta accepts a message and reports trouble later: a free-form message that
 * reached Meta just as the window closed comes back here as failed/131047,
 * minutes after the row was marked sent. Such a row is put back as waiting
 * for a template; a throughput failure is retried; anything else is dead,
 * with Meta's reason, for the desk to see.
 */
export async function noteDeliveryStatus({ providerMessageId, status, code = null, error = null }) {
  if (extraColumns === false || !providerMessageId) return { ok: false, skipped: true };
  const next = normaliseDeliveryStatus(status);
  if (!next) return { ok: false };

  const { data: row, error: readErr } = await db().from('notification_outbox')
    .select('id, status, attempt_count, event_type, entity_id, delivery_status')
    .eq('provider_message_id', String(providerMessageId))
    .limit(1)
    .maybeSingle();
  if (readErr) {
    if (isSchemaMissing(readErr)) extraColumns = false;
    return { ok: false };
  }
  if (!row) return { ok: true, matched: false };

  if (next !== 'failed') {
    // Forward only: "delivered" arriving after "read" must not undo it.
    const rank = { sent: 1, delivered: 2, read: 3 };
    if ((rank[row.delivery_status] ?? 0) >= rank[next]) return { ok: true, matched: true, unchanged: true };
    await db().from('notification_outbox').update({ delivery_status: next, updated_at: new Date().toISOString() }).eq('id', row.id);
    return { ok: true, matched: true, delivery_status: next };
  }

  const reason = String(code ? `${code}: ${error ?? 'failed'}` : error ?? 'failed').slice(0, 500);
  const attempts = Number(row.attempt_count) || 0;
  const now = new Date();
  let patch;
  if (Number(code) === WINDOW_CLOSED || Number(code) === TEMPLATE_MISSING) {
    patch = { status: 'pending', delivery_status: 'needs_template', available_at: now.toISOString() };
  } else if (!isPermanentError(code) && attempts < BACKOFF_MINUTES.length) {
    // Throughput limits above all, but also Meta's own "unknown error" and
    // "service unavailable": worth another go later, on the usual schedule.
    const wait = BACKOFF_MINUTES[Math.max(0, attempts - 1)] ?? 60;
    patch = { status: 'pending', delivery_status: 'failed', available_at: new Date(now.getTime() + wait * 60_000).toISOString() };
  } else {
    patch = { status: 'dead', delivery_status: 'failed' };
  }
  await db().from('notification_outbox')
    .update({ ...patch, last_error: reason, updated_at: now.toISOString() })
    .eq('id', row.id);
  logEvent('outbox_delivery_failed', { event_type: row.event_type, entity_id: row.entity_id, code, next: patch.status });
  return { ok: true, matched: true, ...patch };
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
 *
 * Rendered inside the client's language (the drain sets it): the engine's
 * messages pick their half, and the few words written here do the same, with
 * the bilingual wording unchanged when no language was chosen.
 */
export function render(row) {
  const p = row?.payload ?? {};

  switch (row.event_type) {
    // No longer queued - the transport answers the yes directly - but a row
    // written by an earlier deployment is still delivered rather than dropped.
    case 'booking_request_submitted':
      return { text: M.submitted(p.booking_ref ?? null), inline: kb.afterSubmitted() };

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
        ? phrase(
          `\n\nرقم الشحنة للتتبع: ${p.shipment_id}`,
          `\n\nTrack with: ${p.shipment_id}`,
          `\n\nرقم الشحنة للتتبع / Track with: ${p.shipment_id}`,
        )
        : '';
      return { text: text + tail, inline: kb.afterConfirmed() };
    }

    case 'booking_rejected':
      if (!p.booking_ref) return null;
      return { text: M.bookingRejected(p.booking_ref, p.reason ?? null), inline: kb.homeOnly() };

    // A document the desk turned down is a request for something, worded the
    // same way; its own event so a template can say which paper.
    case 'document_rejected':
    case 'missing_information_requested': {
      if (!p.booking_ref) return null;
      const en = p.requested ?? p.what ?? '';
      return {
        text: M.needsClientAction(p.booking_ref, p.requested_ar ?? en, en),
        inline: kb.homeOnly(),
      };
    }

    case 'mrn_issued':
      if (!p.mrn_number) return null;
      return {
        text: M.documentReceived(`رقم MRN ${p.mrn_number}`, `MRN ${p.mrn_number}`),
        inline: kb.homeOnly(),
      };

    case 'operations_message':
      if (!p.text) return null;
      return { text: String(p.text), inline: kb.homeOnly() };

    // A shipment moved. The desk words the update; this frames it.
    case 'shipment_update': {
      const ref = p.reference ?? p.shipment_id;
      const what = p.update ?? p.text ?? p.status;
      if (!ref || !what) return null;
      const chassisAr = p.vin ? ` (شاسيه ${p.vin})` : '';
      const chassisEn = p.vin ? ` (chassis ${p.vin})` : '';
      const ar = `تحديث على شحنتك ${ref}${chassisAr}:\n${what}${p.eta ? `\nالوصول المتوقع ${p.eta}` : ''}`;
      const en = `Update on your shipment ${ref}${chassisEn}:\n${what}${p.eta ? `\nEstimated arrival ${p.eta}` : ''}`;
      return { text: phrase(ar, en), inline: kb.homeOnly() };
    }

    // A ticket the desk closed (Telegram still sends this inline from
    // lib/notify.js; WhatsApp needs the outbox for the window).
    case 'ticket_resolved': {
      if (!p.ticket_ref) return null;
      const note = String(p.note ?? '').trim();
      const dept = p.department ? ` (${p.department})` : '';
      const ar = `✅ تم حل طلبك ${p.ticket_ref}${dept}.${note ? `\n\n${note}` : ''}\n\nلو لسه في حاجة، ابعت 3 وهنفتح طلب جديد.`;
      const en = `✅ Your ticket ${p.ticket_ref}${dept} has been resolved.${note ? `\n\n${note}` : ''}\n\nIf anything is still outstanding, reply 3 and we will open a new one.`;
      return { text: phrase(ar, en), inline: kb.homeOnly() };
    }

    // The client's own copy of the paperwork, in the chat they booked from.
    // Delivered as its own row so the retry that matters - "did they actually
    // receive the PDF" - is answered separately from "did they get the text".
    case 'booking_request_pdf':
    case 'booking_confirmed_pdf': {
      if (!p.booking_ref) return null;
      const confirmed = row.event_type === 'booking_confirmed_pdf';
      const ar = confirmed ? `تأكيد الحجز ${p.booking_ref} - نسختك بصيغة PDF` : `طلب حجز ${p.booking_ref} - نسختك بصيغة PDF`;
      const en = confirmed ? `Booking confirmation ${p.booking_ref} - your PDF copy` : `Booking request ${p.booking_ref} - your PDF copy`;
      return {
        text: '',
        document: { kind: 'booking_pdf', booking_ref: p.booking_ref, caption: phrase(ar, en, `${ar}\n${en}`) },
      };
    }

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
 *
 * In the client's language when they chose one; otherwise the sheet decides
 * from the booking, exactly as before.
 */
async function buildDocument(spec, language = null) {
  if (spec.kind !== 'booking_pdf') return null;

  const { data: booking } = await db()
    .from('bookings').select('*').eq('booking_ref', spec.booking_ref).maybeSingle();
  if (!booking) return null;

  const { bookingConfirmationPdf } = await import('./pdf.js');
  const buffer = await bookingConfirmationPdf(booking, language ? { lang: language } : {});
  return { buffer, filename: `${booking.booking_ref}.pdf`, caption: spec.caption };
}

function numeric(value) {
  const n = Number(String(value).replace(/[^0-9-]/g, ''));
  return Number.isSafeInteger(n) ? n : null;
}
