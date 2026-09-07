-- ===========================================================================
-- Migration 008 - deterministic state machine, Operations workflow, outbox
--
-- Everything before this migration let the language model decide how a booking
-- progressed. This one gives the application the tables it needs to decide for
-- itself: where a conversation is, what work Operations owes, what still has to
-- be told to a customer, and what happened.
--
-- Additive and idempotent throughout. No existing column is dropped and no
-- existing row is rewritten, so the running bot keeps working while it is
-- applied and while the new code is deployed behind it.
--
-- NAMING NOTE - read this before comparing against the specification.
-- The spec describes `booking_requests` and `bookings` as two tables. This
-- schema already carries both in ONE table, `bookings`, whose status column IS
-- the request lifecycle (draft -> pending_review -> confirmed). Splitting it
-- would break the Operations console, the confirmation PDF, the notifier and
-- the shipment bridge for no business gain, so the single table is kept and the
-- request-side columns the spec asks for are added to it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Clients - the Telegram identity behind a conversation
--
-- `clients` existed only for demo seed data and the bot never wrote to it, so a
-- booking knew a chat id and nothing else. Telegram's user id is the only
-- stable identity a person has here: usernames change, display names are not a
-- business name, and a chat id is not a person.
-- ---------------------------------------------------------------------------
do $do$
begin
  -- The legacy column is text and, in every deployment, empty. Convert it in
  -- place rather than carrying two columns for one fact; anything non-numeric
  -- becomes null instead of failing the migration.
  if exists (
    select 1 from information_schema.columns
    where table_name = 'clients' and column_name = 'telegram_user_id'
      and data_type <> 'bigint'
  ) then
    alter table clients alter column telegram_user_id type bigint
      using nullif(regexp_replace(coalesce(telegram_user_id, ''), '[^0-9]', '', 'g'), '')::bigint;
  end if;
end
$do$;

alter table clients add column if not exists telegram_chat_id  bigint;
alter table clients add column if not exists telegram_username text;
alter table clients add column if not exists first_name        text;
alter table clients add column if not exists last_name         text;
alter table clients add column if not exists display_name      text;
alter table clients add column if not exists is_blocked        boolean not null default false;
alter table clients add column if not exists updated_at        timestamptz not null default now();

-- full_name was NOT NULL from the demo schema. A Telegram user who has not yet
-- told us their business name has no full name, and refusing to record them
-- would mean no client row and therefore no ownership check.
alter table clients alter column full_name drop not null;

create unique index if not exists clients_telegram_user_idx
  on clients (telegram_user_id) where telegram_user_id is not null;
create index if not exists clients_telegram_chat_idx on clients (telegram_chat_id);

-- ---------------------------------------------------------------------------
-- 2. Booking requests - the columns the flow needs
-- ---------------------------------------------------------------------------
alter table bookings add column if not exists client_id           bigint references clients(id);
alter table bookings add column if not exists telegram_user_id    bigint;
alter table bookings add column if not exists mrn_choice          text;
alter table bookings add column if not exists current_step        text;
alter table bookings add column if not exists client_confirmed_at timestamptz;
alter table bookings add column if not exists submitted_at        timestamptz;
alter table bookings add column if not exists review_started_at   timestamptz;
alter table bookings add column if not exists review_started_by   text;
alter table bookings add column if not exists needs_client_action jsonb;

create index if not exists bookings_client_idx on bookings (client_id, created_at desc);
create index if not exists bookings_tg_user_idx on bookings (telegram_user_id, created_at desc);

