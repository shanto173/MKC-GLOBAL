/**
 * Two read-only views in one function.
 *
 *   GET /api/health              "is everything wired up?" - safe to open in a
 *                                browser. ?deep=1 also asks Meta whether the
 *                                WhatsApp token works.
 *   GET /api/status?sessionId=   what a web-chat visitor has in flight, for the
 *                                strip above the widget (rewritten here by
 *                                vercel.json as ?view=status).
 *
 * WHY ONE FILE. Vercel's Hobby plan allows twelve functions per deployment and
 * the project was at twelve; the WhatsApp webhook needed one of them. The
 * status strip was the smallest route and, like this one, only reads - so it
 * moved in here and the old URL is kept by a rewrite. server.js applies the
 * same rewrites from vercel.json, so both hosts answer /api/status alike.
 */

import { config, whatsappConfigured } from '../lib/config.js';
import { db } from '../lib/supabase.js';
import { activeItems } from '../lib/pinned.js';

export default async function handler(req, res) {
  // Either marker means the status view: the rewrite adds view=status, and a
  // sessionId is never sent to the health check.
  if (req.query?.view === 'status' || req.query?.sessionId !== undefined) return statusView(req, res);
  return healthView(req, res);
}

// ---------------------------------------------------------------------------
// /api/status
// ---------------------------------------------------------------------------

/**
 * The same thing the pinned card shows on Telegram: a customer should be able
 * to see where their vehicle is without asking for it again.
 *
 * The session id is the random one the browser made for itself and keeps in
 * localStorage - the same key /api/chat is trusted with. It only ever returns
 * rows created from that session.
 */
async function statusView(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const sessionId = String(req.query.sessionId ?? '').trim();
  if (!sessionId || sessionId.length > 100) {
    return res.status(400).json({ error: 'A sessionId is required.' });
  }

  try {
    const items = await activeItems(sessionId);
    // Never cached: a status the customer is watching must not be a stale copy.
    res.setHeader('cache-control', 'no-store');
    return res.status(200).json({ company: config.companyName, count: items.length, items });
  } catch (err) {
    console.error('status failed:', err.message);
    return res.status(200).json({ company: config.companyName, count: 0, items: [] });
  }
}

// ---------------------------------------------------------------------------
// /api/health
// ---------------------------------------------------------------------------

