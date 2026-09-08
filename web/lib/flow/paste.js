/**
 * Reading a pasted block of details.
 *
 * A client asked for the make will quite reasonably paste the whole table they
 * were given - "Make │ Volvo FH 460 │ Client │ Delta Trans Egypt │ ..." - and
 * the flow used to answer "that is rather long, please send just the value".
 * Every field it needed was in the message.
 *
 * So a long answer is parsed before it is refused. Deliberately deterministic:
 * a label followed by a value, on one line, with the labels named below. No
 * model is involved, so it behaves the same on a Tuesday as on a Friday and it
 * can be tested without a network.
 *
 * The rule this must never break: parsing suggests values, it does not accept
 * them. Everything it returns is validated by the caller exactly as if it had
 * been typed one field at a time - a port still has to be one of the five, a
 * chassis still has to look like a chassis.
 */

/**
 * Field labels, in both languages, longest first so "port of loading" is tested
 * before "port" and "client name" before "name".
 */
const LABELS = [
  ['destination_port', ['destination port', 'port of discharge', 'destination', 'discharge', 'to port', 'egyptian port',
                        'ميناء الوصول', 'ميناء الوصول المصري', 'الوجهة']],
  ['origin_port', ['port of loading', 'place of loading', 'loading port', 'loading', 'origin port', 'origin', 'from',
                   'ميناء الشحن', 'مدينة الشحن', 'مكان الشحن', 'الشحن من', 'شحن من', 'من']],
  ['customer_name', ['client name', 'customer name', 'client', 'customer', 'consignee', 'name',
                     'اسم العميل', 'العميل', 'الاسم']],
  ['vin', ['chassis / vin', 'chassis no', 'chassis number', 'chassis', 'vin no', 'vin',
           'رقم الشاسيه', 'الشاسيه']],
  ['make', ['make / brand', 'make', 'brand', 'manufacturer', 'vehicle',
            'الماركة', 'الصنف']],
];

/**
 * The vertical rules that separate COLUMNS, and the rest of the box-drawing
 * that only decorates.
 *
 * They have to be told apart. Treating the vertical bar as whitespace - or, as
 * a first attempt did, as a line break - splits a label away from its own value
 * and the table parses to nothing.
 */
const COLUMN = /[|｜│┃]/;
const DECORATION = /[─━┄┅┈┉╌╍═┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╞╡╪╫╬+]/g;

/**
 * Pulls booking fields out of a pasted block.
 *
 * @param {string} text
 * @returns {Record<string,string>} only fields it is confident about
 */
export function parsePastedFields(text) {
  const found = {};
  const raw = String(text ?? '');
  if (!raw.trim()) return found;

  for (const [label, value] of labelledPairs(raw)) {
    const key = label.toLowerCase().replace(/[^a-z؀-ۿ/ ]/g, '').trim();
    const clean = value.replace(DECORATION, ' ').trim().replace(/\s+/g, ' ');
    if (!key || !clean || clean.length > 120) continue;

    for (const [field, names] of LABELS) {
      // `continue`, not `break`. Breaking here abandoned the whole scan as soon
      // as ANY earlier field was already filled, so a table listing the chassis
      // before the make silently lost the make.
      if (found[field]) continue;
      if (names.some((n) => key === n || key.startsWith(n + ' ') || key.endsWith(' ' + n))) {
        found[field] = clean;
        break;                                       // this pair is spoken for
      }
    }
  }

  return found;
}

/**
 * Every "label, then value" pair in a message, however it was written.
 *
 * People do not retype a table, they copy one - and what arrives depends
 * entirely on what they copied it FROM. A Markdown table copied out of a
 * document arrives as backticks with the row numbers still attached and every
 * line run together:
 *
 *   Make / Brand`MAN`4Client name`Nile Cargo Egypt`5Port of loading`Hamburg`
 *
 * A terminal table arrives with box rules. A phone keyboard gives colons. All
 * three are the same intention, so all three are read here rather than in three
 * places that each know about one of them.
 */
