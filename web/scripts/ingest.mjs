/**
 * Builds the RAG knowledge base.
 *
 * Reads every PDF and XLSX in data/ (or a file you pass), splits the text into
 * chunks, embeds each chunk, and stores it in the `documents` table.
 *
 *   npm run ingest
 *   npm run ingest -- --file data/tariff-2026.pdf
 *
 * Without OPENAI_API_KEY it still loads the text, and search falls back to
 * Postgres full-text search instead of vectors.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import { db } from '../lib/supabase.js';
import { embed, embeddingsAvailable } from '../lib/llm.js';

// pdf-parse runs a self-test when imported via its index; import the lib directly.
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', 'data');

const CHUNK_CHARS = 1100;
const CHUNK_OVERLAP = 150;

const only = argValue('--file');
const files = only
  ? [path.resolve(process.cwd(), only)]
  : fs.readdirSync(dataDir)
      .filter((f) => /\.(pdf|xlsx)$/i.test(f))
      .map((f) => path.join(dataDir, f));

if (!files.length) {
  console.error(`No .pdf or .xlsx files found in ${dataDir}. Run: npm run gen:data`);
  process.exit(1);
}

const chunks = [];
for (const file of files) {
  const name = path.basename(file);
  const ext = path.extname(file).toLowerCase();
  const pieces = ext === '.pdf' ? await fromPdf(file) : await fromXlsx(file);
  console.log(`  ${name.padEnd(38)} ${pieces.length} chunks`);
  chunks.push(...pieces.map((p) => ({ source: name, ...p })));
}

if (!chunks.length) {
  console.error('Nothing to ingest.');
  process.exit(1);
}

// Replace whatever we previously stored for these files.
const sources = [...new Set(chunks.map((c) => c.source))];
await db().from('documents').delete().in('source', sources);

const useVectors = embeddingsAvailable();
console.log(`\nEmbedding: ${useVectors ? 'on' : 'OFF (keyword search fallback)'}`);

const BATCH = 32;
let done = 0;
for (let i = 0; i < chunks.length; i += BATCH) {
  const batch = chunks.slice(i, i + BATCH);
  let vectors = null;
  if (useVectors) {
    vectors = await embed(batch.map((c) => `${c.title}\n\n${c.content}`));
  }
  const payload = batch.map((c, j) => ({
    source: c.source,
    title: c.title,
    content: c.content,
    metadata: c.metadata ?? {},
    embedding: vectors ? vectors[j] : null,
  }));
  const { error } = await db().from('documents').insert(payload);
  if (error) throw new Error(`insert failed: ${error.message}`);
  done += batch.length;
  process.stdout.write(`\r  stored ${done}/${chunks.length}`);
}

console.log(`\n\nKnowledge base ready: ${done} chunks from ${sources.length} file(s).`);

// ---------------------------------------------------------------------------

async function fromPdf(file) {
  const { text } = await pdfParse(fs.readFileSync(file));
  const cleaned = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return splitText(cleaned, path.basename(file, '.pdf').replace(/_/g, ' '));
}

async function fromXlsx(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const out = [];

  wb.eachSheet((sheet) => {
    // "Company Info" style sheets: topic + long detail -> one chunk per row.
    const headers = [];
    sheet.getRow(1).eachCell((cell, col) => {
      headers[col] = String(cellText(cell.value)).trim().toLowerCase();
    });

    const isProse = headers.includes('topic') && headers.includes('detail');
    const lines = [];

    sheet.eachRow((row, idx) => {
      if (idx === 1) return;
      const values = [];
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        const v = String(cellText(cell.value)).trim();
        if (v) values.push(`${headers[col]}: ${v}`);
      });
      if (!values.length) return;

      if (isProse) {
        const topic = String(cellText(row.getCell(headers.indexOf('topic')).value)).trim();
        const detail = String(cellText(row.getCell(headers.indexOf('detail')).value)).trim();
        out.push(...splitText(detail, topic));
      } else {
        lines.push(values.join(' | '));
      }
    });

    // Tabular sheets: pack rows together so a chunk holds several records.
    for (let i = 0; i < lines.length; i += 8) {
      const block = lines.slice(i, i + 8).join('\n');
      if (block.trim()) {
        out.push({
          title: `${sheet.name} (rows ${i + 1}-${i + Math.min(8, lines.length - i)})`,
          content: `Sheet: ${sheet.name}\n${block}`,
          metadata: { sheet: sheet.name },
        });
      }
    }
  });

  return out;
}

/** Paragraph-aware splitter with a small overlap so sentences are not cut. */
function splitText(text, title) {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  let buf = '';

  const flush = () => {
    if (!buf.trim()) return;
    out.push({ title, content: buf.trim(), metadata: {} });
    buf = buf.length > CHUNK_OVERLAP ? buf.slice(-CHUNK_OVERLAP) : '';
  };

  for (const p of paragraphs) {
    if (buf.length + p.length > CHUNK_CHARS) flush();
    if (p.length > CHUNK_CHARS) {
      for (const sentence of p.match(/[^.!?]+[.!?]*\s*/g) ?? [p]) {
        if (buf.length + sentence.length > CHUNK_CHARS) flush();
        buf += sentence;
      }
    } else {
      buf += (buf ? '\n\n' : '') + p;
    }
  }
  if (buf.trim()) out.push({ title, content: buf.trim(), metadata: {} });
  return out;
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('text' in value) return value.text;
    if ('result' in value) return value.result;
    if ('richText' in value) return value.richText.map((t) => t.text).join('');
  }
  return value;
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}
