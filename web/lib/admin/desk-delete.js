/**
 * Deleting a record, and taking it back.
 *
 *   GET  view=delete_preview&kind=…&reference=…   what would go, counted
 *   GET  view=deleted                             what was deleted, and when it goes for good
 *   POST { action: 'delete_record', kind, reference, confirm }
 *   POST { action: 'restore_record', id }
 *
 * Administrators only, and the request must carry `confirm` spelled exactly as
 * the reference - the screen makes somebody type MKY-BKG-2 rather than press a
 * red button, because the red button is pressed on the wrong row eventually.
 *
 * WHAT A DELETION IS HERE.
 *
 * The rows are really deleted, and kept whole in `deleted_records` for thirty
 * days (supabase/migrations/20261012150000_desk_deletions.sql explains why that
 * rather than a deleted_at column on fourteen tables). So the desk needs no
 * "and not deleted" anywhere: a record that is gone is gone from every screen,
 * every count and every search the moment it goes, which is the whole point of
 * a feature whose reason for existing is "we are deleting confidential data".
 *
 * The files in the bucket are the exception: they stay where they are so a
 * restore can find them, and the purge removes them when the thirty days are
 * up. Until then the paperwork is still in storage, behind the same private
 * bucket it always was - that is the price of being able to undo a mistake,
 * and it is what "recoverable for 30 days" means.
 *
 * WHAT A DELETION IS NOT.
 *
 * It is not a way to erase what the team did. The audit trail is never part of
 * a payload and is never deleted: "Omar confirmed MKY-BKG-3" stays true, and
 * the deletion itself is written to it with who did it and what went.
 */

import { db } from '../supabase.js';
import { audit } from '../audit.js';
import { removeObjects, BUCKET } from '../storage.js';
import { defer } from '../background.js';
import { invalidateTeam, teamList } from './desk-shared.js';
import { sheetPath } from './desk-media.js';
import { DOC_LABEL } from '../ops/workflow.js';

/** How long a deleted record can be taken back. */
export const KEEP_DAYS = 30;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// What goes with what
// ---------------------------------------------------------------------------

/**
 * A step of a deletion: one table, and which of its rows belong to this record.
 * `match` is given the PostgREST builder and narrows it; the order of the steps
 * is the order the rows are deleted in - children first, the record itself
 * last - and a restore walks it backwards.
 */
const step = (table, match) => ({ table, match });

/** The kinds, in the words the dialog uses. */
export const KIND_WORDS = {
  booking: 'booking',
  request: 'customer request',
  mrn: 'MRN application',
  shipment: 'shipment',
  customer: 'customer',
  person: 'team member',
  // The rows a person is looking at one of, rather than records with children:
  // one paper, one note, one message, one queued message, one shipment update.
  document: 'document',
  note: 'internal note',
  message: 'message',
  queued: 'queued message',
  event: 'shipment update',
};

/** "12 Oct", in Cairo, for a label somebody reads before they type. */
const shortDate = (at) => (at
  ? new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Cairo' })
  : 'an unknown date');

/** One row, by the id the screen drew it from. */
async function oneRow(table, reference) {
  const id = Number(reference);
  if (!Number.isFinite(id)) return null;
  const { data } = await db().from(table).select('*').eq('id', id).maybeSingle();
  return data ?? null;
}

/** The whole plan for a kind that is one row: that row, and the file it owns. */
const justThisRow = (table, row) => [step(table, (q) => q.eq('id', row.id))];

/** The first few words of a message, so a label says which one. */
function snippet(text, max = 50) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Deliberately narrow. A booking takes its own paperwork with it and nothing
 * else: a shipment that has sailed is a thing in the world, and a support
 * request is its own conversation with its own customer. Anybody who means
 * "all of it" deletes the customer, which says so in as many words.
 */
