/**
 * The Inbox: everything that needs a person, in one list, most urgent first.
 *
 * Bookings, MRN applications, call-backs and messages that did not go through
 * used to live on separate screens, so "what should I do now" meant visiting
 * all of them. Here each one becomes a row with the same shape - a sentence
 * saying what to do, who it is for, and how long it has waited - and the three
 * tabs answer the only question that sorts them: is it our move, the
 * customer's, or done?
 *
 * The sentences are written here, on the server, from the same workflow rules
 * the case page uses, so the list and the page never disagree about what a
 * booking needs.
 */

import { db } from '../supabase.js';
import { supportHours } from '../settings.js';
import {
  OPEN_STATUSES, DOC_LABEL, readiness, REQUEST_OPEN, REQUEST_TYPE, MRN_OPEN, MRN_STATUS, statusWords, statusTone,
  requestStatusLabel, requestStatusTone, mrnStatusWords,
} from '../ops/workflow.js';
import {
  enrichAll, isMissingTable, todayCheck, unreadable, customerFor, bookingVersion, ticketVersion, mrnVersion,
} from './desk-shared.js';
import { failureWords } from './desk-messages.js';
import { channels } from './channels-bridge.js';
import { channelOf } from '../channels.js';

/** What each of the desk's tones means, for a screen that names its own. */
const MEANING = { blue: 'info', amber: 'warning', green: 'success', red: 'danger', gray: 'neutral' };

/**
 * A row's status as the badge shows it: a short label, the server's tone, and
 * what that tone means. Every kind of row carries one, so the desk never has
 * to read a status back out of the sentence - which breaks the day the
 * sentence is reworded.
 */
export function statusBadge(label, tone = 'gray') {
  const t = MEANING[tone] ? tone : 'gray';
  return { label, tone: t, meaning: MEANING[t] };
}

const PROBLEM_DAYS = 14;
export const TABS = ['needs_us', 'waiting', 'done'];
export const FILTERS = ['all', 'bookings', 'mrn', 'callbacks', 'problems', 'mine'];

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** "Invoice", "Invoice and Brief", "Invoice, Brief and MRN". */
export function listWords(items) {
  const xs = items.filter(Boolean);
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
}

/** "Alexandria Port (incl. El Dekheila)" is the right name and too long for a row. */
export const shortPort = (p) => String(p ?? '').replace(/\s*\(.*\)\s*/g, '').replace(/\s+Port$/i, '').replace(/^Port\s+of\s+/i, '').trim();

const vehicleOf = (r) => [r.make, r.model].filter(Boolean).join(' ');

const labelsOf = (types) => types.map((t) => DOC_LABEL[t] ?? t);

/**
 * What to do about a booking, as a sentence. Ordered like nextAction: the first
 * thing that is not done is the thing to do.
 */
export function bookingSentence(r) {
  const next = r.next;
  const sum = r.summary ?? { required: [], received_types: [], verified_types: [], missing: [] };

  if (r.status === 'confirmed') return `Confirmed${r.confirmed_by ? ` by ${r.confirmed_by}` : ''}`;
  if (r.status === 'rejected') return `Rejected${r.confirmed_by ? ` by ${r.confirmed_by}` : ''}`;
  if (r.status === 'cancelled') return `Cancelled${r.confirmed_by ? ` by ${r.confirmed_by}` : ''}`;

  if (r.client_responded && next.owner === 'client') return 'The customer replied — see what they sent';

  switch (next.code) {
    case 'REVIEW_INFORMATION': {
      const ready = readiness(r, sum, null);
      const missing = ready.items.filter((i) => i.blocking && !i.ok && !i.key.startsWith('doc:') && i.key !== 'mrn');
      return `Ask for the missing details: ${listWords(missing.map((i) => i.label.toLowerCase()))}`;
    }
    case 'REQUEST_DOCUMENTS':
      return `Ask for the ${listWords(labelsOf(sum.missing))}`;
    case 'REVIEW_DOCUMENTS': {
      const unchecked = sum.required.filter((t) => sum.received_types.includes(t) && !sum.verified_types.includes(t));
      const what = unchecked.length === 1 ? `the ${labelsOf(unchecked)[0]}` : `${unchecked.length} documents`;
      // "and confirm" only when confirming really is what comes after.
      const thenConfirm = r.mrn_choice !== 'mky_issue' || r.mrn_number;
      return `Check ${what}${thenConfirm ? ' and confirm' : ''}`;
    }
    case 'PROCESS_MRN':
      return 'Issue the MRN';
    case 'CREATE_BOOKING':
      return 'Record the booking reference';
    case 'CONFIRM_BOOKING':
      return 'Confirm the booking';
    case 'WAIT_CLIENT': {
      const asked = r.needs_client_action?.requested;
      if (sum.missing.length) return `Waiting for the customer to send the ${listWords(labelsOf(sum.missing))}`;
      return asked ? `Waiting for the customer: ${String(asked).slice(0, 80)}` : 'Waiting for the customer';
    }
    default:
      return next.label;
  }
}

