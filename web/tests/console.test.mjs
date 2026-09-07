/**
 * The operations console's decisions.
 *
 * The console draws what this module says and the server enforces what this
 * module says, so these tests are the specification for both. They run with no
 * network and no database: readiness and the next action are pure functions of
 * a booking row, which is the whole reason an operator can be told the same
 * thing twice in a row.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUS, OPEN_STATUSES, statusLabel, statusTone, whoseTurn, canTransition,
  readiness, nextAction, availableActions, humanAge, slaBreach, priorityRank,
} from '../lib/ops/workflow.js';

const BASE = {
  booking_ref: 'MKY-BKG-260908-A1',
  status: 'pending_review',
  vin: 'YV2RT40A8FB712905',
  make: 'Volvo',
  customer_name: 'Delta Trans Egypt',
  origin_port: 'Klaipeda',
  destination_port: 'Port Said',
  mrn_choice: 'existing',
  priority: 'normal',
};

const DOCS = (received = [], verified = []) => ({
  required: ['invoice', 'brief', 'mrn'],
  received_types: received,
  verified_types: verified,
  missing: ['invoice', 'brief', 'mrn'].filter((t) => !received.includes(t)),
});

const ALL_DOCS = DOCS(['invoice', 'brief', 'mrn'], ['invoice', 'brief', 'mrn']);

// ---------------------------------------------------------------------------
// Status model
// ---------------------------------------------------------------------------

test('every status has a readable label, a group and an owner', () => {
  for (const [key, def] of Object.entries(STATUS)) {
    assert.ok(def.label && def.label !== key, `${key} needs a human label`);
    assert.doesNotMatch(def.label, /_/, `${key} label leaks the database value`);
    assert.ok(['inbox', 'active', 'waiting', 'done'].includes(def.group), key);
    assert.ok(['ops', 'client', 'none'].includes(def.owner), key);
  }
});

test('whose turn it is separates our work from the client\'s', () => {
  assert.equal(whoseTurn({ status: 'pending_review' }), 'ops');
  assert.equal(whoseTurn({ status: 'under_review' }), 'ops');
  assert.equal(whoseTurn({ status: 'needs_client_action' }), 'client');
  assert.equal(whoseTurn({ status: 'confirmed' }), 'none');
});

test('a finished request cannot be moved anywhere', () => {
  for (const done of ['confirmed', 'rejected', 'cancelled', 'expired']) {
    for (const to of OPEN_STATUSES) {
      assert.equal(canTransition(done, to), false, `${done} -> ${to} must be refused`);
    }
  }
});

test('the legal moves are the ones the desk actually makes', () => {
  assert.equal(canTransition('pending_review', 'under_review'), true);
  assert.equal(canTransition('under_review', 'needs_client_action'), true);
  assert.equal(canTransition('needs_client_action', 'under_review'), true);
  assert.equal(canTransition('pending_review', 'confirmed'), true);
  assert.equal(canTransition('draft', 'under_review'), false, 'a draft is not ours to review');
});

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

test('readiness lists everything and blocks on what is missing', () => {
  const r = readiness(BASE, DOCS(['invoice']));
  assert.equal(r.complete, false);
  assert.ok(r.blocking.includes('doc:brief'));
  assert.ok(r.blocking.includes('doc:mrn'));
  assert.ok(!r.blocking.includes('doc:invoice'));

  // The booking reference and the confirmation are shown but never block: they
  // are what Operations is about to do, not what it is waiting for.
  assert.ok(!r.blocking.includes('booking_ref'));
  assert.ok(!r.blocking.includes('confirmation'));
});

test('a received but unchecked document does not block, and says so', () => {
  const r = readiness(BASE, DOCS(['invoice', 'brief', 'mrn'], ['invoice']));
  assert.equal(r.complete, true);
  const brief = r.items.find((i) => i.key === 'doc:brief');
  assert.equal(brief.ok, true);
  assert.equal(brief.note, 'not verified yet');
});

/** When MKY obtains the MRN the client is not asked for one. */
const MKY_DOCS = (received, verified) => ({
  required: ['invoice', 'brief'],
  received_types: received,
  verified_types: verified,
  missing: ['invoice', 'brief'].filter((t) => !received.includes(t)),
});

test('the MRN line appears only when MKY is the one obtaining it', () => {
  const client = readiness(BASE, ALL_DOCS);
  assert.equal(client.items.some((i) => i.key === 'mrn'), false);

  const mky = readiness({ ...BASE, mrn_choice: 'mky_issue' }, MKY_DOCS(['invoice', 'brief'], ['invoice', 'brief']));
  const line = mky.items.find((i) => i.key === 'mrn');
  assert.ok(line);
  assert.equal(line.ok, false);
  assert.equal(mky.complete, false);
});

