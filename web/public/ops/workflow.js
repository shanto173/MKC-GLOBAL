/**
 * The operations workflow: statuses, readiness, and what to do next.
 *
 * ONE FILE, TWO RUNTIMES. The browser imports it directly (no build step in
 * this project) and Node imports it from lib/ops/workflow.js. That is
 * deliberate: a status model that exists twice diverges, and the first symptom
 * is a queue that disagrees with the detail page about what a booking needs.
 * So it is plain ES with no imports of its own, and it touches no database.
 *
 * Everything here is a pure function of a booking row plus its documents.
 * Nothing asks a model. "Is this ready to confirm" is arithmetic, and the same
 * arithmetic runs on the server before anything is written - the browser's copy
 * decides what to DRAW, never what is allowed.
 */

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

/**
 * The database values, and how a human should read them.
 *
 * The stored values are the ones migration 004 and 008 already enforce with a
 * CHECK constraint - they are not re-invented here, because a second status
 * vocabulary is exactly the "multiple sources of truth" this must not have.
 * What is added is the label, the group and the colour.
 */
export const STATUS = {
  draft: {
    label: 'Draft', group: 'inbox', tone: 'gray', owner: 'client',
    hint: 'The client has not finished sending it.',
  },
  pending_review: {
    label: 'New', group: 'inbox', tone: 'blue', owner: 'ops',
    hint: 'Waiting for somebody on the desk to pick it up.',
  },
  under_review: {
    label: 'Under Review', group: 'active', tone: 'blue', owner: 'ops',
    hint: 'Somebody has it open.',
  },
  needs_client_action: {
    label: 'Waiting for Client', group: 'waiting', tone: 'amber', owner: 'client',
    hint: 'We have asked the client for something.',
  },
  confirmed: {
    label: 'Confirmed', group: 'done', tone: 'green', owner: 'none',
    hint: 'Booked and the client has been told.',
  },
  rejected: {
    label: 'Rejected', group: 'done', tone: 'red', owner: 'none',
    hint: 'Declined, with a reason.',
  },
  cancelled: {
    label: 'Cancelled', group: 'done', tone: 'gray', owner: 'none',
    hint: 'Withdrawn.',
  },
  expired: {
    label: 'Expired', group: 'done', tone: 'gray', owner: 'none',
    hint: 'Abandoned before it was sent.',
  },
};

export const STATUS_GROUPS = {
  inbox: { label: 'Inbox', statuses: ['pending_review'] },
  active: { label: 'Active', statuses: ['under_review'] },
  waiting: { label: 'Waiting on client', statuses: ['needs_client_action'] },
  done: { label: 'Done', statuses: ['confirmed', 'rejected', 'cancelled', 'expired'] },
};

/** Statuses an operator still owes work on. Drafts are the client's, not ours. */
export const OPEN_STATUSES = ['pending_review', 'under_review', 'needs_client_action'];

export const statusLabel = (s) => STATUS[s]?.label ?? String(s ?? '').replace(/_/g, ' ');
export const statusTone = (s) => STATUS[s]?.tone ?? 'gray';

/**
 * Whose move is it?
 *
 * The single most useful thing on the screen. An operator scanning a queue must
 * not spend attention on rows where MKY is waiting for the customer.
 */
export const whoseTurn = (booking) => STATUS[booking?.status]?.owner ?? 'none';

/**
 * Which status changes are legal.
 *
 * Enforced on the server as well; this copy exists so the console can grey out
 * what it must not offer. An operator should never be able to click something
 * the server will refuse.
 */
export const TRANSITIONS = {
  pending_review: ['under_review', 'needs_client_action', 'confirmed', 'rejected', 'cancelled'],
  under_review: ['needs_client_action', 'confirmed', 'rejected', 'cancelled'],
  needs_client_action: ['under_review', 'confirmed', 'rejected', 'cancelled'],
  confirmed: [],
  rejected: [],
  cancelled: [],
  draft: [],
  expired: [],
};

