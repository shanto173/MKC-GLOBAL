/**
 * Where an old console address goes in the desk.
 *
 * /ops/ and /ops.html stay as small pages that forward here, because people
 * have them bookmarked and links to bookings were pasted into chats. A link to
 * a booking in the old console opens that booking's case; a link to a list
 * opens the inbox filtered the closest way. Nothing is lost by following an
 * old link, and nothing old is left to fall out of date.
 */

const enc = encodeURIComponent;

/**
 * @param {string} hash  the old address's hash, e.g. "#/booking/MKY-BKG-1"
 * @returns {string}     the desk address, e.g. "/desk/#/case/booking/MKY-BKG-1"
 */
export function legacyTarget(hash = '') {
  const parts = String(hash).replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean)
    .map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  const [page, arg] = parts;

  const to = (route) => `/desk/#/${route}`;
  if (page === 'booking' && arg) return to(`case/booking/${enc(arg)}`);
  if (page === 'request' && arg) return to(`case/request/${enc(arg)}`);
  if (page === 'shipment' && arg) return to(`shipments/${enc(arg)}`);
  if (page === 'shipments') return to('shipments');
  if (page === 'mrn' || (page === 'queue' && arg === 'mrn')) return to('inbox?filter=mrn');
  if (page === 'requests') return to('inbox?filter=callbacks');
  if (page === 'tasks' || (page === 'queue' && arg === 'mine')) return to('inbox?filter=mine');
  if (page === 'confirmed' || (page === 'queue' && arg === 'confirmed_today')) return to('inbox?tab=done');
  if (page === 'queue' && arg === 'waiting_client') return to('inbox?tab=waiting');
  if (page === 'documents' || (page === 'queue' && arg === 'missing_documents')) return to('inbox?filter=bookings');
  return to('inbox');
}
