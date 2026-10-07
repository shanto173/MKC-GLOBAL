/**
 * WhatsApp Cloud API (Meta Graph API), with plain fetch - the twin of
 * lib/telegram.js.
 *
 * Same rule as there: nothing here throws into the flow. Every call resolves
 * to { ok, status, code, error, body, id }, logs a refusal, and leaves the
 * decision - retry, template, give up - to the caller, because only the caller
 * knows whether the message was an answer, a notification or a file.
 *
 *   code  Meta's error code (131047 window closed, 130429 throughput, 190 token
 *         expired...), null on success or when Meta was never reached.
 *   id    the wamid of a sent message, or the id of an uploaded media file.
 *
 * Limits used below are Meta's, from the Cloud API reference (checked October
 * 2026): text body 4096; reply buttons at most 3, title 20, id 256; list body
 * 4096 (1024 is used - see lib/channels.js), button label 20, at most 10 rows,
 * row title 24, description 72, row id 200, section title 24; captions 1024.
 * A downloaded media URL is valid for 5 minutes.
 */

import { config } from './config.js';

const GRAPH = 'https://graph.facebook.com';

/** Meta refuses a template parameter carrying a newline, tab or 5+ spaces. */
const TEMPLATE_PARAM_MAX = 1000;

/**
 * Throughput and quality limits: worth trying again later, with backoff.
 *
 *   4       app rate limit           80007   business account rate limit
 *   130429  Cloud API throughput     131048  spam rate limit (quality)
 *   131049  "healthy ecosystem"      131056  too many to one recipient
 */
export const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131048, 131049, 131056]);

/**
 * Codes that will fail the same way however often this message is retried.
 *
 *   131021  recipient is the sender     131026  not a WhatsApp user / cannot receive
 *   131045  number registration error  131051  unsupported message type
 *   131008  required parameter missing 131009  parameter value invalid
 *   133010  number not registered       100     invalid parameter
 *   132xxx  template problems (count, format, paused, disabled...)
 *
 * 131047 (the 24-hour window has closed) is deliberately not here: it is not
 * permanent, it means "send a template instead", and callers handle it.
 * 190 (token expired) is not here either: the message is fine, the token is
 * not, and a retry after someone fixes the token will deliver it.
 */
const PERMANENT_CODES = new Set([100, 131008, 131009, 131021, 131026, 131045, 131051, 133010]);

export function isPermanentError(code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return false;
  if (n >= 132000 && n < 133000) return true;
  return PERMANENT_CODES.has(n);
}

export const isRateLimited = (code) => RATE_LIMIT_CODES.has(Number(code));

/** The re-engagement error: free-form text outside the 24-hour window. */
export const WINDOW_CLOSED = 131047;

/** "Template does not exist in this language or is not approved yet." */
export const TEMPLATE_MISSING = 132001;

const base = () => `${GRAPH}/${config.whatsapp.graphVersion}`;

/** The Graph API, once. Resolves always; logs a refusal unless told not to. */
async function graph(path, { method = 'POST', json = null, form = null, quiet = false } = {}) {
  if (!config.whatsapp.token) {
    return { ok: false, status: 0, code: null, error: 'WHATSAPP_ACCESS_TOKEN is not set', body: null, id: null };
  }

  let res;
  let body;
  try {
    res = await fetch(`${base()}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.whatsapp.token}`,
        ...(json ? { 'content-type': 'application/json' } : {}),
      },
      body: json ? JSON.stringify(json) : form ?? undefined,
    });
    body = await res.json().catch(() => ({}));
  } catch (err) {
    if (!quiet) console.error(`whatsapp ${method} ${path.split('?')[0]} unreachable:`, err?.message);
    return { ok: false, status: 0, code: null, error: `network: ${err?.message ?? 'failed'}`, body: null, id: null };
  }

  if (!res.ok || body?.error) {
    const e = body?.error ?? {};
    const code = e.code ?? null;
    const error = [e.message, e.error_data?.details].filter(Boolean).join(' - ') || `HTTP ${res.status}`;
    if (!quiet) console.error(`whatsapp ${method} ${path.split('?')[0]} failed (${code ?? res.status}):`, error.slice(0, 300));
    // A dead token stops every message on the channel. It is said in capitals
    // so it is the line someone finds in the log, not one of a thousand.
    if (code === 190 || code === 0 || res.status === 401) {
      console.error('WHATSAPP ACCESS TOKEN REJECTED - nothing can be sent on WhatsApp until WHATSAPP_ACCESS_TOKEN is replaced. /api/health?deep=1 checks it.');
    }
    return { ok: false, status: res.status, code, subcode: e.error_subcode ?? null, error, body, id: null };
  }

  return { ok: true, status: res.status, code: null, error: null, body, id: body?.messages?.[0]?.id ?? body?.id ?? null };
}

