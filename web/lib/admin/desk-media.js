/**
 * The files in a conversation, as the desk shows them.
 *
 * A message in the chat log says a file came or went; where its bytes are
 * kept is recorded elsewhere, and differently by age and by channel:
 *
 *   a paper or a photo the bot read     booking_documents (storage_path), found
 *                                       by WhatsApp media id or byte hash, or by
 *                                       Telegram file_unique_id or message id -
 *                                       including papers on no booking (unfiled/)
 *   a voice note, a video, a sticker,   chat_messages.payload.storage_path
 *   a file the bot would not take       (lib/chat-files.js keepChatMedia)
 *   a file the desk sent                chat_messages.payload.storage_path, and
 *                                       payload.document_id when it was filed
 *
 * Messages logged before any of that carry less - a Telegram photo carried
 * nothing at all - so the match falls back to the file's name and the time it
 * came, and says plainly when there is nothing kept to show.
 *
 * The one file of ours that was never kept anywhere is the booking sheet the
 * bot makes and sends: lib/pdf.js builds it from the booking row and nothing
 * is stored. That is a reference too, "made:34", and it is made again from the
 * booking when somebody opens it - which is why every one of them in the
 * history opens, not only the ones sent from today on.
 *
 * The browser never sees a storage path. Each file gets a reference, "doc:12",
 * "msg:34" or "made:34", and view=chat_files turns references into links that
 * expire in ten minutes, fetched as each picture scrolls into view. A photo of
 * several megabytes is shown through a smaller copy made the first time it is
 * asked for, so a chat full of phone photos does not download a hundred
 * megabytes.
 */

import { createHash } from 'node:crypto';
import { db } from '../supabase.js';
import { BUCKET, signedUrl, downloadDocument, storeAt } from '../storage.js';
import { notStoredWords, sizeWords, THUMB_OVER_BYTES, thumbnailOf } from '../chat-files.js';
import { DOC_LABEL } from '../ops/workflow.js';
import { bookingLanguage } from '../i18n.js';
import { unreadable } from './desk-shared.js';

/** Messages that are a file. */
export const FILE_KINDS = new Set(['document', 'image', 'audio', 'video', 'sticker']);

const CHANNEL_WORDS = { whatsapp: 'WhatsApp', telegram: 'Telegram' };
const LINK_SECONDS = 10 * 60;

/** What sort of thing a file is, for how the desk draws it. */
function fileKind(m, mime, name) {
  if (m.kind === 'audio' || m.kind === 'video' || m.kind === 'sticker') return m.kind;
  const type = String(mime ?? '').toLowerCase();
  if (type.startsWith('image/') && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) return 'image';
  if (type === 'application/pdf' || /\.pdf$/i.test(name ?? '')) return 'pdf';
  if (m.kind === 'image' && !type) return 'image';
  return 'document';
}

/**
 * The booking a sheet the bot sent was made from, or null when this message is
 * not one of ours to make again.
 *
 * Only the bot's own outbound PDFs: a file somebody at the desk sent is not a
 * function of anything, so if no copy was kept there is nothing to rebuild.
 * The reference is on the row for everything sent since it was recorded there;
 * older rows carry it only in the file's name, which is the reference.
 */
export function sheetBookingOf(m) {
  if (m.direction !== 'out' || !['bot', 'system'].includes(m.author)) return null;
  const name = m.payload?.file_name ?? '';
  if (m.kind !== 'document' && !/\.pdf$/i.test(name)) return null;
  if (m.booking_ref) return m.booking_ref;
  const named = /^(MKY-[A-Z]+-[0-9A-Z-]+)\.pdf$/i.exec(name);
  return named ? named[1] : null;
}

/**
 * Where a sheet made again is kept: one object per booking, overwritten each
 * time. One per booking so that deleting the booking has one thing to remove
 * (lib/admin/desk-delete.js gather).
 */
export const sheetPath = (bookingRef) => `made/${String(bookingRef).replace(/[^A-Za-z0-9_-]/g, '')}.pdf`;

/**
 * Makes a booking's sheet again, in the language that message went out in, and
 * puts it where a signed link can be made for it.
 *
 * Rebuilt rather than cached on purpose: the sheet is what the booking says
 * now, exactly as lib/outbox.js builds it fresh at delivery time, and one
 * object per booking is one object a deletion could reach.
 */
