/**
 * The desk's building blocks: elements, the API, dialogs, toasts, icons, time.
 *
 * TEXT, NEVER HTML. Every string that reaches the page goes in as a text node
 * or an attribute value - h() has no way to take markup, and nothing in the
 * desk assigns innerHTML. Customer names and messages are written by anybody
 * with a phone, so a name like <script>…</script> must show up as those
 * characters, not run. A test greps every desk file for the ways HTML gets in.
 */

import { RHYTHM, SCOPES, pollDelay, changed, isArea } from './live.js';

export { SCOPES, VIEW_SCOPES, scopesOf, chatKey } from './live.js';

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

/**
 * Appends children the way h() does: arrays flattened, null and false
 * skipped. The DOM's own append() would print a skipped child as "null".
 */
export const add = (el, ...children) => { append(el, children); return el; };
/** Replaces everything inside an element with these children. */
export const fill = (el, ...children) => { el.replaceChildren(); append(el, children); return el; };

/**
 * Text a customer or the bot wrote, one line per element, each with its own
 * dir="auto". The bot's messages stack Arabic over English; given one
 * direction for the whole block, the English half is laid out right to left
 * and its full stops and colons land on the wrong side.
 */
export const lines = (text) => String(text ?? '').split('\n').map((line) => (line.trim()
  ? h('div', { dir: 'auto' }, line)
  : h('div', { class: 'line-gap', 'aria-hidden': 'true' })));

/** A visually hidden label for screen readers, beside something that is only an icon. */
export const sr = (text) => h('span', { class: 'sr-only' }, text);

// ---------------------------------------------------------------------------
// The brand
// ---------------------------------------------------------------------------

/**
 * Who the desk belongs to. The company's own badge (public/brand/) - dark,
 * gold and blue - sits in a dark rounded tile so it reads as a badge on the
 * light sidebar rather than a dark hole in it.
 */
export const BRAND = { name: 'MKY Global Forwarding', product: 'Operations desk', logo: '/brand/mky-logo.png' };
export const pageTitle = (count = 0) => (count ? `(${count}) ${BRAND.name}` : `${BRAND.name} — ${BRAND.product}`);
export const brandLogo = (size = '') => h('span', { class: `brand-logo${size ? ` brand-logo-${size}` : ''}` },
  h('img', { src: BRAND.logo, alt: '', width: size === 'lg' ? 120 : size === 'sm' ? 40 : 48, height: size === 'lg' ? 94 : size === 'sm' ? 32 : 38 }));

/**
 * What each of the four destinations is for, under its title - the owner's
 * words (docs/DESK-REDESIGN-PROMPT.md, section 3). Read together they tell
 * the Inbox (work to do) from Chats (talking to customers).
 */