const hasPhone = (c) => Boolean(c) && !/^(telegram|web|wa|whatsapp):/i.test(c) && /\d{6,}/.test(String(c).replace(/\D/g, ''));

export function requestSentence(t) {
  if (t.status === 'resolved' || t.status === 'closed') return `${t.status === 'resolved' ? 'Resolved' : 'Closed'}${t.resolved_by ? ` by ${t.resolved_by}` : ''}`;
  if (t.status === 'waiting_client') return 'Waiting for the customer to come back';
  return hasPhone(t.contact) ? `Call back ${t.contact}` : 'Reply in the chat — no phone number given';
}

export function mrnSentence(m) {
  if (m.status === 'issued') return `MRN recorded${m.mrn_number ? `: ${m.mrn_number}` : ''}`;
  if (m.status === 'missing_information') return 'Waiting for the customer: information for the MRN';
  if (m.status === 'approved') return 'Record the issued MRN number';
  return 'Issue the MRN';
}

const OUTBOX_WORDS = {
  booking_confirmed: 'booking confirmation',
  booking_confirmed_pdf: 'confirmation PDF',
  booking_request_pdf: 'booking request PDF',
  booking_rejected: 'rejection message',
  missing_information_requested: 'request for information',
  operations_message: 'message from the desk',
  mrn_issued: 'MRN message',
  shipment_update: 'shipment update',
  ticket_resolved: 'request-resolved message',
};

// ---------------------------------------------------------------------------
// Building the rows
// ---------------------------------------------------------------------------

const RANK = (item) => (item.kind === 'problem' ? 0 : item.priority === 'urgent' ? 1 : item.overdue ? 2 : item.priority === 'high' ? 3 : 4);

/**
 * Every row the inbox could show, before tabs and filters. Exported so the
 * sidebar count and the tab title ("(3) MKY Desk") are counted from exactly
 * the list a person would see.
 */
