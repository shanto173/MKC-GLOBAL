/**
 * Sending papers and photos to a customer from the desk.
 *
 * TWO STEPS, NEITHER TRUSTING THE BROWSER.
 *
 *   1. POST { action: 'chat_upload', <conversation>, file_name, mime_type, size, action_key }
 *      The server checks the channel will take a file like that - and that a
 *      message could be sent at all right now - and answers with a one-off
 *      signed address in the private bucket (<customer>/outbound/<key>-<name>).
 *      The browser PUTs the bytes there directly: they never pass through
 *      this API (whose requests stop at 4.5 MB on Vercel), and the service
 *      key never leaves the server.
 *
 *   2. POST { action: 'send_files', <conversation>, files: [{ path, file_name, mime_type }],
 *             caption, file_on_booking, action_key }
 *      The server reads each file back from storage, checks its size and its
 *      first bytes against what it claims to be, sends it on the customer's
 *      channel - WhatsApp as a photo or a document, Telegram sendPhoto or
 *      sendDocument - and logs it in chat_messages with where it is kept, so
 *      the conversation shows it with its delivery ticks and can send it again.
 *
 * SENT ONCE. Each file is claimed in notification_outbox under the batch's
 * action key and its place in the batch, exactly as a typed message is
 * (desk-chat.js): a double click, or Send pressed again after a dropped
 * connection, finds the claim and reports what became of the first attempt.
 * The upload is idempotent too - the same key is the same path.
 *
 * THE WINDOW. Outside WhatsApp's 24 hours a file cannot go (Meta allows only
 * an approved template), so the desk refuses before anything is uploaded and
 * offers the "please reply" template, as it does for text. It does not queue
 * the file to go whenever they write: a quote or a confirmation that arrives
 * hours later, unattended, may be out of date by then, and once they reply the
 * files are still attached in the composer and go with one press.
 *
 * FILED ON THE BOOKING, when asked: a copy goes on the booking's documents as
 * an "MKY document" (doc_type 'mky') - shown apart from the customer's papers,
 * marked "Sent by MKY", never counted as a required paper, never to check.
 */

import { db } from '../supabase.js';
import { audit } from '../audit.js';
import { BUCKET, downloadDocument, signedUploadUrl, signedUrl } from '../storage.js';
import { patchChatMessage } from '../chatlog.js';
import { channels } from './channels-bridge.js';
import { customerFor, actionKeyOf } from './desk-shared.js';
import { failureWords } from './desk-messages.js';
import { targetOf, composerFor, answeringAfterStop, earlierAttempt, httpFor } from './desk-chat.js';
import {
  planOutbound, bytesMatch, outboundPath, isOutboundPathFor, MAX_FILES_PER_SEND, CAPTION_MAX,
} from '../chat-files.js';

/** Above this, WhatsApp is given a link to fetch the file from rather than the bytes. */
const WHATSAPP_UPLOAD_MAX = 16 * 1024 * 1024;

const refusedByRule = (status) => ['needs_template', 'opted_out', 'refused'].includes(status);

/** The conversation, its customer and what the composer may do - or the answer that ends the request. */
async function conversationOf(body, res) {
  const target = await targetOf(body);
  if (!target) return { done: res.status(404).json({ error: 'We could not find that conversation.' }) };
  const customer = await customerFor({ clientId: target.clientId, channel: target.channel, chatId: target.chatId, name: target.name, contact: target.contact });
  const { composer } = await composerFor({ channel: target.channel, chatId: target.chatId, customer });
  if (!composer.can_send) {
    const status = composer.mode === 'template_only' ? 'needs_template' : 'refused';
    return { done: res.status(409).json({ error: composer.reason, status, composer }) };
  }
  return { target, customer, owner: { clientId: customer.client_id ?? target.clientId ?? null, chatId: target.chatId } };
}

/** POST { action: 'chat_upload', … } - where the browser may put one file. */
export async function chatUpload(req, res) {
  const body = req.body ?? {};
  const key = actionKeyOf(body);
  if (!key) return res.status(400).json({ error: 'action_key is required' });
  const conv = await conversationOf(body, res);
  if (conv.done) return conv.done;
  const plan = planOutbound({ channel: conv.target.channel, mimeType: body.mime_type, size: body.size, fileName: body.file_name });
  if (!plan.ok) return res.status(400).json({ error: plan.words, reason: plan.reason });

  const path = outboundPath({ ...conv.owner, key, fileName: body.file_name, ext: plan.ext });
  const upload = await signedUploadUrl(path);
  if (!upload) return res.status(502).json({ error: 'We could not get a place to upload the file. Try again.' });
  return res.status(200).json({ path, upload_url: upload.url, kind: plan.kind, mime_type: plan.mime });
}

/**
 * One file, once. Shared by send_files and by Retry on a file that failed.
 *
 * @returns {Promise<{ok: boolean, status: string, words?: string, duplicate?: boolean,
 *                    provider_message_id?: string|null, document_id?: number|null}>}
 */