-- The draft is written the moment the client answers the FIRST question, so
-- nothing is ever held in memory waiting for the last one. That means a draft
-- legitimately has no client name and no route yet, and these columns - NOT
-- NULL since the general-freight schema - have to allow it.
--
-- The integrity does not go away, it moves: the constraint below says a booking
-- may be incomplete ONLY while it is a draft. Anything that has reached
-- Operations must carry every field, enforced by the database rather than by
-- remembering to check.
alter table bookings alter column customer_name    drop not null;
alter table bookings alter column origin_port      drop not null;
alter table bookings alter column destination_port drop not null;

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_complete_when_submitted') then
    -- NOT VALID applies the rule to every future write without re-checking rows
    -- already in the table. A deployment carrying an old half-filled request
    -- must not have this migration fail underneath it; the validation below
    -- reports that case instead of aborting.
    alter table bookings add constraint bookings_complete_when_submitted
      check (
        -- draft is being filled in; cancelled and expired are requests that
        -- never were. A client who gives a chassis number, learns the unit is
        -- already booked and walks away leaves a row with nothing else on it,
        -- and cancelling that must not be refused by a constraint.
        status in ('draft', 'cancelled', 'expired')
        or (
             vin              is not null and btrim(vin) <> ''
         and make             is not null and btrim(make) <> ''
         and customer_name    is not null and btrim(customer_name) <> ''
         and origin_port      is not null and btrim(origin_port) <> ''
         and destination_port is not null and btrim(destination_port) <> ''
        )
      ) not valid;

    begin
      alter table bookings validate constraint bookings_complete_when_submitted;
    exception when others then
      raise warning
        'bookings_complete_when_submitted holds for new rows but existing rows fail it (%). Fix the incomplete non-draft bookings, then: alter table bookings validate constraint bookings_complete_when_submitted;',
        sqlerrm;
    end;
  end if;
end
$do$;

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_mrn_choice_check') then
    alter table bookings add constraint bookings_mrn_choice_check
      check (mrn_choice is null or mrn_choice in ('existing', 'mky_issue', 'unknown'));
  end if;
end
$do$;

-- The status list grows: Operations can now take a request into review and hand
-- it back to the customer for more information, and an abandoned draft expires.
-- The old five values all remain valid, so nothing in flight is invalidated.
do $do$
begin
  if exists (select 1 from pg_constraint where conname = 'bookings_status_check') then
    alter table bookings drop constraint bookings_status_check;
  end if;
  alter table bookings add constraint bookings_status_check
    check (status in (
      'draft',
      'pending_review',        -- submitted by the client, nobody has picked it up
      'under_review',          -- an operator has it open
      'needs_client_action',   -- handed back for more information
      'confirmed',
      'rejected',
      'cancelled',
      'expired'
    ));
end
$do$;

-- ---------------------------------------------------------------------------
-- 3. One live booking per chassis, enforced by the database
--
-- The duplicate check lived in application code between a SELECT and an INSERT,
-- which two simultaneous confirmations walk straight through. This closes it.
-- Drafts are excluded: a draft is one conversation's private proposal, and two
-- people may well be drafting the same unit before either commits.
--
-- Created defensively: if a deployment already holds duplicates the index
-- cannot be built, and failing the whole migration would be worse than saying
-- so. The application check remains in place either way.
-- ---------------------------------------------------------------------------
do $do$
begin
  begin
    create unique index if not exists bookings_live_vin_unique
      on bookings (vin_norm)
      where vin_norm <> ''
        and status in ('pending_review', 'under_review', 'needs_client_action', 'confirmed');
  exception when others then
    raise warning
      'bookings_live_vin_unique NOT created (%). Resolve duplicate live bookings per chassis, then re-run this migration.',
      sqlerrm;
  end;
end
$do$;