async function healthView(req, res) {
  // Which build is actually serving. We repeatedly could not tell whether a
  // setting had failed to save or a redeploy simply had not happened; the commit
  // and build time answer that in one look. Vercel injects these itself.
  const build = {
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? 'unknown').slice(0, 7),
    message: process.env.VERCEL_GIT_COMMIT_MESSAGE?.split('\n')[0] ?? null,
    deployed_at: process.env.VERCEL_DEPLOYMENT_ID ? undefined : 'local',
    env: process.env.VERCEL_ENV ?? 'local',
    // Surfaced so branding can be checked without messaging the bot.
    company: config.companyName,
    reference_prefix: config.refPrefix,
    model: config.llm.provider === 'anthropic' ? config.llm.anthropicModel
      : config.llm.provider === 'groq' && config.llm.groqKey ? config.llm.groqModel
        : config.llm.openaiModel,
  };

  const checks = {
    supabase_url: Boolean(config.supabase.url),
    supabase_key: Boolean(config.supabase.serviceRoleKey),
    telegram_token: Boolean(config.telegram.token),
    telegram_webhook_secret: Boolean(config.telegram.webhookSecret),
    llm_provider: config.llm.provider,
    llm_key: config.llm.provider === 'anthropic' ? Boolean(config.llm.anthropicKey)
      : config.llm.provider === 'groq' ? Boolean(config.llm.groqKey || config.llm.openaiKey)
        : Boolean(config.llm.openaiKey),
    // Who answers when Groq cannot.
    ...(config.llm.provider === 'groq' ? { llm_fallback: config.llm.openaiKey ? 'openai' : 'none', groq_key: Boolean(config.llm.groqKey) } : {}),
    embeddings: Boolean(config.llm.openaiKey),
  };

  let database = 'not checked';
  let shipments = null;
  let documents = null;
  // Migration 008 adds the tables the state machine cannot work without. Their
  // absence is the single most likely reason a freshly deployed bot answers
  // nothing at all, so it is reported here by name rather than discovered in a
  // log after a client has been left waiting.
  let migrations = 'not checked';
  const flowTables = {};
  let whatsappSchema = { migration: 'not checked' };

  if (checks.supabase_url && checks.supabase_key) {
    try {
      const s = await db().from('shipments').select('*', { count: 'exact', head: true });
      const d = await db().from('documents').select('*', { count: 'exact', head: true });
      if (s.error) throw s.error;
      if (d.error) throw d.error;
      database = 'ok';
      shipments = s.count;
      documents = d.count;
    } catch (err) {
      database = `error: ${err.message}`;
    }

    const REQUIRED = ['conversation_sessions', 'operations_tasks', 'mrn_requests',
      'notification_outbox', 'audit_logs', 'bot_settings'];
    const absent = [];
    for (const table of REQUIRED) {
      const { error } = await db().from(table).select('*', { count: 'exact', head: true });
      flowTables[table] = error ? `missing: ${error.message}` : 'ok';
      if (error) absent.push(table);
    }

    // The two Postgres functions that make submission and de-duplication
    // atomic. A missing one does not throw until a client taps Confirm.
    const claim = await db().rpc('claim_telegram_update', { p_update_id: -1, p_chat_id: 'health' });
    flowTables.claim_telegram_update = claim.error ? `missing: ${claim.error.message}` : 'ok';
    if (claim.error) absent.push('claim_telegram_update()');

    const submit = await db().rpc('submit_booking_request', {
      p_booking_ref: '__health_check__', p_chat_id: 'health', p_task_ref: 'health',
    });
    // not_found is the RIGHT answer here: the function exists and refused a
    // reference that does not. Only a transport error means it is absent.
    flowTables.submit_booking_request = submit.error ? `missing: ${submit.error.message}` : 'ok';
    if (submit.error) absent.push('submit_booking_request()');

    migrations = absent.length
      ? `migration 008 not applied - missing: ${absent.join(', ')}`
      : 'ok';

    whatsappSchema = await whatsappMigration();
  }

  // PDFKit reads .afm font files off disk; if Vercel's file tracing misses
  // them the confirmation PDF fails only when a real booking is made. Check now.
  let pdf = 'not checked';
  try {
    const { bookingConfirmationPdf } = await import('../lib/pdf.js');
    const buf = await bookingConfirmationPdf({
      booking_ref: 'HEALTH-CHECK',
      status: 'pending_review',
      channel: 'health',
      customer_name: 'Health Check',
      customer_contact: 'health@example.com',
      origin_country: 'European Union',
      origin_port: 'Rotterdam',
      destination_port: 'Port Said',
      cargo_description: 'test',
      created_at: new Date().toISOString(),
    });
    pdf = buf?.length > 800 ? `ok (${buf.length} bytes)` : `suspicious (${buf?.length} bytes)`;
  } catch (err) {
    pdf = `error: ${err.message}`;
  }

  const notifications = {
    email: config.mail.apiKey ? 'configured' : 'RESEND_API_KEY not set - emails skipped',
    ops_inbox: config.mail.opsEmail || 'OPS_EMAIL not set',
    staff_telegram: config.staffChatId ? 'configured' : 'STAFF_CHAT_ID not set - staff ping skipped',
  };

  const missing = [];
  if (!checks.supabase_url) missing.push('SUPABASE_URL');
  if (!checks.supabase_key) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!checks.telegram_token) missing.push('TELEGRAM_BOT_TOKEN');
  if (!checks.telegram_webhook_secret) missing.push('TELEGRAM_WEBHOOK_SECRET');
  if (!checks.llm_key) {
    missing.push(config.llm.provider === 'anthropic' ? 'ANTHROPIC_API_KEY'
      : config.llm.provider === 'groq' ? 'GROQ_API_KEY' : 'OPENAI_API_KEY');
  }
  if (missing.length) checks.missing_env = missing;

  const booking_engine = {
    engine: config.bookingEngine,
    prompt_version: config.promptVersion,
    model_can_book: config.bookingEngine !== 'state_machine',
  };

  const whatsapp = await whatsappHealth({ deep: req.query?.deep === '1' || req.query?.deep === 'true' });
  whatsapp.schema = whatsappSchema;

  // WhatsApp is the second channel, not a precondition: a Telegram-only
  // deployment, or one waiting for its WhatsApp migration, is still ready.
  // A deep check that finds the token dead is the exception - that is a
  // channel silently dropping every customer on it.
  const whatsappBroken = whatsapp.token_check?.startsWith('error');
  const ready = missing.length === 0 && database === 'ok' && migrations === 'ok' && pdf.startsWith('ok') && !whatsappBroken;
  res.status(ready ? 200 : 503).json({
    ready, build, checks, database, migrations, flow_tables: flowTables,
    booking_engine, rows: { shipments, documents }, pdf, notifications, whatsapp,
  });
}

