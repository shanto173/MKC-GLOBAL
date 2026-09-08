/**
 * What did the client just say, when it was not the answer to the question?
 *
 * A form asks for a chassis number. A person replies "I want my car to go to
 * Port Said", or "my number is +20 100 555 1234", or "how long does it take?",
 * or "I don't have it yet". Answering all four with "that does not look like a
 * chassis number" is technically true and useless: two contain a value we
 * wanted, one is a question we can answer, one needs a different reply.
 *
 * Two layers, in this order:
 *
 *   1. This file - patterns. Fast, free, and identical every time. It handles
 *      the shapes that recur: a direction word in front of a place, a phone
 *      number, a question mark, "I don't have it".
 *
 *   2. lib/flow/nlu.js - the model, only when the patterns find nothing. It
 *      EXTRACTS; it does not decide. Everything it returns comes back through
 *      the same validation as a value typed on its own.
 *
 * That split is the point. Patterns cannot cover how people actually write, and
 * a model cannot be trusted to say whether a port is one we serve.
 */

import { matchPort, looksLikeVin } from '../bookings.js';
import { findVin, extractField } from './paste.js';

const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const PHONE = /(?:\+|00)?\d[\d\s().-]{7,}\d/;

/** Fields whose value has a shape we can verify. The rest are free text. */
const STRICT = new Set(['vin', 'destination_port']);

/**
 * A question, in either language. Deliberately generous: answering something
 * that was not a question costs a sentence, while refusing a real question
 * costs the client's patience and a second message asking it again.
 */
const QUESTION = /\?|؟|^\s*(?:how|what|when|where|why|which|who|can|could|do|does|did|is|are|will|would|should)\b|\b(?:how much|how long|how many|what about|tell me about)\b|إزاي|ايه|كام|ليه|هل|امتى|إمتى/i;

