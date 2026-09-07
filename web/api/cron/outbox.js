/**
 * Drains the notification outbox.
 *
 *   GET /api/cron/outbox        called by Vercel Cron (see vercel.json)
 *   GET /api/cron/outbox?secret=...   run it by hand
 *
 * The flows and the Operations console both drain inline after they queue
 * something, so in the normal case a client hears back within a second. This
 * exists for the abnormal case: a Telegram outage, a rate limit, a client whose
 * phone was off. Those rows sit with a future available_at and nothing else
 * would ever come back for them.
 *
 * Authorisation: Vercel Cron signs its calls with CRON_SECRET in an
 * Authorization header. A manual run uses ADMIN_SECRET. Neither is optional -
 * an open endpoint here would let anyone force delivery attempts.
 */

import { config } from '../../lib/config.js';
import { drain } from '../../lib/outbox.js';

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.authorization ?? '';
  const fromCron = Boolean(cronSecret) && auth === `Bearer ${cronSecret}`;

  const provided = req.query.secret ?? req.headers['x-admin-secret'];
  const byHand = Boolean(config.adminSecret) && provided === config.adminSecret;

  if (!fromCron && !byHand) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const result = await drain({ limit });

  return res.status(result.ok ? 200 : 500).json(result);
}
