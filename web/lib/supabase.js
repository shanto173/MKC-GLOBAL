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
