/**
 * Talking to customers from the desk: the conversation as they saw it, the
 * list of every conversation, and sending - once, on the right channel, in a
 * way that is honest about WhatsApp's rules.
 *
 * SENDING IS SAID ONCE. A message to a customer cannot be taken back, so a
 * double click, a retried request after a dropped connection, or two tabs must
 * all produce one message. The browser makes an action key per click and
 * repeats it on a retry; that key becomes a notification_outbox row, whose
 * idempotency_key is unique. The second attempt finds the first one's row and
 * reports what happened to it instead of sending again.
 *
 * WHEN THE CHANNEL CODE IS NOT THERE. lib/channels.js (another work package)
 * does the actual sending and logs to chat_messages. Until it is deployed, a
 * Telegram message goes the way the console always sent one - through the
 * outbox - and a WhatsApp message is refused with a sentence, never a crash.
 */

import { db } from '../supabase.js';
import { settings } from '../settings.js';
import { enqueue, drain } from '../outbox.js';
import { audit } from '../audit.js';
import { channels } from './channels-bridge.js';
import { channelOf } from '../channels.js';
import { customerFor, isMissingTable, HISTORY_PENDING, actionKeyOf, ago } from './desk-shared.js';
import { failureWords, DEFAULT_SAVED_REPLIES } from './desk-messages.js';
import { statusWords, statusTone, requestStatusWords, REQUEST_OPEN } from '../ops/workflow.js';
import { filesOf, placeOf, contactsOf } from './desk-media.js';
import { OUTBOUND_LIMITS, OUTBOUND_ACCEPT, DESK_UPLOAD_MAX_BYTES, MAX_FILES_PER_SEND, CAPTION_MAX } from '../chat-files.js';

export const MAX_TEXT = 4096;
const CHANNELS = ['telegram', 'whatsapp'];

const shortDate = (at) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Cairo' });

// ---------------------------------------------------------------------------
// WhatsApp's window, and what the composer may do
// ---------------------------------------------------------------------------

/**
 * Whether free text may be sent to this chat right now.
 *
 * lib/channels.js is the authority. Without it the desk estimates from the
 * last time the customer wrote, only so the screen can say "last wrote 2 days
 * ago" - nothing is sent on an estimate, because without that module nothing
 * can be sent to WhatsApp at all.
 */
export async function windowFor({ channel, chatId, customer }) {
  if (channel !== 'whatsapp') return { applies: false, open: true, known: true };

  const chan = await channels();
  if (typeof chan?.windowState === 'function') {
    try {
      const w = await chan.windowState({ channel, chatId });
      return {
        applies: w?.applies !== false,
        open: Boolean(w?.open),
        last_client_message_at: w?.lastClientMessageAt ?? null,
        closes_at: w?.closesAt ?? null,
        // false: the clock could not be read, so free text is allowed and
        // WhatsApp itself decides - the composer says exactly that.
        known: w?.known !== false,
      };
    } catch (err) {
      console.error('windowState failed:', err?.message);
    }
  }

  const hours = Number((await settings()).whatsapp_window_hours) || 24;
  const last = customer?.last_client_message_at ?? null;
  if (!last) return { applies: true, open: null, last_client_message_at: null, closes_at: null, known: false };
  const closes = new Date(new Date(last).getTime() + hours * 3600_000);
  return {
    applies: true,
    open: closes.getTime() > Date.now(),
    last_client_message_at: last,
    closes_at: closes.toISOString(),
    known: false,
  };
}

/**
 * What the composer may do, decided here so every screen that shows a composer
 * says the same thing, and so the rule is tested rather than drawn.
 *
 *   mode 'text'           free text may be sent
 *   mode 'template_only'  WhatsApp window closed: only the "please reply" template
 *   mode 'disabled'       nothing can be sent; `reason` says why
 */
