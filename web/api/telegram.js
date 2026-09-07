/**
 * Telegram webhook. Telegram POSTs every incoming message here.
 *
 * Security: Telegram sends back the secret we registered with setWebhook in the
 * X-Telegram-Bot-Api-Secret-Token header. Requests without it are rejected, so a
 * random stranger who finds the URL cannot drive the bot.
 */

import { config } from '../lib/config.js';
import { respond, splitLanguages } from '../lib/agent.js';
import { forgetConversation } from '../lib/session.js';
import { db } from '../lib/supabase.js';
import { sendMessage, sendTyping, downloadFile, MAIN_KEYBOARD } from '../lib/telegram.js';
import { ingestDocument, documentStatus } from '../lib/documents.js';

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
  const text = (message?.text ?? message?.caption ?? '').trim();
  const attachment = fileFrom(message);

  // Always 200 to Telegram: a non-200 makes it retry the same update forever.
  if (!chatId || (!text && !attachment)) return res.status(200).json({ ok: true, skipped: true });

  try {
    if (await alreadyProcessed(update.update_id)) {
      return res.status(200).json({ ok: true, duplicate: true });
    }

    const userName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ');
    const ctx = { channel: 'telegram', chatId, userName };

    if (attachment) {
      await handleAttachment(attachment, text, ctx);
      return res.status(200).json({ ok: true });
    }

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
        splitLanguages(
          `عذراً، حصل خطأ عندنا. جرب تاني بعد شوية، أو اكتب /help عشان توصل لموظف. (${ref}) ` +
            `| Sorry - something went wrong on our side. Please try again shortly, or type /help ` +
            `to reach a colleague. (${ref})`,
        ),
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
    // The roadmap's panel 0 is a numbered menu the client answers with a digit,
    // not a prose list. Kept in that shape deliberately: a customer on a phone
    // replying "1" is faster than typing a sentence, and the numbering is what
    // the operations team trained people to expect.
    await sendMessage(
      ctx.chatId,
      splitLanguages(`👋 أهلاً${name}، مرحباً بك في ${config.companyName}!\n` +
        'نقدر نساعدك في إيه النهاردة؟ 😊\n\n' +
        '1️⃣ 📦 احجز شحنة\n' +
        '2️⃣ 🚚 تتبع شحنتي\n' +
        '3️⃣ 💬 تواصل مع فريقنا\n\n' +
        'ابعت رقم 1 أو 2 أو 3.\n' +
        '|\n' +
        `👋 Welcome${name} to ${config.companyName}!\n` +
        'How can we help you today? 😊\n\n' +
        '1️⃣ 📦 Book my shipment\n' +
        '2️⃣ 🚚 Track my shipment\n' +
        '3️⃣ 💬 Contact our team\n\n' +
        'Reply with 1, 2 or 3.'),
      { keyboard: MAIN_KEYBOARD },
    );
    return true;
  }

  // /reset, and the "Start fresh" button that does the same thing in one tap.
  if (cmd === '/reset' || /start fresh|ابدأ من جديد/i.test(text)) {
    const { drafts } = await forgetConversation(ctx.channel, ctx.chatId);
    const alsoAr = drafts ? ` وشلت ${drafts === 1 ? 'حجز' : drafts + ' حجوزات'} لسه ما اتأكدش.` : '';
    const alsoEn = drafts ? ` I also dropped ${drafts} unconfirmed booking${drafts === 1 ? '' : 's'}.` : '';
    await sendMessage(
      ctx.chatId,
      splitLanguages(
        `تمام، مسحت المحادثة السابقة وبدأنا من جديد.${alsoAr} حجوزاتك المؤكدة وشحناتك زي ما هي. |` +
        `Done - cleared our conversation and started fresh.${alsoEn} Your confirmed bookings and ` +
        'shipments are untouched.',
      ),
      { keyboard: MAIN_KEYBOARD },
    );
    return true;
  }

  return false;
}

/**
 * Picks the file out of a Telegram message. A "document" is a file sent as-is;
 * a "photo" arrives as several sizes, and the last is the largest.
 */
function fileFrom(message) {
  if (message?.document) {
    return {
      fileId: message.document.file_id,
      fileName: message.document.file_name ?? 'document',
      mimeType: message.document.mime_type ?? 'application/octet-stream',
      size: message.document.file_size ?? 0,
    };
  }
  const photo = message?.photo?.[message.photo.length - 1];
  if (photo) {
    return {
      fileId: photo.file_id,
      fileName: `photo-${photo.file_unique_id}.jpg`,
      mimeType: 'image/jpeg',
      size: photo.file_size ?? 0,
    };
  }
  return null;
}

/**
 * Reading a scanned document takes the best part of half a minute, so the
 * customer is told what is happening before the wait, not after it.
 */
async function handleAttachment(attachment, caption, ctx) {
  await sendMessage(
    ctx.chatId,
    splitLanguages(`استلمت ${attachment.fileName}، بقرأه دلوقتي... | Got ${attachment.fileName}, reading it now...`),
  );
  await sendTyping(ctx.chatId);

  const { buffer, fileName } = await downloadFile(attachment.fileId);
  const result = await ingestDocument({
    buffer,
    fileName: attachment.fileName || fileName,
    mimeType: attachment.mimeType,
    chatId: ctx.chatId,
    channel: ctx.channel,
  });

  if (!result.ok) {
    await sendMessage(
      ctx.chatId,
      splitLanguages('معلش، مقدرتش أحفظ المستند. ممكن تبعته تاني؟ | Sorry, I could not save that document. Could you send it again?'),
      { keyboard: MAIN_KEYBOARD },
    );
    return;
  }

  const status = await documentStatus({ chatId: ctx.chatId, vin: result.extracted?.vin });

  // The model writes the reply, so it stays in the customer's language and in
  // the flow of the conversation - but only from what the tools actually found.
  await sendTyping(ctx.chatId);
  const { reply } = await respond(
    `[The customer just sent a document: ${attachment.fileName}. It was read ` +
      `${result.readVia === 'vision' ? 'by looking at the scan' : 'from its text'}. ` +
      `What was found: ${JSON.stringify(result.extracted).slice(0, 1500)}. ` +
      `Document status for this conversation: ${JSON.stringify(status).slice(0, 1500)}. ` +
      `${caption ? `They also wrote: "${caption}". ` : ''}` +
      'Tell them what you read from it - the chassis number above all - flag any problem, ' +
      'and say what is still missing. Do not call check_documents again, you already have it.]',
    ctx,
  );
  await sendMessage(ctx.chatId, reply, { keyboard: MAIN_KEYBOARD });
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
