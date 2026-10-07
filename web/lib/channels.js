/**
 * One way to say something to a client, whichever app they wrote from.
 *
 *   sendToChat({ channel, chatId, clientId }, message, opts)
 *
 * `message` is what the state machine produces - { text, inline?, keyboard?,
 * oneTime?, document? } - and the engine never learns which channel it went
 * out on. Telegram gets it exactly as lib/telegram.js always sent it. WhatsApp
 * cannot show an inline keyboard of any size, so the message is re-shaped for
 * it here (renderWhatsApp): three choices or fewer become reply buttons, four
 * to ten a list, more than that several lists; a body too long to carry
 * buttons goes first as text.
 *
 * WhatsApp also has a rule Telegram does not: a business may write freely only
 * within 24 hours of the client's last message (the customer service window).
 * Outside it only a template Meta has approved may be sent, and anything else
 * is refused with error 131047. So a WhatsApp send from the desk or the outbox
 * checks the window first, and outside it either sends the event's template or
 * reports `needs_template` - it never sends free text it knows will bounce.
 *
 * Every send is written to chat_messages (lib/chatlog.js), so the desk shows
 * the conversation the way the client saw it.
 *
 * Results are { ok, status, providerMessageId?, error?, code?, permanent? }
 * with status 'sent' | 'needs_template' | 'opted_out' | 'failed'.
 */

import { config, whatsappConfigured } from './config.js';
import * as telegram from './telegram.js';
import * as wa from './whatsapp.js';
import { logOutbound, isSchemaMissing } from './chatlog.js';
import { currentLanguage, normaliseLanguage, withLanguage } from './lang.js';
import { storedLanguage } from './flow/language.js';
import { sessionKey } from './flow/store.js';
import { S } from './flow/states.js';
import { settings } from './settings.js';
import { db } from './supabase.js';
import { defer, flush } from './background.js';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * A WhatsApp chat id is the client's number with a "wa:" in front. Telegram
 * chat ids are plain integers, and both live in the same chat_id columns: the
 * prefix is what keeps a WhatsApp number from ever being read as - and sent
 * to - a Telegram chat that happens to have the same digits.
 */
export const WHATSAPP_PREFIX = 'wa:';

export function whatsappChatId(waId) {
  const digits = String(waId ?? '').replace(/\D/g, '');
  return digits ? `${WHATSAPP_PREFIX}${digits}` : null;
}

/** The number to give Meta: the chat id without its prefix. Null for any other chat. */
export function waIdOf(chatId) {
  const s = String(chatId ?? '');
  if (!s.startsWith(WHATSAPP_PREFIX)) return null;
  const digits = s.slice(WHATSAPP_PREFIX.length).replace(/\D/g, '');
  return digits || null;
}

/** Which channel a chat id belongs to, for rows written without saying. */
export function channelOf(chatId, fallback = 'telegram') {
  return waIdOf(chatId) ? 'whatsapp' : fallback;
}

// ---------------------------------------------------------------------------
// Words the transports say themselves
// ---------------------------------------------------------------------------

const RULE = '━━━━━━━━━━━━';

/**
 * The half of a pair this conversation speaks. With no language chosen, the
 * `bilingual` form - by default the two halves stacked the way lib/flow
 * messages stack them - so a client who never chose sees what they always saw.
 */
export function phrase(ar, en, bilingual = null) {
  const lang = currentLanguage();
  if (lang === 'ar') return ar;
  if (lang === 'en') return en;
  return bilingual ?? `${ar}\n${RULE}\n${en}`;
}

const choosePrompt = () => phrase('اختار من هنا 👇', 'Choose an option 👇', 'اختار من هنا / Choose an option 👇');
const moreOptions = () => phrase('اختيارات تانية 👇', 'More options 👇', 'اختيارات تانية / More options 👇');
const listButton = () => phrase('اختار', 'Choose', 'اختار / Choose');
const sectionTitle = () => phrase('الاختيارات', 'Options', 'الاختيارات / Options');

