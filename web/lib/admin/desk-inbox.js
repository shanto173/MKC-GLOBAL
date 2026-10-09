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
  enrichAll, isMissingTable, todayCheck, unreadable, customersFor, customerKey, bookingVersion, ticketVersion, mrnVersion,
  hasMessageLog, inChunks,
} from './desk-shared.js';
import { failureWords } from './desk-messages.js';
import { channels } from './channels-bridge.js';
import { channelOf } from '../channels.js';
import { AWAITING_DETAILS } from '../flow/contact.js';
import { shared } from './desk-live.js';
import { VIEW_SCOPES } from '../../public/desk/live.js';

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
      return `Request missing information: ${listWords(missing.map((i) => i.label.toLowerCase()))}`;
    }
    case 'REQUEST_DOCUMENTS':
      return `Request the ${listWords(labelsOf(sum.missing))}`;
    case 'REVIEW_DOCUMENTS': {
      const unchecked = sum.required.filter((t) => sum.received_types.includes(t) && !sum.verified_types.includes(t));
      const what = unchecked.length === 1 ? `the ${labelsOf(unchecked)[0]}` : `${unchecked.length} documents`;
      // "and confirm" only when confirming really is what comes after.
      const thenConfirm = r.mrn_choice !== 'mky_issue' || r.mrn_number;
      return `Review ${what}${thenConfirm ? ' and confirm' : ''}`;
    }
    case 'PROCESS_MRN':
      return 'Record the MRN once it is issued';
    case 'CREATE_BOOKING':
      return 'Record the shipping reference';
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
  return 'Record the MRN once it is issued';
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

const DAY_MS = 86400_000;

/** What a decided booking's row in "Done today", and a paper sent after it, are drawn from. */
const DECIDED_COLUMNS = 'booking_ref, status, confirmed_at, confirmed_by, customer_name, make, model, vin, channel, assigned_to, priority';

/**
 * A moment before the start of today wherever "today" is reckoned: a day and
 * an hour ago. "Done today" never needs an older row, so the reads for it stop
 * there and the exact cut (Cairo's today, todayCheck) is made on the rows.
 */
const startOfTodayAtLatest = (now) => new Date(now - DAY_MS - 3600_000).toISOString();

/**
 * Every row the inbox could show, before tabs and filters. Exported so the
 * sidebar count and the tab title ("(3) MKY Desk") are counted from exactly
 * the list a person would see.
 *
 * READ IN FOUR ROUNDS, WHATEVER THE SIZE OF THE LIST. Each round's reads go
 * out together; a round waits only for what it needs from the one before.
 * The list used to finish with a read per chat that had a failed message, one
 * per paper with no booking and one per MRN application without a booking
 * name - one after another - so the more there was to do, the longer the desk
 * took to say so. Those are now asked for together (customersFor).
 *
 * BOUNDED BY WHAT IS SHOWN, NOT BY "THE NEWEST N". The requests and MRN
 * applications were read as the newest 400 and 300 of all time and then
 * filtered: once the business had more than that, an old one still open would
 * have dropped off the inbox. They are now read as "open, or finished today"
 * - which is what the list shows.
 *
 * A READ THAT FAILED MAKES THE LIST PARTIAL, AND SAYS SO. The rows are shown
 * as they always were, without what could not be read - but the answer is
 * marked `partial`, and a partial answer is never shared between operators,
 * never given an ETag and never counted as caught up: the next tick asks
 * again. Otherwise one failed read would be served, as "not modified", until
 * something else changed.
 */
