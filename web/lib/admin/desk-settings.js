/**
 * Settings and the team, for administrators.
 *
 * Every value here changes what the bot tells customers - when the desk is
 * open, which number to ring, which papers to send - so every write is
 * validated against a rule written down here, refused with a sentence when it
 * breaks it, checked against the version the administrator was looking at, and
 * recorded in the audit trail with what it was before.
 *
 * Nothing is accepted that the code reading it would choke on: a bot that
 * reads "9am" where it expects 9 does not crash, it silently closes the desk.
 */

import { db } from '../supabase.js';
import { settings, writeSetting, invalidateSettings } from '../settings.js';
import { audit } from '../audit.js';
import { fingerprint, userVersion, ROLE_WORDS, refuseStale } from './desk-shared.js';
import { DEFAULT_SAVED_REPLIES } from './desk-messages.js';

const DOC_TYPES = ['invoice', 'brief', 'mrn', 'acid', 'eur1'];
const ROLES = ['ops_agent', 'ops_supervisor', 'admin', 'read_only'];

/** Outbox events a WhatsApp template can carry, as the migration seeded them. */
const TEMPLATE_EVENTS = [
  'booking_confirmed', 'booking_confirmed_pdf', 'booking_rejected', 'missing_information_requested',
  'document_rejected', 'shipment_update', 'operations_message', 'ticket_resolved', '_reopen',
];
const TEMPLATE_WORDS = {
  booking_confirmed: 'Booking confirmed',
  booking_confirmed_pdf: 'Booking confirmation PDF',
  booking_rejected: 'Booking rejected',
  missing_information_requested: 'We need information',
  document_rejected: 'Send a new document',
  shipment_update: 'Shipment update',
  operations_message: 'Message from the team',
  ticket_resolved: 'Request resolved',
  _reopen: '“Please reply” (reopens the conversation)',
};

const isPhone = (v) => /^\+?[\d\s().-]{7,25}$/.test(v) && v.replace(/\D/g, '').length >= 7;

function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}

/**
 * The settings this screen edits, each with the rule a value must pass.
 * A validator returns { value } to store, or { error } to show.
 */
const RULES = {
  support_hours_start: (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 23 && String(v).trim() !== ''
    ? { value: Number(v) } : { error: 'Opening hour is a whole hour from 0 to 23.' }),
  support_hours_end: (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 23 && String(v).trim() !== ''
    ? { value: Number(v) } : { error: 'Closing hour is a whole hour from 0 to 23.' }),
  support_timezone: (v) => (typeof v === 'string' && validTimezone(v.trim()) ? { value: v.trim() } : { error: 'That is not a timezone we know, e.g. Africa/Cairo.' }),
  human_support_hours: (v) => {
    const s = String(v ?? '').trim();
    if (s.length > 200) return { error: 'Keep the opening-hours sentence under 200 characters.' };
    return { value: s || null };
  },
  direct_phone: (v) => {
    const s = String(v ?? '').trim();
    if (!s) return { value: null };
    return isPhone(s) ? { value: s } : { error: 'The direct line must be a phone number, e.g. +20 100 555 1234.' };
  },
  operations_phone: (v) => {
    const s = String(v ?? '').trim();
    if (!s) return { value: null };
    return isPhone(s) ? { value: s } : { error: 'The desk number must be a phone number, e.g. +20 3 555 0143.' };
  },
  required_booking_documents: (v) => docList(v, { allowMrn: true }),
  required_booking_documents_mky_mrn: (v) => docList(v, { allowMrn: false }),
  acid_required: (v) => (typeof v === 'boolean' ? { value: v } : { error: 'Choose yes or no.' }),
  whatsapp_window_hours: (v) => (Number(v) > 0 && Number(v) <= 24 ? { value: Number(v) } : { error: 'WhatsApp’s window is at most 24 hours.' }),
  whatsapp_templates: (v) => templates(v),
  saved_replies: (v) => replies(v),
};

function docList(v, { allowMrn }) {
  if (!Array.isArray(v)) return { error: 'Choose the documents from the list.' };
  const list = [...new Set(v.map(String))];
  const bad = list.filter((t) => !DOC_TYPES.includes(t));
  if (bad.length) return { error: `Unknown document type: ${bad.join(', ')}.` };
  if (!allowMrn && list.includes('mrn')) return { error: 'When MKY obtains the MRN the customer cannot be asked to send one.' };
  return { value: list };
}

