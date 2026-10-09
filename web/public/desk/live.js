/**
 * What each screen of the desk depends on, and how often to ask whether it
 * changed. Plain ES with no imports, like workflow.js: the browser imports it
 * directly and the server (lib/admin/desk-live.js) imports the same file, so
 * the screen that decides WHEN to fetch again and the server that decides
 * WHETHER anything changed can never disagree about what a screen shows.
 *
 * A scope is one area of the desk with a version on the server
 * (supabase/migrations/20261009120000_desk_activity.sql): the version moves
 * whenever a row in that area is written.
 */

export const SCOPES = ['bookings', 'customers', 'history', 'messages', 'outbox', 'problems', 'requests', 'shipments', 'team'];

/**
 * The scopes each view of ?resource=console reads. A view that is not here
 * (search, preview, document_url) is fetched when it is asked for, never
 * polled, and never answered "not modified".
 */
export const VIEW_SCOPES = {
  inbox: ['bookings', 'customers', 'outbox', 'problems', 'requests', 'team'],
  counts: ['bookings', 'customers', 'outbox', 'problems', 'requests', 'team'],
  'case:booking': ['bookings', 'customers', 'history', 'outbox', 'shipments', 'team'],
  'case:request': ['bookings', 'customers', 'history', 'requests', 'team'],
  'case:mrn': ['bookings', 'customers', 'history', 'team'],
  document: ['bookings', 'history', 'team'],
  chats: ['bookings', 'customers', 'messages', 'problems'],
  chat: ['bookings', 'customers', 'messages', 'problems', 'requests', 'team'],
  shipments: ['customers', 'shipments'],
  shipment: ['bookings', 'customers', 'shipments', 'team'],
  settings: ['team'],
};

/** The key VIEW_SCOPES knows a request by: the case view is three views. */
export const viewKey = (view, query = {}) => (view === 'case' ? `case:${query.type}` : view);

/** The scopes a request reads, or null when it is not one the desk polls. */
export const scopesOf = (view, query = {}) => VIEW_SCOPES[viewKey(view, query)] ?? null;

/**
 * How often a view is worked out again on the server even when nothing it
 * reads has changed, because part of what it says depends on the clock:
 * "overdue", "done today", "confirmed 4 min ago" - and, in a conversation,
 * whether WhatsApp's 24-hour window is still open. Seconds.
 */
export const VIEW_CLOCK = { chat: 60, default: 300 };

/**
 * The polling rhythm. Asking costs one cheap read (the pulse); a screen is
 * fetched again only when what it shows changed, or MAX_AGE has passed.
 */
export const RHYTHM = {
  activeMs: 15_000,        // the page is visible and somebody used it lately
  idleMs: 60_000,          // visible, but nobody has touched it for IDLE_AFTER
  idleAfterMs: 180_000,
  fallbackMs: 20_000,      // the server has no pulse (an older database): fetch screens on a timer, as before
  maxBackoffMs: 120_000,   // after errors, wait doubling up to this
  jitter: 0.15,            // ± this share of the wait, so ten desks do not ask in step
  maxAgeMs: 300_000,       // a screen is fetched again at least this often, changed or not
};

/**
 * How long to wait before asking again.
 *
 * @param {{idleForMs?: number, errors?: number, supported?: boolean|null, random?: () => number}} state
 */
export function pollDelay({ idleForMs = 0, errors = 0, supported = true, random = Math.random } = {}) {
  let base = supported === false ? RHYTHM.fallbackMs : RHYTHM.activeMs;
  if (idleForMs >= RHYTHM.idleAfterMs) base = Math.max(base, RHYTHM.idleMs);
  if (errors > 0) base = Math.min(RHYTHM.maxBackoffMs, base * 2 ** Math.min(errors, 6));
  const spread = base * RHYTHM.jitter;
  return Math.round(base - spread + random() * 2 * spread);
}

/**
 * Whether a screen that last saw `seen` must be fetched again, given the
 * versions now. Nothing seen yet counts as changed, and so does a scope that
 * appeared or disappeared: better one fetch too many than a screen that never
 * catches up. A scope the server does not know at all (missing on both
 * sides) is left to MAX_AGE rather than fetched on every tick.
 */
export function changed(scopes, seen, now) {
  if (!seen || !now) return true;
  return scopes.some((s) => String(seen[s] ?? '') !== String(now[s] ?? ''));
}