export const PURPOSE = {
  inbox: 'Requests and issues that need your team.',
  chats: 'Read customer messages and reply.',
  shipments: 'Track confirmed shipments and update customers.',
  settings: 'Manage the team and how the bot works.',
};

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
  truck: ['M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2', 'M15 18H9', 'M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14', 'M17 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M7 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  stamp: ['M5 22h14', 'M19.27 13.73A2.5 2.5 0 0 0 17.5 13h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1.5c0-.66-.26-1.3-.73-1.77z', 'M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-3-3c-1.69 0-3 1-3 3s1 2 1 3.5V13'],
  pencil: ['M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z', 'M15 5l4 4'],
  dot: ['M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  minus: ['M5 12h14'],
  more: ['M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'],
  eye: ['M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  wifiOff: ['M12 20h.01', 'M8.5 16.43a5 5 0 0 1 7 0', 'M2 8.82a15 15 0 0 1 4.17-2.65', 'M10.66 5c4.01-.36 8.14.9 11.34 3.76', 'M16.85 11.25a10 10 0 0 1 2.22 1.68', 'M5 13a10 10 0 0 1 5.24-2.76', 'M2 2l20 20'],
  userPlus: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M19 8v6', 'M22 11h-6'],
  userX: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M17 8l5 5', 'M22 8l-5 5'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  reply: ['M9 17l-5-5 5-5', 'M20 18v-2a4 4 0 0 0-4-4H4'],
  calendar: ['M8 2v4', 'M16 2v4', 'M3 10h18', 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z'],
  checkCircle: ['M22 11.08V12a10 10 0 1 1-5.93-9.14', 'M22 4 12 14.01l-3-3'],
  template: ['M4 4h16v16H4z', 'M8 9h8', 'M8 13h8', 'M8 17h5'],
  hours: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  // Files in a conversation.
  paperclip: ['m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48'],
  image: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'm21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21'],
  imageOff: ['M2 2l20 20', 'M10.41 10.41a2 2 0 1 1-2.83-2.83', 'M13.5 13.5 6 21', 'M18 12l3 3', 'M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.05-.22 1.41-.59', 'M21 15V5a2 2 0 0 0-2-2H9'],
  mic: ['M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v3'],
  video: ['m16 13 5.22 3.48a.5.5 0 0 0 .78-.42V7.94a.5.5 0 0 0-.78-.42L16 11', 'M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z'],
  mapPin: ['M20 10c0 4.99-5.54 10.19-7.4 11.8a1 1 0 0 1-1.2 0C9.54 20.19 4 14.99 4 10a8 8 0 0 1 16 0', 'M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  smile: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M8 14s1.5 2 4 2 4-2 4-2', 'M9 9h.01', 'M15 9h.01'],
  fileText: ['M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8', 'M10 9H8'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
};

/** Icons drawn filled rather than outlined. */
const FILLED = new Set(['dot', 'more']);

export function icon(name, { size = 16, cls = '' } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', FILLED.has(name) ? 'currentColor' : 'none');
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

/**
 * The status badge: a word, an icon by meaning, and a tone - never colour
 * alone. Tones are the server's: blue = ours to do, amber = waiting on the
 * customer or getting late, green = done, red = something is wrong, gray =
 * closed or neutral. docs/DESK-DESIGN-SYSTEM.md maps every status to one.
 */
const TONE_ICON = { blue: 'dot', amber: 'clock', green: 'check', red: 'alert', gray: 'minus' };
export function badge(text, tone = 'gray', { outline = false, small = false, icon: ic } = {}) {
  const t = TONE_ICON[tone] ? tone : 'gray';
  const name = ic === false ? null : (ic ?? TONE_ICON[t]);
  return h('span', { class: `badge badge-${t}${outline ? ' badge-outline' : ''}${small ? ' badge-sm' : ''}` },
    name ? icon(name, { size: small ? 11 : name === 'dot' ? 10 : 13 }) : null, text);
}

/** A tag says what KIND of thing something is (a booking, Arabic, WhatsApp) - not its state. */
export function tag(text, { icon: ic = null, quiet = false, href = null, title = null } = {}) {
  return h(href ? 'a' : 'span', { class: `tag${quiet ? ' tag-quiet' : ''}`, href, title }, ic ? icon(ic, { size: 13 }) : null, text);
}

const CHANNEL_WORDS = { whatsapp: 'WhatsApp', telegram: 'Telegram', web: 'Website' };
const CHANNEL_ICON = { whatsapp: 'whatsapp', telegram: 'telegram' };
/** The channel as its icon alone, with the word for screen readers. */
export const channelIcon = (channel, size = 14) => h('span', { class: `channel channel-${channel}`, title: CHANNEL_WORDS[channel] ?? channel },
  icon(CHANNEL_ICON[channel] ?? 'chats', { size }), sr(CHANNEL_WORDS[channel] ?? channel ?? ''));
export function channelBadge(channel, { compact = false } = {}) {
  if (!channel) return null;
  if (compact) return channelIcon(channel, 14);
  return h('span', { class: `channel channel-${channel}` },
    icon(CHANNEL_ICON[channel] ?? 'chats', { size: 14 }), CHANNEL_WORDS[channel] ?? channel);
}
export const channelWords = (c) => CHANNEL_WORDS[c] ?? c ?? '';

/**
 * Initials in a circle: who has a case, who wrote. The colour comes from the
 * name, so the same person always looks the same; it carries no meaning.
 */
export function initials(name) {
  const words = String(name ?? '').replace(/[—–-]/g, ' ').split(/\s+/).filter((w) => /\p{L}/u.test(w));
  const letters = words.slice(0, 2).map((w) => [...w.replace(/[^\p{L}]/gu, '')][0] ?? '');
  return letters.join('') || '?';
}
export function avatar(name, { size = '', channel = null, title = null } = {}) {
  let hash = 0;
  for (const ch of String(name ?? '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return h('span', { class: `avatar av-${hash % 6}${size ? ` avatar-${size}` : ''}`, 'aria-hidden': 'true', title },
    initials(name),
    channel && CHANNEL_ICON[channel] ? h('span', { class: `avatar-mark avatar-mark-${channel}` }, icon(CHANNEL_ICON[channel], { size: 10 })) : null);
}

/** Nothing to show: what this place is for, and the one thing to do about it. */
export function emptyState(title, detail, action = null, { icon: ic = 'inbox', tone = '' } = {}) {
  return h('div', { class: `empty${tone ? ` empty-${tone}` : ''}` },
    ic ? h('span', { class: 'empty-icon', 'aria-hidden': 'true' }, icon(ic, { size: 22 })) : null,
    h('p', { class: 'empty-title' }, title),
    detail ? h('p', { class: 'empty-detail' }, detail) : null,
    action);
}

/**
 * Something did not load. Takes the error itself where it can, because "you
 * are offline", "your role cannot see this" and "the server failed" need
 * different words and different next steps.
 */
export function errorState(problem, retry) {
  const err = problem instanceof Error ? problem : null;
  const message = err ? err.message : String(problem ?? 'That did not load.');
  if (err?.status === 403) {
    return h('div', { class: 'empty empty-locked', role: 'alert' },
      h('span', { class: 'empty-icon', 'aria-hidden': 'true' }, icon('lock', { size: 22 })),
      h('p', { class: 'empty-title' }, 'Your role cannot open this'),
      h('p', { class: 'empty-detail' }, message));
  }
  return h('div', { class: 'empty empty-error', role: 'alert' },
    h('span', { class: 'empty-icon', 'aria-hidden': 'true' }, icon(err?.offline ? 'wifiOff' : 'alert', { size: 22 })),
    h('p', { class: 'empty-title' }, err?.offline ? 'You are offline' : message),
    err?.offline ? h('p', { class: 'empty-detail' }, 'Nothing you typed is lost. This loads again when the connection is back.') : null,
    retry ? h('button', { class: 'btn', type: 'button', onclick: retry }, icon('refresh', { size: 15 }), 'Try again') : null);
}

/**
 * A placeholder shaped like what is coming, so the page does not jump when it
 * arrives: 'rows' for a list, 'cards' for a case page, 'lines' for anything else.
 */
export function skeleton(lines = 6, { kind = 'lines' } = {}) {
  const box = (cls) => h('div', { class: `sk ${cls}` });
  const body = kind === 'rows'
    ? Array.from({ length: lines }, () => h('div', { class: 'sk-row' }, box('sk-circle'),
      h('div', { class: 'sk-lines' }, box('sk-l1'), box('sk-l2')), box('sk-pill'), box('sk-short')))
    : kind === 'cards'
      ? Array.from({ length: Math.max(2, Math.ceil(lines / 3)) }, (_, i) => box(`sk-card${i === 0 ? ' sk-card-tall' : ''}`))
      : Array.from({ length: lines }, (_, i) => h('div', { class: 'skeleton-line', style: { width: `${92 - (i % 3) * 14}%` } }));
  return h('div', { class: `skeleton${kind === 'lines' ? '' : ` skeleton-${kind}`}`, 'aria-busy': 'true', 'aria-label': 'Loading' }, body);
}

/**
 * A button that may be disabled for a reason. Disabled buttons still say why -
 * as a tooltip AND as visible text when asked - because a greyed button with
 * no explanation sends people to ask a colleague.
 *
 * kind: primary | secondary (default) | ghost | danger | danger-secondary |
 * danger-ghost. 'quiet' and 'danger-quiet' are the old names of the ghost
 * ones; the server still sends 'danger' for a secondary that cannot be undone.
 */
const BUTTON_KIND = {
  primary: 'btn-primary', secondary: 'btn-secondary', danger: 'btn-danger', ghost: 'btn-ghost', quiet: 'btn-ghost',
  'danger-secondary': 'btn-secondary btn-danger-ghost', 'danger-ghost': 'btn-ghost btn-danger-ghost', 'danger-quiet': 'btn-ghost btn-danger-ghost',
};
export function actionButton(spec, onclick, { cls = '', showReason = false, iconName = null } = {}) {
  const kind = BUTTON_KIND[spec.kind] ?? 'btn-secondary';
  const b = h('button', {
    type: 'button',
    class: `btn ${kind} ${cls}`.trim(),
    'aria-disabled': spec.enabled === false ? 'true' : null,
    title: spec.enabled === false ? spec.reason : null,
  }, iconName ? icon(iconName, { size: 16 }) : null, spec.label);
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
 * The last answer to each GET, with the ETag the server gave it. The next
 * time the same thing is asked for, the ETag goes with it; when the server
 * says 304 (nothing it shows has changed) the answer kept here is returned -
 * the very same object, so a screen can tell nothing changed by comparing.
 */
const answers = new Map();
const ANSWERS_KEPT = 40;
/**
 * How long a read may take before it is given up on. An object, not a
 * constant, so a test can shorten it.
 */
export const limits = { getTimeoutMs: 30_000 };

/**
 * Reads that failed - a server error, a timeout, an answer that could not be
 * read - counted, so the live loop can tell a screen's refresh that quietly
 * showed nothing new from one that did not load at all (a screen's own load
 * function may not say).
 */
let readFailures = 0;

/** Forgets every kept answer: on signing out, they are someone else's now. */
export function forgetAnswers() { answers.clear(); }

/**
 * One call to the desk's API. The secret travels in a header, never the URL:
 * a query string lands in server logs and browser history.
 *
 * `signal` aborts it: a screen that has been left does not finish loading
 * into a page nobody is looking at. An aborted call throws an error with
 * `aborted: true`, which is not "offline" and is not worth showing.
 */
export async function api(params, { method = 'GET', body = null, signal = null } = {}) {
  const qs = new URLSearchParams({ resource: 'console' });
  for (const [k, v] of Object.entries(params ?? {})) if (v != null && v !== '') qs.set(k, String(v));
  if (method === 'GET' && session.name) qs.set('operator', session.name);
  const url = `/api/admin/ops?${qs}`;
  const kept = method === 'GET' ? answers.get(url) ?? null : null;
  // A read that has not answered in 30 s is not going to: it is given up on,
  // so the loop that asked can ask again. Actions are left to finish.
  const late = method === 'GET' && typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(limits.getTimeoutMs) : null;
  const both = signal && late ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, late]) : signal) : (signal ?? late);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'x-admin-secret': session.secret,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(kept ? { 'if-none-match': kept.etag } : {}),
      },
      body: body ? JSON.stringify({ ...body, operator: session.name }) : undefined,
      cache: 'no-store',
      signal: both ?? undefined,
    });
  } catch (err) {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled.'), { aborted: true });
    if (method === 'GET') readFailures += 1;
    if (late?.aborted) throw Object.assign(new Error('The server took too long to answer. Try again.'), { status: 504 });
    if (err?.name === 'AbortError') throw Object.assign(new Error('Cancelled.'), { aborted: true });
    setOffline(true);
    throw Object.assign(new Error('You are offline. Nothing was sent — try again when the connection is back.'), { offline: true });
  }
  setOffline(false);

  if (res.status === 304 && kept) return kept.data;

  // The body can fail after the headers arrived: the screen was left, the
  // read timed out, the connection dropped. That is not an answer - it is
  // never kept, and never handed to a screen as one.
  let data;
  try {
    data = await res.json();
  } catch {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled.'), { aborted: true });
    if (method === 'GET') readFailures += 1;
    if (res.ok) throw Object.assign(new Error('The server sent something we could not read. Try again.'), { status: 502 });
    data = { error: 'The server sent something we could not read.' };
  }
  if (res.status === 401) {
    for (const fn of listeners.unauthorised) fn('That desk password was not accepted. Sign in again.');
  }
  if (!res.ok) {
    if (method === 'GET' && res.status >= 500) readFailures += 1;
    throw Object.assign(new Error(data?.error || 'That did not work.'), { status: res.status, data });
  }

  if (method === 'GET') {
    const etag = res.headers?.get?.('etag');
    answers.delete(url);
    if (etag) {
      answers.set(url, { etag, data });
      if (answers.size > ANSWERS_KEPT) answers.delete(answers.keys().next().value);
    }
  } else {
    // An action changes what other screens show (the counts, a colleague's
    // view of the same case): look again shortly, once this screen has
    // reloaded itself.
    poke(1000);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Keeping the screen true: one cheap question, then only what changed
// ---------------------------------------------------------------------------

/**
 * The desk used to fetch the whole of every screen every 20 seconds. Now it
 * asks the server for the pulse - the version of each area of the desk, and
 * of each record an open screen shows (booking:<ref>, chat:<channel>:<id>…),
 * in one cheap read - and fetches a screen again only when something it
 * shows has moved, or when it has not been fetched for MAX_AGE (what it says
 * about the time - "overdue", "done today" - moves without any write).
 *
 * Scopes are the areas (SCOPES) for lists and the record's own keys for a
 * page that shows one - scopesOf(view, params) gives either, the same answer
 * the server uses to decide "not modified":
 *
 *   subscribe(scopesOf('chat', { channel, chat_id }), () => convo.refresh());
 *
 * The rhythm (public/desk/live.js RHYTHM): every 15 seconds while the page is
 * visible and somebody is using it; every minute once nobody has touched it
 * for three; not at all while the tab is hidden; at once when it comes back,
 * gets focus or comes back online, and a second after the operator's own
 * action. Each wait is spread ±15% so ten desks do not ask in step, and
 * doubles after each failure, up to two minutes.
 *
 * A server without the pulse (an older database) is asked for every screen on
 * the old 20-second timer, with the same discipline; it is asked about the
 * pulse again every five minutes, so the desk catches up when the migration
 * lands.
 *
 *   const sub = subscribe(['bookings', 'requests'], async () => { …load…; return ok; });
 *   sub.now();          // refresh it now, through the same one-at-a-time guard
 *   sub.unsubscribe();  // when the screen goes
 *
 * `refresh` may return false to say it did not load (it is tried again on the
 * next tick, rather than counted as caught up). Only one refresh of a
 * subscription is ever in flight; one asked for meanwhile runs once after it.
 *
 * `minGapMs` keeps a subscription from being refreshed more often than that,
 * however often its scopes move: for something expensive that moves with
 * every message (a conversation, the list of chats), or a screen that names
 * no scopes - it is then fetched at most as often as before the pulse.
 */
const live = {
  running: false,
  subs: new Set(),
  versions: null,       // the last pulse's versions
  supported: null,      // null until asked; false: the server has no pulse
  probedAt: 0,
  timer: null,
  checking: null,       // the check in flight
  again: false,
  errors: 0,
  lastInput: Date.now(),
};

const PULSE_RECHECK_MS = 300_000;

/** Subscribes a refresh to the scopes it shows. See above. */
export function subscribe(scopes, refresh, { maxAgeMs = RHYTHM.maxAgeMs, minGapMs = 0 } = {}) {
  const sub = {
    scopes: Array.isArray(scopes) && scopes.length ? scopes : SCOPES,
    refresh,
    maxAgeMs,
    minGapMs,
    // What the screen was loaded against: the last pulse before it loaded.
    // Anything that moved after that is fetched on the next tick.
    seen: live.versions ? { ...live.versions } : null,
    lastRun: Date.now(),
    running: null,
    again: false,
    closed: false,
  };
  live.subs.add(sub);
  return {
    unsubscribe() { sub.closed = true; live.subs.delete(sub); },
    now: () => runSub(sub, live.versions, { queue: true }),
  };
}

/**
 * Runs a subscription's refresh, one at a time. A tick that finds it still
 * loading leaves it be: when it finishes it has caught up to the versions it
 * started from, and the next tick sees anything newer. An explicit now()
 * asked meanwhile runs once more after it.
 */
function runSub(sub, versions, { queue = false } = {}) {
  if (sub.closed) return Promise.resolve();
  if (sub.running) { if (queue) sub.again = true; return sub.running; }
  const against = versions ? { ...versions } : null;
  sub.running = (async () => {
    const failuresBefore = readFailures;
    try {
      const ok = await sub.refresh();
      // Caught up only if it said so - or said nothing and no read failed
      // meanwhile (another screen's failure only costs one more look).
      if (ok !== false && readFailures === failuresBefore) { sub.seen = against; sub.lastRun = Date.now(); }
    } catch { /* a screen says its own errors */ }
  })().finally(() => {
    sub.running = null;
    if (sub.again && !sub.closed) { sub.again = false; runSub(sub, live.versions); }
  });
  return sub.running;
}

/** Whether a subscription must be refreshed on this tick. */
function due(sub, now = Date.now()) {
  if (sub.closed) return false;
  if (now - sub.lastRun < sub.minGapMs) return false;
  if (live.supported !== true) return true;
  return changed(sub.scopes, sub.seen, live.versions) || now - sub.lastRun >= sub.maxAgeMs;
}

async function check() {
  clearTimeout(live.timer);
  if (!live.running) return;
  if (live.checking) { live.again = true; return; }
  if (typeof document !== 'undefined' && document.hidden) return;   // the tab coming back resumes it
  live.checking = (async () => {
    try {
      if (live.supported !== false || Date.now() - live.probedAt >= PULSE_RECHECK_MS) {
        live.probedAt = Date.now();
        // The areas always; the records the open screens show by name
        // (booking:…, chat:…), so a case is fetched again when it moves and
        // not when another one does.
        const watch = [...new Set([...live.subs].flatMap((s) => s.scopes).filter((k) => !isArea(k)))].slice(0, 20);
        let p;
        try {
          p = await api({ view: 'pulse', watch: watch.join(',') });
        } catch (err) {
          // An older server, mid-deploy, does not know the view.
          if (err.status === 400 || err.status === 404) p = { supported: false };
          else throw err;
        }
        live.supported = p.supported === true;
        if (live.supported) live.versions = p.versions ?? null;
      }
      // Not waited for: a screen that is slow to load must not hold up the
      // next pulse. Each subscription has one refresh in flight at most.
      for (const s of [...live.subs].filter((x) => due(x))) runSub(s, live.versions);
      live.errors = 0;
    } catch (err) {
      if (!err?.aborted) live.errors += 1;
    }
  })().finally(() => {
    live.checking = null;
    if (live.again) { live.again = false; check(); } else schedule();
  });
}

function schedule(ms = null) {
  clearTimeout(live.timer);
  if (!live.running) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  const wait = ms ?? pollDelay({ idleForMs: Date.now() - live.lastInput, errors: live.errors, supported: live.supported });
  live.timer = setTimeout(check, wait);
}

/** Asks again soon: after an action, on focus, coming back online. */
export function poke(delayMs = 0) {
  if (!live.running) return;
  if (live.checking) { live.again = true; return; }
  schedule(delayMs);
}

/** The pulse read at sign-in, so the first screen's subscriptions know what they were loaded against. */
export function primeLive(pulse) {
  if (!pulse) return;
  live.supported = pulse.supported === true;
  live.probedAt = Date.now();
  live.versions = live.supported ? pulse.versions ?? null : null;
}

let wired = false;
function wire() {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(live.timer); else poke(0); });
  window.addEventListener('focus', () => poke(0));
  window.addEventListener('online', () => poke(0));
  const touched = () => {
    const wasIdle = Date.now() - live.lastInput >= RHYTHM.idleAfterMs;
    live.lastInput = Date.now();
    if (wasIdle) poke(300);   // somebody is back: catch up now, not in a minute
  };
  for (const e of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(e, touched, { passive: true, capture: true });
}

