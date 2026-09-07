/**
 * The Operations side: the work queue, and how the desk hears about it.
 *
 * Two separate things live here on purpose.
 *
 * The TASK is the record. It is written to Supabase inside the same operation
 * that caused it, and it is what Operations actually works from. It exists
 * whether or not any chat tool is configured, and it cannot be lost by a failed
 * webhook.
 *
 * The NOTIFICATION is a courtesy on top - a ping in Telegram, or Pumble, or
 * whatever MKY uses next. It is deliberately fire-and-forget: a booking must
 * never fail because a notification channel is down, and a channel that is not
 * configured must not change how the business works. That is why the notifier
 * is an interface with a Supabase-backed default rather than a Pumble call
 * buried in the booking code.
 */

import { db } from './supabase.js';
import { config } from './config.js';
import { audit, logEvent } from './audit.js';
import { sendMessage } from './telegram.js';
import { pumbleNotifier } from './integrations/pumble.js';

/** A short reference an operator can quote: MKY-TSK-260908-4F2A. */
export function makeTaskRef() {
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${config.refPrefix}-TSK-${stamp}-${rand}`;
}

/**
 * Puts work on the Operations queue.
 *
 * `idempotencyKey` is what makes a retried webhook or a double-tapped button
 * produce one task rather than three. Give every caller a key derived from the
 * event, never from the clock.
 *
 * @param {{taskType: string, bookingRef?: string, mrnRequestId?: number,
 *          clientId?: number, chatId?: string|number, channel?: string,
 *          priority?: 'low'|'normal'|'high', payload?: object, notes?: string,
 *          idempotencyKey: string}} task
 */
export async function createTask(task) {
  const row = {
    task_ref: makeTaskRef(),
    task_type: task.taskType,
    booking_ref: task.bookingRef ?? null,
    mrn_request_id: task.mrnRequestId ?? null,
    client_id: task.clientId ?? null,
    chat_id: task.chatId != null ? String(task.chatId) : null,
    channel: task.channel ?? 'telegram',
    status: 'open',
    priority: task.priority ?? 'normal',
    payload: task.payload ?? {},
    notes: task.notes ?? null,
    idempotency_key: task.idempotencyKey ? String(task.idempotencyKey).slice(0, 200) : null,
  };

  const { data, error } = await db().from('operations_tasks').insert(row).select().single();

  if (error) {
    if (error.code === '23505') {
      // Already raised for this event. Return the existing one so the caller
      // can quote its reference rather than treating a retry as a failure.
      const { data: existing } = await db()
        .from('operations_tasks')
        .select('*')
        .eq('idempotency_key', row.idempotency_key)
        .maybeSingle();
      return { ok: true, existed: true, task: existing ?? null };
    }
    console.error('operations task insert failed:', error.message);
    return { ok: false, error: error.message };
  }

  logEvent('operations_task_created', { task_ref: data.task_ref, task_type: data.task_type, booking_ref: data.booking_ref });
  await audit({
    actor_type: 'system',
    action: 'operations_task_created',
    entity_type: 'operations_task',
    entity_id: data.task_ref,
    metadata: { task_type: data.task_type, booking_ref: data.booking_ref },
  });

  return { ok: true, existed: false, task: data };
}

export async function completeTask(taskRef, { operator = 'operations', notes = null } = {}) {
  const patch = {
    status: 'done',
    completed_at: new Date().toISOString(),
    completed_by: operator,
    updated_at: new Date().toISOString(),
  };
  if (notes) patch.notes = notes;

  const { data, error } = await db()
    .from('operations_tasks')
    .update(patch)
    .eq('task_ref', taskRef)
    .neq('status', 'done')       // completing twice is a no-op, not an error
    .select();
  if (error) return { ok: false, error: error.message };
  return { ok: true, changed: Boolean(data?.length) };
}

/** Closes whatever is still open against a booking - it has been decided. */
export async function closeTasksForBooking(bookingRef, { operator = 'operations', reason = '' } = {}) {
  const { error } = await db()
    .from('operations_tasks')
    .update({
      status: 'done',
      completed_at: new Date().toISOString(),
      completed_by: operator,
      notes: reason || null,
      updated_at: new Date().toISOString(),
    })
    .eq('booking_ref', bookingRef)
    .in('status', ['open', 'in_progress']);
  if (error) console.error('closing tasks failed:', error.message);
}

// ---------------------------------------------------------------------------
// OperationsNotifier
// ---------------------------------------------------------------------------

/**
 * The interface. Every method takes already-assembled facts and returns a
 * report; none of them may throw, because none of them is allowed to affect
 * whether the underlying business action succeeded.
 *
 * @typedef {{
 *   notifyNewBooking(booking: object, task: object): Promise<object>,
 *   notifyMRNRequest(request: object, booking: object|null): Promise<object>,
 *   notifyMissingDocuments(booking: object, missing: string[]): Promise<object>,
 *   notifyClientContactRequest(ticket: object): Promise<object>,
 * }} OperationsNotifier
 */

/** The staff Telegram group, when STAFF_CHAT_ID is set. */
const telegramNotifier = {
  name: 'telegram',
  enabled: () => Boolean(config.staffChatId && config.telegram.token),

  async post(lines) {
    const res = await sendMessage(config.staffChatId, lines.filter(Boolean).join('\n'), { returnMessage: true });
    return { ok: Boolean(res?.ok), error: res?.ok ? null : res?.description ?? 'send failed' };
  },

  notifyNewBooking(b, task) {
    return this.post([
      `🆕 New booking request ${b.booking_ref}`,
      `Chassis: ${b.vin ?? '—'}`,
      `Make: ${[b.make, b.model].filter(Boolean).join(' ') || '—'}`,
      `Client: ${b.customer_name ?? '—'}`,
      `Route: ${b.origin_port ?? '—'} → ${b.destination_port ?? '—'}`,
      task?.task_ref ? `Task: ${task.task_ref}` : null,
    ]);
  },

  notifyMRNRequest(r, b) {
    return this.post([
      `📄 MRN request ${r.request_ref}`,
      `Chassis: ${r.vin ?? b?.vin ?? '—'}`,
      b?.booking_ref ? `Booking: ${b.booking_ref}` : null,
      'MKY has been asked to obtain the MRN.',
    ]);
  },

  notifyMissingDocuments(b, missing) {
    return this.post([
      `📎 Documents outstanding on ${b.booking_ref}`,
      `Chassis: ${b.vin ?? '—'}`,
      `Still needed: ${missing.join(', ')}`,
    ]);
  },

  notifyClientContactRequest(t) {
    return this.post([
      `💬 ${t.department} — ticket ${t.ticket_ref}`,
      t.customer ? `Client: ${t.customer}` : null,
      t.contact ? `Call: ${t.contact}` : null,
      t.summary ? `Problem: ${t.summary}` : null,
    ]);
  },
};

/**
 * Always-on: the task row itself. This is the notifier that cannot fail to be
 * configured, and it is why the other two are optional.
 */
const supabaseNotifier = {
  name: 'supabase',
  enabled: () => true,
  async notifyNewBooking() { return { ok: true, note: 'recorded as an operations task' }; },
  async notifyMRNRequest() { return { ok: true, note: 'recorded as an operations task' }; },
  async notifyMissingDocuments() { return { ok: true, note: 'recorded on the booking' }; },
  async notifyClientContactRequest() { return { ok: true, note: 'recorded as a support ticket' }; },
};

/** Whichever channels are configured, tried in order, none able to break the rest. */
export function operationsNotifier() {
  const channels = [supabaseNotifier, telegramNotifier, pumbleNotifier].filter((c) => {
    try { return c.enabled(); } catch { return false; }
  });

  const fanOut = (method) => async (...args) => {
    const results = {};
    for (const channel of channels) {
      try {
        results[channel.name] = await channel[method](...args);
      } catch (err) {
        // Swallowed by design. A notification channel is never allowed to
        // decide whether a booking happened.
        console.error(`operations notifier ${channel.name}.${method} failed:`, err?.message);
        results[channel.name] = { ok: false, error: err?.message };
      }
    }
    return results;
  };

  return {
    channels: channels.map((c) => c.name),
    notifyNewBooking: fanOut('notifyNewBooking'),
    notifyMRNRequest: fanOut('notifyMRNRequest'),
    notifyMissingDocuments: fanOut('notifyMissingDocuments'),
    notifyClientContactRequest: fanOut('notifyClientContactRequest'),
  };
}
