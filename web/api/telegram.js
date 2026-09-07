/**
 * Telegram webhook.
 *
 * The order of business here is deliberate and each step guards the next:
 *
 *   1. Prove the request came from Telegram (secret token).
 *   2. Claim the update in Postgres, atomically. A retry loses the race and
 *      returns without doing the work twice.
 *   3. Acknowledge a tapped button immediately, before any slow work, or
 *      Telegram leaves a spinner on it.
 *   4. Run the deterministic state machine.
 *   5. Only if the machine had nothing to say, ask the knowledge assistant.
 *   6. Always answer 200. A non-200 makes Telegram retry the same update for
 *      hours.
 *
 * The state machine runs FIRST and the model runs second. That is the whole
 * architecture in one line: business decisions are made from database rows, and
 * the model is there to answer questions and read values out of sentences.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../lib/config.js';
import { respond, splitLanguages } from '../lib/agent.js';
import { forgetConversation } from '../lib/session.js';
import { db } from '../lib/supabase.js';
import {
  sendMessage, sendTyping, downloadFile, sweepChat, answerCallback, clearButtons,
} from '../lib/telegram.js';
import { parseCallback } from '../lib/flow/keyboards.js';
import * as kb from '../lib/flow/keyboards.js';
import { M } from '../lib/flow/messages.js';
import { runFlow } from '../lib/flow/machine.js';
import { clearSession } from '../lib/flow/store.js';
import { upsertTelegramClient } from '../lib/clients.js';
import { ingestDocument } from '../lib/documents.js';
import { validateUpload } from '../lib/storage.js';
import { settings } from '../lib/settings.js';
import { audit, logEvent } from '../lib/audit.js';
import { refreshPinSafely } from '../lib/pinned.js';
import { drain } from '../lib/outbox.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (!config.telegram.webhookSecret || secret !== config.telegram.webhookSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const update = req.body ?? {};
  const correlationId = randomUUID().slice(0, 8);
  const callbackQuery = update.callback_query ?? null;
  const message = update.message ?? callbackQuery?.message ?? null;
  const from = update.message?.from ?? callbackQuery?.from ?? null;
  const chatId = message?.chat?.id;

  if (!chatId) return res.status(200).json({ ok: true, skipped: true });

  // A tapped button is acknowledged before anything that can be slow or can
  // fail. Telegram spins for a few seconds and then shows the client a dead
  // button, and that happens whether or not the work behind it succeeded.
  if (callbackQuery) await answerCallback(callbackQuery.id);

  // Claimed in one statement, so two workers handling the same retried update
  // cannot both proceed. A crashed worker's claim becomes reclaimable after a
  // couple of minutes rather than being lost for good.
  const claimed = await claimUpdate(update.update_id, chatId);
  if (!claimed) {
    logEvent('telegram_update_duplicate', { update_id: update.update_id, correlation_id: correlationId });
    return res.status(200).json({ ok: true, duplicate: true });
  }

  logEvent('telegram_update_received', {
    update_id: update.update_id, chat_id: String(chatId),
    kind: callbackQuery ? 'callback' : message?.document || message?.photo ? 'document' : 'message',
    correlation_id: correlationId,
  });

  try {
    const client = from
      ? await upsertTelegramClient({
          telegramUserId: from.id,
          chatId,
          username: from.username,
          firstName: from.first_name,
          lastName: from.last_name,
        })
      : null;

    const ctx = {
      channel: 'telegram',
      chatId,
      clientId: client?.id ?? null,
      telegramUserId: from?.id ?? null,
      userName: [from?.first_name, from?.last_name].filter(Boolean).join(' ') || null,
      messageId: message?.message_id,
      correlationId,
    };

    if (client?.is_blocked) {
      await sendMessage(chatId, M.blocked());
      await finishUpdate(update.update_id, 'processed');
      return res.status(200).json({ ok: true, blocked: true });
    }

    const input = await readInput(update, ctx);

    // /reset is a transport concern - it wipes the transcript and the visible
    // chat, which the flow layer has no business knowing about.
    if (input.kind === 'command' && input.command === '/reset') {
      await handleReset(ctx);
      await finishUpdate(update.update_id, 'processed');
      return res.status(200).json({ ok: true });
    }

    if (input.kind === 'rejected') {
      await sendMessage(chatId, input.text, { inline: kb.homeOnly() });
      await finishUpdate(update.update_id, 'processed');
      return res.status(200).json({ ok: true });
    }

    if (input.kind === 'ignore') {
      await finishUpdate(update.update_id, 'processed');
      return res.status(200).json({ ok: true, skipped: true });
    }

    await sendTyping(chatId);

    const flow = await runFlow(input, ctx);

    if (flow.handled) {
      // The card whose button was just pressed has been acted on; leaving the
      // buttons live invites a second press on a decision already taken.
      if (callbackQuery?.message?.message_id) {
        await clearButtons(chatId, callbackQuery.message.message_id);
      }
      for (const m of flow.messages) {
        await sendMessage(chatId, m.text, {
          inline: m.inline,
          keyboard: m.keyboard,
          oneTime: m.oneTime ?? false,
        });
      }
    } else {
      // Nothing was being asked and the text is not a menu choice, so it is a
      // question. The assistant answers it; the flow state is untouched, so a
      // client who asks something mid-booking keeps their booking.
      const { reply } = await respond(input.text ?? '', ctx);
      await sendMessage(chatId, reply, { inline: kb.mainMenu() });
    }

    // Anything the flow queued for this client goes out now rather than waiting
    // for the next cron tick, so a confirmation follows its trigger immediately.
    // Failures here are the outbox's problem: it will retry.
    await drain({ limit: 5 }).catch(() => null);

    await finishUpdate(update.update_id, 'processed');
    logEvent('telegram_update_processed', {
      update_id: update.update_id, correlation_id: correlationId, state: flow.state, handled: flow.handled,
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`telegram handler error [${correlationId}]:`, err);
    logEvent('telegram_update_failed', {
      update_id: update.update_id, correlation_id: correlationId, error: err?.message,
    });
    // Recorded as failed rather than processed, so the claim can be retried
    // instead of the update being silently swallowed.
    await finishUpdate(update.update_id, 'failed', err?.message).catch(() => null);

    try {
      await sendMessage(chatId, M.recoverableError(correlationId), { inline: kb.errorRecovery() });
    } catch { /* best effort */ }

    return res.status(200).json({ ok: true, error: true });
  }
}

