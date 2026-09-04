/**
 * Telegram webhook. Telegram POSTs every incoming message here.
 *
 * Security: Telegram sends back the secret we registered with setWebhook in the
 * X-Telegram-Bot-Api-Secret-Token header. Requests without it are rejected, so a
 * random stranger who finds the URL cannot drive the bot.
 */

import { config } from '../lib/config.js';
import { respond } from '../lib/agent.js';
import { clearHistory } from '../lib/session.js';
import { db } from '../lib/supabase.js';
import { sendMessage, sendTyping, MAIN_KEYBOARD } from '../lib/telegram.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (!config.telegram.webhookSecret || secret !== config.telegram.webhookSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const update = req.body ?? {};
  const message = update.message;
  const chatId = message?.chat?.id;
  const text = (message?.text ?? '').trim();

  // Always 200 to Telegram: a non-200 makes it retry the same update forever.
  if (!chatId || !text) return res.status(200).json({ ok: true, skipped: true });

  try {
    if (await alreadyProcessed(update.update_id)) {
      return res.status(200).json({ ok: true, duplicate: true });
    }

    const userName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ');
    const ctx = { channel: 'telegram', chatId, userName };

    const canned = await handleCommand(text, ctx);
    if (canned) return res.status(200).json({ ok: true });

    await sendTyping(chatId);
    const { reply } = await respond(rewriteCommand(text), ctx);
    await sendMessage(chatId, reply, { keyboard: MAIN_KEYBOARD });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('telegram handler error:', err);
    try {
      // A short code the customer can quote and staff can search the logs for.
      const ref = `ERR-${Date.now().toString(36).toUpperCase().slice(-6)}`;
      console.error(`error ref ${ref}:`, err?.message);
      await sendMessage(
        chatId,
        `عذراً، حصل خطأ عندنا. جرب تاني بعد شوية، أو اكتب /help عشان توصل لموظف. (${ref}) ` +
          `| Sorry - something went wrong on our side. Please try again shortly, or type /help ` +
          `to reach a colleague. (${ref})`,
      );
    } catch {
      /* best effort */
    }
    return res.status(200).json({ ok: true, error: true });
  }
}

/** Handles slash commands. Returns true when the message was fully handled. */
async function handleCommand(text, ctx) {
  const cmd = text.toLowerCase().split(/[\s@]/)[0];

  // These replies are written here rather than generated, so they must carry the
  // Arabic themselves - the model never sees them.
  if (cmd === '/start') {
    const name = ctx.userName ? ' ' + ctx.userName : '';
    await sendMessage(
      ctx.chatId,
      `أهلاً${name}، مرحباً بك في ${config.companyName}.\n\n` +
        'أقدر أساعدك في:\n' +
        '- تتبع شحنة (ابعت رقم الشاسيه أو رقم الحجز أو ACID أو بوليصة الشحن)\n' +
        '- طلب حجز جديد\n' +
        '- الرد على أسئلة المستندات والموانئ والجمارك\n' +
        '- توصيلك بالقسم المختص\n\n' +
        'تحب أساعدك في إيه؟\n' +
        '|\n' +
        `Hello${name}, welcome to ${config.companyName}.\n\n` +
        'I can:\n' +
        '- track a shipment (send the chassis number, booking reference, ACID or B/L)\n' +
        '- take a new booking request\n' +
        '- answer questions about documents, ports and customs\n' +
        '- put you through to the right department\n\n' +
        'What would you like to do?',
      { keyboard: MAIN_KEYBOARD },
    );
    return true;
  }

  if (cmd === '/reset') {
    await clearHistory(ctx.channel, ctx.chatId);
    await sendMessage(
      ctx.chatId,
      'تمام، مسحت المحادثة السابقة. | Done - I have cleared our conversation history.',
      { keyboard: MAIN_KEYBOARD },
    );
    return true;
  }

  return false;
}

/** Turns bare slash commands into normal sentences the model handles well. */
const COMMAND_TEXT = {
  '/track': 'I want to track a shipment.',
  '/book': 'I want to make a new booking.',
  '/help': 'I would like to speak to a human at the company.',
};

function rewriteCommand(text) {
  const cmd = text.toLowerCase().split(/[\s@]/)[0];
  return COMMAND_TEXT[cmd] ?? text;
}

/** Telegram retries on any hiccup; this stops one message being answered twice. */
async function alreadyProcessed(updateId) {
  if (!updateId) return false;
  const { error } = await db().from('processed_updates').insert({ update_id: updateId });
  if (!error) return false;
  // 23505 = unique_violation -> we have seen this update already.
  return error.code === '23505';
}
