/**
 * The desk's building blocks: elements, the API, dialogs, toasts, icons, time.
 *
 * TEXT, NEVER HTML. Every string that reaches the page goes in as a text node
 * or an attribute value - h() has no way to take markup, and nothing in the
 * desk assigns innerHTML. Customer names and messages are written by anybody
 * with a phone, so a name like <script>…</script> must show up as those
 * characters, not run. A test greps every desk file for the ways HTML gets in.
 */

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

/**
 * h('button', { class: 'btn', onclick }, 'Save') → <button class="btn">Save</button>
 * Children may be strings (become text), nodes, arrays, or null/false (skipped).
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'open') el[k] = Boolean(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const clear = (el) => { el.replaceChildren(); return el; };

/** A visually hidden label for screen readers, beside something that is only an icon. */
export const sr = (text) => h('span', { class: 'sr-only' }, text);

// ---------------------------------------------------------------------------
// Icons - static path data only; never built from anything a customer typed.
// ---------------------------------------------------------------------------

const ICONS = {
  inbox: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'],
  chats: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  ship: ['M2 20c1.5 1 3 1 4.5 0s3-1 4.5 0 3 1 4.5 0 3-1 4.5 0', 'M4 17 3 12l9-4 9 4-1 5', 'M6 10V5h12v5', 'M12 3v2'],
  settings: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M2 14h4', 'M10 8h4', 'M18 16h4'],
  search: ['M21 21l-4.3-4.3', 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z'],
  whatsapp: ['M7.9 20A9 9 0 1 0 4 16.1L2 22z', 'M9 10a.5.5 0 0 0 1 0V9a.5.5 0 0 0-1 0v1a5 5 0 0 0 5 5h1a.5.5 0 0 0 0-1h-1a.5.5 0 0 0 0 1'],
  telegram: ['M22 2 11 13', 'M22 2 15 22l-4-9-9-4z'],
  file: ['M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z', 'M14 2v6h6'],
  check: ['M20 6 9 17l-5-5'],
  alert: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
  circle: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'],
  x: ['M18 6 6 18', 'M6 6l12 12'],
  lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  back: ['M12 19l-7-7 7-7', 'M19 12H5'],
  refresh: ['M21 12a9 9 0 1 1-3-6.7L21 8', 'M21 3v5h-5'],
  down: ['M6 9l6 6 6-6'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  phone: ['M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  external: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  note: ['M4 4h16v12l-4 4H4z', 'M16 20v-4h4', 'M8 9h8', 'M8 13h5'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1'],
  left: ['M15 18l-6-6 6-6'],
  right: ['M9 18l6-6-6-6'],
  send: ['M22 2 11 13', 'M22 2 15 22l-4-9-9-4z'],
  plus: ['M12 5v14', 'M5 12h14'],
};

export function icon(name, { size = 16, cls = '' } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (cls) svg.setAttribute('class', cls);
  for (const d of ICONS[name] ?? []) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

// ---------------------------------------------------------------------------
// Small pieces used everywhere
// ---------------------------------------------------------------------------

/** A status chip: always a word, with a tone. Never colour alone. */
export const chip = (text, tone = 'gray', extra = '') => h('span', { class: `chip chip-${tone} ${extra}`.trim() }, text);

const CHANNEL_WORDS = { whatsapp: 'WhatsApp', telegram: 'Telegram', web: 'Website' };
export function channelBadge(channel, { compact = false } = {}) {
  if (!channel) return null;
  return h('span', { class: `channel channel-${channel}` },
    icon(channel === 'whatsapp' ? 'whatsapp' : channel === 'telegram' ? 'telegram' : 'chats', { size: 13 }),
    compact ? sr(CHANNEL_WORDS[channel] ?? channel) : (CHANNEL_WORDS[channel] ?? channel));
}
export const channelWords = (c) => CHANNEL_WORDS[c] ?? c ?? '';

export function emptyState(title, detail, action = null) {
  return h('div', { class: 'empty' },
    h('p', { class: 'empty-title' }, title),
    detail ? h('p', { class: 'empty-detail' }, detail) : null,
    action);
}

export function errorState(message, retry) {
  return h('div', { class: 'empty empty-error', role: 'alert' },
    h('p', { class: 'empty-title' }, message),
    retry ? h('button', { class: 'btn', type: 'button', onclick: retry }, icon('refresh'), 'Try again') : null);
}

export function skeleton(lines = 6) {
  return h('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': 'Loading' },
    Array.from({ length: lines }, (_, i) => h('div', { class: 'skeleton-line', style: { width: `${92 - (i % 3) * 14}%` } })));
}

/**
 * A button that may be disabled for a reason. Disabled buttons still say why -
 * as a tooltip AND as visible text when asked - because a greyed button with
 * no explanation sends people to ask a colleague.
 */
export function actionButton(spec, onclick, { cls = '', showReason = false } = {}) {
  const kind = {
    primary: 'btn-primary', danger: 'btn-danger', quiet: 'btn-quiet', 'danger-quiet': 'btn-quiet btn-quiet-danger',
  }[spec.kind] ?? '';
  const b = h('button', {
    type: 'button',
    class: `btn ${kind} ${cls}`.trim(),
    'aria-disabled': spec.enabled === false ? 'true' : null,
    title: spec.enabled === false ? spec.reason : null,
  }, spec.label);
  b.addEventListener('click', (e) => {
    if (b.getAttribute('aria-disabled') === 'true') {
      e.preventDefault();
      toast(spec.reason ?? 'This is not available.', 'info');
      return;
    }
    onclick(e, b);
  });
  if (showReason && spec.enabled === false && spec.reason) {
    const id = `why-${Math.random().toString(36).slice(2, 8)}`;
    b.setAttribute('aria-describedby', id);
    return h('span', { class: 'with-reason' }, b, h('span', { class: 'reason', id }, spec.reason));
  }
  return b;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export function age(since, now = Date.now()) {
  if (!since) return '';
  const ms = now - new Date(since).getTime();
  if (!Number.isFinite(ms)) return '';
  const mins = Math.floor(Math.max(ms, 0) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return days < 14 ? `${days} d` : `${Math.floor(days / 7)} wk`;
}

export const ago = (since) => {
  const a = age(since);
  return !a ? '' : a === 'just now' ? a : `${a} ago`;
};

export function when(at) {
  if (!at) return '';
  const d = new Date(at);
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function dayLabel(at) {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

export const clock = (at) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** A time that says "2 h" and, on hover, the exact moment. */
export const timeEl = (at, text = age(at)) => h('time', { datetime: at, title: when(at) }, text);

// ---------------------------------------------------------------------------
// Session and the API
// ---------------------------------------------------------------------------

/** The same keys the old console used, so nobody is signed out by the change. */
export const SKEY = 'mky-ops-secret';
export const NKEY = 'mky-ops-name';

export const session = {
  secret: safeGet(SKEY) ?? '',
  name: safeGet(NKEY) ?? '',
  role: null,
  permissions: [],
  features: {},
  saved_replies: [],
  team: [],
  can(p) { return this.permissions.includes(p); },
};

export function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
export function safeSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private window */ } }

const listeners = { offline: [], unauthorised: [] };
export const on = (event, fn) => listeners[event].push(fn);
let offline = false;
function setOffline(v) {
  if (offline === v) return;
  offline = v;
  for (const fn of listeners.offline) fn(v);
}
export const isOffline = () => offline;

/**
 * One call to the desk's API. The secret travels in a header, never the URL:
 * a query string lands in server logs and browser history.
 */
export async function api(params, { method = 'GET', body = null } = {}) {
  const qs = new URLSearchParams({ resource: 'console' });
  for (const [k, v] of Object.entries(params ?? {})) if (v != null && v !== '') qs.set(k, String(v));
  if (method === 'GET' && session.name) qs.set('operator', session.name);

  let res;
  try {
    res = await fetch(`/api/admin/ops?${qs}`, {
      method,
      headers: {
        'x-admin-secret': session.secret,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify({ ...body, operator: session.name }) : undefined,
      cache: 'no-store',
    });
  } catch {
    setOffline(true);
    throw Object.assign(new Error('You are offline. Nothing was sent — try again when the connection is back.'), { offline: true });
  }
  setOffline(false);

  const data = await res.json().catch(() => ({ error: 'The server sent something we could not read.' }));
  if (res.status === 401) {
    for (const fn of listeners.unauthorised) fn('That desk password was not accepted. Sign in again.');
  }
  if (!res.ok) throw Object.assign(new Error(data.error || 'That did not work.'), { status: res.status, data });
  return data;
}

export const post = (body) => api({}, { method: 'POST', body });

/** A key for one intended action; repeated on a retry so the server sends once. */
export function newKey() {
  try { return crypto.randomUUID().replace(/-/g, ''); } catch { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`; }
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export function toast(message, tone = 'ok', { timeout } = {}) {
  const region = $('#toasts');
  if (!region) return;
  const t = h('div', { class: `toast toast-${tone}`, role: tone === 'bad' ? 'alert' : 'status' },
    icon(tone === 'bad' ? 'alert' : tone === 'info' ? 'circle' : 'check', { size: 16 }),
    h('span', {}, message),
    h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', onclick: () => t.remove() }, icon('x', { size: 14 })));
  region.append(t);
  setTimeout(() => t.remove(), timeout ?? (tone === 'bad' ? 9000 : 4500));
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/**
 * A modal dialog. Native <dialog>: focus stays inside, Escape closes, and the
 * page behind cannot be clicked by accident.
 *
 * Each dialog is ONE intended action, so it carries one action key: pressing
 * the button again after a dropped connection repeats the same key and the
 * server recognises the repeat.
 */
export function dialog({ title, subtitle = null, body, actions = [], size = 'md', onClose = null, onStale = null }) {
  const key = newKey();
  const errorBox = h('div', { class: 'dialog-error', role: 'alert', hidden: true });
  const footer = h('div', { class: 'dialog-actions' });
  const el = h('dialog', { class: `dialog dialog-${size}`, 'aria-labelledby': 'dlg-title' },
    h('header', { class: 'dialog-head' },
      h('div', {},
        h('h2', { id: 'dlg-title', class: 'dialog-title' }, title),
        subtitle ? h('p', { class: 'dialog-sub' }, subtitle) : null),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => close() }, icon('x', { size: 18 }))),
    h('div', { class: 'dialog-body' }, body),
    errorBox,
    footer);

  let inFlight = false;
  const dlg = {
    el,
    key,
    close,
    error(msg) { errorBox.textContent = msg ?? ''; errorBox.hidden = !msg; },
    setActions(list) {
      footer.replaceChildren(...list.map((a) => {
        const b = h('button', { type: 'button', class: `btn ${a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : ''}`, disabled: a.disabled }, a.label);
        b.addEventListener('click', async () => {
          if (!a.run) return close();
          if (inFlight) return;   // a second press while the first is out does nothing
          inFlight = true;
          dlg.error(null);
          const before = b.textContent;
          for (const other of footer.querySelectorAll('button')) other.disabled = true;
          b.setAttribute('aria-busy', 'true');
          b.textContent = a.busy ?? 'Working…';
          try {
            const keep = await a.run(dlg);
            if (keep !== true) close();
          } catch (err) {
            dlg.error(err.message);
            // Somebody else changed this case: the dialog is about a record
            // that no longer exists in that form, so it closes and the page
            // shows the latest.
            if (err.data?.stale) { close(); onStale?.(err); }
          } finally {
            inFlight = false;
            for (const other of footer.querySelectorAll('button')) other.disabled = false;
            b.removeAttribute('aria-busy');
            b.textContent = before;
          }
        });
        return b;
      }));
    },
  };

  function close() {
    if (el.open) el.close();
  }
  // Escape while a send is in flight would hide whether it went.
  el.addEventListener('cancel', (e) => { if (inFlight) e.preventDefault(); });
  el.addEventListener('close', () => { el.remove(); onClose?.(); });
  dlg.setActions(actions);
  document.body.append(el);
  el.showModal();
  const first = el.querySelector('textarea, input:not([type=hidden]):not([type=radio]):not([type=checkbox]), select');
  (first ?? footer.querySelector('.btn-primary, .btn-danger') ?? el).focus();
  return dlg;
}

/** Waits `ms` after the last call before running - for search boxes and live previews. */
export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------------------------------------------------------------------------
// Drafts - nothing typed is lost
// ---------------------------------------------------------------------------

const DRAFT = 'mky-desk-draft:';
export const draft = {
  get: (key) => safeGet(DRAFT + key) ?? '',
  set: (key, v) => safeSet(DRAFT + key, v && v.trim() ? v : null),
};