async function planFor(kind, reference) {
  const ref = String(reference ?? '').trim();
  if (!ref) return null;

  if (kind === 'booking') {
    const { data } = await db().from('bookings').select('*').eq('booking_ref', ref).maybeSingle();
    if (!data) return null;
    return {
      label: `${data.customer_name ?? 'Unknown customer'} — booking ${ref}`,
      steps: [
        step('notification_outbox', (q) => q.eq('entity_id', ref)),
        step('operations_tasks', (q) => q.eq('booking_ref', ref)),
        step('internal_notes', (q) => q.eq('booking_ref', ref)),
        step('mrn_requests', (q) => q.eq('booking_ref', ref)),
        step('booking_documents', (q) => q.eq('booking_ref', ref)),
        step('bookings', (q) => q.eq('booking_ref', ref)),
      ],
    };
  }

  if (kind === 'request') {
    const { data } = await db().from('support_tickets').select('*').eq('ticket_ref', ref).maybeSingle();
    if (!data) return null;
    return {
      label: `${data.customer ?? 'Unknown customer'} — request ${ref}`,
      steps: [
        step('notification_outbox', (q) => q.eq('entity_id', ref)),
        step('operations_tasks', (q) => q.eq('idempotency_key', `ticket:${ref}`)),
        step('internal_notes', (q) => q.eq('entity_id', ref)),
        step('support_tickets', (q) => q.eq('ticket_ref', ref)),
      ],
    };
  }

  if (kind === 'mrn') {
    const { data } = await db().from('mrn_requests').select('*').eq('request_ref', ref).maybeSingle();
    if (!data) return null;
    return {
      label: `MRN application ${ref}${data.booking_ref ? ` (${data.booking_ref})` : ''}`,
      steps: [
        step('notification_outbox', (q) => q.eq('entity_id', ref)),
        step('operations_tasks', (q) => q.eq('mrn_request_id', data.id)),
        step('mrn_requests', (q) => q.eq('request_ref', ref)),
      ],
    };
  }

  if (kind === 'shipment') {
    const { data } = await db().from('shipments').select('*').eq('shipment_id', ref).maybeSingle();
    if (!data) return null;
    return {
      label: `${data.customer_name ?? 'Unknown customer'} — shipment ${ref}`,
      steps: [
        step('notification_outbox', (q) => q.eq('entity_id', ref)),
        step('operations_tasks', (q) => q.eq('shipment_id', ref)),
        step('shipment_events', (q) => q.eq('shipment_id', ref)),
        step('shipments', (q) => q.eq('shipment_id', ref)),
      ],
    };
  }

  if (kind === 'customer') {
    const id = Number(ref);
    if (!Number.isFinite(id)) return null;
    const { data } = await db().from('clients').select('*').eq('id', id).maybeSingle();
    if (!data) return null;

    // Everything of theirs is found through the client id, except the rows
    // that only carry a booking reference - those are looked up from their
    // bookings first, so a deletion takes the notes and papers with it.
    const { data: theirs } = await db().from('bookings').select('booking_ref').eq('client_id', id);
    const refs = (theirs ?? []).map((b) => b.booking_ref).filter(Boolean);
    const shipIds = refs.length
      ? ((await db().from('shipments').select('shipment_id').in('booking_ref', refs)).data ?? []).map((s) => s.shipment_id)
      : [];

    const byRefs = (column) => (q) => (refs.length ? q.in(column, refs) : null);
    return {
      label: `${data.display_name || data.full_name || data.whatsapp_name || `Customer ${id}`} — everything`,
      steps: [
        step('notification_outbox', (q) => q.eq('client_id', id)),
        step('operations_tasks', (q) => q.eq('client_id', id)),
        step('internal_notes', byRefs('booking_ref')),
        step('shipment_events', (q) => (shipIds.length ? q.in('shipment_id', shipIds) : null)),
        step('shipments', (q) => (shipIds.length ? q.in('shipment_id', shipIds) : null)),
        step('mrn_requests', (q) => q.eq('client_id', id)),
        step('support_tickets', (q) => q.eq('client_id', id)),
        step('booking_documents', (q) => q.eq('client_id', id)),
        step('bookings', (q) => q.eq('client_id', id)),
        step('chat_messages', (q) => q.eq('client_id', id)),
        step('conversation_sessions', (q) => q.eq('client_id', id)),
        step('clients', (q) => q.eq('id', id)),
      ],
    };
  }

  if (kind === 'person') {
    const rows = await teamList({ fresh: true }).catch(() => []);
    const person = (rows ?? []).find((u) => String(u.name).toLowerCase() === ref.toLowerCase());
    if (!person) return null;
    return {
      label: `${person.name} — team member`,
      // Their name on past decisions is history, not their account: it stays.
      note: `What ${person.name} did stays on the record. Only their sign-in goes.`,
      steps: [step('ops_users', (q) => q.eq('name', person.name))],
    };
  }

  // -- the rows somebody is looking at one of -------------------------------
  //
  // One paper, one note, one message. These have no children: what goes is
  // the row and the file it owns, which filesIn() finds in the row itself. The
  // reference is the id the screen drew the row from, and that is what has to
  // be typed - nobody can press Delete on the line above by accident.

  if (kind === 'document') {
    const row = await oneRow('booking_documents', ref);
    if (!row) return null;
    const what = DOC_LABEL[row.doc_type] ?? 'Document';
    return {
      label: `${what}${row.booking_ref ? ` for ${row.booking_ref}` : ' on no booking'}${row.file_name ? ` (${row.file_name})` : ''}, uploaded ${shortDate(row.uploaded_at ?? row.created_at)}`,
      note: row.booking_ref
        ? `If ${row.booking_ref} still requires this paper, the bot counts it as missing again and may ask the customer for it.`
        : 'The file goes with it, and the bot will no longer count it towards a booking the customer starts.',
      steps: justThisRow('booking_documents', row),
    };
  }

  if (kind === 'note') {
    const row = await oneRow('internal_notes', ref);
    if (!row) return null;
    const on = row.booking_ref || row.entity_id;
    return {
      label: `Internal note by ${row.author || 'the team'}${on ? ` on ${on}` : ''}, ${shortDate(row.created_at)}${snippet(row.body) ? ` — “${snippet(row.body)}”` : ''}`,
      steps: justThisRow('internal_notes', row),
    };
  }

  if (kind === 'message') {
    const row = await oneRow('chat_messages', ref);
    if (!row) return null;
    const who = row.direction === 'in' ? 'from the customer'
      : `to the customer${row.staff_name ? ` from ${row.staff_name}` : row.author === 'bot' ? ' from the bot' : ''}`;
    const said = snippet(row.body) || (row.kind && row.kind !== 'text' ? `[${row.kind}]` : '');
    return {
      label: `Message ${who}, ${shortDate(row.created_at)}${said ? ` — “${said}”` : ''}`,
      // What was sent was sent; this takes it off the desk, not off their phone.
      note: 'The rest of the conversation stays. If it was delivered, the customer still has it.',
      steps: justThisRow('chat_messages', row),
    };
  }

  if (kind === 'queued') {
    const row = await oneRow('notification_outbox', ref);
    if (!row) return null;
    const sent = row.status === 'sent';
    return {
      label: `Queued ${row.event_type ? `${row.event_type} ` : ''}message${row.entity_id ? ` for ${row.entity_id}` : ''} (${row.status ?? 'unknown'}), from ${shortDate(row.created_at)}`,
      note: sent
        ? 'This one was already sent; deleting it only removes the desk’s record of sending it.'
        : 'This message has not been sent. Deleting it means it never will be, and its issue leaves the Inbox.',
      steps: justThisRow('notification_outbox', row),
    };
  }

  if (kind === 'event') {
    const row = await oneRow('shipment_events', ref);
    if (!row) return null;
    return {
      label: `Shipment update on ${row.shipment_id}: ${snippet(row.description) || 'no description'}, ${shortDate(row.event_time ?? row.created_at)}`,
      note: 'The shipment itself, its status and what the customer was told stay as they are.',
      steps: justThisRow('shipment_events', row),
    };
  }

  return null;
}