export function composerState({ channel, chatId, customer, window: win, connected, templateAvailable }) {
  const name = customer?.name && customer.name !== 'Unknown customer' ? customer.name : 'The customer';
  const off = (reason) => ({ mode: 'disabled', can_send: false, reason, note: null });

  if (!chatId) return off('This customer has no chat we can write to.');
  if (!CHANNELS.includes(channel)) return off('This conversation was on the website widget. We cannot write back to it.');
  if (customer?.is_blocked) return off('This customer is blocked, so nothing can be sent to them.');
  if (channel === 'whatsapp' && !connected) return off('WhatsApp sending isn’t connected yet.');

  // A customer who wrote STOP gets nothing from us - unless they have written
  // again since, in which case answering their own message is still allowed.
  if (customer?.opted_out_at) {
    const since = customer.last_client_message_at && new Date(customer.last_client_message_at) > new Date(customer.opted_out_at);
    const windowOpen = channel !== 'whatsapp' || win?.open === true;
    if (!(since && windowOpen)) {
      return off(`${name} wrote STOP on ${shortDate(customer.opted_out_at)}. You can reply only after they write to us again.`);
    }
  }

  if (channel === 'whatsapp' && win?.open !== true) {
    const last = win?.last_client_message_at
      ? `${name} last wrote ${ago(win.last_client_message_at)}.`
      : `${name} has not written to us on WhatsApp yet.`;
    const rule = 'WhatsApp only allows an approved template once 24 hours have passed.';
    if (!templateAvailable) return off(`${last} ${rule} The template isn’t available yet.`);
    return {
      mode: 'template_only',
      can_send: false,
      reason: `${last} ${rule} Send the “please reply” template; when they answer you can write freely.`,
      note: null,
    };
  }

  return {
    mode: 'text',
    can_send: true,
    reason: null,
    note: channel === 'telegram' ? 'Telegram · no time limit'
      : win?.known === false ? 'We cannot tell when they last wrote. If 24 hours have passed, WhatsApp will refuse and you will see why.'
        : null,
  };
}

/** A customer who wrote STOP and has written again since: answering them is allowed. */
export const answeringAfterStop = (customer) => Boolean(customer?.opted_out_at && customer.last_client_message_at
  && new Date(customer.last_client_message_at) > new Date(customer.opted_out_at));

