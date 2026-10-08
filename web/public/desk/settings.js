/**
 * Settings - for administrators. The team, when the desk is open and which
 * number to give, the papers a booking needs, WhatsApp templates and the saved
 * replies everybody uses.
 *
 * Each card saves on its own, so changing the opening hours never resubmits a
 * template someone else is editing. The server checks every value and sends
 * back a sentence per field; those sentences appear beside the field.
 */

import {
  h, icon, api, post, toast, emptyState, errorState, skeleton, session, ago, add, fill,
} from './ui.js';

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const hourWords = (n) => `${String(n).padStart(2, '0')}:00`;
const DOC_WORDS = { invoice: 'Invoice', brief: 'Brief (CMR / transport document)', mrn: 'MRN document', acid: 'ACID certificate', eur1: 'EUR.1 certificate' };
const TIMEZONES = ['Africa/Cairo', 'Europe/Vilnius', 'Europe/Berlin', 'Europe/London', 'Asia/Dubai', 'UTC'];

export function renderSettings({ main }) {
  if (!session.can('settings')) {
    add(main, emptyState('Only an administrator can change settings.', 'Ask an administrator if something here needs changing.'));
    return null;
  }
  const root = h('div', { class: 'settings' }, skeleton(10));
  add(main, 
    h('div', { class: 'page-head' }, h('div', {},
      h('h1', {}, 'Settings'),
      h('p', { class: 'page-sub' }, 'Changes reach the bot within a minute. Every change is recorded with your name.'))),
    root);

  let data = null;
  async function load() {
    try {
      data = await api({ view: 'settings' });
    } catch (err) {
      fill(root, errorState(err.message, () => load()));
      return;
    }
    fill(root, 
      h('nav', { class: 'jump', 'aria-label': 'Settings sections' },
        [['team', 'Team'], ['hours', 'Hours and phone'], ['docs', 'Documents'], ['whatsapp', 'WhatsApp'], ['replies', 'Saved replies']]
          .map(([id, label]) => h('a', { href: `#/settings`, onclick: (e) => { e.preventDefault(); document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: 'smooth' }); } }, label))),
      teamCard(), hoursCard(), docsCard(), whatsappCard(), repliesCard());
  }

  /** Saves some settings, shows each field's error beside it, and reloads. */
  async function save(card, changes, button) {
    for (const el of card.querySelectorAll('.field-error')) { el.hidden = true; el.textContent = ''; }
    const versions = Object.fromEntries(Object.keys(changes).map((k) => [k, data.versions[k]]));
    button.disabled = true;
    const before = button.textContent;
    button.textContent = 'Saving…';
    try {
      await post({ action: 'settings_write', changes, versions });
      toast('Saved. The bot uses it within a minute.');
      await load();
    } catch (err) {
      if (err.data?.errors) {
        for (const [k, msg] of Object.entries(err.data.errors)) {
          const slot = card.querySelector(`[data-error-for="${k}"]`);
          if (slot) { slot.textContent = msg; slot.hidden = false; } else toast(msg, 'bad');
        }
        card.querySelector('.field-error:not([hidden])')?.scrollIntoView({ block: 'center' });
      } else {
        toast(err.message, err.data?.stale ? 'info' : 'bad');
        if (err.data?.stale) await load();
      }
    } finally {
      if (button.isConnected) { button.disabled = false; button.textContent = before; }
    }
  }

  const errorSlot = (key) => h('p', { class: 'field-error', 'data-error-for': key, role: 'alert', hidden: true });
  const changedBy = (key) => {
    const c = data.changed[key];
    return c ? h('span', { class: 'muted small' }, `Last changed by ${c.by} ${ago(c.at)}`) : null;
  };
  const card = (id, title, sub, ...children) => h('section', { class: 'card', id: `set-${id}`, 'aria-labelledby': `set-${id}-t` },
    h('div', { class: 'card-head' }, h('h2', { id: `set-${id}-t` }, title), sub ? h('p', { class: 'card-sub' }, sub) : null),
    ...children);

  // -- team -------------------------------------------------------------------
  function teamCard() {
    const rows = data.users.map((u) => {
      const role = h('select', { class: 'input input-small', 'aria-label': `Role for ${u.name}` },
        data.roles.map((r) => h('option', { value: r.role, selected: r.role === u.role }, r.words)));
      const active = h('input', { type: 'checkbox', checked: u.active, 'aria-label': `${u.name} can sign in` });
      const saveBtn = h('button', { class: 'btn btn-small', type: 'button', hidden: true }, 'Save');
      const changed = () => { saveBtn.hidden = role.value === u.role && active.checked === u.active; };
      role.addEventListener('change', changed);
      active.addEventListener('change', changed);
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
          await post({ action: 'user_save', name: u.name, role: role.value, active: active.checked, version: u.version });
          toast(`${u.name} updated.`);
          await load();
        } catch (err) {
          toast(err.message, 'bad');
          saveBtn.disabled = false;
        }
      });
      return h('tr', { class: u.active ? '' : 'is-inactive' },
        h('th', { scope: 'row' }, u.name, u.name === session.name ? h('span', { class: 'muted small' }, ' (you)') : null),
        h('td', {}, role),
        h('td', {}, h('label', { class: 'check' }, active, h('span', {}, u.active ? 'Active' : 'Switched off'))),
        h('td', { class: 'muted small' }, u.last_seen ? `Seen ${ago(u.last_seen)}` : 'Not seen yet'),
        h('td', {}, saveBtn));
    });

    const name = h('input', { class: 'input', id: 'new-name', placeholder: 'Name as they will type it', autocomplete: 'off' });
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
        await load();
      } catch (err) {
        toast(err.message, 'bad');
      }
    });

    return card('team', 'Team', 'Who can sign in, and what they may do. Agents work cases; supervisors also hand out work and set priority; administrators also change settings.',
      h('div', { class: 'table-wrap' }, h('table', { class: 'table table-plain' },
        h('thead', {}, h('tr', {}, ['Name', 'Role', 'Can sign in', 'Last seen', ''].map((c) => h('th', { scope: 'col' }, c)))),
        h('tbody', {}, rows))),
      add);
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
    const button = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save hours and phone');
    const c = card('hours', 'Office hours and phone numbers', 'When a person answers, and the numbers the bot gives out.');
    const form = h('form', {},
      h('datalist', { id: 'tz-list' }, TIMEZONES.map((t) => h('option', { value: t }))),
      h('div', { class: 'form-grid' },
        fieldWith('Opens at', start, 's-start', 'support_hours_start', changedBy('support_hours_start')),
        fieldWith('Closes at', end, 's-end', 'support_hours_end'),
        fieldWith('Timezone', tz, 's-tz', 'support_timezone'),
        fieldWith('Opening hours, as the customer reads them', sentence, 's-sentence', 'human_support_hours')),
      h('div', { class: 'form-grid' },
        fieldWith('Direct line (urgent, after hours)', direct, 's-direct', 'direct_phone', h('span', { class: 'muted small' }, 'Leave empty and the bot gives no number after hours.')),
        fieldWith('Desk number', desk, 's-desk', 'operations_phone', h('span', { class: 'muted small' }, 'Given to customers who ask for a person, and printed on their booking PDF. Leave empty and the bot gives no number.'))),
      h('div', { class: 'form-actions' }, button));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      save(c, {
        support_hours_start: Number(start.value), support_hours_end: Number(end.value), support_timezone: tz.value.trim(),
        human_support_hours: sentence.value, direct_phone: direct.value, operations_phone: desk.value,
      }, button);
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
        data.document_types.filter((t) => allowMrn || t !== 'mrn').map((t) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', name: key, value: t, checked: chosen.has(t) }), h('span', {}, DOC_WORDS[t] ?? t))),
        errorSlot(key));
    };
    const acid = h('input', { type: 'checkbox', id: 's-acid', checked: v.acid_required === true });
    const button = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save documents');
    const c = card('docs', 'Documents a booking needs', 'The bot asks for these, and the case page checks them. Nothing is required that is not ticked here.');
    const form = h('form', {},
      h('div', { class: 'form-grid' },
        list('required_booking_documents', 'When the customer has their own MRN', true),
        list('required_booking_documents_mky_mrn', 'When MKY gets the MRN for them', false)),
      h('label', { class: 'check', for: 's-acid' }, acid, h('span', {}, 'An ACID certificate is required at booking time')),
      errorSlot('acid_required'),
      h('div', { class: 'form-actions' }, button));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const picked = (k) => [...form.querySelectorAll(`input[name="${k}"]:checked`)].map((i) => i.value);
      save(c, {
        required_booking_documents: picked('required_booking_documents'),
        required_booking_documents_mky_mrn: picked('required_booking_documents_mky_mrn'),
        acid_required: acid.checked,
      }, button);
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
    const button = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save WhatsApp settings');
    const c = card('whatsapp', 'WhatsApp templates',
      'After 24 hours without a message from the customer, WhatsApp only delivers approved templates. Names must match WhatsApp Manager exactly; the same name is used in English and Arabic.');
    const form = h('form', {},
      h('div', { class: 'table-wrap' }, h('table', { class: 'table table-plain' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Message'), h('th', { scope: 'col' }, 'Template name'), h('th', { scope: 'col' }, 'Filled with'))),
        h('tbody', {}, rows))),
      errorSlot('whatsapp_templates'),
      fieldWith('Hours the window stays open', hours, 's-window', 'whatsapp_window_hours'),
      h('div', { class: 'form-actions' }, button, changedBy('whatsapp_templates')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const next = {};
      for (const { event } of data.template_events) {
        const name = inputs[event].value.trim();
        if (name) next[event] = { ...(templates[event] ?? {}), name };
      }
      save(c, { whatsapp_templates: next, whatsapp_window_hours: Number(hours.value) }, button);
    });
    add(c, form);
    return c;
  }

  // -- saved replies -------------------------------------------------------------
  function repliesCard() {
    let list = (data.values.saved_replies ?? []).map((r) => ({ ...r }));
    const holder = h('div', { class: 'replies' });
    const button = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save replies');
    const c = card('replies', 'Saved replies', 'Ready-made answers in the composer. Each is inserted in the customer’s language.');

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
            h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => { list.splice(i, 1); paint(); } }, 'Remove')),
          h('div', { class: 'form-grid' },
            h('div', { class: 'field' }, h('span', { class: 'label' }, 'English'), en),
            h('div', { class: 'field' }, h('span', { class: 'label' }, 'Arabic'), ar)));
      }));
    };
    paint();
    const form = h('form', {}, holder, errorSlot('saved_replies'),
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => { list.push({ title: '', en: '', ar: '' }); paint(); holder.lastChild?.querySelector('input')?.focus(); } }, icon('plus', { size: 14 }), 'Add a reply'),
        button, changedBy('saved_replies')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      list = list.filter((r) => r.title.trim() || r.en.trim() || r.ar.trim());
      save(c, { saved_replies: list }, button);
    });
    add(c, form);
    return c;
  }

  function fieldWith(label, input, id, key, hint = null) {
    return h('div', { class: 'field' }, h('label', { class: 'label', for: id }, label), input, hint, errorSlot(key));
  }

  load();
  return null;
}
