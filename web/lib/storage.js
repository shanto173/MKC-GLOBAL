/**
 * Customer paperwork in Supabase Storage.
 *
 * The bucket is private. Invoices carry names, addresses, tax numbers and cargo
 * values, so nothing here is ever served from a public URL - staff who need a
 * copy get a signed link that expires.
 */

import { randomUUID } from 'node:crypto';
import { db } from './supabase.js';

export const BUCKET = 'booking-docs';

/**
 * One path segment, safe to put in a URL and impossible to escape from.
 *
 * A client controls the filename. Without this, a name containing "../" or a
 * leading slash decides where in the bucket the file lands - so nothing the
 * client sent is ever used as a path component unedited, and a uuid in front of
 * it means two files called scan.pdf cannot collide or overwrite each other.
 */
function segment(value, fallback) {
  const safe = String(value ?? '').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 80);
  return safe || fallback;
}

/**
 * Where a file lives: the client, then the request it belongs to, so a booking's
 * papers are one prefix and a signed link can be issued per booking.
 */
function storagePath({ chatId, clientId, bookingRef, fileName }) {
  const owner = segment(clientId ?? chatId, 'unknown');
  const request = segment(bookingRef, 'unfiled');
  const name = segment(String(fileName ?? 'document').slice(-80), 'document');
  return `${owner}/${request}/${randomUUID()}-${name}`;
}

/**
 * @param {{chatId: string|number, fileName: string, mimeType: string, buffer: Buffer,
 *          bookingRef?: string|null, clientId?: number|null}} file
 * @returns {Promise<{ok: boolean, path?: string, bucket?: string, error?: string}>}
 */
export async function storeDocument({ chatId, fileName, mimeType, buffer, bookingRef = null, clientId = null }) {
  const path = storagePath({ chatId, clientId, bookingRef, fileName });
  const { error } = await db().storage.from(BUCKET).upload(path, buffer, {
    contentType: mimeType || 'application/octet-stream',
    upsert: false,
  });
  if (error) {
    console.error('document upload failed:', error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true, path, bucket: BUCKET };
}

/**
 * Is this file one we accept at all?
 *
 * Checked before the bytes are fetched from Telegram, so an oversized or
 * unsupported file costs nothing. The lists come from bot_settings; the caller
 * passes them in rather than this module reading configuration, so the same
 * check works in a test with no database.
 */
export function validateUpload({ mimeType, size }, { allowedTypes, maxBytes }) {
  const mime = String(mimeType ?? '').toLowerCase().split(';')[0].trim();
  if (Array.isArray(allowedTypes) && allowedTypes.length && !allowedTypes.includes(mime)) {
    return { ok: false, reason: 'type', mime, allowed: allowedTypes };
  }
  if (maxBytes && Number(size) > Number(maxBytes)) {
    return { ok: false, reason: 'size', size: Number(size), maxBytes: Number(maxBytes) };
  }
  return { ok: true, mime };
}

/** A time-limited link, for putting a document in front of an operator. */
export async function signedUrl(path, seconds = 60 * 60 * 24 * 7) {
  const { data, error } = await db().storage.from(BUCKET).createSignedUrl(path, seconds);
  if (error) {
    console.error('signed url failed:', error.message);
    return null;
  }
  return data.signedUrl;
}

export async function downloadDocument(path) {
  const { data, error } = await db().storage.from(BUCKET).download(path);
  if (error) {
    console.error('document download failed:', error.message);
    return null;
  }
  return Buffer.from(await data.arrayBuffer());
}