/** Everything a conversation panel needs to draw its composer. */
export async function composerFor({ channel, chatId, customer }) {
  const chan = await channels();
  const connected = Boolean(chan) || channel === 'telegram';
  const win = await windowFor({ channel, chatId, customer });
  const templateAvailable = typeof chan?.sendReopenTemplate === 'function';
  return {
    window: win,
    composer: composerState({ channel, chatId, customer, window: win, connected, templateAvailable }),
  };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const numeric = (v) => {
  const n = Number(String(v).replace(/[^0-9-]/g, ''));
  return Number.isSafeInteger(n) ? n : null;
};

/** What the earlier attempt with this action key came to. */
export async function earlierAttempt(key) {
  const { data: row } = await db().from('notification_outbox')
    .select('status, last_error, payload').eq('idempotency_key', key).maybeSingle();
  if (!row) return { ok: true, status: 'queued', duplicate: true };
  if (row.status === 'sent') return { ok: true, status: 'sent', duplicate: true };
  if (['failed', 'dead'].includes(row.status)) {
    const refused = row.payload?.refused ?? null;
    return { ok: false, status: refused ?? 'failed', duplicate: true, words: failureWords(row.last_error, { status: refused }) };
  }
  return { ok: true, status: 'queued', duplicate: true };
}

/**
 * Sends one message to one customer, once.
 *
 * @returns {Promise<{ok: boolean, status: string, words?: string, duplicate?: boolean}>}
 *   status: sent | queued | needs_template | opted_out | failed | not_connected | no_chat
 */
export async function sendToCustomer({
  who, channel, chatId, clientId = null, text, actionKey = null,
  bookingRef = null, entityType = 'chat', entityId = null,
  language = null, eventType = 'operations_message', allowTemplate = false,
  templatePayload = null, answering = false,
}) {
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, status: 'empty', words: 'The message is empty.' };
  if (body.length > MAX_TEXT) return { ok: false, status: 'too_long', words: `That is ${body.length} characters; a message can be at most ${MAX_TEXT}.` };
  if (!chatId) return { ok: false, status: 'no_chat', words: 'This customer has no chat we can write to.' };

  const chan = await channels();
  const viaOutbox = !chan && channel === 'telegram';
  if (!chan && !viaOutbox) return { ok: false, status: 'not_connected', words: failureWords('not connected') };

  const key = `desk:${actionKey ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`}`;
  // staff_name: the outbox logs a queued row carrying it as that person's message.
  const payload = { text: body, via: 'desk', staff_name: who.name, booking_ref: bookingRef };
  const entity = entityId ?? `${channel}:${chatId}`;

  if (viaOutbox) {
    const queued = await enqueue({
      chatId, clientId, channel, eventType: 'operations_message', entityType, entityId: entity,
      idempotencyKey: key, payload, language,
    });
    if (!queued.ok) return { ok: false, status: 'failed', words: failureWords(queued.error) };
    if (!queued.queued) return earlierAttempt(key);
    await drain({ limit: 5 }).catch(() => null);
    const { data: row } = await db().from('notification_outbox')
      .select('status, last_error').eq('idempotency_key', key).maybeSingle();
    if (row?.status === 'sent') return { ok: true, status: 'sent' };
    if (row?.status === 'dead') return { ok: false, status: 'failed', words: failureWords(row.last_error) };
    return { ok: true, status: 'queued', words: 'Queued. It will be tried again automatically.' };
  }

  // The claim. 'sending' rather than 'pending' so the outbox drain never picks
  // it up: this row records the send, lib/channels.js performs it.
  const claim = await db().from('notification_outbox').insert({
    client_id: clientId, channel, telegram_chat_id: channel === 'telegram' ? numeric(chatId) : null,
    // Always the plain-text event, whatever eventType tells lib/channels.js:
    // this row's payload IS the text, so if anything ever re-queued it, the
    // outbox would deliver exactly what the operator wrote and nothing else.
    chat_id: String(chatId), event_type: 'operations_message',
    entity_type: entityType, entity_id: entity, payload, status: 'sending', idempotency_key: key,
  });
  if (claim.error?.code === '23505') return earlierAttempt(key);
  if (claim.error) console.error('desk send ledger write failed, sending anyway:', claim.error.message);

  let result;
  try {
    result = await chan.sendToChat(
      { channel, chatId: String(chatId), clientId },
      { text: body },
      {
        author: 'staff', staffName: who.name, bookingRef, language, eventType, allowTemplate, answering,
        // What a template would be filled with if the window has closed.
        payload: { ...(templatePayload ?? {}), text: body, message: body, reference: templatePayload?.reference ?? bookingRef ?? entity },
      },
    );
  } catch (err) {
    result = { ok: false, status: 'failed', error: err?.message ?? 'send threw' };
  }

  const status = result?.ok ? 'sent' : (result?.status && result.status !== 'sent' ? result.status : 'failed');
  await db().from('notification_outbox').update(result?.ok
    ? { status: 'sent', sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    : {
        status: 'failed',
        last_error: `${status}${result?.error ? `: ${result.error}` : ''}`.slice(0, 500),
        payload: { ...payload, refused: status },
        updated_at: new Date().toISOString(),
      }).eq('idempotency_key', key);

  return result?.ok
    ? { ok: true, status: 'sent', provider_message_id: result.providerMessageId ?? null }
    : { ok: false, status, words: failureWords(result?.error, { status }) };
}

/** HTTP status for a send outcome: refusals by rule are 409, a missing channel 503. */
export const httpFor = (r) => (r.ok ? 200
  : ['needs_template', 'opted_out'].includes(r.status) ? 409
    : ['not_connected'].includes(r.status) ? 503
      : ['empty', 'too_long', 'no_chat'].includes(r.status) ? 400 : 502);

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Which chat a send is for: given directly, or the chat a booking/request came from. */
export async function targetOf(body) {
  if (body.booking_ref) {
    const { data: b } = await db().from('bookings')
      .select('booking_ref, channel, chat_id, client_id, customer_name, customer_contact')
      .eq('booking_ref', String(body.booking_ref)).maybeSingle();
    if (!b) return null;
    return { channel: b.channel ?? channelOf(b.chat_id), chatId: b.chat_id, clientId: b.client_id ?? null, bookingRef: b.booking_ref,
      entityType: 'booking', entityId: b.booking_ref, name: b.customer_name, contact: b.customer_contact };
  }
  if (body.ticket_ref) {
    const { data: t } = await db().from('support_tickets')
      .select('ticket_ref, channel, chat_id, client_id, customer, contact, booking_ref')
      .eq('ticket_ref', String(body.ticket_ref)).maybeSingle();
    if (!t) return null;
    return { channel: t.channel ?? channelOf(t.chat_id), chatId: t.chat_id, clientId: t.client_id ?? null, bookingRef: t.booking_ref ?? null,
      entityType: 'support_ticket', entityId: t.ticket_ref, name: t.customer, contact: t.contact };
  }
  const channel = String(body.channel ?? '');
  const chatId = String(body.chat_id ?? '');
  if (!CHANNELS.includes(channel) || !chatId) return null;
  return { channel, chatId, clientId: null, bookingRef: null, entityType: 'chat', entityId: `${channel}:${chatId}` };
}

/** POST { action: 'send_message', channel+chat_id | booking_ref | ticket_ref, text, action_key } */
export async function sendMessage(req, res, who) {
  const body = req.body ?? {};
  const target = await targetOf(body);
  if (!target) return res.status(404).json({ error: 'We could not find that conversation.' });

  const customer = await customerFor({ clientId: target.clientId, channel: target.channel, chatId: target.chatId, name: target.name, contact: target.contact });
  const { composer } = await composerFor({ channel: target.channel, chatId: target.chatId, customer });
  // Checked again here, not just drawn: the window can close while the
  // operator types, and a refusal now is better than one from Meta later.
  if (!composer.can_send) {
    const status = composer.mode === 'template_only' ? 'needs_template' : 'refused';
    return res.status(409).json({ error: composer.reason, status, composer });
  }

  const sent = await sendToCustomer({
    who, channel: target.channel, chatId: target.chatId, clientId: customer.client_id ?? target.clientId,
    text: body.text, actionKey: actionKeyOf(body), bookingRef: target.bookingRef,
    entityType: target.entityType, entityId: target.entityId, language: customer.language,
    answering: answeringAfterStop(customer),
  });

  if (sent.ok && !sent.duplicate) {
    await audit({
      actor_type: 'operator', actor_id: who.name, action: 'client_message_sent',
      entity_type: target.entityType, entity_id: target.entityId,
      metadata: { chars: String(body.text ?? '').trim().length, channel: target.channel, status: sent.status },
    });
  }
  if (!sent.ok) {
    // Our clock said the window was open; WhatsApp disagreed. The answer
    // carries the composer as it is now, so the screen offers the template
    // instead of a Send button that will be refused again.
    const now = ['needs_template', 'opted_out'].includes(sent.status)
      ? (await composerFor({ channel: target.channel, chatId: target.chatId, customer })).composer : undefined;
    return res.status(httpFor(sent)).json({ error: sent.words ?? 'It did not go through.', ...sent, composer: now });
  }
  return res.status(200).json(sent);
}

/** POST { action: 'send_reopen_template', channel, chat_id | booking_ref | ticket_ref, action_key } */
export async function sendReopenTemplate(req, res, who) {
  const body = req.body ?? {};
  const target = await targetOf(body);
  if (!target) return res.status(404).json({ error: 'We could not find that conversation.' });
  if (target.channel !== 'whatsapp') return res.status(400).json({ error: 'The “please reply” template is only for WhatsApp.' });

  const chan = await channels();
  if (typeof chan?.sendReopenTemplate !== 'function') {
    return res.status(503).json({ error: 'WhatsApp sending isn’t connected yet.', status: 'not_connected' });
  }

  const customer = await customerFor({ clientId: target.clientId, channel: target.channel, chatId: target.chatId, name: target.name });
  if (customer.opted_out_at) {
    return res.status(409).json({ error: `${customer.name} wrote STOP on ${shortDate(customer.opted_out_at)}. No template can be sent.`, status: 'opted_out' });
  }

  const key = `desk:${actionKeyOf(body) ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`}`;
  const claim = await db().from('notification_outbox').insert({
    client_id: customer.client_id, channel: 'whatsapp', chat_id: String(target.chatId),
    // Not 'operations_message': this row must never be rendered as free text
    // by the outbox, which is exactly what WhatsApp would refuse here.
    event_type: 'desk_reopen_template', entity_type: target.entityType, entity_id: target.entityId,
    payload: { via: 'desk', staff: who.name, kind: 'template' }, status: 'sending', idempotency_key: key,
  });
  if (claim.error?.code === '23505') {
    const earlier = await earlierAttempt(key);
    return res.status(earlier.ok ? 200 : 502).json(earlier.ok ? earlier : { error: earlier.words, ...earlier });
  }

  let result;
  try {
    result = await chan.sendReopenTemplate(
      { channel: 'whatsapp', chatId: String(target.chatId), clientId: customer.client_id },
      { staffName: who.name, language: customer.language },
    );
  } catch (err) {
    result = { ok: false, status: 'failed', error: err?.message };
  }
  await db().from('notification_outbox').update(result?.ok
    ? { status: 'sent', sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    : { status: 'failed', last_error: String(result?.error ?? result?.status ?? 'failed').slice(0, 500), updated_at: new Date().toISOString() })
    .eq('idempotency_key', key);

  if (!result?.ok) {
    const words = failureWords(result?.error, { status: result?.status });
    return res.status(502).json({ error: words, status: result?.status ?? 'failed', words });
  }
  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'whatsapp_reopen_sent',
    entity_type: target.entityType, entity_id: target.entityId, metadata: { channel: 'whatsapp' },
  });
  return res.status(200).json({ ok: true, status: 'sent' });
}

