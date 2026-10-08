/**
 * Which language a client chose, kept in Postgres.
 *
 * The choice belongs to the person (clients.language), so a client who picked
 * Arabic on Monday is answered in Arabic on Friday and their PDFs and
 * notifications follow. A chat with no client row yet keeps it on the session
 * (conversation_sessions.language) until one exists.
 *
 * Both columns arrive with migration 20261007090000. Until it is applied they do
 * not exist, and this module says so - `languageSupported()` is false - rather
 * than erroring. Callers must then NOT ask the client to choose: a choice that
 * cannot be saved would be asked for again on every message.
 */

import { db } from '../supabase.js';
import { normaliseLanguage } from '../lang.js';
import { sessionKey, sessionSettled } from './store.js';

// Learned once per process: a missing column does not appear mid-flight.
let supported = null;

const MISSING_COLUMN = /column .*language.* does not exist|could not find the 'language' column|42703|PGRST204/i;

function noteError(error) {
  if (error && MISSING_COLUMN.test(`${error.code ?? ''} ${error.message ?? ''}`)) supported = false;
}

/** False once a read or write has shown the migration is not applied. */
export function languageSupported() {
  return supported !== false;
}

/**
 * True only once a read or write has SUCCEEDED against the columns. The session
 * save adds `language` to its row only then: an upsert naming a column that does
 * not exist fails whole, and would lose the turn's state with it.
 */
export function languageColumnsExist() {
  return supported === true;
}

/**
 * The stored choice: the client's, else the session's. null when nobody chose,
 * when the columns do not exist, or when the read failed.
 */
export async function storedLanguage({ channel, chatId, clientId = null }) {
  if (supported === false) return null;

  if (clientId) {
    const { data, error } = await db().from('clients').select('language').eq('id', clientId).maybeSingle();
    if (error) { noteError(error); if (supported === false) return null; }
    const lang = normaliseLanguage(data?.language);
    if (lang) { supported = true; return lang; }
  }

  if (chatId == null) return null;
  // A language chosen last turn may still be on its way to the session row.
  await sessionSettled(channel, chatId);
  const { data, error } = await db()
    .from('conversation_sessions').select('language').eq('id', sessionKey(channel, chatId)).maybeSingle();
  if (error) { noteError(error); return null; }
  supported = true;
  return normaliseLanguage(data?.language);
}

/**
 * Saves a choice on the client and the session. Returns { ok, persisted }:
 * persisted is false when the columns do not exist, so the caller can carry the
 * choice for this turn without promising it will be remembered.
 */
export async function rememberLanguage({ channel, chatId, clientId = null }, value) {
  const lang = normaliseLanguage(value);
  if (!lang) return { ok: false, persisted: false };
  if (supported === false) return { ok: true, persisted: false };

  // Persisted means a row now holds it - an update that matched nothing (a
  // first message, before the session row is written) has saved nothing.
  let persisted = false;
  if (clientId) {
    const { data, error } = await db().from('clients').update({ language: lang }).eq('id', clientId).select('id');
    noteError(error);
    if (!error) { supported = true; if (data?.length) persisted = true; }
  }
  if (chatId != null && supported !== false) {
    const { data, error } = await db()
      .from('conversation_sessions').update({ language: lang }).eq('id', sessionKey(channel, chatId)).select('id');
    noteError(error);
    if (!error) { supported = true; if (data?.length) persisted = true; }
  }
  // Not persisted but supported: the caller puts `language` on the session
  // patch, and saveSession writes it with the rest of the row at the end of
  // the turn (it may, because languageColumnsExist() is now true).
  return { ok: true, persisted, lang };
}

/** For tests: forget what was learned about the schema. */
export function resetLanguageSupportForTests() {
  supported = null;
}
