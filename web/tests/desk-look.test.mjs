/**
 * How the desk reads to the people using it - the owner's redesign brief
 * (docs/DESK-REDESIGN-PROMPT.md), held in place.
 *
 * These run the browser's own modules (public/desk/*) in node: their pure
 * helpers decide what a screen says, and the stylesheet's few rules that
 * carry meaning (whose message is whose) are read as text. Nothing here
 * needs a database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'desk');
const css = readFileSync(path.join(DESK, 'desk.css'), 'utf8');
const convo = await import('../public/desk/conversation.js');

/** The body of the first top-level rule with exactly this selector. */
function rule(selector) {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) return '';
  return css.slice(at, css.indexOf('}', at) + 1);
}

/** A colour token's value from :root. */
function token(name) {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  return m ? m[1].toLowerCase() : null;
}
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// ---------------------------------------------------------------------------
// The conversation, shaped like the chat app the team already uses
// ---------------------------------------------------------------------------

test('theirs is white on the left, ours light green on the right - bot, person and notification alike', () => {
  assert.equal(token('--bubble-theirs'), '#ffffff');
  const ours = token('--bubble-ours');
  assert.ok(ours, '--bubble-ours is defined');
  const [r, g, b] = rgb(ours);
  assert.ok(g > r && g > b, `${ours} is green`);
  assert.ok(Math.min(r, g, b) >= 0xd0, `${ours} is light enough for ink on it`);

  assert.match(rule('.msg-in .bubble'), /background:\s*var\(--bubble-theirs\)/);
  assert.match(rule('.msg-out .bubble'), /background:\s*var\(--bubble-ours\)/);
  // One colour for everything MKY sends; the label on the bubble says who.
  assert.doesNotMatch(css, /\.msg-(bot|staff|system) \.bubble\s*\{[^}]*background/);
});

