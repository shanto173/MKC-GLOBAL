/**
 * Chat endpoint for the website widget.
 *
 * It runs the SAME state machine as Telegram. That matters: with booking
 * removed from the model's tools, a widget that only talked to the model could
 * no longer take a booking at all - it would answer questions politely and
 * quietly drop every request. One flow, two transports.
 *
 * The widget has no inline keyboards, so the buttons come back as `options` for
 * it to render, AND are appended to the reply as a numbered list so a client can
 * simply type the number. The state machine accepts either.
 *
 * NOTE: this route is public and spends LLM credits. Before you point real
 * traffic at it, put something in front: a login, a Turnstile/reCAPTCHA token,
 * or Vercel's built-in rate limiting.
 */

import { randomUUID } from 'node:crypto';
import { respond } from '../lib/agent.js';
import { forgetConversation } from '../lib/session.js';
import { runFlow } from '../lib/flow/machine.js';
import { clearSession } from '../lib/flow/store.js';
import { parseCallback } from '../lib/flow/keyboards.js';
import { logEvent } from '../lib/audit.js';

const MAX_MESSAGE_CHARS = 1500;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message, sessionId, reset, action } = req.body ?? {};

  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 100) {
    return res.status(400).json({ error: 'A sessionId string is required.' });
  }

  if (reset) {
    await forgetConversation('web', sessionId);
    await clearSession('web', sessionId);
    return res.status(200).json({ ok: true, reply: 'Conversation cleared.', options: [] });
  }

  // `action` is a button the widget rendered, sent back verbatim. It carries no
  // authority: the machine decides whether that button is a legal move from the
  // state the conversation is actually in.
  const tapped = typeof action === 'string' && action.length <= 64 ? action : null;

  if (!tapped) {
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'A message is required.' });
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return res.status(413).json({ error: `Please keep messages under ${MAX_MESSAGE_CHARS} characters.` });
    }
  }

  const correlationId = randomUUID().slice(0, 8);
  const ctx = { channel: 'web', chatId: sessionId, correlationId };

  try {
    const text = String(message ?? '').trim();
    const input = tapped
      ? { kind: 'callback', callback: { ...parseCallback(tapped), id: null } }
      : text.startsWith('/')
        ? { kind: 'command', command: text.toLowerCase().split(/\s+/)[0], text }
        : { kind: 'text', text };

    const flow = await runFlow(input, ctx);

    if (flow.handled) {
      const body = flow.messages.map((m) => m.text).filter(Boolean).join('\n\n');
      const options = flow.offered ?? [];
      // Numbered in the text as well as returned as data, so the widget works
      // whether or not it has been updated to draw buttons.
      const numbered = options.length
        ? `\n\n${options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}`
        : '';

      logEvent('web_flow_handled', { session: sessionId, state: flow.state, correlation_id: correlationId });
      return res.status(200).json({ reply: body + numbered, options, state: flow.state, toolsUsed: [] });
    }

    // Nothing was being asked and it is not a menu choice: a question for the
    // knowledge assistant.
    const { reply, toolsUsed } = await respond(text, ctx);
    return res.status(200).json({ reply, options: [], toolsUsed });
  } catch (err) {
    console.error(`chat handler error [${correlationId}]:`, err);
    return res.status(500).json({
      error: 'The assistant is unavailable right now. Please try again shortly.',
      ref: correlationId,
    });
  }
}
