/**
 * The document viewer: the file on one side, what the bot read from it on the
 * other, checked against the booking - and the two decisions a person makes
 * about a paper: it looks right, or the customer must send a new one.
 *
 * The file is shown through a short-lived signed link fetched when the viewer
 * opens. If the link has expired by the time the browser asks for it (a page
 * left open, a slow network), the viewer fetches a fresh one once by itself.
 *
 * When the bot could not read the file at all, the viewer says so and lets the
 * person type what it says - kept apart from the bot's reading, with their name.
 */

import {
  h, icon, api, post, toast, toastError, badge, when, dialog, add, fill,
} from './ui.js';
import { previewBox } from './preview.js';
import { infoDot } from './glossary.js';

const TYPABLE_LABELS = {
  vin: 'Chassis (VIN)', mrn: 'MRN', acid: 'ACID', eur1: 'EUR.1 number', make: 'Make', model: 'Model', document_date: 'Date on the document',
};

/** The two decisions about a paper, in the owner's words (docs/DESK-REDESIGN-PROMPT.md, section 6). */
export const DECISION_WORDS = {
  verify: 'Mark as verified', verifyAnyway: 'Mark as verified anyway', verified: 'Verified', replace: 'Request replacement',
};

/**
 * Each difference between a paper and what it is held to, as one specific
 * sentence: "The chassis number on this Invoice differs from the booking: the
 * Invoice says …, the booking says …" (the brief, section 6).
 */
export function mismatchWords(doc) {
  return (doc?.checks ?? []).filter((c) => !c.match).map((c) => {
    const what = c.field === 'vin' ? 'The chassis number' : `The ${c.label}`;
    const against = c.against ?? 'the booking';
    return `${what} on this ${doc.label} differs from ${against}: the ${doc.label} says ${c.document}, ${against} says ${c.booking}.`;
  });
}

/** Pages drawn in the viewer; a longer file is for "Open in a new tab". */
const MAX_PAGES = 20;

/**
 * pdf.js, loaded the first time a PDF is opened - a desk that never opens one
 * never downloads it. The copy in vendor/pdfjs is byte for byte the pdfjs-dist
 * the server reads papers with (a test holds them together); it is served
 * from here, not a CDN, so the desk depends on nobody else to show a paper.
 */
let pdfjsLoading = null;
function pdfjs() {
  if (!pdfjsLoading) {
    pdfjsLoading = import('./vendor/pdfjs/pdf.min.js').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
      return lib;
    });
    // A failed load is tried again next time, not remembered as a failure.
    pdfjsLoading.catch(() => { pdfjsLoading = null; });
  }
  return pdfjsLoading;
}

/**
 * A PDF drawn by pdf.js into `box`, one canvas per page, at the screen's own
 * pixel density (see drawPdf in openViewer for why not the browser's viewer).
 * `stale()` says this drawing has been overtaken; `expired()` is called once
 * when the link answers 4xx. Falls back to the browser's own viewer.
 */
async function renderPdf(box, url, { label = 'PDF', stale = () => !box.isConnected, expired = null } = {}) {
  let pdf = null;
  try {
    const [lib, bytes] = await Promise.all([pdfjs(), fetch(url).then(async (res) => {
      if (!res.ok) throw Object.assign(new Error(`The file link answered ${res.status}.`), { status: res.status });
      return new Uint8Array(await res.arrayBuffer());
    })]);
    if (stale()) return;
    pdf = await lib.getDocument({ data: bytes, isEvalSupported: false }).promise;
    const pages = Math.min(pdf.numPages, MAX_PAGES);
    const dpr = window.devicePixelRatio || 1;
    for (let n = 1; n <= pages; n++) {
      const page = await pdf.getPage(n);
      if (stale()) return;
      const width = Math.max(200, box.clientWidth - 24);
      const fit = width / page.getViewport({ scale: 1 }).width;
      const viewport = page.getViewport({ scale: fit * dpr });
      const canvas = h('canvas', {
        class: 'viewer-page', width: Math.floor(viewport.width), height: Math.floor(viewport.height),
        role: 'img', 'aria-label': `Page ${n} of ${pdf.numPages}`,
      });
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      if (stale()) return;
      if (n === 1) fill(box, canvas); else add(box, canvas);
    }
    if (pdf.numPages > pages) {
      add(box, h('p', { class: 'muted small viewer-more' }, `Showing the first ${pages} of ${pdf.numPages} pages. Open it in a new tab for the rest.`));
    }
  } catch (err) {
    if (stale()) return;
    if (err?.status >= 400 && err.status < 500 && expired) { expired(); return; }
    box.replaceWith(h('iframe', { class: 'viewer-pdf', src: url, title: label }));
  } finally {
    pdf?.destroy().catch(() => null);
  }
}