async function sendOneFile({ who, chan, target, customer, owner, file, caption, key, fileOn }) {
  const name = String(file.file_name ?? '').trim().slice(0, 200) || 'file';
  const path = String(file.path ?? '');
  // Only a path the desk handed out for this customer: never another
  // customer's paper, never a path typed into a request.
  if (!isOutboundPathFor(path, owner)) {
    return { ok: false, status: 'refused', words: `${name} was not uploaded for this conversation. Attach it again.` };
  }

  const claimKey = `desk:${key}`;
  const payload = { via: 'desk', staff_name: who.name, kind: 'file', file_name: name, storage_path: path, booking_ref: fileOn?.booking_ref ?? target.bookingRef ?? null };
  const claim = await db().from('notification_outbox').insert({
    client_id: owner.clientId, channel: target.channel, chat_id: String(target.chatId),
    telegram_chat_id: target.channel === 'telegram' && /^-?\d+$/.test(String(target.chatId)) ? Number(target.chatId) : null,
    // Its own event: this row records a file the desk sent, and is never
    // rendered as text by the outbox.
    event_type: 'desk_file', entity_type: target.entityType, entity_id: target.entityId,
    payload, status: 'sending', idempotency_key: claimKey,
  });
  if (claim.error?.code === '23505') return earlierAttempt(claimKey);
  if (claim.error) console.error('desk file ledger write failed, sending anyway:', claim.error.message);

  const finish = async (result) => {
    await db().from('notification_outbox').update(result.ok
      ? { status: 'sent', sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }
      : { status: 'failed', last_error: `${result.status}${result.error ? `: ${result.error}` : ''}`.slice(0, 500), payload: { ...payload, refused: result.status }, updated_at: new Date().toISOString() })
      .eq('idempotency_key', claimKey);
    return result;
  };

  const buffer = await downloadDocument(path, { quiet: true });
  if (!buffer) return finish({ ok: false, status: 'missing', words: `${name} did not finish uploading. Attach it again.` });
  const plan = planOutbound({ channel: target.channel, mimeType: file.mime_type, size: buffer.length, fileName: name });
  if (!plan.ok) return finish({ ok: false, status: 'refused', words: plan.words });
  if (!bytesMatch(plan.ext, buffer)) {
    return finish({ ok: false, status: 'refused', words: `${name} is not really a ${plan.ext.toUpperCase()} file. Save it again and attach it.` });
  }

  // A big file is fetched by Meta from a link that lasts an hour, rather than
  // pushed through this request.
  const link = target.channel === 'whatsapp' && plan.kind === 'document' && buffer.length > WHATSAPP_UPLOAD_MAX
    ? await signedUrl(path, 3600) : null;
  let result;
  try {
    result = await chan.sendToChat(
      { channel: target.channel, chatId: String(target.chatId), clientId: owner.clientId },
      { document: { buffer: link ? null : buffer, link, fileName: name, caption, mimeType: plan.mime, asPhoto: plan.kind === 'image' } },
      {
        author: 'staff', staffName: who.name, bookingRef: fileOn?.booking_ref ?? target.bookingRef ?? null,
        language: customer.language, eventType: 'operations_message', allowTemplate: false,
        answering: answeringAfterStop(customer),
        // Kept on the log row, so the conversation shows the file and Retry can send it again.
        logPayload: { storage_bucket: BUCKET, storage_path: path, size: buffer.length, mime_type: plan.mime, outbound: true },
      },
    );
  } catch (err) {
    result = { ok: false, status: 'failed', error: err?.message ?? 'send threw' };
  }
  const status = result?.ok ? 'sent' : (result?.status && result.status !== 'sent' ? result.status : 'failed');
  if (!result?.ok) return finish({ ok: false, status, error: result?.error, words: failureWords(result?.error, { status }) });

  let documentId = null;
  if (fileOn) {
    documentId = await fileOnBooking({ who, booking: fileOn, owner, name, path, plan, size: buffer.length, providerMessageId: result.providerMessageId ?? null });
    if (documentId && result.providerMessageId) await patchChatMessage(target.channel, result.providerMessageId, { document_id: documentId });
  }
  return finish({ ok: true, status: 'sent', provider_message_id: result.providerMessageId ?? null, document_id: documentId, kind: plan.kind });
}

/** A copy of a file MKY sent, on the booking's documents as an MKY document. */
async function fileOnBooking({ who, booking, owner, name, path, plan, size, providerMessageId }) {
  const at = new Date().toISOString();
  const { data, error } = await db().from('booking_documents').insert({
    booking_ref: booking.booking_ref,
    // No chat: the bot looks for the customer's papers by chat (lib/documents.js),
    // and a paper of ours must never count among theirs.
    chat_id: null,
    client_id: owner.clientId,
    channel: booking.channel ?? null,
    doc_type: 'mky',
    file_name: name,
    storage_path: path,
    storage_bucket: BUCKET,
    mime_type: plan.mime,
    size_bytes: size,
    status: 'verified',
    uploaded_by: who.name,
    extraction_ok: true,
    needs_ocr: false,
    extracted: { pending: false, ok: true, outbound: true, sent_by: who.name, sent_at: at, provider_message_id: providerMessageId },
    uploaded_at: at,
  }).select('id').single();
  if (error) {
    console.error('filing an MKY document failed:', error.message);
    return null;
  }
  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'mky_document_filed',
    entity_type: 'booking', entity_id: booking.booking_ref, metadata: { document_id: data.id, file_name: name },
  });
  return data.id;
}

