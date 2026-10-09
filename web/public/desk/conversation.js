/**
 * A conversation with one customer, the way they saw it, and a box to answer.
 *
 * Shaped like the chat apps everybody already knows: the customer on the left,
 * us on the right, and every message of ours says who sent it - the bot, a
 * named person, or an automatic notification. Each line is shown with
 * dir="auto", so Arabic runs right to left and English left to right, line by
 * line, whatever the rest of the page is doing.
 *
 * THE MESSAGES GET THE HEIGHT. The header is one line (who, how to reach
 * them, the WhatsApp window as a chip, their bookings as chips), the composer
 * one line that grows to six; everything between is the transcript, which
 * scrolls on its own and opens on the newest message.
 *
 * FILES, BOTH WAYS. A photo is a thumbnail, a paper a chip with its name, type
 * and size, a voice note a player; each is fetched through a link that lasts
 * ten minutes, asked for only when it scrolls into view (lib/admin/desk-media.js).
 * A file that was not kept says why. The composer attaches files - picked,
 * dropped or pasted - uploads each straight to storage with its progress, and
 * sends them on the customer's channel with the words typed as the caption
 * (lib/admin/desk-files.js).
 *
 * The composer knows the channel's rules. It never pretends it can send
 * something the server will refuse: outside WhatsApp's 24 hours it offers the
 * "please reply" template instead, and after STOP it says so.
 */

import {
  h, clear, icon, api, post, newKey, toast, toastError, badge, tag, channelBadge, avatar, clock, dayLabel, draft, session, safeGet, safeSet,
  errorState, skeleton, add, fill, uploadFile,
} from './ui.js';
import { openFilePreview } from './viewer.js';

const STATUS_MARK = {
  queued: ['Queued', 'clock'],
  sent: ['Sent', 'check'],
  delivered: ['Delivered', 'check2'],
  read: ['Read', 'check2'],
  received: [null, null],
  failed: ['Not delivered', 'alert'],
};
const KIND_WORDS = { document: 'File', image: 'Photo', template: 'Template', audio: 'Voice note', video: 'Video', location: 'Location', sticker: 'Sticker', contact: 'Contact' };
const FILE_KINDS = ['document', 'image', 'video', 'audio', 'sticker'];
const LANG = { ar: 'Arabic', en: 'English' };
/** Inbound photos this close together, uncaptioned after the first, are one album. */
const ALBUM_MS = 2 * 60_000;

/** Remembers, per browser, the newest customer message each chat has shown - for "unread". */
export const seen = {
  key: (channel, chatId) => `mky-desk-seen:${channel}|${chatId}`,
  get: (channel, chatId) => safeGet(seen.key(channel, chatId)),
  mark: (channel, chatId, at) => { if (at) safeSet(seen.key(channel, chatId), at); },
};

// ---------------------------------------------------------------------------
// Words with links
// ---------------------------------------------------------------------------

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"“”]+/gi;
const TRAILING = /[.,;:!?)\]}’'»]+$/;

/** One line of a message, with every web address in it a link that opens in a new tab. */
function linkified(line) {
  const out = [];
  let last = 0;
  for (const match of line.matchAll(URL_IN_TEXT)) {
    let url = match[0];
    const trail = TRAILING.exec(url)?.[0] ?? '';
    if (trail) url = url.slice(0, -trail.length);
    let ok = false;
    try { ok = ['http:', 'https:'].includes(new URL(url).protocol); } catch { ok = false; }
    if (!ok) continue;
    out.push(line.slice(last, match.index));
    out.push(h('a', { class: 'msg-link', href: url, target: '_blank', rel: 'noopener noreferrer nofollow', dir: 'ltr' }, url));
    last = match.index + url.length;
  }
  out.push(line.slice(last));
  return out;
}

/** A message's text, one element per line, each laid out in its own direction. */
const richLines = (text) => String(text ?? '').split('\n').map((line) => (line.trim()
  ? h('div', { dir: 'auto' }, linkified(line))
  : h('div', { class: 'line-gap', 'aria-hidden': 'true' })));

