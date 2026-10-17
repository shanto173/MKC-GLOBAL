/**
 * Turns an uploaded file into something the extractor can read.
 *
 * Three kinds of file arrive from customers:
 *   - a PDF with a real text layer (an exported invoice, a Nafeza printout)
 *   - a PDF that is only a scan, with no text at all (the EUR.1 certificates)
 *   - a photograph taken on a phone
 *
 * The first is read as text. The other two are read by the model's vision,
 * which handles Romanian, Polish and Arabic forms - and handwritten customs
 * stamps - without a separate OCR service.
 */

import { chat, imageMessage } from './llm.js';

/** Below this, a "PDF" is really a scan and its text layer is noise. */
const MIN_USEFUL_TEXT = 120;

/**
 * Two pages is the whole of what a booking needs.
 *
 * A vehicle's papers run to four pages, but the chassis number, the make, the
 * weights and the parties are all on the first; page three of a Spanish
 * registration certificate is the ITV inspection sheet, nothing but dated
 * stamps, and it only repeats the chassis. Each page is a call to a model that
 * sees, so the pages past these cost money and tell the booking nothing.
 */
const MAX_VISION_PAGES = 2;

/**
 * About 215 dpi off an A4 page: enough to tell a run of five zeros from a run
 * of six on a stamped, hand-filled form. At 1.6 it was not, and a chassis
 * number came back a character short.
 *
 * JPEG, not PNG: a scan is a photograph, and a page that is 3.2 MB of PNG is
 * 1.2 MB of JPEG at half again the resolution, with nothing lost a reader can
 * see. The big one is slow to send and, past about 3.7 MB, more than Anthropic
 * accepts at all.
 */
const RENDER_SCALE = 3.0;
const JPEG_QUALITY = 82;

/** Small enough to be quick to judge, large enough to see which way words run. */
const ORIENT_SCALE = 1.6;

/**
 * Where the line between an upright page and a sideways one goes.
 *
 * Measured, not guessed. Over 90 specimen pages rendered each way, and the
 * four scans this was written for, the ratio of ink variance across the page
 * to ink variance down it came out:
 *
 *   upright   0.00 - 0.80   (usually near zero: lines of text band the rows)
 *   sideways  1.20 and up   (into the thousands on a plain page of text)
 *
 * The two sides are nothing like symmetrical. An upright page is unmistakable,
 * but a dense grid form - a vehicle registration certificate is ruled in both
 * directions - barely clears 1.2 when it is on its side, because the rules
 * band the rows almost as strongly as the text does. So the line sits at 0.9,
 * down near the weak side, where it is clear of both.
 */
export const SIDEWAYS_RATIO = 0.9;

export function isImage(mimeType, fileName = '') {
  return /^image\//.test(mimeType ?? '') || /\.(jpe?g|png|webp|heic|gif)$/i.test(fileName);
}

export function isPdf(mimeType, fileName = '') {
  return /pdf/i.test(mimeType ?? '') || /\.pdf$/i.test(fileName);
}

/**
 * pdf.js, with its worker already in hand.
 *
 * pdf.js works out the path to its own worker at runtime, so a deployment that
 * bundles only the files it can see never shipped pdf.worker.mjs - and every
 * PDF failed in production with "Setting up fake worker failed", while every
 * PDF read perfectly on a laptop where the file simply sits on disk. Customers
 * were being asked to photograph documents that were already readable.
 *
 * Importing the worker here does two things: the bundler can see this
 * specifier, so the file ships; and pdf.js finds the handler on globalThis and
 * never goes looking for a file at all.
 */
let pdfjsReady = null;

export function loadPdfjs() {
  pdfjsReady ??= (async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    if (!globalThis.pdfjsWorker) {
      globalThis.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    }
    return pdfjs;
  })();
  return pdfjsReady;
}

/** Plain text out of a PDF's text layer. Empty string when it is a scan. */
export async function pdfText(buffer) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;

  let out = '';
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    let lastY = null;
    for (const item of content.items) {
      const y = item.transform?.[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) out += '\n';
      out += item.str;
      lastY = y;
    }
    out += '\n\n';
  }
  return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** Renders the first pages of a PDF to JPEG, the right way up, for the model. */
export async function pdfToImages(buffer, maxPages = MAX_VISION_PAGES) {
  const [{ createCanvas }, pdfjs] = await Promise.all([
    import('@napi-rs/canvas'),
    loadPdfjs(),
  ]);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;

  const images = [];
  let turn = null;
  for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
    const page = await doc.getPage(n);
    // A scanner feeds a batch the same way, so the first page decides for all.
    turn ??= await uprightTurn((at) => drawPage(createCanvas, page, ORIENT_SCALE, at));
    const canvas = await drawPage(createCanvas, page, RENDER_SCALE, turn);
    images.push(canvas.toBuffer('image/jpeg', JPEG_QUALITY));
  }
  return images;
}

