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
import { fingerprint, userVersion, ROLE_WORDS, ROLE_CAN, refuseStale, invalidateTeam, hasAccountColumns } from './desk-shared.js';
import { hashPassword, passwordProblem, normaliseUsername, usernameProblem, MIN_PASSWORD } from './desk-auth.js';
import { DEFAULT_SAVED_REPLIES } from './desk-messages.js';

// A CMR is deliberately not here: MKY issues its own, and one from a customer
// is proof the truck reached the port - never a condition of booking.
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

/**
 * The number .env.example and this page's own hint used to show as an
 * illustration. The bot refuses to read it out (lib/settings.js), so saving it
 * here would look set and behave as unset - refused instead, saying why.
 */
const digitsOf = (v) => String(v).replace(/\D/g, '');
const isExampleNumber = (v) => digitsOf(v) === digitsOf('+20 3 555 0143');
const EXAMPLE_REFUSED = 'That is the example number from the setup notes, not a real line. Type the number customers should call.';

/**
 * The direct line the setup seeded as a placeholder, which the tests and the
 * docs use. It is a well-formed number, so it is not refused, and it may be
 * live - so it is not changed either. The desk says what it looks like
 * instead: in the live test an urgent customer was told to ring it.
 */
const SEEDED_EXAMPLES = ['+48 512 345 678'];
const looksSeeded = (v) => Boolean(v) && SEEDED_EXAMPLES.some((e) => digitsOf(v) === digitsOf(e));
const SEEDED_WARNING = 'This looks like the example number from the setup (+48 512 345 678), not a real line - '
  + 'urgent customers after hours are told to ring it. Type the responsible person’s own number, or clear it.';

/** What the screen should point out about these values, without refusing them. */
function warningsFor(values) {
  const out = {};
  for (const key of ['direct_phone', 'operations_phone']) {
    if (looksSeeded(values[key])) out[key] = SEEDED_WARNING;
  }
  return out;
}

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
    if (isExampleNumber(s)) return { error: EXAMPLE_REFUSED };
    return isPhone(s) ? { value: s } : { error: 'The direct line must be a phone number, with the country code.' };
  },
  operations_phone: (v) => {
    const s = String(v ?? '').trim();
    if (!s) return { value: null };
    if (isExampleNumber(s)) return { error: EXAMPLE_REFUSED };
    return isPhone(s) ? { value: s } : { error: 'The desk number must be a phone number, with the country code.' };
  },
  required_booking_documents: (v) => docList(v, { allowMrn: true }),
  required_booking_documents_mky_mrn: (v) => docList(v, { allowMrn: false }),
  custom_documents: (v) => customDocs(v),
  acid_required: (v) => (typeof v === 'boolean' ? { value: v } : { error: 'Choose yes or no.' }),
  whatsapp_window_hours: (v) => (Number(v) > 0 && Number(v) <= 24 ? { value: Number(v) } : { error: 'WhatsApp’s window is at most 24 hours.' }),
  whatsapp_templates: (v) => templates(v),
  saved_replies: (v) => replies(v),
};

async function docList(v, { allowMrn }) {
  if (!Array.isArray(v)) return { error: 'Choose the documents from the list.' };
  const list = [...new Set(v.map(String))];
  const known = await knownDocTypes();
  const bad = list.filter((t) => !known.includes(t));
  if (bad.length) return { error: `Unknown document type: ${bad.join(', ')}.` };
  if (!allowMrn && list.includes('mrn')) return { error: 'When MKY obtains the MRN the customer cannot be asked to send one.' };
  return { value: list };
}

/** The five the system knows, plus whatever Operations has added themselves. */
async function knownDocTypes() {
  const cfg = await settings().catch(() => ({}));
  const custom = Array.isArray(cfg.custom_documents) ? cfg.custom_documents : [];
  return [...DOC_TYPES, ...custom.map((d) => String(d?.key ?? '')).filter(Boolean)];
}

