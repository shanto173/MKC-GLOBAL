/**
 * Team MKY — staff-to-staff chat. Type @ then a customer name or VIN to tag a
 * Port Sum Up order; clicking the tag opens that order.
 */

import {
  h, clear, icon, api, post, session, toast, toastError, timeEl, when,
  emptyState, errorState, skeleton, add, fill, VIEW_SCOPES, PURPOSE,
} from './ui.js';

export function renderTeamMky({ main, signal = null }) {
  const feed = h('div', { class: 'team-feed' }, skeleton(4, { kind: 'rows' }));
  const input = h('textarea', {
    class: 'input', rows: '3', dir: 'auto',
    placeholder: 'Message the team… use @Name or @VIN to tag an order',
    'aria-label': 'Team MKY message',
  });
  const send = h('button', { class: 'btn btn-primary', type: 'button' }, icon('send', { size: 14 }), 'Send');
  const suggest = h('ul', { class: 'team-suggest', hidden: true, role: 'listbox', 'aria-label': 'Shipment tags' });
  let candidates = [];
  let rows = [];
  let next = null;
  let first = null;
  let mentionAt = -1;

  add(main,
    h('div', { class: 'page-head' }, h('div', {},
      h('h1', {}, 'Team MKY'),
      h('p', { class: 'page-sub' }, PURPOSE.teamMky))),
    feed,
    h('div', { class: 'team-compose card' },
      suggest,
      input,
      h('div', { class: 'form-actions' }, send)));

  async function loadMentions() {
    try {
      const data = await api({ view: 'port_sum_mentions' }, { signal });
      candidates = data.candidates ?? [];
    } catch {
      candidates = [];
    }
  }

  async function load({ quiet = false } = {}) {
    let data;
    try {
      data = await api({ view: 'team_mky', limit: 80 }, { signal });
    } catch (err) {
      if (err.aborted) return false;
      if (!quiet) fill(feed, errorState(err, () => load()));
      return false;
    }
    if (data === first) return true;
    first = data;
    rows = data.rows ?? [];
    next = data.next ?? null;
    if (data.pending && !quiet) toast(data.pending, 'info');
    draw();
    return true;
  }

  async function more(button) {
    if (!next) return;
    button.disabled = true;
    try {
      const data = await api({ view: 'team_mky', limit: 80, after: next }, { signal });
      const older = data.rows ?? [];
      const seen = new Set(rows.map((m) => m.id));
      rows = [...older.filter((m) => !seen.has(m.id)), ...rows];
      next = data.next ?? null;
      draw();
    } catch (err) {
      if (!err.aborted) toastError(err);
      button.disabled = false;
    }
  }

  function draw() {
    clear(feed);
    if (!rows.length) {
      add(feed, emptyState('No team messages yet.', 'Say hello, or tag an order with @customer or @VIN.', null, { icon: 'users' }));
      return;
    }
    if (next) {
      const button = h('button', { class: 'btn btn-sm', type: 'button' }, 'Load earlier');
      button.addEventListener('click', () => more(button));
      add(feed, h('div', { class: 'more' }, button));
    }
    add(feed, h('ol', { class: 'team-messages' }, rows.map(messageEl)));
    feed.scrollTop = feed.scrollHeight;
  }

  function messageEl(m) {
    return h('li', { class: `team-msg${m.author === session.name ? ' is-mine' : ''}` },
      h('div', { class: 'team-msg-meta' },
        h('strong', {}, m.author),
        timeEl(m.at, when(m.at))),
      h('div', { class: 'team-msg-body', dir: 'auto' }, ...renderBody(m.body, m.mentions ?? [])));
  }

  function renderBody(body, mentions) {
    if (!mentions.length) return [body];
    const parts = [];
    let cursor = 0;
    const sorted = [...mentions].sort((a, b) => a.start - b.start);
    for (const m of sorted) {
      if (m.start < cursor || m.end > body.length) continue;
      if (m.start > cursor) parts.push(body.slice(cursor, m.start));
      parts.push(h('a', {
        class: 'team-mention',
        href: `#/port-sum/${encodeURIComponent(m.booking_ref)}`,
        title: `Open ${m.label} in Port Sum Up`,
      }, `@${m.label}`));
      cursor = m.end;
    }
    if (cursor < body.length) parts.push(body.slice(cursor));
    return parts.length ? parts : [body];
  }

  function showSuggest(query) {
    const q = query.toLowerCase();
    const hits = candidates
      .filter((c) => !q || c.label.toLowerCase().includes(q))
      .slice(0, 8);
    clear(suggest);
    if (!hits.length) { suggest.hidden = true; return; }
    suggest.hidden = false;
    for (const c of hits) {
      const li = h('li', { role: 'option' },
        h('button', { class: 'team-suggest-item', type: 'button' },
          h('span', {}, `@${c.label}`),
          h('span', { class: 'muted' }, c.kind === 'vin' ? 'VIN' : 'Customer')));
      li.querySelector('button').addEventListener('click', () => insertMention(c.label));
      add(suggest, li);
    }
  }

  function insertMention(label) {
    const v = input.value;
    const caret = input.selectionStart ?? v.length;
    const at = mentionAt >= 0 ? mentionAt : v.lastIndexOf('@', caret - 1);
    if (at < 0) return;
    const before = v.slice(0, at);
    const after = v.slice(caret);
    input.value = `${before}@${label} ${after}`;
    const pos = before.length + label.length + 2;
    input.setSelectionRange(pos, pos);
    suggest.hidden = true;
    mentionAt = -1;
    input.focus();
  }

  input.addEventListener('input', () => {
    const v = input.value;
    const caret = input.selectionStart ?? v.length;
    const head = v.slice(0, caret);
    const m = /@([^\s@]*)$/.exec(head);
    if (!m) { suggest.hidden = true; mentionAt = -1; return; }
    mentionAt = caret - m[0].length;
    showSuggest(m[1]);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { suggest.hidden = true; return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send.click();
    }
  });

  send.addEventListener('click', async () => {
    const body = input.value.trim();
    if (!body) return;
    send.disabled = true;
    try {
      const res = await post({ action: 'team_message', body });
      input.value = '';
      suggest.hidden = true;
      if (res.message) {
        rows = [...rows, res.message];
        draw();
      } else {
        first = null;
        await load({ quiet: true });
      }
    } catch (err) {
      toastError(err);
    } finally {
      send.disabled = false;
    }
  });

  loadMentions();
  load();
  return {
    refresh: () => { loadMentions(); return load({ quiet: true }); },
    scopes: VIEW_SCOPES.team_mky,
  };
}
