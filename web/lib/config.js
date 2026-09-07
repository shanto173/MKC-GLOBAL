/**
 * Central config. Everything comes from environment variables so that the same
 * code runs locally (.env) and on Vercel (Project Settings -> Env Variables).
 */

const env = process.env;

export const config = {
  companyName: env.COMPANY_NAME || 'MKY Global Forwarding',
  bookingFormUrl: env.BOOKING_FORM_URL || '',
  companyEmail: env.COMPANY_EMAIL || 'bookings@mkyglobal.example',
  // Prefix on every booking and ticket reference, e.g. MKY-BKG-260904-AB12.
  refPrefix: (env.REFERENCE_PREFIX || 'MKY').toUpperCase(),
  companyPhone: env.COMPANY_PHONE || '+20 3 555 0143',
  // The number the bot gives when a customer asks for a person. Roadmap steps
  // 2 and 3 both end at "Operations: [PHONE NUMBER]".
  operationsPhone: env.OPERATIONS_PHONE || env.COMPANY_PHONE || '+20 3 555 0143',
  adminSecret: env.ADMIN_SECRET || '',

  /**
   * Who owns the booking conversation.
   *
   *   state_machine  the deterministic flow in lib/flow decides every step, and
   *                  the model cannot create, change or submit a booking. This
   *                  is the default and the only supported production setting.
   *   llm            the previous behaviour, where the model drove booking
   *                  through tools. Kept so this change can be rolled back with
   *                  one environment variable rather than a redeploy of old code.
   */
  bookingEngine: (env.BOOKING_ENGINE || 'state_machine').toLowerCase(),

  /** Prompt version, recorded against every AI interaction so answers are traceable. */
  promptVersion: env.BOT_PROMPT_VERSION || '2',
  // Optional. Everything falls back to the incoming request host, so this only
  // matters for CLI scripts. Named APP_BASE_URL because hosts treat a PUBLIC_*
  // prefix as a browser-exposed framework variable and refuse to keep it secret;
  // PUBLIC_BASE_URL is still honoured for anyone who already set it.
  publicBaseUrl: (env.APP_BASE_URL || env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),

  supabase: {
    url: env.SUPABASE_URL || '',
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
  },

  telegram: {
    token: env.TELEGRAM_BOT_TOKEN || '',
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || '',
  },

  /** Telegram group/channel where staff get notified of new bookings. */
  staffChatId: env.STAFF_CHAT_ID || '',

  mail: {
    apiKey: env.RESEND_API_KEY || '',
    from: env.MAIL_FROM || 'MKC Global Logistics <onboarding@resend.dev>',
    opsEmail: env.OPS_EMAIL || '',
  },

  llm: {
    provider: (env.LLM_PROVIDER || 'openai').toLowerCase(),
    openaiKey: env.OPENAI_API_KEY || '',
    // The conversation model. It decides what a customer meant, which tool to
    // call and what to say, so this is where intelligence is worth paying for.
    openaiModel: env.OPENAI_MODEL || 'gpt-4.1',
    // Transcribing a scan and pulling numbers out of text is bulk work on a
    // fixed shape - a cheaper model does it just as well, and there is a lot
    // of it per booking.
    openaiFastModel: env.OPENAI_MODEL_FAST || 'gpt-4.1-mini',
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5',
    embeddingModel: env.EMBEDDING_MODEL || 'text-embedding-3-small',
  },
};

/** Ports we serve, used for validation and for the guided booking flow. */
export const DESTINATION_PORTS = [
  'Alexandria Port (incl. El Dekheila)',
  'Port Said',
  'Damietta Port',
  'Ain Sokhna Port',
  'Suez Port',
];

export const ORIGIN_COUNTRIES = [
  'European Union',
  'United Kingdom',
  'United States',
];

export const DEPARTMENTS = [
  'Booking Operations',
  'Accounts & Payments',
  'Tracking Desk',
  'Customs Documentation',
  'Customer Care',
];

/** Throws a readable error at boot if something essential is missing. */
export function assertConfig({ needLlm = true } = {}) {
  const missing = [];
  if (!config.supabase.url) missing.push('SUPABASE_URL');
  if (!config.supabase.serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (needLlm) {
    if (config.llm.provider === 'openai' && !config.llm.openaiKey) missing.push('OPENAI_API_KEY');
    if (config.llm.provider === 'anthropic' && !config.llm.anthropicKey) missing.push('ANTHROPIC_API_KEY');
  }
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}
