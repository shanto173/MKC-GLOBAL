/**
 * The case page: one booking, call-back or MRN application, with the one thing
 * to do next and everything needed to do it.
 *
 * The page's buttons are decided here. Each action comes with `enabled` and,
 * when it is not, the sentence that says why - "Only a supervisor can…",
 * "Not received yet: Brief" - so the desk never offers something the server
 * would refuse, and never refuses without saying what would make it possible.
 *
 * Every view carries a `version`. Actions send it back, and an action on a
 * record that has changed since is refused with who changed it and when
 * (see refuseStale in desk-shared.js).
 */

import { db } from '../supabase.js';
import { signedUrl } from '../storage.js';
import { audit } from '../audit.js';
import { requiredDocuments, settings } from '../settings.js';
import {
  DOC_LABEL, readiness, nextAction, availableActions, statusWords, statusTone, whoseTurn, turnWords, TURN,
  requestNextAction, requestStatusWords, requestStatusTone, requestOwner, REQUEST_TYPE, REQUEST_OPEN,
  MRN_STATUS, MRN_OPEN, mrnStatusWords, OPEN_STATUSES, canTransitionRequest,
} from '../ops/workflow.js';
import {
  bookingVersion, ticketVersion, mrnVersion, shipmentVersion, describeActivity, documentSummary,
  customerFor, deniedReason, unreadable, normalise, DETAIL_FIELDS, refuseStale, ago,
} from './desk-shared.js';
import {
  replacementRequest, renderEvent, shipmentUpdateText, ticketResolvedText, REPLACEMENT_REASONS,
} from './desk-messages.js';
import { composerFor } from './desk-chat.js';
import { listWords, shortPort, bookingSentence } from './desk-inbox.js';

// ---------------------------------------------------------------------------
// Loading a booking case
// ---------------------------------------------------------------------------