/** POST { action: 'retry_message', message_id, action_key } - a failed message, sent again. */
export async function retryMessage(req, res, who) {
  const id = Number(req.body?.message_id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'message_id is required' });

  const { data: m, error } = await db().from('chat_messages').select('*').eq('id', id).maybeSingle();
  if (isMissingTable(error)) return res.status(503).json({ error: HISTORY_PENDING });
  if (!m) return res.status(404).json({ error: 'That message is no longer here.' });
  if (m.direction !== 'out' || m.status !== 'failed') {
    return res.status(409).json({ error: 'Only a message of ours that failed can be sent again.' });
  }
  // A file the desk sent is kept; it goes again from where it is stored.
  if (resendableFile(m)) {
    const { resendFile } = await import('./desk-files.js');
    return resendFile(req, res, who, m, () => markRetried(who, id));
  }
  if (m.kind && !['text', 'template'].includes(m.kind)) {
    return res.status(400).json({ error: 'Only text and files sent from the desk can be sent again from here.' });
  }

  let outcome;
  if (m.kind === 'template') {
    const sub = { ...req, body: { ...req.body, channel: m.channel, chat_id: m.chat_id } };
    return sendReopenTemplate(sub, wrapRes(res, async (ok) => {
      if (ok) await markRetried(who, id);
    }), who);
  }

  const customer = await customerFor({ clientId: m.client_id, channel: m.channel, chatId: m.chat_id });
  const { composer } = await composerFor({ channel: m.channel, chatId: m.chat_id, customer });
  if (!composer.can_send) {
    return res.status(409).json({ error: composer.reason, status: composer.mode === 'template_only' ? 'needs_template' : 'refused' });
  }
  outcome = await sendToCustomer({
    who, channel: m.channel, chatId: m.chat_id, clientId: m.client_id, text: m.body,
    actionKey: actionKeyOf(req.body) ?? `retry-${id}-${Date.now().toString(36)}`,
    bookingRef: m.booking_ref ?? null, entityType: 'chat', entityId: `${m.channel}:${m.chat_id}`, language: customer.language,
    answering: answeringAfterStop(customer),
  });
  if (!outcome.ok) return res.status(httpFor(outcome)).json({ error: outcome.words, ...outcome });
  await markRetried(who, id);
  return res.status(200).json(outcome);
}

