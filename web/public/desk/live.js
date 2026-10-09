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
 * The areas each list of ?resource=console reads. A view that is in neither
 * this nor RECORD_SCOPES (search, preview, document_url) is fetched when it is
 * asked for, never polled, and never answered "not modified".
 */
export const VIEW_SCOPES = {
  inbox: ['bookings', 'customers', 'outbox', 'problems', 'requests', 'team'],
  counts: ['bookings', 'customers', 'outbox', 'problems', 'requests', 'team'],
  'case:mrn': ['bookings', 'customers', 'history', 'team'],
  document: ['bookings', 'history', 'team'],
  chats: ['bookings', 'customers', 'messages', 'problems'],
  shipments: ['customers', 'shipments'],
  settings: ['team'],
  // As areas, for a page that cannot name its record (and as the fallback).
  'case:booking': ['bookings', 'customers', 'history', 'outbox', 'shipments', 'team'],
  'case:request': ['bookings', 'customers', 'history', 'requests', 'team'],
  chat: ['bookings', 'customers', 'messages', 'problems', 'requests', 'team'],
  shipment: ['bookings', 'customers', 'shipments', 'team'],
};

/**
 * The conversation a chat id belongs to, as the database's desk_chat_key()
 * names it: the channel the chat id says - "wa:…" is WhatsApp, a whole number
 * Telegram - whatever label it was stored with; another id keeps its label.
 */
export function chatKey(channel, chatId) {
  const id = String(chatId ?? '');
  if (!id) return null;
  const ch = id.startsWith('wa:') ? 'whatsapp' : /^-?\d+$/.test(id) ? 'telegram' : (channel || 'web');
  return `chat:${ch}:${id}`;
}

/**
 * The pages that show one record depend on that record's own version
 * (booking:<ref>, chat:<channel>:<chat id>, …) rather than on a whole area:
 * a case open on one booking is not fetched again because another moved.
 * Each also follows 'team' (who may do what, the required papers). What such
 * a page shows of other records - the customer panel on a case, a duplicate
 * chassis on another booking - waits for its five-minute refresh.
 */
const RECORD_SCOPES = {
  'case:booking': (q) => (q.ref ? [`booking:${q.ref}`, 'team'] : null),
  'case:request': (q) => (q.ref ? [`request:${q.ref}`, 'team'] : null),
  chat: (q) => (q.channel && q.chat_id ? [chatKey(q.channel, q.chat_id), 'team'] : null),
  shipment: (q) => (q.id ? [`shipment:${q.id}`, 'team'] : null),
};

/** Whether a scope is one of the areas, rather than one record's key. */
export const isArea = (scope) => SCOPES.includes(scope);

/** The key VIEW_SCOPES knows a request by: the case view is three views. */
export const viewKey = (view, query = {}) => (view === 'case' ? `case:${query.type}` : view);

/** The scopes a request reads, or null when it is not one the desk polls. */
export function scopesOf(view, query = {}) {
  const k = viewKey(view, query);
  return RECORD_SCOPES[k]?.(query) ?? VIEW_SCOPES[k] ?? null;
}

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
