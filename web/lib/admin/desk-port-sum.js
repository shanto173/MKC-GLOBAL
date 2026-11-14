/**
 * Port Sum Up and Team MKY for the operations desk.
 *
 * A row appears as soon as a booking has origin port, destination port and
 * VIN — drafts included, documents optional. Funds amount/status and assignee
 * live on the booking; Team MKY is a shared staff chat that can @ a customer
 * name or chassis and open that Port Sum Up row.
 */

import { db } from '../supabase.js';
import { channelOf } from '../channels.js';
import { DOC_LABEL, statusWords, statusTone } from '../ops/workflow.js';
import {
  bookingVersion, deniedReason, teamList, isMissingSchema,
} from './desk-shared.js';
import { shortPort } from './desk-inbox.js';
import { documentOut, declaredMrn, loadBooking } from './desk-case.js';
import { audit } from '../audit.js';

export const FUNDS = {
  not_received: 'Not Received',
  received: 'Received',
  in_process: 'In process',
};
export const FUNDS_KEYS = Object.keys(FUNDS);

const HIDDEN = new Set(['cancelled', 'expired', 'rejected']);
const PAGE = 100;
const MAX_PAGE = 300;
const LIST_COLUMNS = [
  'booking_ref', 'status', 'customer_name', 'vin', 'make', 'model',
  'origin_port', 'destination_port', 'assigned_to', 'assigned_at',
  'channel', 'chat_id', 'client_id', 'customer_contact', 'created_at',
  'submitted_at', 'port_amount', 'port_funds_status', 'priority',
].join(',');

const SYNTAX = /[%_,()*"\\]/;
const cursorOf = (row) => `${row.created_at}~${row.booking_ref}`;
function parseCursor(raw) {
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2}))~([A-Za-z0-9_.-]{1,64})$/.exec(String(raw ?? ''));
  return m ? { at: m[1], id: m[2] } : null;
}

/** Whether a booking belongs on Port Sum Up. */
export function isPortSumRow(b) {
  if (!b || HIDDEN.has(b.status)) return false;
  return Boolean(String(b.vin ?? '').trim()
    && String(b.origin_port ?? '').trim()
    && String(b.destination_port ?? '').trim());
}

/**
 * @mentions in Team MKY: longest label first so "@John Doe" wins over "@John".
 * candidates: { booking_ref, label }[]
 */
export function parseMentions(body, candidates = []) {
  const text = String(body ?? '');
  const found = [];
  const used = [];
  const sorted = [...candidates]
    .map((c) => ({ booking_ref: c.booking_ref, label: String(c.label ?? '').trim() }))
    .filter((c) => c.booking_ref && c.label)
    .sort((a, b) => b.label.length - a.label.length || a.label.localeCompare(b.label));

  for (const c of sorted) {
    const needle = `@${c.label}`;
    const lower = text.toLowerCase();
    const want = needle.toLowerCase();
    let from = 0;
    while (from < text.length) {
      const i = lower.indexOf(want, from);
      if (i < 0) break;
      const end = i + needle.length;
      const boundary = end >= text.length || /[\s.,;:!?)\]}]/.test(text[end]);
      if (boundary && !used.some(([s, e]) => i < e && end > s)) {
        found.push({ booking_ref: c.booking_ref, label: c.label, start: i, end });
        used.push([i, end]);
      }
      from = i + 1;
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Autocomplete tags for Team MKY: customer name and VIN per Port Sum row. */
export function mentionCandidates(rows = []) {
  const out = [];
  for (const r of rows) {
    if (!isPortSumRow(r)) continue;
    const name = String(r.customer_name ?? '').trim();
    const vin = String(r.vin ?? '').trim();
    if (name) out.push({ booking_ref: r.booking_ref, label: name, kind: 'name' });
    if (vin) out.push({ booking_ref: r.booking_ref, label: vin, kind: 'vin' });
  }
  return out;
}

function fundsOf(b) {
  const key = FUNDS_KEYS.includes(b?.port_funds_status) ? b.port_funds_status : 'not_received';
  return { key, words: FUNDS[key] };
}

function routeOf(b) {
  return `${shortPort(b.origin_port) || '?'} → ${shortPort(b.destination_port) || '?'}`;
}

function docChip(d) {
  const ours = d.doc_type === 'mky';
  return {
    id: d.id,
    label: ours ? (d.file_name || 'MKY file') : (DOC_LABEL[d.doc_type] ?? d.doc_type ?? 'Document'),
    doc_type: d.doc_type,
    sent_by_mky: ours,
    file_name: d.file_name ?? null,
    has_file: Boolean(d.storage_path),
  };
}