// ---------------------------------------------------------------------------
// Reading one update into the shape the state machine takes
// ---------------------------------------------------------------------------

const COMMANDS = new Set(['/start', '/menu', '/help', '/cancel', '/reset', '/book', '/track']);

async function readInput(update, ctx) {
  const callbackQuery = update.callback_query;
  if (callbackQuery) {
    const parsed = parseCallback(callbackQuery.data);
    return {
      kind: 'callback',
      callback: { ...parsed, id: callbackQuery.id, messageId: callbackQuery.message?.message_id },
    };
  }

  const message = update.message ?? {};

  // Telegram vouches for a number shared through the contact button; a typed
  // one arrives with a digit missing often enough to matter.
  if (message.contact?.phone_number) {
    return { kind: 'contact', phone: message.contact.phone_number };
  }

  const file = fileFrom(message);
  if (file) return handleIncomingFile(file, message, ctx);

  const text = (message.text ?? message.caption ?? '').trim();
  if (!text) return { kind: 'ignore' };

  const first = text.toLowerCase().split(/[\s@]/)[0];
  if (COMMANDS.has(first)) return { kind: 'command', command: first, text };

  // The old build's "Start fresh" reply-keyboard button, kept working for
  // clients whose keyboard predates this deployment.
  if (/^🧹|start fresh|ابدأ من جديد/i.test(text)) return { kind: 'command', command: '/reset', text };

  return { kind: 'text', text };
}

/**
 * Picks the file out of a message. A "document" is a file sent as-is; a "photo"
 * arrives as several sizes and the last is the largest.
 */
function fileFrom(message) {
  if (message?.document) {
    return {
      fileId: message.document.file_id,
      fileUniqueId: message.document.file_unique_id,
      fileName: message.document.file_name ?? 'document',
      mimeType: message.document.mime_type ?? 'application/octet-stream',
      size: message.document.file_size ?? 0,
    };
  }
  const photo = message?.photo?.[message.photo.length - 1];
  if (photo) {
    return {
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id,
      fileName: `photo-${photo.file_unique_id}.jpg`,
      mimeType: 'image/jpeg',
      size: photo.file_size ?? 0,
    };
  }
  return null;
}

/**
 * Validates, downloads and files an incoming document.
 *
 * Validation happens BEFORE the bytes are fetched, so an oversized or
 * unsupported file costs one Telegram round trip rather than a download and a
 * storage write.
 */
