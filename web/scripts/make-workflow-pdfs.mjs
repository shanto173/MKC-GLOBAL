/**
 * Renders the two workflow documents in docs/workflow/ to PDF.
 *
 *   npm run docs:pdf
 *
 * The documents are written as print-ready HTML - the client deck as 16:9
 * pages, the technical documentation as A4 - and rendered with whichever
 * Chromium the machine has (Edge on Windows, Chrome elsewhere), headless. No
 * PDF library and no layout code: a browser already knows how to print.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const DOCS = [
  ['docs/workflow/client-workflow.html', 'docs/workflow/MKY-Booking-Assistant-Workflow.pdf'],
  ['docs/workflow/technical-documentation.html', 'docs/workflow/MKY-Booking-Assistant-Technical.pdf'],
  ['docs/workflow/whatsapp-workflow.html', 'docs/workflow/MKY-Booking-Assistant-WhatsApp.pdf'],
];

const browser = CANDIDATES.find((p) => fs.existsSync(p));
if (!browser) {
  console.error('No Edge or Chrome found. Open each HTML file in a browser and print it to PDF.');
  process.exit(1);
}

for (const [source, output] of DOCS) {
  const url = 'file:///' + path.resolve(source).replace(/\\/g, '/');
  execFileSync(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-pdf-header-footer',
    `--print-to-pdf=${path.resolve(output)}`,
    url,
  ], { stdio: 'ignore' });
  const kb = Math.round(fs.statSync(output).size / 1024);
  console.log(`${output}  (${kb} KB)`);
}
