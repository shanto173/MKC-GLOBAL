/**
 * The desk's one door to lib/channels.js - sending to a customer on whichever
 * channel they use.
 *
 * WHY A DOOR AND NOT AN IMPORT. lib/channels.js is written by another work
 * package and can arrive after this code is deployed: a static import of a file
 * that is not there stops the whole operations API from loading, so nobody
 * could even read the inbox. Loaded on demand, its absence is one answer -
 * null - that every caller already knows what to do with: Telegram falls back
 * to the outbox the console always used, WhatsApp says it is not connected yet.
 *
 * A module that loads but lacks sendToChat is treated as absent too, so a half
 * finished version cannot be called into.
 *
 * Tests replace this module with node's module mocks; the real loader is only
 * ever exercised against the real file.
 */

let loaded;          // undefined = not tried; null = not available; else the module

export async function channels() {
  if (loaded !== undefined) return loaded;
  try {
    const mod = await import('../channels.js');
    loaded = typeof mod?.sendToChat === 'function' ? mod : null;
  } catch (err) {
    // channels.js itself missing is expected before the channel work is merged.
    // Anything else - it throwing as it loads, or a file IT imports missing -
    // is a broken deploy and worth a line in the log.
    const selfMissing = err?.code === 'ERR_MODULE_NOT_FOUND'
      && /Cannot find module '[^']*[\\/]channels\.js'/.test(String(err?.message));
    if (!selfMissing) console.error('lib/channels.js failed to load:', err?.message);
    loaded = null;
  }
  return loaded;
}
