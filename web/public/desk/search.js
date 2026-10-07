/**
 * Search results - one box for chassis, reference, name and phone, answered
 * from the server and grouped by what each thing is. The results follow the
 * search box as you type; Escape goes back to where you were.
 */

import { h, clear, $, api, chip, emptyState, errorState, skeleton, debounce } from './ui.js';
import { linkFor } from './inbox.js';

export function renderSearch({ route, main }) {
  let q = route.query.q ?? '';
  const results = h('div', { class: 'search-results', 'aria-live': 'polite' });
  const title = h('h1', {}, 'Search');
  main.append(h('div', { class: 'page-head' }, h('div', {}, title,
    h('p', { class: 'page-sub' }, 'Chassis, booking reference, shipment, customer name or phone number.'))), results);
  $('#q').value = q;

  let seq = 0;
  async function run() {
    const mine = ++seq;
    if (q.length < 2) {
      clear(results).append(emptyState('Type at least two characters.', 'A chassis can be typed with or without spaces.'));
      return;
    }
    clear(results).append(skeleton(5));
    let data;
    try {
      data = await api({ view: 'search', q });
    } catch (err) {
      if (mine === seq) clear(results).append(errorState(err.message, run));
      return;
    }
    if (mine !== seq) return;
    title.textContent = `Results for “${q}”`;
    clear(results);
    if (!data.groups.length) {
      results.append(emptyState('Nothing found.', 'Check the spelling, or search by the last six characters of the chassis.'));
      return;
    }
    results.append(...data.groups.map((g) => h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, g.title), h('p', { class: 'card-sub' }, `${g.items.length}`)),
      h('ul', { class: 'result-list' }, g.items.map((it) => h('li', {},
        h(it.link ? 'a' : 'div', { class: 'result', href: it.link ? linkFor(it.link) : null },
          h('span', { class: 'result-main' },
            h('bdi', { class: 'result-title' }, it.title),
            it.detail ? h('bdi', { class: 'result-detail' }, it.detail) : null),
          it.status_words ? chip(it.status_words, it.tone ?? 'gray') : null)))))));
  }

  const later = debounce(run, 250);
  run();
  return {
    search(next) { q = next; history.replaceState(null, '', `#/search?q=${encodeURIComponent(q)}`); later(); },
  };
}