async function markRetried(who, id) {
  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'message_retried',
    entity_type: 'problem', entity_id: `message:${id}`, metadata: {},
  });
}

/** Lets a nested handler's response be observed before it is passed on. */
function wrapRes(res, onDone) {
  let code = 200;
  return {
    status(c) { code = c; return this; },
    async json(body) { await onDone(code < 300); return res.status(code).json(body); },
  };
}

/** POST { action: 'retry_outbox', outbox_id } - a notification that died, queued again. */
export async function retryOutbox(req, res, who) {
  const id = Number(req.body?.outbox_id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'outbox_id is required' });

  const { data: rows, error } = await db().from('notification_outbox')
    .update({ status: 'pending', attempt_count: 0, available_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id).in('status', ['dead', 'failed']).select('id');
  if (error) return res.status(500).json({ error: 'We could not queue it again.' });
  if (!rows?.length) return res.status(409).json({ error: 'That notification is no longer failed — somebody may have retried it already.' });

  await drain({ limit: 5 }).catch(() => null);
  const { data: row } = await db().from('notification_outbox').select('status, last_error').eq('id', id).maybeSingle();
  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'outbox_retried',
    entity_type: 'problem', entity_id: `outbox:${id}`, metadata: { result: row?.status ?? null },
  });
  if (row?.status === 'dead') return res.status(502).json({ error: failureWords(row.last_error), status: 'failed' });
  return res.status(200).json({ ok: true, status: row?.status === 'sent' ? 'sent' : 'queued' });
}

/**
 * POST { action: 'dismiss_problem', problem_id: 'message:1' | 'outbox:2' | 'document:3' | 'chat:whatsapp:wa:2010…' }
 *
 * A chat's failures are one problem in the inbox (lib/admin/desk-inbox.js),
 * and set aside together: everything that failed in that chat up to now.
 */