async function remakeSheet(m) {
  const ref = sheetBookingOf(m);
  if (!ref) return { error: 'There is no copy of this file, and nothing to make it from.' };
  const { data: booking } = await db().from('bookings').select('*').eq('booking_ref', ref).maybeSingle();
  if (!booking) return { error: `Booking ${ref} is no longer here, so its sheet cannot be made again.` };

  let buffer;
  try {
    const { bookingConfirmationPdf } = await import('../pdf.js');
    buffer = await bookingConfirmationPdf(booking, { lang: bookingLanguage(booking, m.language) });
  } catch (err) {
    console.error('sheet remake failed:', err.message);
    return { error: 'We could not make this sheet again. Try once more in a moment.' };
  }
  const path = sheetPath(ref);
  const stored = await storeAt(path, buffer, 'application/pdf', { upsert: true });
  if (!stored.ok) return { error: 'We could not make this sheet again. Try once more in a moment.' };
  return {
    path, bucket: BUCKET, mime: 'application/pdf', size: buffer.length,
    name: m.payload?.file_name ?? `${ref}.pdf`,
  };
}

/** The words a paper's state is shown in, beside its file in the chat. */
function paperOut(d, docs) {
  const label = d.doc_type === 'other' ? (String(d.mime_type ?? '').startsWith('image/') ? 'Photo' : 'File') : (DOC_LABEL[d.doc_type] ?? 'Document');
  let words;
  let tone;
  if (d.deleted_at) [words, tone] = ['Removed from the case', 'gray'];
  else if (d.doc_type === 'mky') [words, tone] = [null, 'gray'];
  else if (d.extracted?.pending === true) [words, tone] = ['Still being read', 'gray'];
  else if (d.status === 'rejected') [words, tone] = ['Set aside', 'gray'];
  else if (d.status === 'replacement_requested') [words, tone] = ['New copy asked for', 'amber'];
  else if (d.status === 'verified') [words, tone] = [d.verified_by ? `Verified by ${d.verified_by}` : 'Verified', 'green'];
  else if (d.doc_type !== 'other' && unreadable(d)) [words, tone] = ['The bot couldn’t read it', 'red'];
  else if (d.doc_type === 'other') [words, tone] = [null, 'gray'];
  else [words, tone] = ['Received — not verified yet', 'blue'];
  // The same kind of paper came again for the same booking: this one is history.
  const newer = d.booking_ref && !['other', 'mky'].includes(d.doc_type) && docs.some((x) => x.id !== d.id && !x.deleted_at
    && x.booking_ref === d.booking_ref && x.doc_type === d.doc_type && !['rejected'].includes(x.status)
    && String(x.uploaded_at ?? '') > String(d.uploaded_at ?? ''));
  return {
    id: d.id,
    label,
    booking_ref: d.booking_ref ?? null,
    status_words: words,
    tone,
    note: newer && d.status !== 'rejected' ? 'A newer copy came later' : null,
    // One of ours, filed on the booking from the conversation.
    mky: d.doc_type === 'mky',
    // The viewer opens a paper the bot read; a photo it did not take for a
    // paper, or one of ours, is just a file to look at.
    reviewable: !['other', 'mky'].includes(d.doc_type),
  };
}

/** The papers this chat's file messages point at, matched as well as each message allows. */
async function papersFor(channel, chatId, rows) {
  const inbound = rows.filter((m) => m.direction === 'in' && (m.kind === 'document' || m.kind === 'image'));
  const ids = [...new Set(rows.map((m) => Number(m.payload?.document_id)).filter(Number.isFinite))];
  if (!inbound.length && !ids.length) return { find: () => null, docs: [], partial: false };
  const [chatQ, idQ] = await Promise.all([
    inbound.length
      ? db().from('booking_documents').select('*').eq('chat_id', String(chatId)).order('uploaded_at', { ascending: false }).limit(300)
      : { data: [] },
    ids.length ? db().from('booking_documents').select('*').in('id', ids) : { data: [] },
  ]);
  if (chatQ.error) console.error('chat papers read failed:', chatQ.error.message);
  if (idQ.error) console.error('sent papers read failed:', idQ.error.message);
  // Drawn without them ("not kept"), but said: such an answer is never kept
  // under the conversation's version (lib/admin/desk-live.js deskNoTag).
  const partial = Boolean(chatQ.error || idQ.error);
  const docs = [...(chatQ.data ?? [])];
  for (const d of idQ.data ?? []) if (!docs.some((x) => x.id === d.id)) docs.push(d);

  const nearest = (list, at) => list.sort((a, b) => Math.abs(new Date(a.uploaded_at) - new Date(at)) - Math.abs(new Date(b.uploaded_at) - new Date(at)))[0] ?? null;
  const within = (d, at, ms) => Math.abs(new Date(d.uploaded_at).getTime() - new Date(at).getTime()) <= ms;

  function find(m) {
    const p = m.payload ?? {};
    if (p.document_id) return docs.find((d) => d.id === Number(p.document_id)) ?? null;
    if (m.direction !== 'in') return null;
    const candidates = docs.filter((d) => d.doc_type !== 'mky');
    if (channel === 'whatsapp') {
      const byId = p.media_id && candidates.find((d) => d.whatsapp_media_id === p.media_id);
      if (byId) return byId;
      // The same file sent again has the same hash - the row was updated, its media id is the newest.
      const byHash = p.sha256 && nearest(candidates.filter((d) => d.whatsapp_media_sha256 === p.sha256), m.created_at);
      if (byHash) return byHash;
      // Logged before the hash was: a photo is named after its media id.
      const photoName = p.media_id ? `photo-${String(p.media_id).slice(-12)}.` : null;
      const byPhoto = photoName && candidates.find((d) => String(d.file_name ?? '').startsWith(photoName));
      if (byPhoto) return byPhoto;
    } else if (channel === 'telegram') {
      const byUnique = p.file_unique_id && candidates.find((d) => d.telegram_file_unique_id === p.file_unique_id);
      if (byUnique) return byUnique;
      const messageId = Number(String(m.provider_message_id ?? '').split(':').pop());
      const byMessage = Number.isFinite(messageId) && candidates.find((d) => Number(d.telegram_message_id) === messageId);
      if (byMessage) return byMessage;
    }
    // Last: the same name, arriving within a quarter of an hour of the message.
    const name = p.file_name;
    return name ? nearest(candidates.filter((d) => d.file_name === name && within(d, m.created_at, 15 * 60_000)), m.created_at) : null;
  }
  return { find, docs, partial };
}

