/**
 * The Inbox - the desk's home. One list of everything that needs a person,
 * each row a sentence saying what to do.
 *
 * Tabs answer "whose move is it"; chips narrow by kind. Both live in the URL,
 * so the browser's back button and a shared link land on the same view.
 */

import {
  h, clear, icon, api, post, newKey, toast, chip, channelBadge, timeEl, emptyState, errorState, skeleton, session, add, fill,
} from './ui.js';

const TABS = [
  ['needs_us', 'Needs us', 'Needs us'],
  ['waiting', 'Waiting on customer', 'Waiting'],
  ['done', 'Done today', 'Done'],
];
const FILTERS = [
  ['all', 'All'], ['bookings', 'Bookings'], ['mrn', 'MRN'], ['callbacks', 'Call-backs'], ['problems', 'Problems'], ['mine', 'Mine'],
];
const KIND = {
  booking: 'Booking', callback: 'Call-back', mrn: 'MRN', problem: 'Problem',
};
const EMPTY = {
  needs_us: ['Nothing needs you right now.', 'New bookings, call-backs and messages that did not go through appear here as they arrive.'],
  waiting: ['Nobody is waiting on a customer.', 'When we ask a customer for something, the case waits here until they answer.'],
  done: ['Nothing finished yet today.', 'Confirmed bookings, resolved call-backs and recorded MRNs from today are listed here.'],
};

/** Where a row opens. */
export function linkFor(link) {
  if (!link) return '#/inbox';
  const enc = encodeURIComponent;
  if (link.type === 'booking') return `#/case/booking/${enc(link.ref)}${link.document_id ? `?doc=${link.document_id}` : ''}`;
  if (link.type === 'request') return `#/case/request/${enc(link.ref)}`;
  if (link.type === 'mrn') return `#/case/mrn/${enc(link.ref)}`;
  if (link.type === 'chat') return `#/chats/${enc(link.channel)}/${enc(link.chat_id)}`;
  if (link.type === 'shipment') return `#/shipments/${enc(link.id)}`;
  return '#/inbox';
}

const href = (tab, filter) => `#/inbox?tab=${tab}${filter && filter !== 'all' ? `&filter=${filter}` : ''}`;

