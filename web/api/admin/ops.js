/**
 * One route, several admin resources.
 *
 *   /api/admin/tasks      ->  ?resource=tasks      the Operations work queue
 *   /api/admin/mrn        ->  ?resource=mrn        MRN applications
 *   /api/admin/read-test  ->  ?resource=read-test  why a document would not read
 *   /api/cron/outbox      ->  ?resource=outbox     drain queued notifications
 *
 * WHY THIS IS ONE FILE AND NOT FOUR.
 *
 * Vercel turns every file under api/ into its own Serverless Function, and the
 * Hobby plan allows twelve per deployment. The project was already at exactly
 * twelve, so adding tasks, mrn and the outbox cron as their own routes took it
 * to fifteen and every deployment failed at build time - the previous version
 * kept serving, so three pushes looked successful and changed nothing.
 *
 * The handlers still live one per file in lib/admin/; only the routing is
 * shared. The old URLs are preserved by rewrites in vercel.json, so nothing
 * that calls them has to know about any of this.
 *
 * If this project moves to a paid plan the rewrites can go and each handler can
 * have its own route again - the handlers themselves do not change.
 */

import { config } from '../../lib/config.js';
import tasks from '../../lib/admin/tasks.js';
import mrn from '../../lib/admin/mrn.js';
import readTest from '../../lib/admin/read-test.js';
import { drain } from '../../lib/outbox.js';

const RESOURCES = { tasks, mrn, 'read-test': readTest };

export default async function handler(req, res) {
  const resource = String(req.query.resource ?? '').trim();

  if (resource === 'outbox') return outbox(req, res);

  const route = RESOURCES[resource];
  if (!route) {
    return res.status(404).json({
      error: `unknown resource "${resource}"`,
      resources: [...Object.keys(RESOURCES), 'outbox'],
    });
  }

  // Each handler does its own ADMIN_SECRET check, so authorisation is not
  // centralised here - a resource added later cannot forget it by inheriting a
  // check that this dispatcher performed on its behalf.
  return route(req, res);
}

/**
 * Sends whatever is waiting in the notification outbox.
 *
 * Vercel Cron signs its calls with CRON_SECRET in an Authorization header; a
 * manual run uses ADMIN_SECRET. Neither is optional - an open endpoint here
 * would let anyone force delivery attempts.
 *
 * There is no cron entry in vercel.json at present: Hobby refuses a schedule
 * more frequent than daily, and a daily retry is not worth a function slot when
 * every inline drain already sends everything that is due. Add one back on a
 * paid plan, or call this by hand.
 */
async function outbox(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.authorization ?? '';
  const fromCron = Boolean(cronSecret) && auth === `Bearer ${cronSecret}`;

  const provided = req.query.secret ?? req.headers['x-admin-secret'];
  const byHand = Boolean(config.adminSecret) && provided === config.adminSecret;

  if (!fromCron && !byHand) return res.status(401).json({ error: 'Unauthorized' });

  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const result = await drain({ limit });
  return res.status(result.ok ? 200 : 500).json(result);
}