export async function dismissProblem(req, res, who) {
  const id = String(req.body?.problem_id ?? '');
  const valid = /^(message|outbox|document):\d+$/.test(id) || /^chat:(telegram|whatsapp|web):[\w:.+-]{1,120}$/.test(id);
  if (!valid) return res.status(400).json({ error: 'problem_id is required' });
  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'problem_dismissed',
    entity_type: 'problem', entity_id: id, metadata: { note: String(req.body?.note ?? '').slice(0, 200) || null },
  });
  return res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** Saved replies from Settings, or the defaults until somebody sets their own. */
export async function savedReplies() {
  const cfg = await settings();
  const list = Array.isArray(cfg.saved_replies) ? cfg.saved_replies : null;
  return (list && list.length ? list : DEFAULT_SAVED_REPLIES)
    .filter((r) => r && (r.en || r.ar))
    .map((r) => ({ title: String(r.title ?? '').slice(0, 60), en: String(r.en ?? ''), ar: String(r.ar ?? '') }));
}

/**
 * A tapped button arrives as the engine's payload - "lang:ar", "bk:phone:own",
 * "menu:book" - which is routing, not something the customer said. The desk
 * shows what they tapped when the transport kept the button's title, and
 * "Tapped a button" when it did not; never the raw id.
 */
// 'choice' is what the webhooks log a tap as (api/whatsapp.js, api/telegram.js):
// on WhatsApp its body is the button's title, on Telegram the payload. Missing
// from this list, every WhatsApp tap showed as a message the customer typed.
const TAP_KINDS = new Set(['choice', 'callback', 'button', 'interactive', 'button_reply', 'list_reply', 'tap']);
// Only the engine's own namespaces (lib/flow/keyboards.js), lower case and
// with no spaces - so a customer typing "VIN: YV2…" is never mistaken for a tap.
const PAYLOAD = /^(menu|bk|ct|lang|tr):[a-z0-9_:.-]*$/;

export function displayBody(m) {
  const body = m.body ?? '';
  const tapped = m.direction === 'in' && (TAP_KINDS.has(m.kind) || PAYLOAD.test(body.trim()));
  if (!tapped) return { kind: m.kind ?? 'text', body };
  // A choice's body is the title the customer saw, unless it is the payload itself.
  const said = m.kind === 'choice' && body.trim() && !PAYLOAD.test(body.trim()) ? body.trim() : null;
  const title = m.payload?.title ?? m.payload?.button_title ?? m.payload?.text ?? said ?? null;
  // The title separately as well, so the desk can isolate an Arabic title
  // from the English around it instead of letting the two scripts reorder.
  return { kind: 'tap', body: title ? `Tapped “${title}”` : 'Tapped a button', tap_title: title };
}

/** A file the desk sent, kept, that can be sent again as it was. */
export const resendableFile = (m) => m.direction === 'out' && m.author === 'staff' && ['document', 'image'].includes(m.kind)
  && Boolean(m.payload?.storage_path && m.payload?.outbound);

const messageOut = (m, retried, files = new Map()) => ({
  id: m.id,
  direction: m.direction,
  author: m.author,
  staff_name: m.staff_name ?? null,
  ...displayBody(m),
  // A file's own name, so the desk can show it as a file - the body of a
  // file message is only its caption, often empty.
  file_name: m.payload?.file_name ?? null,
  // What there is to show of a file, and how to fetch it (lib/admin/desk-media.js).
  file: files.get(m.id) ?? null,
  location: placeOf(m),
  contacts: contactsOf(m),
  language: m.language ?? null,
  booking_ref: m.booking_ref ?? null,
  status: m.status,
  error: m.error ?? null,
  error_words: m.status === 'failed' ? failureWords(m.error, { template: m.payload?.template ?? null }) : null,
  at: m.created_at,
  retried: retried.has(`message:${m.id}`),
  retryable: m.direction === 'out' && m.status === 'failed'
    && (['text', 'template', null, undefined].includes(m.kind) || resendableFile(m))
    && !retried.has(`message:${m.id}`),
});

/** What a file message says in the chat list, where there is room for one line. */
function previewOf(m, body) {
  if (body || !m) return body;
  const name = m.payload?.file_name;
  switch (m.kind) {
    case 'image': return 'Photo';
    case 'document': return name ? `File: ${name}` : 'File';
    case 'audio': return m.payload?.voice ? 'Voice note' : 'Audio';
    case 'video': return 'Video';
    case 'sticker': return 'Sticker';
    case 'location': return 'Location';
    case 'contact': return 'Contact card';
    default: return body;
  }
}