test('the first bubble of a run has a small tail, on its own side', () => {
  assert.match(css, /\.msg-in\.run-start > \.bubble::before\s*\{/);
  assert.match(css, /\.msg-out\.run-start > \.bubble::before\s*\{/);
});

test('messages from one sender in a row are one run: a new run starts with a new sender, a pause, a tap or a new day', () => {
  const { runStarts } = convo;
  const at = (day, hour, min) => new Date(2026, 9, day, hour, min).toISOString();
  const ms = [
    { id: 1, direction: 'in', author: 'client', at: at(9, 10, 0) },
    { id: 2, direction: 'in', author: 'client', at: at(9, 10, 1) },
    { id: 3, direction: 'out', author: 'bot', at: at(9, 10, 1) },
    { id: 4, direction: 'out', author: 'bot', at: at(9, 10, 2) },
    { id: 5, direction: 'out', author: 'staff', staff_name: 'Sara', at: at(9, 10, 3) },
    { id: 6, direction: 'out', author: 'staff', staff_name: 'Omar', at: at(9, 10, 3) },
    { id: 7, direction: 'out', author: 'staff', staff_name: 'Omar', at: at(9, 10, 40) },
    { id: 8, direction: 'in', author: 'client', kind: 'tap', at: at(9, 10, 41) },
    { id: 9, direction: 'in', author: 'client', at: at(9, 10, 41) },
    { id: 10, direction: 'in', author: 'client', at: at(9, 23, 58) },
    { id: 11, direction: 'in', author: 'client', at: at(10, 0, 1) },
  ];
  assert.deepEqual([...runStarts(ms)], [1, 3, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual([...runStarts([])], []);
});

test('failed messages in a row say why once; the next one with the same reason just says it failed', () => {
  const { failureReasons } = convo;
  const why = 'The customer hasn’t written in 24 hours, so WhatsApp only allows an approved template.';
  const ms = [
    { id: 1, direction: 'out', status: 'failed', error_words: why },
    { id: 2, direction: 'out', status: 'sent' },
    { id: 3, direction: 'out', status: 'failed', error_words: why },
    { id: 4, direction: 'in', status: 'received' },
    { id: 5, direction: 'out', status: 'failed', error_words: why },
    { id: 6, direction: 'out', status: 'failed', error_words: 'Not on WhatsApp.' },
    { id: 7, direction: 'out', status: 'failed', error_words: null },
  ];
  assert.deepEqual(Object.fromEntries(failureReasons(ms)), {
    1: why,
    3: null,                         // the same as just above: not said again
    5: why,                          // the customer wrote in between: said again
    6: 'Not on WhatsApp.',
    7: 'It did not go through.',
  });
});

test('the conversation header is one row', () => {
  assert.match(rule('.convo-head'), /flex-wrap:\s*nowrap/);
  // What a narrow column drops from sight is still read out: never display:none.
  for (const words of ['.sub-channel', '.sub-lang', '.wc-long']) {
    assert.doesNotMatch(css, new RegExp(`${words.replace('.', '\\.')}[^{]*\\{\\s*display:\\s*none`), `${words} stays readable`);
  }
});

// ---------------------------------------------------------------------------
// The brief's words (section 3 to 7)
// ---------------------------------------------------------------------------

const ui = await import('../public/desk/ui.js');
const inbox = await import('../public/desk/inbox.js');
const caseMod = await import('../public/desk/case.js');
const viewer = await import('../public/desk/viewer.js');
const src = (file) => readFileSync(path.join(DESK, file), 'utf8');

test('each of the four destinations says what it is for', () => {
  assert.deepEqual(ui.PURPOSE, {
    inbox: 'Requests and issues that need your team.',
    chats: 'Read customer messages and reply.',
    shipments: 'Track confirmed shipments and update customers.',
    settings: 'Manage the team and how the bot works.',
  });
  for (const [file, key] of [['inbox.js', 'inbox'], ['chats.js', 'chats'], ['shipments.js', 'shipments'], ['settings.js', 'settings']]) {
    assert.match(src(file), new RegExp(`PURPOSE\\.${key}\\b`), `${file} shows its purpose`);
  }
});

test('the inbox tabs and filters say whose move it is and what kind of work - the API\'s keys unchanged', () => {
  assert.deepEqual(inbox.TABS.map(([k, label]) => [k, label]), [
    ['needs_us', 'Needs attention'], ['waiting', 'Waiting for customer'], ['done', 'Completed today'],
  ]);
  assert.deepEqual(inbox.FILTERS, [
    ['all', 'All'], ['bookings', 'Bookings'], ['callbacks', 'Call-back requests'], ['mrn', 'MRN applications'], ['problems', 'Issues'],
  ]);
  // Ownership is its own shortcut, apart from the kinds of work.
  assert.deepEqual(inbox.OWN_FILTER, ['mine', 'Assigned to me']);
  assert.equal(inbox.KIND.problem[0], 'Issue');
});

test('row actions are named by what they do; the old words are gone from the desk', () => {
  assert.deepEqual(inbox.ACTION_WORDS, { assign: 'Assign to me', retry: 'Retry sending', dismiss: 'Dismiss issue' });
  for (const file of ['inbox.js', 'app.js', 'case.js', 'conversation.js', 'viewer.js']) {
    const text = src(file).split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    assert.doesNotMatch(text, /'(Take it|Set aside|Retry|Problems|Looks right|Ask for a new one|Mine)'/, `${file} still says an old word`);
  }
  assert.match(src('app.js'), /label: 'Issues'/, 'the sidebar says Issues');
});

test('the document viewer\'s two decisions', () => {
  assert.deepEqual(viewer.DECISION_WORDS, {
    verify: 'Mark as verified', verifyAnyway: 'Mark as verified anyway', verified: 'Verified', replace: 'Request replacement',
  });
});

test('internal notes say the customer cannot see them; the phone switch says Booking and Conversation', () => {
  assert.equal(caseMod.NOTE_WORDS, 'Internal — customer cannot see this');
  assert.deepEqual(caseMod.paneWords('booking'), ['Booking', 'Conversation']);
  assert.deepEqual(caseMod.paneWords('request'), ['Call-back', 'Conversation']);
  assert.deepEqual(caseMod.paneWords('mrn'), ['Application', 'Conversation']);
});

test('the closed window\'s one button says which template', () => {
  assert.equal(convo.TEMPLATE_WORDS, 'Send the reply-request template');
});

// ---------------------------------------------------------------------------
// Guidance a person can see, not only hover for (sections 3, 4, 7, 8)
// ---------------------------------------------------------------------------

test('where the customer is with the bot is said in the conversation - and that a reply does not pause the bot', () => {
  assert.equal(convo.botStateLine({ bot_state_words: null }), null);
  assert.equal(convo.botStateLine({}), null);
  assert.deepEqual(convo.botStateLine({ bot_state_words: 'Booking — giving the chassis number' }), {
    state: 'With the bot: Booking — giving the chassis number',
    note: 'The bot keeps answering; replying here does not pause it.',
  });
});

test('every inbox row says who owns it, even work nobody is assigned', () => {
  const { ownerNote } = inbox;
  assert.equal(ownerNote({ kind: 'problem' }), 'Anyone on the team');
  assert.equal(ownerNote({ kind: 'mrn' }), 'Anyone on the team');
  assert.equal(ownerNote({ kind: 'booking', assigned_to: null, tab: 'needs_us' }), null, 'a booking has its own owner, or Assign to me');
});

test('Dismiss issue says, before it is pressed, what it does and what it does not do', () => {
  const { dismissWords } = inbox;
  const one = dismissWords({ type: 'message', id: 3 });
  assert.match(one, /removes the alert from the Inbox/);
  assert.match(one, /not delivered/);
  assert.match(one, /not sent again/);
  const chat = dismissWords({ type: 'chat', id: 'whatsapp:wa:2010', count: 3 });
  assert.match(chat, /3 failed messages/);
  assert.match(chat, /A new failure will appear again/);
  const paper = dismissWords({ type: 'document', id: 301 });
  assert.match(paper, /The file is kept/);
  assert.match(paper, /not deleted/);
  assert.match(paper, /not marked as verified/);
});

test('an MRN is recorded, not obtained, here - and approving is a different step from recording', () => {
  assert.match(caseMod.MRN_WORDS.record, /issued/);
  assert.match(caseMod.MRN_WORDS.record, /does not apply for it or obtain it/);
  assert.match(caseMod.MRN_WORDS.steps, /Approving the application and recording the issued MRN are separate steps/);
});
