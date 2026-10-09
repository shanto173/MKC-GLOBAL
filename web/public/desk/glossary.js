/**
 * The words of the trade, in one place.
 *
 * A new colleague meets VIN, MRN, ACID, EUR.1 and CMR on their first case.
 * Each term the desk shows has an info dot beside it (infoDot) that opens its
 * one line here - on a tap or a click, and on hover with a mouse - and the
 * whole list is in the account menu (openGlossary) for every role, and on the
 * Settings page.
 *
 * TO CHANGE A DEFINITION, change it here: every dot and both lists follow.
 * Keep each to one plain, accurate line. They say what a document is, never
 * what the law requires (docs/DESK-REDESIGN-PROMPT.md, section 5).
 */

import { h, dialog } from './ui.js';

export const GLOSSARY = {
  vin: { term: 'Chassis / VIN', text: 'The vehicle’s unique identification number: the 17-character chassis number.' },
  mrn: { term: 'MRN', text: 'The Movement Reference Number of the EU export declaration.' },
  acid: { term: 'ACID', text: 'Egypt’s Advance Cargo Information Declaration, registered on Nafeza before shipping.' },
  eur1: { term: 'EUR.1', text: 'The movement certificate proving EU origin for preferential duty.' },
  cmr: { term: 'CMR', text: 'The international road consignment note.' },
  // The bot's own word for the transport document (lib/extract.js, "brief").
  brief: { term: 'Brief', text: 'The transport document for the vehicle: a CMR road consignment note, or a bill of lading.' },
};

/** The glossary entry for a document type or a field the bot reads, if it has one. */
export function termFor(key) {
  return Object.hasOwn(GLOSSARY, key) ? key : null;
}

/**
 * A small "i" beside a term. A tap or click opens its line and a second one
 * (or Escape, or a click elsewhere - app.js closes open menus) closes it; a
 * mouse resting on it opens it too. Never inside a <label>: a click there
 * would also tick the box the label belongs to.
 */
export function infoDot(key) {
  const g = GLOSSARY[termFor(key)];
  if (!g) return null;
  const summary = h('summary', { class: 'info-dot', 'aria-label': `What is ${g.term}?` }, 'i');
  const dot = h('details', { class: 'menu info' }, summary,
    h('p', { class: 'menu-list info-pop', role: 'note' }, h('strong', {}, g.term), ' — ', g.text));
  // Opened by the mouse resting on it: closes when it leaves - unless it was
  // clicked meanwhile, which keeps it open (the click would otherwise shut it).
  let byHover = false;
  dot.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && !dot.open) { byHover = true; dot.open = true; } });
  dot.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && byHover) { byHover = false; dot.open = false; } });
  summary.addEventListener('click', (e) => { if (byHover) { e.preventDefault(); byHover = false; } });
  return dot;
}

/** Every term, as a definition list: in the glossary dialog and on the Settings page. */
export function glossaryList() {
  return h('dl', { class: 'glossary' }, Object.values(GLOSSARY).flatMap((g) => [h('dt', {}, g.term), h('dd', {}, g.text)]));
}

/** The glossary, from the account menu: for every role, on every screen size. */
export function openGlossary() {
  dialog({
    title: 'Glossary',
    subtitle: 'The words the desk uses for vehicles and their papers.',
    body: glossaryList(),
    actions: [{ label: 'Close' }],
  });
}