async function docsForRefs(refs) {
  if (!refs.length) return new Map();
  const { data, error } = await db().from('booking_documents')
    .select('id, booking_ref, doc_type, file_name, storage_path, status, vin, uploaded_at')
    .in('booking_ref', refs).is('deleted_at', null)
    .order('uploaded_at', { ascending: false });
  if (error) throw new Error(error.message);
  const map = new Map();
  for (const d of data ?? []) {
    if (!map.has(d.booking_ref)) map.set(d.booking_ref, []);
    map.get(d.booking_ref).push(d);
  }
  return map;
}

function rowOut(b, docs = []) {
  const funds = fundsOf(b);
  return {
    booking_ref: b.booking_ref,
    route: routeOf(b),
    origin_port: b.origin_port,
    destination_port: b.destination_port,
    customer_name: b.customer_name || null,
    employee: b.assigned_to || null,
    vin: b.vin || null,
    vehicle: [b.make, b.model].filter(Boolean).join(' ') || null,
    status: b.status,
    status_words: statusWords(b.status),
    status_tone: statusTone(b.status) ?? 'gray',
    port_amount: b.port_amount ?? null,
    port_funds_status: funds.key,
    port_funds_words: funds.words,
    channel: b.channel ?? channelOf(b.chat_id),
    chat_id: b.chat_id ?? null,
    documents: docs.map(docChip),
    created_at: b.created_at,
    version: bookingVersion(b, docs, null),
  };
}

