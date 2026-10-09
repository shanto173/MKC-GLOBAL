/**
 * Settings - for administrators. The team, when the desk is open and which
 * number to give, the papers a booking needs, WhatsApp templates and the saved
 * replies everybody uses.
 *
 * Each card saves on its own, so changing the opening hours never resubmits a
 * template someone else is editing. The server checks every value and sends
 * back a sentence per field; those sentences appear beside the field.
 *
 * Nothing typed is lost by walking away: a card with unsaved changes says so
 * beside its Save button, saving one card leaves the others' edits where they
 * are, and leaving the page asks first (unsaved(), asked by app.js). Each card
 * says who last changed it, and saves against the versions it was drawn from,
 * so a colleague's change in the meantime is refused, not overwritten.
 */

import {
  h, icon, api, post, toast, toastError, badge, avatar, emptyState, errorState, skeleton, session, ago, add, fill, PURPOSE,
} from './ui.js';
import { infoDot, glossaryList } from './glossary.js';

/** The groups, in the owner's words (docs/DESK-REDESIGN-PROMPT.md, section 10): id, title, icon. */
export const SECTIONS = [
  ['team', 'Team and access', 'users'],
  ['hours', 'Office hours and contact numbers', 'hours'],
  ['docs', 'Required documents', 'file'],
  ['whatsapp', 'WhatsApp messaging', 'whatsapp'],
  ['replies', 'Saved replies', 'reply'],
  ['glossary', 'Glossary', 'note'],
];
/** The settings each group saves, for "last changed by". (The team is people, not settings.) */
export const SECTION_KEYS = {
  hours: ['support_hours_start', 'support_hours_end', 'support_timezone', 'human_support_hours', 'direct_phone', 'operations_phone'],
  docs: ['required_booking_documents', 'required_booking_documents_mky_mrn', 'acid_required'],
  whatsapp: ['whatsapp_templates', 'whatsapp_window_hours'],
  replies: ['saved_replies'],
};
/** The newest change among these settings: { by, at }, or null when none is recorded. */
export function lastChange(changed, keys) {
  let newest = null;
  for (const k of keys) {
    const c = changed?.[k];
    if (c?.at && (!newest || new Date(c.at) > new Date(newest.at))) newest = c;
  }
  return newest;
}
const titleOf = (id) => SECTIONS.find(([k]) => k === id)?.[1] ?? id;

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const hourWords = (n) => `${String(n).padStart(2, '0')}:00`;
const DOC_WORDS = { invoice: 'Invoice', brief: 'Brief (CMR / transport document)', mrn: 'MRN document', acid: 'ACID certificate', eur1: 'EUR.1 certificate' };
const TIMEZONES = ['Africa/Cairo', 'Europe/Vilnius', 'Europe/Berlin', 'Europe/London', 'Asia/Dubai', 'UTC'];
/** The fields the server may warn about, as a sentence names them. */
const FIELD_WORDS = { direct_phone: 'direct line', operations_phone: 'desk number' };

