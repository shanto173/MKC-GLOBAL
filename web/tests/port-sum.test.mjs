/**
 * Port Sum Up inclusion and Team MKY @mention parsing — pure helpers, no DB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPortSumRow, parseMentions, mentionCandidates, mentionTokens, FUNDS_KEYS,
} from '../lib/admin/desk-port-sum.js';
const look = await import('../public/desk/port-sum.js');

test('a row needs from-port, to-port and VIN; cancelled stays out', () => {
  assert.equal(isPortSumRow({
    vin: 'S2936820JL', origin_port: 'Hamburg', destination_port: 'Alexandria', status: 'draft',
  }), true);
  assert.equal(isPortSumRow({
    vin: 'S2936820JL', origin_port: 'Hamburg', destination_port: 'Alexandria', status: 'pending_review',
  }), true);
  assert.equal(isPortSumRow({
    vin: '', origin_port: 'Hamburg', destination_port: 'Alexandria', status: 'draft',
  }), false);
  assert.equal(isPortSumRow({
    vin: 'S2936820JL', origin_port: 'Hamburg', destination_port: 'Alexandria', status: 'cancelled',
  }), false);
});

test('@mentions prefer the longest label and keep start/end for links', () => {
  const candidates = [
    { booking_ref: 'B1', label: 'John' },
    { booking_ref: 'B2', label: 'John Doe' },
    { booking_ref: 'B3', label: 'S2936820JL' },
  ];
  const hits = parseMentions('Please check @John Doe and @S2936820JL today', candidates);
  assert.deepEqual(hits.map((h) => h.booking_ref), ['B2', 'B3']);
  assert.equal(hits[0].label, 'John Doe');
  assert.equal(hits[1].label, 'S2936820JL');
});

test('mention candidates expose both customer name and VIN', () => {
  const tags = mentionCandidates([{
    booking_ref: 'B1', customer_name: 'John Doe', vin: 'S2936820JL',
    origin_port: 'Hamburg', destination_port: 'Alexandria Port', status: 'draft',
  }]);
  assert.deepEqual(tags.map((t) => t.label).sort(), ['John Doe', 'S2936820JL']);
});

test('funds statuses are the three the desk offers', () => {
  assert.deepEqual(FUNDS_KEYS, ['not_received', 'received', 'in_process']);
});

// ---------------------------------------------------------------------------
// What a message asks the database about
//
// Team MKY used to read five hundred orders on every message sent, to find
// out which of them a "@" named. It now asks about the words after each "@"
// and nothing else, so the work is the message's size, not the desk's.
// ---------------------------------------------------------------------------

test('a message asks about the words after each @, longest last', () => {
  assert.deepEqual(mentionTokens('Please check @John Doe today'),
    ['John', 'John Doe', 'John Doe today']);
  assert.deepEqual(mentionTokens('@S2936820JL'), ['S2936820JL']);
  assert.deepEqual(mentionTokens('nothing tagged here'), []);
});

test('the same tag twice is asked about once, and a tag stops at the next one', () => {
  // The second "@" ends the first one's words: "@John and" is a question
  // worth asking, "@John and @John again" is not.
  assert.deepEqual(mentionTokens('@John and @John again'), ['John', 'John and', 'John again']);
});

test('a name keeps its spaces and loses the punctuation after it', () => {
  // "@John Doe, please" names John Doe: the comma ends the name, and the
  // three words with a comma in the middle of them are not asked about.
  assert.deepEqual(mentionTokens('ask @John Doe, please'), ['John', 'John Doe']);
});

test('a token that would be read as or() syntax is left out, and the count is capped', () => {
  // A comma, a bracket or a wildcard cannot be put in an or() filter safely.
  assert.deepEqual(mentionTokens('@a(b) @c%d'), []);
  assert.equal(mentionTokens(`@${'w '.repeat(40)}`, { max: 5 }).length, 5);
  assert.equal(mentionTokens('@one two three four five six seven eight').length, 6);
});

// ---------------------------------------------------------------------------
// What the list says when it has nothing to show
// ---------------------------------------------------------------------------

test('an empty list says why it is empty', () => {
  assert.match(look.emptyWords('hamburg', 'all', 'any')[0], /No order matches that/);
  assert.match(look.emptyWords('', 'mine', 'any')[0], /Nothing is assigned to you/);
  assert.match(look.emptyWords('', 'all', 'received')[0], /"Received"/);
  assert.match(look.emptyWords('', 'all', 'any')[1], /both ports and a chassis/);
});

test('an amount reads as a person writes one', () => {
  assert.equal(look.amountWords(1200), '1,200');
  assert.equal(look.amountWords('1200.5'), '1,200.5');
  assert.equal(look.amountWords(null), '');
});
