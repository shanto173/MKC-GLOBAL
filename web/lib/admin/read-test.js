/**
 * Why could a document not be read?
 *
 *   GET /api/admin/read-test?path=<storage_path>
 *
 * Runs the two reading routes - the PDF's text layer, then rendering it to an
 * image - against a file already in storage, and reports what each one did.
 *
 * This exists because a document that reads perfectly on a laptop came back
 * from the deployed bot as "this is a scan and could not be read". The customer
 * was told to photograph a document that was already perfectly readable, and
 * nothing in the reply said which step had failed or why.
 */

import { config } from '../config.js';
import { db } from '../supabase.js';
import { downloadDocument } from '../storage.js';
import { pdfText, pdfToImages } from '../read-file.js';

export default async function handler(req, res) {
  const secret = req.query.secret ?? req.headers['x-admin-secret'];
  if (!config.adminSecret || secret !== config.adminSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let path = String(req.query.path ?? '').trim();

  // No path given: take the most recent document that failed to read.
  if (!path) {
    const { data } = await db()
      .from('booking_documents')
      .select('storage_path, file_name, extraction_ok')
      .order('id', { ascending: false })
      .limit(10);
    const failed = (data ?? []).find((d) => d.extraction_ok === false && d.storage_path);
    if (!failed) return res.status(404).json({ error: 'No failed document to test. Pass ?path=' });
    path = failed.storage_path;
  }

  const report = { path, node: process.version, steps: {} };

  let buffer;
  try {
    buffer = await downloadDocument(path);
    report.steps.download = { ok: true, bytes: buffer.length };
  } catch (err) {
    report.steps.download = { ok: false, error: err.message };
    return res.status(200).json(report);
  }

  try {
    const text = await pdfText(buffer);
    report.steps.text_layer = {
      ok: true,
      characters: text.length,
      enough: text.length >= 120,
      sample: text.slice(0, 240),
    };
  } catch (err) {
    report.steps.text_layer = { ok: false, error: `${err.name}: ${err.message}`, stack: String(err.stack).split('\n').slice(0, 4) };
  }

  try {
    const images = await pdfToImages(buffer, 1);
    report.steps.render = { ok: true, pages: images.length, bytes: images[0]?.length ?? 0 };
  } catch (err) {
    report.steps.render = { ok: false, error: `${err.name}: ${err.message}`, stack: String(err.stack).split('\n').slice(0, 4) };
  }

  res.status(200).json(report);
}