export function renderInbox({ route, main, refreshCounts }) {
  const tab = TABS.some(([k]) => k === route.query.tab) ? route.query.tab : 'needs_us';
  const filter = FILTERS.some(([k]) => k === route.query.filter) ? route.query.filter : 'all';
  let limit = 50;
  let data = null;

  const updated = h('p', { class: 'page-meta', 'aria-live': 'polite' });
  const tabsEl = h('nav', { class: 'tabs', 'aria-label': 'Whose move' });
  const chipsEl = h('nav', { class: 'filters', 'aria-label': 'Show only' });
  const listEl = h('div', { class: 'list-wrap' }, skeleton(7));

  add(main, 
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, 'Inbox'),
        h('p', { class: 'page-sub' }, 'Everything that needs a person, most urgent first.')),
      updated),
    tabsEl, chipsEl, listEl);

  async function load({ quiet = false } = {}) {
    try {
      data = await api({ view: 'inbox', tab, filter, limit });
    } catch (err) {
      if (!quiet) fill(listEl, errorState(err.message || 'We could not load the inbox.', () => load()));
      return;
    }
    draw();
  }

  function draw() {
    const c = data.counts;
    // A phone gets the short word, but a screen reader always hears the full one.
    fill(tabsEl, ...TABS.map(([k, label, short]) => h('a', {
      href: href(k, filter), class: 'tab', 'aria-current': k === tab ? 'page' : null, 'aria-label': `${label}, ${c.tabs[k] ?? 0}`,
    }, h('span', { class: 'long' }, label), h('span', { class: 'short', 'aria-hidden': 'true' }, short),
    h('span', { class: 'tab-count' }, String(c.tabs[k] ?? 0)))));

    fill(chipsEl, ...FILTERS.map(([k, label]) => h('a', {
      href: href(tab, k), class: `filter${k === 'problems' && c.filters.problems ? ' filter-alert' : ''}`,
      'aria-current': k === filter ? 'true' : null,
    }, label, h('span', { class: 'filter-count' }, String(c.filters[k] ?? 0)))));

    updated.textContent = `Updated ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;

    clear(listEl);
    if (!data.items.length) {
      const [title, detail] = filter === 'all'
        ? EMPTY[tab]
        : [`No ${FILTERS.find(([k]) => k === filter)[1].toLowerCase()} here.`, 'Other kinds of work may still be waiting.'];
      add(listEl, emptyState(title, detail, filter !== 'all' ? h('a', { class: 'btn', href: href(tab, 'all') }, 'Show everything') : null));
      return;
    }
    add(listEl, h('ul', { class: 'rows', 'aria-label': TABS.find(([k]) => k === tab)[1] },
      data.items.map((item) => h('li', {}, row(item)))));
    if (data.has_more) {
      add(listEl, h('div', { class: 'more' }, h('button', {
        class: 'btn', type: 'button', onclick: () => { limit += 50; load(); },
      }, `Show more (${data.total - data.items.length} more)`)));
    }
  }

  function row(item) {
    const meta = [
      chip(KIND[item.kind] ?? 'Item', item.kind === 'problem' ? 'red' : item.tone),
      item.priority === 'urgent' ? chip('Urgent', 'red') : item.priority === 'high' ? chip('High', 'amber') : null,
      item.overdue ? chip('Overdue', 'red') : null,
      item.is_new ? chip('New', 'blue') : null,
      item.after_hours ? chip('After hours', 'gray') : null,
    ];
    const owner = item.kind === 'problem' ? null
      : item.assigned_to ? h('span', { class: 'owner' }, icon('user', { size: 13 }), item.assigned_to)
        : item.tab === 'needs_us' ? h('span', { class: 'owner owner-none' }, 'Nobody yet') : null;

    // The whole row is clickable through the title link (stretched over the
    // row in CSS), while Retry and Set aside stay their own buttons - a link
    // cannot contain buttons, and the row should not need two targets.
    return h('div', { class: `row${item.kind === 'problem' ? ' row-problem' : ''}` },
      h('span', { class: `row-mark tone-${item.kind === 'problem' ? 'red' : item.tone}`, 'aria-hidden': 'true' }),
      h('div', { class: 'row-main' },
        h('a', { class: 'row-title', href: linkFor(item.link) }, item.sentence),
        h('span', { class: 'row-sub' },
          h('bdi', { class: 'row-who' }, item.who),
          item.detail ? h('span', { class: 'row-detail' }, ' · ', h('bdi', {}, item.detail)) : null),
        item.problem ? problemActions(item) : null),
      h('div', { class: 'row-meta' },
        h('span', { class: 'row-chips' }, meta),
        h('span', { class: 'row-side' }, owner, channelBadge(item.channel, { compact: true }), timeEl(item.since))));
  }

  /** Retry and set aside, right on the row: a failed message should not need three clicks. */
  function problemActions(item) {
    const p = item.problem;
    if (p.type === 'document') return null;
    const can = session.can('problems');
    const box = h('div', { class: 'row-actions' });
    if (p.retryable) {
      const retry = h('button', { class: 'btn btn-small', type: 'button', disabled: !can, title: can ? null : 'Your role cannot do this.' }, icon('refresh', { size: 14 }), 'Retry');
      const key = newKey();
      retry.addEventListener('click', () => act(retry, p.type === 'message'
        ? { action: 'retry_message', message_id: p.id, action_key: key }
        : { action: 'retry_outbox', outbox_id: p.id }, 'Sent again.'));
      add(box, retry);
    }
    const aside = h('button', { class: 'btn btn-small btn-quiet', type: 'button', disabled: !can }, 'Set aside');
    aside.addEventListener('click', () => act(aside, { action: 'dismiss_problem', problem_id: `${p.type}:${p.id}` }, 'Set aside. It will not come back.'));
    add(box, aside);
    return box;
  }

  async function act(button, body, ok) {
    button.disabled = true;
    try {
      await post(body);
      toast(ok);
      await load({ quiet: true });
      refreshCounts();
    } catch (err) {
      toast(err.message, 'bad');
      button.disabled = false;
    }
  }

  load();
  return { refresh: () => load({ quiet: true }) };
}
