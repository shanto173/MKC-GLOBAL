/**
 * Customer paperwork in Supabase Storage.
 *
 * The bucket is private. Invoices carry names, addresses, tax numbers and cargo
 * values, so nothing here is ever served from a public URL - staff who need a
 * copy get a signed link that expires.
 */

import { db } from './supabase.js';

export const BUCKET = 'booking-docs';

/** Where a file lives: one folder per chat, so a conversation's papers stay together. */
function storagePath(chatId, fileName) {
  const safe = String(fileName ?? 'document')
    .replace(/[^\w.\-]+/g, '_')
    .slice(-80);
  return `${String(chatId).replace(/[^\w-]/g, '')}/${Date.now()}-${safe}`;
}

/**
 * @param {{chatId: string|number, fileName: string, mimeType: string, buffer: Buffer}} file
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
export async function storeDocument({ chatId, fileName, mimeType, buffer }) {
  const path = storagePath(chatId, fileName);
  const { error } = await db().storage.from(BUCKET).upload(path, buffer, {
    contentType: mimeType || 'application/octet-stream',
    upsert: false,
  });
  if (error) {
    console.error('document upload failed:', error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true, path };
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