function templates(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'Templates must be a list of events and names.' };
  const out = {};
  for (const [event, t] of Object.entries(v)) {
    if (!TEMPLATE_EVENTS.includes(event)) return { error: `Unknown message type “${event}”.` };
    const name = String(t?.name ?? '').trim();
    if (!name) continue;   // an empty name means "no template for this event"
    if (!/^[a-z0-9_]{1,512}$/.test(name)) {
      return { error: `“${name}” is not a valid template name: WhatsApp allows lowercase letters, digits and underscores.` };
    }
    const params = Array.isArray(t.params) ? t.params.map(String).filter((p) => /^[a-z_]{1,40}$/.test(p)).slice(0, 10) : [];
    out[event] = { name, params, ...(t.header === 'document' ? { header: 'document' } : {}) };
  }
  return { value: out };
}

function replies(v) {
  if (!Array.isArray(v)) return { error: 'Saved replies must be a list.' };
  if (v.length > 30) return { error: 'Keep it to 30 saved replies or fewer.' };
  const out = [];
  for (const r of v) {
    const title = String(r?.title ?? '').trim();
    const en = String(r?.en ?? '').trim();
    const ar = String(r?.ar ?? '').trim();
    if (!title && !en && !ar) continue;
    if (!title) return { error: 'Every saved reply needs a short title.' };
    if (title.length > 40) return { error: `“${title.slice(0, 20)}…” — keep titles under 40 characters.` };
    if (!en && !ar) return { error: `“${title}” needs the text in at least one language.` };
    if (en.length > 1000 || ar.length > 1000) return { error: `“${title}” is too long (1000 characters per language).` };
    out.push({ title, en, ar });
  }
  return { value: out };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** GET view=settings - everything the Settings screen edits, with each value's version. */
export async function settingsView(req, res) {
  const cfg = await settings({ fresh: true });
  const { data: rows } = await db().from('bot_settings').select('key, updated_at, updated_by');
  const meta = new Map((rows ?? []).map((r) => [r.key, r]));

  const values = {};
  const versions = {};
  const changed = {};
  for (const key of Object.keys(RULES)) {
    values[key] = cfg[key] ?? null;
    versions[key] = fingerprint({ v: cfg[key] ?? null, u: meta.get(key)?.updated_at ?? null });
    const m = meta.get(key);
    changed[key] = m?.updated_by ? { by: m.updated_by, at: m.updated_at } : null;
  }
  if (!Array.isArray(values.saved_replies) || !values.saved_replies.length) values.saved_replies = DEFAULT_SAVED_REPLIES;

  const { data: users } = await db().from('ops_users').select('*').order('name');
  return res.status(200).json({
    values,
    versions,
    changed,
    template_events: TEMPLATE_EVENTS.map((e) => ({ event: e, words: TEMPLATE_WORDS[e] })),
    document_types: DOC_TYPES,
    users: (users ?? []).map(userOut),
    roles: ROLES.map((r) => ({ role: r, words: ROLE_WORDS[r] })),
  });
}

const userOut = (u) => ({
  name: u.name, role: u.role, role_words: ROLE_WORDS[u.role] ?? u.role, active: u.active !== false,
  email: u.email ?? null, last_seen: u.last_seen ?? null, version: userVersion(u),
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * POST { action: 'settings_write', changes: { key: value }, versions: { key: version } }
 *
 * All or nothing: one invalid value refuses the whole save, so a form never
 * half-applies and leaves the bot with opening hours from two different edits.
 */
export async function settingsWrite(req, res, who) {
  const changes = req.body?.changes ?? {};
  const seen = req.body?.versions ?? {};
  const keys = Object.keys(changes);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to save.' });

  const errors = {};
  const clean = {};
  for (const key of keys) {
    const rule = RULES[key];
    if (!rule) { errors[key] = 'This setting cannot be changed here.'; continue; }
    const out = rule(changes[key]);
    if (out.error) errors[key] = out.error; else clean[key] = out.value;
  }
  if ('support_hours_start' in clean || 'support_hours_end' in clean) {
    const cfg = await settings({ fresh: true });
    const start = clean.support_hours_start ?? cfg.support_hours_start;
    const end = clean.support_hours_end ?? cfg.support_hours_end;
    if (Number(start) === Number(end)) errors.support_hours_end = 'Opening and closing hour cannot be the same.';
  }
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Some values need fixing.', errors });

  // Stale check: somebody else saved one of these keys since this form loaded.
  const cfg = await settings({ fresh: true });
  const { data: rows } = await db().from('bot_settings').select('key, updated_at, updated_by').in('key', keys);
  const meta = new Map((rows ?? []).map((r) => [r.key, r]));
  for (const key of keys) {
    const current = fingerprint({ v: cfg[key] ?? null, u: meta.get(key)?.updated_at ?? null });
    if (seen[key] && seen[key] !== current) {
      const m = meta.get(key);
      return res.status(409).json({
        error: `${m?.updated_by ?? 'Somebody'} changed “${key.replace(/_/g, ' ')}” since you opened this page. It now shows the latest.`,
        stale: true,
      });
    }
  }

  for (const key of keys) {
    const before = cfg[key] ?? null;
    const saved = await writeSetting(key, clean[key], { operator: who.name });
    if (!saved.ok) return res.status(500).json({ error: `We could not save “${key.replace(/_/g, ' ')}”.` });
    await audit({
      actor_type: 'operator', actor_id: who.name, action: 'setting_changed',
      entity_type: 'bot_setting', entity_id: key,
      metadata: { setting: key, from: summarise(before), to: summarise(clean[key]) },
    });
  }
  invalidateSettings();
  return res.status(200).json({ ok: true, saved: keys });
}

/** Enough of a value to read in the audit trail; the trail is not a backup. */
const summarise = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 300 ? `${s.slice(0, 300)}…` : s;
};

/**
 * POST { action: 'user_save', name, role, active, version? }
 *
 * Adds a person or changes one. Refuses anything that would leave the desk
 * without an active administrator - including an administrator demoting or
 * switching off themselves - because nobody could then undo it from here.
 */
export async function userSave(req, res, who) {
  const name = String(req.body?.name ?? '').trim().slice(0, 80);
  const role = String(req.body?.role ?? 'ops_agent');
  const active = req.body?.active !== false;
  if (name.length < 2) return res.status(400).json({ error: 'A name needs at least two letters.' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Choose a role from the list.' });

  const { data: all } = await db().from('ops_users').select('*');
  const existing = (all ?? []).find((u) => u.name.toLowerCase() === name.toLowerCase()) ?? null;

  if (existing && req.body?.version && req.body.version !== userVersion(existing)) {
    return refuseStale(res, { entityIds: [`user:${existing.name}`], current: userVersion(existing) });
  }

  const adminsAfter = (all ?? []).filter((u) => u.active !== false && u.role === 'admin'
    && u.name.toLowerCase() !== name.toLowerCase()).length + (active && role === 'admin' ? 1 : 0);
  if (adminsAfter === 0) {
    return res.status(409).json({ error: 'The desk needs at least one active administrator. Make someone else an administrator first.' });
  }

  const row = existing
    ? { name: existing.name, role, active }
    : { name, role, active, created_by: who.name };
  const { data, error } = await db().from('ops_users').upsert(row, { onConflict: 'name' }).select().single();
  if (error) return res.status(500).json({ error: 'We could not save that person.' });

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'ops_user_saved',
    entity_type: 'ops_user', entity_id: `user:${data.name}`,
    metadata: { name: data.name, role, active, was: existing ? `${existing.role}${existing.active === false ? ' (inactive)' : ''}` : 'new' },
  });
  return res.status(200).json({ ok: true, user: userOut(data) });
}

/**
 * POST { action: 'bootstrap_admin', operator } - only while nobody is active.
 *
 * A brand-new desk has no administrator to add the first person, so the first
 * person adds themselves - once. After that the door is shut.
 */
export async function bootstrapAdmin(req, res) {
  const name = String(req.body?.operator ?? '').trim().slice(0, 80);
  if (name.length < 2) return res.status(400).json({ error: 'Type your name first.' });
  const { data: all, error } = await db().from('ops_users').select('name, active');
  if (error) return res.status(500).json({ error: 'We could not read the team list.' });
  if ((all ?? []).some((u) => u.active !== false)) {
    return res.status(409).json({ error: 'The team already has people. Ask an administrator to add you.' });
  }
  const { error: insErr } = await db().from('ops_users').upsert({ name, role: 'admin', active: true, created_by: name }, { onConflict: 'name' });
  if (insErr) return res.status(500).json({ error: 'We could not add you.' });
  await audit({ actor_type: 'operator', actor_id: name, action: 'ops_user_saved', entity_type: 'ops_user', entity_id: `user:${name}`, metadata: { name, role: 'admin', was: 'bootstrap' } });
  return res.status(200).json({ ok: true, name, role: 'admin' });
}