-- ---------------------------------------------------------------------------
-- 4. Conversation sessions - where each chat is in the flow
--
-- The bot used to work out where it was by re-reading the transcript and the
-- flags on a draft row. That does not survive a model changing its mind, and it
-- cannot express "waiting for the invoice". This is the flow's own memory, and
-- it is in Postgres so a restart, a redeploy or a second worker picks it up
-- exactly where the last one left it.
--
-- context is for FLOW bookkeeping only - which prompt was last sent, a retry
-- count. Business data belongs in bookings / booking_documents, never here.
-- ---------------------------------------------------------------------------
create table if not exists conversation_sessions (
  id                  text primary key,          -- "telegram:12345"
  channel             text not null default 'telegram',
  telegram_chat_id    bigint,
  chat_id             text not null,
  client_id           bigint references clients(id),
  active_flow         text,                      -- booking | tracking | contact | null
  current_state       text not null default 'MAIN_MENU',
  active_booking_ref  text,
  context             jsonb not null default '{}'::jsonb,
  state_entered_at    timestamptz not null default now(),
  expires_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists conversation_sessions_chat_idx on conversation_sessions (chat_id);
create index if not exists conversation_sessions_state_idx on conversation_sessions (current_state, updated_at desc);

-- ---------------------------------------------------------------------------
-- 5. Operations tasks - the internal work queue
-- ---------------------------------------------------------------------------
create table if not exists operations_tasks (
  id                 bigint generated always as identity primary key,
  task_ref           text unique not null,
  task_type          text not null,
  booking_ref        text,
  mrn_request_id     bigint,
  client_id          bigint references clients(id),
  chat_id            text,
  channel            text default 'telegram',
  status             text not null default 'open',
  priority           text not null default 'normal',
  assigned_to        text,
  payload            jsonb not null default '{}'::jsonb,
  notes              text,
  -- Two identical tasks for one event is the thing a retry produces. A task
  -- names the event it came from, and the same event can only ever make one.
  idempotency_key    text unique,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  completed_at       timestamptz,
  completed_by       text
);

create index if not exists operations_tasks_queue_idx on operations_tasks (status, created_at asc);
create index if not exists operations_tasks_booking_idx on operations_tasks (booking_ref);

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'operations_tasks_status_check') then
    alter table operations_tasks add constraint operations_tasks_status_check
      check (status in ('open', 'in_progress', 'done', 'cancelled'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'operations_tasks_type_check') then
    alter table operations_tasks add constraint operations_tasks_type_check
      check (task_type in ('new_booking_request', 'mrn_request', 'document_review',
                           'client_callback', 'booking_confirmation', 'other'));
  end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- 6. MRN requests - the branch where MKY obtains the MRN for the client
--
-- The old schema had a single boolean, mrn_needed, and nothing behind it: no
-- record of what was asked for, who was working it, or what came back.
--
-- missing_information is deliberately data, not code. Nobody has told us which
-- fields Egyptian customs needs for an MRN application, and inventing a customs
-- requirement is exactly the failure this system must not have. The list comes
-- from bot_settings.required_mrn_documents, which MKY sets.
-- ---------------------------------------------------------------------------
create table if not exists mrn_requests (
  id                   bigint generated always as identity primary key,
  request_ref          text unique not null,
  booking_ref          text,
  client_id            bigint references clients(id),
  chat_id              text,
  vin                  text,
  status               text not null default 'draft',
  missing_information  jsonb not null default '[]'::jsonb,
  supplied_information jsonb not null default '{}'::jsonb,
  operations_notes     text,
  mrn_number           text,
  submitted_at         timestamptz,
  issued_at            timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  vin_norm             text generated always as
    (upper(regexp_replace(coalesce(vin, ''), '[^A-Za-z0-9]', '', 'g'))) stored
);

create index if not exists mrn_requests_booking_idx on mrn_requests (booking_ref);
create index if not exists mrn_requests_status_idx on mrn_requests (status, created_at desc);

-- One open MRN application per booking. A client tapping the button twice, or a
-- retried callback, must not put two applications on the customs desk.
create unique index if not exists mrn_requests_open_per_booking_idx
  on mrn_requests (booking_ref)
  where booking_ref is not null
    and status in ('draft', 'submitted', 'under_review', 'missing_information', 'approved');

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'mrn_requests_status_check') then
    alter table mrn_requests add constraint mrn_requests_status_check
      check (status in ('draft', 'submitted', 'under_review', 'missing_information',
                        'approved', 'issued', 'rejected', 'cancelled'));
  end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- 7. Documents - received is not verified