/**
 * What the desk draws for each file message: its kind, name, size, whether a
 * copy is kept (and the reference to fetch it by) or why not, and the paper
 * it became. Keyed by message id; `partial` is set on the map when the papers
 * could not be read.
 */
export async function filesOf(channel, chatId, rows) {
  const out = new Map();
  const fileRows = rows.filter((m) => FILE_KINDS.has(m.kind));
  if (!fileRows.length) return out;
  const { find, docs, partial } = await papersFor(channel, chatId, fileRows);
  if (partial) out.partial = true;
  for (const m of fileRows) {
    const p = m.payload ?? {};
    const d = find(m);
    const name = p.file_name ?? d?.file_name ?? null;
    const mime = p.mime_type ?? d?.mime_type ?? null;
    const kind = fileKind(m, mime, name);
    const size = Number(p.size ?? d?.size_bytes) || null;
    let ref = null;
    let missing = null;
    let made = false;
    if (d?.storage_path) ref = `doc:${d.id}`;
    else if (p.storage_path) ref = `msg:${m.id}`;
    else if (d) {
      missing = d.extracted?.pending === true ? 'Still arriving — look again in a moment.'
        : `Not kept: ${CHANNEL_WORDS[channel] ?? 'the chat app'} would not hand the file over. Ask them to send it again.`;
    } else if (sheetBookingOf(m)) {
      // The bot's own sheet: no copy was kept, and none is needed - it is made
      // again from the booking when it is opened.
      ref = `made:${m.id}`;
      made = true;
    } else if (m.direction === 'out') {
      missing = m.author === 'bot' || m.author === 'system' ? 'Made and sent by the bot; no copy is kept here.' : 'No copy is kept here.';
    } else {
      missing = p.not_stored || ['audio', 'video', 'sticker'].includes(m.kind) ? notStoredWords(p, { channel, kind: m.kind }) : 'This file was not kept.';
    }
    out.set(m.id, {
      kind,
      ref,
      name,
      mime,
      size,
      size_words: size ? sizeWords(size) : null,
      width: Number(p.width) || null,
      height: Number(p.height) || null,
      duration: Number(p.duration) || null,
      voice: p.voice === true,
      emoji: p.emoji ?? null,
      // A big photo is shown through a smaller copy; the full one opens on a click.
      thumb: kind === 'image' && Boolean(size && size > THUMB_OVER_BYTES),
      stored: Boolean(ref),
      // Said on the chip: what opens is a fresh copy, so it is the booking as
      // it stands now and not necessarily the sheet the customer received.
      made,
      missing,
      paper: d ? paperOut(d, docs) : null,
    });
  }
  return out;
}

/** A location or contact card, as the desk shows it. */
export function placeOf(m) {
  const p = m.payload ?? {};
  if (m.kind === 'location' && p.latitude != null && p.longitude != null) {
    const lat = Number(p.latitude);
    const lng = Number(p.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      latitude: lat, longitude: lng, name: p.name ?? null, address: p.address ?? null,
      map_url: `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`,
    };
  }
  return null;
}
export function contactsOf(m) {
  if (m.kind !== 'contact') return null;
  const cards = Array.isArray(m.payload?.contacts) ? m.payload.contacts : [];
  if (cards.length) return cards.map((c) => ({ name: c?.name ?? null, phones: (c?.phones ?? []).map(String).slice(0, 4) }));
  return m.body ? [{ name: null, phones: [String(m.body)] }] : null;
}

