/**
 * Points your Telegram bot at a deployed URL.
 *
 *   npm run setup:webhook -- https://your-app.vercel.app
 *
 * With no argument it uses PUBLIC_BASE_URL from .env.
 * Pass --delete to unhook the bot (useful when switching to local testing).
 */

import 'dotenv/config';
import { config } from '../lib/config.js';
import { setWebhook, getWebhookInfo, setCommands } from '../lib/telegram.js';

if (!config.telegram.token) {
  console.error('TELEGRAM_BOT_TOKEN is not set in .env');
  process.exit(1);
}

if (process.argv.includes('--delete')) {
  const res = await fetch(`https://api.telegram.org/bot${config.telegram.token}/deleteWebhook`, { method: 'POST' });
  console.log(await res.json());
  process.exit(0);
}

const base = (process.argv[2] || config.publicBaseUrl || '').replace(/\/+$/, '');
if (!base) {
  console.error('Usage: npm run setup:webhook -- https://your-app.vercel.app');
  process.exit(1);
}
if (!config.telegram.webhookSecret) {
  console.error('TELEGRAM_WEBHOOK_SECRET is not set. Invent a long random string and put it in .env AND in Vercel.');
  process.exit(1);
}

const url = `${base}/api/telegram`;
const result = await setWebhook(url, config.telegram.webhookSecret);
await setCommands();
const info = await getWebhookInfo();

console.log('setWebhook:', result.ok ? 'ok' : JSON.stringify(result));
console.log('webhook   :', info.result?.url);
console.log('pending   :', info.result?.pending_update_count);
if (info.result?.last_error_message) {
  console.log('last error:', info.result.last_error_message);
}
