/**
 * The customer's answer to something the desk asked.
 *
 * The desk asks in two places: a booking it hands back (status
 * needs_client_action - "Ask the customer for something", or a document sent
 * back for a new copy) and an MRN application (status missing_information -
 * "Ask for information for the MRN"). Until this existed neither heard the
 * answer. Any message flipped a waiting booking back to the desk without
 * keeping what it said; an MRN application was not looked at at all, and sat
 * on "Waiting for the customer"; and the message itself went on to the
 * assistant, which answered it as a fresh chat - "Customer Care: to open a
 * ticket send…".
 *
 * Here the answer is kept on the request it answers, where the desk reads it,
 * and the request goes back to the desk. The state machine decides whether a
 * message IS an answer and tells the customer it arrived (lib/flow/machine.js),
 * so Telegram and WhatsApp behave the same: both reach this only through it.
 *
 * Nothing is kept in the conversation session but the reference of what was
 * just answered - the answer itself is business data, and lives on the rows.
 */

import { db } from './supabase.js';
import { audit, logEvent } from './audit.js';
import { createTask } from './operations.js';
import { channelOf } from './channels.js';

/** How long after an answer a further message is taken as more of it. */
export const FOLLOW_UP_MINUTES = 10;

const MAX_TEXT = 2000;

/**
 * What in this chat is waiting on the customer, newest question first.
 *
 * `askedAt` is when the desk asked: the booking's needs_client_action.at, or -
 * for a document sent back, which records no question of its own - when the
 * row last changed. A read that fails is "nothing waiting": the message then
 * goes where it always went, which is a worse answer, not a lost one.
 *
 * @returns {Promise<Array<{kind: 'booking'|'mrn', ref: string, bookingRef: string|null,
 *                          requested: string|null, askedAt: string|null, id?: number}>>}
 */
export async function waitingOn(chatId) {
  if (chatId == null) return [];
  const [bookings, applications] = await Promise.all([
    db().from('bookings').select('*').eq('chat_id', String(chatId)).eq('status', 'needs_client_action')
      .then((r) => r, () => ({ data: null })),
    db().from('mrn_requests').select('*').eq('chat_id', String(chatId)).eq('status', 'missing_information')
      .then((r) => r, () => ({ data: null })),
  ]);

  const waiting = [
    ...(bookings.data ?? []).map((b) => ({
      kind: 'booking',
      ref: b.booking_ref,
      bookingRef: b.booking_ref,
      requested: b.needs_client_action?.requested ?? null,
      askedAt: b.needs_client_action?.at ?? b.status_changed_at ?? b.updated_at ?? null,
    })),
    ...(applications.data ?? []).map((m) => ({
      kind: 'mrn',
      ref: m.request_ref,
      id: m.id,
      bookingRef: m.booking_ref ?? null,
      requested: (m.missing_information ?? []).join('\n') || m.operations_notes || null,
      askedAt: m.updated_at ?? m.created_at ?? null,
    })),
  ];
  return waiting.sort((a, b) => String(b.askedAt ?? '').localeCompare(String(a.askedAt ?? '')));
}

/**
 * Keeps an answer on each request it answers.
 *
 * `reopen` is the first answer: the request must still be waiting - the
 * status is in the WHERE clause, so two messages racing in reopen it once -
 * and it moves back to the desk, with a task and a line in its history. A
 * follow-up (reopen false) is added to what is already there and moves
 * nothing: the request is with the desk already.
 *
 * @param {Array<{kind: 'booking'|'mrn', ref: string}>} requests
 * @param {{chatId: string|number, clientId?: number|null, text?: string,
 *          documents?: Array<{id?: number, file_name?: string|null, doc_type?: string|null}>,
 *          reopen?: boolean}} answer
 * @returns {Promise<Array<{kind: string, ref: string, bookingRef: string|null}>>} what was recorded
 */