/**
 * A file from a conversation that is not a paper to check: a photo, a voice
 * note's companion picture, a file the desk sent, a paper the bot did not
 * take. Large, with a pager through the conversation's other files, "Open in
 * a new tab", and - for a paper the bot read - the way into the document
 * viewer.
 *
 * @param {{title: string, items: Array<{ref: string, name: string|null, mime: string|null, kind: string,
 *          size_words?: string|null, paper?: object|null, caption?: string|null}>, index: number,
 *          link: (ref: string) => Promise<{url: string, mime_type?: string}>, onOpenPaper?: Function}} ctx
 */
export function openFilePreview(ctx) {
  let index = Math.max(0, ctx.index ?? 0);
  let turn = 0;
  const stage = h('div', { class: 'preview-stage' });
  const bar = h('div', { class: 'viewer-file-bar' });
  const nav = h('div', { class: 'viewer-nav', role: 'group', 'aria-label': 'Files in this conversation' });
  const dlg = dialog({ title: ctx.title ?? 'File', body: h('div', { class: 'preview-body' }, stage, bar), size: 'xl', actions: [], extra: nav });
  dlg.el.classList.add('dialog-preview');
  dlg.el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
  });
  const step = (d) => { const next = index + d; if (next >= 0 && next < ctx.items.length) { index = next; draw(); } };

  async function draw(retried = false) {
    const mine = ++turn;
    const item = ctx.items[index];
    dlg.el.querySelector('.dialog-title').textContent = item.paper?.label && item.paper.label !== 'File' ? `${item.paper.label} · ${ctx.title}` : ctx.title;
    nav.hidden = ctx.items.length <= 1;
    fill(nav,
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', disabled: index <= 0, onclick: () => step(-1), title: 'Previous (←)' }, icon('left', { size: 14 }), 'Previous'),
      h('span', { class: 'viewer-count' }, `${index + 1} of ${ctx.items.length}`),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', disabled: index >= ctx.items.length - 1, onclick: () => step(1), title: 'Next (→)' }, 'Next', icon('right', { size: 14 })));
    fill(stage, h('p', { class: 'viewer-loading' }, 'Opening the file…'));
    fill(bar);
    let link;
    try {
      link = await ctx.link(item.ref, { fresh: retried });
    } catch (err) {
      if (mine !== turn) return;
      fill(stage, h('div', { class: 'viewer-nofile' }, icon('imageOff', { size: 32 }), h('p', {}, err.message),
        h('button', { class: 'btn', type: 'button', onclick: () => draw(true) }, icon('refresh', { size: 15 }), 'Try again')));
      return;
    }
    if (mine !== turn) return;
    const mime = String(link.mime_type ?? item.mime ?? '');
    const again = () => { if (!retried) draw(true); else fill(stage, h('div', { class: 'viewer-nofile' }, h('p', {}, 'The file would not open.'))); };
    if (item.kind === 'image' || /^image\//.test(mime)) {
      const img = h('img', { class: 'preview-img', src: link.url, alt: item.caption ? `Photo: ${item.caption}` : `Photo ${index + 1} of ${ctx.items.length}`, decoding: 'async' });
      img.addEventListener('error', again, { once: true });
      // Fitted to the screen; a click shows it at its own size, to read a plate or a stamp.
      img.addEventListener('click', () => stage.classList.toggle('is-zoomed'));
      fill(stage, img);
    } else if (mime === 'application/pdf' || item.kind === 'pdf') {
      const box = h('div', { class: 'viewer-pages', role: 'region', tabindex: '0', 'aria-label': `${item.name ?? 'File'} (PDF)` }, h('p', { class: 'viewer-loading' }, 'Opening the file…'));
      fill(stage, box);
      renderPdf(box, link.url, { label: item.name ?? 'PDF', stale: () => mine !== turn || !box.isConnected, expired: again });
    } else {
      fill(stage, h('div', { class: 'viewer-nofile' }, icon('fileText', { size: 32 }),
        h('p', {}, 'This kind of file cannot be shown here. Open it in a new tab to download it.')));
    }
    stage.classList.remove('is-zoomed');
    fill(bar,
      h('span', { class: 'file-name' }, icon('file', { size: 14 }), h('bdi', { dir: 'ltr', title: item.name ?? '' }, item.name ?? 'File'),
        item.size_words ? h('span', { class: 'muted' }, ` · ${item.size_words}`) : null),
      h('span', { class: 'preview-actions' },
        item.paper?.reviewable && ctx.onOpenPaper
          ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { dlg.close(); ctx.onOpenPaper(item.paper.id); } }, icon('eye', { size: 14 }), 'Open in the document viewer')
          : null,
        h('a', { class: 'btn btn-sm btn-ghost', href: link.url, target: '_blank', rel: 'noopener noreferrer' }, icon('external', { size: 14 }), 'Open in a new tab')));
  }
  draw();
  return dlg;
}

