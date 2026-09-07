import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

let client = null;

/**
 * Server-side Supabase client using the service_role key.
 * This bypasses Row Level Security, so it must never run in a browser.
 */
export function db() {
  if (!client) {
    if (!config.supabase.url || !config.supabase.serviceRoleKey) {
      throw new Error('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
    }
    client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/**
 * Replaces the client, for tests only.
 *
 * The flows are worth testing precisely because they must behave the same on a
 * Tuesday as on a Friday, and that is only checkable against a database whose
 * contents the test controls. Pass null to restore the real client.
 *
 * Guarded by NODE_ENV so a stray call in production cannot silently point the
 * bot at something that is not Supabase.
 */
export function setClientForTests(fake) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('setClientForTests must never be called in production');
  }
  client = fake;
}
