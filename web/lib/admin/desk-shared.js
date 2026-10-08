/**
 * What every part of the desk's API shares: who is asking and what they may
 * do, whether the database has caught up with the code, how a record's version
 * is told apart from the one an operator was looking at, and who the customer
 * on the other end is.
 *
 * Kept out of console.js so the views and actions that grew around it - the
 * inbox, the case page, the conversation, the settings - can each live in a
 * file small enough to read, while answering these questions one way.
 */

import { db } from '../supabase.js';
import { settings, requiredDocuments } from '../settings.js';
import { DOC_LABEL, statusLabel, nextAction } from '../ops/workflow.js';

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * What each role may do.
 *
 * Checked on the server. The desk greys out what a role may not do and says
 * why, but a disabled button is a courtesy, not a permission - anyone holding
 * the admin secret can craft the request by hand.
 *
 * `chat` is talking to a customer in their conversation; `problems` is
 * retrying or setting aside a message that did not go through.
 */
export const PERMISSIONS = {
  read_only:      new Set(['read']),
  ops_agent:      new Set(['read', 'assign_self', 'status', 'documents', 'client', 'chat', 'notes', 'booking', 'mrn', 'problems']),
  ops_supervisor: new Set(['read', 'assign_self', 'assign_others', 'status', 'documents', 'client', 'chat', 'notes', 'booking', 'mrn', 'problems', 'priority', 'override']),
  admin:          new Set(['read', 'assign_self', 'assign_others', 'status', 'documents', 'client', 'chat', 'notes', 'booking', 'mrn', 'problems', 'priority', 'override', 'settings', 'users']),
};

export const ROLE_WORDS = {
  read_only: 'Read only',
  ops_agent: 'Agent',
  ops_supervisor: 'Supervisor',
  admin: 'Administrator',
};

/**
 * Why a role cannot do something, in the words the button shows. "Your role
 * cannot do that" makes people ask somebody; naming who can tells them whom.
 */
export function deniedReason(permission, role) {
  if (role === 'read_only') return 'Your role is read only: you can look, but not change anything.';
  return {
    assign_others: 'Only a supervisor can give work to someone else.',
    priority: 'Only a supervisor can change the priority.',
    override: 'Only a supervisor can do this.',
    settings: 'Only an administrator can change settings.',
    users: 'Only an administrator can manage the team.',
  }[permission] ?? 'Your role cannot do this.';
}

/** Resolves the operator named in the request, and what they may do. */
export async function operatorFor(req) {
  const name = String(req.body?.operator ?? req.query?.operator ?? '').trim();
  if (!name) return { ok: false, error: 'Sign in with your name before making changes.' };

  const { data, error } = await db()
    .from('ops_users')
    .select('name, role, active')
    .ilike('name', name)
    .maybeSingle();

  if (error) return { ok: false, error: 'Could not check who you are. Try again.' };
  if (!data) return { ok: false, unknown: true, error: `"${name}" is not on the team list. Ask an administrator to add you.` };
  if (!data.active) return { ok: false, error: `"${data.name}" is no longer active. Ask an administrator.` };

  const can = (p) => PERMISSIONS[data.role]?.has(p) ?? false;
  return { ok: true, name: data.name, role: data.role, can, permissions: [...(PERMISSIONS[data.role] ?? [])] };
}

// ---------------------------------------------------------------------------
// The schema the code was written for, and the one that is actually there
// ---------------------------------------------------------------------------

// Postgres says "relation ... does not exist" (42P01); PostgREST, in front of
// it, says "Could not find the table ... in the schema cache" (PGRST205).
const MISSING_TABLE = /relation .* does not exist|could not find the table|42P01|PGRST205/i;
// Same pair for a column: 42703, and PGRST204 / "Could not find the '…' column".
const MISSING_COLUMN = /column .* does not exist|could not find the '.*' column|42703|PGRST204/i;