/** The rows one step would take, read whole so they can be put back. */
async function rowsFor(stepped) {
  const query = stepped.match(db().from(stepped.table).select('*'));
  if (!query) return [];
  const { data, error } = await query;
  // A table the migrations have not created here is not an error: there is
  // nothing of this record in a table that does not exist.
  if (error) {
    if (/does not exist|schema cache/i.test(String(error.message))) return [];
    throw new Error(`${stepped.table}: ${error.message}`);
  }
  return data ?? [];
}

/** Every file in the bucket that these rows own. */
function filesIn(table, rows) {
  const out = [];
  for (const row of rows) {
    if (table === 'booking_documents' && row.storage_path) {
      out.push({ bucket: row.storage_bucket || BUCKET, path: row.storage_path });
    }
    if (table === 'chat_messages' && row.payload?.storage_path) {
      out.push({ bucket: row.payload.storage_bucket || BUCKET, path: row.payload.storage_path });
    }
  }
  return out;
}

/**
 * Everything a deletion would take: the rows, the files, and the counts the
 * dialog shows. Reading it all first is what makes the dialog honest and the
 * ledger complete.
 */
export async function gather(kind, reference) {
  const plan = await planFor(kind, reference);
  if (!plan) return null;

  const payload = [];
  const files = [];
  const counts = {};
  const steps = [];
  for (const stepped of plan.steps) {
    const rows = await rowsFor(stepped);
    if (!rows.length) continue;
    payload.push({ table: stepped.table, rows });
    counts[stepped.table] = rows.length;
    files.push(...filesIn(stepped.table, rows));
    // Kept so the deletion narrows each table exactly as the reading did,
    // without planning again from a database it is halfway through changing.
    steps.push(stepped);
  }

  // A sheet the desk made again from a booking it is about to delete
  // (lib/admin/desk-media.js keeps one object per booking) is that booking's
  // data in the bucket, so it goes with it at the purge. Kept apart from
  // `files`: the dialog tells somebody what of theirs goes, and a rebuilt copy
  // of a sheet is not a second paper they sent.
  const derived = (payload.find((p) => p.table === 'bookings')?.rows ?? [])
    .map((b) => b.booking_ref).filter(Boolean)
    .map((ref) => ({ bucket: BUCKET, path: sheetPath(ref) }));

  return { kind, reference: String(reference), label: plan.label, note: plan.note ?? null, payload, files, derived, counts, steps };
}

