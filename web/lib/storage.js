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
export function segment(value, fallback) {
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
export async function signedUrl(path, seconds = 60 * 60 * 24 * 7, { bucket = BUCKET, quiet = false } = {}) {
  const { data, error } = await db().storage.from(bucket || BUCKET).createSignedUrl(path, seconds);
  if (error) {
    if (!quiet) console.error('signed url failed:', error.message);
    return null;
  }
  return data.signedUrl;
}

/**
 * A one-off address the desk's browser uploads one file to, straight into the
 * private bucket - so a file never passes through the API (whose requests stop
 * at 4.5 MB) and the service key never leaves the server. Valid for two hours
 * and for this one path only; `upsert` lets a retried upload replace a
 * half-finished one at the same path.
 */
export async function signedUploadUrl(path) {
  const { data, error } = await db().storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
  if (error) {
    console.error('signed upload url failed:', error.message);
    return null;
  }
  return { url: data.signedUrl, token: data.token ?? null, path: data.path ?? path };
}

/** Stores bytes at a path chosen by the caller (chat media, thumbnails). */
export async function storeAt(path, buffer, mimeType, { upsert = false } = {}) {
  const { error } = await db().storage.from(BUCKET).upload(path, buffer, {
    contentType: mimeType || 'application/octet-stream',
    upsert,
  });
  if (error) {
    console.error('storage upload failed:', error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true, path, bucket: BUCKET };
}

export async function downloadDocument(path, { bucket = BUCKET, quiet = false } = {}) {
  const { data, error } = await db().storage.from(bucket || BUCKET).download(path);
  if (error) {
    if (!quiet) console.error('document download failed:', error.message);
    return null;
  }
  return Buffer.from(await data.arrayBuffer());
}
