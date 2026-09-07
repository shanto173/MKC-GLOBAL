/**
 * Drains the notification outbox.
 *
 *   GET /api/cron/outbox        called by Vercel Cron (see vercel.json)
 *   GET /api/cron/outbox?secret=...   run it by hand
 *
 * The flows and the Operations console both drain inline after they queue
 * something, AND every inline drain sends whatever else is due - not just the
 * row it queued. So on a bot anyone is using, a message that failed its first
 * attempt goes out on the next customer message, within minutes.
 *
 * This cron is the backstop for a bot nobody has messaged since the failure.
 *
 * SCHEDULE: daily, because Vercel's Hobby plan refuses any cron more frequent
 * than once a day - and refuses it at BUILD time, so a five-minute schedule
 * here does not degrade the deployment, it fails it outright and leaves the
 * previous version serving. On Pro, set the schedule in vercel.json to every
 * five minutes; nothing else needs to change.
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
