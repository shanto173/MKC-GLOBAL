/**
 * Work that must finish, but that nobody should wait for.
 *
 * An audit row, a typing indicator, the acknowledgement of a tapped button:
 * each is a network round trip, none of them changes what the client is told,
 * and putting them in front of the reply is a good part of what made every tap
 * feel slow. So they are started and left running - and awaited, all together,
 * just before the function returns.
 *
 * That last part matters. On a serverless platform a promise still in flight
 * when the response goes out may never complete, because the instance is
 * frozen the moment it has answered. This is what keeps "in the background"
 * from quietly meaning "lost".
 */

const pending = new Set();

/**
 * Starts (or adopts) a piece of work and remembers it until it is done.
 * Failures are logged and swallowed: nothing deferred is allowed to fail the
 * request that started it.
 */
export function defer(work) {
  const p = Promise.resolve(work).catch((err) => {
    console.error('background work failed:', err?.message ?? err);
    return null;
  });
  pending.add(p);
  p.then(() => pending.delete(p));
  return p;
}

/** Waits for everything deferred so far - including work deferred meanwhile. */
export async function flush() {
  while (pending.size) {
    await Promise.all([...pending]);
  }
}
