-- ===========================================================================
-- WhatsApp as a second channel, one language per conversation, and a record of
-- every message in and out.
--
-- Idempotent like every migration before it: safe to run twice, safe to run on
-- a database that already has part of it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Who the client is on WhatsApp, and which language they chose.
--
-- On WhatsApp the sender IS their phone number (wa_id, E.164 digits without the
-- plus). Unique, so two webhooks for the same person upsert one row.
--
-- language is the client's own choice, made once at the start and changeable at
-- any time. null means "not chosen yet": the bot asks before anything else.
-- ---------------------------------------------------------------------------
alter table clients add column if not exists whatsapp_id    text;
alter table clients add column if not exists whatsapp_name  text;
alter table clients add column if not exists language       text;
-- A client who wrote STOP. Nothing but a reply to their own message is sent to
-- them again until they write START.
alter table clients add column if not exists opted_out_at   timestamptz;

create unique index if not exists clients_whatsapp_id_unique on clients (whatsapp_id) where whatsapp_id is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'clients_language_check') then
    alter table clients add constraint clients_language_check check (language is null or language in ('en', 'ar'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The conversation remembers its language and when the client last wrote.
--
-- language here covers a chat with no client row yet. last_client_message_at is
-- WhatsApp's 24-hour customer service window: inside it any message may be
-- sent; outside it only an approved template.
-- ---------------------------------------------------------------------------
alter table conversation_sessions add column if not exists language               text;
alter table conversation_sessions add column if not exists last_client_message_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'conversation_sessions_language_check') then
    alter table conversation_sessions add constraint conversation_sessions_language_check
      check (language is null or language in ('en', 'ar'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Every message, in and out, on every channel.
--
-- The desk shows a customer's conversation the way they saw it: what they
-- wrote, what the bot answered, what a person sent, and whether it arrived.
-- provider_message_id is WhatsApp's wamid or Telegram's message id; WhatsApp's
-- delivery receipts find their row by it.
-- ---------------------------------------------------------------------------
create table if not exists chat_messages (
  id                  bigint generated always as identity primary key,
  channel             text not null,
  chat_id             text not null,
  client_id           bigint references clients(id),
  direction           text not null check (direction in ('in', 'out')),
  -- client: the customer · bot: the state machine or assistant
  -- staff: a person at the desk · system: a notification from the outbox
  author              text not null check (author in ('client', 'bot', 'staff', 'system')),
  staff_name          text,
  kind                text not null default 'text',
  body                text,
  payload             jsonb not null default '{}'::jsonb,
  language            text,
  booking_ref         text,
  provider_message_id text,
  status              text not null default 'sent'
                      check (status in ('received', 'queued', 'sent', 'delivered', 'read', 'failed')),
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists chat_messages_provider_id_unique
  on chat_messages (channel, provider_message_id) where provider_message_id is not null;
create index if not exists chat_messages_chat_idx on chat_messages (channel, chat_id, created_at desc);
create index if not exists chat_messages_client_idx on chat_messages (client_id, created_at desc);
create index if not exists chat_messages_failed_idx on chat_messages (status, created_at desc) where status = 'failed';

alter table chat_messages enable row level security;

-- ---------------------------------------------------------------------------
-- 4. WhatsApp retry de-duplication.
--
-- Meta retries a webhook for hours until it gets a 2xx, and its message ids are
-- strings ("wamid.HBg..."), so processed_updates (bigint, Telegram's) cannot
-- hold them. Same claim semantics as claim_telegram_update: the first caller
-- wins; a failed or crashed (stale) claim can be taken again.
-- ---------------------------------------------------------------------------
create table if not exists processed_whatsapp_messages (
  message_id   text primary key,
  chat_id      text,
  status       text not null default 'processing',
  error        text,
  created_at   timestamptz not null default now(),
  processed_at timestamptz not null default now()
);

alter table processed_whatsapp_messages enable row level security;

create or replace function claim_whatsapp_message(
  p_message_id  text,
  p_chat_id     text default null,
  p_stale_after interval default interval '2 minutes'
)
returns boolean
language plpgsql
as $func$
declare
  claimed boolean := false;
begin
  insert into processed_whatsapp_messages (message_id, chat_id, status, processed_at)
  values (p_message_id, p_chat_id, 'processing', now())
  on conflict (message_id) do update
    set status = 'processing',
        processed_at = now()
  where processed_whatsapp_messages.status = 'failed'
     or (processed_whatsapp_messages.status = 'processing'
         and processed_whatsapp_messages.processed_at < now() - p_stale_after)
  returning true into claimed;

  return coalesce(claimed, false);
end;
$func$;

revoke execute on function claim_whatsapp_message(text, text, interval) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The outbox learns WhatsApp.
--
-- Outside the 24-hour window a WhatsApp message can only be an approved
-- template, so the row records which template went (or why none could), and
-- the provider's id so a delivery receipt can mark it delivered or failed.
-- ---------------------------------------------------------------------------
alter table notification_outbox add column if not exists language            text;
alter table notification_outbox add column if not exists template_name       text;
alter table notification_outbox add column if not exists provider_message_id text;
alter table notification_outbox add column if not exists delivery_status     text;

-- ---------------------------------------------------------------------------
-- 6. Settings the desk can change without a deployment.
--
-- whatsapp_templates maps an outbox event to the approved template that carries
-- it outside the 24-hour window, per language. The names must match WhatsApp
-- Manager exactly; until a template is approved there, an event with no open
-- window is recorded as waiting rather than sent wrong.
-- ---------------------------------------------------------------------------
insert into bot_settings (key, value, note) values
  ('whatsapp_window_hours', '24'::jsonb,
   'Hours after the client''s last WhatsApp message during which free-form messages may be sent.'),
  ('whatsapp_templates', '{
     "booking_confirmed":            {"name": "mky_booking_confirmed",   "params": ["booking_ref", "shipment_id"]},
     "booking_confirmed_pdf":        {"name": "mky_booking_confirmed_doc", "params": ["booking_ref"], "header": "document"},
     "booking_rejected":             {"name": "mky_booking_rejected",    "params": ["booking_ref", "reason"]},
     "missing_information_requested": {"name": "mky_information_needed", "params": ["booking_ref", "what"]},
     "document_rejected":            {"name": "mky_document_needed",     "params": ["booking_ref", "what"]},
     "shipment_update":              {"name": "mky_shipment_update",     "params": ["reference", "update"]},
     "operations_message":           {"name": "mky_message_from_team",   "params": ["reference", "message"]},
     "ticket_resolved":              {"name": "mky_request_resolved",    "params": ["reference"]},
     "_reopen":                      {"name": "mky_please_reply",        "params": []}
   }'::jsonb,
   'Event -> approved WhatsApp template (name, ordered body parameters, optional document header). Same name in en and ar.'),
  ('ask_language_first', 'true'::jsonb,
   'Ask a new client to choose English or Arabic before anything else.')
on conflict (key) do nothing;