/** GET view=port_sum&filter=all|mine&q=&limit=&after= */
export async function portSumList(req, res, who) {
  const filter = String(req.query.filter ?? 'all');
  const q = String(req.query.q ?? '').trim();
  const limit = Math.min(Math.max(Number(req.query.limit) || PAGE, 1), MAX_PAGE);
  const after = parseCursor(req.query.after);
  const mine = filter === 'mine';

  let query = db().from('bookings').select(LIST_COLUMNS)
    .not('vin', 'is', null).not('origin_port', 'is', null).not('destination_port', 'is', null)
    .not('status', 'in', '("cancelled","expired","rejected")')
    .order('created_at', { ascending: false }).order('booking_ref', { ascending: false });

  if (mine) query = query.ilike('assigned_to', who.name);

  const pushed = q && !SYNTAX.test(q);
  const search = pushed
    ? ['booking_ref', 'customer_name', 'vin', 'origin_port', 'destination_port', 'assigned_to']
      .map((c) => `${c}.ilike.%${q}%`).join(',')
    : null;
  const rest = after
    ? `created_at.lt."${after.at}",and(created_at.eq."${after.at}",booking_ref.lt."${after.id}")`
    : null;
  if (search && rest) query = query.or(`and(or(${search}),or(${rest}))`);
  else if (search || rest) query = query.or(search ?? rest);
  query = query.limit(limit + 1);

  const [{ data, error }, team] = await Promise.all([
    query,
    teamList().catch(() => []),
  ]);
  if (error) {
    if (isMissingSchema(error)) {
      return res.status(200).json({
        filter, rows: [], next: null, funds: FUNDS, team: [],
        pending: 'Port Sum Up starts once the database update is applied.',
      });
    }
    return res.status(500).json({ error: 'We could not load Port Sum Up.' });
  }

  // Empty VIN/ports can still sneak past .not('…','is',null) as ''.
  let page = (data ?? []).filter(isPortSumRow).slice(0, limit);
  if (q && !pushed) {
    const needle = q.toLowerCase();
    page = page.filter((b) => [b.booking_ref, b.customer_name, b.vin, b.origin_port, b.destination_port, b.assigned_to]
      .some((v) => String(v ?? '').toLowerCase().includes(needle)));
  }

  let docsMap = new Map();
  try {
    docsMap = await docsForRefs(page.map((b) => b.booking_ref));
  } catch {
    docsMap = new Map();
  }

  const rows = page.map((b) => rowOut(b, docsMap.get(b.booking_ref) ?? []));
  const next = (data ?? []).length > limit && page.length ? cursorOf(page.at(-1)) : null;
  const people = (team ?? []).filter((u) => u.active !== false)
    .map((u) => ({ name: u.name, role: u.role }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.status(200).json({
    filter,
    total: rows.length,
    rows,
    next,
    funds: FUNDS,
    team: people,
    can_assign_others: who.can('assign_others'),
    can_edit: who.can('status') || who.can('assign_self'),
  });
}

/** GET view=port_sum_detail&ref= */
export async function portSumDetail(req, res, who) {
  const ref = String(req.query.ref ?? '').trim();
  if (!ref) return res.status(400).json({ error: 'ref is required' });

  let state;
  try {
    state = await loadBooking(ref);
  } catch (err) {
    if (isMissingSchema(err)) {
      return res.status(503).json({ error: 'Port Sum Up starts once the database update is applied.' });
    }
    return res.status(500).json({ error: 'We could not load this order.' });
  }
  if (!state) return res.status(404).json({ error: `There is no booking ${ref}.` });
  // An order that has left the list - cancelled, or its chassis taken off -
  // still opens: a Team MKY message from last week names it, and the page
  // shows its status, which says why it is no longer on Port Sum Up.
  const { booking, docs, mrn, version } = state;

  const declared = declaredMrn(docs);
  const docsOut = docs.map((d) => documentOut(d, booking, { declared }));
  const [{ data: shipment }, team] = await Promise.all([
    db().from('shipments').select('shipment_id, status, eta, vessel')
      .eq('booking_ref', ref).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
    teamList().catch(() => []),
  ]);

  const funds = fundsOf(booking);
  const people = (team ?? []).filter((u) => u.active !== false)
    .map((u) => ({ name: u.name, role: u.role }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.status(200).json({
    booking_ref: ref,
    route: routeOf(booking),
    origin_port: booking.origin_port,
    destination_port: booking.destination_port,
    customer_name: booking.customer_name || null,
    customer_contact: booking.customer_contact || null,
    employee: booking.assigned_to || null,
    vin: booking.vin || null,
    vehicle: [booking.make, booking.model].filter(Boolean).join(' ') || null,
    make: booking.make || null,
    model: booking.model || null,
    status: booking.status,
    status_words: statusWords(booking.status),
    status_tone: statusTone(booking.status) ?? 'gray',
    port_amount: booking.port_amount ?? null,
    port_funds_status: funds.key,
    port_funds_words: funds.words,
    channel: booking.channel ?? channelOf(booking.chat_id),
    chat_id: booking.chat_id ?? null,
    documents: docsOut,
    mky_documents: docsOut.filter((d) => d.sent_by_mky),
    customer_documents: docsOut.filter((d) => !d.sent_by_mky),
    shipment: shipment ?? null,
    mrn: mrn ? { request_ref: mrn.request_ref, status: mrn.status, mrn_number: mrn.mrn_number } : null,
    version,
    funds: FUNDS,
    team: people,
    can_assign_others: who.can('assign_others'),
    can_edit: who.can('status') || who.can('assign_self'),
    assign_reason: who.can('assign_others') ? null : deniedReason('assign_others', who.role),
  });
}

/** POST action=port_sum_update — amount and/or funds status. */
export async function portSumUpdate(req, res, who) {
  if (!who.can('status') && !who.can('assign_self')) {
    return res.status(403).json({ error: deniedReason('status', who.role) });
  }
  const ref = String(req.body.booking_ref ?? '').trim();
  if (!ref) return res.status(400).json({ error: 'booking_ref is required' });

  const patch = {};
  if ('port_amount' in req.body) {
    const raw = req.body.port_amount;
    if (raw === '' || raw == null) patch.port_amount = null;
    else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'Amount must be a number zero or more.' });
      patch.port_amount = n;
    }
  }
  if ('port_funds_status' in req.body) {
    const key = String(req.body.port_funds_status ?? '').trim();
    if (!FUNDS_KEYS.includes(key)) {
      return res.status(400).json({ error: 'Status must be Not Received, Received or In process.' });
    }
    patch.port_funds_status = key;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });

  const { data: before, error: readErr } = await db().from('bookings')
    .select('booking_ref, port_amount, port_funds_status, assigned_to, status, vin, origin_port, destination_port, customer_name, make, model, priority, mrn_number')
    .eq('booking_ref', ref).maybeSingle();
  if (readErr) {
    if (isMissingSchema(readErr)) {
      return res.status(503).json({ error: 'Port Sum Up starts once the database update is applied.' });
    }
    return res.status(500).json({ error: 'We could not load this order.' });
  }
  if (!before) return res.status(404).json({ error: `There is no booking ${ref}.` });

  const { data, error } = await db().from('bookings').update(patch).eq('booking_ref', ref)
    .select(LIST_COLUMNS).maybeSingle();
  if (error) {
    if (isMissingSchema(error)) {
      return res.status(503).json({ error: 'Port Sum Up starts once the database update is applied.' });
    }
    return res.status(500).json({ error: 'We could not save that.' });
  }

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'port_sum_updated',
    entity_type: 'booking', entity_id: ref,
    metadata: { from: { port_amount: before.port_amount, port_funds_status: before.port_funds_status }, to: patch },
  });

  // The papers again, so the row that goes back is the whole row and not one
  // with its documents emptied. No version: the amount and the funds status
  // are not part of a booking's fingerprint, so this write did not move it,
  // and handing back one worked out without the papers and the MRN would make
  // the next save on the same screen bounce as stale.
  let docs = [];
  try {
    docs = (await docsForRefs([ref])).get(ref) ?? [];
  } catch {
    docs = [];
  }

  res.status(200).json({ ok: true, row: rowOut(data, docs) });
}