// ---------------------------------------------------------------------------
// view=chat_files: references to links
// ---------------------------------------------------------------------------

const thumbPathOf = (path) => `thumbs/${createHash('sha1').update(String(path)).digest('hex').slice(0, 32)}.jpg`;

/** The smaller copy of a big photo: made once, kept beside the rest, reused after. */
async function thumbLink(path, bucket) {
  const thumb = thumbPathOf(path);
  const existing = await signedUrl(thumb, LINK_SECONDS, { quiet: true });
  if (existing) return existing;
  const bytes = await downloadDocument(path, { bucket, quiet: true });
  if (!bytes) return null;
  const small = await thumbnailOf(bytes);
  if (!small) return null;
  const stored = await storeAt(thumb, small.buffer, 'image/jpeg', { upsert: true });
  return stored.ok ? signedUrl(thumb, LINK_SECONDS, { quiet: true }) : null;
}

/**
 * GET view=chat_files&refs=doc:12,msg:34,made:56&variant=thumb|full
 *   → { files: { "doc:12": { url, mime_type, file_name, size, thumb } | { error } }, expires_at }
 *
 * Any signed-in member of the team may look, read-only included: seeing what
 * a customer sent is reading the conversation.
 *
 * Never kept: the links die in ten minutes, so this view has no scopes
 * (public/desk/live.js), no ETag and is never answered "not modified", and
 * it says no-store to anything between here and the browser. The browser
 * keeps each link only until its expires_at (conversation.js link()).
 */
export async function chatFilesView(req, res) {
  res.setHeader?.('Cache-Control', 'no-store');
  const refs = [...new Set(String(req.query.refs ?? '').split(',').map((r) => r.trim()).filter((r) => /^(doc|msg|made):\d{1,12}$/.test(r)))].slice(0, 40);
  if (!refs.length) return res.status(400).json({ error: 'refs is required' });
  const variant = req.query.variant === 'full' ? 'full' : 'thumb';
  const idsOf = (prefix) => refs.filter((r) => r.startsWith(`${prefix}:`)).map((r) => Number(r.slice(prefix.length + 1)));
  const docIds = idsOf('doc');
  const msgIds = idsOf('msg');
  const madeIds = idsOf('made');
  const [docsQ, msgsQ, madeQ] = await Promise.all([
    docIds.length ? db().from('booking_documents').select('id, storage_path, storage_bucket, mime_type, file_name, size_bytes').in('id', docIds) : { data: [] },
    msgIds.length ? db().from('chat_messages').select('id, kind, payload').in('id', msgIds) : { data: [] },
    madeIds.length ? db().from('chat_messages').select('id, kind, direction, author, booking_ref, language, payload').in('id', madeIds) : { data: [] },
  ]);
  const where = new Map();
  for (const d of docsQ.data ?? []) {
    where.set(`doc:${d.id}`, { path: d.storage_path, bucket: d.storage_bucket || BUCKET, mime: d.mime_type, name: d.file_name, size: Number(d.size_bytes) || null });
  }
  for (const m of msgsQ.data ?? []) {
    const p = m.payload ?? {};
    where.set(`msg:${m.id}`, { path: p.storage_path, bucket: p.storage_bucket || BUCKET, mime: p.mime_type, name: p.file_name ?? null, size: Number(p.size) || null });
  }
  // One at a time: making a sheet is a PDF built here, not a read.
  for (const m of madeQ.data ?? []) where.set(`made:${m.id}`, await remakeSheet(m));

  const files = {};
  await Promise.all(refs.map(async (ref) => {
    const f = where.get(ref);
    // Why this one cannot be shown, when there is something to say about it.
    if (f?.error) { files[ref] = { error: f.error }; return; }
    if (!f?.path) { files[ref] = { error: 'No copy of this file is kept.' }; return; }
    const isImage = /^image\/(jpeg|png|webp)/.test(String(f.mime ?? ''));
    let url = null;
    let thumb = false;
    if (variant === 'thumb' && isImage && f.size && f.size > THUMB_OVER_BYTES) {
      url = await thumbLink(f.path, f.bucket).catch(() => null);
      thumb = Boolean(url);
    }
    url = url ?? await signedUrl(f.path, LINK_SECONDS, { bucket: f.bucket, quiet: true });
    files[ref] = url
      ? { url, mime_type: f.mime ?? null, file_name: f.name, size: f.size, thumb }
      : { error: 'The file is missing from storage.' };
  }));
  return res.status(200).json({ files, expires_at: new Date(Date.now() + LINK_SECONDS * 1000 - 30_000).toISOString() });
}
