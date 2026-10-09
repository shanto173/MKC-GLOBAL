/**
 * Files in a conversation, both ways.
 *
 * IN. A paper or a photo a customer sends is read by the bot and kept as a
 * booking document (lib/documents.js). Everything else - a voice note, a
 * video, a sticker, a Word file the bot will not read - used to be logged as
 * "[Voice note]" and thrown away, so the desk could not hear or open what the
 * customer sent. keepChatMedia() stores those in the same private bucket,
 * under <customer>/chat-media/, and writes on the logged message where it went
 * or, in words the desk shows, why it did not.
 *
 * OUT. The desk sends papers and photos to a customer. planOutbound() decides
 * whether a file can go on this channel and as what - a photo, or a document -
 * from Meta's and Telegram's own limits, and says why not when it cannot.
 * sniff() checks the bytes are what the name says, because the browser's word
 * for a file's type is only the browser's word.
 *
 * Limits (checked October 2026):
 *   WhatsApp   photo (JPEG, PNG) 5 MB · document 100 MB, PDF / Word / Excel /
 *              PowerPoint / text · audio and video 16 MB · caption 1024
 *   Telegram   photo 10 MB · document 50 MB (uploaded by the bot) · a bot may
 *              download at most 20 MB of what a customer sends · caption 1024
 * And the bucket's own: Supabase's free plan stops a file at 50 MB, so the desk
 * sends at most DESK_UPLOAD_MAX_BYTES (default 50 MB) whatever the channel allows.
 */

import { randomUUID } from 'node:crypto';
import { BUCKET, segment, storeAt } from './storage.js';
import { patchChatMessage } from './chatlog.js';

const MB = 1024 * 1024;

/** The most a chat file (voice note, video…) the desk keeps may weigh. */
export const CHAT_MEDIA_MAX_BYTES = Number(process.env.CHAT_MEDIA_MAX_BYTES) || 16 * MB;
/** The most one file the desk sends may weigh, whatever the channel takes. */
export const DESK_UPLOAD_MAX_BYTES = Number(process.env.DESK_UPLOAD_MAX_BYTES) || 50 * MB;
export const MAX_FILES_PER_SEND = 10;
export const CAPTION_MAX = 1024;

export const OUTBOUND_LIMITS = {
  whatsapp: { image: 5 * MB, document: 100 * MB },
  telegram: { image: 10 * MB, document: 50 * MB },
};

const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png' };
const DOCUMENT_TYPES = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};
const BY_EXTENSION = Object.fromEntries([...Object.entries(IMAGE_TYPES), ['image/jpeg', 'jpeg'], ...Object.entries(DOCUMENT_TYPES)]
  .map(([mime, ext]) => [ext, mime]));

/** What the desk offers to attach, for the file picker. */
export const OUTBOUND_ACCEPT = '.pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx';

