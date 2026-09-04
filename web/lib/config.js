/**
 * Central config. Everything comes from environment variables so that the same
 * code runs locally (.env) and on Vercel (Project Settings -> Env Variables).
 */

const env = process.env;

export const config = {
  companyName: env.COMPANY_NAME || 'MKY Global Forwarding',
  bookingFormUrl: env.BOOKING_FORM_URL || '',
  companyEmail: env.COMPANY_EMAIL || 'bookings@mkyglobal.example',
  companyPhone: env.COMPANY_PHONE || '+20 3 555 0143',
  adminSecret: env.ADMIN_SECRET || '',
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
    openaiModel: env.OPENAI_MODEL || 'gpt-4o-mini',
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