test('an issued MRN completes the booking', () => {
  const r = readiness(
    { ...BASE, mrn_choice: 'mky_issue', mrn_number: '26LTVR610172694233' },
    MKY_DOCS(['invoice', 'brief'], ['invoice', 'brief']),
  );
  assert.equal(r.complete, true);
});

// ---------------------------------------------------------------------------
// The next action
// ---------------------------------------------------------------------------

test('missing basics come before missing documents', () => {
  const n = nextAction({ ...BASE, make: null }, DOCS([]));
  assert.equal(n.code, 'REVIEW_INFORMATION');
  assert.equal(n.owner, 'ops');
  assert.match(n.detail, /Vehicle make/);
});

test('missing documents ask the client, once', () => {
  const n = nextAction(BASE, DOCS(['invoice']));
  assert.equal(n.code, 'REQUEST_DOCUMENTS');
  assert.equal(n.owner, 'ops');
  assert.match(n.detail, /Brief/);
});

test('once asked, the same gap is the client\'s turn, not ours', () => {
  const n = nextAction({ ...BASE, status: 'needs_client_action' }, DOCS(['invoice']));
  assert.equal(n.code, 'WAIT_CLIENT');
  assert.equal(n.owner, 'client', 'the desk must not be shown as late for this');
});

test('MKY-issued MRN becomes the next action once the papers are in', () => {
  const n = nextAction({ ...BASE, mrn_choice: 'mky_issue' }, MKY_DOCS(['invoice', 'brief'], ['invoice', 'brief']));
  assert.equal(n.code, 'PROCESS_MRN');
  assert.equal(n.action, 'process_mrn');
});

test('everything in and no reference yet means create the booking', () => {
  const n = nextAction({ ...BASE, status: 'under_review', booking_ref: '' }, ALL_DOCS);
  assert.equal(n.code, 'CREATE_BOOKING');
});

test('a reference and nothing outstanding means confirm', () => {
  const n = nextAction({ ...BASE, status: 'under_review' }, ALL_DOCS);
  assert.equal(n.code, 'CONFIRM_BOOKING');
  assert.equal(n.owner, 'ops');
});

test('a confirmed booking has nothing outstanding', () => {
  const n = nextAction({ ...BASE, status: 'confirmed' }, ALL_DOCS);
  assert.equal(n.code, 'NONE');
  assert.equal(n.owner, 'none');
  assert.equal(n.action, null);
});

test('the next action is the same every time it is asked', () => {
  const a = nextAction(BASE, DOCS(['invoice']));
  const b = nextAction(BASE, DOCS(['invoice']));
  assert.deepEqual(a, b, 'no randomness, no model, no drift');
});

// ---------------------------------------------------------------------------
// Which buttons exist
// ---------------------------------------------------------------------------

test('Confirm is not offered while anything blocking is missing', () => {
  const ready = readiness(BASE, DOCS(['invoice']));
  const actions = availableActions(BASE, ready);
  assert.ok(!actions.includes('confirm_booking'), 'an incomplete booking must not offer Confirm');
  assert.ok(!actions.includes('create_booking'));
  assert.ok(actions.includes('request_info'));
});

test('Confirm appears exactly when the booking is complete', () => {
  const ready = readiness({ ...BASE, status: 'under_review' }, ALL_DOCS);
  const actions = availableActions({ ...BASE, status: 'under_review' }, ready);
  assert.ok(actions.includes('confirm_booking'));
});

test('a confirmed booking offers shipment work and nothing else', () => {
  const actions = availableActions({ ...BASE, status: 'confirmed' }, readiness(BASE, ALL_DOCS));
  assert.deepEqual(actions, ['view_shipment', 'update_shipment']);
});

test('a cancelled request offers nothing at all', () => {
  assert.deepEqual(availableActions({ ...BASE, status: 'cancelled' }, null), []);
});

// ---------------------------------------------------------------------------
// Ageing and SLA
// ---------------------------------------------------------------------------

test('ages read the way a person says them', () => {
  const now = Date.now();
  assert.equal(humanAge(now - 30_000, now), 'just now');
  assert.equal(humanAge(now - 18 * 60_000, now), '18 min');
  assert.equal(humanAge(now - 84 * 60_000, now), '1h 24m');
  assert.equal(humanAge(now - 6 * 3600_000, now), '6h');
  assert.equal(humanAge(now - 2 * 86400_000, now), '2d');
  assert.equal(humanAge(null), '—');
});