const text = (error) => `${error?.code ?? ''} ${error?.message ?? ''}`;
export const isMissingTable = (error) => Boolean(error) && MISSING_TABLE.test(text(error));
export const isMissingColumn = (error) => Boolean(error) && MISSING_COLUMN.test(text(error));
export const isMissingSchema = (error) => isMissingTable(error) || isMissingColumn(error);

/**
 * Production can be one deploy ahead of its database: this code may run before
 * migration 20261007090000 has been applied. A view that reads a new table
 * says so with this sentence, rather than showing an empty list that looks
 * like nobody ever wrote in.
 */
export const HISTORY_PENDING = 'Conversation history starts once the database update is applied.';

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/**
 * JSON with sorted keys, so two equal objects always print the same.
 * Without it {a,b} and {b,a} would be two "versions" of one record.
 */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** FNV-1a: short, stable, no dependency. Not a security measure - a fingerprint. */
export function fingerprint(value) {
  const s = stable(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `v${h.toString(36)}`;
}

/** The booking fields an operator can see and correct on the case page. */
export const DETAIL_FIELDS = [
  'customer_name', 'customer_contact', 'company', 'vin', 'make', 'model', 'origin_port', 'destination_port',
];

/**
 * The version of a booking case: everything an operator's decision rests on.
 *
 * WHY NOT updated_at. `bookings` has no updated_at column (and the queue view
 * has none either), and adding one is a migration this package may not write.
 * A fingerprint of what the case page shows is stricter anyway: it changes
 * when a colleague verifies a document or the MRN is recorded - rows that are
 * not the booking's own - which is exactly when "confirm" should be refused.
 *
 * Notes and messages are left out on purpose. A colleague writing a note must
 * not make your confirmation bounce.
 */
export function bookingVersion(booking, docs = [], mrn = null) {
  return fingerprint({
    s: booking?.status ?? null,
    a: booking?.assigned_to ?? null,
    p: booking?.priority ?? 'normal',
    f: DETAIL_FIELDS.map((k) => booking?.[k] ?? null),
    n: booking?.mrn_number ?? null,
    d: docs.map((d) => [d.id, d.status, d.doc_type, d.vin ?? null]).sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    m: mrn ? [mrn.request_ref, mrn.status, mrn.mrn_number ?? null] : null,
  });
}

export const ticketVersion = (t) => fingerprint({ s: t?.status ?? null, a: t?.assigned_to ?? null, p: t?.priority ?? 'normal' });
export const mrnVersion = (m) => fingerprint({ s: m?.status ?? null, n: m?.mrn_number ?? null, i: m?.missing_information ?? null });
export const shipmentVersion = (s) => fingerprint({ u: s?.updated_at ?? null, s: s?.status ?? null, e: s?.eta ?? null, v: s?.vessel ?? null });
export const userVersion = (u) => fingerprint({ r: u?.role ?? null, a: u?.active ?? null });

/**
 * "Sara confirmed the booking 1 min ago." - the most recent thing that
 * happened to any of these records, from the audit trail every write leaves.
 */
export async function latestChange(entityIds) {
  const ids = [...new Set(entityIds.filter(Boolean).map(String))];
  if (!ids.length) return null;
  const { data } = await db()
    .from('audit_logs')
    .select('*')
    .in('entity_id', ids)
    .order('created_at', { ascending: false })
    .limit(1);
  return data?.[0] ? describeActivity(data[0]) : null;
}

/**
 * Refuses an action taken on a record that changed since the operator looked.
 *
 * The answer names who and when, because "this changed" alone sends people to
 * the chat to ask who did what. The desk then shows the record as it is now.
 */
export async function refuseStale(res, { entityIds, current }) {
  const change = await latestChange(entityIds);
  const sentence = change
    ? `${change.who} ${change.what} ${ago(change.at)}.`
    : 'Somebody changed this a moment ago.';
  return res.status(409).json({
    error: `${sentence} The page now shows the latest.`,
    stale: true,
    conflict: change,
    version: current,
  });
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** "just now", "4 min ago", "2 h ago", "3 days ago". */
export function ago(at, now = Date.now()) {
  const ms = now - new Date(at).getTime();
  if (!Number.isFinite(ms)) return '';
  const mins = Math.floor(Math.max(ms, 0) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** The calendar day a moment falls on in MKY's timezone, as YYYY-MM-DD. */
export function dayIn(at, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

/** "Today" is Cairo's today, not the server's: the desk works Cairo hours. */
export async function todayCheck() {
  const cfg = await settings();
  const tz = cfg.support_timezone || 'Africa/Cairo';
  const today = dayIn(Date.now(), tz);
  return (at) => Boolean(at) && dayIn(at, tz) === today;
}

// ---------------------------------------------------------------------------
// Documents and readiness
// ---------------------------------------------------------------------------

export const normalise = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** What was received and checked, against what is required. Same rule as the case page. */
export function documentSummary(docs, required) {
  const live = docs.filter((d) => !['rejected', 'replacement_requested'].includes(d.status));
  const received = new Set(live.map((d) => d.doc_type));
  if (received.has('eur1')) received.add('brief');
  const verified = new Set(live.filter((d) => d.status === 'verified').map((d) => d.doc_type));
  if (verified.has('eur1')) verified.add('brief');
  return {
    required,
    received_types: [...received],
    verified_types: [...verified],
    missing: required.filter((t) => !received.has(t)),
  };
}

/** Required documents for both MRN choices, read once per request. */
export async function requiredByChoice() {
  return {
    existing: await requiredDocuments({ mrnChoice: 'existing' }),
    mky_issue: await requiredDocuments({ mrnChoice: 'mky_issue' }),
  };
}

export const requiredFor = (byChoice, booking) =>
  byChoice[booking?.mrn_choice === 'mky_issue' ? 'mky_issue' : 'existing'] ?? [];

/**
 * A document the bot finished reading and could not make sense of. Still
 * reading is not unreadable; a person who typed the values in has dealt with it.
 */
export function unreadable(doc) {
  const x = doc?.extracted ?? {};
  if (x.pending === true) return false;
  if (x.typed_by) return false;
  return doc?.extraction_ok === false || x.ok === false || x.needs_ocr === true;
}

/**
 * Adds next-action, ageing and SLA to queue rows. Documents are counted from
 * the rows themselves when they are given, so a list says exactly what the
 * case page will say; without them it falls back to the view's counts.
 */
export async function enrichAll(rows, { docsByRef = null } = {}) {
  const cfg = await settings();
  const thresholds = {
    new_request_hours: Number(cfg.sla_new_request_hours) || null,
    review_hours: Number(cfg.sla_review_hours) || null,
  };
  const now = Date.now();
  const byChoice = await requiredByChoice();

  return rows.map((r) => {
    const required = requiredFor(byChoice, r);
    const docs = docsByRef?.get(r.booking_ref);
    const summary = docs
      ? documentSummary(docs, required)
      : {
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
      summary,
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

// ---------------------------------------------------------------------------
// The customer
// ---------------------------------------------------------------------------

const PHONEISH = /^\+?[\d\s().-]{7,}$/;

export const LANGUAGE_WORDS = { ar: 'Arabic', en: 'English' };

/**
 * Where the customer is in the bot's conversation, as a phrase - so the desk
 * knows, before writing, that somebody is half-way through typing a chassis
 * number, or has not even picked a language yet. The values are the flow's
 * state names (lib/flow/states.js); an unknown one reads as a plain fallback.
 */
const BOT_STATE_WORDS = {
  MAIN_MENU: 'At the main menu',
  CHOOSE_LANGUAGE: 'Choosing a language',
  BOOK_DRAFT_RESUME: 'Deciding whether to finish an earlier booking',
  BOOK_CLIENT_NAME: 'Booking — giving their name',
  BOOK_CLIENT_PHONE: 'Booking — giving a phone number',
  BOOK_VIN: 'Booking — giving the chassis number',
  BOOK_MAKE: 'Booking — giving the make',
  BOOK_POL: 'Booking — choosing the loading port',
  BOOK_DESTINATION: 'Booking — choosing the destination',
  BOOK_MRN_CHOICE: 'Booking — saying who has the MRN',
  BOOK_DOCUMENTS: 'Booking — sending documents',
  BOOK_DOCUMENT_CLASSIFY: 'Booking — saying what a file is',
  BOOK_MRN_SUPPORTING_INFO: 'Booking — giving information for the MRN',
  BOOK_FINAL_CONFIRMATION: 'Booking — checking the summary before sending it',
  BOOK_CANCEL_CONFIRM: 'Booking — deciding whether to cancel',
  BOOK_SUBMITTED: 'Booking sent to us',
  ANSWERING_DESK: 'Answering what we asked',
  TRACK_IDENTIFIER: 'Tracking — giving a reference',
  TRACK_RESULTS: 'Tracking a shipment',
  CONTACT_MENU: 'Asking to talk to a person',
  CONTACT_URGENCY: 'Saying whether it is urgent (after hours)',
  CONTACT_TICKET_DETAILS: 'Describing what they need from a person',
};

export function botStateWords(state) {
  if (!state) return null;
  if (BOT_STATE_WORDS[state]) return BOT_STATE_WORDS[state];
  if (/^BOOK_EDIT_/.test(state)) return 'Booking — correcting a detail';
  if (/^CONTACT_/.test(state)) return 'Asking to talk to a person';
  if (/^TRACK_/.test(state)) return 'Tracking a shipment';
  return 'Talking to the bot';
}

/**
 * Who is on the other end of a case or a chat, and how to reach them.
 *
 * Everything new (language, WhatsApp identity, opt-out, the last time they
 * wrote) is read with select('*'), so a database without migration
 * 20261007090000 simply has no such fields and nothing errors. Naming a column
 * that does not exist fails the whole query; not naming it cannot.
 */
export async function customerFor({ clientId = null, channel = null, chatId = null, name = null, contact = null } = {}) {
  let session = null;
  if (channel && chatId) {
    const { data } = await db().from('conversation_sessions').select('*').eq('id', `${channel}:${chatId}`).maybeSingle();
    session = data ?? null;
  }
  // The session knows the client even when the caller only knows the chat.
  clientId = clientId ?? session?.client_id ?? null;

  let client = null;
  if (clientId) {
    const { data } = await db().from('clients').select('*').eq('id', clientId).maybeSingle();
    client = data ?? null;
  }
  if (!client && chatId && channel === 'whatsapp') {
    const waId = String(chatId).replace(/^wa:/, '');
    const { data, error } = await db().from('clients').select('*').eq('whatsapp_id', waId).maybeSingle();
    if (!error) client = data ?? null;
  }
  if (!client && chatId && channel === 'telegram' && /^-?\d+$/.test(String(chatId))) {
    const { data } = await db().from('clients').select('*').eq('telegram_chat_id', chatId).maybeSingle();
    client = data ?? null;
  }

  const language = ['en', 'ar'].includes(client?.language) ? client.language
    : ['en', 'ar'].includes(session?.language) ? session.language : null;

  const contactPhone = contact && PHONEISH.test(String(contact).trim()) ? String(contact).trim() : null;
  const waPhone = client?.whatsapp_id ? `+${client.whatsapp_id}`
    : channel === 'whatsapp' && chatId ? `+${String(chatId).replace(/^wa:/, '')}` : null;

  const profile = client?.whatsapp_name || client?.display_name
    || [client?.first_name, client?.last_name].filter(Boolean).join(' ') || null;

  return {
    client_id: client?.id ?? clientId ?? null,
    name: name || client?.company || client?.full_name || profile || client?.telegram_username || waPhone || 'Unknown customer',
    profile_name: profile,
    company: client?.company ?? null,
    phone: client?.phone || contactPhone || waPhone || null,
    email: client?.email ?? null,
    channel: channel ?? null,
    chat_id: chatId != null ? String(chatId) : null,
    telegram_username: client?.telegram_username ?? null,
    whatsapp_id: client?.whatsapp_id ?? null,
    // The client's choice, then the session's (a chat with no client row yet),
    // else null: not chosen, and the bot speaks both languages to them.
    language,
    language_words: language ? LANGUAGE_WORDS[language] : 'Not chosen yet',
    opted_out_at: client?.opted_out_at ?? null,
    is_blocked: Boolean(client?.is_blocked),
    last_client_message_at: session?.last_client_message_at ?? null,
    bot_state: session?.current_state ?? null,
    bot_state_words: botStateWords(session?.current_state),
  };
}

// ---------------------------------------------------------------------------
// History, in sentences
// ---------------------------------------------------------------------------

const docName = (row) => DOC_LABEL[row.metadata?.doc_type] ?? 'document';

/** Turns an audit row into a sentence an operator reads without decoding it. */
export function describeActivity(row) {
  const who = row.actor_type === 'operator' ? row.actor_id
    : row.actor_type === 'client' ? 'The customer' : 'The system';
  const m = row.metadata ?? {};
  const what = {
    booking_draft_created: 'started a booking request',
    booking_request_submitted: 'sent the request to us',
    booking_assigned: `gave it to ${m.to ?? 'somebody'}`,
    booking_unassigned: 'put it back for anyone to take',
    booking_status_changed: `moved it to “${statusLabel(m.to)}”`,
    booking_priority_changed: `set the priority to ${m.priority ?? ''}`,
    booking_details_corrected: `corrected the ${String(m.field ?? 'details').replace(/_/g, ' ')}`,
    document_received: `sent the ${docName(row)}`,
    document_verified: `checked the ${docName(row)}`,
    document_rejected: `asked for a new ${docName(row)}`,
    document_values_typed: `typed in what the ${docName(row)} says`,
    client_information_requested: 'asked the customer for more information',
    client_responded: `answered what we asked${m.said ? `: “${String(m.said).slice(0, 80)}”` : (m.documents ?? []).length ? ' with a file' : ''}`,
    client_message_sent: 'messaged the customer',
    whatsapp_reopen_sent: 'sent the “please reply” template',
    booking_reference_recorded: `recorded booking reference ${m.reference ?? ''}`.trim(),
    booking_confirmed: 'confirmed the booking',
    booking_rejected: 'rejected the request',
    booking_cancelled: 'cancelled the request',
    booking_under_review: 'started checking it',
    booking_needs_client_action: 'asked the customer for something',
    mrn_request_created: 'opened an MRN application',
    mrn_issue: 'recorded the MRN',
    mrn_review: 'started on the MRN application',
    mrn_need_info: 'asked the customer for MRN information',
    mrn_reject: 'rejected the MRN application',
    request_assigned: `gave it to ${m.to ?? 'somebody'}`,
    request_unassigned: 'put it back for anyone to take',
    request_status_changed: `moved it to “${String(m.to ?? '').replace(/_/g, ' ')}”`,
    request_reply_sent: 'replied to the customer',
    support_ticket_created: 'asked for a person',
    operations_task_created: 'raised a task',
    notification_sent: 'sent the customer a message',
    duplicate_booking_detected: 'hit the duplicate-chassis guard',
    problem_dismissed: 'set the problem aside',
    message_retried: 'sent the failed message again',
    outbox_retried: 'tried the failed notification again',
    setting_changed: `changed the setting “${String(m.setting ?? '').replace(/_/g, ' ')}”`,
    ops_user_saved: `updated the team member ${m.name ?? ''}`.trim(),
    shipment_updated: 'updated the shipment',
  }[row.action] ?? String(row.action).replace(/_/g, ' ');

  return { at: row.created_at, who, what, entity: row.entity_id, action: row.action };
}

/** Short stable digest of a string, for idempotency keys built from text. */
export const hash = (s) => {
  let h = 0;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
};

/**
 * An action key from the browser: a UUID-ish token it makes once per click and
 * repeats on a retry, so a double submission resolves to one send. Anything
 * else is ignored rather than trusted into a database key.
 */
export function actionKeyOf(body) {
  const k = String(body?.action_key ?? '').trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(k) ? k : null;
}