export async function recordAnswer(requests, { chatId, clientId = null, text = '', documents = [], reopen = true }) {
  const at = new Date().toISOString();
  const words = String(text ?? '').trim().slice(0, MAX_TEXT);
  const files = (documents ?? []).filter(Boolean).map((d) => ({
    id: d.id ?? null, file_name: d.file_name ?? null, doc_type: d.doc_type && d.doc_type !== 'other' ? d.doc_type : null,
  }));
  if (!words && !files.length) return [];

  const recorded = [];
  for (const request of requests) {
    const done = request.kind === 'mrn'
      ? await answerApplication(request, { at, words, files, reopen })
      : await answerBooking(request, { at, words, files, reopen });
    if (!done) continue;
    recorded.push(done);

    logEvent('client_answer_recorded', { kind: request.kind, ref: request.ref, chat_id: String(chatId), reopened: reopen });
    if (!reopen) continue;

    await createTask({
      taskType: 'client_action_response',
      bookingRef: done.bookingRef,
      mrnRequestId: done.mrnRequestId ?? null,
      clientId: clientId ?? null,
      chatId,
      channel: channelOf(chatId),
      priority: 'high',
      payload: { responded_at: at, kind: request.kind, ref: request.ref },
      notes: done.assignedTo ? `The customer answered. Back with ${done.assignedTo}.` : 'The customer answered. Nobody owns this yet.',
      idempotencyKey: `client_response:${request.ref}:${at.slice(0, 13)}`,
    }).catch(() => null);

    await audit({
      actor_type: 'client', actor_id: String(chatId),
      action: 'client_responded',
      entity_type: request.kind === 'mrn' ? 'mrn_request' : 'booking',
      entity_id: request.ref,
      metadata: {
        booking_ref: done.bookingRef,
        said: words ? words.slice(0, 200) : null,
        documents: files.map((f) => f.file_name).filter(Boolean),
      },
    });
  }
  return recorded.map(({ kind, ref, bookingRef }) => ({ kind, ref, bookingRef }));
}

async function answerBooking(request, { at, words, files, reopen }) {
  const { data: row } = await db().from('bookings').select('*').eq('booking_ref', request.ref).maybeSingle()
    .then((r) => r, () => ({ data: null }));
  if (!row) return null;
  if (reopen && row.status !== 'needs_client_action') return null;

  // Kept beside what was asked, so the desk reads question and answer together.
  const asked = row.needs_client_action ?? {};
  const entry = { at, ...(words ? { text: words } : {}), ...(files.length ? { documents: files } : {}) };
  const patch = { needs_client_action: { ...asked, answers: [...(asked.answers ?? []), entry] } };
  if (reopen) Object.assign(patch, { status: 'under_review', client_responded_at: at });

  let query = db().from('bookings').update(patch).eq('booking_ref', row.booking_ref);
  if (reopen) query = query.eq('status', 'needs_client_action');
  const { data, error } = await query.select('booking_ref');
  if (error) {
    console.error('recording a client answer failed:', error.message);
    return null;
  }
  if (!data?.length) return null;
  return { kind: 'booking', ref: row.booking_ref, bookingRef: row.booking_ref, channel: row.channel, assignedTo: row.assigned_to ?? null };
}

async function answerApplication(request, { at, words, files, reopen }) {
  const { data: row } = await db().from('mrn_requests').select('*').eq('request_ref', request.ref).maybeSingle()
    .then((r) => r, () => ({ data: null }));
  if (!row) return null;
  if (reopen && row.status !== 'missing_information') return null;

  // The desk shows supplied_information.notes as "What the customer told us",
  // one line each, so a file is a line naming it.
  const named = files.map((f) => f.file_name ?? 'a file').join(', ');
  const line = [words, files.length ? `📎 ${named}` : ''].filter(Boolean).join('\n');
  const supplied = row.supplied_information ?? {};
  const notes = Array.isArray(supplied.notes) ? supplied.notes : [];
  const patch = {
    supplied_information: { ...supplied, notes: [...notes, { at, text: line, ...(files.length ? { documents: files } : {}) }] },
    updated_at: at,
  };
  if (reopen) patch.status = 'under_review';

  let query = db().from('mrn_requests').update(patch).eq('request_ref', row.request_ref);
  if (reopen) query = query.eq('status', 'missing_information');
  const { data, error } = await query.select('request_ref');
  if (error) {
    console.error('recording a client answer failed:', error.message);
    return null;
  }
  if (!data?.length) return null;
  return { kind: 'mrn', ref: row.request_ref, bookingRef: row.booking_ref ?? null, mrnRequestId: row.id ?? null };
}
