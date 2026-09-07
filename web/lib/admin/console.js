/**
 * The operations console's API.
 *
 *   GET  ?resource=console&view=dashboard
 *   GET  ?resource=console&view=queue&filter=…&q=…&offset=…
 *   GET  ?resource=console&view=booking&ref=…
 *   POST ?resource=console   { action, … }
 *
 * One route rather than nine, because Vercel's Hobby plan allows twelve
 * Serverless Functions and this project is at exactly twelve.
 *
 * TWO RULES RUN THROUGH ALL OF IT.
 *
 * The first: what is TRUE is decided here, from rows. The browser has the same
 * workflow module and uses it to decide what to DRAW - which button to offer,
 * which chip to colour - but every action re-derives the answer server-side
 * before it writes. A console that trusted the client's readiness calculation
 * would confirm a booking whose documents had been rejected in another tab
 * thirty seconds earlier.
 *
 * The second: confirming and rejecting are NOT reimplemented here. They already
 * exist, guarded, in api/admin/bookings.js - conditional update, shipment
 * creation, outbox, task closure, audit. This calls that. Two implementations
 * of "confirm a booking" is precisely the second source of truth that turns
 * into two different answers on a Friday afternoon.
 */

import { config } from '../config.js';
import { db } from '../supabase.js';
import { signedUrl } from '../storage.js';
import { audit, logEvent } from '../audit.js';
import { enqueue, drain } from '../outbox.js';
import { createTask, completeTask } from '../operations.js';
import { settings } from '../settings.js';
import { requiredDocuments } from '../settings.js';
import decideBooking from '../../api/admin/bookings.js';
import ticketsApi from '../../api/admin/tickets.js';
import shipmentsApi from '../../api/admin/shipments.js';
import {
  STATUS, OPEN_STATUSES, readiness, nextAction, availableActions,
  canTransition, statusLabel, DOC_LABEL,
  REQUEST_OPEN, requestStatusLabel, requestNextAction, canTransitionRequest,
  SHIPMENT_MILESTONES,
} from '../ops/workflow.js';

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

/**
 * What each role may do.
 *
 * Checked HERE, on the server. The console hides what a role may not do, but
 * hiding a button is a courtesy, not a permission - anyone holding the admin
 * secret can craft the request by hand.
 */
const PERMISSIONS = {
  read_only:      new Set(['read']),
  ops_agent:      new Set(['read', 'assign_self', 'status', 'documents', 'client', 'notes', 'booking', 'mrn']),
  ops_supervisor: new Set(['read', 'assign_self', 'assign_others', 'status', 'documents', 'client', 'notes', 'booking', 'mrn', 'priority', 'override']),
  admin:          new Set(['read', 'assign_self', 'assign_others', 'status', 'documents', 'client', 'notes', 'booking', 'mrn', 'priority', 'override', 'settings', 'users']),
};

