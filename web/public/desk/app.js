/**
 * The MKY Desk - start-up, sign-in, navigation, and keeping the screen true.
 *
 * Plain ES modules, no framework and no build step: the files in this folder
 * are what the browser runs. Each screen is a function that draws into <main>
 * and returns { refresh, dispose }; this file decides which one is showing and
 * calls its refresh every 20 seconds and whenever the window regains focus, so
 * what a person sees is never more than a moment behind what a colleague did.
 */

import {
  h, $, clear, icon, session, api, safeSet, safeGet, SKEY, NKEY, on,
} from './ui.js';
import { renderInbox } from './inbox.js';
import { renderCase } from './case.js';
import { renderChats } from './chats.js';
import { renderShipments } from './shipments.js';
import { renderSettings } from './settings.js';
import { renderSearch } from './search.js';

const POLL_MS = 20_000;

const NAV = [
  { key: 'inbox', label: 'Inbox', icon: 'inbox', href: '#/inbox' },
  { key: 'chats', label: 'Chats', icon: 'chats', href: '#/chats' },
  { key: 'shipments', label: 'Shipments', icon: 'ship', href: '#/shipments' },
  { key: 'settings', label: 'Settings', icon: 'settings', href: '#/settings', needs: 'settings' },
];

let screen = null;         // the screen showing: { refresh?, dispose? }
let counts = { needs_us: 0, problems: 0, mine: 0 };
let ticking = false;

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** "#/case/booking/MKY-1?doc=3" → { page: 'case', parts: ['booking','MKY-1'], query: { doc: '3' } } */
export function parseRoute(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, '') || 'inbox';
  const [pathPart, queryPart = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  return { page: parts[0] || 'inbox', parts: parts.slice(1), query: Object.fromEntries(new URLSearchParams(queryPart)) };
}

function render() {
  const route = parseRoute();
  screen?.dispose?.();
  screen = null;
  const main = $('#main');
  clear(main);
  drawNav(route.page);
  if (route.page !== 'search') $('#q').value = '';

  const ctx = { route, main, refreshCounts };
  const pages = {
    inbox: renderInbox, case: renderCase, chats: renderChats, shipments: renderShipments,
    settings: renderSettings, search: renderSearch,
  };
  const page = pages[route.page];
  if (!page) { location.replace('#/inbox'); return; }
  screen = page(ctx) ?? null;
  // A new screen is a new place: move focus there so a keyboard or screen
  // reader user starts at its top, not wherever the old screen left them.
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Navigation and the tab title
// ---------------------------------------------------------------------------

function drawNav(active) {
  const items = NAV.filter((n) => !n.needs || session.can(n.needs));
  const badge = (n) => (n.key === 'inbox' && counts.needs_us
    ? h('span', { class: `nav-count${counts.problems ? ' nav-count-alert' : ''}` },
      String(counts.needs_us), h('span', { class: 'sr-only' }, ' need a person'))
    : null);

  clear($('#nav')).append(...items.map((n) => h('li', {},
    h('a', { href: n.href, class: 'nav-link', 'aria-current': n.key === active ? 'page' : null },
      icon(n.icon, { size: 18 }), h('span', {}, n.label), badge(n)))));

  clear($('#tabbar')).append(...items.map((n) => h('a', {
    href: n.href, class: 'tab-link', 'aria-current': n.key === active ? 'page' : null,
  }, icon(n.icon, { size: 20 }), h('span', {}, n.label), badge(n))));

  clear($('#me')).append(
    h('div', { class: 'me-who' }, icon('user', { size: 16 }), h('div', {},
      h('div', { class: 'me-name' }, session.name), h('div', { class: 'me-role' }, session.role_words ?? ''))),
    h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: signOut }, icon('logout', { size: 15 }), 'Sign out'));
}

/** "(3) MKY Desk": the browser tab says when something is waiting, from any screen. */
async function refreshCounts() {
  try {
    counts = await api({ view: 'counts' });
  } catch {
    return;
  }
  document.title = counts.needs_us ? `(${counts.needs_us}) MKY Desk` : 'MKY Desk';
  drawNav(parseRoute().page);
}

async function tick() {
  if (ticking || document.hidden || $('#app').hidden) return;
  ticking = true;
  try {
    await refreshCounts();
    await screen?.refresh?.();
  } finally {
    ticking = false;
  }
}

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

