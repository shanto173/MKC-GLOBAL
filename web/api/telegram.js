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
 *
 * Everything that does not change what the client is told - the button
 * acknowledgement, the typing indicator, the audit row, the pinned card - is
 * started and left to run (lib/background.js) and waited for only at the end.
 * Each was a network round trip in front of the reply, and together they were
 * most of why a tap felt slow.
 *
 * A FILE is answered before it is read. Telegram delivers a chat's updates one
 * at a time and waits for each answer before sending the next, so three papers
 * sent together used to be read one after another, each getting its own reply.
 * Now the file is recorded, Telegram gets its 200, and the reading goes on in
 * the background (waitUntil keeps the function alive for it) - so the three are
 * read at once, and the last to finish answers for all of them.
 */

import { randomUUID } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { config } from '../lib/config.js';
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
import { noteClientResponse } from '../lib/bookings.js';
import {
  beginDocument, completeDocument, abandonDocument, recentUploads, stillReading, claimReply,
} from '../lib/documents.js';
import { validateUpload } from '../lib/storage.js';
import { settings } from '../lib/settings.js';
import { audit, logEvent } from '../lib/audit.js';
import { refreshPinSafely } from '../lib/pinned.js';
import { drain } from '../lib/outbox.js';
import { defer, flush } from '../lib/background.js';

/** Answers Telegram - after everything left running has finished. */
async function answer(res, body) {
  await flush();
  return res.status(200).json(body);
}

/**
 * Keeps the function alive for work that outlives the response. Outside
 * Vercel there is nothing to tell, and the promise simply runs.
 */
function keepAlive(promise) {
  try {
    waitUntil(promise);
  } catch {
    /* not on Vercel: the process stays up on its own */
  }
}

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
  // Sent, not waited for: nothing below depends on Telegram's answer.
  if (callbackQuery) defer(answerCallback(callbackQuery.id));

  // The client record is refreshed on every update and the refresh is
  // idempotent, so it goes out in the same breath as the claim below rather
  // than after it. A duplicate update does one harmless extra upsert.
  const clientPromise = from
    ? upsertTelegramClient({
        telegramUserId: from.id,
        chatId,
        username: from.username,
        firstName: from.first_name,
        lastName: from.last_name,
      }).catch((err) => { console.error('client upsert failed:', err?.message); return null; })
    : Promise.resolve(null);
  defer(clientPromise);

  // Anything the client sends while we are waiting on them brings the request
  // back to the desk. Started now, alongside the claim, and waited for before
  // the flow runs, so the status the flow reads is already the reopened one.
  const notedPromise = noteClientResponse(chatId, {
    clientId: clientPromise.then((c) => c?.id ?? null),
  }).catch(() => null);
  defer(notedPromise);

  // Claimed in one statement, so two workers handling the same retried update
  // cannot both proceed. A crashed worker's claim becomes reclaimable after a
  // couple of minutes rather than being lost for good.
  const claimed = await claimUpdate(update.update_id, chatId);
  if (!claimed) {
    logEvent('telegram_update_duplicate', { update_id: update.update_id, correlation_id: correlationId });
    return answer(res, { ok: true, duplicate: true });
  }

  logEvent('telegram_update_received', {
    update_id: update.update_id, chat_id: String(chatId),
    kind: callbackQuery ? 'callback' : message?.document || message?.photo ? 'document' : 'message',
    correlation_id: correlationId,
  });

  try {
    const client = await clientPromise;

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
      return answer(res, { ok: true, blocked: true });
    }

    const input = await readInput(update, ctx);

    // /reset is a transport concern - it wipes the transcript and the visible
    // chat, which the flow layer has no business knowing about.
    if (input.kind === 'command' && input.command === '/reset') {
      await handleReset(ctx);
      await finishUpdate(update.update_id, 'processed');
      return answer(res, { ok: true });
    }

    // /start and /menu are the moments a client puts the chat back in order, so
    // they are also when a stale pinned card gets put right. The card is
    // otherwise only touched by booking events, which means one left behind by
    // anything else - a booking removed outside the flow, a chat restored on a
    // new device - stays at the top advertising something that is over.
    if (input.kind === 'command' && (input.command === '/start' || input.command === '/menu')) {
      defer(refreshPinSafely(ctx.chatId));
    }

    if (input.kind === 'rejected') {
      await sendMessage(chatId, input.text, { inline: kb.homeOnly() });
      await finishUpdate(update.update_id, 'processed');
      return answer(res, { ok: true });
    }

    if (input.kind === 'ignore') {
      await finishUpdate(update.update_id, 'processed');
      return answer(res, { ok: true, skipped: true });
    }

    // A file: recorded, and the rest read in the background. Telegram gets
    // its answer now, so the next file it is holding can arrive at once.
    if (input.kind === 'file_recorded') {
      keepAlive(finishDocument(input, ctx, update, notedPromise));
      return res.status(200).json({ ok: true, reading: true });
    }

    await notedPromise;
    defer(sendTyping(chatId));

    const flow = await runFlow(input, ctx);
    await deliver(flow, input, ctx, update, callbackQuery);
    return answer(res, { ok: true });
  } catch (err) {
    await failed(err, update, chatId, correlationId);
    return answer(res, { ok: true, error: true });
  }
}

/**
 * Sends what the flow said - or, when it said nothing, what the assistant
 * says - then the outbox, then the bookkeeping. Shared by the path that
 * answers Telegram afterwards and the one that already has.
 */