const duration = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : null);
const sizeWords = (n) => {
  if (n >= 1048576) { const v = n / 1048576; return `${Number.isInteger(v) || v >= 10 ? Math.round(v) : v.toFixed(1)} MB`; }
  return n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`;
};
const typeWords = (f) => {
  const ext = /\.([a-z0-9]{2,5})$/i.exec(f.name ?? '')?.[1];
  if (f.kind === 'pdf') return 'PDF';
  if (ext) return ext.toUpperCase();
  return String(f.mime ?? '').split('/')[1]?.split(/[;+.]/)[0]?.toUpperCase() || 'File';
};

/**
 * @param {HTMLElement} container
 * @param {{channel: string, chatId: string|null, target: object, draftKey: string, onSent?: Function, onLoad?: Function,
 *          headExtra?: (data: object) => any, fileOn?: (data: object) => Array<{booking_ref: string, label?: string}>,
 *          openPaper?: (id: number) => void}} opts
 *   target     what a send is about: { booking_ref } | { ticket_ref } | { channel, chat_id }
 *   headExtra  more chips for the header line (the Chats page puts the customer's bookings there)
 *   fileOn     the bookings a sent file may also be filed on, as an MKY document
 *   openPaper  opens a paper the bot read in the document viewer
 */
export function mountConversation(container, {
  channel, chatId, target, draftKey, onSent = null, onLoad = null, headExtra = null, fileOn = null, openPaper = null,
}) {
  let data = null;
  let signature = null;   // null, not '': an empty conversation must still be drawn once
  let composerMode = null;
  let pendingKey = null;
  let older = [];         // messages loaded with "Show earlier messages", kept across refreshes
  let loadingOlder = false;

  container.classList.add('convo');
  const head = h('div', { class: 'convo-head' });
  const notice = h('p', { class: 'convo-notice', hidden: true });
  const transcript = h('div', { class: 'transcript', role: 'log', 'aria-label': 'Conversation', tabindex: '0' });
  const pill = h('button', { class: 'new-pill', type: 'button', hidden: true, onclick: () => toEnd() }, 'New messages', icon('down', { size: 14 }));
  const composer = h('div', { class: 'composer' });
  const drop = h('div', { class: 'convo-drop', hidden: true, 'aria-hidden': 'true' }, icon('upload', { size: 22 }), h('span', {}, 'Drop the files to attach them'));
  add(container, head, notice, h('div', { class: 'transcript-wrap' }, transcript, pill), composer, drop);

  if (!chatId) {
    add(head, h('div', { class: 'convo-id' }, h('h2', { class: 'convo-title' }, 'Conversation')));
    add(transcript, h('p', { class: 'convo-empty' }, 'This customer has no chat linked, so there is no conversation to show or answer.'));
    return { refresh() {}, dispose() {} };
  }
  add(transcript, skeleton(4));

  async function load({ quiet = false } = {}) {
    try {
      data = await api({ view: 'chat', channel, chat_id: chatId });
    } catch (err) {
      if (!quiet) fill(transcript, errorState(err.message ? err : 'We could not load the conversation.', () => load()));
      return;
    }
    if (older.length) {
      const have = new Set(data.messages.map((m) => m.id));
      data.messages = [...older.filter((m) => !have.has(m.id)), ...data.messages];
    }
    drawHead();
    onLoad?.(data);
    notice.hidden = !data.notice;
    notice.textContent = data.notice ?? '';
    const sig = data.messages.map((m) => `${m.id}:${m.status}:${m.retried}:${m.file?.ref ?? ''}:${m.file?.paper?.status_words ?? ''}:${m.file?.paper?.note ?? ''}`).join(',') + `|${data.has_more}|${data.composer.mode}`;
    if (sig !== signature) {
      const atEnd = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 60;
      const first = signature === null;
      signature = sig;
      drawTranscript();
      if (first || atEnd) toEnd(); else pill.hidden = false;
    }
    const lastIn = [...data.messages].reverse().find((m) => m.direction === 'in');
    seen.mark(channel, chatId, lastIn?.at);
    const mode = `${data.composer.mode}|${data.composer.reason ?? ''}|${session.can('chat')}`;
    if (mode !== composerMode) { composerMode = mode; drawComposer(); }
  }

  // Whether the newest message is in view. While it is, the transcript stays
  // pinned to the bottom even when its box changes size (the header settling,
  // the composer growing, a phone keyboard opening, a photo arriving).
  // A scroll the desk made itself does not count as the person scrolling away.
  let pinned = true;
  let ownScrollUntil = 0;
  const stickToEnd = () => {
    ownScrollUntil = performance.now() + 250;
    transcript.scrollTop = transcript.scrollHeight;
  };
  function toEnd() {
    stickToEnd();
    pinned = true;
    pill.hidden = true;
  }
  transcript.addEventListener('scroll', () => {
    if (performance.now() < ownScrollUntil) return;
    pinned = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 60;
    if (pinned) pill.hidden = true;
  });
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => { if (pinned) stickToEnd(); }).observe(transcript);
  }

  // -- header -----------------------------------------------------------------
  // Drawn again only when something in it changed - not on every refresh, which
  // would close the "+N" bookings menu under somebody's pointer.
  let headDrawn = null;
  function drawHead() {
    const c = data.customer;
    const sig = JSON.stringify([c, data.window?.closes_at, data.composer.mode, data.bookings, data.requests, Math.floor(Date.now() / 600_000)]);
    if (sig === headDrawn) return;
    headDrawn = sig;
    const profile = c.profile_name && c.profile_name !== c.name ? `${c.channel === 'whatsapp' ? 'WhatsApp' : 'Profile'} name: ${c.profile_name}` : null;
    fill(head,
      avatar(c.name, { channel: c.channel }),
      h('h2', { class: 'convo-title', title: [c.name, profile, c.bot_state_words ? `With the bot: ${c.bot_state_words}` : null].filter(Boolean).join('\n') },
        h('bdi', {}, c.name)),
      h('span', { class: 'convo-chips' },
        c.channel ? tag(channelBadge(c.channel)) : null,
        // Not chosen means the bot writes to them in both languages.
        c.language ? tag(LANG[c.language], { quiet: true }) : tag('No language yet', { quiet: true, title: 'They have not chosen a language: the bot writes to them in both.' }),
        c.opted_out_at ? badge('Wrote STOP', 'red', { small: true }) : null,
        c.is_blocked ? badge('Blocked', 'red', { icon: 'lock', small: true }) : null),
      c.phone ? h('a', { href: `tel:${c.phone.replace(/[^\d+]/g, '')}`, class: 'convo-phone' }, icon('phone', { size: 13 }), h('bdi', { dir: 'ltr' }, c.phone)) : null,
      profile ? h('span', { class: 'convo-profile' }, h('bdi', {}, profile)) : null,
      windowChip(),
      headExtra ? h('span', { class: 'convo-extra' }, headExtra(data)) : null);
  }

  /**
   * The WhatsApp window, as a chip in the header: open and how long, closing
   * (amber, under three hours), or not known. Closed, opted out or blocked is
   * the composer's banner, because there is a button to go with it.
   */
  function windowChip() {
    const w = data.window ?? {};
    if (data.composer.mode !== 'text' || !w.applies) return null;
    if (!w.closes_at) {
      return h('span', { class: 'window-chip tone-gray', title: data.composer.note ?? '' }, icon('clock', { size: 13 }), 'Window not known');
    }
    const ms = new Date(w.closes_at).getTime() - Date.now();
    const hours = Math.max(0, Math.floor(ms / 3600_000));
    const closing = hours < 3;
    return h('span', {
      class: `window-chip ${closing ? 'tone-amber' : 'tone-green'}`,
      title: `WhatsApp lets us write freely until ${new Date(w.closes_at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}; after that only an approved template.`,
    }, icon('clock', { size: 13 }),
    closing ? (hours >= 1 ? `Window closes in ${hours} h` : 'Window closes within the hour') : `Window open · ${hours} h left`);
  }

  // -- files: links, lazily -----------------------------------------------------
  const links = new Map();      // "variant|ref" -> { url, mime_type, expires } | { error }
  let queue = new Map();        // "variant|ref" -> [[resolve, reject]]
  let flushTimer = null;

  /** A link to one file, from a batch request made once the asking settles. */
  function link(ref, variant = 'thumb', { fresh = false } = {}) {
    const k = `${variant}|${ref}`;
    const hit = links.get(k);
    if (!fresh && hit && (hit.error || hit.expires > Date.now())) return hit.error ? Promise.reject(new Error(hit.error)) : Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      if (!queue.has(k)) queue.set(k, []);
      queue.get(k).push([resolve, reject]);
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flushLinks, 40);
    });
  }
  async function flushLinks() {
    const batch = queue;
    queue = new Map();
    for (const variant of ['thumb', 'full']) {
      const keys = [...batch.keys()].filter((k) => k.startsWith(`${variant}|`));
      for (let i = 0; i < keys.length; i += 40) {
        const chunk = keys.slice(i, i + 40);
        let r;
        try {
          r = await api({ view: 'chat_files', refs: chunk.map((k) => k.slice(variant.length + 1)).join(','), variant });
        } catch (err) {
          for (const k of chunk) for (const [, reject] of batch.get(k)) reject(err);
          continue;
        }
        const expires = new Date(r.expires_at).getTime() || Date.now() + 5 * 60_000;
        for (const k of chunk) {
          const f = r.files?.[k.slice(variant.length + 1)] ?? { error: 'No copy of this file is kept.' };
          const value = f.error ? { error: f.error } : { ...f, expires };
          links.set(k, value);
          for (const [resolve, reject] of batch.get(k)) (f.error ? reject(new Error(f.error)) : resolve(value));
        }
      }
    }
  }

  const watcher = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { watcher.unobserve(e.target); e.target.loadMedia?.(); }
    }, { root: transcript, rootMargin: '400px 0px' })
    : null;
  const whenVisible = (el, loadIt) => { el.loadMedia = loadIt; if (watcher) watcher.observe(el); else loadIt(); };

  /** Every file in the conversation that can be opened large, in order - for the preview's pager. */
  function previewables() {
    return (data?.messages ?? []).filter((m) => m.file?.ref && ['image', 'pdf', 'document', 'sticker'].includes(m.file.kind))
      .map((m) => ({ ...m.file, id: m.id, caption: m.direction === 'in' ? m.body : null }));
  }
  function openFile(m) {
    const f = m.file;
    // A paper the bot read opens where papers are checked.
    if (f.paper?.reviewable && openPaper && f.kind !== 'image') return openPaper(f.paper.id);
    const items = previewables();
    const index = Math.max(0, items.findIndex((x) => x.id === m.id));
    if (!items.length) return null;
    return openFilePreview({
      title: data.customer.name, items, index,
      link: (ref, { fresh } = {}) => link(ref, 'full', { fresh }),
      onOpenPaper: openPaper,
    });
  }

  /** A photo in a bubble: a box the shape of the photo, filled once it is in view. */
  function thumb(m, { album = false } = {}) {
    const f = m.file;
    const img = h('img', { alt: '', decoding: 'async' });
    // The photo's own shape, at most 260 wide and 280 tall: a portrait photo
    // is narrower rather than cropped, and nothing moves when it arrives.
    const scale = f.width && f.height ? Math.min(260 / f.width, 280 / f.height, 1) : null;
    const box = h('button', {
      class: `media-thumb is-loading${album ? ' in-album' : ''}`, type: 'button',
      style: scale && !album ? { width: `${Math.round(f.width * scale)}px`, height: `${Math.round(f.height * scale)}px`, aspectRatio: 'auto' } : null,
      'aria-label': `Open the photo${f.name ? `, ${f.name}` : ''}${f.size_words ? `, ${f.size_words}` : ''}`,
      title: f.thumb ? `${f.size_words} — a smaller copy is shown; open it for the full photo` : (f.name ?? 'Photo'),
    }, img);
    box.addEventListener('click', () => openFile(m));
    let tried = false;
    const broken = (words) => {
      box.classList.remove('is-loading');
      box.classList.add('is-broken');
      fill(box, icon('imageOff', { size: 20 }), h('span', {}, words));
    };
    const fetchIt = (fresh = false) => link(f.ref, 'thumb', { fresh }).then((l) => { img.src = l.url; }).catch((err) => broken(err.message));
    img.addEventListener('load', () => { box.classList.remove('is-loading'); if (pinned) stickToEnd(); });
    // A link that expired while the page sat open is asked for again, once.
    img.addEventListener('error', () => { if (!tried) { tried = true; fetchIt(true); } else broken('The photo would not load.'); });
    whenVisible(box, () => fetchIt());
    return box;
  }

  /** A player for a voice note or a video, its link fetched when it scrolls into view. */
  function player(m) {
    const f = m.file;
    const el = f.kind === 'video'
      ? h('video', { class: 'media-video', controls: true, preload: 'metadata', playsinline: true })
      : h('audio', { class: 'media-audio', controls: true, preload: 'none' });
    el.setAttribute('aria-label', `${f.voice ? 'Voice note' : f.kind === 'video' ? 'Video' : 'Audio'}${f.duration ? `, ${duration(f.duration)}` : ''}`);
    let tried = false;
    const fetchIt = (fresh = false) => link(f.ref, 'full', { fresh }).then((l) => { el.src = l.url; })
      .catch((err) => el.replaceWith(h('span', { class: 'media-missing' }, icon('alert', { size: 13 }), err.message)));
    el.addEventListener('error', () => { if (!tried && el.src) { tried = true; fetchIt(true); } });
    el.addEventListener('loadedmetadata', () => { if (pinned) stickToEnd(); });
    whenVisible(el, () => fetchIt());
    return el;
  }

  /** A paper or any other file: a chip with its name, type and size, and what became of it. */
  function fileChip(m) {
    const f = m.file;
    const pdf = f.kind === 'pdf';
    const meta = [typeWords(f), f.size_words].filter(Boolean).join(' · ');
    const inner = [
      h('span', { class: `chip-icon${pdf ? ' is-pdf' : ''}`, 'aria-hidden': 'true' }, icon(pdf ? 'file' : 'fileText', { size: 18 })),
      h('span', { class: 'chip-text' },
        h('bdi', { class: 'chip-name', dir: 'ltr', title: f.name ?? '' }, f.name ?? KIND_WORDS[m.kind] ?? 'File'),
        h('span', { class: 'chip-meta' }, meta)),
    ];
    if (!f.ref) return h('span', { class: 'file-chip is-static' }, inner);
    return h('button', {
      class: 'file-chip', type: 'button', onclick: () => openFile(m),
      'aria-label': `Open ${f.name ?? 'the file'} (${meta})`,
    }, inner);
  }

  /** What a paper the bot read became: its label and state, or that a newer copy came. */
  function paperLine(f) {
    const p = f?.paper;
    if (!p || (!p.status_words && !p.note && !p.booking_ref)) return null;
    if (p.mky) {
      return h('div', { class: 'paper-line' }, h('span', { class: 'paper-ref' }, icon('file', { size: 12 }), ' Filed on ',
        h('span', { class: 'mono' }, p.booking_ref), ' as an MKY document'));
    }
    return h('div', { class: 'paper-line' },
      p.label && p.label !== 'Photo' && p.label !== 'File' ? h('span', { class: 'paper-label' }, p.label) : null,
      p.status_words ? h('span', { class: `paper-state tone-text-${p.tone ?? 'gray'}` }, p.status_words) : null,
      p.booking_ref ? h('span', { class: 'paper-ref' }, 'On ', h('span', { class: 'mono' }, p.booking_ref))
        : p.reviewable ? h('span', { class: 'paper-ref' }, 'On no booking') : null,
      p.note ? h('span', { class: 'paper-note' }, icon('refresh', { size: 12 }), p.note) : null);
  }

  /** Why there is nothing to open. */
  const missingLine = (f) => (f?.missing ? h('div', { class: 'media-missing' }, icon(f.stored ? 'alert' : 'minus', { size: 13 }), f.missing) : null);

  /** The body of a file message: thumbnail, player or chip; then the caption. */
  function fileBody(m) {
    const f = m.file;
    const parts = [];
    if (f.kind === 'image' && f.ref) parts.push(thumb(m));
    else if ((f.kind === 'audio' || f.kind === 'video') && f.ref) {
      parts.push(h('div', { class: 'media-label' }, icon(f.kind === 'video' ? 'video' : 'mic', { size: 14 }),
        f.voice ? 'Voice note' : f.kind === 'video' ? 'Video' : 'Audio', f.duration ? ` · ${duration(f.duration)}` : null,
        f.size_words ? h('span', { class: 'muted' }, ` · ${f.size_words}`) : null));
      parts.push(player(m));
    } else if (f.kind === 'sticker') {
      parts.push(f.ref ? thumb(m) : h('div', { class: 'media-sticker' }, f.emoji ? h('span', { class: 'sticker-emoji', 'aria-hidden': 'true' }, f.emoji) : icon('smile', { size: 22 }),
        h('span', {}, 'Sticker')));
    } else if (f.kind === 'audio' || f.kind === 'video') {
      parts.push(h('div', { class: 'media-label' }, icon(f.kind === 'video' ? 'video' : 'mic', { size: 14 }),
        f.voice ? 'Voice note' : f.kind === 'video' ? 'Video' : 'Audio', f.size_words ? ` · ${f.size_words}` : null));
    } else if (f.kind === 'image') {
      parts.push(h('div', { class: 'media-label' }, icon('image', { size: 14 }), f.name ? h('bdi', { dir: 'ltr' }, f.name) : 'Photo'));
    } else {
      parts.push(fileChip(m));
    }
    parts.push(missingLine(f));
    parts.push(paperLine(f));
    if (m.body && m.kind !== 'sticker') parts.push(h('div', { class: 'caption' }, richLines(m.body)));
    return h('div', { class: 'bubble-body' }, parts);
  }

  // -- transcript ---------------------------------------------------------------
  const nodes = new Map();   // key -> element, so a refresh moves nothing that did not change

  function drawTranscript() {
    const list = [];
    if (!data.messages.length) {
      list.push(keep('empty', () => h('p', { class: 'convo-empty' }, data.available ? 'No messages yet.' : 'Earlier messages are not shown.')));
      reconcile(transcript, list);
      return;
    }
    if (data.has_more || older.length) {
      list.push(keep(`older|${loadingOlder}|${data.has_more}`, () => (data.has_more
        ? h('div', { class: 'convo-older' }, h('button', { class: 'btn btn-sm btn-ghost', type: 'button', disabled: loadingOlder, onclick: loadOlder },
          icon('refresh', { size: 13 }), loadingOlder ? 'Loading…' : 'Show earlier messages'))
        : h('p', { class: 'convo-older' }, 'This is the start of the conversation.'))));
    }
    let day = '';
    const ms = data.messages;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      const d = dayLabel(m.at);
      if (d !== day) { day = d; list.push(keep(`day|${d}`, () => h('div', { class: 'day' }, h('span', {}, d)))); }
      // Photos a customer sent together are one album, as their phone showed them.
      const run = [m];
      if (isAlbumable(m)) {
        while (i + 1 < ms.length && isAlbumable(ms[i + 1]) && !ms[i + 1].body && dayLabel(ms[i + 1].at) === d
          && new Date(ms[i + 1].at) - new Date(run[run.length - 1].at) <= ALBUM_MS) run.push(ms[++i]);
      }
      if (run.length > 1) list.push(keep(`album|${run.map((x) => x.id).join('-')}|${run.map(fileSig).join(',')}`, () => album(run)));
      else list.push(keep(`msg|${m.id}|${m.status}|${m.retried}|${m.retryable}|${fileSig(m)}|${m.status === 'failed' ? data.composer.mode : ''}`, () => message(m)));
    }
    reconcile(transcript, list);
    // Old keys are forgotten, so the map does not grow for ever.
    const live = new Set(list);
    for (const [k, el] of nodes) if (!live.has(el)) nodes.delete(k);
  }
  const fileSig = (m) => (m.file ? `${m.file.ref}:${m.file.paper?.status_words ?? ''}:${m.file.paper?.note ?? ''}:${m.file.missing ?? ''}` : '');
  const isAlbumable = (m) => m.direction === 'in' && m.kind === 'image' && m.file?.kind === 'image' && m.file.ref;
  function keep(key, make) {
    if (!nodes.has(key)) nodes.set(key, make());
    return nodes.get(key);
  }
  /** Puts exactly these nodes in this order, moving as few as possible - a playing voice note keeps playing. */
  function reconcile(parent, list) {
    let i = 0;
    for (const n of list) {
      const at = parent.childNodes[i];
      if (at !== n) parent.insertBefore(n, at ?? null);
      i++;
    }
    while (parent.childNodes.length > list.length) parent.lastChild.remove();
  }

  async function loadOlder() {
    if (loadingOlder || !data?.messages.length) return;
    loadingOlder = true;
    drawTranscript();
    const firstId = data.messages[0].id;
    const before = transcript.scrollHeight - transcript.scrollTop;
    try {
      const r = await api({ view: 'chat', channel, chat_id: chatId, before: firstId, limit: 60 });
      const have = new Set(data.messages.map((m) => m.id));
      older = [...r.messages.filter((m) => !have.has(m.id)), ...older];
      data.messages = [...r.messages.filter((m) => !have.has(m.id)), ...data.messages];
      data.has_more = r.has_more;
    } catch (err) {
      toastError(err);
    } finally {
      loadingOlder = false;
      signature = null;   // drawn afresh, keeping the reader's place
      drawTranscript();
      ownScrollUntil = performance.now() + 250;
      transcript.scrollTop = transcript.scrollHeight - before;
    }
  }

  function album(run) {
    const shown = run.slice(0, 4);
    const grid = h('div', { class: `media-grid n-${Math.min(run.length, 4)}` }, shown.map((m, i) => {
      const t = thumb(m, { album: true });
      if (i === 3 && run.length > 4) add(t, h('span', { class: 'grid-more' }, `+${run.length - 4}`));
      return t;
    }));
    const lastAt = run[run.length - 1].at;
    return h('div', { class: 'msg msg-in msg-client' },
      h('div', { class: 'bubble bubble-media' },
        h('div', { class: 'bubble-body' }, grid, run[0].body ? h('div', { class: 'caption' }, richLines(run[0].body)) : null),
        h('div', { class: 'bubble-meta' }, h('span', { class: 'album-count' }, `${run.length} photos`),
          h('time', { datetime: lastAt, title: new Date(lastAt).toLocaleString('en-GB') }, clock(lastAt)))));
  }

  function message(m) {
    const side = m.direction === 'in' ? 'in' : 'out';
    // A tapped button is an action, not words: a small line, not a bubble.
    if (m.kind === 'tap') {
      return h('div', { class: 'msg msg-in msg-tap' },
        h('span', { class: 'tap' },
          m.tap_title ? ['Tapped ', h('bdi', {}, `“${m.tap_title}”`)] : m.body,
          h('time', { class: 'tap-time', datetime: m.at }, clock(m.at))));
    }
    const who = m.author === 'client' ? null
      : m.author === 'bot' ? 'Bot'
        : m.author === 'staff' ? (m.staff_name || 'Staff') : 'Notification';
    let body;
    let long = false;
    if (m.file && FILE_KINDS.includes(m.kind)) {
      body = fileBody(m);
    } else if (m.location) {
      const l = m.location;
      body = h('div', { class: 'bubble-body' },
        h('a', { class: 'place-chip', href: l.map_url, target: '_blank', rel: 'noopener noreferrer' },
          h('span', { class: 'chip-icon is-place', 'aria-hidden': 'true' }, icon('mapPin', { size: 18 })),
          h('span', { class: 'chip-text' },
            h('span', { class: 'chip-name', dir: 'auto' }, l.name || 'Location'),
            h('span', { class: 'chip-meta', dir: 'auto' }, l.address || `${l.latitude.toFixed(5)}, ${l.longitude.toFixed(5)}`),
            h('span', { class: 'place-open' }, 'Open in Google Maps', icon('external', { size: 12 })))));
    } else if (m.contacts) {
      body = h('div', { class: 'bubble-body' }, m.contacts.map((c) => h('div', { class: 'place-chip is-static' },
        h('span', { class: 'chip-icon is-contact', 'aria-hidden': 'true' }, icon('user', { size: 18 })),
        h('span', { class: 'chip-text' },
          h('span', { class: 'chip-name', dir: 'auto' }, c.name || 'Contact card'),
          c.phones.map((p) => h('a', { class: 'chip-meta', href: `tel:${p.replace(/[^\d+]/g, '')}` }, h('bdi', { dir: 'ltr' }, p)))))));
    } else {
      const text = m.body || (m.kind && m.kind !== 'text' ? `[${KIND_WORDS[m.kind] ?? m.kind}]` : '');
      body = h('div', { class: 'bubble-body' }, richLines(text));
      long = text.length > 700 || text.split('\n').length > 14;
    }
    let toggle = null;
    if (long) {
      body.classList.add('clamped');
      toggle = h('button', { class: 'link-btn', type: 'button', 'aria-expanded': 'false' }, 'Show all');
      toggle.addEventListener('click', () => {
        const clamped = body.classList.toggle('clamped');
        toggle.textContent = clamped ? 'Show all' : 'Show less';
        toggle.setAttribute('aria-expanded', String(!clamped));
      });
    }
    const [statusWord, statusIcon] = side === 'out' ? (STATUS_MARK[m.status] ?? [m.status, null]) : [null, null];
    const meta = h('div', { class: 'bubble-meta' },
      who ? h('span', { class: `bubble-who who-${m.author}` }, who) : null,
      h('time', { datetime: m.at, title: new Date(m.at).toLocaleString('en-GB') }, clock(m.at)),
      statusWord && m.status !== 'failed'
        ? h('span', { class: `tick tick-${m.status}` }, statusIcon === 'check2' ? '✓✓' : statusIcon === 'check' ? '✓' : icon('clock', { size: 12 }), ' ', statusWord)
        : null);

    let failure = null;
    if (m.status === 'failed') {
      failure = h('div', { class: 'bubble-fail', role: 'note' },
        icon('alert', { size: 14 }),
        h('span', {}, h('strong', {}, 'Not delivered. '), m.error_words || 'It did not go through.'),
        m.retried ? h('span', { class: 'muted' }, 'Sent again') : m.retryable ? retryButton(m) : null);
    }
    const media = m.file && ['image', 'sticker'].includes(m.file.kind) && m.file.ref && !m.body;
    return h('div', { class: `msg msg-${side} msg-${m.author}` },
      h('div', { class: `bubble${media ? ' bubble-media' : ''}` }, body, toggle, meta), failure);
  }

  function retryButton(m) {
    const key = newKey();
    // Outside the window, or after STOP, a retry would only be refused again:
    // it waits, saying why, until they write.
    const blockedNow = data.composer.mode !== 'text';
    const b = h('button', {
      class: 'btn btn-sm', type: 'button', disabled: !session.can('problems') || blockedNow,
      title: blockedNow ? 'It can be sent again once they write to us.' : null,
    }, icon('refresh', { size: 13 }), 'Retry');
    if (blockedNow) return h('span', { class: 'retry-wait' }, b, h('span', { class: 'muted' }, 'Once they write'));
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await post({ action: 'retry_message', message_id: m.id, action_key: key });
        toast(m.file ? 'The file was sent again.' : 'Sent again.');
        await load({ quiet: true });
      } catch (err) {
        toastError(err);
        b.disabled = false;
      }
    });
    return b;
  }

  // -- composer -------------------------------------------------------------------
  // Built once and kept: a redraw (the window opening while somebody types)
  // changes the banner and what is enabled, never the box itself - so the
  // words, the cursor and the attached files stay where they were.
  const slot = h('div', { class: 'composer-slot' });
  const tray = h('div', { class: 'tray', hidden: true, 'aria-label': 'Files to send' });
  const errorLine = h('p', { class: 'composer-error', role: 'alert', hidden: true });
  const ta = h('textarea', {
    class: 'composer-input', rows: '1', dir: 'auto', 'aria-label': 'Message to the customer',
    'aria-keyshortcuts': 'Control+Enter', title: 'Ctrl+Enter sends. Enter starts a new line.',
  });
  ta.value = draft.get(draftKey);
  const picker = h('input', { type: 'file', multiple: true, hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
  const attachBtn = h('button', { class: 'icon-btn composer-tool', type: 'button', 'aria-label': 'Attach files', title: 'Attach files (PDF, photos, Word, Excel)' }, icon('paperclip', { size: 18 }));
  const repliesSlot = h('span', { class: 'composer-replies' });
  const sendBtn = h('button', { class: 'btn btn-primary composer-send', type: 'button', title: 'Send (Ctrl+Enter)' }, icon('send', { size: 15 }), h('span', { class: 'send-label' }, 'Send'));
  const box = h('div', { class: 'composer-box' }, attachBtn, repliesSlot, ta, sendBtn, picker);
  add(composer, slot, tray, box, errorLine);

  let files = [];       // { id, file, name, size, type, kind, error, status, progress, path, mime, key, preview }
  let batchKey = null;  // one send of these files; repeated after a dropped connection
  let busy = false;
  let fileOnRef = '';

  const grow = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight + 2, 152)}px`;
  };
  ta.addEventListener('input', () => {
    draft.set(draftKey, ta.value);
    pendingKey = null;          // different words, different message
    errorLine.hidden = true;
    grow();
    captionCount();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });
  ta.addEventListener('paste', (e) => {
    const pasted = [...(e.clipboardData?.files ?? [])];
    if (pasted.length && canAttach()) { e.preventDefault(); addFiles(pasted); }
  });
  attachBtn.addEventListener('click', () => { if (canAttach()) picker.click(); });
  picker.addEventListener('change', () => { addFiles([...picker.files]); picker.value = ''; });
  sendBtn.addEventListener('click', send);

  // Files dragged anywhere over the conversation are attached on drop.
  let dragDepth = 0;
  const dragging = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  container.addEventListener('dragenter', (e) => { if (!dragging(e) || !canAttach()) return; e.preventDefault(); dragDepth++; drop.hidden = false; });
  container.addEventListener('dragover', (e) => { if (!dragging(e) || !canAttach()) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  container.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) drop.hidden = true; });
  container.addEventListener('drop', (e) => {
    if (!dragging(e)) return;
    e.preventDefault();
    dragDepth = 0;
    drop.hidden = true;
    if (canAttach()) addFiles([...e.dataTransfer.files]);
  });

  const canAttach = () => Boolean(data?.attach) && data.composer.mode === 'text' && session.can('chat') && !busy;

  function drawComposer() {
    const c = data.composer;
    const lang = data.customer.language;
    fill(slot);
    errorLine.hidden = true;
    if (!session.can('chat')) {
      add(slot, h('div', { class: 'banner banner-gray banner-slim' }, icon('lock', { size: 15 }),
        h('p', {}, 'Your role is read only: you can read the conversation and open its files, but not write in it.')));
      box.hidden = true;
      tray.hidden = true;
      return;
    }
    box.hidden = false;
    const text = c.mode === 'text';
    // Closed, STOP or blocked: the banner, with what can still be done. On
    // Telegram there is nothing to say (the channel chip says Telegram); a
    // WhatsApp window that cannot be read gets one quiet line.
    if (!text) add(slot, blocked(c));
    else if (c.note && data.window?.applies && data.window?.known === false) add(slot, h('p', { class: 'composer-note' }, icon('clock', { size: 13 }), c.note));
    ta.disabled = !text;
    ta.placeholder = !text ? 'Nothing can be sent now'
      : lang === 'ar' ? 'Write in Arabic…' : lang === 'en' ? 'Write in English…' : 'Write a reply (no language chosen yet)…';
    attachBtn.disabled = !text || !data.attach;
    attachBtn.hidden = !data.attach && text;
    picker.accept = data.attach?.accept ?? '';
    box.classList.toggle('is-disabled', !text);
    fill(repliesSlot, savedReplies(lang, !text));
    drawTray();
    setSendState();
    grow();
  }

  function setSendState() {
    const text = data?.composer.mode === 'text';
    const n = files.filter((f) => f.status !== 'sent').length;
    sendBtn.disabled = !text || busy;
    sendBtn.lastChild.textContent = busy ? 'Sending…' : n ? (n === 1 ? 'Send file' : `Send ${n} files`) : 'Send';
    if (busy) sendBtn.setAttribute('aria-busy', 'true'); else sendBtn.removeAttribute('aria-busy');
  }

  function captionCount() {
    const max = data?.attach?.caption_max ?? 1024;
    const over = files.length && ta.value.trim().length > max;
    tray.querySelector('.tray-caption')?.replaceChildren(over ? `The caption is ${ta.value.trim().length} characters; at most ${max} go with a file.` : '');
  }

  /** What a file may be on this channel, said before anything is uploaded. The server checks again. */
  function check(file) {
    const a = data.attach;
    const name = file.name || 'This file';
    const ext = (/\.([a-z0-9]{2,5})$/i.exec(file.name ?? '')?.[1] ?? '').toLowerCase();
    const allowed = a.accept.split(',').map((x) => x.replace('.', ''));
    if (!allowed.includes(ext)) return `A .${ext || '?'} file cannot be sent from the desk. Send a PDF, a JPG or PNG photo, or a Word or Excel file.`;
    if (!file.size) return `${name} is empty.`;
    const photo = ['jpg', 'jpeg', 'png'].includes(ext);
    if (photo && file.size > a.image_max && !(a.big_photo_as_file && file.size <= a.document_max)) {
      return `Photos can be at most ${sizeWords(a.image_max)} on ${data.customer.channel === 'whatsapp' ? 'WhatsApp' : 'this channel'}; this one is ${sizeWords(file.size)}.`;
    }
    if (file.size > a.document_max) return `${name} is ${sizeWords(file.size)}; the most that can be sent is ${sizeWords(a.document_max)}.`;
    return null;
  }

  function addFiles(list) {
    if (!list.length || !canAttach()) return;
    const room = (data.attach.max_files ?? 10) - files.length;
    if (room <= 0) { toast(`At most ${data.attach.max_files} files go at once.`, 'warn'); return; }
    if (list.length > room) toast(`Only ${room} more ${room === 1 ? 'file' : 'files'} can go with this message; the rest were left out.`, 'warn');
    for (const file of list.slice(0, room)) {
      const ext = (/\.([a-z0-9]{2,5})$/i.exec(file.name ?? '')?.[1] ?? '').toLowerCase();
      const isPhoto = ['jpg', 'jpeg', 'png'].includes(ext);
      files.push({
        id: newKey(), key: newKey(), file, name: file.name || `pasted-${Date.now()}.png`, size: file.size, type: file.type, ext,
        kind: isPhoto ? 'image' : 'document', error: check(file), status: 'ready', progress: 0, path: null, mime: null,
        preview: isPhoto && file.size < 15 * 1048576 ? URL.createObjectURL(file) : null,
      });
    }
    batchKey = null;      // a different set of files is a different send
    errorLine.hidden = true;
    drawTray();
    setSendState();
    ta.focus();
  }

  function removeFile(item) {
    if (busy) return;
    if (item.preview) URL.revokeObjectURL(item.preview);
    files = files.filter((f) => f !== item);
    batchKey = null;
    drawTray();
    setSendState();
  }

  function drawTray() {
    const live = files.filter((f) => f.status !== 'sent');
    tray.hidden = !live.length;
    if (!live.length) { fill(tray); return; }
    const options = fileOn ? fileOn(data) : [];
    if (fileOnRef && !options.some((o) => o.booking_ref === fileOnRef)) fileOnRef = '';
    const fileOnControl = options.length ? (() => {
      const box2 = h('input', { type: 'checkbox', checked: Boolean(fileOnRef), disabled: busy });
      const select = options.length > 1 ? h('select', { class: 'input input-small', 'aria-label': 'Booking to file the copy on', disabled: busy },
        options.map((o) => h('option', { value: o.booking_ref, selected: o.booking_ref === (fileOnRef || options[0].booking_ref) }, o.label ?? o.booking_ref))) : null;
      box2.addEventListener('change', () => { fileOnRef = box2.checked ? (select?.value ?? options[0].booking_ref) : ''; });
      select?.addEventListener('change', () => { if (box2.checked) fileOnRef = select.value; });
      return h('label', { class: 'check tray-file-on' }, box2,
        h('span', {}, 'Also file a copy on ', select ?? h('span', { class: 'mono' }, options[0].booking_ref), ' as an MKY document'));
    })() : null;
    fill(tray,
      h('ul', { class: 'tray-list', 'data-scroll-x': '' }, live.map((item) => h('li', { class: `tray-item${item.error ? ' has-error' : ''} is-${item.status}` },
        item.preview ? h('img', { class: 'tray-thumb', src: item.preview, alt: '' })
          : h('span', { class: `tray-thumb chip-icon${item.ext === 'pdf' ? ' is-pdf' : ''}`, 'aria-hidden': 'true' }, icon(item.ext === 'pdf' ? 'file' : 'fileText', { size: 18 })),
        h('span', { class: 'tray-text' },
          h('bdi', { class: 'tray-name', dir: 'ltr', title: item.name }, item.name),
          h('span', { class: `tray-meta${item.error ? ' tone-text-red' : ''}` },
            item.error ?? (item.status === 'uploading' ? `Uploading ${Math.round(item.progress * 100)}%`
              : item.status === 'sending' ? 'Sending…' : item.status === 'failed' ? 'Not sent'
                : busy && item.path ? `Uploaded · ${sizeWords(item.size)}` : `${item.ext.toUpperCase()} · ${sizeWords(item.size)}`)),
          item.status === 'uploading' ? h('span', { class: 'tray-progress', 'aria-hidden': 'true' }, h('span', { style: { width: `${Math.round(item.progress * 100)}%` } })) : null),
        h('button', {
          class: 'icon-btn tray-remove', type: 'button', disabled: busy, 'aria-label': `Remove ${item.name}`, title: 'Remove', onclick: () => removeFile(item),
        }, icon('x', { size: 14 }))))),
      h('div', { class: 'tray-foot' },
        fileOnControl,
        h('span', { class: 'tray-hint' }, live.length > 1 ? 'The words you type go with the first file.' : 'The words you type go with the file.'),
        h('span', { class: 'tray-caption tone-text-red', role: 'status' })));
    captionCount();
  }

  async function send() {
    if (busy || data?.composer.mode !== 'text') return;
    const live = files.filter((f) => f.status !== 'sent');
    if (live.length) return sendFiles(live);
    const text = ta.value.trim();
    if (!text) return;
    pendingKey = pendingKey ?? newKey();
    busy = true;
    setSendState();
    errorLine.hidden = true;
    try {
      const r = await post({ action: 'send_message', ...target, text, action_key: pendingKey });
      pendingKey = null;
      ta.value = '';
      draft.set(draftKey, '');
      grow();
      toast(r.status === 'queued' ? 'Queued — it will be tried again automatically.' : r.duplicate ? 'Already sent.' : 'Sent.');
      onSent?.();
      await load({ quiet: true });
    } catch (err) {
      // A definite answer from the server means this attempt is over; a
      // dropped connection may not be - the retry keeps the same key.
      if (!err.offline) pendingKey = null;
      showError(err);
    } finally {
      busy = false;
      setSendState();
    }
  }

  function showError(err) {
    errorLine.textContent = err.message;
    errorLine.hidden = false;
    if (err.data?.composer) { data.composer = err.data.composer; composerMode = null; drawComposer(); errorLine.textContent = err.message; errorLine.hidden = false; }
  }

  async function sendFiles(live) {
    const bad = live.find((f) => f.error && f.status !== 'failed');
    if (bad) {
      errorLine.textContent = 'Remove the files that cannot be sent, then send again.';
      errorLine.hidden = false;
      return;
    }
    const caption = ta.value.trim();
    if (caption.length > (data.attach?.caption_max ?? 1024)) {
      errorLine.textContent = `A caption can be at most ${data.attach?.caption_max ?? 1024} characters. Send the words as a message of their own first.`;
      errorLine.hidden = false;
      return;
    }
    busy = true;
    batchKey = batchKey ?? newKey();
    errorLine.hidden = true;
    setSendState();
    try {
      // 1. Each file straight into storage, with its progress.
      for (const item of live) {
        if (item.path) continue;
        item.status = 'uploading';
        item.error = null;
        item.progress = 0;
        drawTray();
        const up = await post({ action: 'chat_upload', ...target, file_name: item.name, mime_type: item.type || '', size: item.size, action_key: item.key });
        let last = 0;
        await uploadFile(up.upload_url, item.file, {
          contentType: up.mime_type,
          onProgress: (p) => { item.progress = p; if (p - last > 0.04 || p === 1) { last = p; drawTray(); } },
        });
        item.path = up.path;
        item.mime = up.mime_type;
        item.status = 'ready';
      }
      // 2. Sent, in order, with the words on the first.
      for (const item of live) item.status = 'sending';
      drawTray();
      const r = await post({
        action: 'send_files', ...target, caption,
        files: live.map((item) => ({ path: item.path, file_name: item.name, mime_type: item.mime ?? item.type })),
        file_on_booking: fileOnRef || null, action_key: batchKey,
      });
      for (const res of r.results ?? []) {
        const item = live[res.index];
        if (!item) continue;
        item.status = res.ok ? 'sent' : 'failed';
        item.error = res.ok ? null : (res.words ?? 'It did not go through.');
      }
      const sent = (r.results ?? []).filter((x) => x.ok).length;
      // The words went with the first file; they are not sent twice.
      if (r.results?.[0]?.ok) { ta.value = ''; draft.set(draftKey, ''); grow(); }
      batchKey = null;
      for (const item of files) if (item.status === 'sent' && item.preview) URL.revokeObjectURL(item.preview);
      files = files.filter((f) => f.status !== 'sent');
      if (r.ok) {
        toast(`${sent === 1 ? 'The file was' : `${sent} files were`} sent${r.filed_on ? `, and filed on ${r.filed_on}` : ''}.`);
      } else {
        errorLine.textContent = sent ? `${sent} sent; ${files.length} did not go. See why beside each file.` : 'The files did not go. See why beside each file.';
        errorLine.hidden = false;
      }
      onSent?.();
      await load({ quiet: true });
    } catch (err) {
      for (const item of live) if (item.status !== 'sent') { item.status = 'failed'; if (!item.path) item.error = err.offline ? 'Not uploaded — you are offline' : null; }
      // A definite refusal ends this send; a dropped connection may not have - the same key goes again.
      if (!err.offline) batchKey = null;
      showError(err);
    } finally {
      busy = false;
      drawTray();
      setSendState();
    }
  }

  /** Why nothing can be typed, as a banner in the tone it deserves - and the one thing that can still be sent. */
  function blocked(c) {
    const cust = data.customer ?? {};
    const stopped = Boolean(cust.opted_out_at || cust.is_blocked);
    const tone = c.mode === 'template_only' ? 'amber' : stopped ? 'red' : 'gray';
    const title = c.mode === 'template_only' ? 'The 24-hour window has closed. '
      : cust.opted_out_at ? 'Opted out. ' : cust.is_blocked ? 'Blocked. ' : '';
    const waiting = files.filter((f) => f.status !== 'sent').length;
    const box2 = h('div', { class: `banner banner-${tone}`, role: 'status' },
      icon(c.mode === 'template_only' ? 'clock' : stopped ? 'lock' : 'alert', { size: 15 }),
      h('p', {}, title ? h('strong', {}, title) : null, c.reason,
        waiting ? ` The ${waiting === 1 ? 'file' : `${waiting} files`} attached will wait here until then.` : null));
    if (c.mode === 'template_only') {
      const key = newKey();
      const label = 'Send the “please reply” template';
      const b = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, icon('template', { size: 14 }), h('span', {}, label));
      b.addEventListener('click', async () => {
        b.disabled = true;
        b.lastChild.textContent = 'Sending…';
        try {
          await post({ action: 'send_reopen_template', ...target, action_key: key });
          toast('Template sent. When they answer you can write freely.');
          await load({ quiet: true });
        } catch (err) {
          toastError(err);
          b.disabled = false;
          b.lastChild.textContent = label;
        }
      });
      add(box2, b);
    }
    return box2;
  }

  /** Saved replies, inserted in the customer's language (both when they have not chosen). */
  function savedReplies(lang, disabled) {
    const list = data.saved_replies ?? [];
    if (!list.length) return null;
    const menu = h('details', { class: 'menu' },
      h('summary', {
        class: `icon-btn composer-tool${disabled ? ' is-disabled' : ''}`, 'aria-disabled': disabled ? 'true' : null,
        'aria-label': 'Saved replies', title: 'Saved replies',
      }, icon('reply', { size: 18 })),
      h('div', { class: 'menu-list menu-up', role: 'menu' },
        h('p', { class: 'menu-head' }, 'Saved replies'),
        list.map((r) => {
          const text = lang === 'ar' ? (r.ar || r.en) : lang === 'en' ? (r.en || r.ar) : [r.ar, r.en].filter(Boolean).join('\n\n');
          const item = h('button', { class: 'menu-item', type: 'button', role: 'menuitem' },
            h('span', { class: 'menu-item-title' }, r.title),
            h('span', { class: 'menu-item-sub', dir: 'auto' }, text.slice(0, 80)));
          item.addEventListener('click', () => {
            ta.value = ta.value.trim() ? `${ta.value.trim()}\n${text}` : text;
            ta.dispatchEvent(new Event('input'));
            menu.open = false;
            ta.focus();
          });
          return item;
        })));
    menu.addEventListener('toggle', () => { if (disabled) menu.open = false; });
    return menu;
  }

  load();
  return {
    refresh: () => load({ quiet: true }),
    dispose() {
      watcher?.disconnect();
      for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
    },
    get customer() { return data?.customer ?? null; },
    get bookings() { return data?.bookings ?? []; },
  };
}
