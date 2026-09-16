/**
 * Phone numbers, as clients actually type them.
 *
 * "+20 100 555 1234", "01005551234", "٠١٠٠٥٥٥١٢٣٤" and "0020 100 555 1234" are
 * one number. What is stored is one shape - the digits, with a leading + when
 * a country code was given - so the desk can dial it, the next booking can
 * recognise it, and two bookings from the same person do not hold it twice in
 * two spellings.
 *
 * Nothing here checks a numbering plan. A real number refused is far worse than
 * an odd one accepted: Operations can read a number back to a client, a form
 * cannot.
 */

/** Our own routing addresses. A way to message somebody, not a way to phone them. */
export const ROUTING_ADDRESS = /^(telegram|web|whatsapp):/i;

const ARABIC_INDIC = /[٠-٩]/g;

/** Arabic-Indic digits to Western ones; everything else untouched. */
export function westernDigits(text) {
  return String(text ?? '').replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660));
}

/**
 * A phone-shaped run inside a message. The lookarounds keep it off a chassis
 * number: "W1T96340310484233" has fourteen digits in a row, and without them
 * that run was being read as somebody's mobile.
 */
const IN_TEXT = /(?<![A-Za-z0-9])(?:\+|00)?\d[\d\s().-]{6,}\d(?![A-Za-z0-9])/;

/** The whole value, and nothing else, is a number. */
const WHOLE = /^(?:\+|00)?[\d\s().-]{8,24}$/;

/**
 * The phone number in a message, in one shape, or null.
 *
 *   "my number is +20 100 555 1234" -> "+201005551234"
 *   "٠١٠٠٥٥٥١٢٣٤"                   -> "01005551234"
 *   "0020 100 555 1234"              -> "+201005551234"
 */
export function normalizePhone(text) {
  const western = westernDigits(text);
  const m = western.match(IN_TEXT);
  if (!m) return null;
  return shape(m[0]);
}

/** Is this stored value a phone number we could dial? */
export function looksLikePhone(value) {
  const western = westernDigits(value).trim();
  if (!western || ROUTING_ADDRESS.test(western)) return false;
  if (!WHOLE.test(western)) return false;
  return shape(western) !== null;
}

function shape(run) {
  let s = String(run).replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return (plus ? '+' : '') + digits;
}
