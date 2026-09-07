/**
 * Is the state machine's schema actually there?
 *
 * A deployment and a migration are two separate acts, and they do not always
 * happen in the right order - a push lands, Vercel builds, and the migration is
 * still a browser tab somebody has not clicked Run in. Without this check the
 * new code would then query `conversation_sessions`, get "relation does not
 * exist", and answer every single customer with "something went wrong". A bot
 * that is completely dead is far worse than the one it replaced.
 *
 * So the code asks, once a minute, whether its tables exist. If they do not, it
 * falls back to exactly the behaviour of the previous release: the model keeps
 * its booking tools and the old prompt, and the flow stands aside. The moment
 * the migration is applied the fallback stops, with no redeploy.
 */

import { db } from '../supabase.js';

const TTL_MS = 60_000;

let present = null;
let checkedAt = 0;
let inflight = null;
let warned = false;

/** Postgres says this when the table is not there. PostgREST forwards the code. */
function tableMissing(error) {
  if (!error) return false;
  return error.code === '42P01'
    || /relation .* does not exist|Could not find the table|schema cache/i.test(error.message ?? '');
}

async function probe() {
  try {
    const { error } = await db().from('conversation_sessions').select('id').limit(1);
    if (!error) return true;
    if (tableMissing(error)) return false;
    // Any other error - a network blip, a permissions problem - is not evidence
    // that the migration is missing. Assume the schema is there rather than
    // silently reverting a working deployment to the old engine.
    console.error('conversation_sessions probe failed (assuming present):', error.message);
    return true;
  } catch (err) {
    console.error('conversation_sessions probe threw (assuming present):', err?.message);
    return true;
  }
}

/**
 * @returns {Promise<boolean>} true when migration 008 has been applied
 */
export async function flowReady() {
  if (present !== null && Date.now() - checkedAt < TTL_MS) return present;

  if (!inflight) {
    inflight = probe()
      .then((result) => {
        present = result;
        checkedAt = Date.now();
        if (!result && !warned) {
          warned = true;
          console.error(
            'MIGRATION 008 HAS NOT BEEN APPLIED. conversation_sessions is missing, so the '
            + 'booking state machine is standing aside and the previous LLM booking engine is '
            + 'handling bookings. Apply supabase/migrations/20260908120000_state_machine_and_'
            + 'operations.sql to switch it on. /api/health lists everything that is missing.',
          );
        }
        if (result) warned = false;
        return result;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** Test seam, and a way to force a re-probe after applying the migration. */
export function resetFlowReady(value = null) {
  present = value;
  checkedAt = value === null ? 0 : Date.now();
  warned = false;
}
