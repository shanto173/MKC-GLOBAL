/**
 * Finds the chat_id of your staff Telegram group.
 *
 *   1. Create a Telegram group, e.g. "MKC Bookings"
 *   2. Add @MKC_Global_bot to it
 *   3. Run:  npm run chatid
 *   4. When it says LISTENING, send  /start@MKC_Global_bot  in the group
 *
 * Group ids are negative, e.g. -1002345678901. Put it in STAFF_CHAT_ID.
 *
 * Why it has to listen live: while a webhook is set, Telegram posts updates to
 * that URL and never queues them for getUpdates. So the script detaches the
 * webhook, listens, then restores it exactly as it was - including on Ctrl+C.
 */

import 'dotenv/config';
import { config } from '../lib/config.js';

const API = (m) => `https://api.telegram.org/bot${config.telegram.token}/${m}`;
const LISTEN_SECONDS = 120;

if (!config.telegram.token) {
  console.error('TELEGRAM_BOT_TOKEN is not set in .env');
  process.exit(1);
}

const info = (await (await fetch(API('getWebhookInfo'))).json()).result;
const hadWebhook = Boolean(info?.url);

async function restore() {
  if (!hadWebhook) return;
  await fetch(API('setWebhook'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: info.url,
      secret_token: config.telegram.webhookSecret,
      allowed_updates: ['message'],
    }),
  });
  console.log('\nWebhook restored:', info.url);
}

// Put the bot back together even if the user gives up half way.
let restored = false;
const safeRestore = async () => {
  if (restored) return;
  restored = true;
  await restore();
};
process.on('SIGINT', async () => {
  console.log('\nInterrupted.');
  await safeRestore();
  process.exit(0);
});

try {
  if (hadWebhook) {
    console.log('Detaching webhook so this script can read messages...');
    await fetch(API('deleteWebhook'), { method: 'POST' });
    console.log('(the bot will not answer customers for the next couple of minutes)');
  }

  console.log('\n  LISTENING - now send this in your group:\n');
  console.log('      /start@MKC_Global_bot\n');
  console.log(`  Waiting up to ${LISTEN_SECONDS}s. Ctrl+C to stop.\n`);

  const chats = new Map();
  const deadline = Date.now() + LISTEN_SECONDS * 1000;
  let offset = 0;

  while (Date.now() < deadline) {
    // Long poll: the request parks until Telegram has something or 25s passes.
    const res = await fetch(API('getUpdates') + `?timeout=25&offset=${offset}`);
    const updates = (await res.json()).result ?? [];

    for (const u of updates) {
      offset = u.update_id + 1;
      const chat = u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat;
      if (!chat || chats.has(chat.id)) continue;
      chats.set(chat.id, chat);
      const label = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '';
      console.log(`  found  ${String(chat.id).padEnd(18)} ${String(chat.type).padEnd(11)} ${label}`);
    }

    if ([...chats.values()].some((c) => c.type === 'group' || c.type === 'supergroup')) break;
  }

  const group = [...chats.values()].find((c) => c.type === 'group' || c.type === 'supergroup');

  if (group) {
    console.log(`\n  Add this line to web/.env AND to Vercel:\n`);
    console.log(`      STAFF_CHAT_ID=${group.id}\n`);
  } else if (chats.size) {
    console.log('\n  Only private chats seen - no group yet.');
    console.log('  Make sure the bot is a MEMBER of the group, then send /start@MKC_Global_bot there.');
  } else {
    console.log('\n  Nothing received.');
    console.log('  Check that the bot was added to the group, and send /start@MKC_Global_bot in it.');
  }
} finally {
  await safeRestore();
}
