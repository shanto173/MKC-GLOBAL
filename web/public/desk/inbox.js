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
  emptyState, errorState, skeleton, session, add, fill, VIEW_SCOPES,
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

/**
 * A problem row's colour: red when something failed, amber when it waits on
 * something (a held message) or wants a look (a paper with no booking, a paper
 * after the decision) - its badge's tone, so the stripe never contradicts it.
 */
const problemTone = (item) => (item.status?.tone === 'amber' ? 'amber' : 'red');

/** The stripe on the left: how urgent, in the same order the server sorts by. */
function markTone(item) {
  if (item.tab === 'done') return 'green';
  if (item.tab === 'waiting') return 'amber';
  if (item.kind === 'problem') return problemTone(item);
  if (item.priority === 'urgent' || item.overdue) return 'red';
  if (item.priority === 'high') return 'amber';
  return 'blue';
}

/** Where a row opens. A paper's row opens the viewer on that paper, in its case or its chat. */
export function linkFor(link) {
  if (!link) return '#/inbox';
  const enc = encodeURIComponent;
  const doc = link.document_id ? `?doc=${enc(link.document_id)}` : '';
  if (link.type === 'booking') return `#/case/booking/${enc(link.ref)}${doc}`;
  if (link.type === 'request') return `#/case/request/${enc(link.ref)}`;
  if (link.type === 'mrn') return `#/case/mrn/${enc(link.ref)}`;
  if (link.type === 'chat') return `#/chats/${enc(link.channel)}/${enc(link.chat_id)}${doc}`;
  if (link.type === 'shipment') return `#/shipments/${enc(link.id)}`;
  return '#/inbox';
}

/**
 * The row's status badge, from the status the server gives every row
 * ({ label, tone, meaning }) - never read back out of the sentence, which
 * broke the day a sentence was reworded. The desk chooses only how the label
 * fits: a few of the server's labels are too long for the status column, so
 * the badge says the short form and keeps the full one as its tooltip.
 * docs/DESK-DESIGN-SYSTEM.md, "Row status".
 */
const SHORT_STATUS = {
  'Waiting for the customer': 'Waiting on customer',
  'Waiting for Client': 'Waiting on customer',
  'New — nobody has it yet': 'New',
  'In Progress': 'In progress',
  'Approved — record the number': 'Approved',
};
/** Labels whose tone's own icon would say the wrong thing: a paper is a file, held is locked. */
const STATUS_ICON = { Held: 'lock', 'No booking': 'file', 'New paper': 'file' };

export function rowStatus(item) {
  const s = item?.status;
  if (!s?.label) {
    // An older server, mid-deploy: its own words for a booking, nothing invented for the rest.
    return item?.status_words ? { label: item.status_words, full: item.status_words, tone: item.tone ?? 'gray', icon: null } : null;
  }
  return { label: SHORT_STATUS[s.label] ?? s.label, full: s.label, tone: s.tone ?? 'gray', icon: STATUS_ICON[s.label] ?? null };
}

/** "a message", "3 messages". */
const messagesWord = (n) => (n === 1 ? '1 message' : `${n} messages`);

/**
 * One problem per chat (problem.type 'chat'): how many messages, when the last
 * was tried, and what that means for the person reading it - in words.
 */
export const REASON_WORDS = {
  not_on_whatsapp: 'sending again won’t help',
  failed: 'send them again from the chat',
  needs_template: 'they go when the customer writes',
  opted_out: 'they go only if the customer writes again',
};

/** The line under a chat's problem: what WhatsApp said last, or who the number is. */
export function problemDetail(item) {
  const p = item?.problem;
  if (p?.type !== 'chat' || p.reason === 'not_on_whatsapp' || !p.last_error) return item?.detail ?? '';
  return `Last error: ${p.last_error}`;
}
export function problemFacts(problem, now = Date.now()) {
  if (!problem || problem.type !== 'chat') return null;
  const n = Number(problem.count) || 0;
  const held = problem.reason === 'needs_template' || problem.reason === 'opted_out';
  const tried = problem.last_attempt ? age(problem.last_attempt, now) : '';
  return [
    `${messagesWord(n)} ${held ? 'held' : 'not delivered'}`,
    tried ? `last tried ${tried === 'just now' ? 'just now' : `${tried} ago`}` : null,
    REASON_WORDS[problem.reason] ?? null,
  ].filter(Boolean).join(' · ');
}

