-- ===========================================================================
-- The desk's change signal - desk_activity
--
-- The desk kept its screens true by asking for all of them again every 20
-- seconds: the inbox alone was some twenty reads, and the sidebar's counts
-- recomputed the same inbox a second time. Ten people with the desk open is
-- over a thousand PostgREST transactions a minute, on the same small pool the
-- bot's writes have to get through.
--
-- This table is what lets the desk ask one cheap question instead: "has
-- anything I am showing changed?". Each row is a version that goes up
-- whenever something it stands for is written:
--
--   an AREA of the desk, for the lists - nine rows:
--     bookings   bookings (not a draft being typed), booking_documents, mrn_requests
--     requests   support_tickets
--     outbox     notification_outbox (not receipts on a message already sent)
--     messages   chat_messages
--     problems   chat_messages turning failed or no longer failed, audit_logs about a problem
--     history    audit_logs, internal_notes
--     customers  clients (not an update that only touches updated_at)
--     shipments  shipments, shipment_events
--     team       ops_users (not last_seen alone), bot_settings
--
--   ONE RECORD, for the pages that show one - a row per record, made the
--   first time it is written:
--     booking:<ref>     the booking, its papers, its MRN application, its notes,
--                       its history, its notifications, its shipment
--     request:<ref>     the call-back, its notes, history and notifications
--     mrn:<ref>         the MRN application and its history
--     shipment:<id>     the shipment, its events, its history and notifications
--     chat:<channel>:<chat id>   the conversation: its messages, the session
--                       (where the customer is with the bot, the WhatsApp window),
--                       the customer's row, the chat's bookings and call-backs
--
-- The desk reads the rows it needs (GET ?view=pulse&watch=…) and fetches a
-- screen again only when one of them moved (docs/SYSTEM-DESIGN-DB-LOAD.md).
-- A case page open on one booking is not fetched again because another
-- booking moved.
--
-- WHY TRIGGERS, AND WHY A ROW RATHER THAN A SEQUENCE. The bot writes these
-- tables from a dozen places; a trigger cannot be forgotten by the next one.
-- A counter row is transactional: its new version becomes visible in the same
-- instant as the write that caused it. A sequence would be lock-free, but its
-- new value is visible before the write commits - a desk reading the pulse in
-- that moment would fetch the old data, remember the new version, and show
-- the old data until something else changed.
--
-- NEVER AT THE EXPENSE OF A CUSTOMER'S WRITE. A bump waits at most 250 ms
-- for its row (lock_timeout) and is skipped on any error, so a busy or broken
-- signal costs the desk freshness - bounded by its 5-minute full refresh -
-- and never costs the bot a write. A transaction bumps its rows in name
-- order, so two never wait on each other's counters the other way round, and
-- each row at most once, so a statement that writes ten thousand rows costs
-- a bump per row it stands for, not ten thousand.
--
-- Additive and idempotent. The desk works without it (it falls back to
-- timed refreshes), so code and migration may go out in either order.
-- ===========================================================================

create table if not exists desk_activity (
  scope      text primary key,
  version    bigint not null default 0,
  changed_at timestamptz not null default now()
);

alter table desk_activity enable row level security;
revoke all on desk_activity from anon, authenticated;
grant select on desk_activity to service_role;

insert into desk_activity (scope) values
  ('bookings'), ('customers'), ('history'), ('messages'), ('outbox'),
  ('problems'), ('requests'), ('shipments'), ('team')
on conflict (scope) do nothing;

-- The conversation a row belongs to, as the desk names it (public/desk/live.js
-- chatKey): the channel its chat id says - "wa:…" is WhatsApp, a whole number
-- Telegram - whatever the row's channel column says, because older rows were
-- written with 'telegram' for WhatsApp chats (supabase/fixes/2026-10-08-
-- channel-labels.sql); the column only for any other chat id.
create or replace function desk_chat_key(p_channel text, p_chat_id text)
returns text
language sql
immutable
as $func$
  select case when nullif(p_chat_id, '') is null then null else
    'chat:' || case when p_chat_id like 'wa:%' then 'whatsapp'
                    when p_chat_id ~ '^-?[0-9]+$' then 'telegram'
                    else coalesce(nullif(p_channel, ''), 'web') end
            || ':' || p_chat_id
  end
$func$;

create or replace function desk_activity_touch()
returns trigger
language plpgsql
security definer
set search_path = public
set lock_timeout = '250ms'
as $func$
declare
  r record;
  keys text[];
  k text;
  ref text;
