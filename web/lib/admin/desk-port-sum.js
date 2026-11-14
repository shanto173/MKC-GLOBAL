/**
 * Port Sum Up and Team MKY for the operations desk.
 *
 * A row appears as soon as a booking has origin port, destination port and
 * VIN — drafts included, documents optional. Funds amount/status and assignee
 * live on the booking; Team MKY is a shared staff chat that can @ a customer
 * name or chassis and open that Port Sum Up row.
 *
 * Written for a desk with thousands of orders on it, the way Shipments is
 * (lib/admin/desk-shipments.js): the database does the filtering, the
 * counting and the paging, the list reads only the columns it shows, and the
 * papers of a page are read in chunks - one `in` list of three hundred
 * references is a URL PostgREST refuses. Team MKY reads the orders a message
 * actually names, not every order there is.
 */

import { db } from '../supabase.js';
import { channelOf } from '../channels.js';
import { DOC_LABEL, statusWords, statusTone } from '../ops/workflow.js';
import {
  deniedReason, teamList, isMissingSchema, inChunks,
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
const HIDDEN_IN = '("cancelled","expired","rejected")';
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

/**
 * The predicates that decide a Port Sum Up row, on any query of bookings -
 * the list, and each of the counts beside the filter. They are the partial
 * index the migration adds, so the database reads an index and not the table.
 * A VIN or a port that is there but empty is excluded here rather than in
 * JavaScript, so a count and its page agree.
 */
function listable(query) {
  return query
    .not('vin', 'is', null).neq('vin', '')
    .not('origin_port', 'is', null).neq('origin_port', '')
    .not('destination_port', 'is', null).neq('destination_port', '')
    .not('status', 'in', HIDDEN_IN);
}

/** One person's orders, by name, with `%` and `_` left as themselves. */
const mineOf = (query, name) => query.ilike('assigned_to', String(name ?? '').replace(/[%_]/g, (c) => `\\${c}`));

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

/**
 * What a message might be tagging: after each `@`, the first word, the first
 * two words, and so on - "Please check @John Doe today" asks about "John",
 * "John Doe" and "John Doe today", and the database says which of the three
 * is somebody. That is a handful of exact lookups per message, whatever the
 * desk holds; reading every order to find out does not stay possible.
 *
 * A token with a character PostgREST's or() reads as syntax is left out: it
 * cannot be asked for safely, and a customer name does not need one.
 */
const MENTION_WORDS = 6;
const MENTION_TOKENS = 12;
export function mentionTokens(body, { words = MENTION_WORDS, max = MENTION_TOKENS } = {}) {
  const text = String(body ?? '');
  const seen = new Set();
  const out = [];
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    const rest = text.slice(i + 1);
    const run = /^[^\n@]*/.exec(rest)[0];
    const parts = run.split(/\s+/).filter(Boolean).slice(0, words);
    for (let n = 1; n <= parts.length; n += 1) {
      const token = parts.slice(0, n).join(' ').replace(/[.,;:!?)\]}]+$/, '').trim();
      const key = token.toLowerCase();
      if (!token || seen.has(key) || SYNTAX.test(token)) continue;
      seen.add(key);
      out.push(token);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** The orders a message's `@`s could name, read by those tokens alone. */
async function candidatesForBody(body) {
  const tokens = mentionTokens(body);
  if (!tokens.length) return [];
  const or = tokens.flatMap((t) => [`customer_name.ilike."${t}"`, `vin.ilike."${t}"`]).join(',');
  const { data, error } = await listable(db().from('bookings')
    .select('booking_ref, customer_name, vin, origin_port, destination_port, status'))
    .or(or).limit(200);
  if (error) return [];
  return mentionCandidates((data ?? []).filter(isPortSumRow));
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

/**
 * The papers of a page of orders, by reference. In chunks: three hundred
 * references in one `in` list is a query string of some kilobytes, which
 * PostgREST answers with 414 rather than rows - so the list of a busy desk
 * would show every order with no papers at all, or fail outright.
 */
async function docsForRefs(refs) {
  if (!refs.length) return new Map();
  const { data, error } = await inChunks(refs, (chunk) => db().from('booking_documents')
    .select('id, booking_ref, doc_type, file_name, storage_path, status, vin, uploaded_at')
    .in('booking_ref', chunk).is('deleted_at', null)
    .order('uploaded_at', { ascending: false }));
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
    // No version on a list row. A booking's fingerprint counts its MRN
    // application, which a page of a hundred orders does not read, so the one
    // worked out here would be wrong for every order that has one - and an
    // action sent with it would be refused as stale every time. The desk's
    // own checks stand instead: an agent cannot take an order a colleague
    // has, and an amount is last-word-wins between two people on one order.
  };
}

