/**
 * WhatsApp webhook (Meta WhatsApp Cloud API).
 *
 * The second transport into the same engine as api/telegram.js: the same
 * state machine, the same rules, the same database. Only the edges differ -
 * how a message arrives, how buttons are drawn (lib/channels.js), and the
 * 24-hour window.
 *
 *   GET   the one-time handshake Meta makes when the webhook is registered:
 *         echo hub.challenge when hub.verify_token matches WHATSAPP_VERIFY_TOKEN.
 *   POST  messages and delivery receipts, signed by Meta.
 *
 * The order of business, each step guarding the next:
 *
 *   1. Prove the request came from Meta: X-Hub-Signature-256 is an HMAC of the
 *      RAW body with the app secret. Re-serialising the parsed JSON does not
 *      give the same bytes - Meta escapes non-ASCII as \uXXXX - so the bytes
 *      are read as they arrived (readRawBody). A mismatch is a 401 and nothing
 *      is read.
 *   2. Answer 200 at once. Meta retries an unanswered webhook for up to 36
 *      hours, and does not wait for one chat's message to be answered before
 *      sending the next - so unlike Telegram there is nothing to gain by
 *      answering late, and the work continues under waitUntil.
 *   3. Per message: claim its id in Postgres (a retry loses the race), refresh
 *      the client, stamp the window (alongside the turn, not in front of it),
 *      run the machine in the client's language, deliver, wait for the stamp
 *      and the session write, drain the outbox, mark the claim done.
 *   4. Per receipt: mark the chat log and the outbox row delivered/read/failed.
 *
 * Messages from one chat are handled one at a time, in the order they were
 * claimed. Telegram gave that for free; Meta delivers concurrently, and two
 * quick messages - the name, then the number - read at once would both be
 * answered from the state before either. A file holds the line only while it
 * is recorded, not while it is read, so several papers are still read side by
 * side and the last to finish answers for all of them.
 */

import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { config } from '../lib/config.js';
import { db } from '../lib/supabase.js';
import { forgetConversation } from '../lib/session.js';
import { parseCallback } from '../lib/flow/keyboards.js';
import * as kb from '../lib/flow/keyboards.js';
import { M } from '../lib/flow/messages.js';
import { runFlow } from '../lib/flow/machine.js';
import { clearSession } from '../lib/flow/store.js';
import { storedLanguage } from '../lib/flow/language.js';
import { withLanguage, withTurn, normaliseLanguage, languageFromChoice } from '../lib/lang.js';
import { upsertWhatsAppClient, setOptOut } from '../lib/clients.js';
import {
  beginDocument, completeDocument, abandonDocument, recentUploads, stillReading, claimReply, openRequestForFiles,
} from '../lib/documents.js';
import { validateUpload } from '../lib/storage.js';
import { settings } from '../lib/settings.js';
import { audit, logEvent } from '../lib/audit.js';
import { drain, releaseHeld, noteDeliveryStatus } from '../lib/outbox.js';
import { defer, flush } from '../lib/background.js';
import { sendToChat, stampClientMessage, phrase, whatsappChatId } from '../lib/channels.js';
import { logInbound, markDelivery, isSchemaMissing } from '../lib/chatlog.js';
import { markRead, mediaInfo, downloadMedia } from '../lib/whatsapp.js';

/** More than this many messages from one chat in a minute is a flood. */
const FLOOD_LIMIT = 20;
const FLOOD_WINDOW_MS = 60_000;

/**
 * How long a message waits for an earlier one from the same chat.
 *
 * The earlier one is not done until its session write has landed, which can
 * now come after its reply: a database call gets up to 4.5 s and one more try
 * (lib/supabase.js), so a wait shorter than that would let the second message
 * be answered from the state before the first.
 */
const TURN_WAIT_MS = 15_000;

/**
 * WhatsApp has no albums: three papers sent together are three messages with
 * nothing tying them. Every file therefore waits this long before looking for
 * siblings, so one read quickly does not answer before the others are
 * recorded. Telegram does the same wait only for an album.
 */
const BATCH_GRACE_MS = 1_500;

/** Files that arrived close enough together to have been sent together. */
const BATCH_WINDOW_MS = 45_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Keeps the function alive for work that outlives the response. Outside
 * Vercel there is nothing to tell, and the promise simply runs (server.js
 * provides the same hook and waits for it on shutdown).
 */
