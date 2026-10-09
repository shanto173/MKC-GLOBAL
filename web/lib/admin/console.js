/**
 * The MKY Desk's API.
 *
 *   GET  ?resource=console&view=me            who is signed in, and what they may do
 *   GET  ?resource=console&view=inbox         everything that needs a person
 *   GET  ?resource=console&view=counts        the numbers on the sidebar and tab title
 *   GET  ?resource=console&view=case&type=booking|request|mrn&ref=…
 *   GET  ?resource=console&view=document_url&id=…
 *   GET  ?resource=console&view=preview&kind=…   the exact customer message, before sending
 *   GET  ?resource=console&view=chats / chat&channel=&chat_id=
 *   GET  ?resource=console&view=shipments / shipment&id=
 *   GET  ?resource=console&view=search&q=…
 *   GET  ?resource=console&view=settings      (administrators)
 *   GET  ?resource=console&view=pulse         what changed: one cheap read (lib/admin/desk-live.js)
 *   POST ?resource=console   { action, operator, version?, action_key?, … }
 *
 * The GET views the desk polls carry an ETag and answer 304 Not Modified when
 * the desk already has the answer (lib/admin/desk-live.js).
 *
 * One route rather than twenty, because Vercel's Hobby plan allows twelve
 * Serverless Functions and this project is at exactly twelve.
 *
 * THREE RULES RUN THROUGH ALL OF IT.
 *
 * What is TRUE is decided here, from rows. The browser has the same workflow
 * module and uses it to decide what to DRAW, but every action re-derives the
 * answer before it writes. A desk that trusted the browser's readiness would
 * confirm a booking whose documents were sent back in another tab a minute ago.
 *
 * An action carries the version of the record the operator was looking at,
 * and is refused - with who changed it and when - if the record has moved on.
 *
 * Confirming, rejecting, resolving a ticket, recording an MRN and moving a
 * shipment are NOT reimplemented here. They exist, guarded, in api/admin/* and
 * lib/admin/mrn.js; this calls them. Two implementations of "confirm a
 * booking" is precisely the second source of truth that turns into two
 * different answers on a Friday afternoon.
 */

import { config } from '../config.js';
import { db } from '../supabase.js';
import { audit } from '../audit.js';
import { enqueue, drain } from '../outbox.js';
import { customerReached } from '../notify.js';
import { createTask, completeTask, closeTasksForTicket } from '../operations.js';
import { requiredDocuments } from '../settings.js';
import { openMrnRequest } from '../mrn.js';
import decideBooking from '../../api/admin/bookings.js';
import ticketsApi from '../../api/admin/tickets.js';
import shipmentsApi from '../../api/admin/shipments.js';
import mrnApi from './mrn.js';
import {
  readiness, canTransition, statusLabel, statusWords, canTransitionRequest, requestStatusLabel,
  requestStatusWords, SHIPMENT_MILESTONES, OPEN_STATUSES, DOC_LABEL,
} from '../ops/workflow.js';
import {
  operatorFor, deniedReason, ROLE_WORDS, documentSummary, hash, refuseStale, ticketVersion, mrnVersion,
  shipmentVersion, actionKeyOf, customerFor, teamList, hasMessageLog,
} from './desk-shared.js';
import { inboxView, countsView } from './desk-inbox.js';
import {
  bookingCase, requestCase, mrnCase, documentUrl, documentView, previewView, editDetails, markReadValues, loadBooking, bookingEntities,
} from './desk-case.js';
import {
  chatsView, chatView, sendMessage, sendReopenTemplate, retryMessage, retryOutbox, dismissProblem,
  sendToCustomer, savedReplies,
} from './desk-chat.js';
import { settingsView, settingsWrite, userSave, bootstrapAdmin } from './desk-settings.js';
import { replacementRequest, shipmentUpdateText, shipmentUpdatePayload } from './desk-messages.js';
import { channels } from './channels-bridge.js';
import { channelOf } from '../channels.js';
import { pulseView, conditionalView } from './desk-live.js';
import { shipmentList, shipmentDetail } from './desk-shipments.js';
import { search } from './desk-search.js';

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Views that need to know who is asking: what they may do changes what is drawn. */
const VIEWS = {
  inbox: inboxView,
  counts: countsView,
  case: (req, res, who) => ({ booking: bookingCase, request: requestCase, mrn: mrnCase }[req.query.type] ?? badCase)(req, res, who),
  document_url: documentUrl,
  document: documentView,
  preview: previewView,
  chats: chatsView,
  chat: chatView,
  shipments: shipmentList,
  shipment: shipmentDetail,
  search,
  settings: settingsView,
};

const badCase = (req, res) => res.status(400).json({ error: 'type must be booking, request or mrn' });

