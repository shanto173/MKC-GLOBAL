/**
 * Reads stored documents again, for the ones that failed the first time.
 *
 *   npm run reread                 show what would be re-read
 *   npm run reread -- --apply      do it
 *   npm run reread -- --apply --chat 1302305956
 *   npm run reread -- --apply --ids 98,99,100,101
 *
 * Documents whose extraction failed are still in storage, so a fault on our
 * side - the deployed function shipping without pdf.js's worker, for instance -
 * does not have to mean asking the customer to send everything again.
 *
 * --ids is for the other kind of fault: a document that was read without
 * complaint and read WRONG. Scans fed through a scanner sideways came back
 * with a chassis number a character out, and nothing about the row said so -
 * extraction_ok was true. Those rows are invisible to the default query, and
 * naming them is the only way to pick them up.
 */

import 'dotenv/config';

const apply = process.argv.includes('--apply');
const chatArg = process.argv.indexOf('--chat');
const onlyChat = chatArg > -1 ? process.argv[chatArg + 1] : null;
const idsArg = process.argv.indexOf('--ids');
const onlyIds = idsArg > -1
  ? String(process.argv[idsArg + 1] ?? '').split(',').map((id) => Number(id.trim())).filter(Number.isInteger)
  : null;

const { db } = await import('../lib/supabase.js');
const { downloadDocument } = await import('../lib/storage.js');
const { readDocument } = await import('../lib/read-file.js');
const { extractDocument } = await import('../lib/extract.js');

const query = db()
  .from('booking_documents')
  .select('id, chat_id, file_name, mime_type, storage_path, extraction_ok, needs_ocr, vin')
  .order('id', { ascending: true })
  .limit(50);
// Named rows are taken as they are; otherwise it is the ones that failed.
if (onlyIds?.length) query.in('id', onlyIds);
else query.eq('extraction_ok', false);
if (onlyChat) query.eq('chat_id', String(onlyChat));

const { data: failed, error } = await query;
if (error) {
  console.error('could not list documents:', error.message);
  process.exit(1);
}

console.log(onlyIds?.length
  ? `${failed.length} document(s) named for re-reading`
  : `${failed.length} document(s) failed to read${onlyChat ? ` in chat ${onlyChat}` : ''}`);
if (!apply) console.log('Dry run - add --apply to read them again.\n');

let fixed = 0;
for (const doc of failed) {
  if (!doc.storage_path) {
    console.log(`  ${doc.file_name}: no stored copy, cannot retry`);
    continue;
  }
  try {
    const buffer = await downloadDocument(doc.storage_path);
    const read = await readDocument({ buffer, mimeType: doc.mime_type, fileName: doc.file_name });
    if (!read.text) {
      console.log(`  ${doc.file_name}: still unreadable (${read.error ?? 'no text'})`);
      continue;
    }
    const extracted = await extractDocument(read.text, { fileName: doc.file_name });
    const found = [
      extracted.vin && `chassis ${extracted.vin}`,
      extracted.mrn && `MRN ${extracted.mrn}`,
      extracted.acid && `ACID ${extracted.acid}`,
    ].filter(Boolean).join(', ');
    const moved = (doc.vin ?? null) !== (extracted.vin ?? null);
    console.log(`  ${doc.file_name}: ${extracted.doc_type}${found ? ` - ${found}` : ''} (read via ${read.source})`
      + (moved ? `
     chassis was ${doc.vin ?? 'none'}, now ${extracted.vin ?? 'none'}` : ''));

    if (apply) {
      const { error: updErr } = await db()
        .from('booking_documents')
        .update({
          vin: extracted.vin ?? null,
          doc_type: extracted.doc_type ?? 'other',
          extracted: { ...extracted, read_via: read.source, reread: true },
          extraction_ok: Boolean(extracted.ok),
          needs_ocr: read.source === 'none',
        })
        .eq('id', doc.id);
      if (updErr) console.log(`     could not save: ${updErr.message}`);
      else fixed++;
    }
  } catch (err) {
    console.log(`  ${doc.file_name}: ${err.message}`);
  }
}

console.log(`\n${apply ? `${fixed} updated.` : 'Nothing written.'}`);