export async function inboxItems() {
  const isToday = await todayCheck();
  const since = new Date(Date.now() - PROBLEM_DAYS * 86400_000).toISOString();

  const [openQ, decidedQ, ticketsQ, mrnQ, handledQ] = await Promise.all([
    db().from('booking_queue').select('*').in('status', OPEN_STATUSES).order('status_changed_at', { ascending: true }).limit(500),
    db().from('booking_queue').select('*').in('status', ['confirmed', 'rejected', 'cancelled'])
      .order('confirmed_at', { ascending: false }).limit(200),
    db().from('client_request_queue').select('*').order('created_at', { ascending: false }).limit(400),
    db().from('mrn_requests').select('*').order('created_at', { ascending: false }).limit(300),
    db().from('audit_logs').select('entity_id, action, created_at').eq('entity_type', 'problem').gte('created_at', since).limit(1000),
  ]);
  if (openQ.error) throw new Error(`booking queue: ${openQ.error.message}`);

  const handled = new Set((handledQ.data ?? []).map((r) => r.entity_id));
  // A whole chat's failures set aside at once: everything up to that moment.
  const chatSetAside = new Map();
  for (const r of handledQ.data ?? []) {
    if (!String(r.entity_id).startsWith('chat:')) continue;
    const at = r.created_at ?? new Date().toISOString();
    if (!chatSetAside.has(r.entity_id) || chatSetAside.get(r.entity_id) < at) chatSetAside.set(r.entity_id, at);
  }
  const open = openQ.data ?? [];
  const refs = open.map((r) => r.booking_ref);

  const { data: docs } = refs.length
    ? await db().from('booking_documents')
        .select('id, booking_ref, doc_type, status, extraction_ok, extracted, vin, uploaded_at')
        .in('booking_ref', refs).is('deleted_at', null)
    : { data: [] };
  const docsByRef = new Map();
  for (const d of docs ?? []) docsByRef.set(d.booking_ref, [...(docsByRef.get(d.booking_ref) ?? []), d]);

  // What a booking's version is made of that the queue view does not carry,
  // so each row's version is the one its case page gives (bookingVersion) and
  // "Take it" can be sent straight from the list. The latest application per
  // booking, as loadBooking reads it: mrn_requests comes newest first.
  const { data: contacts } = refs.length
    ? await db().from('bookings').select('booking_ref, customer_contact').in('booking_ref', refs)
    : { data: [] };
  const contactOf = new Map((contacts ?? []).map((b) => [b.booking_ref, b.customer_contact ?? null]));
  const latestMrn = new Map();
  for (const m of mrnQ.data ?? []) if (m.booking_ref && !latestMrn.has(m.booking_ref)) latestMrn.set(m.booking_ref, m);

  const enriched = await enrichAll(open, { docsByRef });
  const items = [];

  for (const r of enriched) {
    const ours = r.next.owner === 'ops' || (r.client_responded && r.next.owner === 'client');
    const mrnPending = r.mrn_choice === 'mky_issue' && !r.mrn_number && r.mrn_status !== 'issued';
    items.push({
      id: `booking:${r.booking_ref}`,
      kind: 'booking',
      tags: ['bookings', ...(mrnPending ? ['mrn'] : [])],
      tab: ours ? 'needs_us' : 'waiting',
      tone: ours ? 'blue' : 'amber',
      sentence: bookingSentence(r),
      who: r.customer_name || r.company || 'Unknown customer',
      detail: [vehicleOf(r), r.vin, r.origin_port && r.destination_port ? `${shortPort(r.origin_port)} → ${shortPort(r.destination_port)}` : null].filter(Boolean).join(' · '),
      ref: r.booking_ref,
      link: { type: 'booking', ref: r.booking_ref },
      channel: r.channel ?? null,
      assigned_to: r.assigned_to ?? null,
      priority: r.priority ?? 'normal',
      overdue: Boolean(r.overdue),
      is_new: r.status === 'pending_review',
      status_words: statusWords(r.status),
      status: statusBadge(statusWords(r.status), statusTone(r.status)),
      version: bookingVersion({ ...r, customer_contact: contactOf.get(r.booking_ref) ?? null },
        docsByRef.get(r.booking_ref) ?? [], latestMrn.get(r.booking_ref) ?? null),
      since: r.waiting_since,
    });

    // A file the bot could not read is its own line, because the booking row
    // says "check the documents" and does not say this one needs eyes, not a glance.
    for (const d of docsByRef.get(r.booking_ref) ?? []) {
      const pid = `document:${d.id}`;
      if (handled.has(pid) || !unreadable(d) || !['received', 'pending_verification'].includes(d.status)) continue;
      items.push({
        id: pid,
        kind: 'problem',
        tags: ['problems'],
        tab: 'needs_us',
        tone: 'red',
        sentence: `Couldn’t read the ${DOC_LABEL[d.doc_type] ?? 'document'} — check it by eye`,
        who: r.customer_name || 'Unknown customer',
        detail: [r.booking_ref, d.extracted?.message ? 'The bot found no readable text' : null].filter(Boolean).join(' · '),
        ref: r.booking_ref,
        link: { type: 'booking', ref: r.booking_ref, document_id: d.id },
        channel: r.channel ?? null,
        assigned_to: r.assigned_to ?? null,
        priority: 'normal',
        since: d.uploaded_at,
        status: statusBadge('Unreadable', 'red'),
        version: null,
        problem: { type: 'document', id: d.id },
      });
    }
  }

  for (const r of decidedQ.data ?? []) {
    if (!isToday(r.confirmed_at)) continue;
    items.push({
      id: `booking:${r.booking_ref}`,
      kind: 'booking',
      tags: ['bookings'],
      tab: 'done',
      tone: r.status === 'confirmed' ? 'green' : 'gray',
      sentence: bookingSentence({ ...r, next: { owner: 'none' } }),
      who: r.customer_name || 'Unknown customer',
      detail: [vehicleOf(r), r.vin].filter(Boolean).join(' · '),
      ref: r.booking_ref,
      link: { type: 'booking', ref: r.booking_ref },
      channel: r.channel ?? null,
      assigned_to: r.assigned_to ?? null,
      priority: r.priority ?? 'normal',
      status_words: statusWords(r.status),
      status: statusBadge(statusWords(r.status), statusTone(r.status)),
      // Decided: nothing is taken from here, so no version is worked out.
      version: null,
      since: r.confirmed_at,
    });
  }

  for (const t of ticketsQ.data ?? []) {
    const isOpen = REQUEST_OPEN.includes(t.status);
    const doneAt = t.resolved_at || t.status_changed_at;
    if (!isOpen && !isToday(doneAt)) continue;
    const tab = !isOpen ? 'done' : t.status === 'waiting_client' ? 'waiting' : 'needs_us';
    let afterHours = false;
    if (isOpen) {
      try { afterHours = !(await supportHours({ now: new Date(t.created_at) })).open; } catch { afterHours = false; }
    }
    const type = REQUEST_TYPE[t.request_type] ?? REQUEST_TYPE.other;
    items.push({
      id: `request:${t.ticket_ref}`,
      kind: 'callback',
      tags: ['callbacks'],
      tab,
      tone: tab === 'needs_us' ? 'blue' : tab === 'waiting' ? 'amber' : 'green',
      sentence: requestSentence(t),
      who: t.customer || t.client_display_name || t.booking_client || 'Unknown customer',
      detail: [type.label, t.summary ? String(t.summary).slice(0, 90) : null].filter(Boolean).join(' · '),
      ref: t.ticket_ref,
      link: { type: 'request', ref: t.ticket_ref },
      channel: t.channel ?? null,
      assigned_to: t.assigned_to ?? null,
      priority: t.priority ?? 'normal',
      after_hours: afterHours,
      unowned: isOpen && !t.assigned_to,
      status: statusBadge(requestStatusLabel(t.status), requestStatusTone(t.status)),
      version: ticketVersion(t),
      since: !isOpen ? doneAt : (t.status_changed_at || t.created_at),
    });
  }

  // MRN applications that are not already a booking row: a booking still open
  // shows its MRN as its own next step, and two rows for one job is noise.
  const openRefs = new Set(refs);
  const mrnRows = (mrnQ.data ?? []).filter((m) => {
    const isOpen = MRN_OPEN.includes(m.status);
    if (!isOpen && !(m.status === 'issued' && isToday(m.issued_at))) return false;
    return !(isOpen && m.booking_ref && openRefs.has(m.booking_ref));
  });
  // Who the application is for, and on which channel: the row named the
  // booking reference and no channel, so the desk could not say whose it was.
  const mrnBookingRefs = [...new Set(mrnRows.map((m) => m.booking_ref).filter(Boolean))];
  const { data: mrnBookings } = mrnBookingRefs.length
    ? await db().from('bookings').select('booking_ref, customer_name, channel, chat_id, client_id').in('booking_ref', mrnBookingRefs)
    : { data: [] };
  const mrnBookingOf = new Map((mrnBookings ?? []).map((b) => [b.booking_ref, b]));
  for (const m of mrnRows) {
    const tab = m.status === 'issued' ? 'done' : m.status === 'missing_information' ? 'waiting' : 'needs_us';
    const b = m.booking_ref ? mrnBookingOf.get(m.booking_ref) ?? null : null;
    const chatId = m.chat_id ?? b?.chat_id ?? null;
    // The application's own chat decides its channel; the booking's says the
    // same thing, and is the fallback for an application with no chat.
    const channel = m.chat_id ? channelOf(m.chat_id) : b?.channel ?? (chatId ? channelOf(chatId) : null);
    const name = b?.customer_name
      || (chatId || m.client_id ? (await customerFor({ clientId: m.client_id ?? b?.client_id ?? null, channel, chatId }).catch(() => null))?.name : null)
      || m.booking_ref || 'MRN application';
    items.push({
      id: `mrn:${m.request_ref}`,
      kind: 'mrn',
      tags: ['mrn'],
      tab,
      tone: tab === 'needs_us' ? 'blue' : tab === 'waiting' ? 'amber' : 'green',
      sentence: mrnSentence(m),
      who: name,
      detail: [m.booking_ref, m.request_ref, m.vin].filter(Boolean).join(' · '),
      ref: m.request_ref,
      booking_ref: m.booking_ref ?? null,
      link: { type: 'mrn', ref: m.request_ref },
      channel,
      assigned_to: null,
      priority: 'normal',
      status: statusBadge(mrnStatusWords(m.status), MRN_STATUS[m.status]?.tone ?? 'gray'),
      version: mrnVersion(m),
      since: tab === 'done' ? m.issued_at : (m.submitted_at || m.created_at),
    });
  }

  items.push(...await problemItems({ since, handled, chatSetAside }));
  return items;
}