export function renderSettings({ main }) {
  if (!session.can('settings')) {
    add(main, emptyState('Only an administrator can change settings.', 'Ask an administrator if something here needs changing.', null, { icon: 'lock', tone: 'locked' }));
    return null;
  }
  const root = h('div', { class: 'settings' }, h('div'), h('div', { class: 'settings-body' }, skeleton(6, { kind: 'cards' })));
  add(main,
    h('div', { class: 'page-head' }, h('div', {},
      h('h1', {}, 'Settings'),
      h('p', { class: 'page-sub' }, PURPOSE.settings, ' ', h('span', { class: 'page-sub-more' }, 'Changes reach the bot within a minute. Every change is recorded with your name.')))),
    root);

  let data = null;
  let spy = null;
  let body = null;
  const dirty = new Set();     // the cards with changes not saved yet
  const markers = {};          // card id -> its "Unsaved changes" tag

  /** A card's edits since it was drawn: said beside its Save button, and asked about on leaving. */
  function watch(id, el) {
    const mark = () => touched(id);
    el.addEventListener('input', mark);
    el.addEventListener('change', mark);
  }
  function touched(id) {
    if (dirty.has(id)) return;
    dirty.add(id);
    if (markers[id]) markers[id].hidden = false;
  }
  const unsavedTag = (id) => {
    markers[id] = h('span', { class: 'unsaved-tag', role: 'status', hidden: !dirty.has(id) }, icon('pencil', { size: 13 }), 'Unsaved changes');
    return markers[id];
  };

  async function load() {
    try {
      data = await api({ view: 'settings' });
    } catch (err) {
      fill(root, h('div'), h('div', { class: 'settings-body' }, errorState(err, () => load())));
      return;
    }
    // The sections, always in reach on the left; the one in view is marked.
    const links = {};
    const nav = h('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' },
      SECTIONS.map(([id, label, ic]) => {
        links[id] = h('a', { href: '#/settings', onclick: (e) => { e.preventDefault(); document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } },
          icon(ic, { size: 16 }), label);
        return links[id];
      }));
    // A card with unsaved edits stays exactly as it is: saving one card
    // never wipes what somebody is typing in another.
    const make = { team: teamCard, hours: hoursCard, docs: docsCard, whatsapp: whatsappCard, replies: repliesCard, glossary: glossaryCard };
    const drawn = body ? Object.fromEntries([...body.children].map((c) => [c.id.replace(/^set-/, ''), c])) : {};
    body = h('div', { class: 'settings-body' }, SECTIONS.map(([id]) => (dirty.has(id) && drawn[id] ? drawn[id] : make[id]())));
    fill(root, nav, body);
    spy?.disconnect();
    if ('IntersectionObserver' in window) {
      spy = new IntersectionObserver((entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (!top) return;
        const id = top.target.id.replace(/^set-/, '');
        for (const [k, a] of Object.entries(links)) a.setAttribute('aria-current', k === id ? 'true' : 'false');
      }, { rootMargin: '-80px 0px -55% 0px' });
      for (const c of body.children) spy.observe(c);
    }
  }

  /**
   * Saves one card's settings against the versions the card was drawn from -
   * a colleague's change since is refused, not overwritten - shows each
   * field's error beside it, and reloads.
   */
  async function save(id, card, changes, button, drawnVersions) {
    for (const el of card.querySelectorAll('.field-error')) { el.hidden = true; el.textContent = ''; }
    const versions = Object.fromEntries(Object.keys(changes).map((k) => [k, drawnVersions[k]]));
    button.disabled = true;
    const before = button.textContent;
    button.textContent = 'Saving…';
    try {
      const r = await post({ action: 'settings_write', changes, versions });
      dirty.delete(id);
      // Saved, but worth a second look: the server points out a value that
      // looks like a placeholder without refusing it. The page reloads with
      // the same warnings beside their fields.
      const warned = Object.keys(r.warnings ?? {}).filter((k) => FIELD_WORDS[k]);
      if (warned.length) {
        const one = warned.length === 1;
        toast(`Saved — but the ${warned.map((k) => FIELD_WORDS[k]).join(' and the ')} still ${one ? 'looks' : 'look'} like the setup’s example number. See the note under ${one ? 'it' : 'them'}.`, 'warn');
      } else {
        toast(`${titleOf(id)} saved. The bot uses it within a minute.`);
      }
      await load();
    } catch (err) {
      if (err.data?.errors) {
        for (const [k, msg] of Object.entries(err.data.errors)) {
          const slot = card.querySelector(`[data-error-for="${k}"]`);
          if (slot) { slot.textContent = msg; slot.hidden = false; } else toast(msg, 'bad');
        }
        card.querySelector('.field-error:not([hidden])')?.scrollIntoView({ block: 'center' });
      } else {
        toastError(err);
        // Changed by a colleague meanwhile: the card shows the latest (the
        // toast says so), so its edits are no longer what would be saved.
        if (err.data?.stale) { dirty.delete(id); await load(); }
      }
    } finally {
      if (button.isConnected) { button.disabled = false; button.textContent = before; }
    }
  }

  const errorSlot = (key) => h('p', { class: 'field-error', 'data-error-for': key, role: 'alert', hidden: true });
  /** "Last changed by Sara 2 h ago", for a whole card. */
  const changedBy = (id) => {
    const c = lastChange(data.changed, SECTION_KEYS[id] ?? []);
    return h('span', { class: 'muted small changed-by' }, c ? `Last changed by ${c.by} ${ago(c.at)}` : 'Not changed on the desk yet');
  };
  /** The row under a card: its Save button, whether it has unsaved changes, and who changed it last. */
  const actions = (id, ...buttons) => h('div', { class: 'form-actions' }, ...buttons, unsavedTag(id), SECTION_KEYS[id] ? changedBy(id) : null);
  const card = (id, title, sub, ...children) => h('section', { class: 'card', id: `set-${id}`, 'aria-labelledby': `set-${id}-t` },
    h('div', { class: 'card-head' }, h('h2', { id: `set-${id}-t` }, icon(SECTIONS.find(([k]) => k === id)?.[2] ?? 'settings', { size: 17 }), title), sub ? h('p', { class: 'card-sub' }, sub) : null),
    ...children);

  // -- team -------------------------------------------------------------------
  function teamCard() {
    // Unsaved here: a row whose role or sign-in was changed, or a name typed to add.
    const rowsChanged = new Set();
    const name = h('input', { class: 'input', id: 'new-name', placeholder: 'Name as they will type it', autocomplete: 'off' });
    const recheck = () => {
      if (rowsChanged.size || name.value.trim()) touched('team');
      else { dirty.delete('team'); if (markers.team) markers.team.hidden = true; }
    };
    name.addEventListener('input', recheck);
    const rows = data.users.map((u) => {
      const role = h('select', { class: 'input input-small', 'aria-label': `Role for ${u.name}` },
        data.roles.map((r) => h('option', { value: r.role, selected: r.role === u.role }, r.words)));
      const active = h('input', { type: 'checkbox', checked: u.active, 'aria-label': `${u.name} can sign in` });
      const saveBtn = h('button', { class: 'btn btn-sm btn-primary', type: 'button', hidden: true }, 'Save');
      const changed = () => {
        saveBtn.hidden = role.value === u.role && active.checked === u.active;
        if (saveBtn.hidden) rowsChanged.delete(u.name); else rowsChanged.add(u.name);
        recheck();
      };
      role.addEventListener('change', changed);
      active.addEventListener('change', changed);
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
          await post({ action: 'user_save', name: u.name, role: role.value, active: active.checked, version: u.version });
          toast(`${u.name} updated.`);
          dirty.delete('team');
          await load();
        } catch (err) {
          toastError(err);
          saveBtn.disabled = false;
        }
      });
      return h('tr', { class: u.active ? '' : 'is-inactive' },
        h('th', { scope: 'row' }, h('span', { class: 'team-name' }, avatar(u.name), h('span', {}, u.name, u.name === session.name ? h('span', { class: 'muted small' }, ' (you)') : null))),
        h('td', { 'data-label': 'Role' }, role),
        h('td', { 'data-label': 'Can sign in' }, h('label', { class: 'check' }, active, u.active ? badge('Active', 'green', { small: true }) : badge('Switched off', 'gray', { small: true }))),
        h('td', { class: 'muted small' }, u.last_seen ? `Seen ${ago(u.last_seen)}` : 'Not seen yet'),
        h('td', {}, saveBtn));
    });

    const role = h('select', { class: 'input', id: 'new-role' }, data.roles.map((r) => h('option', { value: r.role, selected: r.role === 'ops_agent' }, r.words)));
    const add = h('form', { class: 'inline-form' },
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'new-name' }, 'Add a person'), name),
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'new-role' }, 'Role'), role),
      h('button', { class: 'btn', type: 'submit' }, icon('plus', { size: 14 }), 'Add'));
    add.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (name.value.trim().length < 2) return toast('Type their name first.', 'info');
      try {
        await post({ action: 'user_save', name: name.value.trim(), role: role.value, active: true });
        toast(`${name.value.trim()} can now sign in with the desk password.`);
        dirty.delete('team');
        await load();
      } catch (err) {
        toastError(err);
      }
    });

    return card('team', titleOf('team'), 'Who can sign in, and what each role can do. The server enforces these; this list says what they mean. Everyone signs in with their name and the desk password.',
      // What each role can do, from the server (lib/admin/desk-shared.js ROLE_CAN, beside what it enforces).
      h('dl', { class: 'roles' }, data.roles.map((r) => [h('dt', {}, r.words), h('dd', {}, r.can ?? '')])),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table table-plain team-table' },
        h('thead', {}, h('tr', {}, ['Name', 'Role', 'Can sign in', 'Last seen', ''].map((c) => h('th', { scope: 'col' }, c)))),
        h('tbody', {}, rows))),
      add,
      h('div', { class: 'form-actions' }, unsavedTag('team')));
  }

  // -- hours and phone ----------------------------------------------------------
  function hoursCard() {
    const v = data.values;
    const start = h('select', { class: 'input', id: 's-start' }, HOURS.map((n) => h('option', { value: n, selected: Number(v.support_hours_start) === n }, hourWords(n))));
    const end = h('select', { class: 'input', id: 's-end' }, HOURS.map((n) => h('option', { value: n, selected: Number(v.support_hours_end) === n }, hourWords(n))));
    const tz = h('input', { class: 'input', id: 's-tz', value: v.support_timezone ?? 'Africa/Cairo', list: 'tz-list' });
    const sentence = h('input', { class: 'input', id: 's-sentence', value: v.human_support_hours ?? '', placeholder: 'Sunday to Thursday, 9:00–19:00 Cairo time' });
    const direct = h('input', { class: 'input', id: 's-direct', value: v.direct_phone ?? '', inputmode: 'tel', placeholder: 'With the country code, +20…' });
    const desk = h('input', { class: 'input', id: 's-desk', value: v.operations_phone ?? '', inputmode: 'tel', placeholder: 'With the country code, +20…' });
    const button = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save office hours and numbers');
    const drawnVersions = data.versions;
    const c = card('hours', titleOf('hours'), 'When a person answers, and the numbers the bot gives out. Outside these hours, a customer who asks for a person is asked whether it is urgent; if it is, the bot gives them the direct line.');
    const form = h('form', {},
      h('datalist', { id: 'tz-list' }, TIMEZONES.map((t) => h('option', { value: t }))),
      h('div', { class: 'form-grid' },
        fieldWith('Opens at', start, 's-start', 'support_hours_start'),
        fieldWith('Closes at', end, 's-end', 'support_hours_end'),
        fieldWith('Timezone', tz, 's-tz', 'support_timezone'),
        fieldWith('Opening hours, as the customer reads them', sentence, 's-sentence', 'human_support_hours', h('span', { class: 'muted small' }, 'Example: Sunday to Thursday, 9:00–19:00 Cairo time.'))),
      h('div', { class: 'form-grid' },
        fieldWith('Direct line (urgent, after hours)', direct, 's-direct', 'direct_phone', h('span', { class: 'muted small' }, 'Leave empty and the bot gives no number after hours.')),
        fieldWith('Desk number', desk, 's-desk', 'operations_phone', h('span', { class: 'muted small' }, 'Given to customers who ask for a person, and printed on their booking PDF. Leave empty and the bot gives no number.'))),
      actions('hours', button));
    watch('hours', form);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      save('hours', c, {
        support_hours_start: Number(start.value), support_hours_end: Number(end.value), support_timezone: tz.value.trim(),
        human_support_hours: sentence.value, direct_phone: direct.value, operations_phone: desk.value,
      }, button, drawnVersions);
    });
    add(c, form);
    return c;
  }

  // -- documents -----------------------------------------------------------------
  function docsCard() {
    const v = data.values;
    const list = (key, label, allowMrn) => {
      const chosen = new Set(v[key] ?? []);
      return h('fieldset', { class: 'checks' }, h('legend', { class: 'label' }, label),
        // The info dot sits beside the label, not in it: a tap on it must not tick the box.
        data.document_types.filter((t) => allowMrn || t !== 'mrn').map((t) => h('span', { class: 'check-row' }, h('label', { class: 'check' },
          h('input', { type: 'checkbox', name: key, value: t, checked: chosen.has(t) }), h('span', {}, DOC_WORDS[t] ?? t)), infoDot(t))),
        errorSlot(key));
    };
    const acid = h('input', { type: 'checkbox', id: 's-acid', checked: v.acid_required === true });
    const button = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save required documents');
    const drawnVersions = data.versions;
    const c = card('docs', titleOf('docs'), 'What the bot asks every customer for, and what the case page checks before a booking can be confirmed. Nothing is required that is not ticked. The two lists differ by who provides the MRN: a customer with their own MRN sends the MRN document; when MKY gets the MRN for them, it is not asked for.');
    const form = h('form', {},
      h('div', { class: 'form-grid' },
        list('required_booking_documents', 'When the customer has their own MRN', true),
        list('required_booking_documents_mky_mrn', 'When MKY gets the MRN for them', false)),
      h('span', { class: 'check-row' }, h('label', { class: 'check', for: 's-acid' }, acid, h('span', {}, 'An ACID certificate is required at booking time')), infoDot('acid')),
      errorSlot('acid_required'),
      actions('docs', button));
    watch('docs', form);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const picked = (k) => [...form.querySelectorAll(`input[name="${k}"]:checked`)].map((i) => i.value);
      save('docs', c, {
        required_booking_documents: picked('required_booking_documents'),
        required_booking_documents_mky_mrn: picked('required_booking_documents_mky_mrn'),
        acid_required: acid.checked,
      }, button, drawnVersions);
    });
    add(c, form);
    return c;
  }

  // -- WhatsApp ---------------------------------------------------------------
  function whatsappCard() {
    const v = data.values;
    const templates = v.whatsapp_templates ?? {};
    const inputs = {};
    const rows = data.template_events.map(({ event, words }) => {
      const t = templates[event] ?? {};
      inputs[event] = h('input', { class: 'input mono input-small', value: t.name ?? '', 'aria-label': `Template for ${words}`, placeholder: 'not set', spellcheck: 'false' });
      return h('tr', {},
        h('th', { scope: 'row' }, words),
        h('td', {}, inputs[event]),
        h('td', { class: 'muted small' }, (t.params ?? []).length ? (t.params ?? []).join(', ') : '—'));
    });
    const hours = h('input', { class: 'input input-small input-narrow', id: 's-window', type: 'number', min: '1', max: '24', value: v.whatsapp_window_hours ?? 24 });
    const button = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save WhatsApp messaging');
    const drawnVersions = data.versions;
    const c = card('whatsapp', titleOf('whatsapp'),
      'After 24 hours without a message from the customer, WhatsApp delivers only approved templates. Templates are written and approved in WhatsApp Manager, not here: this page only names which approved template the bot uses for each message. Names must match WhatsApp Manager exactly; the same name is used in English and Arabic.');
    const form = h('form', {},
      h('div', { class: 'table-wrap' }, h('table', { class: 'table table-plain template-table' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Message'), h('th', { scope: 'col' }, 'Template name'), h('th', { scope: 'col' }, 'Filled with'))),
        h('tbody', {}, rows))),
      errorSlot('whatsapp_templates'),
      fieldWith('Hours the window stays open', hours, 's-window', 'whatsapp_window_hours', h('span', { class: 'muted small' }, 'WhatsApp’s own limit is 24 hours. A smaller number makes the desk switch to templates sooner; nothing here can make the window longer.')),
      actions('whatsapp', button));
    watch('whatsapp', form);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const next = {};
      for (const { event } of data.template_events) {
        const name = inputs[event].value.trim();
        if (name) next[event] = { ...(templates[event] ?? {}), name };
      }
      save('whatsapp', c, { whatsapp_templates: next, whatsapp_window_hours: Number(hours.value) }, button, drawnVersions);
    });
    add(c, form);
    return c;
  }

  // -- saved replies -------------------------------------------------------------
  function repliesCard() {
    let list = (data.values.saved_replies ?? []).map((r) => ({ ...r }));
    const holder = h('div', { class: 'replies' });
    const button = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save replies');
    const drawnVersions = data.versions;
    const c = card('replies', titleOf('replies'), 'Ready-made answers in the composer. Each is inserted in the customer’s language, and can be changed before it is sent. Example: “Documents received” — “Thank you, we have your documents and are checking them.”');

    const paint = () => {
      fill(holder, ...list.map((r, i) => {
        const title = h('input', { class: 'input', value: r.title, 'aria-label': `Title of reply ${i + 1}`, maxlength: '40' });
        const en = h('textarea', { class: 'input', rows: '2', dir: 'ltr', 'aria-label': `English text of reply ${i + 1}` });
        en.value = r.en;
        const ar = h('textarea', { class: 'input', rows: '2', dir: 'rtl', lang: 'ar', 'aria-label': `Arabic text of reply ${i + 1}` });
        ar.value = r.ar;
        title.addEventListener('input', () => { r.title = title.value; });
        en.addEventListener('input', () => { r.en = en.value; });
        ar.addEventListener('input', () => { r.ar = ar.value; });
        return h('div', { class: 'reply-edit' },
          h('div', { class: 'reply-edit-head' }, title,
            h('button', { class: 'btn btn-ghost btn-sm btn-danger-ghost', type: 'button', onclick: () => { list.splice(i, 1); paint(); touched('replies'); } }, 'Remove')),
          h('div', { class: 'form-grid' },
            h('div', { class: 'field' }, h('span', { class: 'label' }, 'English'), en),
            h('div', { class: 'field' }, h('span', { class: 'label' }, 'Arabic'), ar)));
      }));
    };
    paint();
    const form = h('form', {}, holder, errorSlot('saved_replies'),
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => { list.push({ title: '', en: '', ar: '' }); paint(); touched('replies'); holder.lastChild?.querySelector('input')?.focus(); } }, icon('plus', { size: 14 }), 'Add a reply'),
        button, unsavedTag('replies'), changedBy('replies')));
    watch('replies', form);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      list = list.filter((r) => r.title.trim() || r.en.trim() || r.ar.trim());
      save('replies', c, { saved_replies: list }, button, drawnVersions);
    });
    add(c, form);
    return c;
  }

  // -- glossary -------------------------------------------------------------------
  /** The words of the trade, as every info dot on the desk explains them. Edited in public/desk/glossary.js. */
  function glossaryCard() {
    return card('glossary', 'Glossary', 'What the info dots beside VIN, MRN, ACID, EUR.1 and CMR say. Everyone can open this list from their account menu.', glossaryList());
  }

  /**
   * A field: its label, the control, a hint, the server's warning about the
   * value it holds (saved, but worth a second look) and the slot for an error.
   */
  function fieldWith(label, input, id, key, hint = null) {
    const warning = data.warnings?.[key];
    const warn = warning ? h('p', { class: 'field-warning', id: `${id}-warn`, role: 'status' }, icon('alert', { size: 14 }), h('span', {}, warning)) : null;
    if (warn) {
      input.setAttribute('aria-describedby', `${id}-warn`);
      input.classList.add('is-warned');
    }
    return h('div', { class: 'field' }, h('label', { class: 'label', for: id }, label), input, warn, hint, errorSlot(key));
  }

  load();
  return {
    dispose() { spy?.disconnect(); },
    // Asked by app.js before leaving: the cards with changes not saved yet.
    unsaved: () => SECTIONS.filter(([id]) => dirty.has(id)).map(([, label]) => label),
  };
}
