/**
 * Chats - every conversation, WhatsApp and Telegram together, newest first and
 * unread on top. Opening one shows the same conversation panel the case page
 * uses, with that customer's bookings beside it.
 *
 * "Unread" is per browser: a chat is unread while its newest customer message
 * is newer than the last one this desk showed you. Nothing is stored about who
 * read what, because nothing would use it except this dot.
 */

import { h, clear, icon, api, channelBadge, chip, timeEl, emptyState, errorState, skeleton, debounce } from './ui.js';
import { mountConversation, seen } from './conversation.js';
import { linkFor } from './inbox.js';

export function renderChats({ route, main }) {
  const [channel, chatId] = route.parts;
  const open = Boolean(channel && chatId);
  let q = route.query.q ?? '';
  let convo = null;

  const listEl = h('div', { class: 'chat-list' }, skeleton(8));
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Find a chat by name, phone or reference', 'aria-label': 'Find a chat', value: q });
  const pane = h('section', { class: 'chat-pane', 'aria-label': 'Conversation' });
  const notice = h('p', { class: 'convo-notice', hidden: true });

  main.append(h('div', { class: `chats${open ? ' chats-open' : ''}` },
    h('div', { class: 'chats-side' },
      h('div', { class: 'page-head page-head-tight' }, h('h1', {}, 'Chats')),
      h('div', { class: 'chats-search' }, search),
      notice,
      listEl),
    pane));

  async function loadList({ quiet = false } = {}) {
    let data;
    try {
      data = await api({ view: 'chats', q });
    } catch (err) {
      if (!quiet) clear(listEl).append(errorState(err.message, () => loadList()));
      return;
    }
    notice.hidden = !data.notice;
    notice.textContent = data.notice ?? '';
    const chats = data.chats.map((c) => ({ ...c, unread: Boolean(c.last_in_at && (!seen.get(c.channel, c.chat_id) || c.last_in_at > seen.get(c.channel, c.chat_id))) }));
    // Unread first, then newest: the order a person answers in.
    chats.sort((a, b) => (Number(b.unread) - Number(a.unread)) || String(b.at ?? '').localeCompare(String(a.at ?? '')));

    clear(listEl);
    if (!chats.length) {
      listEl.append(emptyState(q ? 'No chat matches that.' : 'No conversations yet.',
        q ? 'Try a phone number without spaces, or a booking reference.' : 'Chats appear here when customers write to the bot.'));
      return;
    }
    listEl.append(h('ul', { class: 'chat-rows' }, chats.map((c) => h('li', {}, chatRow(c)))));
  }

  function chatRow(c) {
    const active = c.channel === channel && c.chat_id === chatId;
    const who = c.last ? (c.last.direction === 'in' ? '' : c.last.author === 'bot' ? 'Bot: ' : c.last.author === 'staff' ? `${c.last.staff_name ?? 'Us'}: ` : 'Notification: ') : '';
    return h('a', {
      class: `chat-row${c.unread ? ' is-unread' : ''}${active ? ' is-active' : ''}`,
      href: linkFor({ type: 'chat', channel: c.channel, chat_id: c.chat_id }),
      'aria-current': active ? 'page' : null,
    },
    h('span', { class: 'chat-row-top' },
      h('bdi', { class: 'chat-name' }, c.name),
      c.last ? timeEl(c.last.at) : c.at ? timeEl(c.at) : null),
    h('span', { class: 'chat-row-bottom' },
      channelBadge(c.channel, { compact: true }),
      h('span', { class: 'chat-last', dir: 'auto' }, c.last ? `${who}${c.last.body}` : 'No messages logged yet'),
      c.failed ? chip(`${c.failed} failed`, 'red') : null,
      c.opted_out ? chip('STOP', 'red') : null,
      c.unread ? h('span', { class: 'unread-dot' }, h('span', { class: 'sr-only' }, 'New message')) : null));
  }

  if (open) {
    const bookingsEl = h('div', { class: 'chat-bookings' });
    const convoEl = h('div', { class: 'chat-convo' });
    pane.append(
      h('a', { class: 'back back-mobile', href: '#/chats' }, icon('back', { size: 16 }), 'All chats'),
      bookingsEl, convoEl);
    // Their bookings, so a question about "my truck" is one click from its case.
    const drawBookings = (d) => {
      clear(bookingsEl);
      const requests = (d.requests ?? []).filter((r) => r.open);
      if (!d.bookings?.length && !requests.length) return;
      bookingsEl.append(h('p', { class: 'chat-bookings-title' }, 'Their bookings and requests'),
        h('div', { class: 'chat-bookings-list' },
          d.bookings.map((b) => h('a', { class: 'pill', href: linkFor({ type: 'booking', ref: b.booking_ref }) },
            h('span', { class: 'mono' }, b.booking_ref), chip(b.status_words, b.tone))),
          requests.map((r) => h('a', { class: 'pill', href: linkFor({ type: 'request', ref: r.ticket_ref }) },
            h('span', {}, r.ticket_ref), chip(r.status_words, 'blue')))));
    };
    convo = mountConversation(convoEl, {
      channel, chatId, target: { channel, chat_id: chatId }, draftKey: `chat:${channel}:${chatId}`,
      onSent: () => loadList({ quiet: true }),
      onLoad: drawBookings,
    });
  } else {
    pane.append(emptyState('Pick a conversation.', 'Customers on WhatsApp and Telegram are listed together, with new messages first.'));
  }

  search.addEventListener('input', debounce(() => { q = search.value.trim(); loadList(); }, 300));
  loadList();

  return {
    async refresh() {
      await loadList({ quiet: true });
      await convo?.refresh();
    },
  };
}