/**
 * A sentence with its references kept whole: "New ACID after MKY-BKG-261005-A3K6
 * was confirmed" otherwise breaks at a hyphen inside the reference, and
 * "MKY-BKG-261005-" over "A3K6" reads as two things.
 */
const REF = /\bMKY-[A-Z]+-[0-9A-Z][0-9A-Z-]*/g;
export function refPieces(text) {
  const s = String(text ?? '');
  const out = [];
  let last = 0;
  for (const m of s.matchAll(REF)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push({ ref: m[0] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
const withWholeRefs = (text) => refPieces(text).map((p) => (typeof p === 'string' ? p : h('span', { class: 'ref-whole' }, p.ref)));

/** What "Set aside" sends: a whole chat's failures, one message, an outbox row, or a paper. */
export function problemId(problem) {
  return `${problem.type}:${problem.id}`;
}

const href = (tab, filter) => `#/inbox?tab=${tab}${filter && filter !== 'all' ? `&filter=${filter}` : ''}`;

export function renderInbox({ route, main, setCounts = () => {}, signal = null }) {
  const tab = TABS.some(([k]) => k === route.query.tab) ? route.query.tab : 'needs_us';
  const filter = FILTERS.some(([k]) => k === route.query.filter) ? route.query.filter : 'all';
  let limit = 50;
  let data = null;
  let drawnFrom = null;    // the answer last drawn: a 304 gives the same object back

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

  /** Loads the list; false when it could not (the next tick tries again). */
  async function load({ quiet = false } = {}) {
    try {
      data = await api({ view: 'inbox', tab, filter, limit }, { signal });
    } catch (err) {
      if (err.aborted) return false;
      if (!quiet) fill(listEl, errorState(err, () => load()));
      return false;
    }
    // The sidebar's numbers come with the list: no second request for them.
    if (data.nav) setCounts(data.nav);
    stamp();
    // Nothing changed since it was drawn: the rows stay as they are.
    if (data === drawnFrom) return true;
    drawnFrom = data;
    draw();
    return true;
  }

  /** "Updated 14:05": when the list was last known to be true, changed or not. */
  function stamp() {
    updated.textContent = '';
    add(updated, `Updated ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`);
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

  /** The row's one status badge: the server's label and tone (see rowStatus). */
  function statusOf(item) {
    const s = rowStatus(item);
    if (!s) return null;
    const b = badge(s.label, s.tone, { icon: s.icon ?? undefined });
    if (s.full !== s.label) b.title = s.full;
    return b;
  }

  function row(item) {
    const paper = item.problem?.type === 'document';
    const [kindWordOf, kindIconOf] = KIND[item.kind] ?? ['Item', 'file'];
    // A paper is a file whatever is wrong with it; a failed message is an alert.
    const kindWord = paper ? 'Paper' : kindWordOf;
    const kindIcon = paper ? 'file' : kindIconOf;
    const kindTone = item.kind === 'problem' ? ` kind-${problemTone(item)}` : '';
    const tags = [
      // The kind is the icon on the left and the first word under the
      // customer on a desktop; on a phone, where both are hidden, it is a tag.
      h('span', { class: 'row-kindtag', 'aria-hidden': 'true' }, tag(kindWord, { quiet: true })),
      statusOf(item),
      item.priority === 'urgent' ? badge('Urgent', 'red') : item.priority === 'high' ? badge('High', 'amber', { icon: 'alert' }) : null,
      // A call-back opened at the tap, before the customer said what about.
      item.undescribed ? tag('Not described yet', { icon: 'note', title: 'They asked for a person and have not said what about yet.' }) : null,
      item.after_hours ? tag('After hours', { icon: 'clock' }) : null,
    ];
    const detail = problemDetail(item);
    const facts = problemFacts(item.problem);
    const tone = ageTone(item);
    const ageWords = age(item.since);
    const late = item.overdue ? ' - overdue' : tone === 'red' ? ' - waiting too long' : tone === 'amber' ? ' - getting late' : '';

    // The whole row is clickable through the title link (stretched over the
    // row in CSS), while Take it, Retry and Set aside stay their own buttons -
    // a link cannot contain buttons, and the row should not need two targets.
    return h('div', { class: `row row-${item.kind}` },
      h('span', { class: `row-mark mark-${markTone(item)}`, 'aria-hidden': 'true' }),
      h('span', { class: `row-kind kind-${item.kind}${kindTone}`, title: kindWord }, icon(kindIcon, { size: 16 })),
      h('div', { class: 'row-main' },
        h('a', { class: 'row-title', href: linkFor(item.link) }, h('span', { class: 'sr-only' }, `${kindWord}: `), withWholeRefs(item.sentence)),
        h('span', { class: 'row-detail', title: detail || null },
          h('bdi', { class: 'row-detail-who' }, item.who, detail ? ' · ' : ''),
          detail ? h('bdi', {}, detail) : null),
        item.problem ? problemActions(item, facts) : null),
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
    take.addEventListener('click', () => takeIt(take, item));
    return h('div', { class: 'row-owner' }, take);
  }

  /**
   * "Take it" from the list, with the version the row was drawn from - the
   * server gives every row its record's version, so nothing is read first.
   * The row can be a tick old (15 seconds; a minute on an idle desk): if a
   * colleague took it, or anything else changed, in the meantime, the server refuses and says who did what,
   * and the list redraws. Nobody's case is taken from them by a stale row.
   */
  async function takeIt(button, item) {
    const type = item.kind === 'callback' ? 'request' : 'booking';
    const target = type === 'request' ? { ticket_ref: item.ref } : { booking_ref: item.ref };
    button.disabled = true;
    try {
      let { version } = item;
      if (!version) {
        // A row without a version (a server from before they carried one): read the case for it.
        const c = await api({ view: 'case', type, ref: item.ref });
        if (c.header?.assigned_to) {
          toast(`${c.header.assigned_to} has just taken this.`, 'info');
          await load({ quiet: true });
          return;
        }
        version = c.version;
      }
      await post({ action: 'take', ...target, version });
      toast('It is yours now.');
      await load({ quiet: true });
    } catch (err) {
      toastError(err);
      if (err.data?.stale) { await load({ quiet: true }); return; }
      button.disabled = false;
    }
  }

  /**
   * What can be done about a problem, right on its row - a failed message
   * should not need three clicks. One failed message: Retry and Set aside. A
   * chat's failures together: how many and when, then Set aside for the lot
   * (each one can be sent again from the conversation). A paper: Set aside.
   */
  function problemActions(item, facts) {
    const p = item.problem;
    const can = session.can('problems');
    const box = h('div', { class: 'row-actions' });
    if (p.retryable && (p.type === 'message' || p.type === 'outbox')) {
      const retry = h('button', { class: 'btn btn-sm', type: 'button', disabled: !can, title: can ? null : 'Your role cannot do this.' }, icon('refresh', { size: 14 }), 'Retry');
      const key = newKey();
      retry.addEventListener('click', () => act(retry, p.type === 'message'
        ? { action: 'retry_message', message_id: p.id, action_key: key }
        : { action: 'retry_outbox', outbox_id: p.id }, 'Sent again.'));
      add(box, retry);
    }
    const asideWords = p.type === 'chat' ? 'Set aside. These failures will not come back; a new one would.'
      : p.type === 'document' ? 'Set aside. The paper is kept; it leaves the inbox.'
        : 'Set aside. It will not come back.';
    const aside = h('button', {
      class: 'btn btn-sm btn-ghost', type: 'button', disabled: !can, title: can ? null : 'Your role cannot do this.',
      'aria-label': `Set aside: ${item.sentence}`,
    }, 'Set aside');
    aside.addEventListener('click', () => act(aside, { action: 'dismiss_problem', problem_id: problemId(p) }, asideWords));
    add(box, aside);
    if (facts) add(box, h('span', { class: 'row-facts' }, icon('clock', { size: 13 }), facts));
    return box;
  }

  async function act(button, body, ok) {
    button.disabled = true;
    try {
      await post(body);
      toast(ok);
      await load({ quiet: true });
    } catch (err) {
      toastError(err);
      button.disabled = false;
    }
  }

  load();
  return {
    refresh: () => load({ quiet: true }),
    // Fetched again when one of these moves (public/desk/live.js).
    scopes: VIEW_SCOPES.inbox,
    // The list carries the sidebar's numbers (setCounts above).
    providesCounts: true,
  };
}