/**
 * @param {{caseRef: string, docId: number, getData: () => object, reload: () => Promise<object>,
 *          onStale: Function, refreshCounts: Function}} ctx
 */
export function openViewer(ctx) {
  let docId = ctx.docId;
  let urlInfo = null;
  let retriedUrl = false;
  let drawing = 0;         // which drawing of a PDF is current; an older one stops

  const fileArea = h('div', { class: 'viewer-file' });
  // What the bot read scrolls; the decision under it stays in view.
  const info = h('div', { class: 'viewer-scroll' });
  const foot = h('div', { class: 'viewer-foot' });
  const nav = h('div', { class: 'viewer-nav', role: 'group', 'aria-label': 'Documents in this case' });
  const body = h('div', { class: 'viewer' }, fileArea, h('div', { class: 'viewer-info' }, info, foot));

  const dlg = dialog({ title: 'Document', body, size: 'xl', actions: [], extra: nav });
  dlg.el.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
  });

  const allDocs = () => {
    const d = ctx.getData();
    const order = d.checklist.filter((c) => c.document_id).map((c) => c.document_id);
    for (const o of d.other_documents) if (!order.includes(o.id)) order.push(o.id);
    // Then every other paper on the case - one replaced by a newer copy, or
    // set aside - so a link to it (?doc=) still has a place in the pager.
    for (const o of d.documents) if (!order.includes(o.id)) order.push(o.id);
    return order.map((id) => d.documents.find((x) => x.id === id)).filter(Boolean);
  };
  const current = () => ctx.getData().documents.find((d) => d.id === docId);

  function step(delta) {
    const list = allDocs();
    const i = list.findIndex((d) => d.id === docId);
    const next = list[i + delta];
    if (next) { docId = next.id; draw({ reloadFile: true }); }
  }

  function draw({ reloadFile = false } = {}) {
    const doc = current();
    if (!doc) { dlg.close(); return; }
    const list = allDocs();
    const i = list.findIndex((d) => d.id === docId);
    dlg.el.querySelector('.dialog-title').textContent = `${doc.label} · ${ctx.caseRef}`;
    // One paper on its own (from a chat) has nothing to page through.
    nav.hidden = list.length <= 1;
    fill(nav,
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', disabled: i <= 0, onclick: () => step(-1), title: 'Previous document (←)' }, icon('left', { size: 14 }), 'Previous'),
      h('span', { class: 'viewer-count' }, `${i + 1} of ${list.length}`),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', disabled: i >= list.length - 1, onclick: () => step(1), title: 'Next document (→)' }, 'Next', icon('right', { size: 14 })));
    if (reloadFile) { urlInfo = null; retriedUrl = false; loadFile(doc); }
    drawInfo(doc);
  }

  // -- the file ----------------------------------------------------------------
  async function loadFile(doc) {
    fill(fileArea, h('p', { class: 'viewer-loading' }, 'Opening the file…'));
    if (!doc.has_file) {
      fill(fileArea, h('div', { class: 'viewer-nofile' }, icon('file', { size: 32 }),
        h('p', {}, 'The file itself was not stored — only what was read from it.')));
      return;
    }
    try {
      urlInfo = await api({ view: 'document_url', id: doc.id });
    } catch (err) {
      fill(fileArea, h('div', { class: 'viewer-nofile' }, h('p', {}, err.message),
        h('button', { class: 'btn', type: 'button', onclick: () => loadFile(doc) }, 'Try again')));
      return;
    }
    if (doc.id !== docId) return;
    showFile(doc);
  }

  /** The signed link expired before the browser used it: fetch a fresh one, once. */
  function expired(doc) {
    if (retriedUrl) {
      fill(fileArea, h('div', { class: 'viewer-nofile' }, h('p', {}, 'The file would not open.'),
        h('button', { class: 'btn', type: 'button', onclick: () => { retriedUrl = false; loadFile(doc); } }, 'Try again')));
      return;
    }
    retriedUrl = true;
    loadFile(doc);
  }

  function showFile(doc) {
    const mime = String(urlInfo.mime_type ?? doc.mime_type ?? '');
    const open = h('a', { class: 'btn btn-sm btn-ghost', href: urlInfo.url, target: '_blank', rel: 'noopener noreferrer' },
      icon('external', { size: 14 }), 'Open in a new tab');
    let frame;
    if (mime.startsWith('image/')) {
      frame = h('img', { class: 'viewer-img', src: urlInfo.url, alt: `${doc.label} as sent by the customer` });
      frame.addEventListener('error', () => expired(doc));
    } else if (mime === 'application/pdf' || /\.pdf$/i.test(doc.file_name ?? '')) {
      frame = h('div', { class: 'viewer-pages', role: 'region', tabindex: '0', 'aria-label': `${doc.label} (PDF)` },
        h('p', { class: 'viewer-loading' }, 'Opening the file…'));
    } else {
      frame = h('div', { class: 'viewer-nofile' }, icon('file', { size: 32 }), h('p', {}, 'This kind of file cannot be shown here.'));
    }
    // A link fetched earlier than its expiry minus a margin is still good; past
    // it, ask again rather than show a broken frame.
    if (urlInfo.expires_at && new Date(urlInfo.expires_at) < new Date()) return expired(doc);
    fill(fileArea, frame, h('div', { class: 'viewer-file-bar' },
      h('span', { class: 'file-name' }, icon('file', { size: 14 }), h('bdi', { dir: 'ltr', title: doc.file_name ?? '' }, doc.file_name ?? '')), open));
    // Drawn once it is on the page, so it knows how wide it has to be.
    if (frame.classList.contains('viewer-pages')) drawPdf(frame, doc, urlInfo.url);
  }

  /**
   * A PDF drawn by pdf.js, one canvas per page, at the screen's own pixel
   * density.
   *
   * Not the browser's viewer in an iframe any more. Edge's and Chrome's PDF
   * viewer runs in a frame of its own, and above 100% display scaling - which
   * most laptops run at, 125 or 150% - it laid the page out at the wrong
   * scale inside the iframe: shoved to one side and cut off, or not painted
   * at all. Chrome on Android shows nothing for a PDF in an iframe. Canvases
   * sized by devicePixelRatio look the same, and sharp, at any scale.
   *
   * If pdf.js cannot run here - an old browser, a link that will not be read
   * this way - the browser's viewer is used as it always was, and "Open in a
   * new tab" is beside it either way.
   */
  async function drawPdf(box, doc, url) {
    const turn = ++drawing;
    // Fitted to the width there is, at the screen's pixel density; a link that
    // died between being handed out and being read is fetched once more, fresh.
    return renderPdf(box, url, {
      label: `${doc.label} (PDF)`,
      stale: () => turn !== drawing || doc.id !== docId || !box.isConnected,
      expired: retriedUrl ? null : () => expired(doc),
    });
  }

  // -- what the bot read, and the decision ---------------------------------------
  function drawInfo(doc) {
    const d = ctx.getData();
    const actions = d.document_actions;
    const mismatch = doc.checks.filter((c) => !c.match);

    fill(info,
      h('div', { class: 'viewer-status' },
        badge(doc.status_words, doc.tone),
        h('span', { class: 'muted small' }, `Arrived ${when(doc.uploaded_at)}`)),
      // Each check names what it was held to: the booking, or - for an MRN
      // printed on another paper - the customer's MRN declaration.
      mismatch.length ? h('div', { class: 'callout callout-red', role: 'note' }, icon('alert', { size: 16 }),
        h('div', {}, mismatchWords(doc).map((line) => h('p', {}, line)))) : null,
      doc.reading ? h('div', { class: 'callout callout-gray' }, h('p', {}, 'The bot is still reading this file. Look again in a moment.')) : null,
      doc.sent_by_mky ? h('p', { class: 'muted' }, 'A paper MKY sent the customer. The bot does not read MKY’s own papers.')
        : doc.unreadable ? typeIn(doc, actions) : readTable(doc),
      doc.typed_by ? h('p', { class: 'muted small' }, `Values typed by ${doc.typed_by}.`) : null);
    fill(foot, decision(doc, actions));
    info.scrollTop = 0;
  }

  function readTable(doc) {
    if (!doc.read.length) return h('p', { class: 'muted' }, 'The bot found nothing it could read on this document.');
    const byField = new Map(doc.checks.map((c) => [c.field, c]));
    // A paper on no booking is held to nothing: no column of dashes for it.
    const d = ctx.getData();
    const held = !(d.type === 'document' && !d.booking_ref);
    return h('div', {},
      h('h3', { class: 'viewer-h' }, 'What the bot read'),
      held ? null : h('p', { class: 'muted small viewer-note' }, 'It is on no booking, so there is nothing to compare it with yet.'),
      h('table', { class: 'read-table' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Field'), h('th', { scope: 'col' }, 'On the document'), held ? h('th', { scope: 'col' }, 'On the booking') : null)),
        h('tbody', {}, doc.read.map((f) => {
          const c = byField.get(f.field);
          return h('tr', { class: c && !c.match ? 'is-mismatch' : '' },
            h('th', { scope: 'row' }, f.label, infoDot(f.field)),
            h('td', { dir: 'auto', class: f.field === 'vin' || f.field === 'mrn' ? 'mono' : '' }, String(f.value), f.typed ? h('span', { class: 'muted small' }, ' (typed)') : null),
            // The verdict is one unbreakable word; a differing value is its
            // own piece, free to wrap onto the next line in a narrow column.
            !held ? null : h('td', {}, c ? h('span', { class: `match ${c.match ? 'match-yes' : 'match-no'}` },
              icon(c.match ? 'check' : 'alert', { size: 13 }), c.match ? 'Matches' : 'Differs:',
              c.match ? null : h('span', { class: 'match-value' }, c.booking),
              c.against && c.against !== 'the booking' ? h('span', { class: 'match-value muted small' }, `(${c.against.replace(/^the /, '')})`) : null)
              : h('span', { class: 'muted' }, '—')));
        }))));
  }

  /** The bot could not read it; a person reads it and types what it says. */
  function typeIn(doc, actions) {
    const inputs = {};
    const form = h('form', { class: 'type-in' },
      h('div', { class: 'callout callout-amber' }, icon('alert', { size: 16 }),
        h('p', {}, h('strong', {}, 'The bot couldn’t read this file. '), 'It is a scan or a photo without readable text. Type what you see — only what matters for this booking.')),
      (doc.typable ?? actions.typable).map((k) => {
        inputs[k] = h('input', { class: `input${k === 'vin' || k === 'mrn' ? ' mono' : ''}`, id: `type-${k}`, autocomplete: 'off', spellcheck: 'false' });
        return h('div', { class: 'field' }, h('label', { for: `type-${k}`, class: 'label' }, TYPABLE_LABELS[k] ?? k), inputs[k]);
      }),
      h('button', { class: 'btn', type: 'submit', disabled: !actions.type_values.enabled, title: actions.type_values.reason }, 'Save what I typed'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()]).filter(([, v]) => v));
      if (!Object.keys(values).length) return toast('Type at least one value from the document.', 'info');
      try {
        await post({ action: 'mark_document_read_values', document_id: doc.id, values, version: ctx.getData().version });
        toast('Saved. The values are compared with the booking.');
        await ctx.reload();
        ctx.refreshCounts();
        draw();
      } catch (err) {
        if (err.data?.stale) { dlg.close(); return ctx.onStale(err); }
        toastError(err);
      }
    });
    return form;
  }

  /**
   * The two decisions about a paper. The primary button follows the
   * evidence: when the paper does not match the booking or could not be read,
   * "Request replacement" is the primary and "Mark as verified" becomes "Mark
   * as verified anyway" - the button a person reaches for first is the one
   * the evidence supports. Received, or read by the bot, is never verified:
   * only a person's decision is.
   */
  function decision(doc, actions) {
    // A paper MKY sent the customer: ours, nothing to check or ask for.
    if (doc.sent_by_mky) {
      return h('div', { class: 'viewer-decided is-aside' }, icon('send', { size: 16 }),
        h('p', {}, `Sent to the customer${doc.sent_by ? ` by ${doc.sent_by}` : ''} ${when(doc.uploaded_at)}, from the conversation. It is MKY’s own document, so there is nothing to verify.`));
    }
    if (doc.status === 'replacement_requested') {
      return h('div', { class: 'viewer-decided' }, icon('refresh', { size: 16 }),
        h('p', {}, `A new copy was asked for${doc.rejection_reason ? `: ${doc.rejection_reason}` : '.'}`));
    }
    if (doc.status === 'rejected') {
      // Set aside: kept as the record of what was sent, not asked for again.
      return h('div', { class: 'viewer-decided is-aside' }, icon('minus', { size: 16 }),
        h('p', {}, `Set aside${doc.rejection_reason ? `: ${doc.rejection_reason}` : '.'} It is kept as the record of what was sent.`));
    }
    const box = h('div', { class: 'viewer-actions' });
    const verified = doc.status === 'verified';
    const doubtful = !verified && (doc.checks.some((c) => !c.match) || doc.unreadable);
    const ok = h('button', {
      class: `btn ${doubtful ? 'btn-secondary' : 'btn-primary'}`, type: 'button', 'aria-disabled': actions.verify.enabled ? null : 'true', title: actions.verify.reason,
    }, icon('check', { size: 15 }), verified ? DECISION_WORDS.verified : doubtful ? DECISION_WORDS.verifyAnyway : DECISION_WORDS.verify);
    if (verified) ok.disabled = true;
    const bad = h('button', {
      class: `btn ${doubtful ? 'btn-primary' : 'btn-secondary'}`, type: 'button', 'aria-disabled': actions.reject.enabled ? null : 'true', title: actions.reject.reason,
    }, icon('refresh', { size: 15 }), DECISION_WORDS.replace);

    ok.addEventListener('click', async () => {
      if (!actions.verify.enabled) return toast(actions.verify.reason, 'info');
      ok.disabled = true;
      try {
        await post({ action: 'verify_document', document_id: doc.id, version: ctx.getData().version });
        toast(`${doc.label} marked as verified.`);
        await ctx.reload();
        ctx.refreshCounts();
        // Straight on to the next paper that still needs eyes.
        const next = allDocs().find((x) => x.id !== doc.id && ['received', 'pending_verification'].includes(x.status));
        if (next) { docId = next.id; draw({ reloadFile: true }); } else draw();
      } catch (err) {
        if (err.data?.stale) { dlg.close(); return ctx.onStale(err); }
        toastError(err);
        ok.disabled = false;
      }
    });
    bad.addEventListener('click', () => {
      if (!actions.reject.enabled) return toast(actions.reject.reason, 'info');
      askForNew(doc, actions);
    });

    // The primary first, wherever it is.
    add(box, doubtful ? [bad, ok] : [ok, bad]);
    const why = [actions.verify, actions.reject].find((a) => !a.enabled && a.reason)?.reason;
    return [box, why ? h('p', { class: 'reason' }, why) : null];
  }

  /**
   * What became of "Ask for a new one", in the server's words: the customer
   * was told, it is queued or held, or they could not be reached at all.
   */
  function told(done, t) {
    if (!t?.words) return toast(done);
    toast(`${done} ${t.words}`, t.warn ? 'bad' : t.reached === 'sent' ? 'ok' : 'info', { timeout: t.warn ? 15000 : 9000 });
  }

  /**
   * The paper had already been put right - a correct one is on file - so it
   * was set aside and nobody was asked. Said so, with the one thing that
   * overrides it: asking anyway.
   */
  function setAside(doc, body, r) {
    const right = r.replaced_by ?? {};
    const label = ctx.getData().documents.find((d) => d.id === right.id)?.label ?? doc.label;
    const asked = r.customer_told?.reached === 'not_asked' ? '; the customer wasn’t asked' : '';
    toast(`Set aside — a correct ${label} is already on file${asked}.`, 'info', {
      action: {
        label: 'Ask anyway',
        run: async () => {
          try {
            // The version the page has now: setting it aside changed the case.
            const again = await post({ ...body, ask_anyway: true, version: ctx.getData().version });
            await ctx.reload();
            ctx.refreshCounts();
            told(`Asked for a new ${doc.label} anyway.`, again.customer_told);
            if (dlg.el.open) draw();
          } catch (err) {
            if (err.data?.stale) { if (dlg.el.open) dlg.close(); return ctx.onStale(err); }
            toastError(err);
          }
        },
      },
    });
  }

  /** Why, a note, the exact message in the customer's language, then send. */
  function askForNew(doc, actions) {
    const version = ctx.getData().version;
    const suggested = doc.wrong_vehicle ? 'wrong_vin' : doc.unreadable ? 'unreadable' : 'unreadable';
    const reasons = h('fieldset', { class: 'radios' }, h('legend', { class: 'label' }, 'What is wrong with it?'),
      actions.reasons.map((r) => h('label', { class: 'radio' },
        h('input', { type: 'radio', name: 'reason', value: r.code, checked: r.code === suggested }), r.words)));
    const note = h('textarea', { class: 'input', rows: '2', dir: 'auto', placeholder: 'Optional — anything specific they should know' });
    const reasonCode = () => reasons.querySelector('input:checked')?.value ?? 'other';
    const pv = previewBox(() => ({ kind: 'reject_document', document_id: doc.id, reason_code: reasonCode(), note: note.value.trim() }));
    reasons.addEventListener('change', pv.update);
    note.addEventListener('input', pv.update);

    const back = h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => draw() }, icon('back', { size: 15 }), 'Back');
    const send = h('button', { class: 'btn btn-primary', type: 'button' }, icon('send', { size: 15 }), h('span', {}, 'Send request to customer'));
    let sending = false;
    send.addEventListener('click', async () => {
      if (sending) return;
      sending = true;
      send.disabled = true;
      send.lastChild.textContent = 'Sending…';
      try {
        const body = { action: 'reject_document', document_id: doc.id, reason_code: reasonCode(), reason: note.value.trim() };
        const r = await post({ ...body, version });
        await ctx.reload();
        ctx.refreshCounts();
        if (r.set_aside) {
          setAside(doc, body, r);
          // The paper that put it right is the one to look at now.
          if (r.replaced_by?.id && ctx.getData().documents.some((d) => d.id === r.replaced_by.id)) {
            docId = r.replaced_by.id;
            draw({ reloadFile: true });
            return;
          }
        } else {
          told(`Asked for a new ${doc.label}.`, r.customer_told);
        }
        draw();
      } catch (err) {
        if (err.data?.stale) { dlg.close(); return ctx.onStale(err); }
        toastError(err);
        send.disabled = false;
        send.lastChild.textContent = 'Send request to customer';
      } finally {
        sending = false;
      }
    });

    fill(info,
      h('h3', { class: 'viewer-h' }, `Request a replacement for the ${doc.label}`),
      reasons,
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'reject-note' }, 'Note to the customer'), note),
      pv.el);
    note.id = 'reject-note';
    fill(foot, h('div', { class: 'viewer-actions' }, send, back));
    info.scrollTop = 0;
    pv.now();
    reasons.querySelector('input:checked')?.focus();
  }

  draw({ reloadFile: true });
}
