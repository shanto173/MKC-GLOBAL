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

test('and when a colleague has taken the chat over, it says that instead - with who has it', () => {
  const held = convo.botStateLine({
    bot_state_words: 'Booking — giving the chassis number',
    bot_hold: { at: '2026-10-12T14:20:00Z', by: 'Sara' },
  });
  assert.equal(held.state, 'The bot is not answering this chat');
  assert.match(held.note, /^Sara has it\./, 'the second person to open it needs to know before they type');
  assert.match(held.note, new RegExp(convo.TAKEOVER_WORDS), 'and how to let the bot back in');
  // Held, with nothing known about where they were: still said.
  assert.equal(convo.botStateLine({ bot_hold: { at: '2026-10-12T14:20:00Z', by: null } }).state,
    'The bot is not answering this chat');
});

test('the tick that takes a chat off the bot is in the chat header, and what it does is said in the tooltip', () => {
  const chat = src('conversation.js');
  assert.match(chat, /takeover\(c\)/, 'drawn in the header beside the window chip');
  assert.match(chat, /action: 'bot_hold'/, 'and it is a server decision, not a browser one');
  assert.match(chat, /The bot stops answering this customer until you untick it/,
    'said in plain words before it is ticked, not only after');
  // Somebody who may not write to a customer may not take the bot off them -
  // they see the state, without a tick they cannot use.
  assert.match(chat, /session\.can\('chat'\)[\s\S]{0,120}badge\('Bot off'/);
});

test('every inbox row says who owns it, even work nobody is assigned', () => {
  const { ownerNote } = inbox;
  assert.equal(ownerNote({ kind: 'problem' }), 'Anyone on the team');
  assert.equal(ownerNote({ kind: 'mrn' }), 'Anyone on the team');
  assert.equal(ownerNote({ kind: 'booking', assigned_to: null, tab: 'needs_us' }), null, 'a booking has its own owner, or Assign to me');
  assert.equal(ownerNote({ kind: 'booking', assigned_to: 'Omar', tab: 'waiting' }), null);
  // Waiting or done, nobody's: said, not left blank (there is nothing to assign then).
  assert.equal(ownerNote({ kind: 'booking', assigned_to: null, tab: 'waiting' }), 'Unassigned');
  assert.equal(ownerNote({ kind: 'callback', assigned_to: null, tab: 'done' }), 'Unassigned');
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

test('no issue row is a dead end: each can be dismissed, and the bin names the row it takes', () => {
  const { dismissWords, PROBLEM_DELETE_KIND, PROBLEM_DELETE_WORDS } = inbox;
  // Every type lib/admin/desk-inbox.js can put on an issue row.
  for (const type of ['document', 'message', 'outbox', 'chat']) {
    assert.match(dismissWords({ type, id: 1, count: 2 }), /Dismissing removes the alert/, `${type} can be dismissed`);
  }
  // And where the row stands for a record, the bin says which record - never
  // "the issue", which is what Dismiss deals with.
  for (const type of Object.keys(PROBLEM_DELETE_KIND)) {
    const words = PROBLEM_DELETE_WORDS[type];
    assert.match(words, /^the (document|message|queued message)/, `${type} is named as a row`);
    assert.doesNotMatch(words, /issue$/i);
  }
  // Dismiss is added to every issue row, whatever the type.
  assert.match(src('inbox.js'), /add\(box, aside\);/);
});

test('several records are chosen on a list - never inside a case or a conversation', () => {
  for (const file of ['inbox.js', 'search.js', 'shipments.js', 'chats.js']) {
    assert.match(src(file), /bulkSelection\(\{/, `${file} offers a selection`);
    // "Select all" is what the screen draws, never rows nobody has loaded.
    assert.match(src(file), /picked\.shownNow\(/, `${file} says what select all means`);
  }
  for (const file of ['case.js', 'conversation.js', 'viewer.js', 'settings.js']) {
    assert.doesNotMatch(src(file), /bulkSelection/, `${file} deletes one record at a time`);
  }
  // A reference cannot be typed for twenty records, so the count is.
  const del = src('delete.js');
  assert.match(del, /the number of records/);
  assert.match(del, /action: 'delete_records'/);
});

// ---------------------------------------------------------------------------
// Shipments (section 9): saved is not notified, and sent is not delivered
// ---------------------------------------------------------------------------

test('a shipment is deleted from the list as well as from inside it', () => {
  // Reported as "I cannot delete a shipment": the bin was only in the
  // shipment's own header, so you had to open one to find it.
  const ship = src('shipments.js');
  assert.match(ship, /class: 'cell-actions' \}, deleteBin\(\{/, 'every row of the list has the bin, in a cell of its own');
  assert.match(ship, /class: 'cell-actions' \}, picked\.box\(/, 'and a box, for taking several at once');
  assert.ok(ship.includes("kind: 'shipment', reference: s.shipment_id, name: s.shipment_id"),
    'and the shipment’s own header keeps its Delete');
  // The row is one stretched link, so a control in it has to sit above.
  assert.match(rule('.cell-actions'), /z-index/);
});

test('after saving a shipment update the desk says whether the customer was notified - and never that it was delivered', async () => {
  const { savedWords, notifyLabel } = await import('../public/desk/shipments.js');
  assert.deepEqual(savedWords({ unchanged: true }, true), ['Nothing changed, so nothing was saved.', 'info']);
  assert.deepEqual(savedWords({ ok: true }, false), ['Update saved. The customer was not notified.', 'ok']);
  const [sent, sentTone] = savedWords({ ok: true, customer_told: { ok: true, status: 'sent' } }, true);
  assert.equal(sentTone, 'ok');
  assert.match(sent, /^Update saved; notification sent\./);
  assert.match(sent, /not proof it was delivered or read/);
  assert.deepEqual(savedWords({ ok: true, customer_told: { ok: true, status: 'queued' } }, true),
    ['Update saved; the notification is waiting to be sent. It will be tried again automatically.', 'info']);
  assert.deepEqual(savedWords({ ok: true, customer_told: { ok: false, status: 'needs_template', words: 'WhatsApp needs a template.' } }, true),
    ['Update saved; notification failed: WhatsApp needs a template.', 'bad']);
  assert.deepEqual(savedWords({ ok: true, customer_told: null }, true), ['Update saved; notification failed: there is no chat to send it to.', 'bad']);

  assert.equal(notifyLabel({ channel: 'whatsapp', language: 'ar' }), 'Notify customer on WhatsApp, in Arabic');
  assert.equal(notifyLabel({ channel: 'telegram', language: null }), 'Notify customer on Telegram, in Arabic and English');
  assert.equal(notifyLabel({ channel: null }), 'Notify customer (no chat linked, so it cannot be sent)');
  assert.match(src('shipments.js'), /'Save update and notify customer'/);
});

// ---------------------------------------------------------------------------
// Settings (section 10): the brief's five groups, who changed what, and
// nothing typed is lost by walking away
// ---------------------------------------------------------------------------

test('Settings has the groups the brief names, and each says who last changed it', async () => {
  const s = await import('../public/desk/settings.js');
  // The brief's five, the glossary, and what an administrator deleted - which
  // is on this page because putting something back is an administrator's job.
  assert.deepEqual(s.SECTIONS.map(([, label]) => label),
    ['Team and access', 'Office hours and contact numbers', 'Required documents', 'WhatsApp messaging', 'Saved replies',
      'Recently deleted', 'Glossary']);
  const changed = { a: { by: 'Sara', at: '2026-10-08T10:00:00Z' }, b: { by: 'Omar', at: '2026-10-09T09:00:00Z' }, c: null };
  assert.deepEqual(s.lastChange(changed, ['a', 'b', 'c']), { by: 'Omar', at: '2026-10-09T09:00:00Z' });
  assert.equal(s.lastChange(changed, ['c']), null);
  assert.equal(s.lastChange({}, ['x']), null);
  // Every group that saves settings knows its keys.
  assert.deepEqual(Object.keys(s.SECTION_KEYS), ['hours', 'docs', 'whatsapp', 'replies']);
});

test('unsaved edits are protected when leaving: the desk asks first, naming what would be lost', () => {
  assert.equal(ui.unsavedWords([]), null);
  assert.equal(ui.unsavedWords(['Saved replies']), 'You have unsaved changes in Saved replies. Leave without saving them?');
  assert.equal(ui.unsavedWords(['Team and access', 'Saved replies']),
    'You have unsaved changes in Team and access and Saved replies. Leave without saving them?');
  assert.match(src('app.js'), /unsaved\?\.\(\)/, 'the router asks the screen before leaving it');
  assert.match(src('app.js'), /beforeunload/, 'and the browser asks before the tab closes');
  assert.match(src('settings.js'), /unsaved:/, 'Settings says what is unsaved');
});

// ---------------------------------------------------------------------------
// The words of the trade (section 5): one place, shown where they appear
// ---------------------------------------------------------------------------

test('the glossary says what each document term means, in one place the owner can edit', async () => {
  const { GLOSSARY, termFor } = await import('../public/desk/glossary.js');
  assert.deepEqual(Object.keys(GLOSSARY), ['vin', 'mrn', 'acid', 'eur1', 'cmr', 'brief']);
  assert.match(GLOSSARY.vin.text, /^The vehicle’s unique identification number/);
  assert.match(GLOSSARY.vin.text, /17-character chassis number/);
  assert.match(GLOSSARY.mrn.text, /Movement Reference Number of the EU export declaration/);
  assert.match(GLOSSARY.acid.text, /Egypt’s Advance Cargo Information Declaration, registered on Nafeza before shipping/);
  assert.match(GLOSSARY.eur1.text, /movement certificate proving EU origin for preferential duty/);
  assert.match(GLOSSARY.cmr.text, /international road consignment note/);
  for (const [k, g] of Object.entries(GLOSSARY)) {
    assert.ok(g.term && g.text.length < 140, `${k}: a term and one short line`);
    assert.doesNotMatch(g.text, /must|required|law|legal/i, `${k}: no legal requirement is claimed`);
  }
  // The document types and read fields the desk shows, mapped to their entry.
  assert.deepEqual(['vin', 'mrn', 'acid', 'eur1', 'brief', 'invoice'].map(termFor), ['vin', 'mrn', 'acid', 'eur1', 'brief', null]);
});

test('a difference is named specifically: the chassis number on this invoice differs from the booking', () => {
  const { mismatchWords } = viewer;
  assert.deepEqual(mismatchWords({ label: 'Invoice', checks: [
    { field: 'vin', label: 'Chassis', document: 'YV2RT40A8FB799999', booking: 'YV2RT40A8FB712905', match: false },
    { field: 'make', label: 'Make', document: 'VOLVO', booking: 'Volvo', match: true },
  ] }), ['The chassis number on this Invoice differs from the booking: the Invoice says YV2RT40A8FB799999, the booking says YV2RT40A8FB712905.']);
  assert.deepEqual(mismatchWords({ label: 'EUR.1', checks: [
    { field: 'mrn', label: 'MRN', document: '26LT1', booking: '26LT2', against: 'the MRN declaration', match: false },
  ] }), ['The MRN on this EUR.1 differs from the MRN declaration: the EUR.1 says 26LT1, the MRN declaration says 26LT2.']);
  assert.deepEqual(mismatchWords({ label: 'Invoice', checks: [] }), []);
});

test('an info dot sits beside each term where it appears, and the whole glossary is one menu away for everyone', () => {
  for (const file of ['case.js', 'viewer.js', 'settings.js']) assert.match(src(file), /infoDot\(/, `${file} explains its terms`);
  // Every role, every screen size: the account menu, not Settings (administrators only).
  assert.match(src('app.js'), /openGlossary/);
  assert.match(src('settings.js'), /glossaryList\(/, 'and Settings lists it too');
});

test('a file in a chat opens in the chat, a PDF the same way as a photo', () => {
  const convoSrc = src('conversation.js');
  // A paper the bot had read used to be sent straight to the case's document
  // viewer, and only a photo was spared it - which is why a customer's invoice
  // could not be looked at without leaving the conversation.
  assert.doesNotMatch(convoSrc, /f\.kind !== 'image'/, 'no kind is diverted out of the conversation');
  assert.match(convoSrc, /openFilePreview\(\{/, 'the chat opens its own preview');
  // The one exception, and the reason it is safe: a kind the preview cannot
  // show at all still has the viewer, and so has a paper being checked.
  assert.match(convoSrc, /openPaper\(f\.paper\.id\)/);
  assert.match(src('viewer.js'), /btn-primary'.*'Open in the document viewer'/,
    'and from the preview, the way to the two decisions is the primary button');
});

// ---------------------------------------------------------------------------
// Printing a document
// ---------------------------------------------------------------------------

test('any file the desk shows can be printed, and it is the paper that prints, not the desk', () => {
  // Both places a file is shown: the document viewer where a paper is checked
  // and verified, and the preview the chat opens.
  const viewerSrc = src('viewer.js');
  assert.equal((viewerSrc.match(/printButton\(/g) ?? []).length, 3,
    'declared once, offered on both the document viewer and the file preview');
  // The frame's own window, never the desk's: window.print() here would print
  // the sidebar, the chat and the panel with the paper lost in the middle.
  assert.ok(/contentWindow/.test(viewerSrc), 'the frame holding the file is what prints');
  assert.ok(!/\bwindow\.print\(/.test(viewerSrc), 'never the desk\'s own print');
  assert.ok(/createObjectURL/.test(viewerSrc), 'the file on this origin, so a frame may be asked to print it');
});

test('the frame a document prints from is rendered - a hidden one has nothing to print', () => {
  const frame = rule('.print-frame');
  assert.ok(frame, '.print-frame has a rule of its own');
  assert.doesNotMatch(frame, /display:\s*none/, 'display:none prints a blank page');
  assert.doesNotMatch(frame, /visibility:\s*hidden/);
  assert.match(frame, /position:\s*fixed/, 'and it is out of the way');
  assert.match(frame, /opacity:\s*0/);
});

test('every icon the desk asks for exists', () => {
  const named = new Set();
  for (const file of ['app.js', 'inbox.js', 'case.js', 'viewer.js', 'conversation.js', 'chats.js',
    'settings.js', 'shipments.js', 'search.js', 'preview.js', 'delete.js', 'account.js', 'glossary.js']) {
    for (const m of src(file).matchAll(/\bicon\('([a-zA-Z]+)'/g)) named.add(m[1]);
  }
  assert.ok(named.has('printer'), 'including the printer on the file bar');
  const missing = [...named].filter((name) => !ui.ICONS[name]);
  assert.deepEqual(missing, [], 'an icon that is not in the table draws nothing at all');
});

test('an MRN is recorded, not obtained, here - and approving is a different step from recording', () => {
  assert.match(caseMod.MRN_WORDS.record, /issued/);
  assert.match(caseMod.MRN_WORDS.record, /does not apply for it or obtain it/);
  assert.match(caseMod.MRN_WORDS.steps, /Approving the application and recording the issued MRN are separate steps/);
});

// ---------------------------------------------------------------------------
// The shipping label
// ---------------------------------------------------------------------------

test('the label is MKY’s own: their logo, their red and blue, and what a yard reads', () => {
  const label = readFileSync(path.join(DESK, '..', '..', 'api', 'admin', 'label.js'), 'utf8');

  // The head is drawn once, in lib/letterhead.js, and the label takes it from
  // there - which is why the colours are asserted on that file and not on this
  // one. Three near-copies of a letterhead is how they drift apart.
  const head = readFileSync(path.join(DESK, '..', '..', 'lib', 'letterhead.js'), 'utf8');
  assert.match(label, /from '\.\.\/\.\.\/lib\/letterhead\.js'/);
  assert.match(head, /const RED = '#c00000'/);
  assert.match(head, /const BLUE = '#0070c0'/);
  // Their actual logo, lifted from their own label and shipped as an asset.
  assert.ok(readFileSync(path.join(DESK, '..', '..', 'assets', 'mky-logo.png')).length > 1000, 'the logo is there to print');

  // The three lines in the order their label has them, and the reference alone.
  for (const field of [/MARKS :/, /CHASS\. N°/, /Delivery Instructions:/]) {
    assert.match(label, field);
  }
  // A4 landscape, as theirs is.
  assert.match(label, /layout: 'landscape'/);

  // And none of the internal checklist that used to be on it: a driver in the
  // rain does not need to know which documents are outstanding.
  assert.doesNotMatch(label, /DOCUMENTS/, 'the checklist belongs on the case page');
  assert.doesNotMatch(label, /INCOTERM|GROSS WEIGHT/);
});

test('everything MKY issues carries the same letterhead', () => {
  const root = path.join(DESK, '..', '..');
  const papers = {
    'the shipping label': 'api/admin/label.js',
    'the booking confirmation': 'lib/pdf.js',
    'the CMR and the MRN sheet': 'lib/mky-docs.js',
  };
  // One drawing of the head, imported by each of them: the badge and the red
  // band live in lib/letterhead.js and nowhere else.
  const head = readFileSync(path.join(root, 'lib', 'letterhead.js'), 'utf8');
  assert.match(head, /mky-logo\.png/, 'the letterhead carries the badge');

  for (const [what, file] of Object.entries(papers)) {
    const src = readFileSync(path.join(root, file), 'utf8');
    assert.match(src, /letterhead/, `${what} draws MKY's letterhead`);
    // Their two colours, not the desk's old blue.
    assert.ok(/#0070c0|#c00000|#d80b00|letterhead/i.test(src), `${what} is in their colours`);
    assert.doesNotMatch(src, /#0b4a6f/, `${what} has left the old blue behind`);
  }
});