/** The counts in the words the dialog reads out. */
const TABLE_WORDS = {
  bookings: ['booking', 'bookings'],
  booking_documents: ['document', 'documents'],
  support_tickets: ['customer request', 'customer requests'],
  mrn_requests: ['MRN application', 'MRN applications'],
  shipments: ['shipment', 'shipments'],
  shipment_events: ['shipment update', 'shipment updates'],
  chat_messages: ['message', 'messages'],
  conversation_sessions: ['conversation', 'conversations'],
  internal_notes: ['internal note', 'internal notes'],
  operations_tasks: ['task', 'tasks'],
  notification_outbox: ['queued message', 'queued messages'],
  clients: ['customer record', 'customer records'],
  ops_users: ['sign-in', 'sign-ins'],
};

export function countWords(counts, files = 0) {
  const parts = [];
  // Backwards through the delete order, so the record itself - deleted last,
  // after its children - is named first: "1 booking, 1 document, 1 file"
  // rather than "1 document, 1 booking".
  for (const [table, n] of Object.entries(counts ?? {}).reverse()) {
    const words = TABLE_WORDS[table];
    if (!words || !n) continue;
    parts.push(`${n} ${n === 1 ? words[0] : words[1]}`);
  }
  if (files) parts.push(`${files} ${files === 1 ? 'file' : 'files'}`);
  return parts;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** GET view=delete_preview&kind=&reference= - what the dialog shows before anybody types. */
export async function deletePreview(req, res, who) {
  if (!who.can('delete')) return res.status(403).json({ error: 'Only an administrator can delete records.' });
  const kind = String(req.query.kind ?? '');
  const reference = String(req.query.reference ?? '');
  if (!KIND_WORDS[kind]) return res.status(400).json({ error: `Unknown kind "${kind}".` });

  let found;
  try {
    found = await gather(kind, reference);
  } catch (err) {
    return res.status(500).json({ error: `We could not read what would go: ${err.message}` });
  }
  if (!found) return res.status(404).json({ error: 'That record is no longer here.' });

  return res.status(200).json({
    kind,
    kind_words: KIND_WORDS[kind],
    reference: found.reference,
    label: found.label,
    note: found.note,
    counts: found.counts,
    files: found.files.length,
    words: countWords(found.counts, found.files.length),
    keep_days: KEEP_DAYS,
    // What has to be typed before Delete turns on.
    confirm_with: confirmWord(kind, found),
  });
}

/** What somebody types to prove they mean this record and not the one above it. */
function confirmWord(kind, found) {
  if (kind !== 'customer') return found.reference;
  // A customer's reference is a database id, which nobody can read off the
  // screen and nobody would notice getting wrong. Their name is the thing on
  // the page, so their name is what is typed.
  const client = (found.payload.find((p) => p.table === 'clients')?.rows ?? [])[0] ?? {};
  return client.display_name || client.full_name || client.whatsapp_name || String(found.reference);
}

/** GET view=deleted - what was deleted lately, and when it goes for good. */
export async function deletedView(req, res, who) {
  if (!who.can('delete')) return res.status(403).json({ error: 'Only an administrator can see this.' });
  const { data, error } = await db().from('deleted_records')
    .select('id, kind, reference, label, summary, deleted_by, deleted_at, purge_after, restored_at, restored_by')
    .order('deleted_at', { ascending: false })
    .limit(50);
  if (error) {
    if (/does not exist|schema cache/i.test(String(error.message))) {
      return res.status(200).json({ available: false, records: [], keep_days: KEEP_DAYS });
    }
    return res.status(500).json({ error: 'We could not read what was deleted.' });
  }
  // Named one by one rather than spread. The select above already asks for
  // these columns, but this list is what actually leaves the server: a driver
  // that returns the whole row - a test double, a future client, a `select *`
  // somebody adds later - must not be able to put a deleted customer's
  // messages and documents back on the wire. That payload exists to be
  // restored from, never to be read.
  return res.status(200).json({
    available: true,
    keep_days: KEEP_DAYS,
    records: (data ?? []).map((r) => ({
      id: r.id,
      kind: r.kind,
      kind_words: KIND_WORDS[r.kind] ?? r.kind,
      reference: r.reference,
      label: r.label,
      deleted_by: r.deleted_by,
      deleted_at: r.deleted_at,
      purge_after: r.purge_after,
      restored_at: r.restored_at ?? null,
      restored_by: r.restored_by ?? null,
      words: countWords(r.summary?.counts ?? {}, r.summary?.files ?? 0),
      can_restore: !r.restored_at,
    })),
  });
}

// ---------------------------------------------------------------------------
// Doing it
// ---------------------------------------------------------------------------

/** POST { action: 'delete_record', kind, reference, confirm } */
export async function deleteRecord(req, res, who) {
  const kind = String(req.body?.kind ?? '');
  const reference = String(req.body?.reference ?? '').trim();
  if (!KIND_WORDS[kind]) return res.status(400).json({ error: `Unknown kind "${kind}".` });

  // An administrator cannot delete their own sign-in: they would be removing
  // the person holding the only key, mid-request.
  if (kind === 'person' && reference.toLowerCase() === who.name.toLowerCase()) {
    return res.status(409).json({ error: 'You cannot delete your own sign-in. Ask another administrator.' });
  }

  let found;
  try {
    found = await gather(kind, reference);
  } catch (err) {
    return res.status(500).json({ error: `We could not read what would go: ${err.message}` });
  }
  if (!found) return res.status(404).json({ error: 'That record is no longer here.' });

  // Typed, and typed right. Compared without case or edge spaces, because the
  // point is that they read it off the screen, not that they can touch-type.
  const wanted = confirmWord(kind, found);
  const typed = String(req.body?.confirm ?? '').trim();
  if (typed.toLowerCase() !== String(wanted).trim().toLowerCase()) {
    return res.status(400).json({ error: `Type “${wanted}” to confirm.`, confirm_with: wanted });
  }

  if (kind === 'person') {
    const refused = await lastAdministrator(reference);
    if (refused) return res.status(409).json({ error: refused });
  }

  const summary = { counts: found.counts, files: found.files.length };

  // The ledger first. A deletion that removed the rows and then failed to
  // record them would be the one unrecoverable bug this feature can have.
  const { data: kept, error: keepErr } = await db().from('deleted_records').insert({
    kind,
    reference: found.reference,
    label: found.label,
    summary,
    payload: found.payload,
    // The derived copies go at the purge too, and are not part of the count.
    files: [...found.files, ...(found.derived ?? [])],
    deleted_by: who.name,
    purge_after: new Date(Date.now() + KEEP_DAYS * DAY_MS).toISOString(),
  }).select('id').single();
  if (keepErr) {
    if (/does not exist|schema cache/i.test(String(keepErr.message))) {
      return res.status(503).json({ error: 'Deleting is not switched on in the database yet. Run the deletions migration.' });
    }
    return res.status(500).json({ error: 'We could not record the deletion, so nothing was deleted.' });
  }

  // Then the rows, children first.
  const removed = {};
  for (const stepped of found.steps) {
    const part = found.payload.find((p) => p.table === stepped.table);
    const query = stepped.match(db().from(stepped.table).delete());
    if (!query || !part) continue;
    const { error } = await query;
    if (error) {
      await audit({
        actor_type: 'operator', actor_id: who.name, action: 'record_delete_failed',
        entity_type: kind, entity_id: found.reference,
        metadata: { table: part.table, ledger: kept.id, error: String(error.message).slice(0, 200) },
      });
      return res.status(500).json({
        error: `Part of it could not be deleted (${part.table}). Nothing else was touched; the desk kept a copy of everything, in Settings → Recently deleted.`,
        ledger_id: kept.id,
      });
    }
    removed[part.table] = part.rows.length;
  }

  if (kind === 'person') invalidateTeam();

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'record_deleted',
    entity_type: kind, entity_id: found.reference,
    metadata: { kind, reference: found.reference, label: found.label, removed, files: found.files.length, ledger: kept.id, keep_days: KEEP_DAYS },
  });

  defer(purgeDue().catch(() => null));

  return res.status(200).json({
    ok: true,
    id: kept.id,
    kind,
    kind_words: KIND_WORDS[kind],
    reference: found.reference,
    words: countWords(found.counts, found.files.length),
    keep_days: KEEP_DAYS,
  });
}