/** Starts asking. Called once the operator is signed in. */
export function startLive() {
  wire();
  live.running = true;
  live.errors = 0;
  schedule();
}

/** Stops asking, and forgets every subscription: on signing out. */
export function stopLive() {
  live.running = false;
  clearTimeout(live.timer);
  for (const s of live.subs) s.closed = true;
  live.subs.clear();
  live.versions = null;
  live.supported = null;
}

/** What the loop knows, for the tests and for a curious developer at the console. */
export const liveState = () => ({
  running: live.running, supported: live.supported, versions: live.versions,
  subscriptions: live.subs.size, errors: live.errors, idleForMs: Date.now() - live.lastInput,
});

export const post = (body) => api({}, { method: 'POST', body });

/**
 * Puts one file at a signed upload address the server handed out (storage's
 * own, not this API's: a file never passes through the 4.5 MB API, and the
 * desk never holds a storage key). XMLHttpRequest rather than fetch, because
 * only it reports upload progress. Resolves when storage has the whole file.
 */
export function uploadFile(url, file, { onProgress = null, contentType = null } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', contentType || file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-upsert', 'true');
    xhr.upload.addEventListener('progress', (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) { setOffline(false); return resolve(); }
      reject(Object.assign(new Error(`The upload was refused (${xhr.status}). Try again.`), { status: xhr.status }));
    });
    const lost = () => {
      const offlineNow = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (offlineNow) setOffline(true);
      reject(Object.assign(new Error(offlineNow ? 'You are offline. The file was not uploaded — try again when the connection is back.' : 'The upload stopped. Try again.'), { offline: offlineNow }));
    };
    xhr.addEventListener('error', lost);
    xhr.addEventListener('timeout', lost);
    xhr.send(file);
  });
}