--
-- A file arriving proves a file arrived. It does not prove the invoice is for
-- this vehicle, is legible, or is an invoice at all. The bot may say "received";
-- only Operations may say "verified".
-- ---------------------------------------------------------------------------
alter table booking_documents add column if not exists client_id               bigint references clients(id);
alter table booking_documents add column if not exists telegram_file_id        text;
alter table booking_documents add column if not exists telegram_file_unique_id text;
alter table booking_documents add column if not exists telegram_message_id     bigint;
alter table booking_documents add column if not exists storage_bucket          text default 'booking-docs';
alter table booking_documents add column if not exists status                  text not null default 'received';
alter table booking_documents add column if not exists rejection_reason        text;
alter table booking_documents add column if not exists verified_at             timestamptz;
alter table booking_documents add column if not exists verified_by             text;
alter table booking_documents add column if not exists uploaded_by             text;
alter table booking_documents add column if not exists deleted_at              timestamptz;

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'booking_documents_status_check') then
    alter table booking_documents add constraint booking_documents_status_check
      check (status in ('received', 'pending_verification', 'verified', 'rejected', 'replacement_requested'));
  end if;
end
$do$;

-- Telegram's file_unique_id is stable for the same file. The same paper sent
-- twice into one conversation is one document, not two - the desk was reading
-- nine chips for three papers.
create unique index if not exists booking_documents_unique_file_idx
  on booking_documents (chat_id, telegram_file_unique_id)
  where telegram_file_unique_id is not null and deleted_at is null;

-- ---------------------------------------------------------------------------
-- 8. Notification outbox - nothing important is sent from inside a handler
--
-- Confirmation messages were sent inline, so a Telegram hiccup lost them
-- silently and a retried webhook sent them twice. Writing the intention down
-- first makes delivery a separate, retryable, exactly-once-per-event job.
-- ---------------------------------------------------------------------------
create table if not exists notification_outbox (
  id               bigint generated always as identity primary key,
  client_id        bigint references clients(id),
  channel          text not null default 'telegram',
  telegram_chat_id bigint,
  chat_id          text not null,
  event_type       text not null,
  entity_type      text,
  entity_id        text,
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'pending',
  attempt_count    int not null default 0,
  last_error       text,
  -- One event, one message. A webhook retry, a double click and a re-run of the
  -- drain all resolve to the same key, so the customer is told exactly once.
  idempotency_key  text unique not null,
  available_at     timestamptz not null default now(),
  sent_at          timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists notification_outbox_due_idx
  on notification_outbox (status, available_at);

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'notification_outbox_status_check') then
    alter table notification_outbox add constraint notification_outbox_status_check
      check (status in ('pending', 'sending', 'sent', 'failed', 'dead'));
  end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- 9. Audit log - who did what, to which record, when