export const canTransition = (from, to) => (TRANSITIONS[from] ?? []).includes(to);

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const DOC_STATUS = {
  missing: { label: 'Missing', tone: 'red' },
  received: { label: 'Received', tone: 'blue' },
  pending_verification: { label: 'Pending check', tone: 'blue' },
  verified: { label: 'Verified', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
  replacement_requested: { label: 'Replacement asked', tone: 'amber' },
};

export const DOC_LABEL = {
  invoice: 'Invoice',
  brief: 'Brief',
  mrn: 'MRN',
  acid: 'ACID',
  eur1: 'EUR.1',
  other: 'Document',
};

/** Reasons a document may be sent back. Free text is allowed as "other". */
export const REJECT_REASONS = [
  ['unreadable', 'Unreadable'],
  ['wrong_document', 'Wrong document'],
  ['incomplete', 'Incomplete'],
  ['wrong_vin', 'Wrong chassis number'],
  ['wrong_client', 'Wrong client'],
  ['expired', 'Expired'],
  ['other', 'Other'],
];

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * Everything a booking needs, and whether it has it.
 *
 * @param {object} booking       a bookings row
 * @param {object} documents     { required: string[], received_types: string[],
 *                                 verified_types: string[], missing: string[] }
 * @param {object|null} mrn      the live mrn_requests row, when there is one
 * @returns {{items: Array, complete: boolean, blocking: string[]}}
 */
export function readiness(booking = {}, documents = {}, mrn = null) {
  const has = (v) => Boolean(String(v ?? '').trim());
  const received = new Set(documents.received_types ?? []);
  const verified = new Set(documents.verified_types ?? []);
  const required = documents.required ?? [];

  const items = [
    { key: 'client', label: 'Client information', ok: has(booking.customer_name), blocking: true },
    { key: 'vin', label: 'Chassis / VIN', ok: has(booking.vin), blocking: true },
    { key: 'make', label: 'Vehicle make', ok: has(booking.make), blocking: true },
    { key: 'route', label: 'Route', ok: has(booking.origin_port) && has(booking.destination_port), blocking: true },
  ];

  for (const type of required) {
    const label = DOC_LABEL[type] ?? type;
    items.push({
      key: `doc:${type}`,
      label,
      ok: received.has(type),
      // Verification is a separate, softer signal: a received document lets the
      // booking proceed, an unverified one is worth showing but does not block.
      note: received.has(type) && !verified.has(type) ? 'not verified yet' : null,
      blocking: true,
    });
  }

  // The MRN line only exists when MKY was asked to obtain it. A client who has
  // their own MRN sends it as a document, and it is already in the list above.
  if (booking.mrn_choice === 'mky_issue') {
    const issued = has(booking.mrn_number) || mrn?.status === 'issued';
    items.push({
      key: 'mrn',
      label: 'MRN issued by MKY',
      ok: issued,
      note: issued ? null : (mrn ? `application ${String(mrn.status).replace(/_/g, ' ')}` : 'not started'),
      blocking: true,
    });
  }

  items.push({
    key: 'booking_ref',
    label: 'Booking reference',
    ok: has(booking.booking_ref),
    blocking: false,
  });
  items.push({
    key: 'confirmation',
    label: 'Operations confirmation',
    ok: booking.status === 'confirmed',
    blocking: false,
  });

  const blocking = items.filter((i) => i.blocking && !i.ok).map((i) => i.key);
  return { items, complete: blocking.length === 0, blocking };
}

// ---------------------------------------------------------------------------
// The next action
// ---------------------------------------------------------------------------

/**
 * What has to happen next, and who has to do it.
 *
 * Deterministic and ordered: the first unmet condition wins, so two operators
 * looking at the same booking are told the same thing. Nothing here consults a
 * model - "are the documents complete" is a set difference, not a judgement.
 *
 * @returns {{code: string, label: string, owner: 'ops'|'client'|'none',
 *            detail: string, action: string|null}}
 */
export function nextAction(booking = {}, documents = {}, mrn = null) {
  const status = booking.status;

  if (status === 'confirmed') {
    return { code: 'NONE', label: 'Nothing outstanding', owner: 'none', detail: 'Booked and the client has been told.', action: null };
  }
  if (['rejected', 'cancelled', 'expired'].includes(status)) {
    return { code: 'NONE', label: 'Closed', owner: 'none', detail: `This request was ${statusLabel(status).toLowerCase()}.`, action: null };
  }
  if (status === 'draft') {
    return { code: 'WAIT_CLIENT', label: 'Client is still filling it in', owner: 'client', detail: 'Nothing has been sent to us yet.', action: null };
  }

  const ready = readiness(booking, documents, mrn);
  const missingBasics = ready.items.filter((i) => i.blocking && !i.ok && !i.key.startsWith('doc:') && i.key !== 'mrn');

  if (missingBasics.length) {
    return {
      code: 'REVIEW_INFORMATION',
      label: 'Ask the client for missing details',
      owner: 'ops',
      detail: `Still missing: ${missingBasics.map((i) => i.label).join(', ')}.`,
      action: 'request_info',
    };
  }

  const missingDocs = ready.items.filter((i) => i.key.startsWith('doc:') && !i.ok);
  if (missingDocs.length) {
    // Already asked, and the client has not sent it: the ball is theirs.
    if (status === 'needs_client_action') {
      return {
        code: 'WAIT_CLIENT',
        label: 'Waiting for documents',
        owner: 'client',
        detail: `Asked for: ${missingDocs.map((i) => i.label).join(', ')}.`,
        action: 'send_reminder',
      };
    }
    return {
      code: 'REQUEST_DOCUMENTS',
      label: 'Request the missing documents',
      owner: 'ops',
      detail: `Not received: ${missingDocs.map((i) => i.label).join(', ')}.`,
      action: 'request_documents',
    };
  }

  // The papers are checked BEFORE the MRN is applied for, because the customs
  // application is built from them: discovering an unreadable invoice after
  // lodging the declaration is the expensive order to do this in.
  //
  // It is a suggestion, not a gate - readiness stays complete, so an operator
  // who is sure may still confirm. What it must never do is let "uploaded" pass
  // silently for "checked".
  const unverified = ready.items.filter((i) => i.key.startsWith('doc:') && i.ok && i.note);
  if (unverified.length && ['pending_review', 'under_review'].includes(status)) {
    return {
      code: 'REVIEW_DOCUMENTS',
      label: 'Check the documents',
      owner: 'ops',
      detail: `Not verified yet: ${unverified.map((i) => i.label).join(', ')}.`,
      action: 'review_documents',
    };
  }

  if (booking.mrn_choice === 'mky_issue' && !ready.items.find((i) => i.key === 'mrn')?.ok) {
    return {
      code: 'PROCESS_MRN',
      label: 'Issue the MRN',
      owner: 'ops',
      detail: mrn ? `Application ${mrn.request_ref} is ${String(mrn.status).replace(/_/g, ' ')}.` : 'No application has been opened yet.',
      action: 'process_mrn',
    };
  }

  if (!String(booking.booking_ref ?? '').trim()) {
    return {
      code: 'CREATE_BOOKING',
      label: 'Create the booking',
      owner: 'ops',
      detail: 'Everything needed is in. Record the booking reference.',
      action: 'create_booking',
    };
  }

  return {
    code: 'CONFIRM_BOOKING',
    label: 'Confirm the booking',
    owner: 'ops',
    detail: 'Confirming tells the client and opens the shipment.',
    action: 'confirm_booking',
  };
}

// ---------------------------------------------------------------------------
// Which buttons are legal
// ---------------------------------------------------------------------------

/**
 * The actions valid from this state. The console draws only these; the server
 * checks again before doing any of them.
 */
export function availableActions(booking = {}, ready = null) {
  const status = booking.status;
  const done = ['confirmed', 'rejected', 'cancelled', 'expired', 'draft'].includes(status);
  if (done) return status === 'confirmed' ? ['view_shipment', 'update_shipment'] : [];

  const actions = ['assign', 'priority', 'internal_note', 'message_client'];

  if (status === 'pending_review') actions.push('start_review');
  if (['pending_review', 'under_review', 'needs_client_action'].includes(status)) {
    actions.push('request_info', 'reject', 'cancel');
  }

  const complete = ready?.complete ?? false;
  if (complete && !String(booking.booking_ref ?? '').trim()) actions.push('create_booking');
  // Confirming is only offered when everything blocking is satisfied. The
  // button is not merely disabled - it is absent, because a greyed-out primary
  // action invites a support call asking why.
  if (complete) actions.push('confirm_booking');

  return actions;
}

// ---------------------------------------------------------------------------
// Priority, ageing and SLA
// ---------------------------------------------------------------------------

export const PRIORITY = {
  urgent: { label: 'Urgent', tone: 'red', rank: 0 },
  high: { label: 'High', tone: 'amber', rank: 1 },
  normal: { label: 'Normal', tone: 'gray', rank: 2 },
};

export const priorityLabel = (p) => PRIORITY[p]?.label ?? 'Normal';
export const priorityRank = (p) => PRIORITY[p]?.rank ?? 2;

/** "18 min", "1h 24m", "2d". Nothing longer, nothing more precise. */
export function humanAge(since, now = Date.now()) {
  if (!since) return '—';
  const ms = now - new Date(since).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

/**
 * Is this past the time the business allows for it?
 *
 * Only counted while OPERATIONS owes the work. A request sitting in "waiting
 * for client" for five hours is not the desk being slow, and colouring it red
 * teaches operators to ignore red.
 *
 * Thresholds come from settings, never from here - nobody has told us what
 * MKY's are, so the defaults are marked as placeholders in the settings row.
 */
export function slaBreach(booking, thresholds = {}, now = Date.now()) {
  if (whoseTurn(booking) !== 'ops') return null;

  const hours = {
    pending_review: thresholds.new_request_hours,
    under_review: thresholds.review_hours,
  }[booking.status];

  if (!hours) return null;

  const since = booking.status_changed_at || booking.submitted_at || booking.created_at;
  const overBy = now - new Date(since).getTime() - hours * 3600_000;
  return overBy > 0 ? { overBy, hours } : null;
}

// ---------------------------------------------------------------------------
// Client requests
// ---------------------------------------------------------------------------

/**
 * Where a client request has got to.
 *
 * The old vocabulary was open/resolved, which cannot tell a request nobody has
 * touched from one somebody is already on the phone about. Both old values are
 * still here, so every row written before this and the existing endpoint keep
 * working unchanged.
 */
export const REQUEST_STATUS = {
  open:           { label: 'New', tone: 'blue', owner: 'ops' },
  assigned:       { label: 'Assigned', tone: 'blue', owner: 'ops' },
  in_progress:    { label: 'In Progress', tone: 'blue', owner: 'ops' },
  waiting_client: { label: 'Waiting for Client', tone: 'amber', owner: 'client' },
  resolved:       { label: 'Resolved', tone: 'green', owner: 'none' },
  closed:         { label: 'Closed', tone: 'gray', owner: 'none' },
};

export const REQUEST_OPEN = ['open', 'assigned', 'in_progress', 'waiting_client'];

export const REQUEST_TRANSITIONS = {
  open: ['assigned', 'in_progress', 'waiting_client', 'resolved', 'closed'],
  assigned: ['in_progress', 'waiting_client', 'resolved', 'closed'],
  in_progress: ['waiting_client', 'resolved', 'closed'],
  waiting_client: ['in_progress', 'resolved', 'closed'],
  resolved: ['closed', 'in_progress'],
  closed: [],
};

export const requestStatusLabel = (s) => REQUEST_STATUS[s]?.label ?? String(s ?? '').replace(/_/g, ' ');
export const requestStatusTone = (s) => REQUEST_STATUS[s]?.tone ?? 'gray';
export const requestOwner = (s) => REQUEST_STATUS[s]?.owner ?? 'none';
export const canTransitionRequest = (from, to) => (REQUEST_TRANSITIONS[from] ?? []).includes(to);

/** What the client asked about, for grouping the queue. */
export const REQUEST_TYPE = {
  booking:   { label: 'Booking', icon: '📦' },
  tracking:  { label: 'Shipment tracking', icon: '🚚' },
  documents: { label: 'Documents', icon: '📄' },
  accounts:  { label: 'Accounts', icon: '💳' },
  other:     { label: 'Other', icon: '💬' },
};

/**
 * What to do with a client request next.
 *
 * Same rule as a booking: deterministic, and honest about whose move it is. A
 * request parked on the client is not the desk running late.
 */
export function requestNextAction(request = {}) {
  const s = request.status;
  if (s === 'resolved') return { label: 'Resolved — close it when you are done', owner: 'none', action: 'close' };
  if (s === 'closed') return { label: 'Closed', owner: 'none', action: null };
  if (s === 'waiting_client') return { label: 'Waiting for the client to come back', owner: 'client', action: 'reply' };
  if (!request.assigned_to) return { label: 'Nobody owns this — take it', owner: 'ops', action: 'assign' };
  if (!request.contact || /^(telegram|web):/i.test(request.contact)) {
    return { label: 'No phone number — reply in the chat', owner: 'ops', action: 'reply' };
  }
  return { label: `Call ${request.contact}`, owner: 'ops', action: 'reply' };
}

// ---------------------------------------------------------------------------
// Shipments
// ---------------------------------------------------------------------------

/**
 * A booking being confirmed does not mean the vehicle is moving. These are the
 * milestones the shipment itself passes, kept separate from the booking's
 * status on purpose.
 */
export const SHIPMENT_MILESTONES = [
  'Booking confirmed, awaiting cargo',
  'Awaiting pickup at origin',
  'Received at origin warehouse',
  'Loaded on vessel',
  'Vessel departed',
  'In transit',
  'Arrived at destination port',
  'Customs clearance in progress',
  'Customs cleared',
  'Out for delivery',
  'Delivered',
  'On hold',
];

export function shipmentTone(status) {
  if (!status) return 'gray';
  if (/delivered|cleared|released/i.test(status)) return 'green';
  if (/hold|delay/i.test(status)) return 'red';
  if (/transit|departed|loaded|arrived|clearance|delivery/i.test(status)) return 'blue';
  return 'gray';
}
