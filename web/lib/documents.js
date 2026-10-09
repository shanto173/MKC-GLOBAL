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
import { isSchemaMissing } from './chatlog.js';
import { channelOf } from './channels.js';

// Whether booking_documents has the WhatsApp media columns. Learned once.
let mediaColumns = null;

/** For tests: forget what was learned about the schema. */
export function resetDocumentsForTests() {
  mediaColumns = null;
}

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
 * Which request do papers arriving in this chat belong to? The one this
 * conversation is working on. Attaching them by chat rather than guessing from
 * the content is what stopped an invoice being filed against another
 * vehicle's booking. Shared by both transports.
 *
 * @returns {Promise<{booking_ref: string, vin: string|null}|null>}
 */
export async function openRequestForFiles(chatId) {
  const { data } = await db()
    .from('bookings')
    .select('booking_ref, vin')
    .eq('chat_id', String(chatId))
    .in('status', ['draft', 'pending_review', 'under_review', 'needs_client_action'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/**
 * Records that a file has arrived, before anything slow happens to it.
 *
 * Reading a document takes seconds - a model reads a scan - and three papers
 * sent together are three separate webhook calls running at once. Until each
 * had a row the others could not know it existed, and each answered on its
 * own: "invoice received, two still missing", then "brief received, one
 * missing", then the card. So the row goes in first, marked as still being
 * read, and completeDocument() fills it in when the reading is done. The
 * transport uses stillReading() over recentUploads() to let only the last of
 * them speak.
 *
 * @returns {Promise<{ok: true, document: object, replaced: boolean}|{ok: false, error: string}>}
 */
export async function beginDocument({
  fileName, mimeType, size = 0, chatId, channel: given = null, bookingRef = null,
  telegramFileId = null, telegramFileUniqueId = null, telegramMessageId = null,
  whatsappMediaId = null, whatsappMediaSha256 = null,
  clientId = null, uploadedBy = null,
}) {
  // Not 'telegram' by default: a file from a "wa:" chat is a WhatsApp file.
  const channel = given ?? channelOf(chatId);
  const row = {
    booking_ref: bookingRef,
    chat_id: String(chatId),
    client_id: clientId,
    channel,
    vin: null,
    doc_type: 'other',
    file_name: fileName,
    storage_path: null,
    mime_type: mimeType,
    size_bytes: size,
    telegram_file_id: telegramFileId,
    telegram_file_unique_id: telegramFileUniqueId,
    telegram_message_id: telegramMessageId,
    uploaded_by: uploadedBy,
    // Received. NOT verified - that word belongs to Operations, and the
    // difference is the whole point of having two columns.
    status: 'received',
    extracted: { pending: true },
    extraction_ok: false,
    needs_ocr: false,
    uploaded_at: new Date().toISOString(),
  };

  // The same file sent again is the same document. Customers resend after a
  // warning, and the operations desk was reading nine chips for three papers.
  // Telegram's file_unique_id is the reliable test - the same photo re-sent
  // gets a new file_id and often a new name, but never a new unique id.
  // WhatsApp's equivalent is the file's sha256, which Meta sends with it: a
  // new media id every time, the same hash for the same bytes.
  const byHash = Boolean(whatsappMediaSha256) && mediaColumns !== false;
  const dedupe = db()
    .from('booking_documents')
    .select('id')
    .eq('chat_id', String(chatId))
    .limit(1);
  if (telegramFileUniqueId) dedupe.eq('telegram_file_unique_id', telegramFileUniqueId);
  else if (byHash) dedupe.eq('whatsapp_media_sha256', whatsappMediaSha256);
  else dedupe.eq('file_name', fileName).eq('size_bytes', size);
  const { data: already, error: dedupeError } = await dedupe.maybeSingle();
  if (byHash && isSchemaMissing(dedupeError)) mediaColumns = false;

  // The WhatsApp columns arrive with migration 20261007100000. Written only
  // while they may exist; refused once, never named again in this process.
  const media = channel === 'whatsapp' && mediaColumns !== false && (whatsappMediaId || whatsappMediaSha256)
    ? { whatsapp_media_id: whatsappMediaId, whatsapp_media_sha256: whatsappMediaSha256 }
    : null;

  const write = (values) => (already
    ? db().from('booking_documents').update(values).eq('id', already.id)
    : db().from('booking_documents').insert(values)).select().single();

  let { data, error } = await write(media ? { ...row, ...media } : row);
  if (error && media && isSchemaMissing(error)) {
    mediaColumns = false;
    ({ data, error } = await write(row));
  }
  if (error) {
    console.error('booking_documents insert failed:', error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true, document: data, replaced: Boolean(already) };
}

/**
 * The slow half: store the bytes, read the file, work out what it is, and
 * fill in the row beginDocument() wrote. Whatever happens, the row stops
 * being "still reading" when this returns - a file that could not be read is
 * a file that arrived, not one that is arriving forever.
 */
export async function completeDocument(documentId, {
  buffer, fileName, mimeType, chatId, bookingRef = null, clientId = null, docTypeHint = null,
}) {
  let stored = { path: null, bucket: null, error: null };
  let read;
  let extracted;
  try {
    stored = await storeDocument({ chatId, fileName, mimeType, buffer, bookingRef, clientId });
    read = await readDocument({ buffer, mimeType, fileName });
    extracted = read.text
      ? await extractDocument(read.text, { fileName })
      : { ok: false, needs_ocr: true, doc_type: 'other', message: read.error };
  } catch (err) {
    await abandonDocument(documentId, err?.message);
    throw err;
  }

  // What the flow ASKED for beats what the reader guessed, but only when the
  // reader could not tell. A hint must never overwrite a confident reading: a
  // client who sends the MRN while we are asking for the invoice has sent the
  // MRN, and filing it as an invoice would then report both wrongly.
  const readType = extracted.doc_type && extracted.doc_type !== 'other' ? extracted.doc_type : null;
  const docType = readType ?? docTypeHint ?? 'other';

  const patch = {
    vin: extracted.vin ?? null,
    doc_type: docType,
    file_name: fileName,
    storage_path: stored.path ?? null,
    storage_bucket: stored.bucket ?? null,
    size_bytes: buffer.length,
    extracted: {
      ...extracted,
      pending: false,
      read_via: read.source,
      type_from: readType ? 'reader' : docTypeHint ? 'client' : 'unknown',
    },
    extraction_ok: Boolean(extracted.ok),
    needs_ocr: read.source === 'none',
  };

  const { data, error } = await db()
    .from('booking_documents')
    .update(patch)
    .eq('id', documentId)
    .select()
    .single();
  if (error) {
    console.error('booking_documents update failed:', error.message);
    await abandonDocument(documentId, error.message);
    return { ok: false, error: error.message, extracted };
  }

  // Papers that arrive AFTER the booking was made were left unattached, so the
  // operations desk opened the booking and saw no documents against it even
  // though the customer had sent them. Anything already booked in this chat
  // claims them - by chassis where the document names one.
  let attachedTo = bookingRef ?? null;
  if (!attachedTo) attachedTo = await attachToOpenBooking(data, chatId);
  if (attachedTo) await mrnFromPaper(data, attachedTo).catch((err) => console.error('MRN from paper failed:', err?.message));

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
 * The customer's own MRN export declaration names their MRN; a booking that
 * has none takes it.
 *
 * In the live test the paper was read, its number sat in `extracted`, and
 * bookings.mrn_number stayed empty - so the desk, the PDF and the tracking
 * card all said there was no MRN. Only from a paper read as an MRN, only for
 * the booking's own chassis (or a paper that names none), and never over a
 * number already recorded - the desk's, or an earlier paper's.
 */
export async function mrnFromPaper(document, bookingRef) {
  const mrn = String(document?.extracted?.mrn ?? '').trim().toUpperCase();
  if (document?.doc_type !== 'mrn' || !mrn || !bookingRef) return { recorded: false };
  const { data: booking } = await db().from('bookings').select('booking_ref, vin, mrn_number')
    .eq('booking_ref', bookingRef).maybeSingle();
  if (!booking || booking.mrn_number) return { recorded: false };
  if (document.vin && booking.vin && normalizeVin(document.vin) !== normalizeVin(booking.vin)) return { recorded: false };
  const { data, error } = await db().from('bookings').update({ mrn_number: mrn })
    .eq('booking_ref', bookingRef).is('mrn_number', null).select('booking_ref');
  if (error) {
    console.error('recording the MRN from a paper failed:', error.message);
    return { recorded: false };
  }
  return { recorded: Boolean(data?.length), mrn };
}

/** A file whose reading failed part-way is no longer "still reading". */
export async function abandonDocument(documentId, reason = null) {
  if (!documentId) return;
  await db()
    .from('booking_documents')
    .update({ extracted: { pending: false, ok: false, doc_type: 'other', message: reason ?? 'reading failed' } })
    .eq('id', documentId);
}

/**
 * Full path for one incoming file: record, store, read, extract, fill in.
 *
 * @param {{buffer: Buffer, fileName: string, mimeType: string,
 *          chatId: string|number, channel: string, bookingRef?: string}} file
 */
export async function ingestDocument(file) {
  const begun = await beginDocument({ ...file, size: file.buffer?.length ?? 0 });
  if (!begun.ok) return { ok: false, error: begun.error, extracted: {} };
  return completeDocument(begun.document.id, file);
}

/** Is this row a file that has arrived but has not finished being read? */
export function stillReading(doc) {
  return doc?.extracted?.pending === true;
}

/**
 * The right to reply for a batch of files - won by exactly one of the readers
 * that finish together.
 *
 * "The last to finish speaks" is not enough on its own: three small PDFs read
 * in parallel finish within milliseconds of each other, each looks up, sees no
 * sibling still reading, and all three answer. So the reply is claimed, with
 * the unique index on notification_outbox.idempotency_key as the referee: one
 * row per set of files acknowledged, recorded as already sent so the drain
 * never picks it up. The second claimant for the same set is told no.
 *
 * A file that arrives later, once these are done, is a new set and gets its
 * own reply.
 *
 * @returns {Promise<boolean>} true for the one caller that may speak
 */
export async function claimReply(chatId, documentIds) {
  const ids = [...new Set((documentIds ?? []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!ids.length) return true;

  const chat = String(chatId);
  const channel = channelOf(chat);
  const { error } = await db().from('notification_outbox').insert({
    chat_id: chat,
    telegram_chat_id: channel === 'telegram' ? Number(chat) : null,
    channel,
    event_type: 'document_reply',
    entity_type: 'booking_document',
    entity_id: String(ids[ids.length - 1]),
    payload: { document_ids: ids },
    status: 'sent',
    sent_at: new Date().toISOString(),
    available_at: new Date().toISOString(),
    idempotency_key: `document_reply:${chat}:${ids.join('-')}`.slice(0, 200),
  });

  if (!error) return true;
  if (error.code === '23505') return false;
  // A failure to record the claim is not a reason to say nothing.
  console.error('document reply claim failed:', error.message);
  return true;
}

/**
 * Files from this chat that arrived in the last couple of minutes, oldest
 * first - the ones that could be part of the same batch as a file arriving
 * now. The window bounds the damage a row stuck "still reading" can do.
 */
export async function recentUploads(chatId, { withinMs = 120_000 } = {}) {
  const since = new Date(Date.now() - withinMs).toISOString();
  const { data, error } = await db()
    .from('booking_documents')
    .select('id, doc_type, file_name, vin, extracted, uploaded_at, booking_ref, telegram_message_id')
    .eq('chat_id', String(chatId))
    .gte('uploaded_at', since)
    .is('deleted_at', null)
    .order('uploaded_at', { ascending: true })
    .limit(20);
  if (error) {
    console.error('recent uploads read failed:', error.message);
    return [];
  }
  return data ?? [];
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
 *   mismatched- a file whose own chassis number is not this request's, and
 *               that no later file of its kind has put right
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
    // A paper MKY sent the customer and filed here is ours, not one of theirs.
    if (doc.doc_type === 'mky') continue;
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

  // A wrong-chassis paper the client has since replaced with the right one is
  // behind them. It stays on file - it is the record of what was sent - but
  // it is no longer reported: the document step said "that invoice shows
  // another chassis" again with every later file, after the correct invoice
  // had arrived. One sent AFTER the right one is new, and is reported.
  const sameKind = (a, b) => a === b || (['brief', 'eur1'].includes(a) && ['brief', 'eur1'].includes(b));
  const newer = (a, b) => (a.uploaded_at && b.uploaded_at && a.uploaded_at !== b.uploaded_at
    ? a.uploaded_at > b.uploaded_at
    : Number(a.id) > Number(b.id));
  const outstanding = mismatched.filter((wrong) => !mine.some((right) => sameKind(right.doc_type, wrong.doc_type) && newer(right, wrong)));

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
    mismatched: outstanding.map((d) => ({ type: d.doc_type, file: d.file_name, vin: d.vin })),
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

/**
 * Files these papers on a booking, if they are on none yet.
 *
 * A paper sent from the menu is recorded with no booking (the transport only
 * files under a request still in progress), and then told "received for
 * booking X" - while the desk, which reads a case's papers by reference, never
 * saw it there. A paper that names another chassis is left where it is: it is
 * evidence of a mismatch, not this booking's paper.
 *
 * @returns {Promise<{filed: number[], skipped: number[]}>}
 */
export async function fileDocuments(documentIds, { bookingRef, vin = null }) {
  const ids = [...new Set((documentIds ?? []).map(Number).filter(Number.isFinite))];
  if (!ids.length || !bookingRef) return { filed: [], skipped: [] };
  const { data, error } = await db().from('booking_documents')
    .select('id, vin, booking_ref, doc_type, extracted').in('id', ids).is('booking_ref', null).is('deleted_at', null);
  if (error) {
    console.error('filing documents failed:', error.message);
    return { filed: [], skipped: [] };
  }
  const norm = vin ? normalizeVin(vin) : null;
  const filed = [];
  const skipped = [];
  for (const d of data ?? []) {
    if (norm && d.vin && normalizeVin(d.vin) !== norm) { skipped.push(d.id); continue; }
    const { error: updErr } = await db().from('booking_documents')
      .update({ booking_ref: bookingRef }).eq('id', d.id).is('booking_ref', null);
    if (updErr) {
      console.error('filing a document failed:', updErr.message);
      continue;
    }
    filed.push(d.id);
    await mrnFromPaper(d, bookingRef).catch(() => null);
  }
  return { filed, skipped };
}

/** Which booking each of these papers is on now, by id. */
export async function bookingRefsOf(documentIds) {
  const ids = [...new Set((documentIds ?? []).map(Number).filter(Number.isFinite))];
  if (!ids.length) return new Map();
  const { data } = await db().from('booking_documents').select('id, booking_ref').in('id', ids);
  return new Map((data ?? []).map((d) => [d.id, d.booking_ref ?? null]));
}

/** This chat's papers on no booking yet, newest first, from the last `hours`. */
export async function looseDocuments(chatId, { hours = 24 } = {}) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const { data } = await db().from('booking_documents')
    .select('id, doc_type, file_name, vin, uploaded_at')
    .eq('chat_id', String(chatId)).is('booking_ref', null).is('deleted_at', null)
    .gte('uploaded_at', since).order('uploaded_at', { ascending: false }).limit(20);
  return data ?? [];
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