/** Every outbound message has the same envelope. */
function message(to, type, content) {
  return graph(`${config.whatsapp.phoneNumberId}/messages`, {
    json: { messaging_product: 'whatsapp', recipient_type: 'individual', to: String(to), type, [type]: content },
  });
}

/** Plain text, at most 4096 characters (lib/channels.js splits longer ones). */
export function sendText(to, body) {
  return message(to, 'text', { preview_url: false, body: String(body) });
}

/**
 * Up to three reply buttons under a body of at most 1024 characters.
 * @param {Array<{id: string, title: string}>} buttons
 */
export function sendButtons(to, body, buttons) {
  return message(to, 'interactive', {
    type: 'button',
    body: { text: String(body) },
    action: {
      buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: String(b.id), title: String(b.title) } })),
    },
  });
}

/**
 * A list: one button that opens up to ten rows.
 * @param {{button: string, sections: Array<{title: string, rows: Array<{id: string, title: string, description?: string}>}>}} list
 */
export function sendList(to, body, { button, sections }) {
  return message(to, 'interactive', {
    type: 'list',
    body: { text: String(body) },
    action: { button: String(button), sections },
  });
}

/**
 * Uploads a file and returns its media id. Media uploaded this way is kept by
 * Meta for 30 days, which is far longer than any message needs it.
 */
export function uploadMedia(buffer, { mimeType = 'application/pdf', fileName = 'document.pdf' } = {}) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([buffer], { type: mimeType }), fileName);
  return graph(`${config.whatsapp.phoneNumberId}/media`, { form });
}

/** A file: uploaded first, then sent by its media id, with an optional caption. */
export async function sendDocument(to, { buffer, fileName = 'document.pdf', caption = '', mimeType = 'application/pdf' }) {
  const uploaded = await uploadMedia(buffer, { mimeType, fileName });
  if (!uploaded.ok || !uploaded.id) return { ...uploaded, ok: false, error: uploaded.error ?? 'upload returned no media id' };
  return message(to, 'document', {
    id: uploaded.id,
    filename: fileName,
    ...(caption ? { caption: String(caption).slice(0, 1024) } : {}),
  });
}

/** Template parameters cannot carry line breaks, tabs, or runs of spaces. */
export function templateParam(value) {
  const text = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {4,}/g, '   ')
    .trim()
    .slice(0, TEMPLATE_PARAM_MAX);
  // An empty parameter is refused outright; a dash reads as "none".
  return text || '—';
}

/**
 * An approved template - the only thing that may be sent once the 24-hour
 * window has closed.
 *
 * @param {{name: string, language: string, bodyParams?: string[],
 *          headerDocument?: {id: string, filename: string}|null}} template
 */