function labelledPairs(raw) {
  const pairs = [];

  // Backticks first: a value wrapped in them is unambiguous, and this shape
  // has no line breaks to work from.
  if (raw.includes('`')) {
    const parts = raw.split('`');
    // parts alternate label, value, label, value… A trailing empty string from
    // the closing backtick is simply never paired.
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const label = parts[i].trim();
      const value = parts[i + 1].trim();
      if (label && value) pairs.push([label, value]);
    }
    if (pairs.length) return pairs;
  }

  for (const rawLine of raw.split(/[\n\r]+/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // A rule between rows carries no data: "├─────┼─────┤".
    if (!line.replace(DECORATION, '').replace(COLUMN, '').trim()) continue;

    if (COLUMN.test(line)) {
      // "│ Client │ Delta Trans Egypt │" - the cells are the columns.
      const cells = line.split(COLUMN).map((c) => c.replace(DECORATION, ' ').trim()).filter(Boolean);
      if (cells.length >= 2) pairs.push([cells[0], cells[1]]);
      continue;
    }

    // "Client: Delta Trans Egypt", or two or more spaces standing in for the
    // column rule once the borders are gone.
    const m = line.match(/^(.{2,40}?)\s*(?::|=|→|\s{2,})\s*(.+)$/);
    if (m) pairs.push([m[1], m[2]]);
  }

  return pairs;
}

/**
 * The value for ONE field, from a message that may or may not be a table row.
 *
 * "Chassis │ YV2RT40A8FB712905" is a single row, so it is not a paste by the
 * test below - and without this it was stored whole, label, box character and
 * all, as the chassis number. A labelled answer to the question that was asked
 * is still an answer to that question.
 *
 * @param {string} field the field being asked for
 * @param {string} text  what the client sent
 * @returns {string} the value, with any label and table borders removed
 */