/** Candidates for @ autocomplete (Port Sum rows only). */
export async function portSumMentions(req, res) {
  const { data, error } = await db().from('bookings')
    .select('booking_ref, customer_name, vin, origin_port, destination_port, status')
    .not('vin', 'is', null).not('origin_port', 'is', null).not('destination_port', 'is', null)
    .not('status', 'in', '("cancelled","expired","rejected")')
    .order('created_at', { ascending: false }).limit(500);
  if (error) {
    if (isMissingSchema(error)) return res.status(200).json({ candidates: [] });
    return res.status(500).json({ error: 'We could not load mention tags.' });
  }
  res.status(200).json({ candidates: mentionCandidates((data ?? []).filter(isPortSumRow)) });
}

/** GET view=team_mky&after= */
export async function teamMkyList(req, res) {
  const limit = Math.min(Math.max(Number(req.query.limit) || 80, 1), 200);
  const afterId = Number(req.query.after);
  let query = db().from('team_messages').select('id, author, body, mentions, created_at')
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1);
  if (Number.isFinite(afterId) && afterId > 0) query = query.lt('id', afterId);

  const { data, error } = await query;
  if (error) {
    if (isMissingSchema(error)) {
      return res.status(200).json({
        rows: [], next: null,
        pending: 'Team MKY starts once the database update is applied.',
      });
    }
    return res.status(500).json({ error: 'We could not load Team MKY.' });
  }
  const page = (data ?? []).slice(0, limit);
  const rows = page.map((m) => ({
    id: m.id,
    author: m.author,
    body: m.body,
    mentions: Array.isArray(m.mentions) ? m.mentions : [],
    at: m.created_at,
  })).reverse();
  const next = (data ?? []).length > limit && page.length ? page.at(-1).id : null;
  res.status(200).json({ rows, next });
}

/** POST action=team_message */
export async function teamMkyPost(req, res, who) {
  if (!who.can('notes')) {
    return res.status(403).json({ error: deniedReason('notes', who.role) || 'Your role cannot post in Team MKY.' });
  }
  const body = String(req.body.body ?? '').trim();
  if (body.length < 1) return res.status(400).json({ error: 'The message is empty.' });
  if (body.length > 4000) return res.status(400).json({ error: 'Keep a message under 4000 characters.' });

  const { data: bookings } = await db().from('bookings')
    .select('booking_ref, customer_name, vin, origin_port, destination_port, status')
    .not('vin', 'is', null).not('origin_port', 'is', null).not('destination_port', 'is', null)
    .not('status', 'in', '("cancelled","expired","rejected")')
    .order('created_at', { ascending: false }).limit(500);
  const candidates = mentionCandidates((bookings ?? []).filter(isPortSumRow));
  const parsed = parseMentions(body, candidates);
  const mentions = parsed.map(({ booking_ref, label, start, end }) => ({ booking_ref, label, start, end }));

  const { data, error } = await db().from('team_messages')
    .insert({ author: who.name, body, mentions })
    .select('id, author, body, mentions, created_at')
    .single();
  if (error) {
    if (isMissingSchema(error)) {
      return res.status(503).json({ error: 'Team MKY starts once the database update is applied.' });
    }
    return res.status(500).json({ error: 'We could not send that.' });
  }

  res.status(200).json({
    ok: true,
    message: {
      id: data.id, author: data.author, body: data.body,
      mentions: Array.isArray(data.mentions) ? data.mentions : [],
      at: data.created_at,
    },
  });
}
