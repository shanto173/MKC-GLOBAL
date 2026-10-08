/**
 * Business values that MKY may change without a deployment.
 *
 * The rule this file exists to serve: the application must never invent a
 * customs requirement, a phone number or a document list. Anything of that kind
 * is read from `bot_settings`, falls back to an environment variable, and if
 * neither is set the caller is told it is unknown rather than given a guess.
 *
 * Cached per warm serverless instance for a minute. Longer would mean an
 * operator changing a setting waits for a cold start to see it; shorter would
 * mean a database round trip on every message.
 */

import { db } from './supabase.js';
import { config } from './config.js';

const TTL_MS = 60_000;

let cache = null;
let cachedAt = 0;
let inflight = null;

/** Defaults used only when the settings row is absent (e.g. before migration 008). */
const FALLBACK = {
  required_booking_documents: ['invoice', 'brief', 'mrn'],
  required_booking_documents_mky_mrn: ['invoice', 'brief'],
  required_mrn_documents: [],
  acid_required: false,
  allow_submit_while_mrn_pending: true,
  allowed_file_types: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'],
  max_upload_bytes: 20 * 1024 * 1024,
  draft_expiry_hours: 72,
  operations_phone: null,
  operations_email: null,
  human_support_hours: null,
  // The direct line for anything that cannot wait until the desk opens. Null
  // means none is read out - a client is never given an invented number.
  direct_phone: null,
  // When a person answers: from 9 in the morning until 7 in the evening, Cairo
  // time. Outside that the bot says when the desk is back.
  support_hours_start: 9,
  support_hours_end: 19,
  support_timezone: 'Africa/Cairo',
};

/** The number .env.example used to ship as an illustration. Never read out. */
const PLACEHOLDER_PHONE = '+20 3 555 0143';

/**
 * A number fit to give a customer, or null. Blank is not a number, and neither
 * is the illustration, however it is spaced: a deployment that copied
 * .env.example once still has it in its environment.
 */
function realPhone(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const digits = (v) => String(v).replace(/\D/g, '');
  return digits(s) === digits(PLACEHOLDER_PHONE) ? null : s;
}

async function load() {
  const { data, error } = await db().from('bot_settings').select('key, value');
  if (error) {
    // A settings outage must not take the bot down: the fallbacks are the
    // behaviour the code had before this table existed.
    console.error('bot_settings read failed, using fallbacks:', error.message);
    return { ...FALLBACK };
  }
  const table = { ...FALLBACK };
  for (const row of data ?? []) {
    if (row.value === null) continue;   // an explicit null means "not set here"
    table[row.key] = row.value;
  }
  return table;
}

/** All settings, cached. */
export async function settings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < TTL_MS) return cache;
  // Several messages arriving together must not each start their own read.
  if (!inflight) {
    inflight = load()
      .then((table) => {
        cache = table;
        cachedAt = Date.now();
        return table;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export async function setting(key) {
  const table = await settings();
  return table[key] ?? FALLBACK[key] ?? null;
}

/** Drops the cache, so a write is visible to this instance immediately. */
export function invalidateSettings() {
  cache = null;
  cachedAt = 0;
}

export async function writeSetting(key, value, { operator = 'operations', note = null } = {}) {
  const patch = { key, value, updated_at: new Date().toISOString(), updated_by: operator };
  if (note !== null) patch.note = note;
  const { error } = await db().from('bot_settings').upsert(patch, { onConflict: 'key' });
  if (error) return { ok: false, error: error.message };
  invalidateSettings();
  return { ok: true };
}

/**
 * The number a client is given when they ask for a person.
 *
 * Order: what Operations set in the desk's Settings (bot_settings
 * operations_phone), then the environment - OPERATIONS_PHONE, then
 * COMPANY_PHONE, the same chain config used to follow. Nothing is invented:
 * with none of them set, `phone` is null, `configured` is false, and every
 * caller says what the bot can do instead of reading out a number.
 */
export async function operationsContact() {
  const table = await settings();
  const phone = realPhone(table.operations_phone)
    ?? realPhone(process.env.OPERATIONS_PHONE)
    ?? realPhone(process.env.COMPANY_PHONE);
  const email = table.operations_email || config.mail.opsEmail || process.env.COMPANY_EMAIL || '';
  // The direct line, for a client who asks for a person after hours and says
  // it is urgent. Its own setting, because the number the boss hands out for
  // that is not necessarily the desk's; it falls back to the desk's number.
  const direct = realPhone(table.direct_phone) ?? realPhone(process.env.DIRECT_PHONE) ?? phone;
  return {
    phone,
    email: email || null,
    hours: table.human_support_hours || null,
    // Reading the .env.example illustration out to a customer is worse than
    // saying we cannot connect them right now.
    configured: Boolean(phone),
    directPhone: direct,
  };
}

/**
 * The company's number as printed on paperwork - the booking PDF, the label.
 * The desk's Settings first, so changing the number there changes the next PDF
 * too; then COMPANY_PHONE, then OPERATIONS_PHONE. Null when none is set: the
 * footer then simply has no number, rather than one nobody answers.
 */
export async function companyPhone() {
  const table = await settings();
  return realPhone(table.operations_phone)
    ?? realPhone(process.env.COMPANY_PHONE)
    ?? realPhone(process.env.OPERATIONS_PHONE);
}

/**
 * Is somebody at the desk right now?
 *
 * The rule MKY gave, in two numbers: agents answer from 9 in the morning until
 * 7 in the evening, Cairo time. Outside that the bot says so, says when they
 * are back, and gives the direct number for anything that cannot wait.
 *
 * Both hours and the timezone live in bot_settings so the desk can move them
 * without a deployment. A value that is not a whole hour, or a timezone the
 * runtime does not know, falls back to the default rather than closing the
 * desk by accident.
 *
 * @param {{now?: Date}} [opts] the clock, injectable so a test can be "after 7 PM"
 */
export async function supportHours({ now } = {}) {
  const table = await settings();
  const start = wholeHour(table.support_hours_start, FALLBACK.support_hours_start);
  const end = wholeHour(table.support_hours_end, FALLBACK.support_hours_end);
  const timezone = knownTimezone(table.support_timezone) ?? FALLBACK.support_timezone;
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const hour = hourIn(at, timezone);

  // A desk that closes after midnight (say 20 to 4) wraps around.
  const open = start < end ? hour >= start && hour < end : hour >= start || hour < end;

  return { open, start, end, timezone, hour };
}

function wholeHour(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
}

function knownTimezone(tz) {
  if (!tz || typeof tz !== 'string') return null;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** The hour of the day, 0-23, that `date` is in the given timezone. */
function hourIn(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  return Number.isInteger(hour) ? hour % 24 : date.getUTCHours();
}

/**
 * Which document types this booking needs from the client.
 *
 * Depends on who is obtaining the MRN: a client who has asked MKY to get one
 * cannot be asked to send it. ACID is only added when MKY has confirmed it is
 * required at booking time.
 */
export async function requiredDocuments({ mrnChoice = 'existing' } = {}) {
  const table = await settings();
  const base = mrnChoice === 'mky_issue'
    ? table.required_booking_documents_mky_mrn
    : table.required_booking_documents;
  const list = Array.isArray(base) ? [...base] : [];
  if (table.acid_required === true && !list.includes('acid')) list.push('acid');
  return list;
}