export async function inboxItems() {
  const isToday = await todayCheck();
  const now = Date.now();
  const since = new Date(now - PROBLEM_DAYS * DAY_MS).toISOString();
  const today = startOfTodayAtLatest(now);

  // Round 1: what is open, what was decided, and what has been set aside.
  const [openQ, decidedQ, ticketsQ, handledQ] = await Promise.all([
    db().from('booking_queue').select('*').in('status', OPEN_STATUSES).order('status_changed_at', { ascending: true }).limit(500),
    // The latest decisions, for "Done today" and for papers that arrived after
    // one. From the table, not booking_queue: these rows use none of what the
    // view adds, and the view works out three subqueries for every decided
    // booking before it can sort them - the heaviest read the desk made.
    // Without a decision time a row is in neither; left in, Postgres sorts
    // those first and they could fill the 200.
    db().from('bookings').select(DECIDED_COLUMNS).in('status', ['confirmed', 'rejected', 'cancelled'])
      .not('confirmed_at', 'is', null).order('confirmed_at', { ascending: false }).limit(200),
    db().from('client_request_queue').select('*')
      .or(`status.in.(${REQUEST_OPEN.join(',')}),status_changed_at.gte."${today}",resolved_at.gte."${today}"`)
      .order('created_at', { ascending: false }).limit(400),
    db().from('audit_logs').select('entity_id, action, created_at').eq('entity_type', 'problem').gte('created_at', since).limit(1000),
  ]);
  if (openQ.error) throw new Error(`booking queue: ${openQ.error.message}`);
  let partial = Boolean(decidedQ.error || ticketsQ.error || handledQ.error);

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
  // Open bookings with an MRN application: their latest one is part of their version.
  const withMrn = open.filter((r) => r.mrn_request_ref).map((r) => r.booking_ref);
  const decided = decidedQ.data ?? [];

  // Round 2: what those rows need, and the papers and failures that are rows of their own.
  const [docsQ, contactsQ, mrnOwnQ, mrnOfOpenQ, papers, failures] = await Promise.all([
    inChunks(refs, (c) => db().from('booking_documents')
      .select('id, booking_ref, doc_type, status, extraction_ok, extracted, vin, uploaded_at')
      .in('booking_ref', c).is('deleted_at', null)),
    // What a booking's version is made of that the queue view does not carry,
    // so each row's version is the one its case page gives (bookingVersion) and
    // "Take it" can be sent straight from the list.
    inChunks(refs, (c) => db().from('bookings').select('booking_ref, customer_contact').in('booking_ref', c)),
    // Applications still open or recorded today: their own rows.
    db().from('mrn_requests').select('*')
      .or(`status.in.(${MRN_OPEN.join(',')}),and(status.eq.issued,issued_at.gte."${today}")`)
      .order('created_at', { ascending: false }).limit(300),
    // Every application of an open booking that has one: its latest is part
    // of the booking's version, as loadBooking reads it (newest first).
    inChunks(withMrn, (c) => db().from('mrn_requests').select('*').in('booking_ref', c)),
    paperRows({ since, decided }),
    problemRows({ since, handled }),
  ]);
  partial ||= Boolean(docsQ.error || contactsQ.error || mrnOwnQ.error || mrnOfOpenQ.error || papers.error || failures.error);
  // One list, newest first, each application once - as one read gave it.
  const mrnSeen = new Set();
  const mrnQ = {
    data: [...(mrnOwnQ.data ?? []), ...(mrnOfOpenQ.data ?? [])]
      .filter((m) => !mrnSeen.has(m.request_ref) && mrnSeen.add(m.request_ref))
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))),
  };
  const docsByRef = new Map();
  for (const d of docsQ.data ?? []) docsByRef.set(d.booking_ref, [...(docsByRef.get(d.booking_ref) ?? []), d]);
  const contactOf = new Map((contactsQ.data ?? []).map((b) => [b.booking_ref, b.customer_contact ?? null]));
  const latestMrn = new Map();
  for (const m of mrnQ.data ?? []) if (m.booking_ref && !latestMrn.has(m.booking_ref)) latestMrn.set(m.booking_ref, m);

  // MRN applications that are not already a booking row: a booking still open
  // shows its MRN as its own next step, and two rows for one job is noise.
  const openRefs = new Set(refs);
  const mrnRows = (mrnQ.data ?? []).filter((m) => {
    const isOpen = MRN_OPEN.includes(m.status);
    if (!isOpen && !(m.status === 'issued' && isToday(m.issued_at))) return false;
    return !(isOpen && m.booking_ref && openRefs.has(m.booking_ref));
  });

  // Round 3: whose they are - the bookings behind MRN applications, and every
  // booking of the chats that have a loose paper or a failed message.
  const mrnBookingRefs = [...new Set(mrnRows.map((m) => m.booking_ref).filter(Boolean))];
  const chatIds = [...new Set([...papers.loose.map((d) => String(d.chat_id)), ...failures.entries.map((e) => String(e.chatId))])];
  const [{ data: mrnBookings, error: mrnBookingsError }, { data: chatBookings, error: chatBookingsError }] = await Promise.all([
    inChunks(mrnBookingRefs, (c) => db().from('bookings').select('booking_ref, customer_name, channel, chat_id, client_id').in('booking_ref', c)),
    inChunks(chatIds, (c) => db().from('bookings').select('chat_id, status, customer_name, created_at').in('chat_id', c)
      .order('created_at', { ascending: false }).limit(2000)),
  ]);
  partial ||= Boolean(mrnBookingsError || chatBookingsError);
  const mrnBookingOf = new Map((mrnBookings ?? []).map((b) => [b.booking_ref, b]));
  const drafting = new Set();
  const bookedName = new Map();   // chat -> the newest non-draft booking's customer_name (or null)
  for (const b of chatBookings ?? []) {
    const chat = String(b.chat_id);
    if (b.status === 'draft') { drafting.add(chat); continue; }
    if (!bookedName.has(chat)) bookedName.set(chat, b.customer_name ?? null);
  }

  // Round 4: the customers still without a name, all at once.
  const mrnAsk = (m) => {
    const b = m.booking_ref ? mrnBookingOf.get(m.booking_ref) ?? null : null;
    const chatId = m.chat_id ?? b?.chat_id ?? null;
    const channel = m.chat_id ? channelOf(m.chat_id) : b?.channel ?? (chatId ? channelOf(chatId) : null);
    return { b, chatId, channel, ask: { clientId: m.client_id ?? b?.client_id ?? null, channel, chatId } };
  };
  // Looked up only when there is a chat or the application's own client to
  // look up by - exactly when the inbox always did.
  const mrnNeedsLookup = (m, x) => !x.b?.customer_name && Boolean(x.chatId || m.client_id);
  const paperAsk = (d) => ({ clientId: d.client_id ?? null, channel: d.channel ?? channelOf(d.chat_id), chatId: d.chat_id });
  const asks = [
    ...mrnRows.map((m) => [m, mrnAsk(m)]).filter(([m, x]) => mrnNeedsLookup(m, x)).map(([, x]) => x.ask),
    ...papers.loose.filter((d) => !drafting.has(String(d.chat_id))).map(paperAsk),
    ...papers.late.map(paperAsk),
    ...failures.entries.filter((e) => !bookedName.get(String(e.chatId))).map((e) => ({ clientId: e.clientId, channel: e.channel, chatId: e.chatId })),
  ];
  const customers = await customersFor(asks);
  partial ||= Boolean(customers.partial);
  const customerName = (ask) => customers.get(customerKey(ask))?.name ?? null;

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
      // "Talk to an agent" opens the request at the tap, before the customer
      // has said what it is about; the summary says so until they do. A flag,
      // so the desk does not read it back out of the words.
      undescribed: t.summary === AWAITING_DETAILS,
      status: statusBadge(requestStatusLabel(t.status), requestStatusTone(t.status)),
      version: ticketVersion(t),
      since: !isOpen ? doneAt : (t.status_changed_at || t.created_at),
    });
  }

  // Who the application is for, and on which channel: the row named the
  // booking reference and no channel, so the desk could not say whose it was.
  for (const m of mrnRows) {
    const tab = m.status === 'issued' ? 'done' : m.status === 'missing_information' ? 'waiting' : 'needs_us';
    // The application's own chat decides its channel; the booking's says the
    // same thing, and is the fallback for an application with no chat.
    const x = mrnAsk(m);
    const { b, channel, ask } = x;
    const name = b?.customer_name
      || (mrnNeedsLookup(m, x) ? customerName(ask) : null)
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

  const paperName = (d) => customerName(paperAsk(d)) || 'The customer';
  items.push(...paperItems({ papers, handled, drafting, nameOf: paperName }));
  // A failed message is named after the chat's newest booking, else its customer.
  const failureName = (e) => bookedName.get(String(e.chatId))
    || customerName({ clientId: e.clientId, channel: e.channel, chatId: e.chatId }) || 'the customer';
  items.push(...problemItems({ entries: problemEntries(failures, { nameFor: failureName }), chatSetAside }));
  if (partial) items.partial = true;
  return items;
}

