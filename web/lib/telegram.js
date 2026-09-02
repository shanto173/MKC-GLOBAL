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

export const MAIN_KEYBOARD = [
  [{ text: 'Track a shipment' }, { text: 'New booking' }],
  [{ text: 'Documents needed' }, { text: 'Talk to a human' }],
];