async function deliver(flow, input, ctx, update, callbackQuery) {
  const { chatId, correlationId } = ctx;

  if (flow.handled) {
    // The card whose button was just pressed has been acted on; leaving the
    // buttons live invites a second press on a decision already taken. The
    // buttons come off while the reply goes out, not before it - the client
    // is waiting for the reply, not for the old card to change.
    const cleared = callbackQuery?.message?.message_id
      ? clearButtons(chatId, callbackQuery.message.message_id)
      : Promise.resolve();
    for (const m of flow.messages) {
      await sendMessage(chatId, m.text, {
        inline: m.inline,
        keyboard: m.keyboard,
        oneTime: m.oneTime ?? false,
      });
    }
    await cleared;
  } else {
    // Nothing was being asked and the text is not a menu choice, so it is a
    // question. The assistant answers it; the flow state is untouched, so a
    // client who asks something mid-booking keeps their booking.
    //
    // Loaded here rather than at the top: the assistant and its tool sheet
    // are the largest thing in this function, and a tap never needs them.
    const { respond } = await import('../lib/agent.js');
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
}

async function failed(err, update, chatId, correlationId) {
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
  if (file) return recordIncomingFile(file, message, ctx);

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Files that arrived close enough together to have been sent together. */
const BATCH_WINDOW_MS = 45_000;

/**
 * The quick half of a file: validate it and record that it arrived.
 *
 * Validation happens BEFORE the bytes are fetched, so an oversized or
 * unsupported file costs one Telegram round trip rather than a download and a
 * storage write. Recording it first is what lets the files of one album see
 * each other (lib/documents.js, beginDocument).
 */
async function recordIncomingFile(file, message, ctx) {
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

  const begun = await beginDocument({
    fileName: file.fileName,
    mimeType: file.mimeType,
    size: file.size,
    chatId: ctx.chatId,
    channel: 'telegram',
    bookingRef: open?.booking_ref ?? null,
    clientId: ctx.clientId ?? null,
    telegramFileId: file.fileId,
    telegramFileUniqueId: file.fileUniqueId,
    telegramMessageId: message?.message_id ?? null,
    uploadedBy: ctx.userName ?? null,
  });
  if (!begun.ok) return { kind: 'rejected', text: M.documentSaveFailed() };

  return {
    kind: 'file_recorded',
    file,
    message,
    begun,
    bookingRef: open?.booking_ref ?? null,
    // What was written on the file. Step 2 invites the whole booking in one
    // message with the papers attached; this is where that message is.
    caption: (message?.caption ?? '').trim(),
  };
}

/**
 * The slow half, after Telegram has been answered: the caption, the download,
 * the reading, and - if this is the last of its batch to finish - the reply.
 */
async function finishDocument(input, ctx, update, notedPromise) {
  const { file, message, begun, bookingRef, caption } = input;
  const { chatId } = ctx;

  try {
    // "Reading it now" once per batch, not once per file: the first to arrive
    // says it, and a file whose siblings are already being read stays quiet.
    const alreadyReading = (await recentUploads(chatId))
      .some((d) => d.id !== begun.document.id && stillReading(d));
    if (!alreadyReading) defer(sendMessage(chatId, M.documentReading(file.fileName)));
    defer(sendTyping(chatId));

    await notedPromise;

    // The details written on the file go onto the request first, before this
    // file's own reading - so whichever file of a batch ends up speaking, the
    // details are already there. A chassis in them that is already booked
    // ends the flow here, and the file is then read for the record only.
    let ended = false;
    if (caption) {
      const absorbed = await runFlow({ kind: 'caption', text: caption }, ctx);
      if (absorbed.handled && absorbed.messages.length) {
        for (const m of absorbed.messages) {
          await sendMessage(chatId, m.text, { inline: m.inline, keyboard: m.keyboard, oneTime: m.oneTime ?? false });
        }
        ended = true;
      }
    }

    let ingested;
    try {
      const { buffer, fileName } = await downloadFile(file.fileId);
      ingested = await completeDocument(begun.document.id, {
        buffer,
        fileName: file.fileName || fileName,
        mimeType: file.mimeType,
        chatId,
        bookingRef,
        clientId: ctx.clientId ?? null,
      });
    } catch (err) {
      await abandonDocument(begun.document.id, err?.message).catch(() => null);
      throw err;
    }

    if (!ingested.ok) {
      await sendMessage(chatId, M.documentSaveFailed(), { inline: kb.homeOnly() });
      await finishUpdate(update.update_id, 'processed');
      return;
    }

    audit({
      actor_type: 'client', actor_id: chatId,
      action: 'document_received',
      entity_type: 'booking_document', entity_id: ingested.document?.id,
      metadata: { doc_type: ingested.document?.doc_type, booking_ref: bookingRef },
    });

    // An album's items arrive within a second of each other, but a sibling on
    // a cold instance may not have recorded itself yet. A moment's grace before
    // looking is what keeps a fast-read first file from answering alone.
    if (message?.media_group_id) await sleep(1500);

    const recent = await recentUploads(chatId);
    const mine = ingested.document;
    const arrivedAt = new Date(mine.uploaded_at ?? Date.now()).getTime();
    const batch = recent.filter((d) =>
      !stillReading(d) && Math.abs(new Date(d.uploaded_at).getTime() - arrivedAt) <= BATCH_WINDOW_MS);

    // Speak only when no sibling is still being read - and, since siblings
    // that finish together all pass that test, only after winning the claim
    // for this set of files. One reply per batch, whoever gets there.
    let speak = !ended && !recent.some((d) => d.id !== mine.id && stillReading(d));
    if (speak) speak = await claimReply(chatId, batch.map((d) => d.id));

    const flow = await runFlow({ kind: 'document', document: ingested, speak, batch }, ctx);
    await deliver(flow, input, ctx, update, null);
  } catch (err) {
    await failed(err, update, chatId, ctx.correlationId);
  } finally {
    await flush();
  }
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
  const { splitLanguages } = await import('../lib/agent.js');
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