/** What the composer may attach on this channel - the server checks again on every file. */
function attachFor(channel, composer) {
  const limits = OUTBOUND_LIMITS[channel];
  if (!limits || composer.mode !== 'text') return null;
  return {
    accept: OUTBOUND_ACCEPT,
    image_max: Math.min(limits.image, DESK_UPLOAD_MAX_BYTES),
    document_max: Math.min(limits.document, DESK_UPLOAD_MAX_BYTES),
    // A photo too big to go as a photo goes as a file on Telegram; WhatsApp has no such way.
    big_photo_as_file: channel === 'telegram',
    max_files: MAX_FILES_PER_SEND,
    caption_max: CAPTION_MAX,
  };
}

/** Which failed messages have been sent again or set aside already. */
async function handledProblems(ids) {
  if (!ids.length) return new Set();
  const { data } = await db().from('audit_logs').select('entity_id, action')
    .in('entity_id', ids).in('action', ['message_retried', 'problem_dismissed']);
  return new Set((data ?? []).map((r) => r.entity_id));
}

/**
 * GET view=chat&channel=&chat_id=&before= - one conversation, newest 60
 * messages (older on request), with what the composer may do.
 */
export async function chatView(req, res) {
  const channel = String(req.query.channel ?? '');
  const chatId = String(req.query.chat_id ?? '');
  if (!channel || !chatId) return res.status(400).json({ error: 'channel and chat_id are required' });
  const before = Number(req.query.before) || null;
  const limit = Math.min(Number(req.query.limit) || 60, 200);

  const conv = await conversationFor({ channel, chatId, before, limit, name: req.query.name ?? null });

  const [{ data: bookings }, { data: tickets }] = await Promise.all([
    db().from('bookings').select('booking_ref, status, vin, make, model, origin_port, destination_port, created_at')
      .eq('chat_id', chatId).neq('status', 'draft').order('created_at', { ascending: false }).limit(10),
    db().from('support_tickets').select('ticket_ref, status, department, summary, created_at')
      .eq('chat_id', chatId).order('created_at', { ascending: false }).limit(5),
  ]);

  return res.status(200).json({
    ...conv,
    bookings: (bookings ?? []).map((b) => ({ ...b, status_words: statusWords(b.status), tone: statusTone(b.status) })),
    requests: (tickets ?? []).map((t) => ({ ...t, status_words: requestStatusWords(t.status), open: REQUEST_OPEN.includes(t.status) })),
  });
}

/** The transcript and composer for one chat; shared by the case page and Chats. */
export async function conversationFor({ channel, chatId, before = null, limit = 60, clientId = null, name = null, contact = null }) {
  const customer = await customerFor({ clientId, channel, chatId, name, contact });
  const { window: win, composer } = await composerFor({ channel, chatId, customer });

  let query = db().from('chat_messages').select('*')
    .eq('channel', channel).eq('chat_id', String(chatId))
    .order('created_at', { ascending: false }).limit(limit + 1);
  if (before) query = query.lt('id', before);
  const { data, error } = await query;

  const available = !error;
  if (error && !isMissingTable(error)) console.error('chat_messages read failed:', error.message);
  const rows = (data ?? []).slice(0, limit);
  const failedIds = rows.filter((m) => m.status === 'failed').map((m) => `message:${m.id}`);
  const [retried, files] = await Promise.all([
    handledProblems(failedIds),
    filesOf(channel, chatId, rows).catch((err) => { console.error('chat files failed:', err?.message); return new Map(); }),
  ]);

  return {
    channel,
    chat_id: String(chatId),
    available,
    notice: available ? null : (isMissingTable(error) ? HISTORY_PENDING : 'We could not load this conversation. Try again.'),
    customer,
    window: win,
    composer,
    attach: attachFor(channel, composer),
    messages: rows.reverse().map((m) => messageOut(m, retried, files)),
    has_more: (data ?? []).length > limit,
    saved_replies: await savedReplies(),
  };
}

/**
 * GET view=chats&q=&offset= - every conversation, newest first.
 *
 * Built from the messages themselves when that table exists, because "when did
 * this chat last move" is a message, not a session save. Sessions are merged
 * in so a chat that predates the message log still appears.
 */