/** GET view=port_sum&filter=all|mine&funds=&q=&limit=&after= */
export async function portSumList(req, res, who) {
  const filter = String(req.query.filter ?? 'all');
  const funds = FUNDS_KEYS.includes(String(req.query.funds)) ? String(req.query.funds) : 'any';
  const q = String(req.query.q ?? '').trim();
  const limit = Math.min(Math.max(Number(req.query.limit) || PAGE, 1), MAX_PAGE);
  const after = parseCursor(req.query.after);
  const mine = filter === 'mine';

  let query = listable(db().from('bookings').select(LIST_COLUMNS))
    .order('created_at', { ascending: false }).order('booking_ref', { ascending: false });

  if (mine) query = mineOf(query, who.name);
  if (funds !== 'any') query = query.eq('port_funds_status', funds);

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

  // How many each funds state holds, for the numbers beside the filter, and
  // how many orders there are in all, so a page can say "100 of 412". Counted
  // in the database, never fetched; and not again for a next page, which is
  // the same list further down. Received is what is left, so three counts
  // answer four numbers.
  const countOf = (state) => {
    let c = listable(db().from('bookings').select('booking_ref', { count: 'exact', head: true }));
    if (mine) c = mineOf(c, who.name);
    return state ? c.eq('port_funds_status', state) : c;
  };
  const [{ data, error }, team, all, notReceived, inProcess] = await Promise.all([
    query,
    teamList().catch(() => []),
    after || q ? { count: null } : countOf(null),
    after || q ? { count: null } : countOf('not_received'),
    after || q ? { count: null } : countOf('in_process'),
  ]);
  if (error) {
    if (isMissingSchema(error)) {
      return res.status(200).json({
        filter, funds, rows: [], next: null, counts: null, funds_words: FUNDS, team: [],
        pending: 'Port Sum Up starts once the database update is applied.',
      });
    }
    return res.status(500).json({ error: 'We could not load Port Sum Up.' });
  }
  const counts = after || q || all.error || notReceived.error || inProcess.error ? null : {
    any: all.count ?? 0,
    not_received: notReceived.count ?? 0,
    in_process: inProcess.count ?? 0,
    received: Math.max(0, (all.count ?? 0) - (notReceived.count ?? 0) - (inProcess.count ?? 0)),
  };

  // A VIN or port of nothing but spaces is the one thing the query cannot say.
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
    funds,
    total: rows.length,
    counts,
    rows,
    next,
    funds_words: FUNDS,
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
    funds_words: FUNDS,
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

/**
 * GET view=port_sum_mentions&q=&limit= — what the `@` list offers.
 *
 * Searched in the database for what has been typed so far, a handful at a
 * time. It used to hand the browser every order it could find, five hundred
 * of them, on every visit to Team MKY: a list that gets slower as the desk
 * gets busier, and that quietly stops offering the older orders altogether.
 */
export async function portSumMentions(req, res) {
  const q = String(req.query.q ?? '').trim();
  const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 25);
  let query = listable(db().from('bookings')
    .select('booking_ref, customer_name, vin, origin_port, destination_port, status'))
    .order('created_at', { ascending: false });
  if (q && !SYNTAX.test(q)) query = query.or(`customer_name.ilike.%${q}%,vin.ilike.%${q}%`);
  // Two tags can come from one order (its name and its chassis), so read a
  // few more rows than the number of tags asked for.
  const { data, error } = await query.limit(limit * 2);
  if (error) {
    if (isMissingSchema(error)) return res.status(200).json({ candidates: [] });
    return res.status(500).json({ error: 'We could not load mention tags.' });
  }
  const needle = q.toLowerCase();
  const candidates = mentionCandidates((data ?? []).filter(isPortSumRow))
    .filter((c) => !needle || c.label.toLowerCase().includes(needle))
    .slice(0, limit);
  res.status(200).json({ candidates });
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

  const parsed = parseMentions(body, await candidatesForBody(body));
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
