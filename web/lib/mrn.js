/**
 * MRN requests - the branch where MKY obtains the MRN on the client's behalf.
 *
 * The one thing this module refuses to do is decide what Egyptian customs
 * requires. Nobody has told us, so `required_mrn_documents` in bot_settings is
 * empty and this code collects a free-text description and puts a task on the
 * Customs Documentation desk. The moment MKY fills that setting in, the same
 * code asks for exactly those items and nothing changes elsewhere.
 *
 * That is the difference between "not implemented" and "implemented, awaiting a
 * business decision". Guessing a customs requirement would be worse than either.
 */

import { db } from './supabase.js';
import { config } from './config.js';
import { setting } from './settings.js';
import { createTask } from './operations.js';
import { audit } from './audit.js';

function makeRequestRef() {
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${config.refPrefix}-MRN-${stamp}-${rand}`;
}

/**
 * Opens - or returns - the MRN application for a booking.
 *
 * The partial unique index on (booking_ref) for live statuses is what makes a
 * double tap safe: the second insert loses and we hand back the first.
 *
 * @param {{bookingRef: string, clientId?: number|null, chatId: string|number,
 *          vin?: string|null, supplied?: object}} input
 */
export async function openMrnRequest({ bookingRef, clientId = null, chatId, vin = null, supplied = {} }) {
  const required = await setting('required_mrn_documents');
  const missing = Array.isArray(required) ? required : [];

  const row = {
    request_ref: makeRequestRef(),
    booking_ref: bookingRef ?? null,
    client_id: clientId,
    chat_id: chatId != null ? String(chatId) : null,
    vin: vin ?? null,
    status: 'submitted',
    // What the desk still has to collect. Empty means "MKY has not told the
    // system what it needs" - the task notes say so, rather than the client
    // being asked for an invented list.
    missing_information: missing,
    supplied_information: supplied,
    submitted_at: new Date().toISOString(),
  };

  const { data, error } = await db().from('mrn_requests').insert(row).select().single();

  if (error) {
    if (error.code === '23505') {
      const { data: existing } = await db()
        .from('mrn_requests')
        .select('*')
        .eq('booking_ref', bookingRef)
        .in('status', ['draft', 'submitted', 'under_review', 'missing_information', 'approved'])
        .maybeSingle();
      if (existing) return { ok: true, existed: true, request: existing };
    }
    console.error('mrn request insert failed:', error.message);
    return { ok: false, error: error.message };
  }

  const task = await createTask({
    taskType: 'mrn_request',
    bookingRef: bookingRef ?? null,
    mrnRequestId: data.id,
    clientId,
    chatId,
    priority: 'high',
    payload: { request_ref: data.request_ref, vin: data.vin, supplied },
    notes: missing.length
      ? `Collect from the client: ${missing.join(', ')}`
      : 'bot_settings.required_mrn_documents is empty - MKY has not defined what an MRN application needs, '
        + 'so the bot collected a free-text description only. Confirm the required list to automate this.',
    idempotencyKey: `mrn_request:${data.request_ref}`,
  });

  await audit({
    actor_type: 'client',
    actor_id: chatId,
    action: 'mrn_request_created',
    entity_type: 'mrn_request',
    entity_id: data.request_ref,
    metadata: { booking_ref: bookingRef, vin: data.vin },
  });

  return { ok: true, existed: false, request: data, task: task.task };
}

/** The live MRN application for a booking, if there is one. */
export async function mrnRequestFor(bookingRef) {
  if (!bookingRef) return null;
  const { data } = await db()
    .from('mrn_requests')
    .select('*')
    .eq('booking_ref', bookingRef)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/** Adds what the client just told us to the application, without losing what was there. */
export async function addSuppliedInformation(requestRef, text) {
  const { data: current } = await db()
    .from('mrn_requests')
    .select('supplied_information')
    .eq('request_ref', requestRef)
    .maybeSingle();

  const notes = Array.isArray(current?.supplied_information?.notes)
    ? current.supplied_information.notes
    : [];
  notes.push({ at: new Date().toISOString(), text: String(text).slice(0, 2000) });

  const { error } = await db()
    .from('mrn_requests')
    .update({
      supplied_information: { ...(current?.supplied_information ?? {}), notes },
      updated_at: new Date().toISOString(),
    })
    .eq('request_ref', requestRef);

  return { ok: !error, error: error?.message };
}
