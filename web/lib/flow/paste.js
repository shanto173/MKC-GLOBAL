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
                   'ميناء الشحن', 'مدينة الشحن', 'مكان الشحن']],
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

  for (const rawLine of raw.split(/[\n\r]+/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // A rule between rows carries no data: "├─────┼─────┤".
    if (!line.replace(DECORATION, '').replace(COLUMN, '').trim()) continue;

    let label = null;
    let value = null;

    if (COLUMN.test(line)) {
      // "│ Client │ Delta Trans Egypt │" - the cells are the columns.
      const cells = line.split(COLUMN).map((c) => c.replace(DECORATION, ' ').trim()).filter(Boolean);
      if (cells.length >= 2) {
        label = cells[0];
        value = cells[1];
      }
    } else {
      // "Client: Delta Trans Egypt", or two or more spaces standing in for the
      // column rule once the borders are gone.
      const m = line.match(/^(.{2,40}?)\s*(?::|=|→|\s{2,})\s*(.+)$/);
      if (m) {
        label = m[1];
        value = m[2];
      }
    }

    if (!label || !value) continue;

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
        break;                                       // this line is spoken for
      }
    }
  }

  return found;
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