begin
  -- The row as it is now; for a delete, as it was.
  if tg_op = 'DELETE' then r := old; else r := new; end if;

  case tg_table_name
    when 'bookings' then
      -- The bot rewrites a draft on every answer the customer types; nobody
      -- at the desk is shown a draft until it is sent.
      if tg_op = 'UPDATE' and old.status = 'draft' and new.status = 'draft' then return null; end if;
      keys := array['bookings', 'booking:' || r.booking_ref, desk_chat_key(r.channel, r.chat_id)];
    when 'booking_documents' then
      keys := array['bookings', 'booking:' || r.booking_ref];
    when 'mrn_requests' then
      keys := array['bookings', 'mrn:' || r.request_ref, 'booking:' || r.booking_ref];
    when 'support_tickets' then
      keys := array['requests', 'request:' || r.ticket_ref, desk_chat_key(r.channel, r.chat_id)];
    when 'notification_outbox' then
      -- WhatsApp's delivered/read receipts on a message already sent.
      if tg_op = 'UPDATE' and old.status = 'sent' and new.status = 'sent' then return null; end if;
      keys := array['outbox', case r.entity_type
        when 'booking' then 'booking:' || r.entity_id
        when 'support_ticket' then 'request:' || r.entity_id
        when 'shipment' then 'shipment:' || r.entity_id
      end];
    when 'chat_messages' then
      keys := array['messages', desk_chat_key(r.channel, r.chat_id)];
      if (tg_op <> 'DELETE' and new.status = 'failed') or (tg_op <> 'INSERT' and old.status = 'failed') then
        keys := keys || 'problems'::text;
      end if;
    when 'conversation_sessions' then
      -- Where the customer is with the bot, and the WhatsApp window: shown on
      -- their conversation only.
      keys := array[desk_chat_key(r.channel, r.chat_id)];
    when 'audit_logs' then
      keys := array['history'];
      if r.entity_type = 'problem' then keys := keys || 'problems'::text; end if;
      if r.entity_type = 'booking' then
        keys := keys || ('booking:' || r.entity_id);
      elsif r.entity_type = 'booking_document' then
        ref := r.metadata->>'booking_ref';
        if ref is null and r.entity_id ~ '^[0-9]+$' then
          select d.booking_ref into ref from booking_documents d where d.id = r.entity_id::bigint;
        end if;
        keys := keys || ('booking:' || ref);
      elsif r.entity_type = 'mrn_request' then
        ref := r.metadata->>'booking_ref';
        if ref is null then select m.booking_ref into ref from mrn_requests m where m.request_ref = r.entity_id; end if;
        keys := keys || ('mrn:' || r.entity_id) || ('booking:' || ref);
      elsif r.entity_type = 'support_ticket' then
        keys := keys || ('request:' || r.entity_id);
      elsif r.entity_type = 'shipment' then
        keys := keys || ('shipment:' || r.entity_id);
      end if;
    when 'internal_notes' then
      keys := array['history', case
        when r.booking_ref is not null then 'booking:' || r.booking_ref
        when r.entity_type = 'support_ticket' then 'request:' || r.entity_id
        when r.entity_type = 'mrn_request' then 'mrn:' || r.entity_id
      end];
    when 'clients' then
      -- Every WhatsApp message refreshes the client's row with the same name
      -- and a new updated_at; that is not a change anybody can see.
      if tg_op = 'UPDATE' and (to_jsonb(old) - 'updated_at') = (to_jsonb(new) - 'updated_at') then return null; end if;
      keys := array['customers',
        desk_chat_key('whatsapp', 'wa:' || (to_jsonb(r)->>'whatsapp_id')),
        desk_chat_key('telegram', to_jsonb(r)->>'telegram_chat_id')];
    when 'shipments' then
      keys := array['shipments', 'shipment:' || r.shipment_id, 'booking:' || r.booking_ref];
    when 'shipment_events' then
      keys := array['shipments', 'shipment:' || r.shipment_id];
    when 'ops_users' then
      -- Signing in stamps last_seen.
      if tg_op = 'UPDATE' and (to_jsonb(old) - 'last_seen') = (to_jsonb(new) - 'last_seen') then return null; end if;
      keys := array['team'];
    when 'bot_settings' then
      keys := array['team'];
    else
      return null;
  end case;

  for k in select distinct x from unnest(keys) as x where x is not null order by x loop
    -- Once per row per transaction. The trigger is per written row, and a
    -- statement that writes ten thousand rows (a clean-up, a backfill) would
    -- otherwise update the same counter ten thousand times inside one
    -- transaction - each update slower than the last, as the row's versions
    -- pile up. The marker is transaction-local (set_config(..., true)).
    continue when current_setting('desk_activity.k' || md5(k), true) = '1';
    begin
      insert into desk_activity as a (scope, version) values (k, 1)
      on conflict (scope) do update set version = a.version + 1, changed_at = now();
      perform set_config('desk_activity.k' || md5(k), '1', true);
    exception when others then
      -- lock_not_available after 250 ms, or anything else: the write goes on.
      null;
    end;
  end loop;
  return null;
end
$func$;

revoke execute on function desk_activity_touch() from anon, authenticated;

do $do$
declare
  t text;
begin
  foreach t in array array[
    'bookings', 'booking_documents', 'mrn_requests', 'support_tickets', 'notification_outbox',
    'chat_messages', 'conversation_sessions', 'audit_logs', 'internal_notes', 'clients',
    'shipments', 'shipment_events', 'ops_users', 'bot_settings'
  ] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('drop trigger if exists desk_activity on public.%I', t);
      execute format(
        'create trigger desk_activity after insert or update or delete on public.%I '
        'for each row execute function desk_activity_touch()', t);
    end if;
  end loop;
end
$do$;
