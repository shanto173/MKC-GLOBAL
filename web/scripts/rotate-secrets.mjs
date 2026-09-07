/**
 * Rotates the two secrets we invented ourselves - the admin password for the
 * operations console, and the shared secret Telegram sends back on every
 * webhook call - and puts the new values in Vercel, in .env, and in Telegram.
 *
 *   npm run rotate                 show what would change, change nothing
 *   npm run rotate -- --apply      do it
 *
 * Needs VERCEL_TOKEN in the environment (Vercel -> Account Settings -> Tokens).
 * Without it the script still prints the new values and the exact places to
 * paste them.
 *
 * The other six credentials - the bot token, the Supabase service key, the
 * database password, the OpenAI key, the Resend key and the Vercel token - can
 * only be replaced by the service that issued them. docs/ROTATE-CREDENTIALS.md
 * is the order to do that in.
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const apply = process.argv.includes('--apply');
const token = process.env.VERCEL_TOKEN;
const project = process.env.VERCEL_PROJECT || 'mkc-global';
const teamQuery = process.env.VERCEL_TEAM_ID ? `?teamId=${process.env.VERCEL_TEAM_ID}` : '';

const fresh = () => crypto.randomBytes(24).toString('base64url');
const next = { ADMIN_SECRET: fresh(), TELEGRAM_WEBHOOK_SECRET: fresh() };

console.log(apply ? 'Rotating.\n' : 'Dry run - nothing is changed. Add --apply to do it.\n');
for (const [key, value] of Object.entries(next)) console.log(`${key}=${value}`);

if (!apply) {
  console.log('\nNothing written.');
  process.exit(0);
}

// --- 1. Vercel --------------------------------------------------------------
async function vercel(pathname, options = {}) {
  const res = await fetch(`https://api.vercel.com${pathname}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

if (token) {
  const { envs } = await vercel(`/v9/projects/${project}/env${teamQuery}`);
  for (const [key, value] of Object.entries(next)) {
    const existing = (envs ?? []).filter((e) => e.key === key);
    for (const e of existing) {
      await vercel(`/v9/projects/${project}/env/${e.id}${teamQuery}`, { method: 'DELETE' });
    }
    await vercel(`/v10/projects/${project}/env${teamQuery}`, {
      method: 'POST',
      body: JSON.stringify({ key, value, type: 'encrypted', target: ['production', 'preview', 'development'] }),
    });
    console.log(`vercel: ${key} replaced`);
  }
  // A variable only reaches the running app on the next build.
  const { deployments } = await vercel(`/v6/deployments?projectId=${project}&limit=1&state=READY${teamQuery ? '&' + teamQuery.slice(1) : ''}`);
  const last = deployments?.[0];
  if (last) {
    await vercel(`/v13/deployments${teamQuery}`, {
      method: 'POST',
      body: JSON.stringify({ name: project, deploymentId: last.uid, target: 'production', meta: { rotated: 'secrets' } }),
    });
    console.log('vercel: redeploying production with the new values');
  }
} else {
  console.log('\nNo VERCEL_TOKEN, so nothing was sent to Vercel.');
  console.log('Paste both values at: Vercel -> your project -> Settings -> Environment Variables,');
  console.log('then Deployments -> ... -> Redeploy.');
}

// --- 2. .env ----------------------------------------------------------------
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (fs.existsSync(envPath)) {
  let text = fs.readFileSync(envPath, 'utf8');
  for (const [key, value] of Object.entries(next)) {
    text = new RegExp(`^${key}=.*$`, 'm').test(text)
      ? text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`)
      : `${text.replace(/\s*$/, '')}\n${key}=${value}\n`;
  }
  fs.writeFileSync(envPath, text);
  console.log('.env updated');
}

// --- 3. Telegram ------------------------------------------------------------
// Only after production has the new value, or every incoming message is
// rejected by the webhook that no longer recognises the secret.
console.log('\nNow wait for the deployment to finish, then run:');
console.log('  npm run setup:webhook -- https://mkc-global.vercel.app');
console.log('\nAnd sign in to the console again with the new ADMIN_SECRET.');
