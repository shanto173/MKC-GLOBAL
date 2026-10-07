/**
 * The language of the conversation being answered right now.
 *
 * A client chooses English or Arabic once, and from then on everything the bot
 * says to them is in that language alone - not the two stacked together. The
 * choice lives on the client (and the session, for a chat with no client row);
 * this module carries it through one turn without threading a `lang` argument
 * through every handler and every one of the hundred-odd messages.
 *
 *   withLanguage('ar', () => runFlow(...))   everything inside speaks Arabic
 *   currentLanguage()                        'ar' | 'en' | null
 *   pick(ar, en)                             the half for this turn
 *
 * null means nobody has chosen. Messages then come out in both languages, as
 * they always did - which is also what every test that never sets a language
 * sees, and what a message rendered outside any turn falls back to.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export const LANGS = ['en', 'ar'];

const store = new AsyncLocalStorage();

/** 'en' | 'ar' | null. Anything else is "not chosen". */
export function normaliseLanguage(value) {
  const l = String(value ?? '').trim().toLowerCase().slice(0, 2);
  return LANGS.includes(l) ? l : null;
}

/** Runs fn with this turn's language set. Nested calls see the innermost. */
export function withLanguage(lang, fn) {
  return store.run({ lang: normaliseLanguage(lang) }, fn);
}

/** The language of the turn in progress, or null when none was chosen. */
export function currentLanguage() {
  return store.getStore()?.lang ?? null;
}

/**
 * The half of a bilingual pair this turn should say. With no language chosen,
 * both - joined by `joiner`, which is how the bot always spoke before.
 */
export function pick(ar, en, joiner = '\n') {
  const lang = currentLanguage();
  if (lang === 'ar') return ar;
  if (lang === 'en') return en;
  const a = String(ar ?? '').trim();
  const e = String(en ?? '').trim();
  if (!a) return e;
  if (!e) return a;
  return `${a}${joiner}${e}`;
}

/**
 * A guess from what the client typed: Arabic script means Arabic, Latin letters
 * mean English, digits and emoji alone mean nothing. Used only when the client
 * answers the language question with something other than a choice.
 */
export function detectLanguage(text) {
  const s = String(text ?? '');
  if (/[؀-ۿݐ-ݿ]/.test(s)) return 'ar';
  if (/[A-Za-z]{2,}/.test(s)) return 'en';
  return null;
}

/** Words that mean "this language", typed or tapped. */
export function languageFromChoice(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (/^(en|eng|english|انجليزي|إنجليزي|انجليزى|إنجليزى|الانجليزية|الإنجليزية)$/.test(s)) return 'en';
  if (/^(ar|arabic|عربي|عربى|العربية|العربيه)$/.test(s)) return 'ar';
  return null;
}
