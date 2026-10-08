/**
 * The Inbox - the desk's home. One list of everything that needs a person,
 * each row a sentence saying what to do.
 *
 * Tabs answer "whose move is it"; the segmented filter narrows by kind. Both
 * live in the URL, so the browser's back button and a shared link land on the
 * same view.
 *
 * Every row has the same columns, aligned down the list, so a person scans one
 * column at a time: what to do, for whom, its tags, who has it, how long it has
 * waited. Age turns amber and then red past the thresholds below; the left
 * stripe says how urgent the row is. Neither is colour alone - the age is a
 * number, urgency is also a word (Urgent, Overdue) and a sort order.
 */

import {
  h, clear, icon, api, post, newKey, toast, toastError, badge, tag, channelIcon, avatar, timeEl, age,
  emptyState, errorState, skeleton, session, add, fill,
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
  booking: ['Booking', 'truck'], callback: ['Call-back', 'phone'], mrn: ['MRN', 'stamp'], problem: ['Problem', 'alert'],
};
const EMPTY = {
  needs_us: ['Nothing needs you right now.', 'New bookings, call-backs and messages that did not go through appear here as they arrive.', 'checkCircle', 'done'],
  waiting: ['Nobody is waiting on a customer.', 'When we ask a customer for something, the case waits here until they answer.', 'clock', ''],
  done: ['Nothing finished yet today.', 'Confirmed bookings, resolved call-backs and recorded MRNs from today are listed here.', 'check', ''],
};
const AGE_HEAD = { needs_us: 'Waiting', waiting: 'Waiting', done: 'Finished' };
const WHAT_HEAD = { needs_us: 'What needs doing', waiting: 'What we are waiting for', done: 'What was done' };

/**
 * How late a row is, from how long it has waited. Documented in
 * docs/DESK-DESIGN-SYSTEM.md ("Age thresholds"):
 *   Needs us   - amber from 30 min, red from 2 h, red whenever the server says overdue
 *   Waiting    - amber from 24 h (time to chase the customer); never red, it is not our delay
 *   Done today - never coloured
 */
export const AGE = { needsAmberMin: 30, needsRedMin: 120, waitingAmberMin: 24 * 60 };
export function ageTone(item, now = Date.now()) {
  const mins = (now - new Date(item.since).getTime()) / 60000;
  if (!Number.isFinite(mins) || item.tab === 'done') return '';
  if (item.tab === 'waiting') return mins >= AGE.waitingAmberMin ? 'amber' : '';
  if (item.overdue || mins >= AGE.needsRedMin) return 'red';
  return mins >= AGE.needsAmberMin ? 'amber' : '';
}

