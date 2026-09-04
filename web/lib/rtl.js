/**
 * Right-to-left text layout for PDFKit.
 *
 * Two separate problems have to be solved, and in the right order:
 *
 *  1. SHAPING - Arabic letters change form depending on their neighbours, and
 *     lam+alef becomes one ligature. fontkit (inside PDFKit) does this correctly,
 *     but only when it receives the text in LOGICAL order.
 *
 *  2. BIDI - a line mixing Arabic with Latin (a booking reference, a port name,
 *     an Incoterm) has to be reordered so the Latin run sits to the LEFT of the
 *     Arabic that precedes it logically. PDFKit does not do this at all.
 *
 * So we must not hand reversed characters to PDFKit: that would produce correctly
 * ordered text made of wrongly shaped letters. Instead we split the line into
 * directional runs, put the RUNS in visual order, and draw each run in logical
 * order so fontkit can still shape it.
 */

import bidiFactory from 'bidi-js';

const bidi = bidiFactory();

/** True if the string contains Arabic (or Arabic-Supplement / Presentation) letters. */
export function hasArabic(text) {
  return /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/.test(String(text ?? ''));
}

/**
 * Split one line into directional runs, returned in visual left-to-right order.
 * Each run keeps its text in logical order, ready for shaping.
 *
 * @param {string} text
 * @param {'rtl'|'ltr'} baseDir
 * @returns {{text: string, rtl: boolean}[]}
 */
export function bidiRuns(text, baseDir = 'rtl') {
  const str = String(text ?? '');
  if (!str) return [];

  const embedding = bidi.getEmbeddingLevels(str, baseDir);
  const levels = embedding.levels;
  const order = bidi.getReorderedIndices(str, embedding);

  const runs = [];
  let start = null;   // index in `order` where the current run began
  let prev = null;

  const flush = (endExclusive) => {
    if (start === null) return;
    const slice = order.slice(start, endExclusive);
    const lo = Math.min(...slice);
    const hi = Math.max(...slice);
    // Whatever the visual direction, the logical text is simply the substring
    // between the lowest and highest source index in this run.
    runs.push({ text: str.slice(lo, hi + 1), rtl: levels[lo] % 2 === 1 });
  };

  for (let i = 0; i < order.length; i++) {
    const idx = order[i];
    const sameRun =
      prev !== null &&
      levels[idx] === levels[prev] &&
      (idx === prev + 1 || idx === prev - 1);
    if (!sameRun) {
      flush(i);
      start = i;
    }
    prev = idx;
  }
  flush(order.length);

  return runs.filter((r) => r.text.length);
}

/**
 * Draw a single line of possibly-mixed text, aligned within [x, x + width].
 * Returns the width actually used.
 */
export function drawBidiLine(doc, text, x, y, width, { align = 'right', baseDir = 'rtl' } = {}) {
  const runs = bidiRuns(text, baseDir);
  if (!runs.length) return 0;

  const widths = runs.map((r) => doc.widthOfString(r.text));
  const total = widths.reduce((a, b) => a + b, 0);

  let cursor = x;
  if (align === 'right') cursor = x + width - total;
  else if (align === 'center') cursor = x + (width - total) / 2;

  runs.forEach((run, i) => {
    doc.text(run.text, cursor, y, { lineBreak: false, width: widths[i] + 2 });
    cursor += widths[i];
  });

  return total;
}

/**
 * Word-wrap and draw a paragraph. PDFKit's own wrapping cannot be used because
 * it would break the line before bidi reordering, putting words on the wrong side.
 *
 * @returns {number} the y coordinate just below the last line drawn
 */
export function drawBidiParagraph(doc, text, x, y, width, { align = 'right', baseDir = 'rtl', lineGap = 4 } = {}) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return y;

  const lineHeight = doc.currentLineHeight() + lineGap;
  const lines = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && doc.widthOfString(candidate) > width) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);

  let cursor = y;
  for (const l of lines) {
    drawBidiLine(doc, l, x, cursor, width, { align, baseDir });
    cursor += lineHeight;
  }
  return cursor;
}