test('a request waiting on the CLIENT is never counted against the desk', () => {
  const now = Date.now();
  const waiting = {
    status: 'needs_client_action',
    status_changed_at: new Date(now - 40 * 3600_000).toISOString(),
  };
  assert.equal(slaBreach(waiting, { new_request_hours: 2, review_hours: 4 }, now), null,
    'forty hours on the client is not the desk being late');
});

test('a new request past its threshold is overdue', () => {
  const now = Date.now();
  const late = { status: 'pending_review', status_changed_at: new Date(now - 5 * 3600_000).toISOString() };
  const breach = slaBreach(late, { new_request_hours: 2 }, now);
  assert.ok(breach);
  assert.equal(breach.hours, 2);
});

test('with no threshold configured nothing is called overdue', () => {
  const now = Date.now();
  const old = { status: 'pending_review', status_changed_at: new Date(now - 200 * 3600_000).toISOString() };
  assert.equal(slaBreach(old, {}, now), null, 'we do not invent MKY\'s service levels');
});

test('urgent sorts before high, high before normal', () => {
  assert.ok(priorityRank('urgent') < priorityRank('high'));
  assert.ok(priorityRank('high') < priorityRank('normal'));
  assert.equal(priorityRank(undefined), priorityRank('normal'));
});

// ---------------------------------------------------------------------------
// The workflow from section 84, start to finish
// ---------------------------------------------------------------------------

test('the whole roadmap scenario, step by step', () => {
  // A request arrives: invoice and brief sent, MKY to obtain the MRN.
  let booking = { ...BASE, status: 'pending_review', mrn_choice: 'mky_issue', booking_ref: '' };
  let docs = MKY_DOCS(['invoice', 'brief'], []);

  let n = nextAction(booking, docs, { status: 'submitted', request_ref: 'MKY-MRN-1' });
  assert.equal(n.code, 'REVIEW_DOCUMENTS', 'first: somebody checks what arrived');

  // Documents checked.
  docs = { ...docs, verified_types: ['invoice', 'brief'] };
  booking = { ...booking, status: 'under_review' };
  n = nextAction(booking, docs, { status: 'submitted', request_ref: 'MKY-MRN-1' });
  assert.equal(n.code, 'PROCESS_MRN', 'then: the MRN');

  // MRN issued.
  booking = { ...booking, mrn_number: '26LTVR610172694233' };
  n = nextAction(booking, docs, { status: 'issued' });
  assert.equal(n.code, 'CREATE_BOOKING', 'then: record the reference');

  // Reference recorded.
  booking = { ...booking, booking_ref: 'MKY-2026-00123' };
  n = nextAction(booking, docs, { status: 'issued' });
  assert.equal(n.code, 'CONFIRM_BOOKING', 'then: confirm');

  // Confirmed.
  booking = { ...booking, status: 'confirmed' };
  n = nextAction(booking, docs, { status: 'issued' });
  assert.equal(n.code, 'NONE', 'and then nothing is outstanding');
  assert.equal(readiness(booking, docs, { status: 'issued' }).complete, true);
});

test('the missing-document scenario, including the client coming back', () => {
  // Invoice and MRN in, brief missing.
  let booking = { ...BASE, status: 'pending_review' };
  let docs = DOCS(['invoice', 'mrn']);

  let n = nextAction(booking, docs);
  assert.equal(n.code, 'REQUEST_DOCUMENTS');
  assert.match(n.detail, /Brief/);

  // Asked. Now it is the client's move and the desk should stop looking.
  booking = { ...booking, status: 'needs_client_action' };
  n = nextAction(booking, docs);
  assert.equal(n.owner, 'client');

  // The client sends it; the flow reopens the request. The brief that just
  // arrived has not been looked at, so checking it - not confirming - is what
  // comes next. That is the point of received and verified being different.
  booking = { ...booking, status: 'under_review' };
  docs = DOCS(['invoice', 'mrn', 'brief'], ['invoice', 'mrn']);
  n = nextAction(booking, docs);
  assert.equal(n.owner, 'ops', 'it is back with the desk');
  assert.equal(n.code, 'REVIEW_DOCUMENTS');
  assert.match(n.detail, /Brief/);

  // Checked. Now it can be confirmed.
  docs = DOCS(['invoice', 'mrn', 'brief'], ['invoice', 'mrn', 'brief']);
  n = nextAction(booking, docs);
  assert.equal(n.code, 'CONFIRM_BOOKING');
});
