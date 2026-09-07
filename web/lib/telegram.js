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

export async function sendMessage(chatId, text, { keyboard, returnMessage = false } = {}) {
  const parts = chunk(text);
  let last;
  for (let i = 0; i < parts.length; i++) {
    const payload = { chat_id: chatId, text: parts[i], disable_web_page_preview: true };
    if (keyboard && i === parts.length - 1) {
      payload.reply_markup = { keyboard, resize_keyboard: true, one_time_keyboard: false };
    }
    last = await call('sendMessage', payload);
  }
  // The caller sometimes needs the message back - to pin it, for instance.
  return returnMessage ? last : undefined;
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

/** Like call(), but silent: a sweep expects failures and would flood the log. */
async function tryCall(method, payload, { retryOn429 = true } = {}) {
  let data;
  try {
    const res = await fetch(API(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    data = await res.json().catch(() => ({ ok: false }));
  } catch {
    return { ok: false };
  }

  // Deleting hundreds of messages runs into Telegram's rate limit. Counting a
  // "too many requests" as a refusal would end the sweep early and leave the
  // conversation half cleared, so it waits the time it is told and tries again.
  if (!data.ok && data.error_code === 429 && retryOn429) {
    const wait = Math.min(Number(data.parameters?.retry_after) || 1, 3);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return tryCall(method, payload, { retryOn429: false });
  }
  return data;
}

/**
 * Wipes the visible chat, not just our memory of it.
 *
 * Telegram lets a bot delete its own messages and, in a private chat, the
 * customer's too - but only for 48 hours, and there is no way to ask for a
 * chat's history. So we walk back from the message being handled: ids in a
 * private chat run in sequence.
 *
 * deleteMessages looked like the fast way to do that, and it is - right up to
 * the first message older than two days, at which point it refuses the entire
 * batch of a hundred rather than skipping that one. So a failed batch is
 * retried one message at a time, and once forty in a row have been refused we
 * have reached the 48-hour wall and stop: everything older will refuse too.
 *
 * @returns {Promise<{deleted: number, refused: number, reachedLimit: boolean}>}
 */
export async function sweepChat(chatId, fromMessageId, howMany = 300) {
  const newest = Number(fromMessageId);
  if (!Number.isFinite(newest)) return { deleted: 0, refused: 0, reachedLimit: false };

  const oldest = Math.max(1, newest - howMany + 1);
  let deleted = 0;
  let refused = 0;
  let refusedInARow = 0;

  for (let top = newest; top >= oldest; top -= 100) {
    const batch = [];
    for (let id = top; id > Math.max(oldest - 1, top - 100); id--) batch.push(id);

    const quick = await tryCall('deleteMessages', { chat_id: chatId, message_ids: batch });
    if (quick.ok) {
      deleted += batch.length;
      refusedInARow = 0;
      continue;
    }

    // Newest first, so the run of refusals we count is the old end of the chat.
    for (let i = 0; i < batch.length; i += 8) {
      const group = batch.slice(i, i + 8);
      const results = await Promise.all(
        group.map((id) => tryCall('deleteMessage', { chat_id: chatId, message_id: id })),
      );
      for (const r of results) {
        if (r.ok) { deleted++; refusedInARow = 0; } else { refused++; refusedInARow++; }
      }
      if (refusedInARow >= 40) return { deleted, refused, reachedLimit: true };
    }
  }

  return { deleted, refused, reachedLimit: false };
}

/** Edits a message the bot already sent, in place. */
export async function editMessage(chatId, messageId, text) {
  const res = await tryCall('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
  });
  // Re-sending identical text is not a failure - there was simply nothing new.
  if (!res.ok && /message is not modified/i.test(res.description ?? '')) return { ok: true, unchanged: true };
  return res;
}

/** Pins a message to the top of the chat. Silent: no notification for it. */
export async function pinMessage(chatId, messageId) {
  return tryCall('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true });
}

export async function unpinMessage(chatId, messageId) {
  return tryCall('unpinChatMessage', { chat_id: chatId, message_id: messageId });
}

/** What is pinned in this chat right now, if anything, and whether it is ours. */
export async function pinnedMessage(chatId) {
  const res = await tryCall('getChat', { chat_id: chatId });
  const pinned = res?.result?.pinned_message;
  if (!pinned) return null;
  return { messageId: pinned.message_id, mine: pinned.from?.is_bot === true, text: pinned.text ?? '' };
}

export async function deleteMessageQuietly(chatId, messageId) {
  return tryCall('deleteMessage', { chat_id: chatId, message_id: messageId });
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
