/**
 * Pumble, as an optional notification channel.
 *
 * The original roadmap named Pumble as the place Operations hears about a new
 * booking. Nobody has given us a workspace or a webhook URL, and the business
 * must not depend on one: the record of the work is the operations_tasks row in
 * Supabase, and this is a copy of it in a chat window.
 *
 * So it is off unless PUMBLE_ENABLED=true and PUMBLE_WEBHOOK_URL is set, it
 * never throws, and nothing anywhere branches on whether it succeeded. Swapping
 * it for Slack, Teams or anything else means writing one more object with the
 * same four methods.
 */

const env = process.env;

const enabled = () =>
  String(env.PUMBLE_ENABLED ?? '').toLowerCase() === 'true' && Boolean(env.PUMBLE_WEBHOOK_URL);

/**
 * Incoming webhooks in this family of tools accept `{ text }`. Kept to that
 * lowest common denominator deliberately - a richer payload is worth nothing
 * until someone tells us which product and which webhook format they use.
 */
async function post(text) {
  if (!enabled()) return { ok: false, skipped: true, reason: 'pumble not configured' };

  const controller = new AbortController();
  // A slow chat tool must not hold a serverless function open on a customer's
  // booking. Five seconds, then we give up and the task row carries the truth.
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(env.PUMBLE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `pumble responded ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'pumble timed out' : err?.message };
  } finally {
    clearTimeout(timer);
  }
}

export const pumbleNotifier = {
  name: 'pumble',
  enabled,

  notifyNewBooking(b, task) {
    return post(
      `New booking request ${b.booking_ref} — chassis ${b.vin ?? '—'}, ` +
      `${b.customer_name ?? '—'}, ${b.origin_port ?? '—'} → ${b.destination_port ?? '—'}` +
      (task?.task_ref ? ` (task ${task.task_ref})` : ''),
    );
  },

  notifyMRNRequest(r, b) {
    return post(
      `MRN request ${r.request_ref} — chassis ${r.vin ?? b?.vin ?? '—'}` +
      (b?.booking_ref ? `, booking ${b.booking_ref}` : ''),
    );
  },

  notifyMissingDocuments(b, missing) {
    return post(`Documents outstanding on ${b.booking_ref}: ${missing.join(', ')}`);
  },

  notifyClientContactRequest(t) {
    return post(
      `${t.department} ticket ${t.ticket_ref}` +
      (t.contact ? ` — call ${t.contact}` : '') +
      (t.summary ? ` — ${t.summary}` : ''),
    );
  },
};
