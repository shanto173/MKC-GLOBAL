import { config } from './config.js';

const API = (method) => `https://api.telegram.org/bot${config.telegram.token}/${method}`;
const MAX_LEN = 4000; // Telegram hard limit is 4096

async function call(method, payload) {
  const res = await fetch(API(method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.error(`telegram ${method} failed:`, JSON.stringify(data).slice(0, 400));
  return data;
}

/** Split long replies so Telegram never rejects them. */
function chunk(text) {
  if (text.length <= MAX_LEN) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > MAX_LEN) {
    let cut = rest.lastIndexOf('\n', MAX_LEN);
    if (cut < MAX_LEN * 0.5) cut = MAX_LEN;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export async function sendMessage(chatId, text, { keyboard } = {}) {
  const parts = chunk(text);
  for (let i = 0; i < parts.length; i++) {
    const payload = { chat_id: chatId, text: parts[i], disable_web_page_preview: true };
    if (keyboard && i === parts.length - 1) {
      payload.reply_markup = { keyboard, resize_keyboard: true, one_time_keyboard: false };
    }
    await call('sendMessage', payload);
  }
}

export async function sendTyping(chatId) {
  await call('sendChatAction', { chat_id: chatId, action: 'typing' });
}

/** Upload a file (multipart, so it cannot go through the JSON helper above). */
export async function sendDocument(chatId, buffer, filename, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', new Blob([buffer], { type: 'application/pdf' }), filename);
  if (caption) form.append('caption', caption.slice(0, 1024));

  const res = await fetch(API('sendDocument'), { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`sendDocument: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

/**
 * Downloads a file a customer sent. Telegram gives a file_id in the update; the
 * bytes need two calls - one to resolve the path, one to fetch it.
 * Bot API downloads are capped at 20 MB, which is well under our storage limit.
 */
export async function downloadFile(fileId) {
  const info = await call('getFile', { file_id: fileId });
  const filePath = info?.result?.file_path;
  if (!filePath) throw new Error('Telegram would not give a path for that file.');

  const res = await fetch(`https://api.telegram.org/file/bot${config.telegram.token}/${filePath}`);
  if (!res.ok) throw new Error(`downloading the file failed: ${res.status}`);

  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    fileName: filePath.split('/').pop(),
    size: info.result.file_size ?? 0,
  };
}

/**
 * Wipes the visible chat, not just our memory of it.
 *
 * Telegram lets a bot delete its own messages and, in a private chat, the
 * customer's messages too - but only for 48 hours, and there is no way to ask
 * for a chat's history. So we walk back from the message being handled: ids in
 * a private chat run in sequence, and deleteMessages skips anything that is not
 * there or is too old rather than failing the whole batch.
 *
 * @returns {Promise<{attempted: number, batches: number, failed: number}>}
 */
export async function sweepChat(chatId, fromMessageId, howMany = 400) {
  const first = Math.max(1, Number(fromMessageId) - howMany + 1);
  const ids = [];
  for (let id = first; id <= Number(fromMessageId); id++) ids.push(id);

  let failed = 0;
  let batches = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const res = await call('deleteMessages', { chat_id: chatId, message_ids: ids.slice(i, i + 100) });
    batches++;
    if (!res.ok) failed++;
  }
  return { attempted: ids.length, batches, failed };
}

export async function setWebhook(url, secret) {
  return call('setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  });
}

export async function getWebhookInfo() {
  const res = await fetch(API('getWebhookInfo'));
  return res.json();
}

export async function setCommands() {
  return call('setMyCommands', {
    commands: [
      { command: 'start', description: 'Start / show the main menu' },
      { command: 'track', description: 'Track a shipment' },
      { command: 'book', description: 'Request a new booking' },
      { command: 'help', description: 'Talk to a human department' },
      { command: 'reset', description: 'Forget this conversation' },
    ],
  });
}

/**
 * Quick-reply buttons. Bilingual on one line rather than two separate keyboards,
 * because a Telegram keyboard is shared by the whole chat and we do not know
 * which language the next message will arrive in.
 */
export const MAIN_KEYBOARD = [
  [{ text: '1 · Book my shipment / احجز شحنة' }],
  [{ text: '2 · Track my shipment / تتبع شحنتي' }],
  [{ text: '3 · Contact our team / تواصل مع فريقنا' }],
  // One tap to start over. Customers testing the bot end up staring at an old
  // half-finished booking and cannot tell it apart from a real one.
  [{ text: '🧹 Start fresh / ابدأ من جديد' }],
];