/** The booking a copy is filed on: the case's own, or one of this customer's, by reference. */
async function bookingToFileOn(body, target) {
  if (!body.file_on_booking) return { booking: null };
  const ref = body.file_on_booking === true ? target.bookingRef : String(body.file_on_booking);
  if (!ref) return { error: 'Say which booking to file the copy on.' };
  const { data: b } = await db().from('bookings').select('booking_ref, chat_id, channel, client_id').eq('booking_ref', ref).maybeSingle();
  if (!b) return { error: `There is no booking ${ref}.` };
  if (String(b.chat_id ?? '') !== String(target.chatId)) return { error: `${ref} is not this customer’s booking.` };
  return { booking: b };
}

/** POST { action: 'send_files', … } - the files, in order, with the caption on the first. */
export async function sendFiles(req, res, who) {
  const body = req.body ?? {};
  const files = Array.isArray(body.files) ? body.files.filter((f) => f && typeof f === 'object') : [];
  if (!files.length) return res.status(400).json({ error: 'Attach at least one file.' });
  if (files.length > MAX_FILES_PER_SEND) return res.status(400).json({ error: `Send at most ${MAX_FILES_PER_SEND} files at a time.` });
  const caption = String(body.caption ?? '').trim();
  if (caption.length > CAPTION_MAX) {
    return res.status(400).json({ error: `A caption can be at most ${CAPTION_MAX} characters; this one is ${caption.length}. Send the words as a message of their own.` });
  }

  const conv = await conversationOf(body, res);
  if (conv.done) return conv.done;
  const { target, customer, owner } = conv;
  const filing = await bookingToFileOn(body, target);
  if (filing.error) return res.status(400).json({ error: filing.error });

  const chan = await channels();
  if (!chan) return res.status(503).json({ error: failureWords('not connected'), status: 'not_connected' });

  const key = actionKeyOf(body) ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const results = [];
  for (const [i, file] of files.entries()) {
    const r = await sendOneFile({
      who, chan, target, customer, owner, file, caption: i === 0 ? caption : '', key: `${key}:f${i}`, fileOn: filing.booking,
    });
    results.push({ index: i, file_name: String(file.file_name ?? ''), ...r });
    // Refused by rule (the window closed meanwhile, STOP): the rest would be too.
    if (!r.ok && refusedByRule(r.status) && !r.duplicate) {
      for (let j = i + 1; j < files.length; j++) {
        results.push({ index: j, file_name: String(files[j].file_name ?? ''), ok: false, status: 'not_sent', words: 'Not sent, because the one before it was refused.' });
      }
      break;
    }
  }

  const sent = results.filter((r) => r.ok && !r.duplicate);
  if (sent.length) {
    await audit({
      actor_type: 'operator', actor_id: who.name, action: 'client_file_sent',
      entity_type: target.entityType, entity_id: target.entityId,
      metadata: { files: sent.length, channel: target.channel, names: sent.map((r) => r.file_name).slice(0, 10), filed_on: filing.booking?.booking_ref ?? null },
    });
  }
  const first = results.find((r) => !r.ok);
  if (results.every((r) => !r.ok) && first && refusedByRule(first.status)) {
    // Our clock said the window was open and WhatsApp disagreed: the answer
    // carries the composer as it is now, with the template to send instead.
    const now = (await composerFor({ channel: target.channel, chatId: target.chatId, customer })).composer;
    return res.status(409).json({ error: first.words, status: first.status, results, composer: now });
  }
  return res.status(200).json({ ok: results.every((r) => r.ok), results, sent: sent.length, filed_on: filing.booking?.booking_ref ?? null });
}

/** Retry on a file the desk sent that failed: the same file, from storage, once more. */
export async function resendFile(req, res, who, m, onSent) {
  const conv = await conversationOf({ channel: m.channel, chat_id: m.chat_id }, res);
  if (conv.done) return conv.done;
  const chan = await channels();
  if (!chan) return res.status(503).json({ error: failureWords('not connected'), status: 'not_connected' });
  const p = m.payload ?? {};
  // The owner the path was made for is the one on the row: a client id, or the chat.
  const owner = { clientId: m.client_id ?? conv.owner.clientId, chatId: m.chat_id };
  const r = await sendOneFile({
    who, chan, target: conv.target, customer: conv.customer, owner,
    file: { path: p.storage_path, file_name: p.file_name, mime_type: p.mime_type },
    caption: m.body ?? '', key: actionKeyOf(req.body) ?? `retry-${m.id}-${Date.now().toString(36)}`, fileOn: null,
  });
  if (!r.ok) return res.status(['refused', 'missing'].includes(r.status) ? 400 : httpFor(r)).json({ error: r.words ?? 'It did not go through.', ...r });
  await onSent();
  return res.status(200).json(r);
}
