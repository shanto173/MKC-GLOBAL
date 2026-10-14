/**
 * MKY's letterhead, as it is printed on their own paper.
 *
 * One drawing, used by everything that leaves here: the shipping label, the
 * booking sheet the bot sends, the CMR and the MRN. A customer who has seen one
 * of their documents recognises the next without reading a word of it, which is
 * the whole point of a letterhead and the reason this is not three near-copies
 * in three files.
 *
 * What is on it, from MKY's label: the red band across the head, the badge over
 * its left end, the company name under it in their blue, and how to reach them
 * on the right. Then the two red rules that run under the head of every sheet.
 *
 * The phone and the email are passed in - never defaulted here. A document that
 * invents a number somebody has to answer is worse than one with no number on
 * it, and the numbers live in the desk's Settings.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const ASSETS = fileURLToPath(new URL('../assets/', import.meta.url));
export const LOGO = path.join(ASSETS, 'mky-logo.png');

/** MKY's own two, taken from the label they print. */
export const RED = '#c00000';
export const BLUE = '#0070c0';
export const INK = '#101010';

/**
 * Draws the head and returns the y to carry on below it.
 *
 * @param {PDFDocument} doc
 * @param {object} o
 * @param {number} o.left   left edge of the content
 * @param {number} o.right  right edge of the content
 * @param {number} [o.top]  where the red band starts
 * @param {string|null} [o.phone]
 * @param {string|null} [o.email]
 * @param {number} [o.scale] 1 for A4 portrait; the label prints it larger
 */
export function letterhead(doc, { left, right, top = 30, phone = null, email = null, scale = 1 }) {
  const bandH = 22 * scale;
  const logoH = 58 * scale;

  // The band first, then the badge over it: on MKY's label the logo overlaps
  // the red and hangs below it.
  doc.save().rect(left + 18 * scale, top, right - left - 18 * scale, bandH).fill(RED).restore();

  let nameX = left;
  try {
    if (fs.existsSync(LOGO)) {
      doc.image(LOGO, left, top - 6 * scale, { height: logoH });
      nameX = left + logoH * 1.45;
    }
  } catch { /* the sheet is still the sheet without it */ }

  // The name sits under the band, beside the badge, in their blue - exactly as
  // the label has it.
  const nameY = top + bandH + 14 * scale;
  doc.font('Helvetica-Bold').fontSize(11 * scale).fillColor(BLUE)
    .text(String(config.companyName || 'MKY Global Forwarding').toUpperCase(), nameX, nameY, { lineBreak: false });

  // How to reach them, right-aligned against the margin.
  doc.font('Helvetica-Bold').fontSize(9 * scale).fillColor(INK);
  const contact = [phone ? `phone: ${phone}` : null, email ? `Email: ${email}` : null].filter(Boolean);
  contact.forEach((row, i) => {
    doc.text(row, right - doc.widthOfString(row), top + bandH + 6 * scale + i * 13 * scale, { lineBreak: false });
  });

  const y = Math.max(nameY + 16 * scale, top + logoH + 4 * scale);
  rules(doc, { left, right, y, scale });
  return y + 12 * scale;
}

/** The two red rules that run under the head, and between the blocks. */
export function rules(doc, { left, right, y, scale = 1 }) {
  const w = 2.2 * scale;
  doc.save().lineWidth(w).strokeColor(RED).moveTo(left, y).lineTo(right, y).stroke();
  doc.lineWidth(w).strokeColor(RED).moveTo(left, y + 6 * scale).lineTo(right, y + 6 * scale).stroke().restore();
}

/**
 * The three lines MKY writes on everything - the route, the marks and the
 * chassis - each on its own red-ruled row. On the label they are read from
 * across a yard; on a sheet they are what tells a reader which unit this is
 * before any of the detail below.
 *
 * `write` draws one value, so a caller that has Arabic to place can pass its
 * own bidi-aware writer; without one the text is drawn as given.
 */
export function marksBlock(doc, {
  left, right, y, route, marks, chassis, size = 13, labelSize = 10, write = null,
}) {
  const labelW = Math.max(110, (right - left) * 0.28);
  const put = write ?? ((text, x, ty, fontSize) => {
    doc.font('Helvetica-Bold').fontSize(fontSize).fillColor(INK).text(text, x, ty, { lineBreak: false });
  });

  let ty = y;
  for (const [label, value] of [route, marks, chassis]) {
    doc.font('Helvetica-Bold').fontSize(labelSize).fillColor(INK)
      .text(label, left + 4, ty + (size - labelSize) / 2, { lineBreak: false });
    put(String(value || '—'), left + labelW, ty, size);
    ty += size + 10;
    doc.save().lineWidth(1).strokeColor(RED).moveTo(left, ty).lineTo(right, ty).stroke().restore();
    ty += 10;
  }
  return ty;
}