async function handleIncomingFile(file, message, ctx) {
  const cfg = await settings();
  const check = validateUpload(
    { mimeType: file.mimeType, size: file.size },
    { allowedTypes: cfg.allowed_file_types, maxBytes: cfg.max_upload_bytes },
  );

  if (!check.ok) {
    return {
      kind: 'rejected',
      text: check.reason === 'size'
        ? M.documentTooBig(Math.floor(Number(cfg.max_upload_bytes) / 1048576))
        : M.documentRejectedType(check.mime || 'unknown', cfg.allowed_file_types),
    };
  }

  await sendMessage(ctx.chatId, M.documentReading(file.fileName));
  await sendTyping(ctx.chatId);

  // Which request do these papers belong to? The one this conversation is
  // working on. Attaching them by chat rather than guessing from the content is
  // what stopped an invoice being filed against another vehicle's booking.
  const { data: open } = await db()
    .from('bookings')
    .select('booking_ref, vin')
    .eq('chat_id', String(ctx.chatId))
    .in('status', ['draft', 'pending_review', 'under_review', 'needs_client_action'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { buffer, fileName } = await downloadFile(file.fileId);

  const ingested = await ingestDocument({
    buffer,
    fileName: file.fileName || fileName,
    mimeType: file.mimeType,
    chatId: ctx.chatId,
    channel: 'telegram',
    bookingRef: open?.booking_ref ?? null,
    clientId: ctx.clientId ?? null,
    telegramFileId: file.fileId,
    telegramFileUniqueId: file.fileUniqueId,
    telegramMessageId: message?.message_id ?? null,
    uploadedBy: ctx.userName ?? null,
  });

  if (!ingested.ok) {
    return { kind: 'rejected', text: M.documentSaveFailed() };
  }

  await audit({
    actor_type: 'client', actor_id: ctx.chatId,
    action: 'document_received',
    entity_type: 'booking_document', entity_id: ingested.document?.id,
    metadata: { doc_type: ingested.document?.doc_type, booking_ref: open?.booking_ref },
  });

  return { kind: 'document', document: ingested };
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

async function claimUpdate(updateId, chatId) {
  if (!updateId) return true;    // nothing to de-duplicate on; process it

  const { data, error } = await db().rpc('claim_telegram_update', {
    p_update_id: updateId,
    p_chat_id: String(chatId),
  });

  if (error) {
    // The function is missing (migration 008 not applied yet) - fall back to
    // the original insert-and-check so an un-migrated deployment still works.
    if (/claim_telegram_update|function .* does not exist/i.test(error.message)) {
      const { error: insErr } = await db().from('processed_updates').insert({ update_id: updateId });
      return !insErr || insErr.code !== '23505';
    }
    console.error('claim_telegram_update failed:', error.message);
    // Better to risk answering twice than to go silent on every message.
    return true;
  }
  return data === true;
}

async function finishUpdate(updateId, status, error = null) {
  if (!updateId) return;
  await db().from('processed_updates').update({
    status,
    processed_at: new Date().toISOString(),
    ...(error ? { error: String(error).slice(0, 500) } : {}),
  }).eq('update_id', updateId);
}

// ---------------------------------------------------------------------------
// /reset
// ---------------------------------------------------------------------------

async function handleReset(ctx) {
  const { drafts } = await forgetConversation(ctx.channel, ctx.chatId);
  await clearSession(ctx.channel, ctx.chatId);
  await sweepChat(ctx.chatId, ctx.messageId, 400);

  const alsoAr = drafts ? ` وشلت ${drafts === 1 ? 'حجز' : drafts + ' حجوزات'} لسه ما اتأكدش.` : '';
  const alsoEn = drafts ? ` I also dropped ${drafts} unconfirmed booking${drafts === 1 ? '' : 's'}.` : '';

  await sendMessage(
    ctx.chatId,
    splitLanguages(
      `تمام، مسحت المحادثة ورسايلها.${alsoAr} حجوزاتك المؤكدة وشحناتك زي ما هي. ` +
      'الرسايل الأقدم من يومين بتفضل ظاهرة - تليجرام مبيسمحش للبوت يمسحها. |' +
      `Done - cleared our conversation and the messages above.${alsoEn} Your confirmed bookings ` +
      'and shipments are untouched. Anything older than two days stays visible - Telegram does ' +
      'not let a bot delete it.',
    ),
    { removeKeyboard: true },
  );
  await sendMessage(ctx.chatId, M.welcome(ctx.userName), { inline: kb.mainMenu() });
  await refreshPinSafely(ctx.chatId);
}
