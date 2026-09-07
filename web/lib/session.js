/**
 * Conversation memory, stored in Supabase so it survives serverless cold starts.
 * Only plain user/assistant turns are kept - tool traffic is transient.
 */

import { db } from './supabase.js';

const MAX_TURNS = 16; // 8 exchanges

export function sessionId(channel, chatId) {
  return `${channel}:${chatId}`;
}

export async function loadHistory(channel, chatId) {
  const { data, error } = await db()
    .from('conversations')
    .select('messages')
    .eq('id', sessionId(channel, chatId))
    .maybeSingle();
  if (error) {
    console.error('loadHistory failed:', error.message);
    return [];
  }
  return Array.isArray(data?.messages) ? data.messages : [];
}

export async function saveHistory(channel, chatId, messages) {
  const trimmed = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.content }));

  const { error } = await db()
    .from('conversations')
    .upsert(
      {
        id: sessionId(channel, chatId),
        channel,
        chat_id: String(chatId),
        messages: trimmed,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    );
  if (error) console.error('saveHistory failed:', error.message);
}

export async function clearHistory(channel, chatId) {
  await db().from('conversations').delete().eq('id', sessionId(channel, chatId));
}

/**
 * Starting fresh: forget what was said, and drop the half-finished booking that
 * was still waiting to be confirmed. Real bookings are never touched - those
 * belong to the customer and to the operations desk, not to the chat window.
 *
 * @returns {Promise<{drafts: number}>} how many unconfirmed drafts were dropped
 */
export async function forgetConversation(channel, chatId) {
  await clearHistory(channel, chatId);
  const { data } = await db()
    .from('bookings')
    .delete()
    .eq('chat_id', String(chatId))
    .eq('status', 'draft')
    .select('booking_ref');
  return { drafts: data?.length ?? 0 };
}
