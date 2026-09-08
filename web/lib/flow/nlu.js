/**
 * The second layer of understanding: the model, when the patterns find nothing.
 *
 * lib/flow/understand.js handles the shapes that recur - a direction word in
 * front of a place, a phone number, a question mark. It is fast, free and
 * identical every time, and it goes first. This runs only when it comes back
 * with "unknown", which on a normal booking is never.
 *
 * THE RULE THIS FILE EXISTS UNDER: the model EXTRACTS, it does not DECIDE.
 *
 * It is asked one question - "which of these fields does this sentence
 * supply?" - and its answer is a set of candidate strings. Every one of them
 * then goes through exactly the same validation as a value typed on its own: a
 * chassis must still look like a chassis, a destination must still be one of
 * the five ports we serve. Nothing here can make a booking ready, resolve a
 * duplicate, or complete a document.
 *
 * That is why a wrong answer from it costs at most one clarifying question,
 * and never a wrong port on a customs declaration.
 */

import { chat } from '../llm.js';
import { config, DESTINATION_PORTS } from '../config.js';
import { matchPort, looksLikeVin } from '../bookings.js';
import { logEvent } from '../audit.js';

const SYSTEM = `You read one message from a customer of a freight forwarder that
imports used commercial vehicles into Egypt, and report which booking details it
contains. You do not reply to the customer and you do not make decisions.

Return ONLY a JSON object, no commentary:

{
  "vin": string|null,               // chassis / VIN, exactly as written
  "make": string|null,              // manufacturer only, e.g. "Volvo", "MAN"
  "model": string|null,             // e.g. "FH 460", "Actros 1845"
  "customer_name": string|null,     // the person or company BOOKING, not a place
  "origin_port": string|null,       // where the vehicle is loaded / collected
  "destination_port": string|null,  // the Egyptian port it is going TO
  "contact": string|null,           // phone number or email address
  "intent": "book"|"track"|"contact"|"menu"|"cancel"|null,
  "is_question": boolean            // are they ASKING something rather than answering
}

Use null for anything the message does not state. NEVER guess, never infer a
value from another one, and never repeat the example values below.

DIRECTION DECIDES WHICH PORT IS WHICH. "from Hamburg to Port Said" means
origin_port Hamburg and destination_port Port Said. A place named with no
direction at all is null, not a guess.

A COMPANY NAME IS NOT A PLACE. "Alexandria Trading Co" is a customer_name, and
destination_port stays null. "Port Said Motors" is a customer_name too.

The Egyptian destination is one of: ${DESTINATION_PORTS.join('; ')}. If the
message names an Egyptian port not on that list, still report what they wrote -
the application checks it, not you.

Examples.
"my car should reach Damietta, picking up in Antwerp"
  -> {"vin":null,"make":null,"model":null,"customer_name":null,"origin_port":"Antwerp","destination_port":"Damietta","contact":null,"intent":null,"is_question":false}
"its a volvo fh, chassis YV2RT40A8FB712905, for Nile Cargo"
  -> {"vin":"YV2RT40A8FB712905","make":"Volvo","model":"FH","customer_name":"Nile Cargo","origin_port":null,"destination_port":null,"contact":null,"intent":null,"is_question":false}
"how much does it cost to Alexandria?"
  -> {"vin":null,"make":null,"model":null,"customer_name":null,"origin_port":null,"destination_port":null,"contact":null,"intent":null,"is_question":true}`;

/** Is a model configured at all? Without one this layer simply does not run. */
export function nluAvailable() {
  return config.llm.provider === 'anthropic'
    ? Boolean(config.llm.anthropicKey)
    : Boolean(config.llm.openaiKey);
}

/**
 * Reads a message for booking details.
 *
 * @param {string} text
 * @param {{asked?: string|null, timeoutMs?: number}} [opts]
 * @returns {Promise<{fields: object, intent: string|null, question: boolean, used: boolean}>}
 */
export async function understand(text, { asked = null, timeoutMs = 6000 } = {}) {
  const empty = { fields: {}, intent: null, question: false, used: false };
  const message = String(text ?? '').trim();
  if (!message || message.length > 800 || !nluAvailable()) return empty;

  let raw;
  try {
    // A booking must never hang on this. If the model is slow the client gets
    // the plain "I need X" a beat later, which is a worse answer, not a broken
    // one - so the timeout is short and losing the race is not an error.
    raw = await Promise.race([
      chat({
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: asked
            ? `The customer was asked for: ${asked}. Their reply:\n\n${message}`
            : message,
        }],
        tools: [],
        // The cheap model. This is extraction against a fixed shape, which is
        // exactly what it is good at, and there is a lot of it per booking.
        fast: true,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('nlu timed out')), timeoutMs)),
    ]);
  } catch (err) {
    logEvent('nlu_failed', { error: err?.message });
    return empty;
  }

  const parsed = parseJson(raw?.content);
  if (!parsed) return empty;

  const fields = validate(parsed);
  logEvent('nlu_used', { asked, found: Object.keys(fields), question: Boolean(parsed.is_question) });

  return {
    fields,
    intent: ['book', 'track', 'contact', 'menu', 'cancel'].includes(parsed.intent) ? parsed.intent : null,
    question: parsed.is_question === true,
    used: true,
  };
}

/**
 * Everything the model returned, checked the same way a typed value is.
 *
 * This is the whole safety of the arrangement. A hallucinated chassis number
 * does not look like a chassis number; an invented port is not one of the five;
 * a sentence returned as a client name is too long. What survives is only what
 * would have been accepted anyway.
 */
export function __validateForTests(parsed) { return validate(parsed); }

function validate(parsed) {
  const out = {};
  const clean = (v, max = 120) => {
    const s = String(v ?? '').trim().replace(/\s+/g, ' ');
    return s && s.length <= max ? s : null;
  };

  const vin = clean(parsed.vin, 30);
  if (vin && looksLikeVin(vin)) out.vin = vin.toUpperCase().replace(/[^A-Z0-9]/g, '');

  const dest = clean(parsed.destination_port, 60);
  if (dest) {
    // Must be one of the five. A model naming Aswan is reporting what the
    // client said, and the client is still wrong.
    const port = matchPort(dest);
    if (port) out.destination_port = port;
  }

  const origin = clean(parsed.origin_port, 60);
  // Nobody loads at an Egyptian discharge port, so that is a misread rather
  // than a loading point.
  if (origin && !matchPort(origin)) out.origin_port = origin;

  const make = clean(parsed.make, 40);
  if (make && !looksLikeSentence(make)) out.make = make;

  const model = clean(parsed.model, 60);
  if (model && !looksLikeSentence(model)) out.model = model;

  const name = clean(parsed.customer_name, 120);
  if (name && !looksLikeSentence(name)) out.customer_name = name;

  const contact = clean(parsed.contact, 80);
  if (contact && /[@\d]/.test(contact)) out.contact = contact;

  return out;
}

/**
 * A model asked for a name sometimes returns the sentence it came from. Six
 * words or a question mark is prose, not a field.
 */
function looksLikeSentence(value) {
  const s = String(value);
  return s.split(/\s+/).length > 6 || /[?؟]/.test(s);
}

function parseJson(content) {
  const text = String(content ?? '').trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}