/** Resolves the operator named in the request, and what they may do. */
async function operatorFor(req) {
  const name = String(req.body?.operator ?? req.query.operator ?? '').trim();
  if (!name) return { ok: false, error: 'Sign in with your name before making changes.' };

  const { data, error } = await db()
    .from('ops_users')
    .select('name, role, active')
    .ilike('name', name)
    .maybeSingle();

  if (error) return { ok: false, error: 'Could not check who you are. Try again.' };
  if (!data) return { ok: false, error: `"${name}" is not on the operations list. Ask an administrator to add you.` };
  if (!data.active) return { ok: false, error: `"${data.name}" is no longer active.` };

  return { ok: true, name: data.name, role: data.role, can: (p) => PERMISSIONS[data.role]?.has(p) ?? false };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  const secret = req.query.secret ?? req.headers['x-admin-secret'];
  if (!config.adminSecret || secret !== config.adminSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    if (req.method === 'GET') {
      const view = String(req.query.view ?? 'queue');
      if (view === 'dashboard') return dashboard(req, res);
      if (view === 'booking') return bookingDetail(req, res);
      if (view === 'search') return search(req, res);
      if (view === 'requests') return requestQueue(req, res);
      if (view === 'request') return requestDetail(req, res);
      if (view === 'shipments') return shipmentQueue(req, res);
      if (view === 'shipment') return shipmentDetail(req, res);
      return queue(req, res);
    }
    if (req.method === 'POST') return act(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    // Never the raw Postgres error. An operator can do nothing with
    // "PGRST116"; the reference is what they quote when they call us.
    const ref = `ERR-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    console.error(`console error ${ref}:`, err);
    return res.status(500).json({ error: 'Something went wrong on our side.', ref });
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

async function dashboard(req, res) {
  const me = String(req.query.operator ?? '').trim();
  const cfg = await settings();

  const { data: rows, error } = await db()
    .from('booking_queue')
    .select('*')
    .in('status', OPEN_STATUSES)
    .order('status_changed_at', { ascending: true })
    .limit(500);
  if (error) return res.status(500).json({ error: 'We could not load the queue.' });

  const enriched = await enrichAll(rows ?? []);

  const counter = (fn) => enriched.filter(fn).length;
  const thresholds = {
    new_request_hours: Number(cfg.sla_new_request_hours) || null,
    review_hours: Number(cfg.sla_review_hours) || null,
  };

  const counters = [
    { key: 'new', label: 'New requests', filter: 'new', count: counter((r) => r.status === 'pending_review') },
    { key: 'review', label: 'Under review', filter: 'under_review', count: counter((r) => r.status === 'under_review') },
    { key: 'documents', label: 'Missing documents', filter: 'missing_documents', count: counter((r) => r.next.code === 'REQUEST_DOCUMENTS') },
    { key: 'mrn', label: 'MRN action required', filter: 'mrn', count: counter((r) => r.next.code === 'PROCESS_MRN') },
    { key: 'ready', label: 'Ready to confirm', filter: 'ready', count: counter((r) => r.next.code === 'CONFIRM_BOOKING' || r.next.code === 'CREATE_BOOKING') },
    { key: 'waiting', label: 'Waiting for client', filter: 'waiting_client', count: counter((r) => r.next.owner === 'client') },
    { key: 'responded', label: 'Client responded', filter: 'responded', count: counter((r) => r.client_responded) },
    { key: 'overdue', label: 'Overdue', filter: 'overdue', count: counter((r) => r.overdue) },
  ];

  const mine = enriched
    .filter((r) => me && r.assigned_to && r.assigned_to.toLowerCase() === me.toLowerCase() && r.next.owner === 'ops')
    .slice(0, 15);

  const unassigned = enriched
    .filter((r) => !r.assigned_to && r.next.owner === 'ops')
    .slice(0, 15);

  const { data: activity } = await db()
    .from('audit_logs')
    .select('action, actor_type, actor_id, entity_type, entity_id, created_at')
    .order('created_at', { ascending: false })
    .limit(20);

  res.status(200).json({
    counters,
    my_tasks: mine,
    unassigned,
    activity: (activity ?? []).map(describeActivity),
    sla: thresholds,
  });
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

const FILTERS = {
  active: (r) => OPEN_STATUSES.includes(r.status),
  new: (r) => r.status === 'pending_review',
  under_review: (r) => r.status === 'under_review',
  unassigned: (r) => !r.assigned_to && r.next.owner === 'ops',
  missing_documents: (r) => r.next.code === 'REQUEST_DOCUMENTS',
  mrn: (r) => r.next.code === 'PROCESS_MRN',
  waiting_client: (r) => r.next.owner === 'client',
  responded: (r) => r.client_responded,
  ready: (r) => ['CONFIRM_BOOKING', 'CREATE_BOOKING'].includes(r.next.code),
  overdue: (r) => r.overdue,
  confirmed_today: (r) => r.status === 'confirmed' && isToday(r.confirmed_at),
  all: () => true,
};

async function queue(req, res) {
  const filter = String(req.query.filter ?? 'active');
  const me = String(req.query.operator ?? '').trim();
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  // The status set is narrowed in SQL first, so a desk with ten thousand
  // finished bookings does not pull them into memory to filter five open ones.
  const query = db().from('booking_queue').select('*');
  if (filter === 'confirmed_today') query.eq('status', 'confirmed');
  else if (filter === 'all') query.neq('status', 'draft');
  else query.in('status', OPEN_STATUSES);

  if (q) {
    const safe = q.replace(/[%_,()]/g, ' ').trim();
    if (safe) {
      query.or(
        `booking_ref.ilike.%${safe}%,vin.ilike.%${safe}%,customer_name.ilike.%${safe}%,make.ilike.%${safe}%`,
      );
    }
  }

  const { data, error } = await query.order('status_changed_at', { ascending: true }).limit(500);
  if (error) return res.status(500).json({ error: 'We could not load booking requests.' });

  let rows = await enrichAll(data ?? []);
  if (filter === 'mine') rows = rows.filter((r) => me && r.assigned_to?.toLowerCase() === me.toLowerCase());
  else rows = rows.filter(FILTERS[filter] ?? FILTERS.active);

  // Urgent first, then whoever has waited longest. An operator working top-down
  // is then working the right thing without having to sort anything.
  rows.sort((a, b) => (a.priority_rank - b.priority_rank) || (a.waiting_ms > b.waiting_ms ? -1 : 1));

  const total = rows.length;
  res.status(200).json({
    filter,
    total,
    offset,
    limit,
    has_more: offset + limit < total,
    rows: rows.slice(offset, offset + limit),
  });
}

// ---------------------------------------------------------------------------
// One booking, in full
// ---------------------------------------------------------------------------

async function bookingDetail(req, res) {
  const ref = String(req.query.ref ?? '').trim();
  if (!ref) return res.status(400).json({ error: 'ref is required' });

  const { data: booking, error } = await db().from('bookings').select('*').eq('booking_ref', ref).maybeSingle();
  if (error) return res.status(500).json({ error: 'We could not load this booking.' });
  if (!booking) return res.status(404).json({ error: `No booking ${ref}` });

  const [docs, mrn, notes, activity, notifications, duplicate] = await Promise.all([
    documentsFor(booking),
    db().from('mrn_requests').select('*').eq('booking_ref', ref).order('created_at', { ascending: false }).limit(1).maybeSingle().then((r) => r.data),
    db().from('internal_notes').select('*').eq('booking_ref', ref).order('created_at', { ascending: false }).limit(50).then((r) => r.data ?? []),
    db().from('audit_logs').select('*').eq('entity_id', ref).order('created_at', { ascending: false }).limit(60).then((r) => r.data ?? []),
    db().from('notification_outbox').select('event_type, status, attempt_count, last_error, sent_at, created_at').eq('entity_id', ref).order('created_at', { ascending: false }).then((r) => r.data ?? []),
    duplicateFor(booking),
  ]);

  const summary = documentSummary(docs, await requiredDocuments({ mrnChoice: booking.mrn_choice ?? 'existing' }));
  const ready = readiness(booking, summary, mrn);
  const next = nextAction(booking, summary, mrn);

  res.status(200).json({
    booking: { ...booking, status_label: statusLabel(booking.status) },
    readiness: ready,
    next_action: next,
    actions: availableActions(booking, ready),
    documents: docs,
    document_summary: summary,
    mrn,
    duplicate,
    notes,
    activity: activity.map(describeActivity),
    notifications,
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function act(req, res) {
  const who = await operatorFor(req);
  if (!who.ok) return res.status(403).json({ error: who.error });

  const { action, booking_ref: ref } = req.body ?? {};
  if (!action) return res.status(400).json({ error: 'action is required' });

  const needs = {
    assign: 'assign_self', unassign: 'assign_self', priority: 'priority',
    start_review: 'status', status: 'status', request_info: 'client',
    verify_document: 'documents', reject_document: 'documents',
    internal_note: 'notes', message_client: 'client',
    create_booking: 'booking', confirm: 'booking', reject: 'booking', cancel: 'booking',
    issue_mrn: 'mrn', mrn_need_info: 'mrn',
    request_assign: 'assign_self', request_status: 'status',
    request_reply: 'client', request_resolve: 'client',
    shipment_update: 'booking',
  }[action];

  if (needs && !who.can(needs)) {
    return res.status(403).json({ error: `Your role (${who.role.replace(/_/g, ' ')}) cannot do that.` });
  }

  switch (action) {
    case 'assign': return assign(req, res, who);
    case 'unassign': return assign(req, res, who, { clear: true });
    case 'priority': return setPriority(req, res, who);
    case 'start_review': return setStatus(req, res, who, 'under_review');
    case 'status': return setStatus(req, res, who, String(req.body.status ?? ''));
    case 'internal_note': return addNote(req, res, who);
    case 'verify_document': return reviewDocument(req, res, who, true);
    case 'reject_document': return reviewDocument(req, res, who, false);
    case 'request_info': return requestInfo(req, res, who);
    case 'message_client': return messageClient(req, res, who);
    case 'create_booking': return createBookingRecord(req, res, who);
    // Confirm, reject and cancel go through the existing guarded path.
    case 'confirm': return delegate(req, res, who, 'confirm');
    case 'reject': return delegate(req, res, who, 'reject');
    case 'cancel': return delegate(req, res, who, 'cancel');
    case 'request_assign': return requestAssign(req, res, who);
    case 'request_status': return requestStatus(req, res, who);
    case 'request_reply': return requestReply(req, res, who);
    case 'request_resolve': return requestResolve(req, res, who);
    case 'shipment_update': return shipmentUpdate(req, res, who);
    default: return res.status(400).json({ error: `Unknown action "${action}"` });
  }
}

/** Ownership. Taking work is an agent's right; giving it away is a supervisor's. */
async function assign(req, res, who, { clear = false } = {}) {
  const ref = String(req.body.booking_ref ?? '').trim();
  const to = clear ? null : String(req.body.assignee ?? who.name).trim();

  if (!clear && to.toLowerCase() !== who.name.toLowerCase() && !who.can('assign_others')) {
    return res.status(403).json({ error: 'Only a supervisor can assign work to somebody else.' });
  }

  const { data: before } = await db().from('bookings').select('assigned_to, status').eq('booking_ref', ref).maybeSingle();
  if (!before) return res.status(404).json({ error: `No booking ${ref}` });

  const { data, error } = await db()
    .from('bookings')
    .update({ assigned_to: to, assigned_at: clear ? null : new Date().toISOString(), assigned_by: who.name })
    .eq('booking_ref', ref)
    .select('assigned_to')
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'We could not change the owner.' });

  await audit({
    actor_type: 'operator', actor_id: who.name,
    action: clear ? 'booking_unassigned' : 'booking_assigned',
    entity_type: 'booking', entity_id: ref,
    metadata: { from: before.assigned_to ?? null, to },
  });

  res.status(200).json({ ok: true, assigned_to: data?.assigned_to ?? null });
}

async function setPriority(req, res, who) {
  const ref = String(req.body.booking_ref ?? '').trim();
  const priority = String(req.body.priority ?? '').trim();
  if (!['normal', 'high', 'urgent'].includes(priority)) {
    return res.status(400).json({ error: 'Priority must be normal, high or urgent.' });
  }

  const { error } = await db().from('bookings').update({ priority }).eq('booking_ref', ref);
  if (error) return res.status(500).json({ error: 'We could not change the priority.' });

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'booking_priority_changed',
    entity_type: 'booking', entity_id: ref, metadata: { priority },
  });
  res.status(200).json({ ok: true, priority });
}

/**
 * A status change, checked against the transition table.
 *
 * The same table the browser uses to grey out illegal moves - but checked here,
 * because the browser's copy is advice and this is the decision.
 */
async function setStatus(req, res, who, to) {
  const ref = String(req.body.booking_ref ?? '').trim();
  const { data: booking } = await db().from('bookings').select('status').eq('booking_ref', ref).maybeSingle();
  if (!booking) return res.status(404).json({ error: `No booking ${ref}` });

  if (!canTransition(booking.status, to)) {
    return res.status(409).json({
      error: `A request that is "${statusLabel(booking.status)}" cannot become "${statusLabel(to)}".`,
    });
  }

  // The status is repeated in the WHERE clause so the database decides who
  // wins when two operators move the same request at once.
  const { data, error } = await db()
    .from('bookings')
    .update({ status: to, ...(to === 'under_review' ? { assigned_to: booking.assigned_to ?? who.name } : {}) })
    .eq('booking_ref', ref)
    .eq('status', booking.status)
    .select('status');
  if (error) return res.status(500).json({ error: 'We could not change the status.' });
  if (!data?.length) {
    return res.status(409).json({ error: 'Somebody else changed this request a moment ago. Refresh and look again.' });
  }

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'booking_status_changed',
    entity_type: 'booking', entity_id: ref, metadata: { from: booking.status, to },
  });
  res.status(200).json({ ok: true, status: to, status_label: statusLabel(to) });
}

/** An internal note. It has no path to Telegram, by construction. */
async function addNote(req, res, who) {
  const ref = String(req.body.booking_ref ?? '').trim();
  const body = String(req.body.body ?? '').trim();
  if (body.length < 2) return res.status(400).json({ error: 'The note is empty.' });

  const { data, error } = await db()
    .from('internal_notes')
    .insert({ booking_ref: ref, entity_id: ref, author: who.name, body })
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'We could not save the note.' });

  res.status(200).json({ ok: true, note: data });
}

/**
 * Verify or reject one document.
 *
 * Rejecting asks the client for a replacement, which means the request is now
 * waiting on them - so the status moves too. Verifying is silent: it changes
 * nothing the client needs to hear about.
 */
async function reviewDocument(req, res, who, verify) {
  const id = Number(req.body.document_id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'document_id is required' });

  const { data: doc } = await db().from('booking_documents').select('*').eq('id', id).maybeSingle();
  if (!doc) return res.status(404).json({ error: 'That document is no longer here.' });

  if (verify) {
    const { error } = await db().from('booking_documents').update({
      status: 'verified', verified_at: new Date().toISOString(), verified_by: who.name,
      reviewed_at: new Date().toISOString(), rejection_reason: null, rejection_code: null,
    }).eq('id', id);
    if (error) return res.status(500).json({ error: 'We could not save that.' });

    await audit({
      actor_type: 'operator', actor_id: who.name, action: 'document_verified',
      entity_type: 'booking_document', entity_id: String(id),
      metadata: { doc_type: doc.doc_type, booking_ref: doc.booking_ref },
    });

    // The task that asked somebody to look at it is done, so it stops being
    // work. A queue that disagrees with the record is worse than no queue.
    await closeDocumentTask(doc.booking_ref, who.name);
    return res.status(200).json({ ok: true, status: 'verified' });
  }

  const code = String(req.body.reason_code ?? 'other');
  const note = String(req.body.reason ?? '').trim();
  const label = DOC_LABEL[doc.doc_type] ?? 'document';

  const { error } = await db().from('booking_documents').update({
    status: 'replacement_requested',
    rejection_code: code,
    rejection_reason: note || null,
    reviewed_at: new Date().toISOString(),
    verified_by: who.name,
  }).eq('id', id);
  if (error) return res.status(500).json({ error: 'We could not save that.' });

  // The old file stays. It is the record of what was sent, and a replacement
  // that arrives later points back at it.
  if (doc.booking_ref) {
    await db().from('bookings').update({ status: 'needs_client_action' })
      .eq('booking_ref', doc.booking_ref)
      .in('status', ['pending_review', 'under_review']);

    await enqueue({
      chatId: doc.chat_id,
      eventType: 'missing_information_requested',
      entityType: 'booking',
      entityId: doc.booking_ref,
      idempotencyKey: `doc_replacement:${id}:${code}`,
      payload: {
        booking_ref: doc.booking_ref,
        requested: `A replacement ${label}${note ? ` — ${note}` : ` — the one we have is ${reasonText(code)}`}.`,
      },
    });
    await drain({ limit: 5 }).catch(() => null);
  }

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'document_rejected',
    entity_type: 'booking_document', entity_id: String(id),
    metadata: { doc_type: doc.doc_type, booking_ref: doc.booking_ref, reason_code: code },
  });

  res.status(200).json({ ok: true, status: 'replacement_requested' });
}

const reasonText = (code) => ({
  unreadable: 'unreadable', wrong_document: 'the wrong document', incomplete: 'incomplete',
  wrong_vin: 'for a different chassis', wrong_client: 'for a different client', expired: 'out of date',
}[code] ?? 'not usable');

/** Ask the client for something, in their own language, through the outbox. */
async function requestInfo(req, res, who) {
  const ref = String(req.body.booking_ref ?? '').trim();
  const requested = String(req.body.requested ?? '').trim();
  if (!requested) return res.status(400).json({ error: 'Say what the client must send.' });

  const { data: booking } = await db().from('bookings').select('chat_id, client_id, status').eq('booking_ref', ref).maybeSingle();
  if (!booking) return res.status(404).json({ error: `No booking ${ref}` });

  await db().from('bookings').update({
    status: 'needs_client_action',
    needs_client_action: { requested, at: new Date().toISOString(), by: who.name },
  }).eq('booking_ref', ref).in('status', ['pending_review', 'under_review', 'needs_client_action']);

  const queued = await enqueue({
    chatId: booking.chat_id,
    clientId: booking.client_id ?? null,
    eventType: 'missing_information_requested',
    entityType: 'booking',
    entityId: ref,
    // Keyed on the text, so asking for a second thing later sends a second
    // message while a double-click sends one.
    idempotencyKey: `request_info:${ref}:${hash(requested)}`,
    payload: { booking_ref: ref, requested },
  });
  await drain({ limit: 5 }).catch(() => null);

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'client_information_requested',
    entity_type: 'booking', entity_id: ref, metadata: { requested },
  });

  res.status(200).json({ ok: true, queued: queued.ok, status: 'needs_client_action' });
}

/** A free message to the client. Always through the outbox, never inline. */
async function messageClient(req, res, who) {
  const ref = String(req.body.booking_ref ?? '').trim();
  const text = String(req.body.text ?? '').trim();
  if (text.length < 2) return res.status(400).json({ error: 'The message is empty.' });

  const { data: booking } = await db().from('bookings').select('chat_id, client_id').eq('booking_ref', ref).maybeSingle();
  if (!booking?.chat_id) return res.status(404).json({ error: 'We have no chat to send this to.' });

  const queued = await enqueue({
    chatId: booking.chat_id,
    clientId: booking.client_id ?? null,
    eventType: 'operations_message',
    entityType: 'booking',
    entityId: ref,
    idempotencyKey: `ops_message:${ref}:${hash(text)}:${Date.now().toString(36)}`,
    payload: { text },
  });
  await drain({ limit: 5 }).catch(() => null);

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'client_message_sent',
    entity_type: 'booking', entity_id: ref, metadata: { chars: text.length },
  });

  res.status(200).json({ ok: true, queued: queued.ok });
}

/**
 * Record the booking reference.
 *
 * Uniqueness is the database's job: a partial unique index already covers
 * booking_ref, and this reports the clash rather than overwriting somebody.
 */
async function createBookingRecord(req, res, who) {
  const ref = String(req.body.booking_ref ?? '').trim();
  const reference = String(req.body.reference ?? '').trim().toUpperCase();
  if (!reference) return res.status(400).json({ error: 'Enter the booking reference.' });

  const { data: booking } = await db().from('bookings').select('*').eq('booking_ref', ref).maybeSingle();
  if (!booking) return res.status(404).json({ error: `No booking ${ref}` });

  // Readiness is recomputed here from rows, never taken from the browser.
  const docs = await documentsFor(booking);
  const summary = documentSummary(docs, await requiredDocuments({ mrnChoice: booking.mrn_choice ?? 'existing' }));
  const { data: mrn } = await db().from('mrn_requests').select('*').eq('booking_ref', ref).order('created_at', { ascending: false }).limit(1).maybeSingle();
  const ready = readiness(booking, summary, mrn);

  if (!ready.complete) {
    return res.status(409).json({
      error: 'This booking is not ready yet.',
      missing: ready.items.filter((i) => i.blocking && !i.ok).map((i) => i.label),
    });
  }

  if (reference !== booking.booking_ref) {
    const { data: clash } = await db().from('bookings').select('booking_ref').eq('booking_ref', reference).maybeSingle();
    if (clash) return res.status(409).json({ error: 'This booking reference already exists.' });
  }

  const patch = {};
  if (req.body.vessel) patch.notes = [booking.notes, `Vessel: ${String(req.body.vessel).trim()}`].filter(Boolean).join('\n');
  if (req.body.note) patch.ops_notes = String(req.body.note).trim();
  if (Object.keys(patch).length) await db().from('bookings').update(patch).eq('booking_ref', ref);

  await createTask({
    taskType: 'confirm_booking', bookingRef: ref, chatId: booking.chat_id,
    clientId: booking.client_id ?? null, priority: 'high',
    payload: { reference }, idempotencyKey: `confirm_booking:${ref}`,
  }).catch(() => null);

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'booking_reference_recorded',
    entity_type: 'booking', entity_id: ref, metadata: { reference },
  });

  res.status(200).json({ ok: true, reference, next: 'confirm' });
}

/**
 * Confirm, reject and cancel: handed to the existing endpoint.
 *
 * Not reimplemented. That handler owns the conditional update, the shipment,
 * the outbox message and the task closure, and it has been in production. A
 * second copy here would be a second answer to "did this booking get
 * confirmed", which is the one question that must have exactly one.
 */
async function delegate(req, res, who, action) {
  const proxied = {
    ...req,
    method: 'POST',
    query: { ...req.query, secret: config.adminSecret },
    headers: { ...req.headers, 'x-admin-secret': config.adminSecret },
    body: { ...req.body, action, operator: who.name },
  };
  return decideBooking(proxied, res);
}


// ---------------------------------------------------------------------------
// Client requests
// ---------------------------------------------------------------------------

async function requestQueue(req, res) {
  const filter = String(req.query.filter ?? 'open');
  const me = String(req.query.operator ?? '').trim();

  const query = db().from('client_request_queue').select('*');
  if (filter === 'resolved') query.in('status', ['resolved', 'closed']);
  else if (filter !== 'all') query.in('status', REQUEST_OPEN);

  const { data, error } = await query.order('status_changed_at', { ascending: true }).limit(400);
  if (error) return res.status(500).json({ error: 'We could not load client requests.' });

  const now = Date.now();
  let rows = (data ?? []).map((r) => {
    const next = requestNextAction(r);
    const since = r.status_changed_at || r.created_at;
    return {
      ...r,
      status_label: requestStatusLabel(r.status),
      next,
      waiting_since: since,
      waiting_ms: now - new Date(since).getTime(),
      priority_rank: { urgent: 0, high: 1, normal: 2 }[r.priority] ?? 2,
    };
  });

  if (filter === 'mine') rows = rows.filter((r) => me && r.assigned_to?.toLowerCase() === me.toLowerCase());
  if (filter === 'unassigned') rows = rows.filter((r) => !r.assigned_to && r.next.owner === 'ops');
  if (['booking', 'tracking', 'documents', 'other'].includes(filter)) {
    rows = rows.filter((r) => r.request_type === filter);
  }

  rows.sort((a, b) => (a.priority_rank - b.priority_rank) || (a.waiting_ms > b.waiting_ms ? -1 : 1));
  res.status(200).json({ filter, total: rows.length, rows });
}

async function requestDetail(req, res) {
  const ref = String(req.query.ref ?? '').trim();
  const { data: request, error } = await db().from('client_request_queue').select('*').eq('ticket_ref', ref).maybeSingle();
  if (error) return res.status(500).json({ error: 'We could not load this request.' });
  if (!request) return res.status(404).json({ error: `No request ${ref}` });

  // The conversation this came from, and only the recent part of it: the whole
  // transcript is noise, and an operator is looking for what was just said.
  const { data: convo } = await db()
    .from('conversations')
    .select('messages, updated_at')
    .eq('id', `${request.channel}:${request.chat_id}`)
    .maybeSingle();

  const [notifications, activity, bookings] = await Promise.all([
    db().from('notification_outbox').select('event_type, status, sent_at, last_error, created_at')
      .eq('chat_id', String(request.chat_id)).order('created_at', { ascending: false }).limit(10).then((r) => r.data ?? []),
    db().from('audit_logs').select('*').eq('entity_id', ref).order('created_at', { ascending: false }).limit(30).then((r) => r.data ?? []),
    db().from('bookings').select('booking_ref, status, vin, make, customer_name')
      .eq('chat_id', String(request.chat_id)).neq('status', 'draft')
      .order('created_at', { ascending: false }).limit(5).then((r) => r.data ?? []),
  ]);

  res.status(200).json({
    request: { ...request, status_label: requestStatusLabel(request.status) },
    next_action: requestNextAction(request),
    conversation: (convo?.messages ?? []).slice(-12),
    bookings,
    notifications,
    activity: activity.map(describeActivity),
  });
}

async function requestAssign(req, res, who) {
  const ref = String(req.body.ticket_ref ?? '').trim();
  const clear = Boolean(req.body.clear);
  const to = clear ? null : String(req.body.assignee ?? who.name).trim();

  if (!clear && to.toLowerCase() !== who.name.toLowerCase() && !who.can('assign_others')) {
    return res.status(403).json({ error: 'Only a supervisor can assign work to somebody else.' });
  }

  const { data: before } = await db().from('support_tickets').select('status, assigned_to').eq('ticket_ref', ref).maybeSingle();
  if (!before) return res.status(404).json({ error: `No request ${ref}` });

  // Taking an untouched request also moves it out of "nobody has looked at
  // this", so the queue does not show it as new once somebody owns it.
  const patch = { assigned_to: to, assigned_at: clear ? null : new Date().toISOString() };
  if (!clear && before.status === 'open') patch.status = 'assigned';

  const { error } = await db().from('support_tickets').update(patch).eq('ticket_ref', ref);
  if (error) return res.status(500).json({ error: 'We could not change the owner.' });

  await audit({
    actor_type: 'operator', actor_id: who.name,
    action: clear ? 'request_unassigned' : 'request_assigned',
    entity_type: 'support_ticket', entity_id: ref,
    metadata: { from: before.assigned_to ?? null, to },
  });
  res.status(200).json({ ok: true, assigned_to: to, status: patch.status ?? before.status });
}

async function requestStatus(req, res, who) {
  const ref = String(req.body.ticket_ref ?? '').trim();
  const to = String(req.body.status ?? '').trim();

  const { data: before } = await db().from('support_tickets').select('status').eq('ticket_ref', ref).maybeSingle();
  if (!before) return res.status(404).json({ error: `No request ${ref}` });

  if (!canTransitionRequest(before.status, to)) {
    return res.status(409).json({
      error: `A request that is "${requestStatusLabel(before.status)}" cannot become "${requestStatusLabel(to)}".`,
    });
  }

  const { data, error } = await db().from('support_tickets')
    .update({ status: to }).eq('ticket_ref', ref).eq('status', before.status).select('status');
  if (error) return res.status(500).json({ error: 'We could not change the status.' });
  if (!data?.length) return res.status(409).json({ error: 'Somebody else changed this a moment ago. Refresh and look again.' });

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'request_status_changed',
    entity_type: 'support_ticket', entity_id: ref, metadata: { from: before.status, to },
  });
  res.status(200).json({ ok: true, status: to, status_label: requestStatusLabel(to) });
}

/** A reply to the client, through the outbox like everything else. */
async function requestReply(req, res, who) {
  const ref = String(req.body.ticket_ref ?? '').trim();
  const text = String(req.body.text ?? '').trim();
  if (text.length < 2) return res.status(400).json({ error: 'The message is empty.' });

  const { data: t } = await db().from('support_tickets').select('chat_id, client_id, status').eq('ticket_ref', ref).maybeSingle();
  if (!t?.chat_id) return res.status(404).json({ error: 'We have no chat to reply in.' });

  const queued = await enqueue({
    chatId: t.chat_id,
    clientId: t.client_id ?? null,
    eventType: 'operations_message',
    entityType: 'support_ticket',
    entityId: ref,
    idempotencyKey: `request_reply:${ref}:${hash(text)}:${Date.now().toString(36)}`,
    payload: { text },
  });
  await drain({ limit: 5 }).catch(() => null);

  // Replying and then waiting is the normal shape of this work.
  if (req.body.wait_for_client && canTransitionRequest(t.status, 'waiting_client')) {
    await db().from('support_tickets').update({ status: 'waiting_client' }).eq('ticket_ref', ref);
  }

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'request_reply_sent',
    entity_type: 'support_ticket', entity_id: ref, metadata: { chars: text.length },
  });
  res.status(200).json({ ok: true, queued: queued.ok });
}

/** Resolving hands off to the existing endpoint, which also tells the client. */
async function requestResolve(req, res, who) {
  const ref = String(req.body.ticket_ref ?? '').trim();
  const note = String(req.body.note ?? '').trim();
  if (!note) return res.status(400).json({ error: 'Say what was done - the client is told this.' });

  const proxied = {
    method: 'POST',
    query: { secret: config.adminSecret },
    headers: { 'x-admin-secret': config.adminSecret },
    body: { ticket_ref: ref, action: 'resolve', note, operator: who.name },
  };
  return ticketsApi(proxied, res);
}

// ---------------------------------------------------------------------------
// Shipments
// ---------------------------------------------------------------------------

async function shipmentQueue(req, res) {
  const filter = String(req.query.filter ?? 'active');
  const query = db().from('shipments').select('*').order('updated_at', { ascending: false }).limit(300);
  if (filter === 'delivered') query.eq('delivery_status', 'Complete');
  else if (filter !== 'all') query.neq('delivery_status', 'Complete');

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'We could not load shipments.' });

  res.status(200).json({
    filter,
    total: data.length,
    milestones: SHIPMENT_MILESTONES,
    rows: data,
  });
}

async function shipmentDetail(req, res) {
  const id = String(req.query.id ?? '').trim();
  const { data: shipment, error } = await db().from('shipments').select('*').eq('shipment_id', id).maybeSingle();
  if (error) return res.status(500).json({ error: 'We could not load this shipment.' });
  if (!shipment) return res.status(404).json({ error: `No shipment ${id}` });

  const { data: events } = await db()
    .from('shipment_events')
    .select('*')
    .eq('shipment_id', id)
    .order('event_time', { ascending: false })
    .limit(60);

  res.status(200).json({ shipment, events: events ?? [], milestones: SHIPMENT_MILESTONES });
}

/** Delegated to the shipments endpoint, which writes the event and can notify. */
async function shipmentUpdate(req, res, who) {
  const proxied = {
    method: 'POST',
    query: { secret: config.adminSecret },
    headers: { 'x-admin-secret': config.adminSecret },
    body: { ...req.body, operator: who.name },
  };
  return shipmentsApi(proxied, res);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function search(req, res) {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.status(200).json({ bookings: [], clients: [], shipments: [], mrn: [] });
  const safe = q.replace(/[%_,()]/g, ' ').trim();
  const norm = q.toUpperCase().replace(/[^A-Z0-9]/g, '');

  const [bookings, shipments, clients, mrn] = await Promise.all([
    db().from('booking_queue').select('booking_ref, status, vin, make, customer_name, origin_port, destination_port')
      .or(`booking_ref.ilike.%${safe}%,vin.ilike.%${safe}%,customer_name.ilike.%${safe}%`).limit(15).then((r) => r.data ?? []),
    db().from('shipments').select('shipment_id, booking_ref, status, vin, customer_name, vessel, eta')
      .or(`shipment_id.ilike.%${safe}%,booking_ref.ilike.%${safe}%${norm.length >= 6 ? `,vin_norm.eq.${norm}` : ''}`).limit(15).then((r) => r.data ?? []),
    db().from('clients').select('id, display_name, telegram_username, telegram_user_id, phone, company')
      .or(`display_name.ilike.%${safe}%,telegram_username.ilike.%${safe}%`).limit(15).then((r) => r.data ?? []),
    db().from('mrn_requests').select('request_ref, booking_ref, status, vin, mrn_number')
      .or(`request_ref.ilike.%${safe}%,mrn_number.ilike.%${safe}%`).limit(15).then((r) => r.data ?? []),
  ]);

  res.status(200).json({ bookings, shipments, clients, mrn });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Adds next-action, ageing and SLA to every queue row, server-side. */
async function enrichAll(rows) {
  const cfg = await settings();
  const thresholds = {
    new_request_hours: Number(cfg.sla_new_request_hours) || null,
    review_hours: Number(cfg.sla_review_hours) || null,
  };
  const now = Date.now();

  const byChoice = new Map();
  for (const choice of ['existing', 'mky_issue']) {
    byChoice.set(choice, await requiredDocuments({ mrnChoice: choice }));
  }

  return rows.map((r) => {
    const required = byChoice.get(r.mrn_choice === 'mky_issue' ? 'mky_issue' : 'existing') ?? [];
    // The view gives counts, not types, so readiness is approximated for the
    // LIST only - the detail view and every write recompute it from the rows.
    const summary = {
      required,
      received_types: required.slice(0, r.documents_received ?? 0),
      verified_types: required.slice(0, r.documents_verified ?? 0),
      missing: required.slice(r.documents_received ?? 0),
    };
    const mrn = r.mrn_request_ref ? { request_ref: r.mrn_request_ref, status: r.mrn_status } : null;
    const next = nextAction(r, summary, mrn);

    const since = r.status_changed_at || r.submitted_at || r.created_at;
    const waiting = now - new Date(since).getTime();
    const hours = { pending_review: thresholds.new_request_hours, under_review: thresholds.review_hours }[r.status];
    const overdue = next.owner === 'ops' && hours ? waiting > hours * 3600_000 : false;

    return {
      ...r,
      status_label: statusLabel(r.status),
      next,
      waiting_ms: waiting,
      waiting_since: since,
      overdue,
      priority_rank: { urgent: 0, high: 1, normal: 2 }[r.priority] ?? 2,
      documents_required: required.length,
      client_responded: Boolean(r.client_responded_at
        && (!r.status_changed_at || new Date(r.client_responded_at) >= new Date(r.status_changed_at))),
    };
  });
}

async function documentsFor(booking) {
  const { data } = await db()
    .from('booking_documents')
    .select('id, doc_type, file_name, status, vin, storage_path, mime_type, size_bytes, uploaded_at, verified_at, verified_by, rejection_code, rejection_reason, extraction_ok')
    .eq('booking_ref', booking.booking_ref)
    .is('deleted_at', null)
    .order('uploaded_at', { ascending: false });

  // Signed links, never a public URL: an invoice carries names, addresses and
  // cargo values.
  return Promise.all((data ?? []).map(async (d) => ({
    ...d,
    label: DOC_LABEL[d.doc_type] ?? d.doc_type,
    url: d.storage_path ? await signedUrl(d.storage_path, 60 * 60) : null,
    wrong_vehicle: Boolean(d.vin && booking.vin && normalise(d.vin) !== normalise(booking.vin)),
  })));
}

function documentSummary(docs, required) {
  const live = docs.filter((d) => !['rejected', 'replacement_requested'].includes(d.status));
  const received = new Set(live.map((d) => d.doc_type));
  if (received.has('eur1')) received.add('brief');
  const verified = new Set(live.filter((d) => d.status === 'verified').map((d) => d.doc_type));
  return {
    required,
    received_types: [...received],
    verified_types: [...verified],
    missing: required.filter((t) => !received.has(t)),
  };
}

/** Another live booking on the same chassis. The loudest warning in the UI. */
async function duplicateFor(booking) {
  const norm = normalise(booking.vin);
  if (!norm || norm.length < 6) return null;
  const { data } = await db()
    .from('bookings')
    .select('booking_ref, status, customer_name, origin_port, destination_port, confirmed_at')
    .eq('vin_norm', norm)
    .neq('booking_ref', booking.booking_ref)
    .in('status', ['pending_review', 'under_review', 'needs_client_action', 'confirmed'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

async function closeDocumentTask(bookingRef, operator) {
  if (!bookingRef) return;
  const { data } = await db().from('operations_tasks')
    .select('task_ref').eq('booking_ref', bookingRef).eq('task_type', 'document_review')
    .in('status', ['open', 'in_progress']).limit(1).maybeSingle();
  if (data) await completeTask(data.task_ref, { operator }).catch(() => null);
}

/** Turns an audit row into a sentence an operator reads without decoding it. */
function describeActivity(row) {
  const who = row.actor_type === 'operator' ? row.actor_id : row.actor_type === 'client' ? 'The client' : 'The system';
  const what = {
    booking_draft_created: 'started a booking request',
    booking_request_submitted: 'sent the request to Operations',
    booking_assigned: `assigned it to ${row.metadata?.to ?? 'somebody'}`,
    booking_unassigned: 'removed the owner',
    booking_status_changed: `moved it to ${statusLabel(row.metadata?.to)}`,
    booking_priority_changed: `set priority to ${row.metadata?.priority ?? ''}`,
    document_received: `sent a ${DOC_LABEL[row.metadata?.doc_type] ?? 'document'}`,
    document_verified: `verified the ${DOC_LABEL[row.metadata?.doc_type] ?? 'document'}`,
    document_rejected: `asked for a replacement ${DOC_LABEL[row.metadata?.doc_type] ?? 'document'}`,
    client_information_requested: 'asked the client for more information',
    client_message_sent: 'sent the client a message',
    booking_reference_recorded: `recorded booking reference ${row.metadata?.reference ?? ''}`,
    booking_confirmed: 'confirmed the booking',
    booking_rejected: 'rejected the request',
    booking_cancelled: 'cancelled the request',
    mrn_request_created: 'opened an MRN application',
    mrn_issue: `recorded the MRN`,
    support_ticket_created: 'opened a support ticket',
    operations_task_created: 'raised a task',
    notification_sent: 'the client was notified',
    duplicate_booking_detected: 'hit the duplicate-chassis guard',
  }[row.action] ?? String(row.action).replace(/_/g, ' ');

  return { at: row.created_at, who, what, entity: row.entity_id, action: row.action };
}

const normalise = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const isToday = (ts) => ts && new Date(ts).toDateString() === new Date().toDateString();
const hash = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
};
