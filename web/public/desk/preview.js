/**
 * "What the customer will receive" - the exact message, in their language,
 * shown before anything that messages a customer is sent.
 *
 * The text comes from the server, which renders it with the same code that
 * will send it, so what is previewed is what arrives. When WhatsApp's 24-hour
 * window has closed, the box says the message will go as a template - or
 * wait - instead of letting the operator believe it went as written.
 */

import {
  h, icon, api, debounce, fill, lines,
} from './ui.js';

const VIA_TONE = { chat: 'gray', template: 'amber', waiting: 'amber', none: 'red' };

/**
 * @param {() => object|null} params  the preview query; null means "not ready to preview"
 * @param {{empty?: string}} opts     what to say while there is nothing to preview
 */
export function previewBox(params, { empty = 'The message appears here as you type.' } = {}) {
  const label = h('p', { class: 'preview-label' }, 'What the customer will receive');
  const bubble = h('div', { class: 'preview-bubble' }, empty);
  const delivery = h('p', { class: 'preview-delivery' });
  const el = h('div', { class: 'preview', 'aria-live': 'polite' }, label, bubble, delivery);
  let seq = 0;

  async function run() {
    const p = params();
    const mine = ++seq;
    if (!p) {
      bubble.textContent = empty;
      bubble.classList.add('is-empty');
      delivery.hidden = true;
      return;
    }
    try {
      const r = await api({ view: 'preview', ...p });
      if (mine !== seq) return;   // a newer keystroke already asked again
      label.textContent = `What ${r.customer_name || 'the customer'} will receive · ${r.language === 'ar' ? 'in Arabic' : r.language === 'en' ? 'in English' : 'in both languages (they have not chosen one yet)'}`;
      fill(bubble, lines(r.text || '—'));
      bubble.classList.remove('is-empty');
      const tone = VIA_TONE[r.delivery?.via] ?? 'gray';
      fill(delivery, icon(tone === 'gray' ? 'send' : 'alert', { size: 13 }), h('span', {}, r.delivery?.words ?? ''));
      delivery.className = `preview-delivery tone-text-${tone}`;
      delivery.hidden = !r.delivery?.words;
    } catch (err) {
      if (mine !== seq) return;
      bubble.textContent = `We could not prepare the preview: ${err.message}`;
      delivery.hidden = true;
    }
  }

  const later = debounce(run, 300);
  return { el, update: later, now: run };
}