/** A key for one intended action; repeated on a retry so the server sends once. */
export function newKey() {
  try { return crypto.randomUUID().replace(/-/g, ''); } catch { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`; }
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

/**
 * tone: ok (done), info (worth knowing), warn (could not, but nothing broke -
 * offline, not allowed), bad (it failed). The icon says which without colour.
 *
 * action: { label, run } adds one button to the toast - for the one thing a
 * person may want to do about what it says ("Ask anyway"). Pressing it runs
 * `run` once and closes the toast; a toast with an action stays longer.
 */
const TOAST_ICON = { ok: 'checkCircle', info: 'circle', warn: 'alert', bad: 'alert' };
export function toast(message, tone = 'ok', { timeout, icon: ic = null, action = null } = {}) {
  const region = $('#toasts');
  if (!region) return;
  let act = null;
  if (action) {
    act = h('button', { class: 'toast-action', type: 'button' }, action.label);
    act.addEventListener('click', async () => {
      act.disabled = true;
      t.remove();
      await action.run();
    }, { once: true });
  }
  const t = h('div', { class: `toast toast-${tone}${act ? ' has-action' : ''}`, role: tone === 'bad' || tone === 'warn' ? 'alert' : 'status' },
    icon(ic ?? TOAST_ICON[tone] ?? 'circle', { size: 18 }),
    h('span', {}, message, act),
    h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', onclick: () => t.remove() }, icon('x', { size: 14 })));
  region.append(t);
  // A modal dialog lives in the browser's top layer, above everything else on
  // the page - including toasts. Shown as a popover, the region is put back on
  // top each time, so "Sent" is visible over the dialog that sent it.
  if (typeof region.showPopover === 'function') {
    try { if (region.matches(':popover-open')) region.hidePopover(); region.showPopover(); } catch { /* not supported */ }
  }
  setTimeout(() => t.remove(), timeout ?? (act ? 15000 : tone === 'bad' || tone === 'warn' ? 9000 : 4500));
}

/**
 * A failed action, said the way its cause deserves. Offline and "your role
 * cannot do this" are not failures of the desk - nothing broke and nothing was
 * sent - so they are a calm warning with the reason, not a red alarm. A record
 * a colleague changed meanwhile is news, not an error.
 */
export function toastError(err, fallback = 'That did not work.') {
  if (err?.offline) return toast(err.message || 'You are offline. Nothing was sent.', 'warn', { icon: 'wifiOff' });
  if (err?.status === 403) return toast(err.message || 'Your role cannot do this.', 'warn', { icon: 'lock' });
  if (err?.data?.stale || err?.status === 409) return toast(err.message, 'info', { timeout: 9000 });
  return toast(err?.message || fallback, 'bad');
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
export function dialog({ title, subtitle = null, body, actions = [], size = 'md', onClose = null, onStale = null, extra = null }) {
  const key = newKey();
  const errorBox = h('div', { class: 'dialog-error', role: 'alert', hidden: true });
  const footer = h('div', { class: 'dialog-actions' });
  const el = h('dialog', { class: `dialog dialog-${size}`, 'aria-labelledby': 'dlg-title' },
    h('header', { class: 'dialog-head' },
      h('div', {},
        h('h2', { id: 'dlg-title', class: 'dialog-title' }, title),
        subtitle ? h('p', { class: 'dialog-sub' }, subtitle) : null),
      extra ? h('div', { class: 'dialog-extra' }, extra) : null,
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