const PAPER_COLUMNS = 'id, booking_ref, chat_id, client_id, channel, doc_type, file_name, status, uploaded_at';

/**
 * Papers a customer sent that no open case shows.
 *
 * One sent with nothing open is kept on no booking - it counts for a booking
 * the customer starts next, which is why it is left alone while one is being
 * filled in. In the live test such a photo was stored and appeared nowhere on
 * the desk. One sent after its booking was decided is on that booking, but a
 * decided booking is not in the inbox, so nobody would look. Each is a row
 * until the paper is checked, filed, or set aside.
 */
async function paperRows({ since, decided }) {
  const decidedAt = new Map(decided.filter((b) => b.confirmed_at).map((b) => [b.booking_ref, b]));
  const [looseQ, lateQ] = await Promise.all([
    db().from('booking_documents').select(PAPER_COLUMNS).is('booking_ref', null).is('deleted_at', null)
      .in('status', ['received', 'pending_verification']).gte('uploaded_at', since)
      .order('uploaded_at', { ascending: false }).limit(100),
    decidedAt.size
      ? db().from('booking_documents').select(PAPER_COLUMNS).in('booking_ref', [...decidedAt.keys()]).is('deleted_at', null)
        .in('status', ['received', 'pending_verification']).gte('uploaded_at', since).limit(100)
      : { data: [] },
  ]);
  const late = (lateQ.data ?? []).filter((d) => {
    const b = decidedAt.get(d.booking_ref);
    return b && String(d.uploaded_at ?? '') > String(b.confirmed_at);
  });
  return { loose: (looseQ.data ?? []).filter((d) => d.chat_id), late, decidedAt, error: looseQ.error || lateQ.error || null };
}