export function sendTemplate(to, { name, language, bodyParams = [], headerDocument = null }) {
  const components = [];
  if (headerDocument?.id) {
    components.push({
      type: 'header',
      parameters: [{ type: 'document', document: { id: headerDocument.id, filename: headerDocument.filename } }],
    });
  }
  if (bodyParams.length) {
    components.push({ type: 'body', parameters: bodyParams.map((p) => ({ type: 'text', text: templateParam(p) })) });
  }
  return message(to, 'template', {
    name,
    language: { code: language },
    ...(components.length ? { components } : {}),
  });
}

/** A contact card: one tap to call or save the number. */
export function sendContact(to, { name, phone }) {
  return message(to, 'contacts', [{
    name: { formatted_name: String(name), first_name: String(name) },
    phones: [{ phone: String(phone), type: 'WORK' }],
  }]);
}

/**
 * Marks the client's message read (blue ticks) and, optionally, shows
 * "typing…" until we answer or 25 seconds pass. Quiet: a failure here
 * changes nothing the client is told.
 */
export function markRead(messageId, { typing = false } = {}) {
  if (!messageId) return Promise.resolve({ ok: false });
  return graph(`${config.whatsapp.phoneNumberId}/messages`, {
    quiet: true,
    json: {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: String(messageId),
      ...(typing ? { typing_indicator: { type: 'text' } } : {}),
    },
  });
}

/**
 * What Meta knows about a file a client sent: a download URL (valid for five
 * minutes), its type and its size. Asked before downloading, so an oversized
 * file costs one small call rather than the download.
 */
export async function mediaInfo(mediaId) {
  const query = config.whatsapp.phoneNumberId ? `?phone_number_id=${encodeURIComponent(config.whatsapp.phoneNumberId)}` : '';
  const res = await graph(`${encodeURIComponent(mediaId)}${query}`, { method: 'GET' });
  if (!res.ok) return res;
  return {
    ...res,
    url: res.body?.url ?? null,
    mimeType: res.body?.mime_type ?? null,
    size: Number(res.body?.file_size) || 0,
    sha256: res.body?.sha256 ?? null,
  };
}

/** The bytes behind a media URL. The token is required: without it Meta refuses. */
export async function download(url) {
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${config.whatsapp.token}` } });
    if (!res.ok) return { ok: false, status: res.status, error: `download failed: HTTP ${res.status}` };
    return { ok: true, status: res.status, buffer: Buffer.from(await res.arrayBuffer()) };
  } catch (err) {
    return { ok: false, status: 0, error: `download failed: ${err?.message}` };
  }
}

/**
 * A client's file, by media id.
 *
 * The URL a webhook or mediaInfo() hands over lasts five minutes; a file read
 * after a slow batch, or a retried claim, can find it expired (Meta answers
 * 404, sometimes 401/403). The URL is then asked for again, once - a second
 * failure is a real one and the caller tells the client.
 *
 * @param {string} mediaId
 * @param {{url?: string|null}} [known] a URL already in hand, tried first
 */
export async function downloadMedia(mediaId, { url = null } = {}) {
  let link = url;
  if (!link) {
    const info = await mediaInfo(mediaId);
    if (!info.ok || !info.url) return { ok: false, error: info.error ?? 'no URL for that media id', code: info.code ?? null };
    link = info.url;
  }

  let got = await download(link);
  if (!got.ok && [401, 403, 404, 410].includes(got.status)) {
    const fresh = await mediaInfo(mediaId);
    if (!fresh.ok || !fresh.url) return { ok: false, error: fresh.error ?? got.error, code: fresh.code ?? null };
    got = await download(fresh.url);
    if (got.ok) got.refetched = true;
  }
  return got;
}

/**
 * The phone number as Meta sees it, for /api/health?deep=1: proves the token
 * works and the number id is right without sending anybody anything.
 */
export function phoneNumberInfo() {
  if (!config.whatsapp.phoneNumberId) {
    return Promise.resolve({ ok: false, code: null, error: 'WHATSAPP_PHONE_NUMBER_ID is not set' });
  }
  return graph(`${config.whatsapp.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`, {
    method: 'GET', quiet: true,
  });
}
