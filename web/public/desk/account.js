/**
 * Setting a password - one's own, from the account menu, or somebody else's,
 * from Settings. One dialog for both, so the rules a password must pass are
 * said the same way wherever it is typed.
 *
 * The server is the one that decides (lib/admin/desk-auth.js passwordProblem);
 * this checks the easy things first so nobody waits on a round trip to be told
 * the two boxes do not match.
 */

import { h, dialog, post, toast, session, safeSet, TKEY } from './ui.js';

export const MIN_PASSWORD = 8;

/**
 * Asks for a new password and saves it.
 *
 * @param {{ name?: string, mine?: boolean, onSaved?: Function }} opts
 *   name  whose password. Left out, it is the signed-in person's own.
 *   mine  whether that is the signed-in person - said in the words, and it is
 *         the case where the server hands back a fresh token so they are not
 *         signed out of the tab they are standing in.
 */
export function passwordDialog({ name = session.name, mine = !name || name === session.name, onSaved = null } = {}) {
  const one = h('input', { class: 'input', type: 'password', id: 'pw-1', autocomplete: 'new-password', required: true });
  const two = h('input', { class: 'input', type: 'password', id: 'pw-2', autocomplete: 'new-password', required: true });

  const dlg = dialog({
    title: mine ? 'Set your password' : `Set a password for ${name}`,
    subtitle: mine
      ? 'You will use it the next time you sign in. Anywhere else you are signed in will ask again.'
      : `Read it out to ${name} - the desk never shows it again. Anywhere they are signed in will ask again.`,
    size: 'sm',
    body: h('div', { class: 'stack' },
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'pw-1' }, 'New password'), one,
        h('p', { class: 'field-hint' }, `At least ${MIN_PASSWORD} characters. Not the shared desk secret.`)),
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'pw-2' }, 'Type it again'), two)),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save password',
        kind: 'primary',
        busy: 'Saving…',
        async run() {
          const password = one.value;
          if (password.length < MIN_PASSWORD) { dlg.error(`A password needs at least ${MIN_PASSWORD} characters.`); return true; }
          if (password !== two.value) { dlg.error('The two passwords are not the same.'); return true; }
          const out = await post({ action: 'set_password', name: mine ? session.name : name, password });
          // Their own password: the server hands back a token issued against
          // the new one, because changing it ended the old token - including
          // the one this tab is holding.
          if (out.token) { session.token = out.token; safeSet(TKEY, out.token); }
          toast(out.words ?? 'Password saved.');
          await onSaved?.();
          return false;
        },
      },
    ],
  });
  return dlg;
}