/** The stripe on the left: how urgent, in the same order the server sorts by. */
function markTone(item) {
  if (item.tab === 'done') return 'green';
  if (item.tab === 'waiting') return 'amber';
  if (item.kind === 'problem' || item.priority === 'urgent' || item.overdue) return 'red';
  if (item.priority === 'high') return 'amber';
  return 'blue';
}

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
  const chipsEl = h('nav', { class: 'seg', 'aria-label': 'Show only' });
  const listEl = h('div', { class: 'list-wrap' }, skeleton(7, { kind: 'rows' }));

  add(main,
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, 'Inbox'),
        h('p', { class: 'page-sub' }, 'Everything that needs a person, most urgent first.')),
      updated),
    tabsEl,
    h('div', { class: 'inbox-bar' }, chipsEl),
    listEl);

  async function load({ quiet = false } = {}) {
    try {
      data = await api({ view: 'inbox', tab, filter, limit });
    } catch (err) {
      if (!quiet) fill(listEl, errorState(err, () => load()));
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

    fill(chipsEl, ...FILTERS.map(([k, label]) => {
      const n = c.filters[k] ?? 0;
      return h('a', {
        href: href(tab, k),
        class: `seg-item${n === 0 ? ' is-zero' : ''}${k === 'problems' && n ? ' is-alert' : ''}`,
        'aria-current': k === filter ? 'true' : null,
        'aria-label': `${label}, ${n}`,
      }, label, h('span', { class: 'seg-count', 'aria-hidden': 'true' }, String(n)));
    }));

    updated.textContent = '';
    add(updated, `Updated ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`);

    clear(listEl);
    if (!data.items.length) {
      const [title, detail, ic, tone] = filter === 'all'
        ? EMPTY[tab]
        : [`No ${FILTERS.find(([k]) => k === filter)[1].toLowerCase()} here.`, 'Other kinds of work may still be waiting.', 'inbox', ''];
      add(listEl, emptyState(title, detail, filter !== 'all' ? h('a', { class: 'btn', href: href(tab, 'all') }, 'Show everything') : null, { icon: ic, tone }));
      return;
    }
    add(listEl,
      h('div', { class: 'list-head', 'aria-hidden': 'true' },
        h('span'), h('span'), h('span', {}, WHAT_HEAD[tab]), h('span', { class: 'col-who' }, 'Customer'),
        h('span', {}, 'Status'), h('span', {}, 'Owner'), h('span', {}, AGE_HEAD[tab])),
      h('ul', { class: 'rows', 'aria-label': TABS.find(([k]) => k === tab)[1] },
        data.items.map((item) => h('li', {}, row(item)))));
    if (data.has_more) {
      add(listEl, h('div', { class: 'more' }, h('button', {
        class: 'btn', type: 'button', onclick: () => { limit += 50; load(); },
      }, `Show more (${data.total - data.items.length} more)`)));
    }
  }

  /**
   * The row's status, as a badge: a word, an icon and a tone. Bookings bring
   * their own words from the server; the other kinds say the same thing from
   * the tab they are in and what the server wrote about them.
   */
  function statusOf(item) {
    if (item.kind === 'problem') {
      const p = item.problem ?? {};
      if (p.type === 'document') return badge('Unreadable', 'red');
      if (p.type === 'outbox' && !p.retryable) return badge('Held', 'amber', { icon: 'lock' });
      return badge('Not delivered', 'red');
    }
    // The tab's own words where the server's are long, so the badge fits its column.
    if (item.kind === 'booking') return badge(item.status_words === 'Waiting for the customer' ? 'Waiting on customer' : (item.status_words ?? (item.tab === 'done' ? 'Done' : 'Open')), item.tone);
    if (item.tab === 'waiting') return badge('Waiting on customer', 'amber');
    if (item.kind === 'callback') {
      if (item.tab === 'done') return /^Closed/.test(item.sentence) ? badge('Closed', 'gray') : badge('Resolved', 'green');
      return item.assigned_to ? badge('In progress', 'blue') : badge('New', 'blue');
    }
    if (item.kind === 'mrn') {
      if (item.tab === 'done') return badge('MRN issued', 'green');
      return /Record the issued/.test(item.sentence) ? badge('Approved', 'blue') : badge('New application', 'blue');
    }
    return null;
  }

  function row(item) {
    const [kindWord, kindIcon] = KIND[item.kind] ?? ['Item', 'file'];
    const tags = [
      // The kind is the icon on the left and the first word under the
      // customer on a desktop; on a phone, where both are hidden, it is a tag.
      h('span', { class: 'row-kindtag', 'aria-hidden': 'true' }, tag(kindWord, { quiet: true })),
      statusOf(item),
      item.priority === 'urgent' ? badge('Urgent', 'red') : item.priority === 'high' ? badge('High', 'amber', { icon: 'alert' }) : null,
      item.after_hours ? tag('After hours', { icon: 'clock' }) : null,
    ];
    const tone = ageTone(item);
    const ageWords = age(item.since);
    const late = item.overdue ? ' - overdue' : tone === 'red' ? ' - waiting too long' : tone === 'amber' ? ' - getting late' : '';

    // The whole row is clickable through the title link (stretched over the
    // row in CSS), while Take it, Retry and Set aside stay their own buttons -
    // a link cannot contain buttons, and the row should not need two targets.
    return h('div', { class: `row row-${item.kind}` },
      h('span', { class: `row-mark mark-${markTone(item)}`, 'aria-hidden': 'true' }),
      h('span', { class: `row-kind kind-${item.kind}`, title: kindWord }, icon(kindIcon, { size: 16 })),
      h('div', { class: 'row-main' },
        h('a', { class: 'row-title', href: linkFor(item.link) }, h('span', { class: 'sr-only' }, `${kindWord}: `), item.sentence),
        h('span', { class: 'row-detail', title: item.detail || null },
          h('bdi', { class: 'row-detail-who' }, item.who, item.detail ? ' · ' : ''),
          item.detail ? h('bdi', {}, item.detail) : null),
        item.problem ? problemActions(item) : null),
      h('div', { class: 'row-who' },
        h('span', { class: 'row-name' }, item.channel ? channelIcon(item.channel, 14) : null, h('bdi', { class: /^MKY-[A-Z]+-/.test(item.who ?? '') ? 'mono' : null }, item.who)),
        // The reference when the line above does not already show it; else the kind of work.
        item.ref && !String(item.detail ?? '').includes(item.ref) && item.ref !== item.who
          ? h('span', { class: 'row-ref mono', title: kindWord }, item.ref)
          : h('span', { class: 'row-ref', 'aria-hidden': 'true' }, kindWord)),
      h('div', { class: 'row-meta-line' },
        h('div', { class: 'row-tags' }, tags),
        owner(item)),
      // Overdue is said in words under the age - the age is already red - rather than as one more badge.
      h('span', { class: `row-age${tone ? ` age-${tone}` : ''}`, title: late ? `Waiting ${ageWords}${late}` : null },
        h('span', { class: 'row-age-time' }, icon(tone === 'red' ? 'alert' : 'clock', { size: 13 }), timeEl(item.since, ageWords || '—')),
        item.overdue ? h('span', { class: 'row-age-note' }, 'Overdue') : late ? h('span', { class: 'sr-only' }, late) : null));
  }
  /** Who has it - or, when nobody does and it is ours, the button that takes it. */
  function owner(item) {
    if (item.kind === 'problem' || item.kind === 'mrn') return h('div', { class: 'row-owner' });
    if (item.assigned_to) {
      const mine = item.assigned_to.toLowerCase() === String(session.name).toLowerCase();
      return h('div', { class: 'row-owner', title: `${item.assigned_to} has this` },
        avatar(item.assigned_to, { size: 'sm' }), h('span', {}, mine ? 'You' : item.assigned_to));
    }
    if (item.tab !== 'needs_us') return h('div', { class: 'row-owner' });
    if (!session.can('assign_self')) return h('div', { class: 'row-owner' }, h('span', { class: 'owner-none' }, icon('userX', { size: 14 }), 'Nobody yet'));
    const take = h('button', { class: 'btn btn-sm row-take', type: 'button', 'aria-label': `Take it: ${item.sentence}` }, icon('userPlus', { size: 14 }), 'Take it');
    take.addEventListener('click', () => act(take, item.kind === 'callback'
      ? { action: 'take', ticket_ref: item.ref }
      : { action: 'take', booking_ref: item.ref }, 'It is yours now.'));
    return h('div', { class: 'row-owner' }, take);
  }

  /** Retry and set aside, right on the row: a failed message should not need three clicks. */
  function problemActions(item) {
    const p = item.problem;
    if (p.type === 'document') return null;
    const can = session.can('problems');
    const box = h('div', { class: 'row-actions' });
    if (p.retryable) {
      const retry = h('button', { class: 'btn btn-sm', type: 'button', disabled: !can, title: can ? null : 'Your role cannot do this.' }, icon('refresh', { size: 14 }), 'Retry');
      const key = newKey();
      retry.addEventListener('click', () => act(retry, p.type === 'message'
        ? { action: 'retry_message', message_id: p.id, action_key: key }
        : { action: 'retry_outbox', outbox_id: p.id }, 'Sent again.'));
      add(box, retry);
    }
    const aside = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', disabled: !can }, 'Set aside');
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
      toastError(err);
      button.disabled = false;
    }
  }

  load();
  return { refresh: () => load({ quiet: true }) };
}
