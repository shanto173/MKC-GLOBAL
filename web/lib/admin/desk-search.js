/**
 * The desk's search box: one box for chassis, reference, name and phone,
 * answered from five tables at once and grouped by what each thing is.
 *
 * Asked for as the operator types (debounced), never polled: it carries no
 * ETag and is not in public/desk/live.js. Each group is the first ten
 * matches - a search narrows by typing more, not by paging.
 */

import { db } from '../supabase.js';
import {
  statusWords, statusTone, requestStatusWords, requestStatusTone, mrnStatusWords, MRN_STATUS, shipmentTone,
} from '../ops/workflow.js';
import { isMissingColumn } from './desk-shared.js';

/** What a customer result is drawn from: the name it goes by, how to reach them, and their chat. */
const CLIENT_COLUMNS = 'company, full_name, whatsapp_name, display_name, telegram_username, phone, whatsapp_id, telegram_chat_id';
const CLIENT_COLUMNS_BEFORE_WHATSAPP = 'company, full_name, display_name, telegram_username, phone, telegram_chat_id';

/**
 * GET view=search&q= - one box for chassis, reference, name and phone.
 * Results come back grouped and each carries where it opens.
 */
export async function search(req, res) {
  const q = String(req.query.q ?? '').trim();
  const empty = { q, groups: [] };
  if (q.length < 2) return res.status(200).json(empty);
  // Characters that mean something to PostgREST's or() syntax are removed, so
  // whatever is typed is searched for rather than parsed.
  const safe = q.replace(/[%_,()*"\\]/g, ' ').trim();
  if (!safe) return res.status(200).json(empty);
  const norm = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const digits = q.replace(/\D/g, '');

  const like = (cols) => cols.map((c) => `${c}.ilike.%${safe}%`).join(',');
  const clientCols = ['display_name', 'full_name', 'company', 'telegram_username', 'phone', 'whatsapp_name', 'whatsapp_id'];

  const clientsQuery = async () => {
    let r = await db().from('clients').select(CLIENT_COLUMNS).or(like(clientCols)).limit(10);
    // whatsapp_* arrive with the new migration; search what exists until then.
    if (r.error && isMissingColumn(r.error)) r = await db().from('clients').select(CLIENT_COLUMNS_BEFORE_WHATSAPP).or(like(clientCols.slice(0, 5))).limit(10);
    return r.data ?? [];
  };

  const [bookings, shipments, clients, mrn, tickets] = await Promise.all([
    db().from('bookings').select('booking_ref, status, vin, make, model, customer_name, customer_contact')
      .or(like(['booking_ref', 'vin', 'customer_name', 'customer_contact']) + (norm.length >= 6 ? `,vin_norm.eq.${norm}` : ''))
      .neq('status', 'draft').order('created_at', { ascending: false }).limit(10).then((r) => r.data ?? []),
    db().from('shipments').select('shipment_id, booking_ref, status, vin, customer_name, vessel, eta')
      .or(like(['shipment_id', 'booking_ref', 'customer_name', 'vin']) + (norm.length >= 6 ? `,vin_norm.eq.${norm}` : ''))
      .limit(10).then((r) => r.data ?? []),
    clientsQuery(),
    db().from('mrn_requests').select('request_ref, booking_ref, status, vin, mrn_number')
      .or(like(['request_ref', 'mrn_number', 'booking_ref']) + (norm.length >= 6 ? `,vin_norm.eq.${norm}` : '')).limit(10).then((r) => r.data ?? []),
    db().from('support_tickets').select('ticket_ref, status, customer, contact, summary')
      .or(like(['ticket_ref', 'customer', 'contact'])).order('created_at', { ascending: false }).limit(10).then((r) => r.data ?? []),
  ]);

  const groups = [
    {
      key: 'bookings', title: 'Bookings',
      items: bookings.map((b) => ({
        title: `${b.booking_ref} · ${b.customer_name ?? ''}`.trim(), detail: [[b.make, b.model].filter(Boolean).join(' '), b.vin].filter(Boolean).join(' · '),
        status_words: statusWords(b.status), tone: statusTone(b.status), link: { type: 'booking', ref: b.booking_ref },
      })),
    },
    {
      key: 'customers', title: 'Customers',
      items: clients.map((c) => {
        const chat = c.whatsapp_id ? { channel: 'whatsapp', chat_id: `wa:${c.whatsapp_id}` }
          : c.telegram_chat_id ? { channel: 'telegram', chat_id: String(c.telegram_chat_id) } : null;
        return {
          title: c.company || c.full_name || c.whatsapp_name || c.display_name || c.telegram_username || 'Customer',
          detail: [c.phone || (c.whatsapp_id ? `+${c.whatsapp_id}` : null), c.telegram_username ? `@${c.telegram_username}` : null, chat?.channel === 'whatsapp' ? 'WhatsApp' : chat ? 'Telegram' : null].filter(Boolean).join(' · '),
          link: chat ? { type: 'chat', ...chat } : null,
        };
      }),
    },
    {
      key: 'shipments', title: 'Shipments',
      items: shipments.map((s) => ({
        title: `${s.shipment_id} · ${s.customer_name ?? ''}`.trim(), detail: [s.vin, s.vessel, s.eta ? `ETA ${s.eta}` : null].filter(Boolean).join(' · '),
        status_words: s.status, tone: shipmentTone(s.status), link: { type: 'shipment', id: s.shipment_id },
      })),
    },
    {
      key: 'mrn', title: 'MRN applications',
      items: mrn.map((m) => ({
        title: `${m.request_ref}${m.booking_ref ? ` · ${m.booking_ref}` : ''}`, detail: [m.vin, m.mrn_number].filter(Boolean).join(' · '),
        status_words: mrnStatusWords(m.status), tone: MRN_STATUS[m.status]?.tone ?? 'gray', link: { type: 'mrn', ref: m.request_ref },
      })),
    },
    {
      key: 'requests', title: 'Call-backs and requests',
      items: tickets.map((t) => ({
        title: `${t.ticket_ref} · ${t.customer ?? ''}`.trim(), detail: [t.contact, t.summary ? String(t.summary).slice(0, 80) : null].filter(Boolean).join(' · '),
        // A tone like every other result, so the badge is not grey.
        status_words: requestStatusWords(t.status), tone: requestStatusTone(t.status), link: { type: 'request', ref: t.ticket_ref },
      })),
    },
  ].filter((g) => g.items.length);

  // A phone number typed with spaces or a leading zero finds the chat even
  // when no client row spells it the same way.
  if (digits.length >= 7 && !groups.some((g) => g.key === 'customers')) {
    const wa = `wa:${digits.replace(/^0+/, '')}`;
    const { data: chat, error } = await db().from('chat_messages').select('channel, chat_id').eq('chat_id', wa).limit(1).maybeSingle();
    if (!error && chat) groups.push({ key: 'customers', title: 'Customers', items: [{ title: `+${digits}`, detail: 'WhatsApp', link: { type: 'chat', channel: 'whatsapp', chat_id: wa } }] });
  }

  res.status(200).json({ q, groups });
}
