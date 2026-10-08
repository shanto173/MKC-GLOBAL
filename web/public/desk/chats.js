/**
 * Chats - every conversation, WhatsApp and Telegram together, newest first and
 * unread on top. Opening one shows the same conversation panel the case page
 * uses, with that customer's bookings beside it.
 *
 * "Unread" is per browser: a chat is unread while its newest customer message
 * is newer than the last one this desk showed you. Nothing is stored about who
 * read what, because nothing would use it except this dot.
 */

import {
  h, clear, icon, api, badge, avatar, timeEl, emptyState, errorState, skeleton, debounce, add, fill, toast, toastError,
} from './ui.js';
import { mountConversation, seen } from './conversation.js';
import { linkFor } from './inbox.js';
import { openViewer } from './viewer.js';

export function renderChats({ route, main, refreshCounts = () => {} }) {
  const [channel, chatId] = route.parts;
  const open = Boolean(channel && chatId);
  let q = route.query.q ?? '';
  let limit = 50;
  let convo = null;

  const listEl = h('div', { class: 'chat-list' }, skeleton(8, { kind: 'rows' }));
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Find by name, phone or reference', 'aria-label': 'Find a chat', value: q });
  const pane = h('section', { class: 'chat-pane', 'aria-label': 'Conversation' });
  const notice = h('p', { class: 'convo-notice', hidden: true });

  add(main, h('div', { class: `chats${open ? ' chats-open' : ''}` },
    h('div', { class: 'chats-side' },
      h('div', { class: 'page-head page-head-tight' }, h('h1', {}, 'Chats')),
      h('label', { class: 'search-field' }, icon('search', { size: 16 }), search),
      notice,
      listEl),
    pane));

  async function loadList({ quiet = false } = {}) {
    let data;
    try {
      data = await api({ view: 'chats', q, limit });
    } catch (err) {
      if (!quiet) fill(listEl, errorState(err, () => loadList()));
      return;
    }
    notice.hidden = !data.notice;
    notice.textContent = data.notice ?? '';
    const chats = data.chats.map((c) => ({ ...c, unread: Boolean(c.last_in_at && (!seen.get(c.channel, c.chat_id) || c.last_in_at > seen.get(c.channel, c.chat_id))) }));
    // Unread first, then newest: the order a person answers in.
    chats.sort((a, b) => (Number(b.unread) - Number(a.unread)) || String(b.at ?? '').localeCompare(String(a.at ?? '')));

    clear(listEl);
    if (!chats.length) {
      add(listEl, emptyState(q ? 'No chat matches that.' : 'No conversations yet.',
        q ? 'Try a phone number without spaces, or a booking reference.' : 'Chats appear here when customers write to the bot.', null,
        { icon: q ? 'search' : 'chats' }));
      return;
    }
    add(listEl, h('ul', { class: 'chat-rows' }, chats.map((c) => h('li', {}, chatRow(c)))));
    if (data.has_more) {
      add(listEl, h('div', { class: 'more' }, h('button', {
        class: 'btn btn-sm', type: 'button', onclick: () => { limit += 50; loadList(); },
      }, `Show more (${data.total - data.chats.length} more)`)));
    }
  }

  function chatRow(c) {
    const active = c.channel === channel && c.chat_id === chatId;
    const who = c.last ? (c.last.direction === 'in' ? '' : c.last.author === 'bot' ? 'Bot: ' : c.last.author === 'staff' ? `${c.last.staff_name ?? 'Us'}: ` : 'Notification: ') : '';
    return h('a', {
      class: `chat-row${c.unread ? ' is-unread' : ''}${active ? ' is-active' : ''}`,
      href: linkFor({ type: 'chat', channel: c.channel, chat_id: c.chat_id }),
      'aria-current': active ? 'page' : null,
    },
    avatar(c.name, { size: 'lg', channel: c.channel }),
    h('span', { class: 'chat-row-body' },
      h('span', { class: 'chat-row-top' },
        h('bdi', { class: 'chat-name' }, c.name),
        c.last ? timeEl(c.last.at) : c.at ? timeEl(c.at) : null),
      h('span', { class: 'chat-row-bottom' },
        who ? h('span', { class: 'chat-last' }, who, h('bdi', {}, c.last.body))
          : h('span', { class: 'chat-last', dir: 'auto' }, c.last ? c.last.body : 'No messages logged yet'),
        c.failed ? badge(`${c.failed} failed`, 'red', { small: true }) : null,
        c.opted_out ? badge('STOP', 'red', { small: true, icon: 'lock' }) : null,
        c.unread ? h('span', { class: 'unread-dot' }, h('span', { class: 'sr-only' }, 'New message')) : null)));
  }

  if (open) {
    const bookingsEl = h('div', { class: 'chat-bookings' });
    const convoEl = h('div', { class: 'chat-convo' });
    add(pane,
      h('a', { class: 'back back-mobile', href: '#/chats' }, icon('back', { size: 16 }), 'All chats'),
      bookingsEl, convoEl);
    // Their bookings, so a question about "my truck" is one click from its case.
    const drawBookings = (d) => {
      clear(bookingsEl);
      const requests = (d.requests ?? []).filter((r) => r.open);
      if (!d.bookings?.length && !requests.length) return;
      add(bookingsEl, h('span', { class: 'chat-bookings-title' }, 'Their bookings and requests'),
        h('div', { class: 'chat-bookings-list' },
          d.bookings.map((b) => h('a', { class: 'pill', href: linkFor({ type: 'booking', ref: b.booking_ref }) },
            h('span', { class: 'mono' }, b.booking_ref), badge(b.status_words, b.tone, { small: true }))),
          requests.map((r) => h('a', { class: 'pill', href: linkFor({ type: 'request', ref: r.ticket_ref }) },
            icon('phone', { size: 13 }), h('span', { class: 'mono' }, r.ticket_ref), badge(r.status_words, 'blue', { small: true })))));
    };
    convo = mountConversation(convoEl, {
      channel, chatId, target: { channel, chat_id: chatId }, draftKey: `chat:${channel}:${chatId}`,
      onSent: () => loadList({ quiet: true }),
      onLoad: drawBookings,
    });
    // A paper they sent with no booking open: the inbox row opens this chat
    // on that paper, in the same viewer a case uses.
    if (route.query.doc) openPaper(Number(route.query.doc));
  } else {
    add(pane, emptyState('Pick a conversation.', 'Customers on WhatsApp and Telegram are listed together, with new messages first.', null, { icon: 'chats' }));
  }

  /** One paper, read on its own (view=document), shown in the document viewer. */
  async function openPaper(id) {
    if (!Number.isFinite(id)) return;
    let paper;
    try {
      paper = await api({ view: 'document', id });
    } catch (err) {
      toastError(err);
      return;
    }
    openViewer({
      caseRef: paper.booking_ref ?? 'No booking',
      docId: id,
      getData: () => paper,
      reload: async () => { paper = await api({ view: 'document', id }); return paper; },
      onStale: async (err) => {
        toast(err.message, 'info', { timeout: 9000 });
        paper = await api({ view: 'document', id }).catch(() => paper);
      },
      refreshCounts,
    });
  }

  search.addEventListener('input', debounce(() => { q = search.value.trim(); loadList(); }, 300));
  loadList();

  return {
    async refresh() {
      await loadList({ quiet: true });
      await convo?.refresh();
    },
    dispose() {
      document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    },
  };
}
