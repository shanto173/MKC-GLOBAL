/**
 * What happens when a customer sends a document.
 *
 * Store it, read it, work out what it is, and check it agrees with the other
 * papers for the same vehicle. The chassis number is the thing that matters:
 * if the invoice and the MRN disagree, the customs declaration gets rejected,
 * and that is exactly the kind of typo a person skims past.
 */

import { db } from './supabase.js';
import { storeDocument } from './storage.js';
import { readDocument } from './read-file.js';
import { extractDocument, crossCheck, missingDocuments, REQUIRED_DOCS, LATER_DOCS } from './extract.js';
import { normalizeVin } from './tools.js';

const DOC_LABELS = {
  invoice: 'commercial invoice',
  mrn: 'MRN / export declaration',
  eur1: 'EUR.1 certificate of origin',
  acid: 'ACID registration',
  brief: 'transport document',
  other: 'document',
};

export const DOC_LABELS_AR = {
  invoice: 'الفاتورة التجارية',
  mrn: 'رقم MRN / بيان التصدير',
  eur1: 'شهادة المنشأ EUR.1',
  acid: 'تسجيل ACID',
  brief: 'مستند النقل',
  other: 'مستند',
};

/**
 * Full path for one incoming file: store, read, extract, record.
 *
 * @param {{buffer: Buffer, fileName: string, mimeType: string,
 *          chatId: string|number, channel: string, bookingRef?: string}} file
 */
export async function ingestDocument({ buffer, fileName, mimeType, chatId, channel = 'telegram', bookingRef = null }) {
  const stored = await storeDocument({ chatId, fileName, mimeType, buffer });

  const read = await readDocument({ buffer, mimeType, fileName });
  const extracted = read.text
    ? await extractDocument(read.text, { fileName })
    : { ok: false, needs_ocr: true, doc_type: 'other', message: read.error };

  const row = {
    booking_ref: bookingRef,
    chat_id: String(chatId),
    channel,
    vin: extracted.vin ?? null,
    doc_type: extracted.doc_type ?? 'other',
    file_name: fileName,
    storage_path: stored.path ?? null,
    mime_type: mimeType,
    size_bytes: buffer.length,
    extracted: { ...extracted, read_via: read.source },
    extraction_ok: Boolean(extracted.ok),
    needs_ocr: read.source === 'none',
  };

  const { data, error } = await db().from('booking_documents').insert(row).select().single();
  if (error) {
    console.error('booking_documents insert failed:', error.message);
    return { ok: false, error: error.message, extracted };
  }

  // Papers that arrive AFTER the booking was made were left unattached, so the
  // operations desk opened the booking and saw no documents against it even
  // though the customer had sent them. Anything already booked in this chat
  // claims them - by chassis where the document names one.
  let attachedTo = bookingRef ?? null;
  if (!attachedTo) attachedTo = await attachToOpenBooking(data, chatId);

  return {
    ok: true,
    document: data,
    extracted,
    readVia: read.source,
    bookingRef: attachedTo,
    storageError: stored.error,
  };
}

/**
 * Everything we hold for this conversation: which documents have arrived, which
 * are still missing, and whether they agree with each other.
 */
export async function documentStatus({ chatId, vin = null }) {
  const { data, error } = await db()
    .from('booking_documents')
    .select('id, doc_type, file_name, vin, extracted, extraction_ok, needs_ocr, uploaded_at')
    .eq('chat_id', String(chatId))
    .order('uploaded_at', { ascending: false })
    .limit(30);

  if (error) return { error: error.message };

  // The same file sent twice is one document, not two. A customer re-sending
  // after a warning had "6 received" read back at them.
  const seen = new Set();
  const unique = (data ?? []).filter((d) => {
    const key = `${d.doc_type}:${d.file_name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // When a VIN is known, only papers for that vehicle count - a customer may be
  // moving several units through the same chat.
  const norm = vin ? normalizeVin(vin) : null;
  const docs = unique.filter((d) => !norm || !d.vin || normalizeVin(d.vin) === norm);

  // A paper that arrived but belongs to another vehicle is NOT missing. Saying
  // "still missing: commercial invoice" to somebody who has just sent an invoice
  // is how you lose an afternoon: they resend the same file, and we say it again.
  const otherVehicle = norm
    ? unique.filter((d) => d.vin && normalizeVin(d.vin) !== norm).map((d) => ({
        type: d.doc_type,
        label: DOC_LABELS[d.doc_type] ?? d.doc_type,
        file: d.file_name,
        vin: d.vin,
      }))
    : [];

  const extractedDocs = docs.map((d) => ({ ...d.extracted, doc_type: d.doc_type }));
  const check = crossCheck(extractedDocs);
  const missing = missingDocuments(extractedDocs);
  const wrongVehicleTypes = new Set(otherVehicle.map((d) => d.type));

  return {
    count: docs.length,
    received: docs.map((d) => ({
      type: d.doc_type,
      label: DOC_LABELS[d.doc_type] ?? d.doc_type,
      file: d.file_name,
      vin: d.vin,
      readable: d.extraction_ok,
    })),
    // Split three ways, because they mean three different things to a customer.
    missing: missing.filter((m) => !wrongVehicleTypes.has(m)),
    missing_labels: missing.filter((m) => !wrongVehicleTypes.has(m)).map((m) => DOC_LABELS[m] ?? m),
    wrong_vehicle: otherVehicle,
    wrong_vehicle_labels: otherVehicle.map((d) => `${d.label} (${d.vin})`),
    to_follow_labels: LATER_DOCS
      .filter((d) => !docs.some((doc) => doc.doc_type === d))
      .map((d) => DOC_LABELS[d] ?? d),
    required: REQUIRED_DOCS,
    consistent: check.consistent,
    agreed_vin: check.vin,
    problems: check.problems,
    complete: missing.length === 0 && check.consistent,
  };
}

/** Links loose documents to a booking once its reference exists. */
/**
 * Links a document to the booking it belongs to, when one already exists in
 * this conversation. Matches on the chassis number if the document carries one,
 * otherwise the newest open booking in the chat.
 */
async function attachToOpenBooking(document, chatId) {
  const { data: open } = await db()
    .from('bookings')
    .select('booking_ref, vin, vin_norm, status, created_at')
    .eq('chat_id', String(chatId))
    .in('status', ['pending_review', 'confirmed'])
    .order('created_at', { ascending: false })
    .limit(5);
  if (!open?.length) return null;

  const docVin = document.vin ? normalizeVin(document.vin) : null;
  const match = (docVin && open.find((b) => normalizeVin(b.vin ?? '') === docVin)) || open[0];
  if (!match) return null;

  const { error } = await db()
    .from('booking_documents')
    .update({ booking_ref: match.booking_ref, vin: document.vin ?? match.vin ?? null })
    .eq('id', document.id);
  if (error) {
    console.error('attaching a late document failed:', error.message);
    return null;
  }
  return match.booking_ref;
}

export async function attachDocumentsToBooking({ chatId, bookingRef, vin }) {
  const { error } = await db()
    .from('booking_documents')
    .update({ booking_ref: bookingRef, vin })
    .eq('chat_id', String(chatId))
    .is('booking_ref', null);
  if (error) console.error('attaching documents to booking failed:', error.message);
}