function keepAlive(promise) {
  try {
    waitUntil(promise);
  } catch {
    /* not on Vercel: the process stays up on its own */
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') return verifyHandshake(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Without the app secret nothing can be verified, and an unverified POST is
  // anyone on the internet typing as a customer.
  if (!config.whatsapp.appSecret) {
    console.error('whatsapp webhook refused: WHATSAPP_APP_SECRET is not set');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const raw = await readRawBody(req);
  if (!verifySignature(raw, req.headers['x-hub-signature-256'], config.whatsapp.appSecret)) {
    logEvent('whatsapp_signature_rejected', { bytes: raw.length, had_header: Boolean(req.headers['x-hub-signature-256']) });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  keepAlive(handlePayload(payload).catch((err) => console.error('whatsapp webhook processing failed:', err)));
  return res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------------
// Proving it is Meta
// ---------------------------------------------------------------------------

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The subscription handshake. Anything but an exact match is a 403. */
function verifyHandshake(req, res) {
  const q = req.query ?? {};
  const challenge = String(q['hub.challenge'] ?? '');
  const ok = q['hub.mode'] === 'subscribe'
    && Boolean(config.whatsapp.verifyToken)
    && safeEqual(q['hub.verify_token'], config.whatsapp.verifyToken)
    // Meta sends a number. Echoing anything else back would let this URL
    // reflect arbitrary text, so anything else is refused.
    && /^[A-Za-z0-9_-]{1,256}$/.test(challenge);
  if (!ok) return res.status(403).json({ error: 'Forbidden' });
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  return res.status(200).send(challenge);
}

/**
 * HMAC-SHA256 of the raw body with the app secret, compared in constant time
 * with the hex after "sha256=" in the header.
 */
export function verifySignature(raw, header, secret) {
  if (!secret || typeof header !== 'string') return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return false;
  const expected = createHmac('sha256', secret).update(raw ?? Buffer.alloc(0)).digest();
  const given = Buffer.from(match[1], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The request body exactly as it arrived, on whichever host is running this.
 *
 *   server.js   reads the stream before calling a handler and keeps the bytes
 *               on req.rawBody.
 *   Vercel      reads the stream too (to offer req.body), then replays the
 *               same bytes to any 'data'/'end' listener on req - so listening
 *               gets them, as long as req.body is not what we rely on.
 *   plain Node  the stream has not been touched; listening reads it.
 *
 * A stream that has already been read with nothing replaying it never emits
 * again, so that case is detected rather than waited on.
 */
export async function readRawBody(req, { timeoutMs = 10_000 } = {}) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody, 'utf8');

  const replayed = Object.prototype.hasOwnProperty.call(req, 'on');
  const consumed = req.readableEnded === true && !replayed;
  let streamed = Buffer.alloc(0);
  if (!consumed && typeof req.on === 'function') {
    streamed = await new Promise((resolve) => {
      const chunks = [];
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      };
      const timer = setTimeout(finish, timeoutMs);
      req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', finish);
      req.on('error', finish);
    });
  }
  if (streamed.length) return streamed;
  // A host that kept only the bytes, or the text, as the body.
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  return streamed;
}

// ---------------------------------------------------------------------------
// One webhook call
// ---------------------------------------------------------------------------

/** Not messages to answer, and not claimed: a reaction, a "number changed". */
const IGNORED_TYPES = new Set(['reaction', 'system', 'ephemeral']);

/**
 * Everything in one POST. Meta may batch: several changes, several messages,
 * receipts mixed in. Receipts and different chats run side by side; one chat's
 * messages run in order.
 */
export async function handlePayload(payload) {
  if (payload?.object && payload.object !== 'whatsapp_business_account') return;

  const tasks = [];
  const background = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if ((change?.field ?? 'messages') !== 'messages') continue;
      const value = change?.value ?? {};

      // One app can serve several numbers; a message to another of them is not
      // ours to answer from this one.
      const to = value.metadata?.phone_number_id;
      if (to && config.whatsapp.phoneNumberId && String(to) !== String(config.whatsapp.phoneNumberId)) {
        logEvent('whatsapp_other_number', { phone_number_id: String(to) });
        continue;
      }

      for (const status of value.statuses ?? []) tasks.push(handleStatus(status));
      for (const error of value.errors ?? []) {
        logEvent('whatsapp_webhook_error', { code: error?.code, title: error?.title, details: error?.error_data?.details });
      }

      const names = new Map((value.contacts ?? []).map((c) => [String(c?.wa_id ?? ''), c?.profile?.name ?? null]));
      const byChat = new Map();
      const ordered = [...(value.messages ?? [])].sort((a, b) => Number(a?.timestamp ?? 0) - Number(b?.timestamp ?? 0));
      for (const message of ordered) {
        const from = String(message?.from ?? '');
        if (!from) continue;
        if (!byChat.has(from)) byChat.set(from, []);
        byChat.get(from).push(message);
      }
      for (const [from, messages] of byChat) {
        tasks.push((async () => {
          for (const message of messages) {
            await handleMessage(message, { waId: from, profileName: names.get(from) ?? null }, background)
              .catch((err) => console.error('whatsapp message failed:', err));
          }
        })());
      }
    }
  }

  await Promise.all(tasks);
  // Files go on being read after their message has been dealt with.
  await Promise.all(background);
  await flush();
}

/** A delivery receipt for something we sent. */
async function handleStatus(status) {
  const first = status?.errors?.[0] ?? null;
  const code = first?.code ?? null;
  const error = first ? [first.title ?? first.message, first.error_data?.details].filter(Boolean).join(' - ') : null;
  await Promise.all([
    markDelivery('whatsapp', status?.id, status?.status, code ? `${code}: ${error}` : error),
    noteDeliveryStatus({ providerMessageId: status?.id, status: status?.status, code, error })
      .catch((err) => console.error('outbox receipt failed:', err?.message)),
  ]);
  if (status?.status === 'failed') logEvent('whatsapp_delivery_failed', { code, title: first?.title ?? null });
}

/** "wa:2010…1234" - enough to follow a conversation in the log, not a number to call. */
function masked(chatId) {
  const s = String(chatId ?? '');
  return s.length > 10 ? `${s.slice(0, 7)}…${s.slice(-4)}` : s;
}

async function handleMessage(message, who, background) {
  const waId = String(message?.from ?? who.waId ?? '').replace(/\D/g, '');
  const chatId = whatsappChatId(waId);
  if (!chatId || !message?.id) return;
  if (IGNORED_TYPES.has(message.type)) {
    logEvent('whatsapp_message_ignored', { type: message.type, chat: masked(chatId) });
    return;
  }

  const correlationId = randomUUID().slice(0, 8);

  // The client row is refreshed on every message and the refresh is
  // idempotent, so it goes out alongside the claim rather than after it.
  const clientPromise = upsertWhatsAppClient({ waId, profileName: who.profileName })
    .catch((err) => { console.error('whatsapp client upsert failed:', err?.message); return null; });
  defer(clientPromise);

  const claimed = await claimMessage(message.id, chatId);
  if (!claimed) {
    logEvent('whatsapp_message_duplicate', { chat: masked(chatId), correlation_id: correlationId });
    return;
  }
  logEvent('whatsapp_message_received', { chat: masked(chatId), type: message.type, correlation_id: correlationId });

  const client = await clientPromise;
  const ctx = {
    channel: 'whatsapp',
    chatId,
    waId,
    clientId: client?.id ?? null,
    userName: who.profileName ?? client?.whatsapp_name ?? null,
    language: null,
    messageId: message.id,
    correlationId,
  };
  ctx.language = normaliseLanguage(client?.language)
    ?? await storedLanguage(ctx).catch(() => null);

  // Everything said this turn - including what is said outside the machine:
  // the blocked notice, an error, a refused file - is in the client's
  // language, and worded for WhatsApp ("send menu", not "/menu").
  return withTurn({ lang: ctx.language, channel: 'whatsapp' }, () => turn(message, ctx, client, background));
}

async function turn(message, ctx, client, background) {
  const { chatId } = ctx;
  const target = targetOf(ctx);

  // The client wrote: the window opens from now, and anything the outbox was
  // holding for them may go. Waited for before the turn's own drain, and not
  // before: nothing the bot says in answer depends on it, and in the live
  // test this one write once held a reply for seven seconds.
  const opened = stampClientMessage(ctx).then(() => releaseHeld(chatId)).catch(() => null);
  defer(opened);
  ctx.opened = opened;
  // A reply to something the desk asked is no longer caught here, by any
  // message at all, before the flow has read it: the state machine decides
  // whether it is an answer, keeps it on the request and says so
  // (lib/answers.js). Caught here, a tap on "Main menu" reopened the request
  // with nothing to show for it, and the real answer then went to the
  // assistant as a fresh chat.
  // Blue ticks and "typing…" - in place of Telegram's sendChatAction.
  defer(markRead(message.id, { typing: true }));
  defer(logInbound({
    channel: 'whatsapp', chatId, clientId: ctx.clientId, language: ctx.language,
    providerMessageId: message.id, ...describe(message),
  }));

  try {
    const flood = await floodCheck(chatId);
    if (flood !== 'ok') {
      if (flood === 'warn') await sendToChat(target, { text: T.slowDown() });
      logEvent('whatsapp_flood', { chat: masked(chatId), action: flood });
      await finishClaim(message.id, 'ignored');
      return;
    }

    await waitForTurn(chatId, message.id);

    if (client?.is_blocked) {
      await sendToChat(target, { text: M.blocked() });
      await finishClaim(message.id, 'processed');
      return;
    }

    const input = await readInput(message, ctx, client);

    if (input.kind === 'ignore') {
      await finishClaim(message.id, 'processed');
      return;
    }

    if (input.kind === 'opt_out') {
      await handleOptOut(ctx);
      await finishClaim(message.id, 'processed');
      return;
    }

    // START after STOP: they hear it is undone, and the menu as for "start" -
    // in one message. Sent as two, one word got two notifications.
    if (input.kind === 'opt_in') {
      const { changed } = await setOptOut(ctx.clientId, false);
      const flow = await runFlow({ kind: 'command', command: '/start', text: input.text }, ctx, { awaitSave: false });
      if (changed) {
        const [first, ...rest] = flow.handled ? flow.messages : [];
        if (first) flow.messages = [{ ...first, text: `${T.optedIn()}\n\n${first.text ?? ''}`.trim() }, ...rest];
        else await sendToChat(target, { text: T.optedIn() });
      }
      await deliver(flow, input, ctx);
      return;
    }

    // Reset is a transport concern: it clears our side of the conversation,
    // and on WhatsApp it cannot clear the client's.
    if (input.kind === 'command' && input.command === '/reset') {
      await handleReset(ctx);
      await finishClaim(message.id, 'processed');
      return;
    }

    if (input.kind === 'unsupported') {
      await sendToChat(target, { text: T.unsupported(), inline: kb.mainMenu() });
      await finishClaim(message.id, 'processed');
      return;
    }

    if (input.kind === 'rejected') {
      await sendToChat(target, { text: input.text, inline: kb.homeOnly() });
      await finishClaim(message.id, 'processed');
      return;
    }

    // A file: recorded, and the line for this chat released, so the next
    // file can be recorded too; the reading carries on beside it.
    if (input.kind === 'file_recorded') {
      await finishClaim(message.id, 'reading');
      background.push(withLanguage(ctx.language, () => finishDocument(input, ctx)));
      return;
    }

    // The reply goes out before the session write lands; deliver() waits for
    // the write before this message is marked done.
    const flow = await runFlow(input, ctx, { awaitSave: false });
    await deliver(flow, input, ctx);
  } catch (err) {
    await failed(err, message, ctx);
  }
}

const targetOf = (ctx) => ({ channel: 'whatsapp', chatId: ctx.chatId, clientId: ctx.clientId ?? null });

/**
 * Sends what the flow said - or, when it said nothing, what the assistant
 * says - then the outbox, then the bookkeeping.
 *
 * The order is the point. The reply is sent while the turn's session write
 * and the window stamp may still be on their way; both are waited for after
 * it - the stamp because the outbox must not judge the window from a clock
 * that has not moved yet, the session because the claim is what makes the
 * next message from this chat wait (waitForTurn), and it must not be released
 * while the state that message will read is still being written.
 */
async function deliver(flow, input, ctx) {
  const target = targetOf(ctx);
  // The turn may have changed the language (a choice, or a guess from the
  // script the client wrote in); the reply is drawn in the new one.
  const language = flow.language !== undefined ? normaliseLanguage(flow.language) : await languageAfter(input, ctx);

  await withLanguage(language, async () => {
    if (flow.handled) {
      for (const m of coalesce(flow.messages)) await sendToChat(target, m, { author: 'bot' });
    } else {
      // Nothing was being asked and it is not a menu choice: a question. The
      // assistant answers it and the flow state is untouched. Loaded here, not
      // at the top: a tap never needs it.
      const { respond } = await import('../lib/agent.js');
      const { reply } = await respond(input.text ?? '', { ...ctx, language });
      await sendToChat(target, { text: reply, inline: kb.mainMenu() }, { author: 'bot' });
    }
  });

  await Promise.all([flow.saved, ctx.opened].filter(Boolean));

  // Anything the flow queued goes now rather than at the next retry, so a
  // confirmation follows its trigger. Failures are the outbox's to retry.
  await drain({ limit: 5 }).catch(() => null);

  await finishClaim(ctx.messageId, 'processed');
  logEvent('whatsapp_message_processed', {
    chat: masked(ctx.chatId), correlation_id: ctx.correlationId, state: flow.state, handled: flow.handled,
  });
}

/** WhatsApp's ceilings on one message: an interactive body, and plain text. */
const MERGE_LIMITS = { interactive: 1024, text: 4096 };

/**
 * One reply, as few messages as it fits in.
 *
 * The engine says things in steps - "this unit is new", "we still need make,
 * port and destination", "what is the make?" - and Telegram shows them as
 * steps. On WhatsApp each one is a separate notification on the client's phone,
 * three buzzes for one answer. Plain messages are therefore folded into the
 * message that follows them, while the result still fits what WhatsApp allows
 * for that kind of message; a file, or anything over the limit, is left as it
 * was.
 */
export function coalesce(messages) {
  const out = [];
  let pending = [];
  const plain = (m) => !m.inline?.length && !m.document && String(m.text ?? '').trim();
  const flush = () => { if (pending.length) out.push({ text: pending.join('\n\n') }); pending = []; };

  for (const m of messages ?? []) {
    if (plain(m)) {
      const joined = [...pending, String(m.text).trim()].join('\n\n');
      if (joined.length <= MERGE_LIMITS.text) { pending.push(String(m.text).trim()); continue; }
      flush();
      pending.push(String(m.text).trim());
      continue;
    }
    if (pending.length && !m.document) {
      const text = [...pending, String(m.text ?? '').trim()].filter(Boolean).join('\n\n');
      const limit = m.inline?.length ? MERGE_LIMITS.interactive : MERGE_LIMITS.text;
      if (text.length <= limit) {
        out.push({ ...m, text });
        pending = [];
        continue;
      }
    }
    flush();
    out.push(m);
  }
  flush();
  return out;
}

/** The language after the machine ran, re-read only when it may have moved. */
async function languageAfter(input, ctx) {
  const mayHaveChanged = !ctx.language
    || (input.kind === 'command' && input.command === '/language')
    || (input.kind === 'callback' && /^lang/i.test(input.callback?.ns ?? ''))
    || (input.kind === 'text' && languageFromChoice(input.text));
  if (!mayHaveChanged) return ctx.language;
  return (await storedLanguage(ctx).catch(() => null)) ?? ctx.language;
}

async function failed(err, message, ctx) {
  console.error(`whatsapp handler error [${ctx.correlationId}]:`, err);
  logEvent('whatsapp_message_failed', { correlation_id: ctx.correlationId, error: err?.message });
  // Failed rather than processed, so a redelivery of the same message can be
  // claimed again instead of being swallowed.
  await finishClaim(message?.id, 'failed', err?.message).catch(() => null);
  try {
    await sendToChat(targetOf(ctx), { text: M.recoverableError(ctx.correlationId), inline: kb.errorRecovery() });
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// What the transport says itself
// ---------------------------------------------------------------------------

export const T = {
  unsupported: () => phrase(
    'أقدر أقرا الرسايل المكتوبة وملفات PDF والصور بس. اكتبلي اللي محتاجه، أو اختار من القائمة.',
    'I can read text, PDFs and photos. Please type what you need, or choose from the menu.',
  ),
  slowDown: () => phrase(
    '⏳ وصلني رسايل كتير ورا بعض. استنى دقيقة وبعدين كمّل من فضلك.',
    '⏳ That is a lot of messages at once. Please wait a minute, then carry on.',
  ),
  optedOut: () => phrase(
    'تمام، مش هنبعتلك رسايل تاني إلا لو كتبتلنا انت الأول. لو غيرت رأيك ابعت "ابدأ" أو START.',
    'Done - we will not message you again unless you write to us first. Send START if you change your mind.',
  ),
  optedIn: () => phrase(
    'أهلاً بيك تاني! هنبعتلك تحديثات حجوزاتك وشحناتك تاني.',
    'Welcome back! We will keep you updated on your bookings and shipments again.',
  ),
  reset: (drafts) => phrase(
    'تمام، مسحت المحادثة من عندنا.'
      + (drafts ? ` وشلت ${drafts === 1 ? 'حجز' : `${drafts} حجوزات`} لسه ما اتأكدش.` : '')
      + ' حجوزاتك المؤكدة وشحناتك زي ما هي. واتساب مبيسمحش لنا نمسح الرسايل من عندك، فهتفضل ظاهرة.',
    'Done - I have cleared our side of this conversation.'
      + (drafts ? ` I also dropped ${drafts} unconfirmed booking${drafts === 1 ? '' : 's'}.` : '')
      + ' Your confirmed bookings and shipments are untouched. WhatsApp does not let us delete messages, so the chat above stays visible.',
  ),
};

async function handleReset(ctx) {
  const { drafts } = await forgetConversation(ctx.channel, ctx.chatId);
  await clearSession(ctx.channel, ctx.chatId);
  // The session row carried the window's clock; the client has just written,
  // so it starts again from now rather than reading as closed.
  await stampClientMessage(ctx).catch(() => null);
  const target = targetOf(ctx);
  await sendToChat(target, { text: T.reset(drafts) });
  await sendToChat(target, { text: M.welcome(ctx.userName), inline: kb.mainMenu() });
}

/** STOP: recorded, confirmed once. A second STOP gets no second message. */
async function handleOptOut(ctx) {
  const result = await setOptOut(ctx.clientId, true);
  if (result.ok && result.changed) {
    await sendToChat(targetOf(ctx), { text: T.optedOut() });
    audit({ actor_type: 'client', actor_id: ctx.chatId, action: 'whatsapp_opted_out', entity_type: 'client', entity_id: String(ctx.clientId) });
  } else if (!result.ok) {
    logEvent('whatsapp_opt_out_unrecorded', { chat: masked(ctx.chatId), unsupported: Boolean(result.unsupported) });
  }
}

// ---------------------------------------------------------------------------
// Reading one message into the shape the state machine takes
// ---------------------------------------------------------------------------

/**
 * Words that are commands on WhatsApp, where there is no "/" menu. Matched
 * against the whole message, so "cancel my booking please" stays a sentence.
 */
const COMMANDS = new Map([
  ...['menu', 'main menu', 'home', 'القائمة', 'القائمه', 'القائمة الرئيسية', 'الرئيسية'].map((w) => [w, '/menu']),
  ...['start', 'hi', 'hello', 'hey', 'ابدأ', 'ابدا', 'مرحبا', 'أهلا', 'اهلا', 'هاي', 'السلام عليكم', 'سلام عليكم']
    .map((w) => [w, '/start']),
  ...['cancel', 'الغاء', 'إلغاء', 'الغي', 'ألغي'].map((w) => [w, '/cancel']),
  ...['reset', 'start fresh', 'ابدأ من جديد', 'ابدا من جديد'].map((w) => [w, '/reset']),
  ...['help', 'مساعدة', 'مساعده'].map((w) => [w, '/help']),
  ...['language', 'lang', 'اللغة', 'اللغه', 'لغة'].map((w) => [w, '/language']),
]);

/** The Telegram-style slash commands, which some clients type anyway. */
const SLASH = new Set(['/start', '/menu', '/help', '/cancel', '/reset', '/book', '/track', '/language']);

const STOP_WORDS = new Set(['stop', 'توقف', 'unsubscribe']);
const START_WORDS = new Set(['start', 'ابدأ', 'ابدا']);

function readText(body, client) {
  const text = String(body ?? '').trim();
  if (!text) return { kind: 'ignore' };

  if (text.startsWith('/')) {
    const first = text.toLowerCase().split(/[\s@]/)[0];
    if (SLASH.has(first)) {
      if (first === '/start' && client?.opted_out_at) return { kind: 'opt_in', text };
      return { kind: 'command', command: first, text };
    }
  }

  const word = text.toLowerCase().replace(/[.!؟?،,]+$/u, '').replace(/\s+/g, ' ').trim();
  if (STOP_WORDS.has(word)) return { kind: 'opt_out', text };
  if (START_WORDS.has(word) && client?.opted_out_at) return { kind: 'opt_in', text };
  const command = COMMANDS.get(word);
  if (command) return { kind: 'command', command, text };
  return { kind: 'text', text };
}

/** A tapped button or list row: the id we set is the engine's own payload. */
function callback(id, message) {
  return {
    kind: 'callback',
    callback: { ...parseCallback(id), id: message.id, messageId: message.context?.id ?? null },
  };
}

async function readInput(message, ctx, client) {
  switch (message.type) {
    case 'text':
      return readText(message.text?.body, client);

    case 'interactive': {
      const reply = message.interactive?.button_reply ?? message.interactive?.list_reply;
      return reply?.id ? callback(reply.id, message) : { kind: 'unsupported' };
    }

    // A quick-reply button on a template. Our templates carry an engine
    // payload ("menu:home"); anything else - a tap on "Reply" - means the
    // client is back, and they get the menu.
    case 'button': {
      const payload = String(message.button?.payload ?? '').trim();
      if (/^[a-z]{2,8}:[a-z_]/i.test(payload)) return callback(payload, message);
      return { kind: 'command', command: '/menu', text: message.button?.text ?? payload };
    }

    // A contact card. WhatsApp's own wa_id for the number is preferred: it is
    // international and has no formatting to get wrong.
    case 'contacts': {
      const phone = (message.contacts ?? []).flatMap((c) => c?.phones ?? [])
        .map((p) => (p?.wa_id ? `+${p.wa_id}` : p?.phone))
        .find(Boolean);
      return phone ? { kind: 'contact', phone: String(phone) } : { kind: 'unsupported' };
    }

    case 'document':
    case 'image':
      return recordIncomingFile(fileFrom(message), message, ctx);

    // The client opened the chat for the first time from a link or an ad.
    case 'request_welcome':
      return { kind: 'command', command: '/start', text: '' };

    // audio, video, sticker, location, order, unsupported, and whatever Meta
    // adds next.
    default:
      return { kind: 'unsupported' };
  }
}

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' };

function fileFrom(message) {
  const media = message.type === 'image' ? message.image : message.document;
  const mimeType = String(media?.mime_type ?? (message.type === 'image' ? 'image/jpeg' : 'application/octet-stream'))
    .split(';')[0].trim().toLowerCase();
  const ext = EXTENSIONS[mimeType] ?? 'bin';
  const shortId = String(media?.id ?? message.id ?? '').slice(-12) || 'file';
  return {
    mediaId: media?.id ?? null,
    url: media?.url ?? null,
    sha256: media?.sha256 ?? null,
    mimeType,
    fileName: message.type === 'image' ? `photo-${shortId}.${ext}` : (media?.filename || `document-${shortId}.${ext}`),
    caption: media?.caption ?? '',
    size: 0,
  };
}

/**
 * The quick half of a file: validate it and record that it arrived.
 *
 * The type is checked from the webhook, which costs nothing. The webhook does
 * not carry the size; Meta's media endpoint does, so it is asked - one small
 * call - before anything is downloaded. Recording the file first is what lets
 * the files of one batch see each other (lib/documents.js, beginDocument).
 */
async function recordIncomingFile(file, message, ctx) {
  if (!file.mediaId) return { kind: 'unsupported' };
  const cfg = await settings();
  const limits = { allowedTypes: cfg.allowed_file_types, maxBytes: cfg.max_upload_bytes };
  const refuse = (check) => ({
    kind: 'rejected',
    text: check.reason === 'size'
      ? M.documentTooBig(Math.floor(Number(cfg.max_upload_bytes) / 1048576))
      : M.documentRejectedType(check.mime || 'unknown', cfg.allowed_file_types),
  });

  const byType = validateUpload({ mimeType: file.mimeType, size: 0 }, limits);
  if (!byType.ok) return refuse(byType);

  const info = await mediaInfo(file.mediaId);
  if (info.ok) {
    file.size = info.size || 0;
    file.url = info.url ?? file.url;
    // The webhook usually carries the hash; when it does not, the media
    // endpoint does, and the hash is how a re-sent paper is recognised.
    file.sha256 = file.sha256 ?? info.sha256 ?? null;
  }
  const bySize = validateUpload({ mimeType: file.mimeType, size: file.size }, limits);
  if (!bySize.ok) return refuse(bySize);

  const open = await openRequestForFiles(ctx.chatId);
  const begun = await beginDocument({
    fileName: file.fileName,
    mimeType: file.mimeType,
    size: file.size,
    chatId: ctx.chatId,
    channel: 'whatsapp',
    bookingRef: open?.booking_ref ?? null,
    clientId: ctx.clientId ?? null,
    whatsappMediaId: file.mediaId,
    whatsappMediaSha256: file.sha256,
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
    caption: String(file.caption ?? '').trim(),
  };
}

/**
 * The slow half: the caption, the download, the reading, and - if this is the
 * last of its batch to finish - the reply.
 */
async function finishDocument(input, ctx) {
  const { file, message, begun, bookingRef, caption } = input;
  const { chatId } = ctx;
  const target = targetOf(ctx);

  try {
    // The details written on the file go onto the request first, so whichever
    // file of a batch ends up speaking, they are already there. A chassis in
    // them that is already booked ends the flow here, and the file is then
    // read for the record only.
    let ended = false;
    if (caption) {
      const absorbed = await runFlow({ kind: 'caption', text: caption }, ctx);
      if (absorbed.handled && absorbed.messages.length) {
        for (const m of absorbed.messages) await sendToChat(target, m, { author: 'bot' });
        ended = true;
      }
    }

    // The URL from a few seconds ago may already be past its five minutes on
    // a slow batch; downloadMedia asks for a fresh one once if so.
    const got = await downloadMedia(file.mediaId, { url: file.url });
    const cfg = await settings();
    const tooBig = got.ok && cfg.max_upload_bytes && got.buffer.length > Number(cfg.max_upload_bytes);
    if (!got.ok || tooBig) {
      await abandonDocument(begun.document.id, got.error ?? 'too big').catch(() => null);
      await sendToChat(target, {
        text: tooBig ? M.documentTooBig(Math.floor(Number(cfg.max_upload_bytes) / 1048576)) : M.documentSaveFailed(),
        inline: kb.homeOnly(),
      });
      await finishClaim(message.id, 'processed', got.error ?? 'too big');
      return;
    }

    let ingested;
    try {
      ingested = await completeDocument(begun.document.id, {
        buffer: got.buffer,
        fileName: file.fileName,
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
      await sendToChat(target, { text: M.documentSaveFailed(), inline: kb.homeOnly() });
      await finishClaim(message.id, 'processed');
      return;
    }

    audit({
      actor_type: 'client', actor_id: chatId,
      action: 'document_received',
      entity_type: 'booking_document', entity_id: ingested.document?.id,
      metadata: { doc_type: ingested.document?.doc_type, booking_ref: bookingRef, channel: 'whatsapp' },
    });

    await sleep(BATCH_GRACE_MS);

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

    const flow = await runFlow({ kind: 'document', document: ingested, speak, batch }, ctx, { awaitSave: false });
    await deliver(flow, { kind: 'document' }, ctx);
  } catch (err) {
    await failed(err, message, ctx);
  } finally {
    await flush();
  }
}

// ---------------------------------------------------------------------------
// Idempotency, order and flood
// ---------------------------------------------------------------------------

// Whether claim_whatsapp_message() and its table exist. Learned once.
let claimSupported = null;
// Without the table: message ids seen by this instance, so at least a retry
// that lands on the same instance is not answered twice.
const seenHere = new Map();
const recentHere = new Map();

/** For tests: forget what was learned about the schema. */
export function resetWhatsappForTests() {
  claimSupported = null;
  seenHere.clear();
  recentHere.clear();
}

/**
 * Claimed in one statement, so two workers handling the same retried
 * delivery cannot both proceed. A crashed worker's claim becomes reclaimable
 * after two minutes rather than being lost for good.
 */
async function claimMessage(messageId, chatId) {
  if (claimSupported !== false) {
    const { data, error } = await db().rpc('claim_whatsapp_message', { p_message_id: messageId, p_chat_id: chatId });
    if (!error) {
      claimSupported = true;
      return data === true;
    }
    if (!isSchemaMissing(error)) {
      console.error('claim_whatsapp_message failed:', error.message);
      // Better to risk answering twice than to go silent on every message.
      return true;
    }
    claimSupported = false;
    console.error('claim_whatsapp_message is missing (migration 20261007090000 not applied): '
      + 'WhatsApp retries are de-duplicated per instance only. /api/health lists what is missing.');
  }
  const now = Date.now();
  for (const [id, at] of seenHere) if (now - at > 3_600_000) seenHere.delete(id);
  if (seenHere.has(messageId)) return false;
  seenHere.set(messageId, now);
  return true;
}

async function finishClaim(messageId, status, error = null) {
  if (!messageId || claimSupported === false) return;
  await db().from('processed_whatsapp_messages').update({
    status,
    processed_at: new Date().toISOString(),
    ...(error ? { error: String(error).slice(0, 500) } : {}),
  }).eq('message_id', messageId);
}

/**
 * Waits while an earlier message from the same chat is still being handled.
 * Bounded: a message never waits more than a few seconds, and a claim older
 * than two minutes is a crashed worker's, not one to wait for.
 */
async function waitForTurn(chatId, messageId) {
  if (claimSupported !== true) return;
  const { data: mine } = await db().from('processed_whatsapp_messages')
    .select('processed_at').eq('message_id', messageId).maybeSingle();
  if (!mine?.processed_at) return;

  const deadline = Date.now() + TURN_WAIT_MS;
  while (Date.now() < deadline) {
    const { data, error } = await db().from('processed_whatsapp_messages')
      .select('message_id')
      .eq('chat_id', chatId)
      .eq('status', 'processing')
      .neq('message_id', messageId)
      .lt('processed_at', mine.processed_at)
      .gte('processed_at', new Date(Date.now() - 120_000).toISOString())
      .limit(1);
    if (error || !data?.length) return;
    await sleep(250);
  }
}

/**
 * 'ok', 'warn' (the first message over the limit: one "slow down" reply) or
 * 'drop'. Counted from the claims table, which every instance shares; without
 * it, per instance.
 */
async function floodCheck(chatId) {
  let count = null;
  if (claimSupported === true) {
    const since = new Date(Date.now() - FLOOD_WINDOW_MS).toISOString();
    const { count: n, error } = await db().from('processed_whatsapp_messages')
      .select('message_id', { count: 'exact', head: true })
      .eq('chat_id', chatId)
      .gte('created_at', since);
    if (!error) count = n ?? 0;
  }
  if (count === null) {
    const now = Date.now();
    const times = (recentHere.get(chatId) ?? []).filter((t) => now - t < FLOOD_WINDOW_MS);
    times.push(now);
    recentHere.set(chatId, times);
    count = times.length;
  }
  if (count <= FLOOD_LIMIT) return 'ok';
  return count === FLOOD_LIMIT + 1 ? 'warn' : 'drop';
}

/** What the chat log records of an inbound message. */
function describe(message) {
  switch (message.type) {
    case 'text':
      return { kind: 'text', body: message.text?.body ?? '' };
    case 'interactive': {
      const reply = message.interactive?.button_reply ?? message.interactive?.list_reply;
      return { kind: 'choice', body: reply?.title ?? null, payload: { id: reply?.id ?? null } };
    }
    case 'button':
      return { kind: 'choice', body: message.button?.text ?? null, payload: { id: message.button?.payload ?? null } };
    case 'document':
    case 'image': {
      const media = message[message.type] ?? {};
      return {
        kind: message.type,
        body: media.caption ?? null,
        payload: { file_name: media.filename ?? null, mime_type: media.mime_type ?? null, media_id: media.id ?? null },
      };
    }
    case 'contacts':
      return { kind: 'contact', body: message.contacts?.[0]?.name?.formatted_name ?? null };
    default:
      return { kind: String(message.type ?? 'unknown'), body: null };
  }
}