/**
 * Papers Operations adds themselves: a packing list, a power of attorney,
 * whatever this lane turns out to need.
 *
 * The key is made from the label and then never changes, because it is what
 * the required lists and every document row already filed under it hold.
 * Renaming the label renames what the customer is asked for; it does not
 * orphan the papers that came in under the old name.
 */
function customDocs(v) {
  if (!Array.isArray(v)) return { error: 'The extra documents must be a list.' };
  if (v.length > 12) return { error: 'Twelve extra documents is as many as a customer will read.' };
  const out = [];
  const seen = new Set();
  for (const item of v) {
    const label = String(item?.label ?? '').trim().replace(/\s+/g, ' ');
    if (!label) return { error: 'Every extra document needs a name.' };
    if (label.length > 40) return { error: `“${label.slice(0, 20)}…” is too long a name - keep it under 40 characters.` };
    const key = String(item?.key ?? '').trim() || slug(label);
    if (!key) return { error: `“${label}” has no letters or numbers in it to make a name from.` };
    if (DOC_TYPES.includes(key) || key === 'cmr' || key === 'other' || key === 'mky') {
      return { error: `“${label}” is one the system already knows. Tick it in the list instead.` };
    }
    if (seen.has(key)) return { error: `“${label}” is in the list twice.` };
    seen.add(key);
    out.push({ key, label });
  }
  return { value: out };
}

/** A key out of a label: lower case, words joined by underscores. */
const slug = (label) => String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);

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
    warnings: warningsFor(values),
    template_events: TEMPLATE_EVENTS.map((e) => ({ event: e, words: TEMPLATE_WORDS[e] })),
    // Each type with the words the desk shows for it, so a document Operations
    // added themselves is drawn exactly like the five that came with the
    // system - and the screen never has to know which is which.
    document_types: [
      ...DOC_TYPES.map((key) => ({ key, label: null, custom: false })),
      ...(Array.isArray(values.custom_documents) ? values.custom_documents : [])
        .map((d) => ({ key: d.key, label: d.label, custom: true })),
    ],
    users: (users ?? []).map(userOut),
    roles: ROLES.map((r) => ({ role: r, words: ROLE_WORDS[r], can: ROLE_CAN[r] })),
    // Whether this database has the per-person sign-in columns yet - read from
    // the rows just fetched. False between the code reaching Vercel and the
    // migration being applied, and the screen says so rather than offering a
    // password box that cannot save.
    accounts: hasAccountColumns(users),
    min_password: MIN_PASSWORD,
  });
}

const userOut = (u) => ({
  name: u.name, role: u.role, role_words: ROLE_WORDS[u.role] ?? u.role, active: u.active !== false,
  email: u.email ?? null, last_seen: u.last_seen ?? null, version: userVersion(u),
  // The sign-in name, and whether a password of their own has been set -
  // never the hash, which has no reason to leave the server.
  username: u.username ?? null,
  has_password: Boolean(u.password_hash),
  password_set_at: u.password_set_at ?? null,
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
    // Some rules read the settings (a required list is checked against the
    // extra documents that exist), so every rule is awaited.
    const out = await rule(changes[key]);
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
  return res.status(200).json({ ok: true, saved: keys, warnings: warningsFor(clean) });
}

/** Enough of a value to read in the audit trail; the trail is not a backup. */
const summarise = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 300 ? `${s.slice(0, 300)}…` : s;
};

/**
 * POST { action: 'user_save', name, role, active, username?, password?, version? }
 *
 * Adds a person or changes one. Refuses anything that would leave the desk
 * without an active administrator - including an administrator demoting or
 * switching off themselves - because nobody could then undo it from here.
 *
 * A new person is given a username and a password here, so that adding
 * somebody is one form and not three: they can sign in the moment the
 * administrator reads the password out to them. Changing an existing person's
 * password is its own action (set_password), because it ends their sessions.
 */