export function valueFor(field, text) {
  const parsed = parsePastedFields(text);
  if (parsed[field]) return parsed[field];

  // Not labelled, or labelled as something else: take it as typed, minus the
  // table decoration a copy-paste drags along.
  return String(text ?? '')
    .replace(DECORATION, ' ')
    .split(COLUMN).join(' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Is this message a pasted block rather than an answer to the question asked?
 *
 * Two or more recognised labels. One is not enough: a client answering "Make"
 * with "Make: Volvo" has answered the question, and treating that as a paste
 * would be the same behaviour by a longer route.
 */
export function looksLikePaste(text) {
  return Object.keys(parsePastedFields(text)).length >= 2;
}

/**
 * "Volvo FH 460 Globetrotter" -> { make: 'Volvo', model: 'FH 460 Globetrotter' }
 *
 * Only when the first word is a manufacturer we recognise. Anything else is
 * left whole, because guessing where a make ends and a model begins is how
 * "Schmitz Cargobull" becomes make "Schmitz", model "Cargobull".
 */
const KNOWN_MAKES = new Set(['mercedes', 'mercedes-benz', 'benz', 'volvo', 'scania', 'man', 'daf',
  'iveco', 'renault', 'ford', 'isuzu', 'hino', 'mitsubishi', 'toyota', 'krone', 'wielton']);

export function splitMakeModel(value) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return { make: '', model: '' };

  const [first, ...rest] = text.split(' ');
  if (!rest.length) return { make: text, model: '' };
  if (KNOWN_MAKES.has(first.toLowerCase())) {
    return { make: first, model: rest.join(' ') };
  }
  return { make: text, model: '' };
}

// ---------------------------------------------------------------------------
// Pulling one value out of a sentence
// ---------------------------------------------------------------------------

/**
 * People do not answer a form, they answer a question.
 *
 * "here is my chasis number : WMA06XZZ8KM745219" was refused outright, because
 * the chassis test rejects anything longer than four words - so a client who
 * wrote a polite sentence was told their real chassis number was not one.
 *
 * Everything below is a parser, not a model: the same input gives the same
 * answer every time, and whatever it returns is validated exactly as if it had
 * been typed on its own.
 */

/** Openers people put in front of an answer, stripped repeatedly. */
const LEAD_IN = /^\s*(?:here\s+(?:is|are)|this\s+is|that\s+is|it\s*'?s|its|please|pls|ok(?:ay)?|yes|so|and|the|my|our|we|i|am|is|are|use|put|write|send(?:ing)?|sure|تمام|ماشي|طبعا|هو|هي)\b[\s,:;.-]*/i;

/**
 * The word for the field itself, e.g. "chassis number is …".
 *
 * Both languages. Half the clients on this lane write Arabic, and "الشحن من
 * فيلنيوس" stored whole put the words "shipping from" into the loading-port
 * column on the paperwork.
 */
const FIELD_WORDS = {
  vin: /\b(?:chass?is|chasis|chasse|vin|serial)\s*(?:number|no\.?|nr\.?|#)?\b|رقم الشاسيه|الشاسيه/i,
  make: /\b(?:make|brand|manufacturer|marque)\b|الماركة|ماركة/i,
  customer_name: /\b(?:client|customer|company|consignee|name)\b|اسمي|الاسم|العميل/i,
  origin_port: /\b(?:port\s+of\s+loading|loading\s+port|place\s+of\s+loading|loading|origin|shipping\s+from|ship\s+from|from)\b|الشحن من|ميناء الشحن|من/i,
  destination_port: /\b(?:destination\s+port|destination|discharge|deliver(?:y|ed)?\s+to|going\s+to|to)\b|ميناء الوصول|إلى/i,
};

/**
 * A chassis number hiding in a sentence.
 *
 * Scored rather than first-match: a message may hold a date, an invoice number
 * and a chassis, and the chassis is the token that mixes letters and digits at
 * the right length. Seventeen characters wins outright, because that is what a
 * modern VIN is.
 */
export function findVin(text) {
  const tokens = String(text ?? '').split(/[\s,;:|]+/).filter(Boolean);
  let best = null;

  for (const raw of tokens) {
    // Trailing punctuation is not part of the number.
    const token = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    const norm = token.toUpperCase().replace(/[^A-Z0-9]/g, '');

    if (norm.length < 8 || norm.length > 25) continue;
    if (!/[A-Z]/.test(norm) || !/[0-9]/.test(norm)) continue;
    // Our own references are not chassis numbers.
    if (/^MKY-/i.test(token)) continue;
    // A date, or a price.
    if (/^\d{4}-\d{2}-\d{2}$/.test(token)) continue;

    const score = norm.length === 17 ? 100 : 50 - Math.abs(17 - norm.length);
    if (!best || score > best.score) best = { value: token, score };
  }

  return best?.value ?? null;
}

/**
 * The value for one field, from whatever the client actually wrote.
 *
 * Order matters. A labelled row is the strongest signal, then a field-specific
 * reading, then the message with its openers removed. Anything it returns is
 * still checked by the caller.
 */
export function extractField(field, text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';

  // "Chassis │ ABC123" and "Chassis: ABC123" are already handled.
  const labelled = valueFor(field, raw);

  if (field === 'vin') {
    // A whole sentence, or a bare number: either way, find the number.
    return findVin(labelled) ?? findVin(raw) ?? labelled;
  }

  if (field === 'destination_port' || field === 'origin_port') {
    // These are matched against a known list by the caller, which already
    // searches inside a sentence - so the tidied text is enough.
    return tidy(labelled, field);
  }

  if (field === 'make') {
    const cleaned = tidy(labelled, field);
    // A manufacturer named anywhere in the sentence beats the whole sentence.
    const found = findMake(cleaned) ?? findMake(raw);
    return found ?? cleaned;
  }

  return tidy(labelled, field);
}

/** Strips openers and the name of the field, as many times as they appear. */
function tidy(text, field) {
  let s = String(text ?? '').trim();
  const word = FIELD_WORDS[field];

  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(LEAD_IN, '');
    if (word) {
      // "make is X", "make: X", "make = X", "make X"
      s = s.replace(new RegExp(`^${word.source}\s*(?:is|are|=|:)?[\s,:;.-]*`, 'i'), '');
    }
    s = s.replace(/^[\s,:;.\-–—]+/, '');
    if (s === before) break;
  }

  return s.trim().replace(/\s+/g, ' ') || String(text ?? '').trim();
}

/**
 * A manufacturer we recognise, and everything after it.
 *
 * "it is a DAF XF 480" gives back "DAF XF 480", not "DAF": the model is worth
 * keeping, and splitMakeModel separates the two a moment later. Cutting at the
 * make would throw the model away before anything had a chance to store it.
 */
function findMake(text) {
  const words = String(text ?? '').split(/[\s,]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const bare = words[i].replace(/[^A-Za-z-]/g, '');
    if (bare && KNOWN_MAKES.has(bare.toLowerCase())) {
      return [bare, ...words.slice(i + 1)].join(' ').replace(/[.,;]+$/, '').trim();
    }
  }
  return null;
}
