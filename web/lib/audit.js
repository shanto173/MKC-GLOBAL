/**
 * The audit trail: who did what, to which record, when.
 *
 * Two rules, both enforced here rather than trusted to callers:
 *   - never a document body, never a secret. Metadata is identifiers and
 *     decisions, nothing else.
 *   - never throws. An audit write failing must not fail the thing it is
 *     recording; a booking that happened and was not logged is a gap in the
 *     log, while a booking that did not happen because logging failed is a lost
 *     customer.
 */

import { db } from './supabase.js';

/** Keys that must never reach the log, whatever a caller passes. */
const FORBIDDEN = /(token|secret|key|password|authorization|cookie|buffer|content|base64|file_bytes)/i;

/** Values long enough to be a document rather than an identifier. */
const MAX_VALUE_CHARS = 500;

export function redact(metadata) {
  const out = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (FORBIDDEN.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      // One level deep is enough for the shapes we log; deeper is a payload,
      // and a payload is what this function exists to keep out.
      out[key] = Buffer.isBuffer(value)
        ? '[binary]'
        : Array.isArray(value)
          ? value.slice(0, 20).map((v) => String(v).slice(0, 120))
          : redact(value);
      continue;
    }
    const text = String(value);
    out[key] = text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
  }
  return out;
}

/**
 * @param {{actor_type: 'client'|'operator'|'system', actor_id?: string|number,
 *          action: string, entity_type?: string, entity_id?: string|number,
 *          metadata?: object}} event
 */
export async function audit(event) {
  try {
    const { error } = await db().from('audit_logs').insert({
      actor_type: event.actor_type ?? 'system',
      actor_id: event.actor_id != null ? String(event.actor_id).slice(0, 120) : null,
      action: String(event.action ?? 'unknown').slice(0, 120),
      entity_type: event.entity_type ?? null,
      entity_id: event.entity_id != null ? String(event.entity_id).slice(0, 120) : null,
      metadata: redact(event.metadata),
    });
    if (error) console.error('audit write failed:', error.message);
  } catch (err) {
    console.error('audit write threw:', err?.message);
  }
}

/**
 * A structured line on stdout, for the platform log, carrying the same
 * correlation identifiers as the database row so one can be found from the
 * other. Vercel indexes JSON lines; a sentence is not searchable.
 */
export function logEvent(name, fields = {}) {
  try {
    console.log(JSON.stringify({ event: name, at: new Date().toISOString(), ...redact(fields) }));
  } catch {
    console.log(`event=${name}`);
  }
}