// ---------------------------------------------------------------------------
// Rendering for WhatsApp
// ---------------------------------------------------------------------------

/** Meta's limits for the shapes used here. */
export const LIMITS = {
  text: 4096,
  // Lists accept a 4096-character body today, reply buttons 1024. One limit
  // for both keeps the rule simple and survives Meta tightening lists again.
  interactiveBody: 1024,
  buttons: 3,
  buttonTitle: 20,
  rows: 10,
  rowTitle: 24,
  rowDescription: 72,
  caption: 1024,
};

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Shortens a label to `max` characters without cutting a character in half.
 *
 * "Characters" here are UTF-16 code units - JavaScript's .length - which
 * counts an emoji as two. That is the strictest reading of Meta's limit, so a
 * title that passes here passes there whichever way Meta counts. The cut
 * falls between whole graphemes, so a keycap or a flag is kept or dropped
 * whole rather than left as a broken box.
 */
export function fitText(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  let out = '';
  for (const { segment } of graphemes.segment(s)) {
    if (out.length + segment.length > max - 1) break;
    out += segment;
  }
  return `${out.replace(/[\s/·,;:|–-]+$/u, '')}…`;
}

/** A cut that does not fall inside a grapheme, at or before `max`. */
function graphemeCut(text, max) {
  let at = 0;
  for (const { index, segment } of graphemes.segment(text)) {
    if (index + segment.length > max) break;
    at = index + segment.length;
  }
  return at || max;
}

/**
 * Splits text WhatsApp would refuse as one message: at a blank line where
 * there is one, else a line break, else a space - and only then mid-word.
 */
export function splitText(text, max = LIMITS.text) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  if (s.length <= max) return [s];
  const parts = [];
  let rest = s;
  while (rest.length > max) {
    const floor = Math.floor(max * 0.3);
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < floor) cut = rest.lastIndexOf('\n', max);
    if (cut < floor) cut = rest.lastIndexOf(' ', max);
    if (cut < floor) cut = graphemeCut(rest, max);
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