/** Meta's "this number is not on WhatsApp". Sending again cannot fix it. */
const NOT_ON_WHATSAPP = /\b131026\b/;

/** "a message", "6 messages". */
const messages = (n) => (n === 1 ? 'a message' : `${n} messages`);

/**
 * Messages that did not reach a customer, from both the conversation log and
 * the outbox - one problem per chat.
 *
 * Each failure used to be its own red row: in the live test 77 of them, most
 * for numbers WhatsApp does not know, buried the one real item. A chat with one
 * failure still gets the row it always got, with Retry on it. A chat with more
 * gets one row saying how many, the last error and when it was last tried, and
 * a number WhatsApp does not know is one row for that customer, saying so
 * plainly - whatever the count.
 *
 * The outbox records the same message the conversation log does once it was
 * sent and then refused (the delivery receipt marks both), so an outbox row
 * carrying the provider id of a failed message is not counted twice.
 */
async function problemItems({ since, handled, chatSetAside = new Map() }) {
  const singles = await problemEntries({ since, handled });
  const groups = new Map();
  for (const entry of singles) {
    const key = `chat:${entry.channel ?? 'unknown'}:${entry.chatId}`;
    // Set aside as a whole chat: only what failed after that comes back.
    const asideAt = chatSetAside.get(key);
    if (asideAt && String(entry.at ?? '') <= asideAt) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  const out = [];
  for (const [key, entries] of groups) {
    entries.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
    const last = entries.at(-1);
    const lost = entries.some((e) => NOT_ON_WHATSAPP.test(e.error ?? ''));
    const summary = {
      count: entries.length,
      last_error: last.words,
      last_error_raw: last.error ? String(last.error).slice(0, 300) : null,
      last_attempt: last.at,
      first_failed: entries[0].at,
    };

    // Held is waiting for something (a template, a customer who wrote STOP),
    // not broken: amber, as the held rows have always been worded.
    const badgeFor = (heldWhy) => (heldWhy ? statusBadge('Held', 'amber') : statusBadge('Not delivered', 'red'));

    if (entries.length === 1 && !lost) {
      out.push({ ...last.item, status: badgeFor(last.held), version: null, problem: { ...last.item.problem, ...summary } });
      continue;
    }

    const held = entries.every((e) => e.held);
    const reason = lost ? 'not_on_whatsapp' : held ? last.held : 'failed';
    const phone = last.channel === 'whatsapp' ? `+${String(last.chatId).replace(/^wa:/, '')}` : null;
    out.push({
      id: key,
      kind: 'problem',
      tags: ['problems'],
      tab: 'needs_us',
      tone: 'red',
      sentence: lost
        ? `${last.name} isn’t on WhatsApp — call them instead`
        : held && last.held === 'opted_out'
          ? `${entries.length} messages held — ${last.name} wrote STOP`
          : held
            ? `${entries.length} messages wait for a WhatsApp template — ${last.name} hasn’t written in 24 h`
            : `${entries.length} messages didn’t reach ${last.name}`,
      who: last.name,
      detail: lost
        ? `WhatsApp says ${phone ?? 'this number'} has no WhatsApp account, so ${messages(entries.length)} could not be delivered. `
          + 'Call them, or ask them for a number that is on WhatsApp.'
        : `Last: ${last.words}`,
      ref: last.item.ref ?? null,
      link: { type: 'chat', channel: last.channel, chat_id: last.chatId },
      channel: last.channel,
      priority: 'normal',
      since: last.at,
      status: lost ? statusBadge('Not on WhatsApp', 'red') : badgeFor(held ? last.held : null),
      version: null,
      problem: {
        type: 'chat',
        id: key.slice('chat:'.length),
        // Each failed message can be sent again from the conversation itself;
        // the row's own action is setting the lot aside.
        retryable: false,
        reason,
        ...summary,
      },
    });
  }
  return out;
}

/**
 * Every message that did not reach a customer, one entry each, with the row
 * the inbox showed for it before they were grouped.
 */
async function problemEntries({ since, handled }) {
  const out = [];
  const [failedQ, outboxQ] = await Promise.all([
    db().from('chat_messages').select('*').eq('status', 'failed').eq('direction', 'out')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(200),
    db().from('notification_outbox').select('*').neq('status', 'sent')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(300),
  ]);

  const names = new Map();
  const nameFor = async (channel, chatId, clientId) => {
    const k = `${channel}|${chatId}|${clientId}`;
    if (!names.has(k)) {
      const { data: b } = await db().from('bookings').select('customer_name').eq('chat_id', String(chatId))
        .neq('status', 'draft').order('created_at', { ascending: false }).limit(1).maybeSingle();
      const c = b?.customer_name ? null : await customerFor({ clientId, channel, chatId });
      names.set(k, b?.customer_name || c?.name || 'the customer');
    }
    return names.get(k);
  };

  // Provider ids of the failed messages, so the outbox's record of the same
  // message is not a second failure.
  const failedIds = new Set();
  if (!failedQ.error) {
    for (const m of failedQ.data ?? []) {
      if (m.provider_message_id) failedIds.add(String(m.provider_message_id));
      const pid = `message:${m.id}`;
      if (handled.has(pid)) continue;
      const name = await nameFor(m.channel, m.chat_id, m.client_id);
      const words = failureWords(m.error, { template: m.payload?.template ?? null });
      out.push({
        channel: m.channel, chatId: String(m.chat_id), name, at: m.created_at, error: m.error ?? null, words, held: null,
        item: {
          id: pid,
          kind: 'problem',
          tags: ['problems'],
          tab: 'needs_us',
          tone: 'red',
          sentence: `Message failed — couldn’t reach ${name}`,
          who: name,
          detail: words,
          ref: m.booking_ref ?? null,
          link: { type: 'chat', channel: m.channel, chat_id: m.chat_id },
          channel: m.channel,
          priority: 'normal',
          since: m.created_at,
          problem: { type: 'message', id: m.id, retryable: ['text', 'template', null, undefined].includes(m.kind) },
        },
      });
    }
  } else if (!isMissingTable(failedQ.error)) {
    console.error('failed messages read failed:', failedQ.error.message);
  }

  for (const o of outboxQ.data ?? []) {
    // The desk's own sends are recorded here too, but the operator saw those
    // fail as they pressed Send; listing them again would be noise.
    if (o.payload?.via === 'desk') continue;
    // Held rows stay 'pending' in the outbox; delivery_status says why.
    const needsTemplate = o.delivery_status === 'needs_template';
    const stopped = o.delivery_status === 'opted_out';
    const dead = ['dead', 'failed'].includes(o.status);
    if (!needsTemplate && !stopped && !dead) continue;
    if (o.provider_message_id && failedIds.has(String(o.provider_message_id))) continue;
    const pid = `outbox:${o.id}`;
    if (handled.has(pid)) continue;
    const name = await nameFor(o.channel, o.chat_id, o.client_id);
    const what = OUTBOX_WORDS[o.event_type] ?? String(o.event_type).replace(/_/g, ' ');
    const words = needsTemplate ? failureWords(null, { status: 'needs_template' })
      : stopped ? failureWords(null, { status: 'opted_out' })
        : failureWords(o.last_error, { template: o.template_name ?? null });
    out.push({
      channel: o.channel, chatId: String(o.chat_id), name, at: o.updated_at || o.created_at,
      error: o.last_error ?? null, words, held: needsTemplate ? 'needs_template' : stopped ? 'opted_out' : null,
      item: {
        id: pid,
        kind: 'problem',
        tags: ['problems'],
        tab: 'needs_us',
        tone: 'red',
        sentence: needsTemplate
          ? `Waiting for a WhatsApp template — ${name} hasn’t written in 24 h`
          : stopped ? `Not sent — ${name} wrote STOP`
            : `The ${what} didn’t reach ${name}`,
        who: name,
        detail: needsTemplate
          ? `The ${what} cannot go as free text${o.template_name ? `; template “${o.template_name}”` : ''}. It goes as soon as they write; or send the “please reply” template, or set one up in Settings.`
          : stopped ? `The ${what} is held until they write to us again. Call them if it cannot wait.`
            : failureWords(o.last_error, { template: o.template_name ?? null }),
        ref: o.entity_id ?? null,
        link: o.entity_type === 'booking' ? { type: 'booking', ref: o.entity_id }
          : o.entity_type === 'support_ticket' ? { type: 'request', ref: o.entity_id }
            : { type: 'chat', channel: o.channel, chat_id: o.chat_id },
        channel: o.channel,
        priority: 'normal',
        since: o.updated_at || o.created_at,
        problem: { type: 'outbox', id: o.id, retryable: dead },
      },
    });
  }
  return out;
}

function sortItems(items, tab) {
  if (tab === 'done') return items.sort((a, b) => String(b.since ?? '').localeCompare(String(a.since ?? '')));
  return items.sort((a, b) => (RANK(a) - RANK(b)) || String(a.since ?? '').localeCompare(String(b.since ?? '')));
}

const inFilter = (item, filter, me) => {
  if (filter === 'all') return true;
  if (filter === 'mine') return Boolean(me) && String(item.assigned_to ?? '').toLowerCase() === me.toLowerCase();
  return item.tags.includes(filter);
};

/** GET view=inbox&tab=&filter=&offset=&limit= */
export async function inboxView(req, res, who) {
  const tab = TABS.includes(req.query.tab) ? req.query.tab : 'needs_us';
  const filter = FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const all = await inboxItems();
  const counts = { tabs: {}, filters: {} };
  for (const t of TABS) counts.tabs[t] = all.filter((i) => i.tab === t).length;
  const inTab = all.filter((i) => i.tab === tab);
  for (const f of FILTERS) counts.filters[f] = inTab.filter((i) => inFilter(i, f, who.name)).length;

  const rows = sortItems(inTab.filter((i) => inFilter(i, filter, who.name)), tab);
  const chan = await channels();
  const { error: logErr } = await db().from('chat_messages').select('id').limit(1);

  return res.status(200).json({
    tab,
    filter,
    counts,
    total: rows.length,
    offset,
    limit,
    has_more: offset + limit < rows.length,
    items: rows.slice(offset, offset + limit),
    features: { channels: Boolean(chan), chat_messages: !isMissingTable(logErr) },
  });
}

/** GET view=counts - the numbers on the sidebar and in the tab title. */
export async function countsView(req, res, who) {
  const all = await inboxItems();
  const needs = all.filter((i) => i.tab === 'needs_us');
  return res.status(200).json({
    needs_us: needs.length,
    problems: needs.filter((i) => i.kind === 'problem').length,
    mine: needs.filter((i) => String(i.assigned_to ?? '').toLowerCase() === who.name.toLowerCase()).length,
  });
}