/** Everything a booking's version and readiness are computed from, read fresh. */
export async function loadBooking(ref) {
  const { data: booking, error } = await db().from('bookings').select('*').eq('booking_ref', ref).maybeSingle();
  if (error) throw new Error(`booking read: ${error.message}`);
  if (!booking) return null;

  const [{ data: docs }, { data: mrn }] = await Promise.all([
    db().from('booking_documents').select('*').eq('booking_ref', ref).is('deleted_at', null)
      .order('uploaded_at', { ascending: false }),
    db().from('mrn_requests').select('*').eq('booking_ref', ref)
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  const required = await requiredDocuments({ mrnChoice: booking.mrn_choice ?? 'existing' });
  const summary = documentSummary(docs ?? [], required);
  return {
    booking,
    docs: docs ?? [],
    mrn: mrn ?? null,
    required,
    summary,
    version: bookingVersion(booking, docs ?? [], mrn ?? null),
  };
}

/** The records a booking case is made of, for "who changed this". */
export const bookingEntities = (state) => [
  state.booking.booking_ref, ...state.docs.map((d) => d.id), state.mrn?.request_ref,
];

// ---------------------------------------------------------------------------
// Documents, as the viewer shows them
// ---------------------------------------------------------------------------

/** What the bot read, by field, in the order a person checks a paper. */
const READ_FIELDS = [
  ['vin', 'Chassis (VIN)'], ['mrn', 'MRN'], ['acid', 'ACID'], ['eur1', 'EUR.1 number'],
  ['make', 'Make'], ['model', 'Model'], ['vehicle_type', 'Vehicle type'],
  ['seller', 'Seller'], ['buyer', 'Buyer'], ['value', 'Value'], ['incoterm', 'Incoterm'],
  ['origin_place', 'From'], ['destination_place', 'To'], ['document_date', 'Date on the document'],
  ['gross_weight_kg', 'Gross weight (kg)'], ['notes', 'Notes'],
];

/** The fields a person may type in when the bot could not read a file. */
export const TYPABLE = ['vin', 'mrn', 'acid', 'eur1', 'make', 'model', 'document_date'];

/**
 * Which of those matter for each kind of paper - so the form for an unreadable
 * MRN asks for the MRN and the chassis, not for seven boxes most of which do
 * not apply.
 */
const TYPABLE_BY_TYPE = {
  invoice: ['vin', 'make', 'model', 'document_date'],
  brief: ['vin', 'document_date'],
  mrn: ['mrn', 'vin', 'document_date'],
  acid: ['acid', 'vin'],
  eur1: ['eur1', 'vin', 'document_date'],
};
export const typableFor = (docType) => TYPABLE_BY_TYPE[docType] ?? TYPABLE;

const DOC_WORDS = {
  received: ['Received, not checked', 'blue'],
  pending_verification: ['Received, not checked', 'blue'],
  verified: ['Checked', 'green'],
  replacement_requested: ['New copy asked for', 'amber'],
  rejected: ['Rejected', 'red'],
};

/** The same make written two ways ("Mercedes-Benz" / "MERCEDES BENZ") is the same make. */
const sameWords = (a, b) => {
  const x = normalise(a);
  const y = normalise(b);
  return Boolean(x && y) && (x.includes(y) || y.includes(x));
};

/** A value as the desk reads it off a document: what a person typed wins over what the bot read. */
function readValue(d, k) {
  const x = d.extracted ?? {};
  const typed = x.typed ?? {};
  if (typed[k] != null && typed[k] !== '') return typed[k];
  if (k === 'value') return x.value_amount != null ? `${x.value_amount}${x.value_currency ? ` ${x.value_currency}` : ''}` : null;
  if (k === 'vin') return d.vin ?? x.vin ?? null;
  return x[k] ?? null;
}

/**
 * The MRN on the customer's own export declaration - the booking's MRN
 * document, the newest one still standing - or null when there is none.
 */
export function declaredMrn(docs = []) {
  const standing = docs.filter((d) => d.doc_type === 'mrn' && !['replacement_requested', 'rejected'].includes(d.status) && !d.deleted_at);
  for (const d of standing) {
    const mrn = readValue(d, 'mrn');
    if (mrn) return String(mrn);
  }
  return null;
}

/**
 * One document as the viewer shows it.
 *
 * `declared` is the MRN read from the booking's MRN declaration (declaredMrn).
 * It, not the number on the booking, is what OTHER papers' MRNs are held to:
 * the booking's number is whatever the desk typed when it recorded one, and a
 * transport document routinely prints a different MRN - a transit one - so
 * holding every paper to it flagged them all "does not match the booking" the
 * moment an MRN was recorded. The declaration itself is held to the booking's
 * number, which is the comparison that catches a mistyped MRN.
 */
export function documentOut(d, booking, { declared = null } = {}) {
  const x = d.extracted ?? {};
  const typed = x.typed ?? {};
  const value = (k) => readValue(d, k);
  const read = READ_FIELDS
    .map(([field, label]) => ({ field, label, value: value(field), typed: typed[field] != null && typed[field] !== '' }))
    .filter((f) => f.value != null && f.value !== '');

  // Checked against the booking: the comparisons that get a customs entry
  // rejected when they are wrong.
  // A check held to something other than the booking says what, in
  // `against`, for the sentence the viewer writes: "the MRN declaration says…".
  const checks = [];
  const vin = value('vin');
  if (vin && booking?.vin) {
    checks.push({ field: 'vin', label: 'Chassis', document: vin, booking: booking.vin, match: normalise(vin) === normalise(booking.vin) });
  }
  const make = value('make');
  if (make && booking?.make) checks.push({ field: 'make', label: 'Make', document: make, booking: booking.make, match: sameWords(make, booking.make) });
  const mrn = value('mrn');
  if (mrn && d.doc_type === 'mrn' && booking?.mrn_number) {
    checks.push({ field: 'mrn', label: 'MRN', document: mrn, booking: booking.mrn_number, match: normalise(mrn) === normalise(booking.mrn_number) });
  } else if (mrn && d.doc_type !== 'mrn' && declared) {
    checks.push({ field: 'mrn', label: 'MRN', document: mrn, booking: declared, against: 'the MRN declaration', match: normalise(mrn) === normalise(declared) });
  }

  const [words, tone] = DOC_WORDS[d.status] ?? [String(d.status ?? ''), 'gray'];
  return {
    id: d.id,
    doc_type: d.doc_type,
    label: DOC_LABEL[d.doc_type] ?? d.doc_type,
    status: d.status,
    status_words: d.status === 'verified' && d.verified_by ? `Checked by ${d.verified_by}` : words,
    tone,
    file_name: d.file_name ?? null,
    mime_type: d.mime_type ?? null,
    size_bytes: d.size_bytes ?? null,
    uploaded_at: d.uploaded_at,
    verified_by: d.verified_by ?? null,
    verified_at: d.verified_at ?? null,
    rejection_code: d.rejection_code ?? null,
    rejection_reason: d.rejection_reason ?? null,
    has_file: Boolean(d.storage_path),
    reading: x.pending === true,
    unreadable: unreadable(d),
    typable: typableFor(d.doc_type),
    typed_by: x.typed_by ?? null,
    bot_message: x.message ?? null,
    read,
    checks,
    wrong_vehicle: checks.some((c) => c.field === 'vin' && !c.match),
  };
}

/**
 * The required papers, one line each, saying where each stands. Never invents
 * a requirement: an empty list from Settings is shown as empty, with a note.
 */
export function checklistFor(required, docs) {
  const live = docs.filter((d) => !['replacement_requested', 'rejected'].includes(d.status));
  return required.map((type) => {
    const label = DOC_LABEL[type] ?? type;
    const mine = (t) => t === type || (type === 'brief' && t === 'eur1');
    const doc = live.find((d) => mine(d.doc_type));
    const asked = docs.find((d) => mine(d.doc_type) && d.status === 'replacement_requested');
    if (doc?.status === 'verified') {
      return { type, label, state: 'checked', words: `Checked${doc.verified_by ? ` by ${doc.verified_by}` : ''}`, tone: 'green', document_id: doc.id };
    }
    if (doc && doc.wrong_vehicle) return { type, label, state: 'mismatch', words: 'Chassis differs from the booking', tone: 'red', document_id: doc.id };
    if (doc && doc.unreadable) return { type, label, state: 'unreadable', words: 'The bot couldn’t read it — check it by eye', tone: 'red', document_id: doc.id };
    if (doc && doc.reading) return { type, label, state: 'reading', words: 'Arrived, still being read', tone: 'gray', document_id: doc.id };
    if (doc) return { type, label, state: 'received', words: 'Received, not checked', tone: 'blue', document_id: doc.id };
    if (asked) {
      const why = REPLACEMENT_REASONS.find((r) => r.code === asked.rejection_code)?.words?.toLowerCase();
      return { type, label, state: 'replacement', words: `New copy asked for${why ? ` — ${why}` : ''}`, tone: 'amber', document_id: asked.id };
    }
    return { type, label, state: 'missing', words: 'Not received', tone: 'amber', document_id: null };
  });
}

// ---------------------------------------------------------------------------
// Buttons, with reasons
// ---------------------------------------------------------------------------

function button(who, action, label, { allowed = true, why = null, perm = null, kind = 'secondary', ...extra } = {}) {
  if (!allowed) return { action, label, kind, enabled: false, reason: why, ...extra };
  if (perm && !who.can(perm)) return { action, label, kind, enabled: false, reason: deniedReason(perm, who.role), ...extra };
  return { action, label, kind, enabled: true, reason: null, ...extra };
}

const mine = (who, name) => Boolean(name) && name.toLowerCase() === who.name.toLowerCase();

/** The "Next step" card for a booking: what to do, and the one button that does it. */
export function bookingNextStep(who, state, docsOut) {
  const { booking, summary, mrn } = state;
  const ready = readiness(booking, summary, mrn);
  const next = nextAction(booking, summary, mrn);
  const legal = availableActions(booking, ready);
  const open = OPEN_STATUSES.includes(booking.status);
  const missingLabels = ready.items.filter((i) => i.blocking && !i.ok).map((i) => i.label);
  const notReady = missingLabels.length ? `Not ready yet: ${listWords(missingLabels)}.` : null;
  const unchecked = docsOut.filter((d) => ['received', 'pending_verification'].includes(d.status));

  let primary = null;
  switch (next.action) {
    case 'request_info':
    case 'request_documents':
    case 'send_reminder': {
      const missing = summary.missing.map((t) => DOC_LABEL[t] ?? t);
      const label = next.action === 'send_reminder' ? 'Send a reminder'
        : next.action === 'request_documents' ? `Ask for the ${listWords(missing)}` : 'Ask for the missing details';
      const prefill = next.action === 'request_info'
        ? ready.items.filter((i) => i.blocking && !i.ok && !i.key.startsWith('doc:')).map((i) => i.label).join('\n')
        : missing.map((m) => `The ${m}`).join('\n');
      primary = button(who, 'request_info', label, { perm: 'client', kind: 'primary', prefill });
      break;
    }
    case 'review_documents':
      primary = button(who, 'open_document', 'Check the documents', {
        perm: 'documents', kind: 'primary', document_id: unchecked[0]?.id ?? null,
      });
      break;
    case 'process_mrn':
      primary = button(who, 'issue_mrn', 'Record the MRN', { perm: 'mrn', kind: 'primary', request_ref: mrn?.request_ref ?? null });
      break;
    case 'create_booking':
      primary = button(who, 'create_booking', 'Record the booking reference', { perm: 'booking', kind: 'primary', allowed: legal.includes('create_booking'), why: notReady });
      break;
    case 'confirm_booking':
      primary = button(who, 'confirm', 'Confirm booking', { perm: 'booking', kind: 'primary', allowed: legal.includes('confirm_booking'), why: notReady });
      break;
    default:
      primary = null;
  }

  const secondary = [];
  if (open) {
    if (primary?.action !== 'request_info') secondary.push(button(who, 'request_info', 'Ask the customer for something', { perm: 'client' }));
    if (primary?.action !== 'confirm') {
      secondary.push(button(who, 'confirm', unchecked.length ? 'Confirm without checking' : 'Confirm booking', {
        perm: 'booking', allowed: legal.includes('confirm_booking'), why: notReady, more: true,
        warning: unchecked.length ? `${unchecked.length === 1 ? 'One document is' : `${unchecked.length} documents are`} not checked yet.` : null,
      }));
    }
    secondary.push(button(who, 'reject', 'Reject request', { perm: 'booking', kind: 'danger' }));
    secondary.push(button(who, 'cancel', 'Cancel request', { perm: 'booking', kind: 'danger', more: true }));
    secondary.push(button(who, 'priority', 'Change priority', { perm: 'priority', more: true }));
    secondary.push(button(who, 'assign', 'Give to someone else', { perm: 'assign_others', more: true }));
  }

  const confirmed = booking.status === 'confirmed';
  return {
    code: next.code,
    owner: next.owner,
    owner_words: turnWords(next.owner),
    owner_tone: TURN[next.owner]?.tone ?? 'gray',
    title: confirmed ? 'Nothing to do — the booking is confirmed'
      : !open ? `This request was ${statusWords(booking.status).toLowerCase()}`
        : bookingSentence({ ...booking, next, summary }),
    detail: confirmed
      ? `Confirmed${booking.confirmed_by ? ` by ${booking.confirmed_by}` : ''}${booking.confirmed_at ? ` ${ago(booking.confirmed_at)}` : ''}. Shipment updates are on the Shipments page.`
      : next.detail,
    primary,
    secondary,
    readiness: ready,
  };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** GET view=case&type=booking&ref= */
export async function bookingCase(req, res, who) {
  const ref = String(req.query.ref ?? '').trim();
  if (!ref) return res.status(400).json({ error: 'ref is required' });
  const state = await loadBooking(ref);
  if (!state) return res.status(404).json({ error: `There is no booking ${ref}.` });
  const { booking, docs, mrn, required } = state;

  const declared = declaredMrn(docs);
  const docsOut = docs.map((d) => documentOut(d, booking, { declared }));
  const byId = new Map(docsOut.map((d) => [d.id, d]));
  const live = docs.map((d) => ({ ...d, ...byId.get(d.id), status: d.status }));
  const checklist = checklistFor(required, live);
  const requiredSet = new Set(required);
  if (requiredSet.has('brief')) requiredSet.add('eur1');

  const [notesQ, auditQ, outboxQ, dupQ, shipQ] = await Promise.all([
    db().from('internal_notes').select('*').eq('booking_ref', ref).order('created_at', { ascending: false }).limit(50),
    db().from('audit_logs').select('*').in('entity_id', bookingEntities(state).filter(Boolean).map(String))
      .order('created_at', { ascending: false }).limit(80),
    db().from('notification_outbox').select('id, event_type, status, attempt_count, last_error, sent_at, created_at, payload')
      .eq('entity_id', ref).order('created_at', { ascending: false }).limit(30),
    normalise(booking.vin).length >= 6
      ? db().from('bookings').select('booking_ref, status, customer_name, created_at').eq('vin_norm', normalise(booking.vin))
        .neq('booking_ref', ref).in('status', ['pending_review', 'under_review', 'needs_client_action', 'confirmed']).limit(1).maybeSingle()
      : { data: null },
    db().from('shipments').select('shipment_id, status, eta, vessel, updated_at').eq('booking_ref', ref).limit(1).maybeSingle(),
  ]);

  const customer = await customerFor({
    clientId: booking.client_id, channel: booking.channel ?? 'telegram', chatId: booking.chat_id,
    name: booking.customer_name, contact: booking.customer_contact,
  });
  const nextStep = bookingNextStep(who, state, docsOut);
  const open = OPEN_STATUSES.includes(booking.status);

  return res.status(200).json({
    type: 'booking',
    version: state.version,
    header: {
      ref,
      status: booking.status,
      status_words: statusWords(booking.status),
      tone: statusTone(booking.status),
      turn: whoseTurn(booking),
      vehicle: [booking.make, booking.model].filter(Boolean).join(' ') || null,
      vin: booking.vin ?? null,
      route: booking.origin_port || booking.destination_port
        ? `${shortPort(booking.origin_port) || '?'} → ${shortPort(booking.destination_port) || '?'}` : null,
      priority: booking.priority ?? 'normal',
      assigned_to: booking.assigned_to ?? null,
      assigned_to_me: mine(who, booking.assigned_to),
      submitted_at: booking.submitted_at ?? booking.created_at,
    },
    booking: {
      ...Object.fromEntries(DETAIL_FIELDS.map((k) => [k, booking[k] ?? null])),
      booking_ref: booking.booking_ref,
      status: booking.status,
      mrn_choice: booking.mrn_choice ?? null,
      mrn_number: booking.mrn_number ?? null,
      channel: booking.channel ?? 'telegram',
      chat_id: booking.chat_id ?? null,
      confirmed_at: booking.confirmed_at ?? null,
      confirmed_by: booking.confirmed_by ?? null,
      needs_client_action: booking.needs_client_action ?? null,
      editable: open && who.can('booking'),
      edit_reason: !open ? 'A decided booking cannot be corrected here.' : who.can('booking') ? null : deniedReason('booking', who.role),
    },
    customer,
    next_step: nextStep,
    take: takeButton(who, booking.assigned_to, open),
    documents: docsOut,
    checklist,
    required_documents: required,
    required_note: required.length ? null : 'No documents are set as required in Settings, so none are asked for.',
    other_documents: docsOut.filter((d) => !requiredSet.has(d.doc_type)),
    document_actions: {
      verify: button(who, 'verify_document', 'Looks right', { perm: 'documents', allowed: open, why: 'This request is closed.' }),
      reject: button(who, 'reject_document', 'Ask for a new one', { perm: 'documents', allowed: open, why: 'This request is closed.' }),
      type_values: button(who, 'mark_document_read_values', 'Type what it says', { perm: 'documents', allowed: open, why: 'This request is closed.' }),
      reasons: REPLACEMENT_REASONS.map(({ code, words }) => ({ code, words })),
      typable: TYPABLE,
    },
    mrn: booking.mrn_choice === 'mky_issue' ? {
      request_ref: mrn?.request_ref ?? null,
      status: mrn?.status ?? null,
      status_words: mrn ? mrnStatusWords(mrn.status) : 'No application opened yet',
      mrn_number: booking.mrn_number ?? mrn?.mrn_number ?? null,
      supplied: mrn?.supplied_information?.notes ?? [],
      missing: mrn?.missing_information ?? [],
    } : null,
    asked: askedOut(booking.needs_client_action),
    duplicate: dupQ.data ? { ...dupQ.data, status_words: statusWords(dupQ.data.status) } : null,
    shipment: shipQ.data ?? null,
    notes: (notesQ.data ?? []).map((n) => ({ id: n.id, author: n.author, body: n.body, at: n.created_at })),
    note_action: button(who, 'internal_note', 'Save note', { perm: 'notes' }),
    history: (auditQ.data ?? []).map(describeActivity),
    notifications: (outboxQ.data ?? []).filter((n) => n.payload?.via !== 'desk').map((n) => ({
      id: n.id, event_type: n.event_type, status: n.status, at: n.sent_at ?? n.created_at, error: n.last_error ?? null,
    })),
    last_change: (auditQ.data ?? [])[0] ? describeActivity(auditQ.data[0]) : null,
    conversation: { channel: booking.channel ?? 'telegram', chat_id: booking.chat_id ?? null },
  });
}

/**
 * What the desk last asked the customer for, and what they answered
 * (lib/answers.js keeps the answers beside the question). Null when nothing
 * was asked. The papers they sent are named as the desk names them, with the
 * id the viewer opens.
 */
function askedOut(asked) {
  if (!asked || (!asked.requested && !(asked.answers ?? []).length)) return null;
  return {
    requested: asked.requested ?? null,
    at: asked.at ?? null,
    by: asked.by ?? null,
    answers: (asked.answers ?? []).map((a) => ({
      at: a.at ?? null,
      text: a.text ?? null,
      documents: (a.documents ?? []).map((d) => ({
        id: d.id ?? null, file_name: d.file_name ?? null, label: DOC_LABEL[d.doc_type] ?? d.file_name ?? 'A file',
      })),
    })),
  };
}

/** Internal notes on a call-back or an MRN application (bookings read theirs by booking_ref). */
async function notesFor(entityId) {
  const { data } = await db().from('internal_notes').select('*').eq('entity_id', entityId)
    .order('created_at', { ascending: false }).limit(50);
  return (data ?? []).map((n) => ({ id: n.id, author: n.author, body: n.body, at: n.created_at }));
}

/** Taking a case is everyone's right; taking it from a colleague is a supervisor's. */
function takeButton(who, assignedTo, open) {
  if (!open) return null;
  if (mine(who, assignedTo)) return { ...button(who, 'unassign', 'Put back'), state: 'mine', words: 'You have this' };
  if (assignedTo) {
    return { ...button(who, 'take', 'Take it over', { perm: 'assign_others' }), state: 'other', words: `${assignedTo} has this` };
  }
  return { ...button(who, 'take', 'Take it', { perm: 'assign_self' }), state: 'nobody', words: 'Nobody has this yet' };
}

/** GET view=case&type=request&ref= - a call-back or other client request. */
export async function requestCase(req, res, who) {
  const ref = String(req.query.ref ?? '').trim();
  const { data: t, error } = await db().from('client_request_queue').select('*').eq('ticket_ref', ref).maybeSingle();
  if (error) throw new Error(`request read: ${error.message}`);
  if (!t) return res.status(404).json({ error: `There is no request ${ref}.` });

  const next = requestNextAction(t);
  const open = REQUEST_OPEN.includes(t.status);
  const phone = t.contact && !/^(telegram|web|wa|whatsapp):/i.test(t.contact) && /\d{6,}/.test(String(t.contact).replace(/\D/g, '')) ? t.contact : null;

  let primary = null;
  let title = next.label;
  let detail = null;
  const secondary = [];
  if (open && !t.assigned_to) {
    primary = button(who, 'take', 'Take this call-back', { perm: 'assign_self', kind: 'primary' });
    title = 'Nobody has this yet — take it';
    detail = phone ? `Then call ${phone}.` : 'Then reply in the chat.';
  } else if (open && t.status !== 'waiting_client') {
    title = phone ? `Call ${phone}` : 'Reply in the chat';
    detail = phone
      ? 'When you have spoken to them, write what was agreed and mark it resolved. The customer gets your note.'
      : 'They gave no phone number. Write to them in the conversation, then mark it resolved.';
    primary = button(who, 'request_resolve', 'Mark resolved', { perm: 'client', kind: 'primary' });
    secondary.push(button(who, 'request_status', 'Waiting for the customer', {
      perm: 'status', status: 'waiting_client', allowed: canTransitionRequest(t.status, 'waiting_client'),
    }));
  } else if (t.status === 'waiting_client') {
    title = 'Waiting for the customer to come back';
    detail = 'It comes back to the inbox when they write.';
    secondary.push(button(who, 'request_status', 'Back to in progress', { perm: 'status', status: 'in_progress' }));
    secondary.push(button(who, 'request_resolve', 'Mark resolved', { perm: 'client' }));
  } else if (t.status === 'resolved') {
    title = `Resolved${t.resolved_by ? ` by ${t.resolved_by}` : ''}`;
    detail = t.resolution_note ? `They were told: “${t.resolution_note}”` : null;
    secondary.push(button(who, 'request_status', 'Reopen', { perm: 'status', status: 'in_progress' }));
  } else {
    title = 'Closed';
  }
  if (open) {
    secondary.push(button(who, 'request_status', 'Close without a message', {
      perm: 'status', status: 'closed', kind: 'danger', more: true,
    }));
    if (t.assigned_to) secondary.push(button(who, 'request_assign', 'Give to someone else', { perm: 'assign_others', more: true }));
  }

  const [auditQ, bookingsQ, notes] = await Promise.all([
    db().from('audit_logs').select('*').eq('entity_id', ref).order('created_at', { ascending: false }).limit(40),
    t.chat_id
      ? db().from('bookings').select('booking_ref, status, vin, make, created_at').eq('chat_id', String(t.chat_id))
        .neq('status', 'draft').order('created_at', { ascending: false }).limit(5)
      : { data: [] },
    notesFor(ref),
  ]);
  const customer = await customerFor({
    clientId: t.client_id, channel: t.channel ?? 'telegram', chatId: t.chat_id, name: t.customer || t.client_display_name, contact: phone,
  });
  const type = REQUEST_TYPE[t.request_type] ?? REQUEST_TYPE.other;

  return res.status(200).json({
    type: 'request',
    version: ticketVersion(t),
    header: {
      ref,
      title: type.label,
      status: t.status,
      status_words: requestStatusWords(t.status),
      tone: requestStatusTone(t.status),
      turn: requestOwner(t.status),
      priority: t.priority ?? 'normal',
      assigned_to: t.assigned_to ?? null,
      assigned_to_me: mine(who, t.assigned_to),
      submitted_at: t.created_at,
    },
    request: {
      ticket_ref: t.ticket_ref, department: t.department, summary: t.summary ?? '', contact: phone,
      booking_ref: t.booking_ref ?? null, created_at: t.created_at, resolution_note: t.resolution_note ?? null,
    },
    customer,
    next_step: {
      owner: next.owner, owner_words: turnWords(next.owner), owner_tone: TURN[next.owner]?.tone ?? 'gray',
      title, detail, primary, secondary,
    },
    take: open && t.assigned_to ? takeButton(who, t.assigned_to, true) : null,
    bookings: (bookingsQ.data ?? []).map((b) => ({ ...b, status_words: statusWords(b.status), tone: statusTone(b.status) })),
    notes,
    history: (auditQ.data ?? []).map(describeActivity),
    last_change: (auditQ.data ?? [])[0] ? describeActivity(auditQ.data[0]) : null,
    conversation: { channel: t.channel ?? 'telegram', chat_id: t.chat_id ?? null },
  });
}

/** GET view=case&type=mrn&ref= - an MRN application MKY is making. */
export async function mrnCase(req, res, who) {
  const ref = String(req.query.ref ?? '').trim();
  const { data: m, error } = await db().from('mrn_requests').select('*').eq('request_ref', ref).maybeSingle();
  if (error) throw new Error(`mrn read: ${error.message}`);
  if (!m) return res.status(404).json({ error: `There is no MRN application ${ref}.` });

  const { data: booking } = m.booking_ref
    ? await db().from('bookings').select('*').eq('booking_ref', m.booking_ref).maybeSingle()
    : { data: null };
  const open = MRN_OPEN.includes(m.status) || m.status === 'draft';
  const meta = MRN_STATUS[m.status] ?? { tone: 'gray', owner: 'none' };

  const secondary = [];
  let primary = null;
  if (open) {
    primary = button(who, 'issue_mrn', 'Record the MRN', { perm: 'mrn', kind: 'primary', request_ref: ref });
    secondary.push(button(who, 'mrn_need_info', 'Ask the customer for information', { perm: 'mrn' }));
    if (m.status === 'submitted') secondary.push(button(who, 'mrn_review', 'Start working on it', { perm: 'mrn' }));
    secondary.push(button(who, 'mrn_reject', 'Reject the application', { perm: 'mrn', kind: 'danger', more: true }));
  }

  const [{ data: auditRows }, notes] = await Promise.all([
    db().from('audit_logs').select('*')
      .in('entity_id', [ref, m.booking_ref].filter(Boolean)).order('created_at', { ascending: false }).limit(40),
    notesFor(ref),
  ]);
  const customer = await customerFor({
    clientId: m.client_id ?? booking?.client_id, channel: booking?.channel ?? 'telegram', chatId: m.chat_id ?? booking?.chat_id,
    name: booking?.customer_name, contact: booking?.customer_contact,
  });

  return res.status(200).json({
    type: 'mrn',
    version: mrnVersion(m),
    header: {
      ref, title: 'MRN application', status: m.status, status_words: mrnStatusWords(m.status), tone: meta.tone,
      turn: meta.owner, vin: m.vin ?? booking?.vin ?? null,
      vehicle: booking ? [booking.make, booking.model].filter(Boolean).join(' ') : null,
      submitted_at: m.submitted_at ?? m.created_at,
    },
    mrn: {
      request_ref: m.request_ref, booking_ref: m.booking_ref ?? null, status: m.status, mrn_number: m.mrn_number ?? null,
      supplied: m.supplied_information?.notes ?? [], missing: m.missing_information ?? [], notes: m.operations_notes ?? null,
    },
    booking: booking ? { booking_ref: booking.booking_ref, status_words: statusWords(booking.status), customer_name: booking.customer_name } : null,
    customer,
    next_step: {
      owner: meta.owner, owner_words: turnWords(meta.owner), owner_tone: TURN[meta.owner]?.tone ?? 'gray',
      title: open ? (m.status === 'missing_information' ? 'Waiting for the customer’s information' : 'Record the MRN when customs issue it')
        : mrnStatusWords(m.status),
      detail: open ? 'Type the MRN exactly as issued. It is never generated here.' : (m.mrn_number ? `MRN ${m.mrn_number}` : null),
      primary, secondary,
    },
    notes,
    history: (auditRows ?? []).map(describeActivity),
    last_change: (auditRows ?? [])[0] ? describeActivity(auditRows[0]) : null,
    conversation: { channel: booking?.channel ?? 'telegram', chat_id: m.chat_id ?? booking?.chat_id ?? null },
  });
}

/**
 * GET view=document_url&id= - a fresh signed link for one file.
 *
 * Short-lived (15 minutes) and fetched when the viewer opens, not when the
 * case loads: a case page left open over lunch must not hand out a link that
 * died an hour ago, and one that lists ten documents must not sign ten links
 * nobody looks at. The viewer asks again when a link has expired.
 */
export async function documentUrl(req, res) {
  const id = Number(req.query.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id is required' });
  const { data: d } = await db().from('booking_documents').select('id, storage_path, mime_type, file_name').eq('id', id).maybeSingle();
  if (!d) return res.status(404).json({ error: 'That document is no longer here.' });
  if (!d.storage_path) return res.status(404).json({ error: 'The file itself was not stored, only what was read from it.' });
  const seconds = 15 * 60;
  const url = await signedUrl(d.storage_path, seconds);
  if (!url) return res.status(502).json({ error: 'We could not get a link to the file. Try again.' });
  return res.status(200).json({
    url, mime_type: d.mime_type ?? null, file_name: d.file_name ?? null,
    expires_at: new Date(Date.now() + seconds * 1000 - 30_000).toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Previews: the exact message, before it is sent
// ---------------------------------------------------------------------------

/** What will reach the customer, and how, given WhatsApp's window. */
async function deliveryNote({ channel, chatId, customer, eventType }) {
  const { window: win, composer } = await composerFor({ channel, chatId, customer });
  if (!chatId) return { via: 'none', words: 'This customer has no chat linked, so nothing will be sent.' };
  if (channel === 'whatsapp' && win.open !== true) {
    const templates = (await settings()).whatsapp_templates ?? {};
    const t = templates?.[eventType];
    return t?.name
      ? { via: 'template', template: t.name, words: `The customer hasn’t written in 24 hours, so WhatsApp will carry this as the approved template “${t.name}”.` }
      : { via: 'waiting', words: 'The customer hasn’t written in 24 hours and no template is set for this message, so it will wait until they write.' };
  }
  if (composer.mode === 'disabled' && channel !== 'whatsapp') return { via: 'none', words: composer.reason };
  return { via: 'chat', words: channel === 'whatsapp' ? 'Sent on WhatsApp.' : 'Sent on Telegram.' };
}

/**
 * GET view=preview&kind=…
 *
 *   reject_document  document_id, reason_code, note
 *   request_info     booking_ref, requested
 *   confirm          booking_ref
 *   reject           booking_ref, note
 *   issue_mrn        request_ref, mrn_number
 *   shipment_update  shipment_id, status, eta, note
 *   request_resolve  ticket_ref, note
 *
 * → { text, language, language_words, channel, delivery: { via, words } }
 */
export async function previewView(req, res) {
  const q = req.query;
  const kind = String(q.kind ?? '');

  let target = null;
  let eventType = 'operations_message';
  let make = null;   // (language, channel) => the text, rendered the way it will be sent

  const forBooking = async (ref) => {
    const { data: b } = await db().from('bookings').select('*').eq('booking_ref', String(ref ?? '')).maybeSingle();
    return b;
  };
  const targetOf = (row, name, contact) => ({
    channel: row?.channel ?? 'telegram', chatId: row?.chat_id ?? null, clientId: row?.client_id ?? null, name, contact,
  });

  if (kind === 'reject_document') {
    const { data: d } = await db().from('booking_documents').select('*').eq('id', Number(q.document_id)).maybeSingle();
    if (!d) return res.status(404).json({ error: 'That document is no longer here.' });
    const b = await forBooking(d.booking_ref);
    target = targetOf(b ?? d, b?.customer_name, b?.customer_contact);
    eventType = 'document_rejected';
    const payload = { booking_ref: d.booking_ref, ...replacementRequest(d.doc_type, String(q.reason_code ?? 'other'), q.note) };
    make = (lang, ch) => renderEvent(eventType, payload, lang, ch);
  } else if (kind === 'request_info') {
    const b = await forBooking(q.booking_ref);
    if (!b) return res.status(404).json({ error: 'No such booking.' });
    target = targetOf(b, b.customer_name, b.customer_contact);
    eventType = 'missing_information_requested';
    make = (lang, ch) => renderEvent(eventType, { booking_ref: b.booking_ref, requested: String(q.requested ?? '').trim() || '…' }, lang, ch);
  } else if (kind === 'confirm' || kind === 'reject') {
    const b = await forBooking(q.booking_ref);
    if (!b) return res.status(404).json({ error: 'No such booking.' });
    target = targetOf(b, b.customer_name, b.customer_contact);
    eventType = kind === 'confirm' ? 'booking_confirmed' : 'booking_rejected';
    make = (lang, ch) => renderEvent(eventType, {
      booking_ref: b.booking_ref, vin: b.vin, make: [b.make, b.model].filter(Boolean).join(' ') || b.make,
      origin_port: b.origin_port, destination_port: b.destination_port,
      // The shipment number does not exist until the confirmation creates it.
      shipment_id: kind === 'confirm' ? '(new shipment number)' : null,
      reason: String(q.note ?? '').trim() || null,
    }, lang, ch);
  } else if (kind === 'issue_mrn' || kind === 'mrn_need_info') {
    const { data: m } = await db().from('mrn_requests').select('*').eq('request_ref', String(q.request_ref ?? '')).maybeSingle();
    if (!m) return res.status(404).json({ error: 'No such MRN application.' });
    const b = await forBooking(m.booking_ref);
    target = targetOf({ ...(b ?? {}), chat_id: m.chat_id ?? b?.chat_id, client_id: m.client_id ?? b?.client_id }, b?.customer_name, b?.customer_contact);
    eventType = kind === 'issue_mrn' ? 'mrn_issued' : 'missing_information_requested';
    make = (lang, ch) => (kind === 'issue_mrn'
      ? renderEvent(eventType, { mrn_number: String(q.mrn_number ?? '').trim() || '…', booking_ref: m.booking_ref }, lang, ch)
      : renderEvent(eventType, { booking_ref: m.booking_ref, requested: String(q.requested ?? '').trim() || '…' }, lang, ch));
  } else if (kind === 'shipment_update') {
    const { data: s } = await db().from('shipments').select('*').eq('shipment_id', String(q.shipment_id ?? '')).maybeSingle();
    if (!s) return res.status(404).json({ error: 'No such shipment.' });
    const b = s.booking_ref ? await forBooking(s.booking_ref) : null;
    target = targetOf({ channel: s.channel ?? b?.channel, chat_id: s.chat_id ?? b?.chat_id, client_id: b?.client_id }, s.customer_name);
    eventType = 'shipment_update';
    make = (lang) => shipmentUpdateText(s, { status: q.status || null, eta: q.eta || null, note: q.note ?? '' }, lang);
  } else if (kind === 'request_resolve') {
    const { data: t } = await db().from('support_tickets').select('*').eq('ticket_ref', String(q.ticket_ref ?? '')).maybeSingle();
    if (!t) return res.status(404).json({ error: 'No such request.' });
    target = targetOf(t, t.customer, t.contact);
    eventType = 'ticket_resolved';
    // Telegram is told inline by notify.js; WhatsApp through the outbox.
    make = (lang, ch) => (ch === 'whatsapp'
      ? renderEvent(eventType, { ticket_ref: t.ticket_ref, department: t.department ?? null, note: String(q.note ?? '').trim() || null }, lang, ch)
      : ticketResolvedText(t, q.note ?? '', lang));
  } else {
    return res.status(400).json({ error: `Unknown preview "${kind}"` });
  }

  const customer = await customerFor({ ...target });
  const text = make(customer.language, target.channel);
  const delivery = await deliveryNote({ channel: target.channel, chatId: target.chatId, customer, eventType });
  return res.status(200).json({
    text: text ?? '',
    language: customer.language,
    language_words: customer.language_words,
    channel: target.channel,
    customer_name: customer.name,
    delivery,
  });
}

// ---------------------------------------------------------------------------
// Actions on a case
// ---------------------------------------------------------------------------

/**
 * POST { action: 'edit_details', booking_ref, version, field, value }
 *
 * A correction, not a free edit: one field at a time, recorded with what it
 * was, who changed it and when - on the booking's own edit_history and in the
 * audit trail - because a chassis number on a customs declaration has to be
 * explainable.
 */
export async function editDetails(req, res, who, state) {
  const field = String(req.body.field ?? '');
  if (!DETAIL_FIELDS.includes(field)) return res.status(400).json({ error: 'That detail cannot be corrected here.' });
  const { booking } = state;
  if (!OPEN_STATUSES.includes(booking.status)) {
    return res.status(409).json({ error: 'This booking is decided, so it cannot be corrected here. Correct the shipment instead.' });
  }

  let value = String(req.body.value ?? '').trim().slice(0, 200);
  const required = ['customer_name', 'customer_contact', 'vin', 'make', 'origin_port', 'destination_port'];
  if (required.includes(field) && !value) return res.status(400).json({ error: 'This detail cannot be empty.' });

  if (field === 'vin') {
    value = value.toUpperCase().replace(/\s+/g, '');
    const norm = normalise(value);
    if (norm.length < 6 || norm.length > 20 || !/[A-Z]/.test(norm) || !/\d/.test(norm)) {
      return res.status(400).json({ error: 'A chassis number mixes letters and digits, usually 17 characters.' });
    }
    // Two live bookings on one chassis is the mistake the whole duplicate
    // guard exists for; a correction must not walk around it.
    const { data: clash } = await db().from('bookings').select('booking_ref, status').eq('vin_norm', norm)
      .neq('booking_ref', booking.booking_ref).in('status', ['pending_review', 'under_review', 'needs_client_action', 'confirmed'])
      .limit(1).maybeSingle();
    if (clash) return res.status(409).json({ error: `Booking ${clash.booking_ref} already uses this chassis (${statusWords(clash.status).toLowerCase()}).` });
  }

  const before = booking[field] ?? null;
  if (String(before ?? '') === value) return res.status(200).json({ ok: true, unchanged: true });

  const history = Array.isArray(booking.edit_history) ? booking.edit_history : [];
  const entry = { field, from: before, to: value || null, by: who.name, at: new Date().toISOString(), via: 'desk' };
  const { data, error } = await db().from('bookings')
    .update({ [field]: value || null, edit_history: [...history, entry].slice(-100) })
    .eq('booking_ref', booking.booking_ref).eq('status', booking.status).select('booking_ref');
  if (error) return res.status(500).json({ error: 'We could not save the correction.' });
  if (!data?.length) return refuseStale(res, { entityIds: bookingEntities(state), current: null });

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'booking_details_corrected',
    entity_type: 'booking', entity_id: booking.booking_ref, metadata: { field, from: before, to: value || null },
  });
  return res.status(200).json({ ok: true, field, value: value || null });
}

/**
 * POST { action: 'mark_document_read_values', document_id, version, values: { vin, mrn, … } }
 *
 * When the bot could not read a scan, a person reads it and types what it
 * says. Kept apart from what the bot read (extracted.typed), with the name of
 * whoever typed it, so nobody later mistakes a person's reading for the bot's.
 */
export async function markReadValues(req, res, who, doc) {
  const raw = req.body.values ?? {};
  const typed = {};
  for (const k of TYPABLE) {
    const v = String(raw[k] ?? '').trim().slice(0, 120);
    if (v) typed[k] = k === 'vin' || k === 'mrn' ? v.toUpperCase().replace(/\s+/g, '') : v;
  }
  if (!Object.keys(typed).length) return res.status(400).json({ error: 'Type at least one value from the document.' });
  if (typed.vin) {
    const n = normalise(typed.vin);
    if (n.length < 6 || !/[A-Z]/.test(n) || !/\d/.test(n)) return res.status(400).json({ error: 'A chassis number mixes letters and digits.' });
  }

  const extracted = { ...(doc.extracted ?? {}), typed: { ...(doc.extracted?.typed ?? {}), ...typed }, typed_by: who.name, typed_at: new Date().toISOString() };
  const patch = { extracted, ...(typed.vin ? { vin: typed.vin } : {}) };
  const { error } = await db().from('booking_documents').update(patch).eq('id', doc.id);
  if (error) return res.status(500).json({ error: 'We could not save what you typed.' });

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'document_values_typed',
    entity_type: 'booking_document', entity_id: String(doc.id),
    metadata: { doc_type: doc.doc_type, booking_ref: doc.booking_ref, fields: Object.keys(typed) },
  });
  return res.status(200).json({ ok: true, typed });
}

export { shipmentVersion };
