/**
 * A conversation with one customer, the way they saw it, and a box to answer.
 *
 * Shaped like the chat apps everybody already knows: the customer on the left,
 * us on the right, and every message of ours says who sent it - the bot, a
 * named person, or an automatic notification. Each message is shown with
 * dir="auto", so Arabic runs right to left and English left to right, line by
 * line, whatever the rest of the page is doing.
 *
 * The composer knows the channel's rules. On WhatsApp it says how long the
 * 24-hour window has left, and when it has closed it says so and offers the
 * one thing that can still be sent. It never pretends it can send something
 * the server will refuse.
 */

import {
  h, clear, icon, api, post, newKey, toast, chip, channelBadge, clock, dayLabel, draft, session, safeGet, safeSet, errorState, skeleton,
} from './ui.js';

const STATUS_MARK = {
  queued: ['Queued', 'clock'],
  sent: ['Sent', 'check'],
  delivered: ['Delivered', 'check2'],
  read: ['Read', 'check2'],
  received: [null, null],
  failed: ['Not delivered', 'alert'],
};
const KIND_WORDS = { document: 'File', image: 'Photo', template: 'Template', audio: 'Voice note', video: 'Video', location: 'Location', sticker: 'Sticker' };
const LANG = { ar: 'Arabic', en: 'English' };

/** Remembers, per browser, the newest customer message each chat has shown - for "unread". */
export const seen = {
  key: (channel, chatId) => `mky-desk-seen:${channel}|${chatId}`,
  get: (channel, chatId) => safeGet(seen.key(channel, chatId)),
  mark: (channel, chatId, at) => { if (at) safeSet(seen.key(channel, chatId), at); },
};

/**
 * @param {HTMLElement} container
 * @param {{channel: string, chatId: string|null, target: object, draftKey: string, onSent?: Function}} opts
 *   target - what a send is about: { booking_ref } | { ticket_ref } | { channel, chat_id }
 */