export async function userSave(req, res, who) {
  const name = String(req.body?.name ?? '').trim().slice(0, 80);
  const role = String(req.body?.role ?? 'ops_agent');
  const active = req.body?.active !== false;
  if (name.length < 2) return res.status(400).json({ error: 'A name needs at least two letters.' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Choose a role from the list.' });

  const { data: all } = await db().from('ops_users').select('*');
  const everyone = all ?? [];
  const existing = everyone.find((u) => u.name.toLowerCase() === name.toLowerCase()) ?? null;

  if (existing && req.body?.version && req.body.version !== userVersion(existing)) {
    return refuseStale(res, { entityIds: [`user:${existing.name}`], current: userVersion(existing) });
  }

  const adminsAfter = everyone.filter((u) => u.active !== false && u.role === 'admin'
    && u.name.toLowerCase() !== name.toLowerCase()).length + (active && role === 'admin' ? 1 : 0);
  if (adminsAfter === 0) {
    return res.status(409).json({ error: 'The desk needs at least one active administrator. Make someone else an administrator first.' });
  }

  // The sign-in name. Given, or made from the name the obvious way; either
  // way it is checked against everybody else's before it is written.
  const accounts = hasAccountColumns(everyone);
  const credentials = {};
  if (accounts) {
    const asked = String(req.body?.username ?? '').trim();
    const username = normaliseUsername(asked || (existing?.username ? '' : name));
    if (asked) {
      const problem = usernameProblem(asked);
      if (problem) return res.status(400).json({ error: problem });
    }
    if (username) {
      const taken = everyone.find((u) => u.username && normaliseUsername(u.username) === username
        && u.name.toLowerCase() !== name.toLowerCase());
      if (taken) return res.status(409).json({ error: `“${username}” is already ${taken.name}’s username. Choose another.` });
      if (username !== (existing?.username ?? null)) credentials.username = username;
    }

    const password = req.body?.password == null ? '' : String(req.body.password);
    if (password) {
      if (existing?.password_hash) {
        return res.status(400).json({ error: `${existing.name} already has a password. Use “Set password” to change it.` });
      }
      const problem = passwordProblem(password);
      if (problem) return res.status(400).json({ error: problem });
      credentials.password_hash = await hashPassword(password);
      credentials.password_set_at = new Date().toISOString();
    }
  }

  const row = existing
    ? { name: existing.name, role, active, ...credentials }
    : { name, role, active, created_by: who.name, ...credentials };
  const { data, error } = await db().from('ops_users').upsert(row, { onConflict: 'name' }).select().single();
  invalidateTeam();
  if (error) return res.status(500).json({ error: 'We could not save that person.' });

  await audit({
    actor_type: 'operator', actor_id: who.name, action: 'ops_user_saved',
    entity_type: 'ops_user', entity_id: `user:${data.name}`,
    metadata: {
      name: data.name, role, active, username: data.username ?? null,
      password_set: Boolean(credentials.password_hash),
      was: existing ? `${existing.role}${existing.active === false ? ' (inactive)' : ''}` : 'new',
    },
  });
  return res.status(200).json({ ok: true, user: userOut(data), accounts });
}

/**
 * POST { action: 'bootstrap_admin', operator } - only while nobody is active.
 *
 * A brand-new desk has no administrator to add the first person, so the first
 * person adds themselves - once. After that the door is shut.
 */
export async function bootstrapAdmin(req, res) {
  const name = String(req.auth?.name ?? req.body?.operator ?? '').trim().slice(0, 80);
  if (name.length < 2) return res.status(400).json({ error: 'Type your name first.' });
  const { data: all, error } = await db().from('ops_users').select('name, active');
  if (error) return res.status(500).json({ error: 'We could not read the team list.' });
  if ((all ?? []).some((u) => u.active !== false)) {
    return res.status(409).json({ error: 'The team already has people. Ask an administrator to add you.' });
  }
  const { error: insErr } = await db().from('ops_users').upsert({ name, role: 'admin', active: true, created_by: name }, { onConflict: 'name' });
  invalidateTeam();
  if (insErr) return res.status(500).json({ error: 'We could not add you.' });
  await audit({ actor_type: 'operator', actor_id: name, action: 'ops_user_saved', entity_type: 'ops_user', entity_id: `user:${name}`, metadata: { name, role: 'admin', was: 'bootstrap' } });
  return res.status(200).json({ ok: true, name, role: 'admin' });
}
