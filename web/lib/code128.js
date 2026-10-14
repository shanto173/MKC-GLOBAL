/**
 * Code 128, character set B, drawn straight into a PDF.
 *
 * An export declaration carries its MRN as a bar code - the EU printout
 * guidelines put it to the right of box 1 and name this symbology and this
 * character set - and a customs office reads the number off the bars. A sheet
 * with the MRN in type alone is not the document.
 *
 * Forty lines and a width table beats a dependency for one bar code, and
 * pdfkit already draws rectangles.
 */

/**
 * Bar and space widths, in modules, for values 0-106. Each pattern alternates
 * bar, space, bar... and every one is 11 modules wide; the stop pattern is 13.
 */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

const START_B = 104;
const STOP = 106;

// A mistyped width is the one way this file can be wrong, and it would print a
// bar code that scans as the wrong number - worse than none at all. Every
// pattern is 11 modules, the stop is 13: checked once, at import.
for (const [i, p] of PATTERNS.entries()) {
  const sum = [...p].reduce((n, d) => n + Number(d), 0);
  const want = i === STOP ? 13 : 11;
  if (sum !== want) throw new Error(`code128: pattern ${i} is ${sum} modules, expected ${want}`);
}

/** Set B covers ASCII 32-126; anything else cannot be encoded. */
export function encodable(text) {
  return [...String(text)].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126);
}

/** The values of a Code 128-B symbol: start, data, check digit, stop. */
export function symbol(text) {
  const data = [...String(text)].map((c) => c.charCodeAt(0) - 32);
  const check = data.reduce((sum, v, i) => sum + v * (i + 1), START_B) % 103;
  return [START_B, ...data, check, STOP];
}

/**
 * Draws the bar code and returns the width it used.
 *
 * `width` is the space it may fill; the module is sized to fit it and the bars
 * are drawn from `x`. A symbol narrower than the space given is not stretched -
 * a scanner wants even modules, not a justified line.
 */
export function code128(doc, text, { x, y, width, height = 26 }) {
  if (!encodable(text)) return 0;
  const values = symbol(text);
  // Ten modules of quiet zone, as the standard asks, inside the space given.
  const modules = values.reduce((n, v) => n + [...PATTERNS[v]].reduce((m, d) => m + Number(d), 0), 0);
  const unit = Math.max(0.5, width / (modules + 20));

  let cursor = x + unit * 10;
  doc.save().fillColor('#000000');
  for (const v of values) {
    let bar = true;
    for (const d of PATTERNS[v]) {
      const w = Number(d) * unit;
      if (bar) doc.rect(cursor, y, w, height).fill();
      cursor += w;
      bar = !bar;
    }
  }
  doc.restore();
  return cursor - x + unit * 10;
}