export async function chatsView(req, res) {
  const q = String(req.query.q ?? '').trim().toLowerCase();
  // "Show more" asks for 50 more each time; the list is grouped in memory anyway.
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const [{ data: msgs, error: msgErr }, { data: sessions }] = await Promise.all([
    db().from('chat_messages').select('*').order('created_at', { ascending: false }).limit(2000),
    db().from('conversation_sessions').select('*').order('updated_at', { ascending: false }).limit(400),
  ]);
  const available = !msgErr;
  if (msgErr && !isMissingTable(msgErr)) console.error('chat_messages read failed:', msgErr.message);

  const chats = new Map();
  for (const m of msgs ?? []) {
    if (!CHANNELS.includes(m.channel)) continue;
    const k = `${m.channel}|${m.chat_id}`;
    let c = chats.get(k);
    if (!c) {
      c = { channel: m.channel, chat_id: String(m.chat_id), client_id: m.client_id ?? null, last: m, last_in_at: null, at: m.created_at, failed: [] };
      chats.set(k, c);
    }
    if (!c.client_id && m.client_id) c.client_id = m.client_id;
    if (m.direction === 'in' && !c.last_in_at) c.last_in_at = m.created_at;
    if (m.direction === 'out' && m.status === 'failed') c.failed.push(`message:${m.id}`);
  }
  for (const s of sessions ?? []) {
    if (!CHANNELS.includes(s.channel)) continue;
    const k = `${s.channel}|${s.chat_id}`;
    const c = chats.get(k);
    if (c) { if (!c.client_id && s.client_id) c.client_id = s.client_id; continue; }
    chats.set(k, {
      channel: s.channel, chat_id: String(s.chat_id), client_id: s.client_id ?? null,
      last: null, last_in_at: s.last_client_message_at ?? null, at: s.last_client_message_at ?? s.updated_at, failed: [],
    });
  }

  const list = [...chats.values()];
  const clientIds = [...new Set(list.map((c) => c.client_id).filter(Boolean))];
  const chatIds = [...new Set(list.map((c) => c.chat_id))];
  const [{ data: clients }, { data: bookings }] = await Promise.all([
    clientIds.length ? db().from('clients').select('*').in('id', clientIds) : { data: [] },
    chatIds.length ? db().from('bookings').select('chat_id, customer_name, booking_ref, created_at')
      .in('chat_id', chatIds).neq('status', 'draft').order('created_at', { ascending: false }) : { data: [] },
  ]);
  const clientById = new Map((clients ?? []).map((c) => [c.id, c]));
  const nameByChat = new Map();
  const refsByChat = new Map();
  for (const b of bookings ?? []) {
    if (!nameByChat.has(b.chat_id) && b.customer_name) nameByChat.set(b.chat_id, b.customer_name);
    refsByChat.set(b.chat_id, [...(refsByChat.get(b.chat_id) ?? []), b.booking_ref]);
  }
  const retried = await handledProblems(list.flatMap((c) => c.failed));

  let out = list.map((c) => {
    const cl = clientById.get(c.client_id) ?? null;
    const profile = cl?.whatsapp_name || cl?.display_name || null;
    const phone = cl?.phone || (cl?.whatsapp_id ? `+${cl.whatsapp_id}` : c.channel === 'whatsapp' ? `+${c.chat_id.replace(/^wa:/, '')}` : null);
    const body = c.last ? previewOf(c.last, displayBody(c.last).body) : '';
    return {
      key: `${c.channel}|${c.chat_id}`,
      channel: c.channel,
      chat_id: c.chat_id,
      client_id: c.client_id,
      name: nameByChat.get(c.chat_id) || cl?.company || profile || cl?.telegram_username || phone || `Chat ${c.chat_id}`,
      profile_name: profile,
      phone,
      language: ['en', 'ar'].includes(cl?.language) ? cl.language : null,
      opted_out: Boolean(cl?.opted_out_at),
      last: c.last ? {
        body: body.length > 160 ? `${body.slice(0, 160)}…` : body,
        direction: c.last.direction, author: c.last.author, staff_name: c.last.staff_name ?? null,
        kind: c.last.kind ?? 'text', status: c.last.status, at: c.last.created_at,
      } : null,
      last_in_at: c.last_in_at,
      at: c.at,
      failed: c.failed.filter((id) => !retried.has(id)).length,
      booking_refs: (refsByChat.get(c.chat_id) ?? []).slice(0, 3),
    };
  });

  if (q) {
    const digits = q.replace(/\D/g, '');
    out = out.filter((c) => [c.name, c.profile_name, c.chat_id, ...(c.booking_refs ?? [])]
      .some((v) => String(v ?? '').toLowerCase().includes(q))
      || (digits.length >= 4 && String(c.phone ?? '').replace(/\D/g, '').includes(digits)));
  }
  out.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));

  return res.status(200).json({
    available,
    notice: available ? null : HISTORY_PENDING,
    total: out.length,
    offset,
    has_more: offset + limit < out.length,
    chats: out.slice(offset, offset + limit),
  });
}
