/**
 * Chat endpoint for the website widget.
 *
 * NOTE: this route is public and spends LLM credits. Before you point real
 * traffic at it, put something in front: a login, a Turnstile/reCAPTCHA token,
 * or Vercel's built-in rate limiting.
 */

import { respond } from '../lib/agent.js';
import { clearHistory } from '../lib/session.js';

const MAX_MESSAGE_CHARS = 1500;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message, sessionId, reset } = req.body ?? {};

  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 100) {
    return res.status(400).json({ error: 'A sessionId string is required.' });
  }

  if (reset) {
    await clearHistory('web', sessionId);
    return res.status(200).json({ ok: true, reply: 'Conversation cleared.' });
  }

  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'A message is required.' });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return res.status(413).json({ error: `Please keep messages under ${MAX_MESSAGE_CHARS} characters.` });
  }

  try {
    const { reply, toolsUsed } = await respond(message.trim(), {
      channel: 'web',
      chatId: sessionId,
    });
    return res.status(200).json({ reply, toolsUsed });
  } catch (err) {
    console.error('chat handler error:', err);
    return res.status(500).json({ error: 'The assistant is unavailable right now. Please try again shortly.' });
  }
}
