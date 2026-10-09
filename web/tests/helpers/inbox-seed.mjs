/**
 * A busy desk, every kind of inbox row in it, for checking that the inbox
 * says exactly what it said before its reads were restructured.
 *
 * tests/fixtures/inbox-golden.json is what the inbox of 6993e5c - the code
 * before the reads were batched - returned for seed(N) at FIXED_NOW, for N in
 * GOLDEN_SIZES. tests/db-load.test.mjs works the inbox out on the same desk at
 * the same moment and compares, item for item.
 *
 * Telegram and WhatsApp chats; bookings in every status, with and without a
 * customer name, a client, a channel; papers read and unreadable, on and off
 * a booking, after a decision; failed messages, some for numbers not on
 * WhatsApp, some in chats with no named booking; held, dead and desk-sent
 * notifications; call-backs open and closed today and before; MRN
 * applications open, issued today and earlier, with and without a chat or a
 * booking; problems set aside, singly and a whole chat at once.
 */

import { withViews } from './desk-db.mjs';

/** 2026-10-09 10:00 in Cairo: inside working hours, so "after hours" is said of some call-backs only. */
export const FIXED_NOW = Date.parse('2026-10-09T07:00:00.000Z');
export const GOLDEN_SIZES = [7, 30, 61];

export function seed(N, now = FIXED_NOW) {
  const iso = (ago) => new Date(now - ago).toISOString();
  const bookings = []; const docs = []; const tickets = []; const msgs = []; const sessions = []; const clients = [];
  const mrn = []; const outbox = []; const audit = [];
  let id = 1;
  for (let i = 0; i < N; i++) {
    const tg = i % 5 === 4;
    const chat = tg ? String(7000 + i) : `wa:2010000${String(i).padStart(5, '0')}`;
    const channel = tg ? 'telegram' : 'whatsapp';
    const named = i % 3 !== 1;
    if (i % 6 !== 5) {
      clients.push({
        id: 100 + i,
        ...(tg ? { telegram_chat_id: 7000 + i, telegram_username: `tg${i}` } : { whatsapp_id: chat.slice(3), whatsapp_name: named ? `Cust ${i}` : null }),
        language: i % 2 ? 'en' : 'ar', company: i % 7 === 0 ? `Co ${i}` : null,
      });
    }
    if (i % 4 !== 3) sessions.push({ id: `${channel}:${chat}`, channel, chat_id: chat, client_id: i % 6 !== 5 ? 100 + i : null, current_state: 'MAIN_MENU', last_client_message_at: iso(3600_000), updated_at: iso(3600_000) });
    const statuses = ['pending_review', 'under_review', 'needs_client_action', 'confirmed', 'rejected', 'draft', 'cancelled'];
    const status = statuses[i % statuses.length];
    const decided = ['confirmed', 'rejected', 'cancelled'].includes(status);
    bookings.push({
      booking_ref: `MKY-BKG-${i}`, status, channel, chat_id: chat, client_id: i % 6 !== 5 ? 100 + i : null,
      // Some chats' newest booking has no name: their failures are named from the client.
      customer_name: i % 8 === 0 ? null : `Booked ${i}`, customer_contact: '+201000000', vin: `YV2RT40A8FB7${String(i).padStart(5, '0')}`,
      make: 'Volvo', model: 'FH', origin_port: 'Klaipeda', destination_port: 'Alexandria Port (incl. El Dekheila)',
      mrn_choice: i % 4 === 0 ? 'mky_issue' : 'existing', priority: ['normal', 'high', 'urgent'][i % 3],
      created_at: iso((50 - i) * 3600_000), submitted_at: iso(5 * 3600_000), status_changed_at: iso((i % 9) * 3600_000),
      confirmed_at: decided ? iso((i % 3) * 20 * 3600_000 + 60_000) : null, confirmed_by: decided ? 'Omar' : null, edit_history: [],
      client_responded_at: i % 5 === 0 ? iso(60_000) : null, assigned_to: i % 4 === 1 ? 'Sara' : null,
    });
    for (const t of ['invoice', 'brief', 'mrn']) {
      docs.push({
        id: id++, booking_ref: `MKY-BKG-${i}`, chat_id: chat, client_id: 100 + i, channel, doc_type: t,
        status: ['received', 'verified', 'pending_verification', 'replacement_requested'][(i + id) % 4], vin: 'X',
        extraction_ok: i % 5 !== 0, extracted: { ok: i % 5 !== 0, message: i % 5 === 0 ? 'no text' : null },
        uploaded_at: decided && t === 'invoice' ? iso(30_000) : iso(4 * 3600_000),
      });
    }
    for (let k = 0; k < 4; k++) {
      const failed = k === 3 && i % 3 === 0;
      msgs.push({
        id: id++, channel, chat_id: chat, client_id: 100 + i, direction: k % 2 ? 'out' : 'in', author: k % 2 ? 'bot' : 'client', kind: 'text',
        body: `m${k}`, status: failed ? 'failed' : 'read', error: failed ? (i % 2 ? '(#131026) not on WhatsApp' : '(#131047) Re-engagement') : null,
        provider_message_id: failed ? `wamid.f${i}` : null, created_at: iso((20 - k) * 60_000 + i * 1000),
      });
    }
    if (i % 3 === 0) {
      tickets.push({
        ticket_ref: `MKY-T-${i}`, status: ['open', 'assigned', 'waiting_client', 'resolved', 'closed', 'in_progress'][i % 6], channel, chat_id: chat,
        client_id: 100 + i, department: 'Booking Operations', customer: i % 2 ? `Tick ${i}` : null, contact: i % 4 ? '+20 100 000 0001' : 'wa:1',
        summary: 'call me', request_type: 'booking', priority: 'normal', created_at: iso((40 + i) * 60_000 + (i % 4 === 0 ? 14 * 3600_000 : 0)),
        status_changed_at: iso(((i % 3) * 20) * 3600_000 + 60_000), resolved_at: i % 6 === 3 ? iso(((i % 3) * 20) * 3600_000 + 60_000) : null,
      });
    }
    if (i % 4 === 0) {
      mrn.push({
        request_ref: `MKY-MRN-${i}`, booking_ref: `MKY-BKG-${i}`, chat_id: i % 8 === 0 ? chat : null, client_id: i % 16 === 0 ? 100 + i : null,
        status: ['submitted', 'issued', 'missing_information', 'rejected'][(i / 4) % 4], mrn_number: 'MRN1',
        issued_at: iso((i % 2) * 30 * 3600_000 + 60_000), created_at: iso(3600_000 + i),
      });
    }
    if (i % 5 === 2) {
      outbox.push({
        id: 9000 + i, channel, chat_id: chat, client_id: i % 2 ? 100 + i : null, event_type: 'booking_confirmed', entity_type: i % 2 ? 'booking' : null,
        entity_id: `MKY-BKG-${i}`, status: ['pending', 'dead', 'failed'][i % 3], delivery_status: ['needs_template', 'opted_out', null][i % 3],
        provider_message_id: i % 10 === 2 ? `wamid.f${i - 2}` : null, last_error: 'boom', created_at: iso(3600_000), updated_at: iso(1800_000),
        payload: i % 15 === 2 ? { via: 'desk' } : {},
      });
    }
    if (i % 9 === 0) {
      docs.push({
        id: id++, booking_ref: null, chat_id: chat, client_id: i % 2 ? 100 + i : null, channel: i % 3 ? channel : null,
        doc_type: ['other', 'acid'][i % 2], status: 'received', uploaded_at: iso(3600_000), file_name: 'x.pdf',
      });
    }
  }
  mrn.push({ request_ref: 'MKY-MRN-X', booking_ref: null, chat_id: 'wa:2019999', client_id: null, status: 'submitted', created_at: iso(3600_000) });
  mrn.push({ request_ref: 'MKY-MRN-Y', booking_ref: null, chat_id: null, client_id: null, status: 'approved', created_at: iso(3600_000) });
  // No chat of its own, a booking with a client but no name: named after the booking reference.
  bookings.push({ booking_ref: 'MKY-BKG-NONAME', status: 'confirmed', channel: 'whatsapp', chat_id: null, client_id: 101, customer_name: null, created_at: iso(3600_000), confirmed_at: iso(86400_000 * 3), edit_history: [] });
  mrn.push({ request_ref: 'MKY-MRN-Z', booking_ref: 'MKY-BKG-NONAME', chat_id: null, client_id: null, status: 'submitted', created_at: iso(3600_000) });
  audit.push({ id: 1, entity_type: 'problem', entity_id: 'message:5', action: 'problem_dismissed', created_at: iso(1000) });
  audit.push({ id: 2, entity_type: 'problem', entity_id: 'chat:whatsapp:wa:201000000003', action: 'problem_dismissed', created_at: iso(1000) });
  return withViews({
    ops_users: [{ name: 'Sara', role: 'ops_agent', active: true }],
    bot_settings: [
      { key: 'required_booking_documents', value: ['invoice', 'brief', 'mrn'] },
      { key: 'required_booking_documents_mky_mrn', value: ['invoice', 'brief'] },
    ],
    clients, conversation_sessions: sessions, bookings, booking_documents: docs, support_tickets: tickets, chat_messages: msgs,
    mrn_requests: mrn, notification_outbox: outbox, audit_logs: audit, shipments: [],
  });
}