/** One page onto a white canvas, turned `turn` degrees past its own rotation. */
async function drawPage(createCanvas, page, scale, turn) {
  const viewport = page.getViewport({ scale, rotation: (page.rotate + turn) % 360 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  return canvas;
}

/**
 * Which way up a scan is.
 *
 * Customers scan vehicle papers sideways - a landscape registration
 * certificate through a portrait scanner - and handing the model a page it has
 * to read down the side is what made chassis numbers come back wrong. On four
 * of these from one customer the reader got one right: WKESD000000510879 was
 * filed as WKE5KD000001510879, and WSM00000005106764 as nothing at all. Turned
 * upright first, the same reader and the same model got three of the four, and
 * the fourth came back empty rather than wrong, which is a question for the
 * client instead of a rejected declaration.
 *
 * Working out the axis costs nothing: lines of text leave bands of ink with
 * white between them, so ink varies far more across the baselines than along
 * them. That tells upright from sideways but not which of the two sideways
 * turns it is, and a page read upside down is as bad as one read sideways - so
 * the model is asked, once per document, one yes/no question about a page that
 * is already on the right axis. It answered that one correctly every time;
 * asked the open question - 90, 180 or 270 - it did not.
 */
async function uprightTurn(draw) {
  const flat = await draw(0);
  const turn = looksSideways(flat) ? 90 : 0;
  const upright = turn === 0 ? flat : await draw(turn);
  const inverted = await looksUpsideDown(upright.toBuffer('image/jpeg', JPEG_QUALITY));
  return (turn + (inverted ? 180 : 0)) % 360;
}

/** True when the page's lines of text run down the side rather than across it. */
export function looksSideways(canvas) {
  const { width, height } = canvas;
  const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
  const rows = new Float64Array(height);
  const cols = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Rec. 601 luma; 140 keeps the grey of a scanned page out of the count.
      if (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114 < 140) {
        rows[y]++;
        cols[x]++;
      }
    }
  }
  // A page with no ink on it bands neither way: leave it as it came.
  const down = spread(rows, width);
  return down > 0 && spread(cols, height) / down > SIDEWAYS_RATIO;
}

/** How unevenly ink is spread along one axis, as a variance of densities. */
function spread(counts, across) {
  let mean = 0;
  for (const count of counts) mean += count / across;
  mean /= counts.length;
  let variance = 0;
  for (const count of counts) variance += ((count / across) - mean) ** 2;
  return variance / counts.length;
}

/** Asks the model the one thing the ink cannot say: is this page upside down? */
async function looksUpsideDown(jpeg) {
  try {
    const { content } = await chat({
      system: 'You answer with one word and nothing else.',
      messages: [imageMessage(
        'Look at the printed words on this scanned page. Are they upside down? Answer only YES or NO.',
        jpeg,
        'image/jpeg',
      )],
      tools: [],
      fast: true,
    });
    return /yes/i.test(content);
  } catch (err) {
    // Not worth failing a document over. Leave it on the axis the ink found.
    console.error('page orientation check failed:', err.message);
    return false;
  }
}

/**
 * Reads a document however it can, and says which route it used.
 *
 * @returns {Promise<{text: string, source: 'text'|'vision'|'none', pages?: number, error?: string}>}
 */
export async function readDocument({ buffer, mimeType, fileName = '', visionPrompt }) {
  if (isImage(mimeType, fileName)) {
    // A photograph taken sideways reads as badly as a page scanned sideways,
    // and it is NOT turned here on purpose. Turning one means decoding it, and
    // @napi-rs/canvas does not fail on a malformed image, it segfaults: a
    // truncated JPEG takes the whole function down, so the customer gets no
    // reply at all and their document stays "still reading" for ever. A
    // sideways photograph read badly is the far smaller harm. To do this
    // properly the decode has to be somewhere a crash cannot reach.
    const text = await describeImages([buffer], mimeType || 'image/jpeg', visionPrompt);
    return { text, source: 'vision', pages: 1 };
  }

  if (isPdf(mimeType, fileName)) {
    let text = '';
    try {
      text = await pdfText(buffer);
    } catch (err) {
      console.error('pdf text extraction failed:', err.message);
    }

    if (text.length >= MIN_USEFUL_TEXT) return { text, source: 'text' };

    // A scan. Render it and let the model look at it instead.
    try {
      const images = await pdfToImages(buffer);
      if (!images.length) return { text: '', source: 'none', error: 'The PDF has no pages we could render.' };
      const described = await describeImages(images, 'image/jpeg', visionPrompt);
      return { text: described, source: 'vision', pages: images.length };
    } catch (err) {
      console.error('pdf render failed:', err.message);
      return {
        text,
        source: 'none',
        detail: err.message,
        error:
          'This PDF could not be read automatically - the fault may be ours, not the file. Tell ' +
          'the customer it has been saved and that our team will read it, and do NOT ask them to ' +
          'send it again in another format unless they offer. If they have the numbers to hand ' +
          '(chassis, MRN, ACID), they can type them instead.',
      };
    }
  }

  return { text: '', source: 'none', error: `Unsupported file type: ${mimeType || fileName}` };
}

/** Asks the model to transcribe what it can see, page by page. */
async function describeImages(images, mimeType, visionPrompt) {
  const instruction =
    visionPrompt ??
    'Transcribe every field and value you can see in this freight or customs document. ' +
      'Include labels, reference numbers, names, addresses, weights and dates exactly as printed, ' +
      'in the original language. Do not summarise, translate or interpret - transcribe. ' +
      // A chassis number is mostly a run of zeros, and a run read by eye comes
      // out one short: WSM00000005106764 was transcribed WSM0000005106764.
      'Where a number or code contains a run of the same character repeated, count the ' +
      'repetitions one by one and write every one of them. A chassis number is 17 characters.';

  // Pages are read at once, not one after the other. Nothing on page two
  // depends on page one, and a document took as long as the sum of its pages
  // while the function it runs in is allowed sixty seconds in total.
  const parts = await Promise.all(images.map(async (img, i) => {
    const { content } = await chat({
      system:
        'You transcribe shipping and customs paperwork. Reproduce exactly what is printed, ' +
        'including handwriting and stamps. Never invent a value you cannot read; write [unclear] instead.',
      messages: [imageMessage(instruction, img, mimeType)],
      tools: [],
      // Transcribing what is on a page, not deciding anything.
      fast: true,
    });
    return images.length > 1 ? `--- page ${i + 1} ---\n${content}` : content;
  }));
  return parts.join('\n\n').trim();
}