/**
 * Refuses a deletion that would leave the desk with no administrator.
 *
 * Belt and braces: an administrator is active by definition of being able to
 * ask, and cannot delete themselves, so today the count can only come out
 * right. It is here so that the day somebody makes self-deletion possible, or
 * changes a role and deletes in one request, the desk still cannot be left
 * with nobody who can let anyone back in.
 */
async function lastAdministrator(name) {
  const rows = await teamList({ fresh: true }).catch(() => null);
  if (!rows) return 'We could not check the team list. Try again.';
  const left = rows.filter((u) => u.active !== false && u.role === 'admin'
    && String(u.name).toLowerCase() !== String(name).toLowerCase());
  return left.length ? null : 'The desk needs at least one active administrator. Make someone else an administrator first.';
}

/** POST { action: 'restore_record', id } */
export async function restoreRecord(req, res, who) {
  const id = Number(req.body?.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Which deleted record?' });

  const { data: row, error: readErr } = await db().from('deleted_records')
    .select('id, kind, reference, label, restored_at').eq('id', id).maybeSingle();
  if (readErr) return res.status(500).json({ error: 'We could not read that.' });
  if (!row) return res.status(404).json({ error: 'That deletion is no longer on the list — it may have been purged.' });
  if (row.restored_at) return res.status(409).json({ error: 'That was already put back.' });

  const { data, error } = await db().rpc('restore_deleted_record', { record_id: id });
  if (error) {
    return res.status(500).json({ error: `We could not put it back: ${String(error.message).slice(0, 200)}` });
  }
  await db().from('deleted_records').update({ restored_by: who.name }).eq('id', id);
  if (row.kind === 'person') invalidateTeam();

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'record_restored',
    entity_type: row.kind, entity_id: row.reference,
    metadata: { kind: row.kind, reference: row.reference, label: row.label, ledger: id, put_back: data ?? null },
  });
  return res.status(200).json({ ok: true, id, kind: row.kind, reference: row.reference, label: row.label, put_back: data ?? null });
}

