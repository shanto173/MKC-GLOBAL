/**
 * Central config. Everything comes from environment variables so that the same
 * code runs locally (.env) and on Vercel (Project Settings -> Env Variables).
 */

const env = process.env;

export const config = {
  companyName: env.COMPANY_NAME || 'MKY Global Forwarding',
  bookingFormUrl: env.BOOKING_FORM_URL || '',
  // Printed in the PDF footer. No default for the same reason as the phone
  // below: an address on a .example domain reaches nobody.
  companyEmail: env.COMPANY_EMAIL || '',
  // Prefix on every booking and ticket reference, e.g. MKY-BKG-260904-AB12.
  refPrefix: (env.REFERENCE_PREFIX || 'MKY').toUpperCase(),
  // No default, and no operationsPhone here at all any more. Both used to fall
  // back to the .env.example illustration, +20 3 555 0143, and production has
  // neither COMPANY_PHONE nor OPERATIONS_PHONE set - so that number was printed
  // on every booking PDF and handed to the assistant as the one to give
  // customers. The number the bot uses is read at run time by
  // operationsContact() / companyPhone() in lib/settings.js: the desk's
  // Settings first, then the environment, and none at all when nothing is set.
  companyPhone: env.COMPANY_PHONE || '',
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

  /**
   * WhatsApp Cloud API (Meta). The second channel into the same engine.
   *
   * Two of these protect the webhook rather than send anything: the app
   * secret signs every POST Meta makes (X-Hub-Signature-256), and the verify
   * token is the string Meta echoes back once, when the webhook is registered.
   * Without the app secret the webhook refuses everything - an unsigned
   * request is indistinguishable from anyone on the internet typing as a
   * customer.
   */
  whatsapp: {
    token: env.WHATSAPP_ACCESS_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    businessAccountId: env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
    appSecret: env.WHATSAPP_APP_SECRET || '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    // Pinned rather than "latest": Meta retires a version two years after its
    // release and changes payloads between versions, so moving is a decision.
    graphVersion: env.WHATSAPP_GRAPH_VERSION || 'v23.0',
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
    // Groq: OpenAI's request format on fast hardware, asked first when
    // LLM_PROVIDER=groq. OpenAI stays behind it - a Groq refusal, rate limit or
    // outage is answered by OpenAI rather than with an apology - and remains
    // the only source of embeddings, which Groq does not offer.
    groqKey: env.GROQ_API_KEY || '',
    groqModel: env.GROQ_MODEL || 'openai/gpt-oss-120b',
    groqFastModel: env.GROQ_MODEL_FAST || 'openai/gpt-oss-20b',
    // Reading a scan or a photograph needs a model that sees images.
    groqVisionModel: env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b',
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

/**
 * The same five ports as an Arabic chat names them. Only ever what a customer
 * reads: the booking keeps the English name above, which is what customs and
 * the paperwork use, and lib/bookings.js matchPort() understands either.
 */
export const DESTINATION_PORTS_AR = {
  'Alexandria Port (incl. El Dekheila)': 'ميناء الإسكندرية (شامل الدخيلة)',
  'Port Said': 'ميناء بورسعيد',
  'Damietta Port': 'ميناء دمياط',
  'Ain Sokhna Port': 'ميناء العين السخنة',
  'Suez Port': 'ميناء السويس',
};

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

/** Can we send on WhatsApp at all? Both are needed for every Graph API call. */
export function whatsappConfigured() {
  return Boolean(config.whatsapp.token && config.whatsapp.phoneNumberId);
}

/** Throws a readable error at boot if something essential is missing. */
export function assertConfig({ needLlm = true } = {}) {
  const missing = [];
  if (!config.supabase.url) missing.push('SUPABASE_URL');
  if (!config.supabase.serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (needLlm) {
    if (config.llm.provider === 'openai' && !config.llm.openaiKey) missing.push('OPENAI_API_KEY');
    if (config.llm.provider === 'groq' && !config.llm.groqKey && !config.llm.openaiKey) missing.push('GROQ_API_KEY');
    if (config.llm.provider === 'anthropic' && !config.llm.anthropicKey) missing.push('ANTHROPIC_API_KEY');
  }
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}
