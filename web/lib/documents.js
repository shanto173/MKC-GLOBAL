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
import { requiredDocuments } from './settings.js';

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
export async function ingestDocument({
  buffer, fileName, mimeType, chatId, channel = 'telegram', bookingRef = null,
  telegramFileId = null, telegramFileUniqueId = null, telegramMessageId = null,
  clientId = null, uploadedBy = null, docTypeHint = null,
}) {
  const stored = await storeDocument({ chatId, fileName, mimeType, buffer, bookingRef, clientId });

  const read = await readDocument({ buffer, mimeType, fileName });
  const extracted = read.text
    ? await extractDocument(read.text, { fileName })
    : { ok: false, needs_ocr: true, doc_type: 'other', message: read.error };

  // What the flow ASKED for beats what the reader guessed, but only when the
  // reader could not tell. A hint must never overwrite a confident reading: a
  // client who sends the MRN while we are asking for the invoice has sent the
  // MRN, and filing it as an invoice would then report both wrongly.
  const readType = extracted.doc_type && extracted.doc_type !== 'other' ? extracted.doc_type : null;
  const docType = readType ?? docTypeHint ?? 'other';

  const row = {
    booking_ref: bookingRef,
    chat_id: String(chatId),
    client_id: clientId,
    channel,
    vin: extracted.vin ?? null,
    doc_type: docType,
    file_name: fileName,
    storage_path: stored.path ?? null,
    storage_bucket: stored.bucket ?? null,
    mime_type: mimeType,
    size_bytes: buffer.length,
    telegram_file_id: telegramFileId,
    telegram_file_unique_id: telegramFileUniqueId,
    telegram_message_id: telegramMessageId,
    uploaded_by: uploadedBy,
    // Received. NOT verified - that word belongs to Operations, and the
    // difference is the whole point of having two columns.
    status: 'received',
    extracted: { ...extracted, read_via: read.source, type_from: readType ? 'reader' : docTypeHint ? 'client' : 'unknown' },
    extraction_ok: Boolean(extracted.ok),
    needs_ocr: read.source === 'none',
  };

  // The same file sent again is the same document. Customers resend after a
  // warning, and the operations desk was reading nine chips for three papers.
  // Telegram's file_unique_id is the reliable test - the same photo re-sent
  // gets a new file_id and often a new name, but never a new unique id.
  const dedupe = db()
    .from('booking_documents')
    .select('id')
    .eq('chat_id', String(chatId))
    .limit(1);
  if (telegramFileUniqueId) dedupe.eq('telegram_file_unique_id', telegramFileUniqueId);
  else dedupe.eq('file_name', fileName).eq('size_bytes', buffer.length);
  const { data: already } = await dedupe.maybeSingle();

  const write = already
    ? db().from('booking_documents').update(row).eq('id', already.id)
    : db().from('booking_documents').insert(row);

  const { data, error } = await write.select().single();
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

/**
 * What a specific booking request still needs, judged against the list MKY has
 * configured rather than a list written into the code.
 *
 * The deterministic replacement for asking a model "are we done yet". Three
 * facts come out of it and all three come from rows:
 *   received  - a file of that type is attached to THIS request
 *   missing   - a required type with no file attached
 *   mismatched- a file whose own chassis number is not this request's
 *
 * A document that arrived for another vehicle is never counted as received and
 * never counted as missing: it is its own problem, and telling a client "still
 * missing: invoice" when they have just sent an invoice is how an afternoon
 * gets lost to the same file being sent four times.
 *
 * @param {{bookingRef?: string|null, chatId: string|number, vin?: string|null,
 *          mrnChoice?: string}} where
 */
export async function bookingDocumentState({ bookingRef = null, chatId, vin = null, mrnChoice = 'existing' }) {
  const required = await requiredDocuments({ mrnChoice });

  // Papers for this request: attached to it by reference, plus anything sent in
  // this conversation that has not been attached to anything yet.
  //
  // Two plain queries rather than one `or(...and(...))`: the nested filter
  // string is unreadable, easy to get subtly wrong, and the merge below is
  // exactly as correct for one extra round trip.
  const COLUMNS = 'id, doc_type, file_name, vin, status, extraction_ok, needs_ocr, uploaded_at, telegram_file_unique_id, booking_ref';

  const loose = db()
    .from('booking_documents')
    .select(COLUMNS)
    .eq('chat_id', String(chatId))
    .is('deleted_at', null)
    .order('uploaded_at', { ascending: false })
    .limit(50);

  const attached = bookingRef
    ? db()
        .from('booking_documents')
        .select(COLUMNS)
        .eq('booking_ref', bookingRef)
        .is('deleted_at', null)
        .order('uploaded_at', { ascending: false })
        .limit(50)
    : null;

  const [looseRes, attachedRes] = await Promise.all([loose, attached ?? Promise.resolve({ data: [] })]);
  if (looseRes.error) return { ok: false, error: looseRes.error.message };
  if (attachedRes.error) return { ok: false, error: attachedRes.error.message };

  const seenIds = new Set();
  const data = [];
  for (const doc of [...(attachedRes.data ?? []), ...(looseRes.data ?? [])]) {
    // A loose document from this chat counts; one already filed against a
    // DIFFERENT request does not - it belongs to that request, not this one.
    if (doc.booking_ref && bookingRef && doc.booking_ref !== bookingRef) continue;
    if (seenIds.has(doc.id)) continue;
    seenIds.add(doc.id);
    data.push(doc);
  }

  const norm = vin ? normalizeVin(vin) : null;

  const mismatched = [];
  const mine = [];
  for (const doc of data ?? []) {
    if (doc.status === 'rejected') continue;      // Operations refused it; it is not received
    if (norm && doc.vin && normalizeVin(doc.vin) !== norm) {
      mismatched.push(doc);
      continue;
    }
    mine.push(doc);
  }

  // One type may arrive twice; the newest wins and the client is not told they
  // have "two invoices".
  const byType = new Map();
  for (const doc of mine) {
    if (!byType.has(doc.doc_type)) byType.set(doc.doc_type, doc);
  }
  // Origin paperwork satisfies the transport-document requirement either way.
  if (byType.has('eur1') && !byType.has('brief')) byType.set('brief', byType.get('eur1'));

  const missing = required.filter((type) => !byType.has(type));
  const verified = mine.filter((d) => d.status === 'verified').map((d) => d.doc_type);

  return {
    ok: true,
    required,
    received: [...byType.entries()].map(([type, doc]) => ({
      type,
      file: doc.file_name,
      status: doc.status,
      readable: doc.extraction_ok,
      vin: doc.vin,
    })),
    received_types: [...byType.keys()],
    // "Verified" is Operations' word, never the bot's. A file arriving proves a
    // file arrived and nothing else.
    verified_types: verified,
    missing,
    mismatched: mismatched.map((d) => ({ type: d.doc_type, file: d.file_name, vin: d.vin })),
    complete: missing.length === 0,
  };
}

/** Links loose documents to a booking once its reference exists. */
/**
 * Links a document to the booking it belongs to, when one already exists in
 * this conversation. Matches on the chassis number if the document carries one,
 * otherwise the newest open booking in the chat.
 */
async function attachToOpenBooking(document, chatId) {
  // Drafts count: the papers step happens while the booking is still a draft,
  // and a document sent then belongs to it. Left out, three papers for one
  // chassis were filed against a different vehicle's confirmed booking.
  const { data: open } = await db()
    .from('bookings')
    .select('booking_ref, vin, vin_norm, status, created_at')
    .eq('chat_id', String(chatId))
    .in('status', ['draft', 'pending_review', 'confirmed'])
    .order('created_at', { ascending: false })
    .limit(5);
  if (!open?.length) return null;

  // A document that names a chassis goes only to that chassis. One that names
  // none - a Nafeza printout carries no VIN - goes to the newest booking in the
  // chat. There is no "nearest" for a paper that names a different vehicle.
  const docVin = document.vin ? normalizeVin(document.vin) : null;
  const match = docVin
    ? open.find((b) => normalizeVin(b.vin ?? '') === docVin)
    : open[0];
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
  const { data: loose, error: readErr } = await db()
    .from('booking_documents')
    .select('id, vin')
    .eq('chat_id', String(chatId))
    .is('booking_ref', null);
  if (readErr) {
    console.error('attaching documents to booking failed:', readErr.message);
    return;
  }

  const norm = normalizeVin(vin);
  for (const doc of loose ?? []) {
    // A document's own chassis number is evidence. Stamping the booking's
    // number over it - which is what a blanket update did - erased the very
    // mismatch we exist to catch: an invoice for another vehicle quietly became
    // an invoice for this one.
    if (doc.vin && normalizeVin(doc.vin) !== norm) continue;

    const { error } = await db()
      .from('booking_documents')
      .update({ booking_ref: bookingRef, ...(doc.vin ? {} : { vin }) })
      .eq('id', doc.id);
    if (error) console.error('attaching a document failed:', error.message);
  }
}