// ---------------------------------------------------------------------------
// The thirty days running out
// ---------------------------------------------------------------------------

let purgedAt = 0;
const PURGE_EVERY_MS = 3_600_000;

/** For tests: forget when the purge last ran. */
export const resetPurgeClock = () => { purgedAt = 0; };

/**
 * Removes what is past its thirty days: the files from the bucket first, then
 * the ledger row that was keeping them.
 *
 * Run after a deletion and from the outbox route, not on a schedule: this
 * project has no cron (Hobby refuses one more often than daily), and a desk
 * somebody uses every day purges every day. At most once an hour per instance,
 * because the reading costs a query and nothing is due most of the time.
 */
export async function purgeDue({ force = false, limit = 20 } = {}) {
  if (!force && Date.now() - purgedAt < PURGE_EVERY_MS) return { ok: true, skipped: true, purged: 0 };
  purgedAt = Date.now();

  const { data, error } = await db().from('deleted_records')
    .select('id, kind, reference, files')
    .is('restored_at', null)
    .lt('purge_after', new Date().toISOString())
    .limit(limit);
  if (error) {
    if (!/does not exist|schema cache/i.test(String(error.message))) console.error('purge read failed:', error.message);
    return { ok: false, purged: 0 };
  }
  const due = data ?? [];
  if (!due.length) return { ok: true, purged: 0 };

  let files = 0;
  for (const row of due) {
    const removed = await removeObjects(row.files ?? []);
    files += removed.removed;
    // The row goes whether or not every file did: a file that would not delete
    // is logged, and keeping the payload would keep the data this purge exists
    // to destroy.
    const { error: delErr } = await db().from('deleted_records').delete().eq('id', row.id);
    if (delErr) { console.error('purge delete failed:', delErr.message); continue; }
    await audit({
      actor_type: 'system', action: 'deleted_record_purged',
      entity_type: row.kind, entity_id: row.reference,
      metadata: { ledger: row.id, files: (row.files ?? []).length, files_removed: removed.removed },
    });
  }
  return { ok: true, purged: due.length, files };
}
