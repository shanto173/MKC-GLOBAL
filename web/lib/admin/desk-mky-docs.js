/**
 * The desk's end of the papers MKY issues: the CMR and the MRN sheet.
 *
 *   GET  ?view=mky_document&ref=MKY-BKG-…&kind=cmr   the form, as it stands
 *   POST { action: 'mky_document_save',  ref, kind, values }
 *   POST { action: 'mky_document_issue', ref, kind, values }
 *
 * Saving and issuing are deliberately two things. A CMR is filled in from six
 * places and the person doing it gets interrupted; the draft is theirs to come
 * back to. Issuing is the moment it becomes a document - rendered, stored, and
 * filed against the booking where it is listed, opened, printed and sent like
 * any other paper.
 */

import { db } from '../supabase.js';
import { audit } from '../audit.js';
import { signedUrl } from '../storage.js';
import { requiredDocuments } from '../settings.js';
import { FORMS, KINDS, formFor, saveForm, issueForm } from '../mky-docs.js';

const UNSUPPORTED = 'Issuing documents needs a database change that has not been applied yet.';

/** The booking and the papers a form is filled in from. */
async function contextFor(ref) {
  const { data: booking } = await db().from('bookings').select('*').eq('booking_ref', ref).maybeSingle();
  if (!booking) return null;
  const [{ data: documents }, { data: mrn }] = await Promise.all([
    db().from('booking_documents').select('doc_type, extracted').eq('booking_ref', ref).is('deleted_at', null),
    db().from('mrn_requests').select('*').eq('booking_ref', ref).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  await requiredDocuments({ mrnChoice: booking.mrn_choice ?? 'existing' }).catch(() => []);
  return { booking, documents: documents ?? [], mrn: mrn ?? null };
}

const kindOf = (v) => (KINDS.includes(String(v)) ? String(v) : null);

/** GET view=mky_document */
export async function mkyDocumentView(req, res) {
  const ref = String(req.query.ref ?? '').trim();
  const kind = kindOf(req.query.kind);
  if (!ref || !kind) return res.status(400).json({ error: 'ref and kind are required.' });

  const context = await contextFor(ref);
  if (!context) return res.status(404).json({ error: `There is no booking ${ref}.` });

  const form = await formFor(kind, ref, context);
  if (!form.available) return res.status(503).json({ error: UNSUPPORTED });

  // A short-lived link to the issued paper, so it opens and prints from the
  // dialog without a second round trip.
  const url = form.storage_path && form.status === 'issued'
    ? await signedUrl(form.storage_path, 60 * 30).catch(() => null)
    : null;

  return res.status(200).json({ ...form, booking_ref: ref, url: url ?? null });
}

/** POST action=mky_document_save */
export async function saveMkyDocument(req, res, who) {
  const ref = String(req.body?.ref ?? '').trim();
  const kind = kindOf(req.body?.kind);
  if (!ref || !kind) return res.status(400).json({ error: 'ref and kind are required.' });

  const saved = await saveForm(kind, ref, req.body?.values ?? {}, who);
  if (!saved.ok) return res.status(saved.unsupported ? 503 : 500).json({ error: saved.unsupported ? UNSUPPORTED : 'That did not save. Try again.' });

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'mky_document_saved',
    entity_type: 'booking', entity_id: ref, metadata: { kind },
  });
  return res.status(200).json({ ok: true, values: saved.fields, status: 'draft' });
}

/** POST action=mky_document_issue */
export async function issueMkyDocument(req, res, who) {
  const ref = String(req.body?.ref ?? '').trim();
  const kind = kindOf(req.body?.kind);
  if (!ref || !kind) return res.status(400).json({ error: 'ref and kind are required.' });

  const context = await contextFor(ref);
  if (!context) return res.status(404).json({ error: `There is no booking ${ref}.` });

  // Nothing is invented on a document that leaves this building: a form with
  // its named essentials still blank is refused, with the blanks named.
  const values = req.body?.values ?? {};
  const required = kind === 'cmr'
    ? ['sender', 'consignee', 'delivery_place', 'goods', 'carrier']
    : ['mrn_number', 'exporter', 'consignee', 'vehicle'];
  const blank = required.filter((key) => !String(values[key] ?? '').trim());
  if (blank.length) {
    const label = (key) => FORMS[kind].fields.find((f) => f.key === key)?.label ?? key;
    return res.status(409).json({
      error: `Still blank: ${blank.map(label).join(', ')}.`,
      blank,
    });
  }

  const issued = await issueForm(kind, ref, values, who, context);
  if (!issued.ok) {
    return res.status(issued.unsupported ? 503 : 500)
      .json({ error: issued.unsupported ? UNSUPPORTED : (issued.error ?? 'That did not issue. Try again.') });
  }

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'mky_document_issued',
    entity_type: 'booking', entity_id: ref,
    metadata: { kind, document_no: issued.document_no },
  });

  const url = await signedUrl(issued.storage_path, 60 * 30).catch(() => null);
  return res.status(200).json({
    ok: true, status: 'issued', document_no: issued.document_no,
    issued_at: issued.issued_at, file_name: issued.fileName, url: url ?? null,
  });
}
