/**
 * The status card pinned to the top of a customer's chat.
 *
 * Customers were asking "where is it?" every day or two, and every answer cost
 * a model call and their patience. Telegram will not let a bot change the chat
 * header - that belongs to Telegram - but it will let a bot pin one message and
 * edit that same message afterwards, which sits in the same place and reads the
 * same way.
 *
 * So there is one card per chat, it is edited in place as the shipment moves,
 * and it disappears when there is nothing to follow: delivered, rejected or
 * cancelled. The next booking brings it back.
 *
 * The message id is not stored anywhere. Telegram already knows what is pinned
 * in a chat, and asking it is one call - a second copy in our database would
 * only be something else to get out of step.
 */

import { db } from './supabase.js';
import { pinnedCard } from './format.js';
import {
  sendMessage, editMessage, pinMessage, unpinMessage, pinnedMessage, deleteMessageQuietly,
} from './telegram.js';
import { config } from './config.js';

/** How many shipments fit on a pinned card before it becomes a wall of text. */
const MAX_ROWS = 3;

/**
 * What this customer currently has in flight: shipments that have not been
 * delivered, and bookings that have not yet become shipments.
 */
export async function activeItems(chatId) {
  const chat = String(chatId);

  // Delivered shipments are read too, not filtered out in the query: a booking
  // whose shipment has arrived must not reappear on the card as if it were
  // still waiting. Asking only for the open ones left exactly that hole.
  const { data: allShipments } = await db()
    .from('shipments')
    .select('shipment_id, booking_ref, make, model, status, vessel, eta, delivery_status, origin_port, destination_port, updated_at')
    .eq('chat_id', chat)
    .order('updated_at', { ascending: false })
    .limit(30);

  // Either field can carry the news: an operator moving the milestone to
  // Delivered is saying the same thing as delivery_status Complete, and a card
  // that keeps following a delivered truck is worse than no card.
  const done = (s) => s.delivery_status === 'Complete' || s.status === 'Delivered';
  const shipments = (allShipments ?? []).filter((s) => !done(s));

  const { data: bookings } = await db()
    .from('bookings')
    .select('booking_ref, make, model, status, origin_port, destination_port, created_at')
    .eq('chat_id', chat)
    .in('status', ['pending_review', 'confirmed'])
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS + 1);

  // A booking that already has a shipment is the same vehicle twice; the
  // shipment is the one that moves, so it wins.
  const shipped = new Set((allShipments ?? []).map((s) => s.booking_ref).filter(Boolean));

  const rows = [
    ...shipments.slice(0, MAX_ROWS + 1).map((s) => ({
      kind: 'shipment',
      ref: s.shipment_id,
      vehicle: [s.make, s.model].filter(Boolean).join(' '),
      status: s.status,
      vessel: s.vessel,
      eta: s.eta,
      route: `${s.origin_port} → ${s.destination_port}`,
    })),
    ...(bookings ?? [])
      .filter((b) => !shipped.has(b.booking_ref))
      .map((b) => ({
        kind: 'booking',
        ref: b.booking_ref,
        vehicle: [b.make, b.model].filter(Boolean).join(' '),
        status: b.status === 'confirmed' ? 'Confirmed - opening shipment' : 'Awaiting confirmation',
        route: `${b.origin_port} → ${b.destination_port}`,
      })),
  ];

  return rows;
}

/**
 * Brings the pinned card in line with what the customer actually has.
 *
 * @returns {Promise<{action: 'edited'|'pinned'|'cleared'|'none', ref?: string}>}
 */
export async function refreshPin(chatId, { channel = 'telegram' } = {}) {
  if (channel !== 'telegram' || !chatId || !config.telegram.token) return { action: 'none' };

  const rows = await activeItems(chatId);
  const current = await pinnedMessage(chatId);

  // Nothing in flight: the last shipment was delivered, or the booking was
  // turned down. Take the card away rather than leave a stale one at the top.
  if (!rows.length) {
    if (current?.mine && isOurCard(current.text)) {
      await unpinMessage(chatId, current.messageId);
      await deleteMessageQuietly(chatId, current.messageId);
      return { action: 'cleared' };
    }
    return { action: 'none' };
  }

  const text = pinnedCard(rows.slice(0, MAX_ROWS), rows.length - MAX_ROWS);

  // Editing keeps the card in the same place, with no new message and no "the
  // bot pinned a message" line each time something moves.
  if (current?.mine && isOurCard(current.text)) {
    const edited = await editMessage(chatId, current.messageId, text);
    if (edited.ok) return { action: 'edited', ref: rows[0].ref };
    // Too old to edit, or gone. Fall through and pin a new one.
    await unpinMessage(chatId, current.messageId);
  }

  const sent = await sendMessage(chatId, text, { returnMessage: true });
  const messageId = sent?.result?.message_id;
  if (!messageId) return { action: 'none' };
  await pinMessage(chatId, messageId);
  return { action: 'pinned', ref: rows[0].ref };
}

/**
 * Is the pinned message one of ours? The customer may have pinned something of
 * their own, and replacing that would be rude.
 */
function isOurCard(text) {
  return String(text ?? '').startsWith('📌');
}

/** Never let a pinned card break the thing that triggered it. */
export async function refreshPinSafely(chatId, options) {
  try {
    return await refreshPin(chatId, options);
  } catch (err) {
    console.error('pinned status refresh failed:', err.message);
    return { action: 'none', error: err.message };
  }
}
