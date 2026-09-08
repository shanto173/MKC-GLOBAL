/**
 * The pinned status card.
 *
 * The card is the first thing a customer sees when they open the chat, so a
 * stale one is worse than none: it advertises a booking that is over. These
 * tests pin down when it is taken away and - just as important - when it is
 * left alone, because the customer may have pinned something of their own.
 *
 * Telegram and the database are stubbed at the module boundary. A module mock
 * can only be registered once per process, so both stubs read from `state`,
 * which each test sets before it calls in.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const CHAT = '555';

/** What the stubs will answer with, and what they were asked. */
const state = {
  shipments: [],
  bookings: [],
  pinned: null,
  calls: [],
};

const record = (name) => async (...args) => { state.calls.push(name); return { ok: true }; };

mock.module('../lib/telegram.js', {
  namedExports: {
    sendMessage: async () => { state.calls.push('sendMessage'); return { ok: true, result: { message_id: 7 } }; },
    editMessage: record('editMessage'),
    pinMessage: record('pinMessage'),
    unpinMessage: record('unpinMessage'),
    unpinAll: record('unpinAll'),
    deleteMessageQuietly: record('deleteMessageQuietly'),
    pinnedMessage: async () => state.pinned,
  },
});

mock.module('../lib/config.js', {
  namedExports: {
    config: { telegram: { token: 'test-token' } },
    DESTINATION_PORTS: [],
  },
});

// Just enough of the query builder for activeItems: every call returns the
// builder until it is awaited, and the rows depend on the table it started on.
mock.module('../lib/supabase.js', {
  namedExports: {
    db: () => ({
      from(table) {
        const rows = table === 'shipments' ? state.shipments : state.bookings;
        const builder = {
          select: () => builder,
          eq: () => builder,
          in: () => builder,
          order: () => builder,
          limit: () => builder,
          then: (resolve) => Promise.resolve({ data: rows, error: null }).then(resolve),
        };
        return builder;
      },
    }),
  },
});

const { refreshPin, activeItems } = await import('../lib/pinned.js');

/** Resets the recorded calls and sets what this case is about. */
function given({ shipments = [], bookings = [], pinned = null } = {}) {
  state.shipments = shipments;
  state.bookings = bookings;
  state.pinned = pinned;
  state.calls = [];
}

const SHIPMENT = {
  shipment_id: 'MKY-26001', booking_ref: 'MKY-BKG-1', make: 'MAN', model: 'TGX',
  status: 'In transit', vessel: 'MSC Aurora', eta: '2026-09-20',
  origin_port: 'Hamburg', destination_port: 'Port Said', delivery_status: null,
};

test('nothing in flight and nothing pinned: the chat is cleared anyway', async () => {
  // getChat reporting no pin is not proof the customer sees no pin - the bar
  // outlives the message often enough that a booking removed outside the flow
  // left a card at the top advertising it. Nothing of theirs is at risk when
  // Telegram itself says the chat has no pin.
  given({ pinned: null });
  const r = await refreshPin(CHAT);

  assert.equal(r.action, 'cleared');
  assert.deepEqual(state.calls, ['unpinAll']);
});

test("nothing in flight but the customer's own message is pinned: leave it", async () => {
  given({ pinned: { messageId: 3, mine: false, text: 'my own note' } });
  const r = await refreshPin(CHAT);

  assert.equal(r.action, 'none');
  assert.deepEqual(state.calls, []);
});

test('nothing in flight and our own card is pinned: unpin, delete, clear', async () => {
  given({ pinned: { messageId: 3, mine: true, text: '📌 status' } });
  const r = await refreshPin(CHAT);

  assert.equal(r.action, 'cleared');
  assert.deepEqual(state.calls, ['unpinMessage', 'deleteMessageQuietly', 'unpinAll']);
});

test('a bot message that is not our card is not deleted', async () => {
  // Our own confirmations come from the bot too. Only the card starts with the
  // pin glyph, and only the card may be removed.
  given({ pinned: { messageId: 3, mine: true, text: '🎉 Your booking is confirmed!' } });
  const r = await refreshPin(CHAT);

  assert.equal(r.action, 'none');
  assert.equal(state.calls.includes('deleteMessageQuietly'), false);
});

test('something in flight and no card yet: one is pinned', async () => {
  given({ shipments: [SHIPMENT], pinned: null });
  const r = await refreshPin(CHAT);

  assert.equal(r.action, 'pinned');
  assert.equal(r.ref, 'MKY-26001');
  assert.deepEqual(state.calls, ['sendMessage', 'pinMessage']);
});

test('something in flight and our card already there: it is edited in place', async () => {
  // Editing rather than re-pinning is the point: no new message, and no "the
  // bot pinned a message" line every time the shipment moves.
  given({ shipments: [SHIPMENT], pinned: { messageId: 3, mine: true, text: '📌 old' } });
  const r = await refreshPin(CHAT);

  assert.equal(r.action, 'edited');
  assert.deepEqual(state.calls, ['editMessage']);
});

test('a delivered shipment stops counting as in flight', async () => {
  given({ shipments: [{ ...SHIPMENT, delivery_status: 'Complete' }] });
  assert.deepEqual(await activeItems(CHAT), []);
});

test('a booking that already has a shipment is not listed twice', async () => {
  given({
    shipments: [SHIPMENT],
    bookings: [{ booking_ref: 'MKY-BKG-1', make: 'MAN', status: 'confirmed', origin_port: 'Hamburg', destination_port: 'Port Said' }],
  });
  const rows = await activeItems(CHAT);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'shipment');
});

test('a channel that is not telegram is never touched', async () => {
  given({ pinned: null });
  const r = await refreshPin(CHAT, { channel: 'whatsapp' });

  assert.equal(r.action, 'none');
  assert.deepEqual(state.calls, []);
});