/** "I do not have it", "later", "I do not know". */
const REFUSAL = /\b(?:i (?:do not|don'?t) (?:have|know)|no idea|not sure|dunno|later|not now|skip|haven'?t got|don'?t have)\b|معنديش|مش معايا|مش عارف|بعدين|مش دلوقتي/i;

/** Wanting to go somewhere else entirely. */
const INTENT = [
  ['menu', /^\s*(?:menu|main menu|home|back|start over)\s*$|القائمة|الرئيسية/i],
  ['cancel', /^\s*(?:cancel|stop|forget it|never ?mind)\s*$|إلغاء|الغي/i],
  ['track', /\b(?:track|tracking|where is (?:my|the)|status of my)\b|الشحنة فين|فين الشحنة/i],
  ['contact', /\b(?:speak to|talk to)\s+(?:a |an )?(?:human|person|someone|agent)\b|\bcustomer (?:service|support)\b|\bcomplain\b|موظف|شكوى/i],
];

/**
 * Where a place sits in the journey.
 *
 * "Alexandria Trading Co" is a client's name; "send it to Alexandria" is a
 * destination. The difference is not the word Alexandria - it is whether the
 * sentence points at it. Getting this wrong is not cosmetic: a company name
 * silently becoming a destination puts the wrong port on a customs declaration.
 */
const TO_WORDS = /\b(?:to|towards|into|destination|dest|delivered?\s+(?:to|at)|delivery\s+(?:to|at)|discharge[ds]?\s*(?:at|in)?|arrive\s+(?:at|in)|arrival\s+(?:at|in)|going\s+to|goes\s+to|go\s+to|bound\s+for|unload\s+(?:at|in)|final\s+destination)\b|إلى|لميناء|وصول|للميناء/i;

const FROM_WORDS = /\b(?:from|out\s+of|origin|loading|loaded\s+(?:at|in)|load\s+(?:at|in)|pick(?:ed|ing)?\s*-?\s*up|pickup|collect(?:ed)?\s+(?:at|in|from)|departs?\s+from|departing\s+from|shipping\s+from|shipped\s+from|ship\s+from|sailing\s+from)\b|شحن من|من ميناء/i;

/**
 * @param {string} field the field that was asked for
 * @param {string} text  what the client sent
 * @returns {{kind: string, value?: string, field?: string, detail?: string}}
 *
 * kind:
 *   answer        it parses as the field asked for
 *   other_field   a value, but for a DIFFERENT field
 *   question      a question for the knowledge assistant
 *   intent        they want to go somewhere else
 *   contact       a phone number or an email address
 *   refusal       they have not got it, or not yet
 *   empty | unknown
 */
export function classify(field, text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { kind: 'empty' };

  // 1. A field with a shape we can check. Tested first, or a chassis number
  //    containing "DO" would be read as a question. Free-text fields are NOT
  //    accepted here - "what makes do you accept?" is a valid string, and
  //    taking it as the make is how a question becomes a manufacturer.
  const asAsked = extractField(field, raw);
  if (STRICT.has(field) && fits(field, asAsked)) return { kind: 'answer', value: asAsked };

  // 2. Somewhere else entirely. Before the question test, because "where is my
  //    shipment" is both a question and a request to track.
  for (const [name, pattern] of INTENT) {
    if (pattern.test(raw)) return { kind: 'intent', value: name };
  }

  // 3. A question for the knowledge assistant.
  if (QUESTION.test(raw)) return { kind: 'question' };

  // 4. A value for a field we did not ask for.
  const elsewhere = valueForAnotherField(field, raw);
  if (elsewhere) return { kind: 'other_field', ...elsewhere };

  // 5. Contact details. Never a chassis number, and worth keeping.
  const email = raw.match(EMAIL)?.[0];
  const phone = raw.match(PHONE)?.[0]?.trim();
  if (email || phone) return { kind: 'contact', value: email || phone, detail: email ? 'email' : 'phone' };

  // 6. They have not got it.
  if (REFUSAL.test(raw)) return { kind: 'refusal' };

  // 7. Free text, and nothing above claimed it: a make, a client name or a
  //    loading city is whatever the client says it is.
  if (!STRICT.has(field) && fits(field, asAsked)) return { kind: 'answer', value: asAsked };

  return { kind: 'unknown' };
}

/** Does this value satisfy the field it was collected for? */
function fits(field, value) {
  const v = String(value ?? '').trim();
  if (!v) return false;
  if (field === 'vin') return looksLikeVin(v);
  if (field === 'destination_port') return Boolean(matchPort(v));
  return v.length > 0 && v.length <= 120;
}

/**
 * Every field this message can be read as supplying.
 *
 * Used both to answer a different question than the one asked, and to take a
 * whole sentence apart: "a Volvo from Hamburg to Port Said" names three things,
 * and asking for each of them separately afterwards is what makes a bot
 * exhausting to use.
 */
export function fieldsIn(text) {
  const raw = String(text ?? '');
  const found = {};

  const vin = findVin(raw);
  if (vin && looksLikeVin(vin)) found.vin = vin;

  const port = matchPort(raw);
  if (port) {
    const before = textBefore(raw, port);
    // A message that is essentially just the place name is the answer to
    // whatever was asked about a place.
    const bare = raw.trim().split(/\s+/).length <= 2;
    if (TO_WORDS.test(before) || (bare && !FROM_WORDS.test(raw))) found.destination_port = port;
  }

  const from = placeAfter(raw, FROM_WORDS);
  // Nobody loads at an Egyptian discharge port, so a match there is a misread.
  if (from && !matchPort(from)) found.origin_port = from;

  return found;
}

/**
 * A value in the message that belongs to a field we did not ask for.
 *
 * Deliberately conservative. A chassis number has a shape, so it can be picked
 * out anywhere. A place needs the sentence to say which end of the journey it
 * is - otherwise it is left alone and the client is simply asked again, which
 * costs one message rather than a wrong port on the paperwork.
 */
export function valueForAnotherField(asked, raw) {
  const found = fieldsIn(raw);
  for (const field of ['vin', 'destination_port', 'origin_port']) {
    if (field !== asked && found[field]) return { field, value: found[field] };
  }
  return null;
}

/** The words leading up to wherever a port was recognised. */
export function textBefore(text, port) {
  const lower = String(text).toLowerCase();
  // matchPort works on aliases, so look for the distinctive part of the name.
  for (const alias of [port.toLowerCase(), port.toLowerCase().split(' ')[0]]) {
    const at = lower.indexOf(alias);
    if (at > 0) return String(text).slice(0, at);
  }
  return '';
}

/**
 * The place named after "from", "loading at" and friends.
 *
 * Built with concatenation, not a template literal: `\s` inside a template is
 * not an escape sequence and silently becomes a bare "s", which turns the
 * pattern into one that can never match.
 */
export function placeAfter(text, marker) {
  // The marker is a top-level alternation, so it MUST be wrapped: without the
  // group, "\\b(?:from|…)\\b|شحن من" + "(…)" binds the capture to the last
  // branch only, and a match on any other branch leaves group 1 undefined.
  const pattern = new RegExp('(?:' + marker.source + ')\\s+([^,.;\\n]{2,40})', 'i');
  const m = String(text).match(pattern);
  if (!m || !m[1]) return null;

  // Stop at the next direction word, so "from Hamburg to Port Said" gives
  // Hamburg rather than the whole remainder.
  const cut = m[1].split(TO_WORDS)[0].trim();
  const words = cut
    // "loading at Klaipeda" captures "at Klaipeda"; the preposition belongs to
    // the marker, not to the place.
    .replace(/^\s*(?:at|in|from|the|port\s+of|city\s+of)\s+/i, '')
    .split(/\s+/).slice(0, 3).join(' ')
    .replace(/[^\p{L}\p{N}\s'-]/gu, '')
    .trim();

  return words.length >= 2 ? words : null;
}
