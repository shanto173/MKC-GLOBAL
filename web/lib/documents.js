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
import { extractDocument, crossCheck, missingDocuments, REQUIRED_DOCS } from './extract.js';
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

  return { ok: true, document: data, extracted, readVia: read.source, storageError: stored.error };
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

  // When a VIN is known, only papers for that vehicle count - a customer may be
  // moving several units through the same chat.
  const norm = vin ? normalizeVin(vin) : null;
  const docs = (data ?? []).filter((d) => !norm || !d.vin || normalizeVin(d.vin) === norm);

  const extractedDocs = docs.map((d) => ({ ...d.extracted, doc_type: d.doc_type }));
  const check = crossCheck(extractedDocs);
  const missing = missingDocuments(extractedDocs);

  return {
    count: docs.length,
    received: docs.map((d) => ({
      type: d.doc_type,
      label: DOC_LABELS[d.doc_type] ?? d.doc_type,
      file: d.file_name,
      vin: d.vin,
      readable: d.extraction_ok,
    })),
    missing,
    missing_labels: missing.map((m) => DOC_LABELS[m] ?? m),
    required: REQUIRED_DOCS,
    consistent: check.consistent,
    agreed_vin: check.vin,
    problems: check.problems,
    complete: missing.length === 0 && check.consistent,
  };
}

/** Links loose documents to a booking once its reference exists. */
export async function attachDocumentsToBooking({ chatId, bookingRef, vin }) {
  const { error } = await db()
    .from('booking_documents')
    .update({ booking_ref: bookingRef, vin })
    .eq('chat_id', String(chatId))
    .is('booking_ref', null);
  if (error) console.error('attaching documents to booking failed:', error.message);
}
