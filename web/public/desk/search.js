/**
 * Search results - one box for chassis, reference, name and phone, answered
 * from the server and grouped by what each thing is. The results follow the
 * search box as you type; Escape goes back to where you were.
 */

import {
  h, clear, $, icon, api, badge, emptyState, errorState, skeleton, debounce, add, fill,
} from './ui.js';
import { linkFor } from './inbox.js';

/** Each group's icon, so the kind of result is a shape before it is a word. */
const GROUP_ICON = { bookings: 'truck', customers: 'user', shipments: 'ship', requests: 'phone', callbacks: 'phone', mrn: 'stamp' };
const LINK_ICON = { booking: 'truck', chat: 'chats', shipment: 'ship', request: 'phone', mrn: 'stamp' };

export function renderSearch({ route, main }) {
  let q = route.query.q ?? '';
  const results = h('div', { class: 'search-results', 'aria-live': 'polite' });
  const title = h('h1', {}, 'Search');
  const meta = h('span', { class: 'page-meta' });
  add(main, h('div', { class: 'page-head' }, h('div', {}, title,
    h('p', { class: 'page-sub' }, 'Chassis, booking reference, shipment, customer name or phone number.')), meta), results);
  $('#q').value = q;

  let seq = 0;
  async function run() {
    const mine = ++seq;
    if (q.length < 2) {
      title.textContent = 'Search';
      meta.textContent = '';
      fill(results, emptyState('Type at least two characters.', 'A chassis can be typed with or without spaces, or just its last six characters.', null, { icon: 'search' }));
      return;
    }
    fill(results, h('div', { class: 'list-wrap' }, skeleton(5, { kind: 'rows' })));
    let data;
    try {
      data = await api({ view: 'search', q });
    } catch (err) {
      if (mine === seq) fill(results, errorState(err, run));
      return;
    }
    if (mine !== seq) return;
    title.textContent = `Results for “${q}”`;
    const total = data.groups.reduce((n, g) => n + g.items.length, 0);
    meta.textContent = total ? `${total} found` : '';
    clear(results);
    if (!data.groups.length) {
      add(results, emptyState('Nothing found.', 'Check the spelling, or search by the last six characters of the chassis.', null, { icon: 'search' }));
      return;
    }
    add(results, ...data.groups.map((g) => h('section', { class: 'result-group', 'aria-labelledby': `group-${g.key}` },
      h('div', { class: 'section-head' },
        icon(GROUP_ICON[g.key] ?? 'file', { size: 16 }),
        h('h2', { id: `group-${g.key}` }, g.title),
        h('span', { class: 'count' }, String(g.items.length))),
      h('div', { class: 'list-wrap' }, h('ul', { class: 'result-list' }, g.items.map((it) => h('li', {},
        h(it.link ? 'a' : 'div', { class: 'result', href: it.link ? linkFor(it.link) : null },
          h('span', { class: 'row-kind', 'aria-hidden': 'true' }, icon(LINK_ICON[it.link?.type] ?? GROUP_ICON[g.key] ?? 'file', { size: 16 })),
          h('span', { class: 'result-main' },
            h('bdi', { class: 'result-title' }, it.title),
            it.detail ? h('bdi', { class: 'result-detail' }, it.detail) : null),
          it.status_words ? badge(it.status_words, it.tone ?? 'gray') : h('span'),
          it.link ? icon('right', { size: 16 }) : h('span')))))))));
  }

  const later = debounce(run, 250);
  run();
  return {
    search(next) { q = next; history.replaceState(null, '', `#/search?q=${encodeURIComponent(q)}`); later(); },
  };
}