export function mountConversation(container, { channel, chatId, target, draftKey, onSent = null, onLoad = null }) {
  let data = null;
  let signature = '';
  let composerMode = '';
  let pendingKey = null;

  const head = h('div', { class: 'convo-head' });
  const notice = h('p', { class: 'convo-notice', hidden: true });
  const transcript = h('div', { class: 'transcript', role: 'log', 'aria-label': 'Conversation', tabindex: '0' });
  const pill = h('button', { class: 'new-pill', type: 'button', hidden: true, onclick: () => toEnd() }, 'New messages', icon('down', { size: 14 }));
  const composer = h('div', { class: 'composer' });
  container.append(head, notice, h('div', { class: 'transcript-wrap' }, transcript, pill), composer);

  if (!chatId) {
    head.append(h('h2', { class: 'convo-title' }, 'Conversation'));
    transcript.append(h('p', { class: 'convo-empty' }, 'This customer has no chat linked, so there is no conversation to show or answer.'));
    return { refresh() {}, dispose() {} };
  }
  transcript.append(skeleton(4));

  async function load({ quiet = false } = {}) {
    try {
      data = await api({ view: 'chat', channel, chat_id: chatId });
    } catch (err) {
      if (!quiet) clear(transcript).append(errorState(err.message || 'We could not load the conversation.', () => load()));
      return;
    }
    drawHead();
    onLoad?.(data);
    notice.hidden = !data.notice;
    notice.textContent = data.notice ?? '';
    const sig = data.messages.map((m) => `${m.id}:${m.status}:${m.retried}`).join(',');
    if (sig !== signature) {
      const atEnd = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 60;
      const first = !signature;
      signature = sig;
      drawTranscript();
      if (first || atEnd) toEnd(); else pill.hidden = false;
    }
    const lastIn = [...data.messages].reverse().find((m) => m.direction === 'in');
    seen.mark(channel, chatId, lastIn?.at);
    const mode = `${data.composer.mode}|${data.composer.reason ?? ''}|${data.window.closes_at ?? ''}`;
    if (mode !== composerMode) { composerMode = mode; drawComposer(); }
  }

  function toEnd() {
    transcript.scrollTop = transcript.scrollHeight;
    pill.hidden = true;
  }
  transcript.addEventListener('scroll', () => {
    if (transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 60) pill.hidden = true;
  });

  // -- header ---------------------------------------------------------------
  function drawHead() {
    const c = data.customer;
    clear(head).append(
      h('div', { class: 'convo-who' },
        h('h2', { class: 'convo-title' }, h('bdi', {}, c.name)),
        h('div', { class: 'convo-chips' },
          channelBadge(c.channel),
          // Not chosen means the bot writes to them in both languages.
          c.language ? chip(LANG[c.language], 'gray') : chip('Language not chosen yet', 'gray'),
          c.opted_out_at ? chip('Wrote STOP', 'red') : null,
          c.is_blocked ? chip('Blocked', 'red') : null)),
      h('div', { class: 'convo-contact' },
        c.phone ? h('a', { href: `tel:${c.phone.replace(/[^\d+]/g, '')}`, class: 'convo-phone' }, icon('phone', { size: 14 }), h('bdi', {}, c.phone)) : null,
        c.profile_name && c.profile_name !== c.name
          ? h('span', { class: 'convo-profile' }, `${c.channel === 'whatsapp' ? 'WhatsApp' : 'Profile'} name: `, h('bdi', {}, c.profile_name)) : null,
        c.bot_state_words ? h('span', { class: 'convo-state' }, `With the bot: ${c.bot_state_words}`) : null));
  }

  // -- transcript -----------------------------------------------------------
  function drawTranscript() {
    clear(transcript);
    if (!data.messages.length) {
      transcript.append(h('p', { class: 'convo-empty' }, data.available
        ? 'No messages yet.'
        : 'Earlier messages are not shown here.'));
      return;
    }
    if (data.has_more) transcript.append(h('p', { class: 'convo-older' }, 'Older messages are not shown.'));
    let day = '';
    for (const m of data.messages) {
      const d = dayLabel(m.at);
      if (d !== day) { day = d; transcript.append(h('div', { class: 'day' }, h('span', {}, d))); }
      transcript.append(message(m));
    }
  }

  function message(m) {
    const side = m.direction === 'in' ? 'in' : 'out';
    // A tapped button is an action, not words: a small line, not a bubble.
    if (m.kind === 'tap') {
      return h('div', { class: 'msg msg-in msg-tap' },
        h('span', { class: 'tap' }, m.body, ' · ', h('time', { datetime: m.at }, clock(m.at))));
    }
    const who = m.author === 'client' ? null
      : m.author === 'bot' ? 'Bot'
        : m.author === 'staff' ? (m.staff_name || 'Staff') : 'Notification';
    const text = m.body || (m.kind && m.kind !== 'text' ? `[${KIND_WORDS[m.kind] ?? m.kind}]` : '');
    const body = h('div', { class: 'bubble-body', dir: 'auto' }, text);
    const long = text.length > 700 || text.split('\n').length > 14;
    let toggle = null;
    if (long) {
      body.classList.add('clamped');
      toggle = h('button', { class: 'link-btn', type: 'button' }, 'Show all');
      toggle.addEventListener('click', () => {
        const clamped = body.classList.toggle('clamped');
        toggle.textContent = clamped ? 'Show all' : 'Show less';
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
    return h('div', { class: `msg msg-${side} msg-${m.author}` },
      h('div', { class: 'bubble' }, body, toggle, meta), failure);
  }

  function retryButton(m) {
    const key = newKey();
    const b = h('button', { class: 'btn btn-small', type: 'button', disabled: !session.can('problems') }, icon('refresh', { size: 13 }), 'Retry');
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await post({ action: 'retry_message', message_id: m.id, action_key: key });
        toast('Sent again.');
        await load();
      } catch (err) {
        toast(err.message, 'bad');
        b.disabled = false;
      }
    });
    return b;
  }

  // -- composer -------------------------------------------------------------
  function drawComposer() {
    const c = data.composer;
    const lang = data.customer.language;
    const typed = composer.querySelector('textarea')?.value ?? draft.get(draftKey);
    clear(composer);

    if (!session.can('chat')) {
      composer.append(h('p', { class: 'composer-note' }, 'Your role is read only: you can read the conversation, but not write in it.'));
      return;
    }

    const status = composerStatus();
    const ta = h('textarea', {
      class: 'composer-input', rows: '3', dir: 'auto', 'aria-label': 'Message to the customer',
      placeholder: lang === 'ar' ? 'Write in Arabic…' : lang === 'en' ? 'Write in English…' : 'Write a reply (they have not chosen a language)…',
      disabled: c.mode !== 'text',
    });
    ta.value = typed;
    const errorLine = h('p', { class: 'composer-error', role: 'alert', hidden: true });
    const sendBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: c.mode !== 'text' }, icon('send', { size: 15 }), 'Send');

    ta.addEventListener('input', () => {
      draft.set(draftKey, ta.value);
      pendingKey = null;          // different words, different message
      errorLine.hidden = true;
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    });

    async function send() {
      const text = ta.value.trim();
      if (!text || sendBtn.disabled) return;
      pendingKey = pendingKey ?? newKey();
      sendBtn.disabled = true;
      sendBtn.setAttribute('aria-busy', 'true');
      sendBtn.lastChild.textContent = 'Sending…';
      errorLine.hidden = true;
      try {
        const r = await post({ action: 'send_message', ...target, text, action_key: pendingKey });
        pendingKey = null;
        ta.value = '';
        draft.set(draftKey, '');
        toast(r.status === 'queued' ? 'Queued — it will be tried again automatically.' : r.duplicate ? 'Already sent.' : 'Sent.');
        onSent?.();
        await load({ quiet: true });
      } catch (err) {
        // A definite answer from the server means this attempt is over; a
        // dropped connection may not be - the retry keeps the same key.
        if (!err.offline) pendingKey = null;
        errorLine.textContent = err.message;
        errorLine.hidden = false;
        if (err.data?.composer) { data.composer = err.data.composer; composerMode = ''; drawComposer(); }
      } finally {
        sendBtn.disabled = data.composer.mode !== 'text';
        sendBtn.removeAttribute('aria-busy');
        if (sendBtn.isConnected) sendBtn.lastChild.textContent = 'Send';
      }
    }
    sendBtn.addEventListener('click', send);

    composer.append(
      status,
      c.mode !== 'text' ? blocked(c) : null,
      ta,
      h('div', { class: 'composer-row' },
        savedReplies(ta, lang, c.mode !== 'text'),
        h('span', { class: 'composer-hint' }, c.mode === 'text' ? 'Ctrl+Enter to send' : ''),
        sendBtn),
      errorLine);
  }

  function composerStatus() {
    const w = data.window;
    if (data.composer.mode !== 'text') return null;
    if (w.applies && w.closes_at) {
      const hours = Math.max(0, Math.floor((new Date(w.closes_at).getTime() - Date.now()) / 3600_000));
      return h('p', { class: 'composer-status status-open' }, icon('clock', { size: 13 }),
        hours >= 1 ? `WhatsApp window open for ${hours} h more` : 'WhatsApp window closes within the hour');
    }
    return data.composer.note ? h('p', { class: 'composer-status' }, data.composer.note) : null;
  }

  function blocked(c) {
    const box = h('div', { class: `callout ${c.mode === 'template_only' ? 'callout-amber' : 'callout-gray'}` },
      h('p', {}, c.reason));
    if (c.mode === 'template_only') {
      const key = newKey();
      const b = h('button', { class: 'btn btn-primary', type: 'button' }, 'Send the “please reply” template');
      b.addEventListener('click', async () => {
        b.disabled = true;
        b.textContent = 'Sending…';
        try {
          await post({ action: 'send_reopen_template', ...target, action_key: key });
          toast('Template sent. When they answer you can write freely.');
          await load({ quiet: true });
        } catch (err) {
          toast(err.message, 'bad');
          b.disabled = false;
          b.textContent = 'Send the “please reply” template';
        }
      });
      box.append(b);
    }
    return box;
  }

  /** Saved replies, inserted in the customer's language (both when they have not chosen). */
  function savedReplies(ta, lang, disabled) {
    const list = data.saved_replies ?? [];
    if (!list.length) return h('span');
    const menu = h('details', { class: 'menu' },
      h('summary', { class: `btn btn-quiet btn-small${disabled ? ' is-disabled' : ''}`, 'aria-disabled': disabled ? 'true' : null },
        'Saved replies', icon('down', { size: 14 })),
      h('div', { class: 'menu-list menu-up', role: 'menu' },
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
    dispose() {},
    get customer() { return data?.customer ?? null; },
    get bookings() { return data?.bookings ?? []; },
  };
}
