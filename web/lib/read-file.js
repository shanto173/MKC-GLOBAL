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
const MAX_VISION_PAGES = 2;

export function isImage(mimeType, fileName = '') {
  return /^image\//.test(mimeType ?? '') || /\.(jpe?g|png|webp|heic|gif)$/i.test(fileName);
}

export function isPdf(mimeType, fileName = '') {
  return /pdf/i.test(mimeType ?? '') || /\.pdf$/i.test(fileName);
}

/** Plain text out of a PDF's text layer. Empty string when it is a scan. */
export async function pdfText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
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

/** Renders the first pages of a PDF to PNG so the model can look at them. */
export async function pdfToImages(buffer, maxPages = MAX_VISION_PAGES) {
  const [{ createCanvas }, pdfjs] = await Promise.all([
    import('@napi-rs/canvas'),
    import('pdfjs-dist/legacy/build/pdf.mjs'),
  ]);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;

  const images = [];
  for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
    const page = await doc.getPage(n);
    // 1.6 is enough for stamped, hand-filled forms without making the image huge.
    const viewport = page.getViewport({ scale: 1.6 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    images.push(canvas.toBuffer('image/png'));
  }
  return images;
}

/**
 * Reads a document however it can, and says which route it used.
 *
 * @returns {Promise<{text: string, source: 'text'|'vision'|'none', pages?: number, error?: string}>}
 */
export async function readDocument({ buffer, mimeType, fileName = '', visionPrompt }) {
  if (isImage(mimeType, fileName)) {
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
      const described = await describeImages(images, 'image/png', visionPrompt);
      return { text: described, source: 'vision', pages: images.length };
    } catch (err) {
      console.error('pdf render failed:', err.message);
      return {
        text,
        source: 'none',
        error:
          'This PDF is a scan and could not be read automatically. Ask the customer to send a ' +
          'photograph of the document instead, which can be read directly.',
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
      'in the original language. Do not summarise, translate or interpret - transcribe.';

  const parts = [];
  for (const [i, img] of images.entries()) {
    const { content } = await chat({
      system:
        'You transcribe shipping and customs paperwork. Reproduce exactly what is printed, ' +
        'including handwriting and stamps. Never invent a value you cannot read; write [unclear] instead.',
      messages: [imageMessage(instruction, img, mimeType)],
      tools: [],
    });
    parts.push(images.length > 1 ? `--- page ${i + 1} ---\n${content}` : content);
  }
  return parts.join('\n\n').trim();
}