export default async function handler(req, res) {
  const secret = req.query.secret ?? req.headers['x-admin-secret'];
  if (!config.adminSecret) {
    // Said plainly, because the person reading it is setting the desk up.
    return res.status(503).json({ error: 'The desk is not configured: ADMIN_SECRET is not set on the server.', setup: 'ADMIN_SECRET' });
  }
  if (secret !== config.adminSecret) return res.status(401).json({ error: 'Unauthorized' });

  try {
    if (req.method === 'GET') {
      const view = String(req.query.view ?? 'inbox');
      if (view === 'me') return await me(req, res);
      const fn = view === 'pulse' ? pulseView : VIEWS[view];
      if (!fn) return res.status(400).json({ error: `Unknown view "${view}"` });
      const who = await operatorFor(req);
      if (!who.ok) return res.status(403).json({ error: who.error });
      if (view === 'settings' && !who.can('settings')) return res.status(403).json({ error: deniedReason('settings', who.role) });
      // The views the desk polls answer 304 when nothing they show has
      // changed since the version the desk already has (lib/admin/desk-live.js).
      return await conditionalView(view, req, res, who, (out) => fn(req, out, who));
    }
    if (req.method === 'POST') return await act(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    // A server with no database settings is a setup problem, not a crash:
    // the desk shows a page naming what is missing.
    if (/Supabase is not configured/.test(String(err?.message))) {
      return res.status(503).json({
        error: 'The desk is not configured: the database settings are not set on the server.',
        setup: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
      });
    }
    // Never the raw Postgres error. An operator can do nothing with
    // "PGRST116"; the reference is what they quote when they call us.
    const ref = `ERR-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    console.error(`console error ${ref}:`, err);
    return res.status(500).json({ error: 'Something went wrong on our side.', ref });
  }
}

/**
 * GET view=me - who is signed in.
 *
 * The one view that answers an unknown name with something other than a
 * refusal: when nobody at all is on the team yet, it says so, and the desk
 * offers to make this person the first administrator.
 */
async function me(req, res) {
  const who = await operatorFor(req);
  if (!who.ok) {
    if (who.unknown) {
      // Fresh: the first person on an empty desk must not wait out a cache.
      const data = await teamList({ fresh: true }).catch(() => []);
      if (!(data ?? []).some((u) => u.active !== false)) return res.status(200).json({ bootstrap: true });
    }
    return res.status(403).json({ error: who.error });
  }

  // Best effort: "last seen" is a courtesy for the team list, never a blocker.
  await db().from('ops_users').update({ last_seen: new Date().toISOString() }).eq('name', who.name)
    .then(() => null, () => null);

  const chan = await channels();
  const [logged, team] = await Promise.all([hasMessageLog(), teamList().catch(() => [])]);
  return res.status(200).json({
    name: who.name,
    role: who.role,
    role_words: ROLE_WORDS[who.role] ?? who.role,
    permissions: who.permissions,
    features: { channels: Boolean(chan), chat_messages: logged },
    saved_replies: await savedReplies(),
    // Who work can be handed to. Names only: roles are the administrator's business.
    team: [...(team ?? [])].sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .filter((u) => u.active !== false && u.role !== 'read_only').map((u) => u.name),
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** The permission each action needs. Checked before anything is read. */
const NEEDS = {
  take: 'assign_self', assign: 'assign_self', unassign: 'assign_self', priority: 'priority',
  start_review: 'status', status: 'status',
  request_info: 'client', verify_document: 'documents', reject_document: 'documents', mark_document_read_values: 'documents',
  internal_note: 'notes',
  message_client: 'chat', send_message: 'chat', send_reopen_template: 'chat', request_reply: 'chat',
  retry_message: 'problems', retry_outbox: 'problems', dismiss_problem: 'problems',
  create_booking: 'booking', confirm: 'booking', reject: 'booking', cancel: 'booking', edit_details: 'booking',
  issue_mrn: 'mrn', mrn_need_info: 'mrn', mrn_review: 'mrn', mrn_reject: 'mrn',
  request_assign: 'assign_self', request_status: 'status', request_resolve: 'client',
  shipment_update: 'booking',
  settings_write: 'settings', user_save: 'users',
};

/** Actions where the version the operator saw is checked before anything is written. */
const VERSIONED = new Set([
  'take', 'assign', 'unassign', 'priority', 'start_review', 'status', 'request_info',
  'verify_document', 'reject_document', 'mark_document_read_values', 'create_booking', 'confirm', 'reject', 'cancel',
  'edit_details', 'issue_mrn', 'mrn_need_info', 'mrn_review', 'mrn_reject',
  'request_assign', 'request_status', 'request_resolve', 'shipment_update',
]);

async function act(req, res) {
  const action = String(req.body?.action ?? '');
  if (!action) return res.status(400).json({ error: 'action is required' });
  if (action === 'bootstrap_admin') return bootstrapAdmin(req, res);

  const who = await operatorFor(req);
  if (!who.ok) return res.status(403).json({ error: who.error });

  const needs = NEEDS[action];
  if (!needs) return res.status(400).json({ error: `Unknown action "${action}"` });
  if (!who.can(needs)) return res.status(403).json({ error: deniedReason(needs, who.role) });

  const ctx = {};
  if (VERSIONED.has(action)) {
    const refused = await checkVersion(req, res, ctx);
    if (refused) return refused;
  }

  switch (action) {
    case 'take': return take(req, res, who, ctx);
    case 'assign': return assign(req, res, who);
    case 'unassign': return assign(req, res, who, { clear: true });
    case 'priority': return setPriority(req, res, who);
    case 'start_review': return setStatus(req, res, who, 'under_review');
    case 'status': return setStatus(req, res, who, String(req.body.status ?? ''));
    case 'internal_note': return addNote(req, res, who);
    case 'verify_document': return reviewDocument(req, res, who, true, ctx);
    case 'reject_document': return reviewDocument(req, res, who, false, ctx);
    case 'mark_document_read_values': return markReadValues(req, res, who, ctx.doc);
    case 'request_info': return requestInfo(req, res, who);
    case 'message_client':
    case 'send_message': return sendMessage(req, res, who);
    case 'send_reopen_template': return sendReopenTemplate(req, res, who);
    case 'retry_message': return retryMessage(req, res, who);
    case 'retry_outbox': return retryOutbox(req, res, who);
    case 'dismiss_problem': return dismissProblem(req, res, who);
    case 'create_booking': return createBookingRecord(req, res, who);
    case 'edit_details': return editDetails(req, res, who, ctx.state);
    // Confirm, reject and cancel go through the existing guarded path.
    case 'confirm': return delegate(req, res, who, 'confirm');
    case 'reject': return delegate(req, res, who, 'reject');
    case 'cancel': return delegate(req, res, who, 'cancel');
    case 'issue_mrn': return mrnAction(req, res, who, 'issue');
    case 'mrn_need_info': return mrnAction(req, res, who, 'need_info');
    case 'mrn_review': return mrnAction(req, res, who, 'review');
    case 'mrn_reject': return mrnAction(req, res, who, 'reject');
    case 'request_assign': return requestAssign(req, res, who);
    case 'request_status': return requestStatus(req, res, who);
    case 'request_reply': return requestReply(req, res, who);
    case 'request_resolve': return requestResolve(req, res, who);
    case 'shipment_update': return shipmentUpdate(req, res, who);
    case 'settings_write': return settingsWrite(req, res, who);
    case 'user_save': return userSave(req, res, who);
    default: return res.status(400).json({ error: `Unknown action "${action}"` });
  }
}

/**
 * Refuses an action on a record that changed after the operator loaded it.
 *
 * Only when a version is sent: scripts and older callers that send none keep
 * working, and are protected by the conditional updates beneath (status in the
 * WHERE clause) as before. The desk always sends one.
 */
async function checkVersion(req, res, ctx) {
  const b = req.body ?? {};
  const seen = b.version ? String(b.version) : null;

  // A document action is an action on its booking.
  if (b.document_id != null) {
    const { data: doc } = await db().from('booking_documents').select('*').eq('id', Number(b.document_id)).maybeSingle();
    if (!doc) return res.status(404).json({ error: 'That document is no longer here.' });
    ctx.doc = doc;
    if (doc.booking_ref && !b.booking_ref) b.booking_ref = doc.booking_ref;
  }

  if (b.booking_ref) {
    const state = await loadBooking(String(b.booking_ref));
    if (!state) return res.status(404).json({ error: `There is no booking ${b.booking_ref}.` });
    ctx.state = state;
    if (seen && seen !== state.version) return refuseStale(res, { entityIds: bookingEntities(state), current: state.version });
    return null;
  }
  if (b.ticket_ref) {
    const { data: t } = await db().from('support_tickets').select('*').eq('ticket_ref', String(b.ticket_ref)).maybeSingle();
    if (!t) return res.status(404).json({ error: `There is no request ${b.ticket_ref}.` });
    ctx.ticket = t;
    const current = ticketVersion(t);
    if (seen && seen !== current) return refuseStale(res, { entityIds: [t.ticket_ref], current });
    return null;
  }
  if (b.request_ref) {
    const { data: m } = await db().from('mrn_requests').select('*').eq('request_ref', String(b.request_ref)).maybeSingle();
    if (!m) return res.status(404).json({ error: `There is no MRN application ${b.request_ref}.` });
    ctx.mrn = m;
    const current = mrnVersion(m);
    if (seen && seen !== current) return refuseStale(res, { entityIds: [m.request_ref, m.booking_ref], current });
    return null;
  }
  if (b.shipment_id) {
    const { data: s } = await db().from('shipments').select('*').eq('shipment_id', String(b.shipment_id)).maybeSingle();
    if (!s) return res.status(404).json({ error: `There is no shipment ${b.shipment_id}.` });
    ctx.shipment = s;
    const current = shipmentVersion(s);
    if (seen && seen !== current) return refuseStale(res, { entityIds: [s.shipment_id, s.booking_ref], current });
    return null;
  }
  return null;
}

/**
 * Taking a case: it becomes yours, and a new request becomes "being checked".
 * Taking it FROM a colleague is reassigning, which is a supervisor's call.
 */
async function take(req, res, who, ctx) {
  if (req.body.ticket_ref) {
    const t = ctx.ticket;
    if (t.assigned_to && t.assigned_to.toLowerCase() !== who.name.toLowerCase() && !who.can('assign_others')) {
      return res.status(403).json({ error: `${t.assigned_to} has this. Only a supervisor can take it from them.` });
    }
    req.body.assignee = who.name;
    return requestAssign(req, res, who);
  }
  const booking = ctx.state?.booking;
  if (!booking) return res.status(400).json({ error: 'booking_ref or ticket_ref is required' });
  if (booking.assigned_to && booking.assigned_to.toLowerCase() !== who.name.toLowerCase() && !who.can('assign_others')) {
    return res.status(403).json({ error: `${booking.assigned_to} has this. Only a supervisor can take it from them.` });
  }

  const patch = { assigned_to: who.name, assigned_at: new Date().toISOString(), assigned_by: who.name };
  const moving = booking.status === 'pending_review';
  if (moving) Object.assign(patch, { status: 'under_review', review_started_at: new Date().toISOString(), review_started_by: who.name });

  const { data, error } = await db().from('bookings').update(patch)
    .eq('booking_ref', booking.booking_ref).eq('status', booking.status).select('booking_ref');
  if (error) return res.status(500).json({ error: 'We could not give this to you.' });
  if (!data?.length) return refuseStale(res, { entityIds: bookingEntities(ctx.state), current: null });

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'booking_assigned',
    entity_type: 'booking', entity_id: booking.booking_ref, metadata: { from: booking.assigned_to ?? null, to: who.name },
  });
  if (moving) {
    await audit({
      actor_type: 'operator', actor_id: who.name, action: 'booking_status_changed',
      entity_type: 'booking', entity_id: booking.booking_ref, metadata: { from: booking.status, to: 'under_review' },
    });
  }
  return res.status(200).json({ ok: true, assigned_to: who.name, status: moving ? 'under_review' : booking.status });
}

/** Ownership. Taking work is an agent's right; giving it away is a supervisor's. */
async function assign(req, res, who, { clear = false } = {}) {
  const ref = String(req.body.booking_ref ?? '').trim();
  const to = clear ? null : String(req.body.assignee ?? who.name).trim();

  if (!clear && to.toLowerCase() !== who.name.toLowerCase() && !who.can('assign_others')) {
    return res.status(403).json({ error: deniedReason('assign_others', who.role) });
  }
  if (!clear) {
    const people = (await teamList().catch(() => [])).filter((u) => String(u.name ?? '').toLowerCase() === to.toLowerCase());
    const person = people.length === 1 ? people[0] : null;
    if (!person || person.active === false) return res.status(400).json({ error: `"${to}" is not an active member of the team.` });
  }

  const { data: before } = await db().from('bookings').select('assigned_to, status').eq('booking_ref', ref).maybeSingle();
  if (!before) return res.status(404).json({ error: `There is no booking ${ref}.` });

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
  const { data: booking } = await db().from('bookings').select('status, assigned_to').eq('booking_ref', ref).maybeSingle();
  if (!booking) return res.status(404).json({ error: `There is no booking ${ref}.` });

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

/**
 * An internal note, on a booking or a request. It has no path to a customer,
 * by construction: the notifier reads the outbox, and nothing here writes one.
 */
async function addNote(req, res, who) {
  const body = String(req.body.body ?? '').trim();
  if (body.length < 2) return res.status(400).json({ error: 'The note is empty.' });
  if (body.length > 4000) return res.status(400).json({ error: 'Keep a note under 4000 characters.' });

  const ref = String(req.body.booking_ref ?? '').trim();
  const ticket = String(req.body.ticket_ref ?? '').trim();
  const mrnRef = String(req.body.request_ref ?? '').trim();
  const row = ref ? { booking_ref: ref, entity_type: 'booking', entity_id: ref }
    : ticket ? { booking_ref: null, entity_type: 'support_ticket', entity_id: ticket }
      : mrnRef ? { booking_ref: null, entity_type: 'mrn_request', entity_id: mrnRef } : null;
  if (!row) return res.status(400).json({ error: 'Say which case the note is for.' });

  const { data, error } = await db()
    .from('internal_notes')
    .insert({ ...row, author: who.name, body })
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'We could not save the note.' });

  res.status(200).json({ ok: true, note: { id: data.id, author: data.author, body: data.body, at: data.created_at } });
}

/**
 * Verify or reject one document.
 *
 * Rejecting asks the customer for a replacement, which means the request is
 * now waiting on them - so the status moves too. Verifying is silent: it
 * changes nothing the customer needs to hear about.
 */
async function reviewDocument(req, res, who, verify, ctx) {
  const doc = ctx.doc;
  if (!doc) return res.status(400).json({ error: 'document_id is required' });
  const id = doc.id;

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
  const note = String(req.body.reason ?? '').trim().slice(0, 300);
  const { data: booking } = doc.booking_ref
    ? await db().from('bookings').select('client_id, chat_id, channel, customer_name, vin')
      .eq('booking_ref', doc.booking_ref).maybeSingle()
    : { data: null };

  // A paper the customer has already put right is not asked for again. In the
  // live test the wrong-chassis invoice was sent back after the right one had
  // been checked, and the customer was asked for "A new Invoice" they had
  // already sent, with the booking put back on them. The wrong one is set
  // aside instead - kept, as the record of what was sent - and the desk is
  // told why nobody was asked. `ask_anyway` asks regardless.
  const replacement = req.body.ask_anyway === true ? null : await putRight(doc, booking);
  if (replacement) {
    const { error } = await db().from('booking_documents').update({
      status: 'rejected',
      rejection_code: code,
      rejection_reason: note || null,
      reviewed_at: new Date().toISOString(),
      verified_by: who.name,
    }).eq('id', id);
    if (error) return res.status(500).json({ error: 'We could not save that.' });
    await audit({
      actor_type: 'operator', actor_id: who.name, action: 'document_set_aside',
      entity_type: 'booking_document', entity_id: String(id),
      metadata: { doc_type: doc.doc_type, booking_ref: doc.booking_ref, reason_code: code, replaced_by: replacement.id },
    });
    const label = DOC_LABEL[doc.doc_type] ?? 'document';
    const state = replacement.status === 'verified' ? 'checked' : 'for this chassis, not checked yet';
    return res.status(200).json({
      ok: true,
      status: 'rejected',
      set_aside: true,
      replaced_by: { id: replacement.id, doc_type: replacement.doc_type, status: replacement.status },
      customer_told: {
        reached: 'not_asked',
        warn: false,
        words: `Set aside. The customer already sent a correct ${label} (${state}), so they were not asked for another.`,
      },
    });
  }

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
  let told = { reached: 'none', warn: true, words: 'This document is on no booking, so there was no customer to ask. Contact them directly.' };
  if (doc.booking_ref) {
    await db().from('bookings').update({ status: 'needs_client_action' })
      .eq('booking_ref', doc.booking_ref)
      .in('status', ['pending_review', 'under_review']);

    const channel = booking?.channel ?? channelOf(booking?.chat_id ?? doc.chat_id);
    const customer = await customerFor({ clientId: booking?.client_id, channel, chatId: booking?.chat_id ?? doc.chat_id });
    const idempotencyKey = `doc_replacement:${id}:${code}`;
    const queued = await enqueue({
      chatId: booking?.chat_id ?? doc.chat_id,
      clientId: booking?.client_id ?? null,
      channel,
      // Its own event, so on WhatsApp outside the 24 hours the template that
      // carries it says "send a new document", not "we need information".
      eventType: 'document_rejected',
      entityType: 'booking',
      entityId: doc.booking_ref,
      language: customer.language,
      idempotencyKey,
      payload: { booking_ref: doc.booking_ref, ...replacementRequest(doc.doc_type, code, note) },
    });
    await drain({ limit: 5 }).catch(() => null);
    // Told or not, in the same words every other action that messages the
    // customer uses, so the desk can say so. This answered only "queued".
    const reached = await customerReached({ chat: queued.ok, channel, key: idempotencyKey });
    told = { queued: queued.ok, duplicate: queued.ok && !queued.queued, ...reached };
  }

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'document_rejected',
    entity_type: 'booking_document', entity_id: String(id),
    metadata: { doc_type: doc.doc_type, booking_ref: doc.booking_ref, reason_code: code },
  });

  res.status(200).json({ ok: true, status: 'replacement_requested', customer_told: told });
}

/**
 * Ask the customer for something, in their own language, through the outbox.
 *
 * The idempotency key is the text - so a double click sends one message - plus
 * the desk's action key when there is one, so a deliberate reminder tomorrow,
 * with the same words, is a second message rather than a silent no-op.
 */
async function requestInfo(req, res, who) {
  const ref = String(req.body.booking_ref ?? '').trim();
  const requested = String(req.body.requested ?? '').trim().slice(0, 1000);
  if (!requested) return res.status(400).json({ error: 'Say what the customer must send.' });

  const { data: booking } = await db().from('bookings').select('chat_id, client_id, status, channel').eq('booking_ref', ref).maybeSingle();
  if (!booking) return res.status(404).json({ error: `There is no booking ${ref}.` });
  if (!OPEN_STATUSES.includes(booking.status)) {
    return res.status(409).json({ error: `This request is ${statusWords(booking.status).toLowerCase()}; nothing more can be asked for it.` });
  }

  await db().from('bookings').update({
    status: 'needs_client_action',
    needs_client_action: { requested, at: new Date().toISOString(), by: who.name },
  }).eq('booking_ref', ref).in('status', ['pending_review', 'under_review', 'needs_client_action']);

  const key = actionKeyOf(req.body);
  const customer = await customerFor({ clientId: booking.client_id, channel: booking.channel ?? channelOf(booking.chat_id), chatId: booking.chat_id });
  const idempotencyKey = `request_info:${ref}:${hash(requested)}${key ? `:${key}` : ''}`;
  const queued = await enqueue({
    chatId: booking.chat_id,
    clientId: booking.client_id ?? null,
    channel: booking.channel ?? channelOf(booking.chat_id),
    eventType: 'missing_information_requested',
    entityType: 'booking',
    entityId: ref,
    language: customer.language,
    idempotencyKey,
    payload: { booking_ref: ref, requested },
  });
  await drain({ limit: 5 }).catch(() => null);

  if (queued.queued) {
    await audit({
      actor_type: 'operator', actor_id: who.name, action: 'client_information_requested',
      entity_type: 'booking', entity_id: ref, metadata: { requested },
    });
  }

  // What became of the message, so the desk says "sent", "waiting for them to
  // write" or "not delivered" rather than "sent" in every case.
  const told = await customerReached({ chat: queued.ok, channel: booking.channel ?? channelOf(booking.chat_id), key: idempotencyKey });
  res.status(200).json({
    ok: true, queued: queued.ok, duplicate: queued.ok && !queued.queued, status: 'needs_client_action', customer_told: told,
  });
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
  if (!booking) return res.status(404).json({ error: `There is no booking ${ref}.` });

  // Readiness is recomputed here from rows, never taken from the browser.
  const { data: docs } = await db().from('booking_documents').select('*').eq('booking_ref', ref).is('deleted_at', null);
  const summary = documentSummary(docs ?? [], await requiredDocuments({ mrnChoice: booking.mrn_choice ?? 'existing' }));
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

  // 'booking_confirmation', the type operations_tasks_type_check allows: the
  // 'confirm_booking' this wrote was refused by the database every time, and
  // createTask reports a refusal rather than throwing, so nobody noticed. The
  // channel comes from the booking - the task used to say Telegram whatever
  // the customer was on.
  await createTask({
    taskType: 'booking_confirmation', bookingRef: ref, chatId: booking.chat_id,
    channel: booking.channel ?? channelOf(booking.chat_id, null),
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
  if (action === 'reject' && !String(req.body.note ?? '').trim()) {
    return res.status(400).json({ error: 'Say why — the customer is told the reason.' });
  }
  const proxied = {
    ...req,
    method: 'POST',
    query: { ...req.query, secret: config.adminSecret },
    headers: { ...req.headers, 'x-admin-secret': config.adminSecret },
    body: { ...req.body, action, operator: who.name },
  };
  return decideBooking(proxied, res);
}

/**
 * MRN actions, handed to lib/admin/mrn.js.
 *
 * Recording an MRN for a booking that has no application yet opens one first
 * (lib/mrn.js), so "Record the MRN" on a booking works whether or not the bot
 * got as far as opening the application.
 */
async function mrnAction(req, res, who, action) {
  let requestRef = String(req.body.request_ref ?? '').trim();
  if (!requestRef && req.body.booking_ref) {
    const ref = String(req.body.booking_ref);
    const { data: m } = await db().from('mrn_requests').select('request_ref, status').eq('booking_ref', ref)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (m && !['issued', 'rejected', 'cancelled'].includes(m.status)) {
      requestRef = m.request_ref;
    } else {
      const { data: b } = await db().from('bookings').select('booking_ref, client_id, chat_id, vin').eq('booking_ref', ref).maybeSingle();
      if (!b) return res.status(404).json({ error: `There is no booking ${ref}.` });
      const opened = await openMrnRequest({ bookingRef: b.booking_ref, clientId: b.client_id ?? null, chatId: b.chat_id, vin: b.vin });
      if (!opened.ok) return res.status(500).json({ error: 'We could not open the MRN application.' });
      requestRef = opened.request.request_ref;
    }
  }
  if (!requestRef) return res.status(400).json({ error: 'Say which MRN application.' });
  if (action === 'issue' && !String(req.body.mrn_number ?? '').trim()) {
    return res.status(400).json({ error: 'Type the MRN exactly as it was issued.' });
  }

  const proxied = {
    method: 'POST',
    query: { secret: config.adminSecret },
    headers: { 'x-admin-secret': config.adminSecret },
    body: {
      request_ref: requestRef, action, operator: who.name,
      mrn_number: req.body.mrn_number, requested: req.body.requested, note: req.body.note,
    },
  };
  return mrnApi(proxied, res);
}

/**
 * Another paper of the same kind on this booking that has put this one right:
 * checked by the desk, or carrying the booking's own chassis. Brief and EUR.1
 * count as one kind, as they do for the requirement (lib/documents.js).
 *
 * @returns {Promise<object|null>} that document, or null
 */
async function putRight(doc, booking) {
  if (!doc.booking_ref) return null;
  const { data: others } = await db().from('booking_documents')
    .select('id, doc_type, status, vin, uploaded_at').eq('booking_ref', doc.booking_ref).is('deleted_at', null);
  const kind = (t) => (['brief', 'eur1'].includes(t) ? 'transport' : t);
  const norm = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const chassis = norm(booking?.vin);
  const right = (others ?? []).filter((d) => d.id !== doc.id && kind(d.doc_type) === kind(doc.doc_type)
    && (d.status === 'verified'
      || (['received', 'pending_verification'].includes(d.status) && chassis && norm(d.vin) === chassis)));
  // A checked one first: that is the one the desk has already vouched for.
  return right.find((d) => d.status === 'verified') ?? right[0] ?? null;
}

/** Closes the review task once a document is checked, so the work queue agrees with the record. */
async function closeDocumentTask(bookingRef, operator) {
  if (!bookingRef) return;
  const { data } = await db().from('operations_tasks')
    .select('task_ref').eq('booking_ref', bookingRef).eq('task_type', 'document_review')
    .in('status', ['open', 'in_progress']).limit(1).maybeSingle();
  if (data) await completeTask(data.task_ref, { operator }).catch(() => null);
}

// ---------------------------------------------------------------------------
// Client requests
// ---------------------------------------------------------------------------

async function requestAssign(req, res, who) {
  const ref = String(req.body.ticket_ref ?? '').trim();
  const clear = Boolean(req.body.clear);
  const to = clear ? null : String(req.body.assignee ?? who.name).trim();

  if (!clear && to.toLowerCase() !== who.name.toLowerCase() && !who.can('assign_others')) {
    return res.status(403).json({ error: deniedReason('assign_others', who.role) });
  }

  const { data: before } = await db().from('support_tickets').select('status, assigned_to').eq('ticket_ref', ref).maybeSingle();
  if (!before) return res.status(404).json({ error: `There is no request ${ref}.` });

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

  const { data: before } = await db().from('support_tickets').select('status, ticket_ref, chat_id, created_at').eq('ticket_ref', ref).maybeSingle();
  if (!before) return res.status(404).json({ error: `There is no request ${ref}.` });

  if (!canTransitionRequest(before.status, to)) {
    return res.status(409).json({
      error: `A request that is "${requestStatusLabel(before.status)}" cannot become "${requestStatusLabel(to)}".`,
    });
  }

  const { data, error } = await db().from('support_tickets')
    .update({ status: to }).eq('ticket_ref', ref).eq('status', before.status).select('status');
  if (error) return res.status(500).json({ error: 'We could not change the status.' });
  if (!data?.length) return res.status(409).json({ error: 'Somebody else changed this a moment ago. Refresh and look again.' });

  // Closed without a message is still finished: its task goes with it.
  if (to === 'resolved' || to === 'closed') {
    await closeTasksForTicket(before, { operator: who.name, reason: `The request was ${to}.` });
  }

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'request_status_changed',
    entity_type: 'support_ticket', entity_id: ref, metadata: { from: before.status, to },
  });
  res.status(200).json({ ok: true, status: to, status_words: requestStatusWords(to) });
}

/** A reply to the customer, sent once, and optionally "now waiting for them". */
async function requestReply(req, res, who) {
  const ref = String(req.body.ticket_ref ?? '').trim();
  const { data: t } = await db().from('support_tickets').select('*').eq('ticket_ref', ref).maybeSingle();
  if (!t?.chat_id) return res.status(404).json({ error: 'We have no chat to reply in.' });

  const customer = await customerFor({ clientId: t.client_id, channel: t.channel ?? channelOf(t.chat_id), chatId: t.chat_id, name: t.customer });
  const sent = await sendToCustomer({
    who, channel: t.channel ?? channelOf(t.chat_id), chatId: t.chat_id, clientId: customer.client_id, text: req.body.text,
    actionKey: actionKeyOf(req.body), bookingRef: t.booking_ref ?? null,
    entityType: 'support_ticket', entityId: ref, language: customer.language,
  });
  if (!sent.ok) return res.status(sent.status === 'not_connected' ? 503 : 409).json({ error: sent.words, ...sent });

  // Replying and then waiting is the normal shape of this work.
  if (req.body.wait_for_client && canTransitionRequest(t.status, 'waiting_client')) {
    await db().from('support_tickets').update({ status: 'waiting_client' }).eq('ticket_ref', ref);
  }
  if (!sent.duplicate) {
    await audit({
      actor_type: 'operator', actor_id: who.name, action: 'request_reply_sent',
      entity_type: 'support_ticket', entity_id: ref, metadata: { chars: String(req.body.text ?? '').trim().length },
    });
  }
  res.status(200).json(sent);
}

/** Resolving hands off to the existing endpoint, which also tells the customer. */
async function requestResolve(req, res, who) {
  const ref = String(req.body.ticket_ref ?? '').trim();
  const note = String(req.body.note ?? '').trim();
  if (!note) return res.status(400).json({ error: 'Say what was done — the customer is told this.' });

  const proxied = {
    method: 'POST',
    query: { secret: config.adminSecret },
    headers: { 'x-admin-secret': config.adminSecret },
    body: { ticket_ref: ref, action: 'resolve', note, operator: who.name },
  };
  return ticketsApi(proxied, res);
}

// ---------------------------------------------------------------------------
// Shipments (the list and one shipment are read in desk-shipments.js; the
// search box is desk-search.js)
// ---------------------------------------------------------------------------

/**
 * POST { action: 'shipment_update', shipment_id, version, status?, eta?, vessel?, location?, note?, tell_customer, action_key }
 *
 * The change itself goes through api/admin/shipments.js, which writes the
 * event. Telling the customer is done here, through the same sender as every
 * other desk message, so it reaches WhatsApp customers too and the text is
 * the one the operator was shown.
 */
async function shipmentUpdate(req, res, who) {
  const body = req.body ?? {};
  const tell = body.tell_customer !== false;
  const changes = {};
  for (const k of ['status', 'eta', 'etd', 'vessel', 'location']) if (body[k] !== undefined && body[k] !== '') changes[k] = body[k];
  if (changes.status && !SHIPMENT_MILESTONES.includes(changes.status)) {
    return res.status(400).json({ error: 'Choose the status from the list.' });
  }
  if (changes.eta && !/^\d{4}-\d{2}-\d{2}$/.test(String(changes.eta))) return res.status(400).json({ error: 'The arrival date must be a date.' });

  let result = null;
  const captured = {
    status(code) { this.code = code; return this; },
    json(payload) { result = { code: this.code ?? 200, payload }; return this; },
  };
  await shipmentsApi({
    method: 'POST',
    query: { secret: config.adminSecret },
    headers: { 'x-admin-secret': config.adminSecret },
    body: { shipment_id: body.shipment_id, ...changes, note: String(body.note ?? '').trim(), operator: who.name, tell_customer: false },
  }, captured);
  if (!result || result.code >= 300) return res.status(result?.code ?? 500).json(result?.payload ?? { error: 'The update failed.' });
  if (result.payload.unchanged) return res.status(200).json({ ...result.payload, customer_told: null });

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'shipment_updated',
    entity_type: 'shipment', entity_id: body.shipment_id, metadata: { fields: Object.keys(changes), told: tell },
  });

  let told = null;
  if (tell) {
    const { data: s } = await db().from('shipments').select('*').eq('shipment_id', body.shipment_id).maybeSingle();
    const { data: b } = s?.booking_ref
      ? await db().from('bookings').select('client_id, chat_id, channel').eq('booking_ref', s.booking_ref).maybeSingle()
      : { data: null };
    const channel = s?.channel ?? b?.channel ?? channelOf(s?.chat_id ?? b?.chat_id);
    const chatId = s?.chat_id ?? b?.chat_id ?? null;
    const customer = await customerFor({ clientId: b?.client_id, channel, chatId, name: s?.customer_name });
    const said = { status: changes.status, eta: changes.eta, note: body.note };
    told = await sendToCustomer({
      who, channel, chatId, clientId: customer.client_id,
      text: shipmentUpdateText(s, said, customer.language),
      actionKey: actionKeyOf(body), bookingRef: s?.booking_ref ?? null, entityType: 'shipment', entityId: body.shipment_id,
      language: customer.language, eventType: 'shipment_update', allowTemplate: true,
      templatePayload: shipmentUpdatePayload(s, said, customer.language),
    });
  }
  return res.status(200).json({ ...result.payload, customer_told: told });
}

