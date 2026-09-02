/** Quick "is everything wired up?" check. Safe to open in a browser. */

import { config } from '../lib/config.js';
import { db } from '../lib/supabase.js';

export default async function handler(_req, res) {
  const checks = {
    supabase_url: Boolean(config.supabase.url),
    supabase_key: Boolean(config.supabase.serviceRoleKey),
    telegram_token: Boolean(config.telegram.token),
    telegram_webhook_secret: Boolean(config.telegram.webhookSecret),
    llm_provider: config.llm.provider,
    llm_key: config.llm.provider === 'anthropic' ? Boolean(config.llm.anthropicKey) : Boolean(config.llm.openaiKey),
    embeddings: Boolean(config.llm.openaiKey),
  };

  let database = 'not checked';
  let shipments = null;
  let documents = null;

  if (checks.supabase_url && checks.supabase_key) {
    try {
      const s = await db().from('shipments').select('*', { count: 'exact', head: true });
      const d = await db().from('documents').select('*', { count: 'exact', head: true });
      if (s.error) throw s.error;
      if (d.error) throw d.error;
      database = 'ok';
      shipments = s.count;
      documents = d.count;
    } catch (err) {
      database = `error: ${err.message}`;
    }
  }

  const ready = Object.values(checks).every(Boolean) && database === 'ok';
  res.status(ready ? 200 : 503).json({ ready, checks, database, rows: { shipments, documents } });
}