/** "4.2 MB", "380 KB" - for a person, not a log. */
export function sizeWords(bytes) {
  const n = Number(bytes) || 0;
  if (n >= MB) {
    const v = n / MB;
    return `${Number.isInteger(v) || v >= 10 ? Math.round(v) : v.toFixed(1)} MB`;
  }
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

const extOf = (name) => (/\.([a-z0-9]{2,5})$/i.exec(String(name ?? ''))?.[1] ?? '').toLowerCase();

/** The type a file really is for sending: the browser's word, or its extension when the browser had none. */
export function normaliseMime(mimeType, fileName) {
  const mime = String(mimeType ?? '').toLowerCase().split(';')[0].trim();
  if (mime && mime !== 'application/octet-stream') return mime === 'image/jpg' ? 'image/jpeg' : mime;
  return BY_EXTENSION[extOf(fileName)] ?? (mime || 'application/octet-stream');
}

const CHANNEL_WORDS = { whatsapp: 'WhatsApp', telegram: 'Telegram' };

/**
 * Whether one file may go to a customer on this channel, and as what.
 *
 * @returns {{ok: true, kind: 'image'|'document', mime: string, ext: string}
 *          | {ok: false, reason: 'empty'|'type'|'size', words: string}}
 */
export function planOutbound({ channel, mimeType, size, fileName }) {
  const limits = OUTBOUND_LIMITS[channel];
  const where = CHANNEL_WORDS[channel] ?? 'This chat';
  const name = String(fileName ?? 'This file');
  const bytes = Number(size) || 0;
  if (!limits) return { ok: false, reason: 'type', words: `${where} cannot take files from the desk.` };
  if (bytes <= 0) return { ok: false, reason: 'empty', words: `${name} is empty.` };
  const mime = normaliseMime(mimeType, fileName);
  if (bytes > DESK_UPLOAD_MAX_BYTES) {
    return { ok: false, reason: 'size', words: `${name} is ${sizeWords(bytes)}. The desk sends files of up to ${sizeWords(DESK_UPLOAD_MAX_BYTES)}.` };
  }
  if (IMAGE_TYPES[mime]) {
    if (bytes <= limits.image) return { ok: true, kind: 'image', mime, ext: IMAGE_TYPES[mime] };
    // Telegram takes a big photo as a file; WhatsApp takes photos only up to 5 MB.
    if (channel === 'telegram' && bytes <= limits.document) return { ok: true, kind: 'document', mime, ext: IMAGE_TYPES[mime] };
    return { ok: false, reason: 'size', words: `${where} takes photos of up to ${sizeWords(limits.image)}; ${name} is ${sizeWords(bytes)}. Send a smaller photo, or save it as a PDF.` };
  }
  if (DOCUMENT_TYPES[mime]) {
    const max = Math.min(limits.document, DESK_UPLOAD_MAX_BYTES);
    if (bytes <= max) return { ok: true, kind: 'document', mime, ext: DOCUMENT_TYPES[mime] };
    return { ok: false, reason: 'size', words: `${name} is ${sizeWords(bytes)}; ${where} takes files of up to ${sizeWords(max)} from the desk.` };
  }
  const ext = extOf(fileName);
  return { ok: false, reason: 'type', words: `${ext ? `A .${ext} file` : 'This kind of file'} cannot be sent from the desk. Send a PDF, a JPG or PNG photo, or a Word or Excel file.` };
}

/**
 * What the first bytes say a file is: 'pdf', 'jpeg', 'png', 'zip' (Word and
 * Excel since 2007 are zip files), 'ole' (the older .doc and .xls), or null.
 */
export function sniff(buffer) {
  const b = buffer ?? Buffer.alloc(0);
  if (b.length >= 4 && b.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'zip';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'ole';
  return null;
}

const SNIFFED = { pdf: 'pdf', jpg: 'jpeg', png: 'png', docx: 'zip', xlsx: 'zip', doc: 'ole', xls: 'ole' };

/** Do the bytes agree with the type the file is being sent as? */
export const bytesMatch = (ext, buffer) => SNIFFED[ext] === sniff(buffer);

/** A file name safe for a storage path that still ends in its type. */
function storageName(fileName, ext) {
  const s = segment(String(fileName ?? '').slice(-80), 'file');
  return /\.[a-z0-9]{2,5}$/i.test(s) ? s : `${s}.${ext || 'bin'}`;
}

const ownerOf = ({ clientId, chatId }) => segment(clientId ?? chatId, 'unknown');

/**
 * Where a file the desk sends is kept: <customer>/outbound/<action key>-<name>.
 * The action key is the browser's, one per file, so an upload retried after a
 * dropped connection lands on the same path instead of leaving a twin.
 */
export function outboundPath({ clientId = null, chatId, key, fileName, ext }) {
  return `${ownerOf({ clientId, chatId })}/outbound/${segment(key, 'k')}-${storageName(fileName, ext)}`;
}

/** Is this path one the desk handed out for this customer's outgoing files? */
export const isOutboundPathFor = (path, { clientId = null, chatId }) => {
  const p = String(path ?? '');
  const owners = [clientId, chatId].filter((v) => v != null && v !== '').map((v) => `${segment(v, 'unknown')}/outbound/`);
  return !p.includes('..') && owners.some((o) => p.startsWith(o));
};

/**
 * Keeps one file a customer sent that the bot does not keep itself, and notes
 * the outcome on the logged message (chat_messages.payload):
 *
 *   storage_path, storage_bucket, size     kept
 *   not_stored: 'too_large'                over CHAT_MEDIA_MAX_BYTES
 *   not_stored: 'download_failed'          the channel would not hand it over
 *   not_stored: 'storage_failed'           the bucket refused it
 *
 * Best effort and quiet: the customer's answer never waits on it.
 *
 * @param {{channel: string, chatId: string, clientId?: number|null, providerMessageId: string,
 *          mimeType?: string|null, fileName?: string|null, size?: number,
 *          fetchBytes: () => Promise<{ok: boolean, buffer?: Buffer, error?: string}>}} file
 */
export async function keepChatMedia({ channel, chatId, clientId = null, providerMessageId, mimeType = null, fileName = null, size = 0, fetchBytes }) {
  const note = (patch) => patchChatMessage(channel, providerMessageId, patch).then(() => patch);
  try {
    // Only what a person at the desk can sensibly open: an archive or a
    // program is not fetched at all, let alone handed to a colleague's browser.
    if (!keepable(mimeType, fileName)) return note({ not_stored: 'type' });
    if (Number(size) > CHAT_MEDIA_MAX_BYTES) return note({ not_stored: 'too_large', size: Number(size) });
    const got = await fetchBytes();
    if (!got?.ok || !got.buffer) return note({ not_stored: 'download_failed', not_stored_detail: String(got?.error ?? 'no file').slice(0, 200) });
    if (got.buffer.length > CHAT_MEDIA_MAX_BYTES) return note({ not_stored: 'too_large', size: got.buffer.length });
    const ext = extOf(fileName) || (String(mimeType ?? '').split('/')[1] ?? 'bin').split(/[;+]/)[0];
    const path = `${ownerOf({ clientId, chatId })}/chat-media/${randomUUID()}-${storageName(fileName ?? `file.${ext}`, ext)}`;
    const stored = await storeAt(path, got.buffer, String(mimeType ?? '').split(';')[0] || 'application/octet-stream');
    if (!stored.ok) return note({ not_stored: 'storage_failed' });
    return note({ storage_bucket: BUCKET, storage_path: path, size: got.buffer.length, stored_at: new Date().toISOString() });
  } catch (err) {
    console.error('keeping chat media failed:', err?.message);
    return note({ not_stored: 'download_failed', not_stored_detail: String(err?.message ?? 'failed').slice(0, 200) }).catch(() => null);
  }
}

const KEEPABLE = new Set([
  ...Object.keys(DOCUMENT_TYPES), 'text/plain', 'text/csv',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
/** Voice notes, videos, pictures, and papers in a format people open: kept. Anything else is not fetched. */
export function keepable(mimeType, fileName) {
  const mime = normaliseMime(mimeType, fileName);
  return /^(audio|video|image)\//.test(mime) || KEEPABLE.has(mime);
}

/** Why a chat file was not kept, as the desk says it. */
export function notStoredWords(payload = {}, { channel = null, kind = null } = {}) {
  const where = CHANNEL_WORDS[channel] ?? 'The chat app';
  switch (payload.not_stored) {
    case 'too_large':
      return `Not kept: ${payload.size ? `${sizeWords(payload.size)}, ` : ''}more than the ${sizeWords(CHAT_MEDIA_MAX_BYTES)} the desk keeps of a chat file. Open it on the phone, or ask them to send it another way.`;
    case 'download_failed':
      return `Not kept: ${where} would not hand the file over. Ask them to send it again.`;
    case 'storage_failed':
      return 'Not kept: storing it failed. Ask them to send it again.';
    case 'not_kept':
      return payload.animated ? 'Animated stickers are not kept.' : 'Not kept.';
    case 'type':
      return 'Not kept: the desk keeps photos, PDFs, Office files, voice notes and videos, not this kind of file. Ask them to send a PDF.';
    default:
      return kind === 'audio' || kind === 'video' || kind === 'sticker'
        ? 'Not kept: it arrived before the desk kept voice notes, videos and stickers.'
        : 'Not kept.';
  }
}

/** Images the desk shrinks before showing them in a chat: bigger than this, or wider. */
export const THUMB_OVER_BYTES = 1.5 * MB;
export const THUMB_WIDTH = 640;

/**
 * A JPEG at most THUMB_WIDTH wide, for showing a big photo in a bubble without
 * making the browser fetch and decode six megabytes. Null when the image
 * cannot be read here (HEIC, a broken file) - the desk then shows the original.
 */
export async function thumbnailOf(buffer) {
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(buffer);
    const scale = Math.min(1, THUMB_WIDTH / img.width);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = createCanvas(w, h);
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return { buffer: canvas.toBuffer('image/jpeg', 80), width: img.width, height: img.height };
  } catch (err) {
    console.error('thumbnail failed:', err?.message);
    return null;
  }
}