/** The rows for those papers; `nameOf` answers from names already read. */
function paperItems({ papers, handled, drafting, nameOf }) {
  const { decidedAt } = papers;
  const loose = papers.loose.filter((d) => !handled.has(`document:${d.id}`));
  const out = [];
  const label = (d) => DOC_LABEL[d.doc_type] && d.doc_type !== 'other' ? DOC_LABEL[d.doc_type] : (d.file_name || 'a paper');

  for (const d of loose) {
    if (drafting.has(String(d.chat_id))) continue;
    const name = nameOf(d);
    const channel = d.channel ?? channelOf(d.chat_id);
    out.push({
      id: `document:${d.id}`,
      kind: 'problem',
      tags: ['problems'],
      tab: 'needs_us',
      tone: 'amber',
      sentence: `${name} sent ${/^[AEIOU]/i.test(label(d)) ? 'an' : 'a'} ${label(d)} with no booking open — look at it`,
      who: name,
      detail: [d.file_name, 'Kept on no booking. It counts for a booking they start; or file it on one of theirs.'].filter(Boolean).join(' · '),
      ref: null,
      link: { type: 'chat', channel, chat_id: d.chat_id, document_id: d.id },
      channel,
      priority: 'normal',
      since: d.uploaded_at,
      status: statusBadge('No booking', 'amber'),
      version: null,
      problem: { type: 'document', id: d.id },
    });
  }

  for (const d of papers.late) {
    const b = decidedAt.get(d.booking_ref);
    if (!b || handled.has(`document:${d.id}`) || String(d.uploaded_at ?? '') <= String(b.confirmed_at)) continue;
    const name = b.customer_name || nameOf(d);
    out.push({
      id: `document:${d.id}`,
      kind: 'problem',
      tags: ['problems'],
      tab: 'needs_us',
      tone: 'amber',
      sentence: `New ${label(d)} after ${d.booking_ref} was ${b.status === 'confirmed' ? 'confirmed' : b.status} — check it`,
      who: name,
      detail: [d.booking_ref, d.file_name].filter(Boolean).join(' · '),
      ref: d.booking_ref,
      link: { type: 'booking', ref: d.booking_ref, document_id: d.id },
      channel: b.channel ?? d.channel ?? null,
      priority: 'normal',
      since: d.uploaded_at,
      status: statusBadge('New document', 'amber'),
      version: null,
      problem: { type: 'document', id: d.id },
    });
  }
  return out;
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
function problemItems({ entries: singles, chatSetAside = new Map() }) {
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
 * Every message that did not reach a customer and still needs a person: the
 * failed messages in the conversation log, and the outbox rows that died or
 * are held. Read in round 2 of inboxItems(); named in round 4.
 */
async function problemRows({ since, handled }) {
  const [failedQ, outboxQ] = await Promise.all([
    db().from('chat_messages').select('*').eq('status', 'failed').eq('direction', 'out')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(200),
    db().from('notification_outbox').select('*').neq('status', 'sent')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(300),
  ]);

  const entries = [];
  // Provider ids of the failed messages, so the outbox's record of the same
  // message is not a second failure.
  const failedIds = new Set();
  if (!failedQ.error) {
    for (const m of failedQ.data ?? []) {
      if (m.provider_message_id) failedIds.add(String(m.provider_message_id));
      if (handled.has(`message:${m.id}`)) continue;
      entries.push({ source: 'message', row: m, channel: m.channel, chatId: String(m.chat_id), clientId: m.client_id ?? null });
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
    if (handled.has(`outbox:${o.id}`)) continue;
    entries.push({ source: 'outbox', row: o, channel: o.channel, chatId: String(o.chat_id), clientId: o.client_id ?? null });
  }
  // A missing chat log is a database before its migration, not a failure.
  const failedError = failedQ.error && !isMissingTable(failedQ.error) ? failedQ.error : null;
  return { entries, error: failedError || outboxQ.error || null };
}

/**
 * One entry per message that did not reach a customer, with the row the inbox
 * showed for it before they were grouped. `nameFor` answers from the names
 * inboxItems() has already read.
 */
function problemEntries({ entries }, { nameFor }) {
  const out = [];
  for (const e of entries) {
    const name = nameFor(e);
    if (e.source === 'message') {
      const m = e.row;
      const pid = `message:${m.id}`;
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
      continue;
    }

    const o = e.row;
    const pid = `outbox:${o.id}`;
    const needsTemplate = o.delivery_status === 'needs_template';
    const stopped = o.delivery_status === 'opted_out';
    const dead = ['dead', 'failed'].includes(o.status);
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
          ? `The ${what} cannot go as free text${o.template_name ? `; template “${o.template_name}”` : ''}. It goes as soon as they write; or send the reply-request template, or set one up in Settings.`
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

/**
 * The inbox's rows, worked out once per instance for every operator asking
 * under the same versions (lib/admin/desk-live.js). The rows are the same for
 * everybody; tabs, filters and "mine" are cut from them per request, and
 * nothing here changes them.
 */
const sharedInbox = (req) => shared('inbox', req?.deskPulse ?? null, VIEW_SCOPES.inbox, () => inboxItems());

/** GET view=inbox&tab=&filter=&offset=&limit= */
export async function inboxView(req, res, who) {
  const tab = TABS.includes(req.query.tab) ? req.query.tab : 'needs_us';
  const filter = FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const all = await sharedInbox(req);
  // Some of it could not be read: shown, but not vouched for (no ETag) and
  // marked, so the desk asks again on its next tick.
  if (all.partial) req.deskNoTag = true;
  const counts = { tabs: {}, filters: {} };
  for (const t of TABS) counts.tabs[t] = all.filter((i) => i.tab === t).length;
  const inTab = all.filter((i) => i.tab === tab);
  for (const f of FILTERS) counts.filters[f] = inTab.filter((i) => inFilter(i, f, who.name)).length;

  const rows = sortItems(inTab.filter((i) => inFilter(i, filter, who.name)), tab);
  const chan = await channels();
  const logged = await hasMessageLog();

  return res.status(200).json({
    tab,
    filter,
    counts,
    // The sidebar's numbers, from the same list: the desk does not have to
    // ask view=counts for them while the inbox is open.
    nav: navCounts(all, who),
    total: rows.length,
    offset,
    limit,
    has_more: offset + limit < rows.length,
    items: rows.slice(offset, offset + limit),
    features: { channels: Boolean(chan), chat_messages: logged },
    ...(all.partial ? { partial: true } : {}),
  });
}

/** The numbers on the sidebar and in the tab title, from the inbox's rows. */
function navCounts(all, who) {
  const needs = all.filter((i) => i.tab === 'needs_us');
  return {
    needs_us: needs.length,
    problems: needs.filter((i) => i.kind === 'problem').length,
    mine: needs.filter((i) => String(i.assigned_to ?? '').toLowerCase() === who.name.toLowerCase()).length,
  };
}

/** GET view=counts - the numbers on the sidebar and in the tab title. */
export async function countsView(req, res, who) {
  const all = await sharedInbox(req);
  if (all.partial) req.deskNoTag = true;
  return res.status(200).json({ ...navCounts(all, who), ...(all.partial ? { partial: true } : {}) });
}
