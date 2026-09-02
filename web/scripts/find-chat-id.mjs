/**
 * Finds the chat_id of your staff Telegram group.
 *
 *   1. Create a Telegram group, e.g. "MKC Bookings"
 *   2. Add @MKC_Global_bot to it
 *   3. Send any message in the group, e.g. "hello"
 *   4. npm run chatid
 *
 * Group ids are negative, e.g. -1002345678901. Put it in STAFF_CHAT_ID.
 *
 * Note: this reads pending updates, which only works while no webhook is set.
 * The script detaches the webhook, reads, then puts it back exactly as it was.
 */

import 'dotenv/config';
import { config } from '../lib/config.js';

const API = (m) => `https://api.telegram.org/bot${config.telegram.token}/${m}`;

if (!config.telegram.token) {
  console.error('TELEGRAM_BOT_TOKEN is not set in .env');
  process.exit(1);
}

const infoRes = await fetch(API('getWebhookInfo'));
const info = (await infoRes.json()).result;
const hadWebhook = Boolean(info?.url);

if (hadWebhook) {
  console.log('Temporarily detaching webhook to read pending messages...');
  await fetch(API('deleteWebhook'), { method: 'POST' });
}

try {
  const res = await fetch(API('getUpdates') + '?limit=100');
  const updates = (await res.json()).result ?? [];

  const chats = new Map();
  for (const u of updates) {
    const chat = u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat;
    if (chat) chats.set(chat.id, chat);
  }

  if (!chats.size) {
    console.log('\nNo recent messages found.');
    console.log('Send a message in the group (with the bot in it), then run this again.');
  } else {
    console.log('\nChats the bot has seen recently:\n');
    for (const c of chats.values()) {
      const label = c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '';
      console.log(`  ${String(c.id).padEnd(18)} ${String(c.type).padEnd(10)} ${label}`);
    }
    const group = [...chats.values()].find((c) => c.type === 'group' || c.type === 'supergroup');
    if (group) console.log(`\n=> Put this in .env:  STAFF_CHAT_ID=${group.id}`);
    else console.log('\nNo group found yet - add the bot to a group and send a message there.');
  }
} finally {
  if (hadWebhook) {
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
}