--
-- Never document bodies, never secrets: metadata is for identifiers and
-- decisions, and the writing helper strips anything else.
-- ---------------------------------------------------------------------------
create table if not exists audit_logs (
  id          bigint generated always as identity primary key,
  actor_type  text not null,              -- client | operator | system
  actor_id    text,
  action      text not null,
  entity_type text,
  entity_id   text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_logs_entity_idx on audit_logs (entity_type, entity_id, created_at desc);
create index if not exists audit_logs_action_idx on audit_logs (action, created_at desc);

-- ---------------------------------------------------------------------------
-- 10. Bot settings - the business's values, not the programmer's
--
-- Everything here is something MKY may change without a deployment, and
-- everything here was previously either hard-coded or absent. The seeded values
-- are taken from what the existing code already did, EXCEPT the two marked
-- NEEDS BUSINESS CONFIRMATION, which nobody has told us and which must not be
-- guessed.
-- ---------------------------------------------------------------------------
create table if not exists bot_settings (
  key        text primary key,
  value      jsonb not null,
  note       text,
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into bot_settings (key, value, note) values
  ('required_booking_documents',
   '["invoice","brief","mrn"]'::jsonb,
   'Document types a client must send before a booking request may be submitted, when the client already holds the MRN. Matches the roadmap: Invoice, Brief, MRN.'),
  ('required_booking_documents_mky_mrn',
   '["invoice","brief"]'::jsonb,
   'Same list when MKY is obtaining the MRN: the client cannot supply an MRN they do not have.'),
  ('required_mrn_documents',
   '[]'::jsonb,
   'NEEDS BUSINESS CONFIRMATION. What MKY needs from a client to apply for an MRN on their behalf. Left empty deliberately: inventing a customs requirement is not acceptable. While empty, the MRN branch collects a free-text description and raises an Operations task.'),
  ('acid_required',
   'false'::jsonb,
   'NEEDS BUSINESS CONFIRMATION. Whether an ACID registration is required from the client at booking time, in addition to the MRN.'),
  ('allow_submit_while_mrn_pending',
   'true'::jsonb,
   'Whether a booking request may be submitted to Operations while MKY is still obtaining the MRN. True keeps the desk informed early; set false to hold the request until the MRN is issued.'),
  ('allowed_file_types',
   '["application/pdf","image/jpeg","image/png","image/webp","image/heic"]'::jsonb,
   'MIME types accepted as a booking document.'),
  ('max_upload_bytes',
   '20971520'::jsonb,
   '20 MB - the Telegram Bot API download ceiling, so anything larger cannot be fetched at all.'),
  ('draft_expiry_hours',
   '72'::jsonb,
   'An untouched draft booking is expired after this many hours.'),
  ('allow_unowned_shipment_tracking',
   'false'::jsonb,
   'Whether a shipment row with no owning chat or client may be tracked by anyone who quotes its reference. False is the safe production setting: it means a forwarded booking reference cannot be used to read another company''s route and schedule. Set true ONLY in a demo environment seeded with fictional shipments.'),
  ('operations_phone', 'null'::jsonb,
   'Falls back to the OPERATIONS_PHONE environment variable. Set here to change it without a deployment.'),
  ('operations_email', 'null'::jsonb,
   'Falls back to the OPS_EMAIL environment variable.'),
  ('human_support_hours', '"Sunday to Thursday, 09:00-17:00 Cairo time"'::jsonb,
   'Shown when a client asks to speak to a person outside working hours.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 11. Telegram idempotency - remember the outcome, not just the id
--
-- processed_updates recorded that an update was seen. It could not say whether
-- processing had finished, so an update that crashed halfway was never retried
-- and never reported.
-- ---------------------------------------------------------------------------
alter table processed_updates add column if not exists processed_at timestamptz not null default now();
alter table processed_updates add column if not exists status       text not null default 'processed';
alter table processed_updates add column if not exists error        text;
alter table processed_updates add column if not exists chat_id      text;

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'processed_updates_status_check') then
    alter table processed_updates add constraint processed_updates_status_check
      check (status in ('processing', 'processed', 'failed'));
  end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- 12. Claiming an update, atomically.
--
-- Two workers receiving the same retried update both ran `select` then `insert`
-- and both won. This does it in one statement: the insert either takes the row
-- or hits the primary key, and only the winner is told to process.
--
-- A row left in 'processing' by a crashed worker is reclaimable after a grace
-- period, so a genuine crash is retried instead of being lost for ever.
-- ---------------------------------------------------------------------------
create or replace function claim_telegram_update(
  p_update_id   bigint,
  p_chat_id     text default null,
  p_stale_after interval default interval '2 minutes'
)
returns boolean
language plpgsql
as $func$
declare
  claimed boolean := false;
begin
  insert into processed_updates (update_id, chat_id, status, processed_at)
  values (p_update_id, p_chat_id, 'processing', now())
  on conflict (update_id) do update
    set status = 'processing',
        processed_at = now()
    where processed_updates.status = 'failed'
       or (processed_updates.status = 'processing'
           and processed_updates.processed_at < now() - p_stale_after)
  returning true into claimed;

  return coalesce(claimed, false);
end;
$func$;

revoke execute on function claim_telegram_update(bigint, text, interval) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 13. Submitting a booking request, atomically.
--
-- The client tapping Confirm has to do several things that must all happen or
-- none: the request moves out of draft, a live-booking duplicate must not
-- exist, and Operations must get exactly one task. Done in the application in
-- three round trips, a double tap produced two tasks and a retry produced two
-- submissions. Done here, the second caller is simply told it already happened.
-- ---------------------------------------------------------------------------
create or replace function submit_booking_request(
  p_booking_ref text,
  p_chat_id     text,
  p_task_ref    text
)
returns jsonb
language plpgsql
as $func$
declare
  b            bookings%rowtype;
  clash_ref    text;
  task_rows    int := 0;
begin
  -- Lock this request for the duration, so a double tap queues behind itself.
  select * into b from bookings where booking_ref = p_booking_ref for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- The draft belongs to the conversation that made it. Nobody else submits it.
  if b.chat_id is distinct from p_chat_id then
    return jsonb_build_object('ok', false, 'reason', 'not_yours');
  end if;

  -- Already submitted: not an error, just nothing more to do. A retried
  -- callback lands here and the client sees one confirmation, not two.
  if b.status <> 'draft' then
    return jsonb_build_object('ok', true, 'already', true,
                              'status', b.status, 'booking_ref', b.booking_ref);
  end if;

  -- Someone else's live booking for the same chassis blocks this one. Checked
  -- inside the transaction, so it cannot be raced.
  select booking_ref into clash_ref
    from bookings
   where vin_norm = b.vin_norm
     and vin_norm <> ''
     and booking_ref <> b.booking_ref
     and status in ('pending_review', 'under_review', 'needs_client_action', 'confirmed')
   limit 1;

  if clash_ref is not null then
    return jsonb_build_object('ok', false, 'reason', 'duplicate', 'booking_ref', clash_ref);
  end if;

  update bookings
     set status              = 'pending_review',
         client_confirmed_at = now(),
         submitted_at        = now(),
         current_step        = 'BOOK_SUBMITTED'
   where booking_ref = p_booking_ref;

  insert into operations_tasks (task_ref, task_type, booking_ref, client_id, chat_id, channel,
                                status, priority, payload, idempotency_key)
  values (p_task_ref, 'new_booking_request', b.booking_ref, b.client_id, b.chat_id,
          coalesce(b.channel, 'telegram'), 'open', 'normal',
          jsonb_build_object('vin', b.vin, 'make', b.make, 'customer_name', b.customer_name,
                             'origin_port', b.origin_port, 'destination_port', b.destination_port),
          'booking_submitted:' || b.booking_ref)
  on conflict (idempotency_key) do nothing;

  get diagnostics task_rows = row_count;

  return jsonb_build_object('ok', true, 'already', false, 'booking_ref', b.booking_ref,
                            'task_created', task_rows > 0);
end;
$func$;

revoke execute on function submit_booking_request(text, text, text) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 14. Lock the new tables down, exactly like the existing ones: RLS on, no
--     policies. Only the service-role key, which is server-side only, reads
--     these. A leaked anon key sees nothing.
-- ---------------------------------------------------------------------------
alter table conversation_sessions enable row level security;
alter table operations_tasks      enable row level security;
alter table mrn_requests          enable row level security;
alter table notification_outbox   enable row level security;
alter table audit_logs            enable row level security;
alter table bot_settings          enable row level security;
