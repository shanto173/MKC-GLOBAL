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
 *   withTurn({ lang, channel }, fn)          the same, and which channel
 *   currentChannel()                         'telegram' | 'whatsapp' | 'web' | null
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

/**
 * Runs fn with this turn's language set. Nested calls see the innermost.
 *
 * The channel of an enclosing withTurn() carries through: a client who switches
 * language mid-turn is still on the channel they wrote from.
 */
export function withLanguage(lang, fn) {
  return store.run({ ...store.getStore(), lang: normaliseLanguage(lang) }, fn);
}

/**
 * Runs fn with this turn's language AND channel set.
 *
 * The channel matters to a handful of sentences only - "send /menu" means
 * something on Telegram and nothing on WhatsApp, where the client types "menu"
 * - but those sentences are deep inside the message table, which is exactly
 * what this module exists to avoid threading arguments into.
 */
export function withTurn({ lang = null, channel = null } = {}, fn) {
  return store.run({ lang: normaliseLanguage(lang), channel: channel ?? null }, fn);
}

/** The language of the turn in progress, or null when none was chosen. */
export function currentLanguage() {
  return store.getStore()?.lang ?? null;
}

/** 'telegram' | 'whatsapp' | 'web' | null, for the turn in progress. */
export function currentChannel() {
  return store.getStore()?.channel ?? null;
}

/**
 * A list as this turn writes one. Arabic separates with its own comma; both
 * languages together kept the Latin one, as they always did.
 */
export function listJoin(items) {
  return [].concat(items ?? []).join(currentLanguage() === 'ar' ? '، ' : ', ');
}

/** A route's arrow: Arabic reads it the other way, as the Arabic halves always wrote it. */
export function routeArrow() {
  return currentLanguage() === 'ar' ? '←' : '→';
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

/**
 * Franco-Arabic is Arabic typed in Latin letters, with digits standing in for
 * letters that have no Latin equivalent: 3=ع, 7=ح, 2=ء, 5=خ, 9=ص. Detecting it
 * matters because it looks like English to a character test, and an Egyptian
 * writing "el sha7na fen?" should not be answered in English alone - nor have
 * English chosen for them on the strength of it.
 */
export function looksFrancoArabic(text) {
  // A chassis number is a Latin string full of digits, and to this test
  // "TESTTBLMTR2LC19" reads exactly like "sha7na" does - which answered an
  // English customer in Arabic because their VIN happened to contain a 2.
  // A word carries at most one stand-in digit; two or more means a code.
  const s = String(text ?? '').toLowerCase().replace(/\b[\w-]*\d[\w-]*\d[\w-]*\b/g, ' ');

  // A digit used as a letter, i.e. sitting inside a word between letters
  // (sha7na, bta3ty) or opening one (3ayez, 7abibi). Reference numbers such as
  // MKC-24001 and chassis numbers do not match, because their digits are
  // adjacent to other digits or separators rather than letters.
  const digitAsLetter = /[a-z][23579][a-z]/.test(s) || /\b[2357][a-z]{2,}/.test(s);

  const words = /\b(fen|feen|ezay|izzay|3ayez|3awez|a7gez|sha7na|bta3|bta3ty|bta3i|msh|mesh|3andi|3ala|kam|eh|ayoh|aiwa|tamam|momken|mumkin|law sama7t|shokran)\b/.test(s);

  return digitAsLetter || words;
}

/** Words that mean "this language", typed or tapped. */
export function languageFromChoice(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (/^(en|eng|english|انجليزي|إنجليزي|انجليزى|إنجليزى|الانجليزية|الإنجليزية)$/.test(s)) return 'en';
  if (/^(ar|arabic|عربي|عربى|العربية|العربيه)$/.test(s)) return 'ar';
  return null;
}