const ARABIC = /[؀-ۿݐ-ݿ]/;
const LATIN = /[A-Za-z]/;
// A leading emoji, keycap or symbol run - "📦 ", "1️⃣ ", "🧾 " - that both
// halves of a label share but only the first half carries.
const LEAD = /^((?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|[0-9#*]️?⃣|️|‍)+)\s*/u;

/**
 * The two halves of a bilingual button label, "📦 احجز شحنة / Book my shipment"
 * -> ["📦 احجز شحنة", "📦 Book my shipment"]; null when it is not one.
 */
export function labelHalves(text) {
  const s = String(text ?? '').trim();
  const at = s.indexOf(' / ');
  if (at === -1) return null;
  const ar = s.slice(0, at).trim();
  let en = s.slice(at + 3).trim();
  if (!ARABIC.test(ar) || !LATIN.test(en) || ARABIC.test(en)) return null;
  const lead = LEAD.exec(ar)?.[1];
  if (lead && !LEAD.test(en)) en = `${lead} ${en}`;
  return [ar, en];
}

/**
 * What a button says on WhatsApp. The engine gives every button a short,
 * one-language `title` (at most 20 characters, lib/flow/keyboards.js) and that
 * is what is shown. A button built without one has its label cut down here -
 * the half in the conversation's language, or the Arabic half when none was
 * chosen (house style puts Arabic first).
 *
 * `long` is the full label - both languages before a choice - which a list row
 * can show under its title.
 */
function labelFor(button, language) {
  const halves = labelHalves(button.text);
  const long = halves ? (language === 'en' ? halves[1] : language === 'ar' ? halves[0] : String(button.text).trim())
                      : String(button.text ?? '').trim();
  const short = button.title
    ? String(button.title).trim()
    : halves ? (language === 'en' ? halves[1] : halves[0]) : long;
  return { short, long };
}

/** A label without its leading emoji, for "does the long label add anything?". */
const bare = (text) => String(text ?? '').replace(LEAD, '').trim();

/** Flattens inline rows into one list of distinct buttons, ids unique. */
function flatten(inline) {
  const seen = new Set();
  const out = [];
  for (const b of (inline ?? []).flat()) {
    const id = b?.callback_data ?? b?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...b, id: String(id) });
  }
  return out;
}

/** Titles must differ within one message; a clash gets a number. */
function distinct(titles, max) {
  const used = new Set();
  return titles.map((t) => {
    let title = t;
    for (let n = 2; used.has(title); n++) title = fitText(`${fitText(t, max - 3)} ${n}`, max);
    used.add(title);
    return title;
  });
}

/**
 * The calls that carry one engine message on WhatsApp, in order. Pure: no
 * network, so the shape decisions are tested directly.
 *
 * @returns {Array<{type: 'text', body: string}
 *   | {type: 'buttons', body: string, buttons: Array<{id: string, title: string}>}
 *   | {type: 'list', body: string, button: string, sections: Array}
 *   | {type: 'document', buffer: Buffer, fileName: string, caption?: string}>}
 */
export function renderWhatsApp(message, { language = currentLanguage() } = {}) {
  return withLanguage(language, () => {
    const steps = [];
    if (message?.document?.buffer) {
      steps.push({
        type: 'document',
        buffer: message.document.buffer,
        fileName: message.document.fileName ?? 'document.pdf',
        caption: fitText(message.document.caption ?? '', LIMITS.caption),
        mimeType: message.document.mimeType ?? 'application/pdf',
      });
    }

    // A reply keyboard (Telegram's "Share my number") has no WhatsApp form,
    // and needs none: the sender's number arrives with every message.
    const text = String(message?.text ?? '').trim();
    const buttons = flatten(message?.inline);

    if (!buttons.length) {
      for (const part of splitText(text)) steps.push({ type: 'text', body: part });
      return steps;
    }

    // Buttons need a body, and one of at most 1024 characters. A longer text
    // - a review card, the documents checklist - is sent whole, and the
    // buttons follow under a short prompt.
    let body = text;
    if (!body || body.length > LIMITS.interactiveBody) {
      for (const part of splitText(text)) steps.push({ type: 'text', body: part });
      body = choosePrompt();
    }

    const labels = buttons.map((b) => labelFor(b, language));

    if (buttons.length <= LIMITS.buttons) {
      const titles = distinct(labels.map((l) => fitText(l.short, LIMITS.buttonTitle)), LIMITS.buttonTitle);
      steps.push({ type: 'buttons', body, buttons: buttons.map((b, i) => ({ id: b.id, title: titles[i] })) });
      return steps;
    }

    for (let start = 0; start < buttons.length; start += LIMITS.rows) {
      const chunk = buttons.slice(start, start + LIMITS.rows);
      const chunkLabels = labels.slice(start, start + LIMITS.rows);
      const titles = distinct(chunkLabels.map((l) => fitText(l.short, LIMITS.rowTitle)), LIMITS.rowTitle);
      const rows = chunk.map((b, i) => {
        // The row has room under its title for the full label - which is
        // where a title cut to fit, or the other language, goes. A label that
        // only repeats the title with an emoji in front is left off.
        const { long } = chunkLabels[i];
        const description = bare(long) && bare(long) !== bare(titles[i]) ? fitText(long, LIMITS.rowDescription) : '';
        return { id: b.id, title: titles[i], ...(description ? { description } : {}) };
      });
      steps.push({
        type: 'list',
        body: start === 0 ? body : moreOptions(),
        button: fitText(listButton(), 20),
        sections: [{ title: fitText(sectionTitle(), 24), rows }],
      });
    }
    return steps;
  });
}

// ---------------------------------------------------------------------------
// The 24-hour window
// ---------------------------------------------------------------------------

// Whether conversation_sessions.last_client_message_at exists. Learned once.
let windowColumn = null;

async function windowHours() {
  const value = Number((await settings()).whatsapp_window_hours);
  // Meta's window is 24 hours. A setting can shorten it for safety; it can
  // never stretch it, because Meta would refuse what we then sent.
  return value > 0 ? Math.min(value, 24) : 24;
}

/**
 * Is the customer service window open for this chat?
 *
 * @returns {Promise<{applies: boolean, open: boolean, lastClientMessageAt: string|null,
 *                    closesAt: string|null, known?: boolean}>}
 *   applies is false for Telegram and the web widget, which have no window.
 *   known is false when the column is missing or unreadable: open is then
 *   true, and Meta is the judge - a 131047 comes back and is handled.
 */
export async function windowState({ channel, chatId }) {
  const ch = channel ?? channelOf(chatId);
  if (ch !== 'whatsapp') return { applies: false, open: true, lastClientMessageAt: null, closesAt: null };

  const unknown = { applies: true, open: true, known: false, lastClientMessageAt: null, closesAt: null };
  if (windowColumn === false) return unknown;

  const [hours, read] = await Promise.all([
    windowHours(),
    db().from('conversation_sessions').select('last_client_message_at')
      .eq('id', sessionKey('whatsapp', chatId)).maybeSingle(),
  ]);
  if (read.error) {
    if (isSchemaMissing(read.error)) windowColumn = false;
    else console.error('window read failed:', read.error.message);
    return unknown;
  }
  windowColumn = true;

  const last = read.data?.last_client_message_at ? new Date(read.data.last_client_message_at) : null;
  if (!last || Number.isNaN(last.getTime())) {
    return { applies: true, open: false, known: true, lastClientMessageAt: null, closesAt: null };
  }
  const closes = new Date(last.getTime() + hours * 3_600_000);
  return {
    applies: true,
    open: closes.getTime() > Date.now(),
    known: true,
    lastClientMessageAt: last.toISOString(),
    closesAt: closes.toISOString(),
  };
}

/**
 * The client just wrote: the window opens (or stays open) from now.
 *
 * Called by the WhatsApp transport for every message a client sends. A first
 * message has no session row yet; one is created in the state every new
 * session starts in, which is what loadSession would have made of it anyway.
 */
export async function stampClientMessage({ channel = 'whatsapp', chatId, clientId = null }, at = new Date()) {
  if (windowColumn === false || chatId == null) return { ok: false, skipped: true };
  const id = sessionKey(channel, chatId);
  const when = at.toISOString();

  const updated = await db().from('conversation_sessions')
    .update({ last_client_message_at: when }).eq('id', id).select('id');
  if (updated.error) {
    if (isSchemaMissing(updated.error)) windowColumn = false;
    else console.error('window stamp failed:', updated.error.message);
    return { ok: false };
  }
  windowColumn = true;
  if (updated.data?.length) return { ok: true };

  // An insert, never an upsert: a turn running alongside this one may have
  // just written its state, and an upsert would put MAIN_MENU over it.
  const inserted = await db().from('conversation_sessions').insert({
    id, channel, chat_id: String(chatId), client_id: clientId,
    current_state: S.MAIN_MENU, context: {}, last_client_message_at: when,
  });
  if (!inserted.error) return { ok: true, created: true };
  if (inserted.error.code === '23505') {
    const again = await db().from('conversation_sessions').update({ last_client_message_at: when }).eq('id', id);
    return { ok: !again.error };
  }
  console.error('window stamp insert failed:', inserted.error.message);
  return { ok: false };
}

// ---------------------------------------------------------------------------
// Opt-out (STOP)
// ---------------------------------------------------------------------------

let optOutColumn = null;

/** When this WhatsApp client wrote STOP, or null. */
async function optedOutAt({ chatId, clientId }) {
  if (optOutColumn === false) return null;
  const query = db().from('clients').select('opted_out_at');
  const { data, error } = await (clientId ? query.eq('id', clientId) : query.eq('whatsapp_id', waIdOf(chatId))).maybeSingle();
  if (error) {
    if (isSchemaMissing(error)) optOutColumn = false;
    return null;
  }
  optOutColumn = true;
  return data?.opted_out_at ?? null;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * A template's language when the client never chose one. Arabic: the house
 * style leads with Arabic, and so do the bilingual messages these clients
 * have been reading.
 */
export const DEFAULT_TEMPLATE_LANGUAGE = 'ar';

/** The approved template for an event (bot_settings.whatsapp_templates), or null. */
export async function templateFor(eventType) {
  if (!eventType) return null;
  const map = (await settings()).whatsapp_templates;
  const entry = map && typeof map === 'object' ? map[eventType] : null;
  if (!entry?.name || entry.enabled === false) return null;
  return { params: [], ...entry };
}

/**
 * Where a template's named parameter is found in an outbox payload. The
 * template list names what the client reads ("reference", "what"); the
 * payloads were written before templates existed and say booking_ref,
 * requested, text.
 */
function aliases(name, language) {
  switch (name) {
    case 'reference': return ['reference', 'booking_ref', 'shipment_id', 'ticket_ref', 'request_ref', 'mrn_number'];
    case 'what': return language === 'ar' ? ['what', 'requested_ar', 'requested'] : ['what', 'requested', 'requested_ar'];
    case 'message': return ['message', 'text'];
    case 'update': return ['update', 'text', 'status'];
    case 'staff_name': return ['staff_name', 'name'];
    default: return [name];
  }
}

/** The body parameters, in the template's order, from the payload. */
export function templateParams(template, payload = {}, language = DEFAULT_TEMPLATE_LANGUAGE) {
  return (template?.params ?? []).map((name) => {
    for (const key of aliases(name, language)) {
      const value = payload?.[key];
      if (value !== null && value !== undefined && String(value).trim() !== '') return wa.templateParam(value);
    }
    return '—';
  });
}

/** "en"/"ar", or the code a template was approved under ("en_US"). */
function templateLanguage(template, language) {
  return template?.languages?.[language] ?? language;
}

async function recipientLanguage(target) {
  try {
    return await storedLanguage({ channel: 'whatsapp', chatId: target.chatId, clientId: target.clientId ?? null });
  } catch {
    return null;
  }
}

async function sendTemplateMessage(target, template, { payload = {}, document = null, language = null, ...log } = {}) {
  const to = waIdOf(target.chatId);
  const lang = normaliseLanguage(language) ?? DEFAULT_TEMPLATE_LANGUAGE;
  const params = templateParams(template, payload, lang);

  let headerDocument = null;
  if (template.header === 'document') {
    if (!document?.buffer) {
      return { ok: false, status: 'failed', error: `template ${template.name} needs a document`, permanent: true };
    }
    const uploaded = await wa.uploadMedia(document.buffer, {
      mimeType: document.mimeType ?? 'application/pdf', fileName: document.fileName ?? 'document.pdf',
    });
    if (!uploaded.ok || !uploaded.id) return failedFrom(uploaded, target, log, { kind: 'template' });
    headerDocument = { id: uploaded.id, filename: document.fileName ?? 'document.pdf' };
  }

  const sent = await wa.sendTemplate(to, {
    name: template.name, language: templateLanguage(template, lang), bodyParams: params, headerDocument,
  });
  const body = `[${template.name}] ${params.join(' · ')}`.trim();
  if (!sent.ok) {
    // Not approved (yet), or not in this language: the message waits for the
    // client to write, as if no template were configured.
    if (sent.code === wa.TEMPLATE_MISSING) {
      return { ok: false, status: 'needs_template', code: sent.code, templateName: template.name,
        error: `template ${template.name} is not approved in "${templateLanguage(template, lang)}" (132001)` };
    }
    return failedFrom(sent, target, log, { kind: 'template', body, templateName: template.name });
  }
  record(target, { ...log, kind: 'template', body, language: lang,
    payload: { template: template.name, params, ...(headerDocument ? { document: headerDocument.filename } : {}) },
    providerMessageId: sent.id });
  return { ok: true, status: 'sent', providerMessageId: sent.id, templateName: template.name };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** The chat log, written in the background - a reply never waits on it. */
function record(target, entry) {
  defer(logOutbound({
    channel: target.channel,
    chatId: target.chatId,
    clientId: target.clientId ?? null,
    author: entry.author ?? 'bot',
    staffName: entry.staffName ?? null,
    kind: entry.kind ?? 'text',
    body: entry.body ?? null,
    payload: entry.payload ?? {},
    language: entry.language ?? currentLanguage(),
    bookingRef: entry.bookingRef ?? null,
    providerMessageId: entry.providerMessageId ?? null,
    status: entry.status ?? 'sent',
    error: entry.error ?? null,
  }));
}

function failedFrom(res, target, log, extra = {}) {
  const error = res?.error ?? 'WhatsApp refused the message';
  record(target, { ...log, ...extra, status: 'failed', error: res?.code ? `${res.code}: ${error}` : error });
  return {
    ok: false,
    status: 'failed',
    error: res?.code ? `${error} (${res.code})` : error,
    code: res?.code ?? null,
    permanent: wa.isPermanentError(res?.code),
    rateLimited: wa.isRateLimited(res?.code),
    ...(extra.templateName ? { templateName: extra.templateName } : {}),
  };
}

/** Telegram refuses these for good; retrying is how an outbox becomes a load. */
const TELEGRAM_PERMANENT = /bot was blocked|user is deactivated|chat not found|bot can't initiate|CHAT_WRITE_FORBIDDEN/i;

async function sendTelegram(target, message, opts) {
  // The outbox's tests hand in a transport that fails on demand; everything
  // else uses the real one.
  const send = opts.transport?.send ?? telegram.sendMessage;
  const sendFile = opts.transport?.sendFile ?? telegram.sendDocument;
  const log = { author: opts.author, staffName: opts.staffName, bookingRef: opts.bookingRef, language: opts.language };
  // Telegram message ids count up per chat, so two chats share every id; the
  // chat goes in front to make the id unique in chat_messages.
  const providerId = (sent) => (sent?.result?.message_id != null ? `${target.chatId}:${sent.result.message_id}` : null);

  try {
    if (message.document?.buffer) {
      const { buffer, fileName, caption } = message.document;
      // sendDocument throws when Telegram refuses, so reaching the next line
      // means the file went.
      const sent = await sendFile(target.chatId, buffer, fileName, caption);
      const id = providerId(sent);
      record(target, { ...log, kind: 'document', body: caption ?? null, payload: { file_name: fileName }, providerMessageId: id });
      return { ok: true, status: 'sent', providerMessageId: id };
    }

    // returnMessage, because sendMessage LOGS a refusal and resolves anyway:
    // without reading ok back, an undelivered message would count as sent.
    const sent = await send(target.chatId, message.text, {
      inline: message.inline,
      keyboard: message.keyboard,
      oneTime: message.oneTime ?? false,
      removeKeyboard: message.removeKeyboard ?? false,
      returnMessage: true,
    });
    const buttons = (message.inline ?? []).flat().map((b) => ({ id: b.callback_data, text: b.text }));
    if (!sent?.ok) {
      const error = sent?.description || `Telegram refused the message (${sent?.error_code ?? 'no response'})`;
      record(target, { ...log, body: message.text, payload: buttons.length ? { buttons } : {}, status: 'failed', error });
      return { ok: false, status: 'failed', error, code: sent?.error_code ?? null, permanent: TELEGRAM_PERMANENT.test(error) };
    }
    const id = providerId(sent);
    record(target, { ...log, body: message.text, payload: buttons.length ? { buttons } : {}, providerMessageId: id });
    return { ok: true, status: 'sent', providerMessageId: id };
  } catch (err) {
    const error = err?.message ?? 'Telegram send failed';
    record(target, { ...log, kind: message.document ? 'document' : 'text', body: message.document?.caption ?? message.text, status: 'failed', error });
    return { ok: false, status: 'failed', error, permanent: TELEGRAM_PERMANENT.test(error) };
  }
}

async function sendSteps(target, steps, log) {
  const to = waIdOf(target.chatId);
  const ids = [];
  for (const step of steps) {
    let res;
    let entry;
    if (step.type === 'text') {
      res = await wa.sendText(to, step.body);
      entry = { kind: 'text', body: step.body };
    } else if (step.type === 'buttons') {
      res = await wa.sendButtons(to, step.body, step.buttons);
      entry = { kind: 'buttons', body: step.body, payload: { buttons: step.buttons } };
    } else if (step.type === 'list') {
      res = await wa.sendList(to, step.body, { button: step.button, sections: step.sections });
      entry = { kind: 'list', body: step.body, payload: { button: step.button, rows: step.sections.flatMap((s) => s.rows) } };
    } else if (step.type === 'document') {
      res = await wa.sendDocument(to, step);
      entry = { kind: 'document', body: step.caption || null, payload: { file_name: step.fileName } };
    } else {
      continue;
    }
    if (!res.ok) return { ...failedFrom(res, target, log, entry), providerMessageIds: ids };
    ids.push(res.id);
    record(target, { ...log, ...entry, providerMessageId: res.id });
  }
  return { ok: true, status: 'sent', providerMessageId: ids[ids.length - 1] ?? null, providerMessageIds: ids };
}

async function sendWhatsApp(target, message, opts) {
  if (!whatsappConfigured()) return { ok: false, status: 'failed', error: 'WhatsApp is not configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID)' };
  if (!waIdOf(target.chatId)) return { ok: false, status: 'failed', error: `not a WhatsApp chat: ${target.chatId}`, permanent: true };

  const author = opts.author ?? 'bot';
  const log = { author, staffName: opts.staffName, bookingRef: opts.bookingRef, language: opts.language };
  const proactive = author !== 'bot' && !opts.answering;

  // The bot answering a message the client has just sent is inside the window
  // by definition, and is never "proactive". Everything else checks.
  const window = proactive || opts.checkWindow ? await windowState(target) : { open: true };

  // STOP means nothing proactive - unless they have written to us since, in
  // which case a reply to that is what they asked for.
  if (proactive) {
    const stoppedAt = await optedOutAt(target);
    if (stoppedAt) {
      const wroteSince = window.lastClientMessageAt && new Date(window.lastClientMessageAt) > new Date(stoppedAt);
      if (!(window.open && wroteSince)) {
        return { ok: false, status: 'opted_out', error: `The client wrote STOP on ${String(stoppedAt).slice(0, 10)}` };
      }
    }
  }

  // A row held because Meta said the window was closed stays closed until the
  // client writes again, whatever our own clock says.
  let open = window.open;
  if (open && opts.closedUnlessClientWroteAfter) {
    open = Boolean(window.lastClientMessageAt)
      && new Date(window.lastClientMessageAt) >= new Date(opts.closedUnlessClientWroteAfter);
  }

  if (!open) return viaTemplate(target, message, opts, log);

  const sent = await sendSteps(target, renderWhatsApp(message, { language: opts.language }), log);
  // Our clock said open; Meta says closed. Meta decides.
  if (!sent.ok && sent.code === wa.WINDOW_CLOSED && !sent.providerMessageIds?.length) {
    return viaTemplate(target, message, opts, log);
  }
  return sent;
}

async function viaTemplate(target, message, opts, log) {
  const closed = { ok: false, status: 'needs_template', error: 'The 24-hour WhatsApp window is closed' };
  if (!opts.allowTemplate) return closed;
  const template = await templateFor(opts.eventType);
  if (!template) return { ...closed, error: `${closed.error} and no template is configured for ${opts.eventType ?? 'this message'}` };
  const language = normaliseLanguage(opts.language) ?? (await recipientLanguage(target)) ?? DEFAULT_TEMPLATE_LANGUAGE;
  return sendTemplateMessage(target, template, {
    payload: opts.payload ?? {}, document: message?.document ?? null, language, ...log,
  });
}

/**
 * Sends one engine message to a client, on their channel.
 *
 * @param {{channel?: string, chatId: string|number, clientId?: number|null}} target
 * @param {{text?: string, inline?: Array, keyboard?: Array, oneTime?: boolean,
 *          document?: {buffer: Buffer, fileName: string, caption?: string}}} message
 * @param {{author?: 'bot'|'staff'|'system', staffName?: string, bookingRef?: string,
 *          language?: 'en'|'ar'|null, eventType?: string, allowTemplate?: boolean,
 *          payload?: object, answering?: boolean}} [opts]
 *   author     who is speaking. 'bot' is the transport answering the client's
 *              own message - inside the window, never blocked by STOP.
 *   allowTemplate  outside the WhatsApp window, send the event's approved
 *              template (filled from `payload`) instead of reporting
 *              needs_template.
 *   answering  this message answers something the client did (their PDF
 *              after they confirmed): sent even after STOP.
 * @returns {Promise<{ok: boolean, status: 'sent'|'needs_template'|'opted_out'|'failed',
 *                    providerMessageId?: string|null, error?: string, code?: number|null,
 *                    permanent?: boolean, templateName?: string}>}
 */
export async function sendToChat(target, message, opts = {}) {
  const chatId = target?.chatId;
  if (chatId === null || chatId === undefined || chatId === '') {
    return { ok: false, status: 'failed', error: 'no chat to send to', permanent: true };
  }
  const channel = target.channel ?? channelOf(chatId);
  const language = normaliseLanguage(opts.language) ?? currentLanguage();
  const resolved = { channel, chatId, clientId: target.clientId ?? null };
  const options = { ...opts, author: opts.author ?? 'bot', language };

  let result;
  if (channel === 'telegram') result = await sendTelegram(resolved, message ?? {}, options);
  else if (channel === 'whatsapp') result = await withLanguage(language, () => sendWhatsApp(resolved, message ?? {}, options));
  // The web widget is answered in the HTTP response; there is nothing to push to.
  else return { ok: false, status: 'failed', error: `cannot send to a ${channel} chat`, permanent: true };

  // The bot's replies leave their chat-log rows to be written in the
  // background - the transports wait for them before answering. A person at
  // the desk is answered by a route that knows nothing of that, and the row is
  // what their screen shows next, so it is written before this returns.
  if (options.author === 'staff') await flush();
  return result;
}

/**
 * The "please reply so we can continue" template, for a person at the desk
 * who needs to reach a client whose window has closed. Their reply reopens the
 * window and the conversation carries on as free text.
 */
export async function sendReopenTemplate(target, { staffName = null, language = null } = {}) {
  const resolved = { channel: 'whatsapp', chatId: target?.chatId, clientId: target?.clientId ?? null };
  if (!waIdOf(resolved.chatId)) return { ok: false, status: 'failed', error: 'only WhatsApp chats have a window to reopen', permanent: true };
  if (!whatsappConfigured()) return { ok: false, status: 'failed', error: 'WhatsApp is not configured' };

  const stoppedAt = await optedOutAt(resolved);
  if (stoppedAt) return { ok: false, status: 'opted_out', error: `The client wrote STOP on ${String(stoppedAt).slice(0, 10)}` };

  const template = await templateFor('_reopen');
  if (!template) return { ok: false, status: 'failed', error: 'No "_reopen" template is configured in whatsapp_templates' };

  const lang = normaliseLanguage(language) ?? (await recipientLanguage(resolved)) ?? DEFAULT_TEMPLATE_LANGUAGE;
  return withLanguage(lang, () => sendTemplateMessage(resolved, template, {
    payload: { staff_name: staffName, company: config.companyName },
    language: lang,
    author: staffName ? 'staff' : 'system',
    staffName,
  }));
}

/** For tests: forget what was learned about the schema. */
export function resetChannelsForTests() {
  windowColumn = null;
  optOutColumn = null;
}