/**
 * Which WhatsApp settings are present. Meta is only asked whether the token
 * works when ?deep=1 says so: a health check opened every few minutes by a
 * monitor should not spend Graph API calls or sit behind Meta's latency.
 */
async function whatsappHealth({ deep = false } = {}) {
  const w = config.whatsapp;
  const present = {
    access_token: Boolean(w.token),
    phone_number_id: Boolean(w.phoneNumberId),
    business_account_id: Boolean(w.businessAccountId),
    app_secret: Boolean(w.appSecret),
    verify_token: Boolean(w.verifyToken),
  };
  const missing = Object.entries({
    WHATSAPP_ACCESS_TOKEN: present.access_token,
    WHATSAPP_PHONE_NUMBER_ID: present.phone_number_id,
    WHATSAPP_APP_SECRET: present.app_secret,
    WHATSAPP_VERIFY_TOKEN: present.verify_token,
  }).filter(([, ok]) => !ok).map(([name]) => name);

  const anything = Object.values(present).some(Boolean);
  const result = {
    status: !anything ? 'off' : missing.length ? 'incomplete' : 'configured',
    ...present,
    graph_version: w.graphVersion,
    ...(anything && missing.length ? { missing_env: missing } : {}),
    token_check: 'not checked - add ?deep=1',
  };

  if (deep && whatsappConfigured()) {
    const { phoneNumberInfo } = await import('../lib/whatsapp.js');
    const info = await phoneNumberInfo();
    if (info.ok) {
      result.token_check = 'ok';
      result.number = info.body?.display_phone_number ?? null;
      result.verified_name = info.body?.verified_name ?? null;
      result.quality_rating = info.body?.quality_rating ?? null;
    } else {
      result.token_check = `error${info.code ? ` ${info.code}` : ''}: ${info.error}`;
    }
  }
  return result;
}

/**
 * Is migration 20261007090000 (WhatsApp, language, chat log) applied - and the
 * small 20261007100000 after it? The bot runs without them, Telegram exactly
 * as before; WhatsApp clients, the chosen language and the desk's
 * conversation view need them. Said here by name, so "why is everything
 * bilingual" has an answer one click away.
 */
async function whatsappMigration() {
  const probes = {
    chat_messages: () => db().from('chat_messages').select('*', { count: 'exact', head: true }),
    processed_whatsapp_messages: () => db().from('processed_whatsapp_messages').select('*', { count: 'exact', head: true }),
    'clients.whatsapp_id/language/opted_out_at': () => db().from('clients').select('whatsapp_id, language, opted_out_at').limit(1),
    'conversation_sessions.language/last_client_message_at': () =>
      db().from('conversation_sessions').select('language, last_client_message_at').limit(1),
    'notification_outbox.language/delivery_status/provider_message_id/template_name': () =>
      db().from('notification_outbox').select('language, delivery_status, provider_message_id, template_name').limit(1),
    // A fixed id: the first check claims it, every later one is a duplicate.
    'claim_whatsapp_message()': () => db().rpc('claim_whatsapp_message', { p_message_id: '__health_check__', p_chat_id: 'health' }),
  };

  const tables = {};
  const absent = [];
  for (const [name, probe] of Object.entries(probes)) {
    const { error } = await probe();
    tables[name] = error ? `missing: ${error.message}` : 'ok';
    if (error) absent.push(name);
  }

  const { data: setting } = await db().from('bot_settings').select('value').eq('key', 'whatsapp_templates').maybeSingle();
  tables.whatsapp_templates = setting?.value ? `${Object.keys(setting.value).length} events mapped` : 'not set';

  const media = await db().from('booking_documents').select('whatsapp_media_sha256').limit(1);
  tables['booking_documents.whatsapp_media_sha256'] = media.error ? `missing: ${media.error.message}` : 'ok';

  return {
    migration: absent.length
      ? `20261007090000 not applied - missing: ${absent.join(', ')}`
      : 'ok',
    media_migration: media.error ? '20261007100000 not applied (WhatsApp re-sent files are not recognised as the same document)' : 'ok',
    tables,
  };
}