function showSignIn(message = '', extra = null) {
  $('#app').hidden = true;
  $('#signin').hidden = false;
  const err = $('#signinError');
  err.textContent = message;
  err.hidden = !message;
  clear($('#signinExtra'));
  if (extra) $('#signinExtra').append(extra);
  $('#who').value = session.name || '';
  ($('#who').value ? $('#secret') : $('#who')).focus();
}

/** The page shown when the server itself is not set up, naming the missing setting. */
function showNotConfigured(setting) {
  $('#app').hidden = true;
  $('#signin').hidden = false;
  clear($('#signin')).append(h('div', { class: 'signin-card' },
    h('div', { class: 'signin-brand', 'aria-hidden': 'true' }, 'M'),
    h('h1', {}, 'The desk is not set up yet'),
    h('p', {}, 'The server is missing the setting ', h('code', {}, setting), '.'),
    h('p', { class: 'field-hint' }, 'Whoever deployed the desk adds it under Project settings → Environment variables, then redeploys.')));
}

async function signIn({ quiet = false } = {}) {
  const button = $('#signinButton');
  button.disabled = true;
  button.textContent = 'Signing in…';
  try {
    const me = await api({ view: 'me' });
    if (me.bootstrap) return offerBootstrap();
    Object.assign(session, me);
    safeSet(SKEY, session.secret);
    safeSet(NKEY, session.name);
    $('#signin').hidden = true;
    $('#app').hidden = false;
    if (!location.hash) location.replace('#/inbox');
    render();
    refreshCounts();
  } catch (err) {
    if (err.data?.setup) return showNotConfigured(err.data.setup);
    const message = err.status === 401 ? 'That desk password was not accepted.'
      : err.offline ? 'We could not reach the server. Check the connection and try again.'
        : err.message;
    // A remembered password that stopped working (it was rotated) is said
    // plainly, with the name already filled in.
    showSignIn(quiet && err.status === 401 ? 'The desk password has changed. Sign in again.' : message);
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in';
  }
}

/** A desk with nobody on it lets the first person make themselves administrator. */
function offerBootstrap() {
  const yes = h('button', { class: 'btn btn-primary btn-block', type: 'button' }, `Yes, make ${session.name} the administrator`);
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    try {
      await api({}, { method: 'POST', body: { action: 'bootstrap_admin' } });
      await signIn();
    } catch (err) {
      showSignIn(err.message);
    }
  });
  showSignIn('', h('div', { class: 'callout callout-blue' },
    h('p', {}, h('strong', {}, 'Nobody is on the team yet.'), ' The first person to sign in becomes the administrator and can add everyone else.'),
    yes));
}

function signOut() {
  safeSet(SKEY, null);
  session.secret = '';
  screen?.dispose?.();
  screen = null;
  document.title = 'MKY Desk';
  showSignIn('');
  $('#secret').value = '';
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

$('#signinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#who').value.trim();
  const secret = $('#secret').value.trim();
  if (!name || !secret) return showSignIn('Type your name and the desk password.');
  session.name = name;
  session.secret = secret;
  signIn();
});

$('#searchIcon').append(icon('search', { size: 16 }));
$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`;
});
$('#q').addEventListener('input', () => {
  const q = $('#q').value.trim();
  // Typing in the box takes you to the results, which follow as you type.
  if (q.length >= 2 && parseRoute().page !== 'search') location.hash = `#/search?q=${encodeURIComponent(q)}`;
  else if (parseRoute().page === 'search') screen?.search?.(q);
});
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('#q').value = ''; $('#q').blur(); if (parseRoute().page === 'search') history.back(); }
});

// "/" anywhere (except while typing) jumps to search - the shortcut chat apps taught everybody.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t.closest?.('input, textarea, select, [contenteditable="true"], dialog')) return;
  e.preventDefault();
  $('#q').focus();
  $('#q').select();
});

on('offline', (offline) => { $('#offline').hidden = !offline; });
on('unauthorised', (message) => { if (!$('#app').hidden) { signOut(); showSignIn(message); } });
window.addEventListener('online', tick);
window.addEventListener('offline', () => { $('#offline').hidden = false; });
window.addEventListener('hashchange', () => { if (!$('#app').hidden) render(); });
window.addEventListener('focus', tick);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
setInterval(tick, POLL_MS);

if (session.secret && session.name) {
  signIn({ quiet: true });
} else {
  session.name = safeGet(NKEY) ?? '';
  showSignIn('');
}
