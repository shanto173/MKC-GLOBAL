/** Quick "is everything wired up?" check. Safe to open in a browser. */

import { config } from '../lib/config.js';
import { db } from '../lib/supabase.js';

export default async function handler(_req, res) {
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
    model: config.llm.provider === 'anthropic' ? config.llm.anthropicModel : config.llm.openaiModel,
  };

  const checks = {
    supabase_url: Boolean(config.supabase.url),
    supabase_key: Boolean(config.supabase.serviceRoleKey),
    telegram_token: Boolean(config.telegram.token),
    telegram_webhook_secret: Boolean(config.telegram.webhookSecret),
    llm_provider: config.llm.provider,
    llm_key: config.llm.provider === 'anthropic' ? Boolean(config.llm.anthropicKey) : Boolean(config.llm.openaiKey),
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
  if (!checks.llm_key) missing.push(config.llm.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
  if (missing.length) checks.missing_env = missing;

  const booking_engine = {
    engine: config.bookingEngine,
    prompt_version: config.promptVersion,
    model_can_book: config.bookingEngine !== 'state_machine',
  };

  const ready = missing.length === 0 && database === 'ok' && migrations === 'ok' && pdf.startsWith('ok');
  res.status(ready ? 200 : 503).json({
    ready, build, checks, database, migrations, flow_tables: flowTables,
    booking_engine, rows: { shipments, documents }, pdf, notifications,
  });
}
