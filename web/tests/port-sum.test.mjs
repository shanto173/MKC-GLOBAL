/**
 * Port Sum Up inclusion and Team MKY @mention parsing — pure helpers, no DB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPortSumRow, parseMentions, mentionCandidates, FUNDS_KEYS,
} from '../lib/admin/desk-port-sum.js';

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
