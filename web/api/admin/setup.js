/**
 * One-click wiring of the Telegram webhook after a deploy.
 *
 *   https://<your-app>.vercel.app/api/admin/setup?secret=<ADMIN_SECRET>
 *
 * Registers this deployment's /api/telegram URL with Telegram, installs the
 * command menu, and reports what Telegram thinks the webhook is.
 */

import { config } from '../../lib/config.js';
import { setWebhook, getWebhookInfo, setCommands } from '../../lib/telegram.js';

export default async function handler(req, res) {
  if (!config.adminSecret || req.query.secret !== config.adminSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!config.telegram.token || !config.telegram.webhookSecret) {
    return res.status(400).json({ error: 'TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must be set.' });
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const base = config.publicBaseUrl || `https://${host}`;
  const url = `${base}/api/telegram`;

  const setResult = await setWebhook(url, config.telegram.webhookSecret);
  const commands = await setCommands();
  const info = await getWebhookInfo();

  res.status(setResult.ok ? 200 : 500).json({
    webhook_url: url,
    set_webhook: setResult,
    set_commands: commands.ok ?? commands,
    webhook_info: info.result,
  });
}
