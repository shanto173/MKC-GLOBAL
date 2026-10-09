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

-- The keys one row stands for. Read from the row as jsonb, so a column a
-- table does not have (yet) is null rather than an error. A lookup is made
-- only for an audit row that does not say its booking, and every cast is
-- guarded, so nothing here can fail the write that called it.
create or replace function desk_activity_keys(p_table text, p jsonb)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $func$
declare
  keys text[];
  ref text;
begin
  case p_table
    when 'bookings' then
      keys := array['bookings', 'booking:' || (p->>'booking_ref'), desk_chat_key(p->>'channel', p->>'chat_id')];
    when 'booking_documents' then
      keys := array['bookings', 'booking:' || (p->>'booking_ref')];
    when 'mrn_requests' then
      keys := array['bookings', 'mrn:' || (p->>'request_ref'), 'booking:' || (p->>'booking_ref')];
    when 'support_tickets' then
      keys := array['requests', 'request:' || (p->>'ticket_ref'), desk_chat_key(p->>'channel', p->>'chat_id')];
    when 'notification_outbox' then
      keys := array['outbox', case p->>'entity_type'
        when 'booking' then 'booking:' || (p->>'entity_id')
        when 'support_ticket' then 'request:' || (p->>'entity_id')
        when 'shipment' then 'shipment:' || (p->>'entity_id')
      end];
    when 'chat_messages' then
      keys := array['messages', desk_chat_key(p->>'channel', p->>'chat_id'),
        case when p->>'status' = 'failed' then 'problems' end];
    when 'conversation_sessions' then
      -- Where the customer is with the bot, and the WhatsApp window: shown on
      -- their conversation only.
      keys := array[desk_chat_key(p->>'channel', p->>'chat_id')];
    when 'audit_logs' then
      keys := array['history'];
      case p->>'entity_type'
        when 'problem' then
          keys := keys || 'problems'::text;
          -- A failed message sent again or set aside changes its conversation
          -- (the Retry button); a whole chat set aside is named by its key.
          if p->>'entity_id' like 'chat:%' then
            keys := keys || (p->>'entity_id');
          elsif p->>'entity_id' ~ '^message:[0-9]{1,18}$' then
            select desk_chat_key(m.channel, m.chat_id) into ref from chat_messages m
             where m.id = substr(p->>'entity_id', 9)::bigint;
            keys := keys || ref;
          end if;
        when 'booking' then
          keys := keys || ('booking:' || (p->>'entity_id'));
        when 'booking_document' then
          ref := p->'metadata'->>'booking_ref';
          if ref is null and p->>'entity_id' ~ '^[0-9]{1,18}$' then
            select d.booking_ref into ref from booking_documents d where d.id = (p->>'entity_id')::bigint;
          end if;
          keys := keys || ('booking:' || ref);
        when 'mrn_request' then
          ref := p->'metadata'->>'booking_ref';
          if ref is null then
            select m.booking_ref into ref from mrn_requests m where m.request_ref = p->>'entity_id';
          end if;
          keys := keys || ('mrn:' || (p->>'entity_id')) || ('booking:' || ref);
        when 'support_ticket' then
          keys := keys || ('request:' || (p->>'entity_id'));
        when 'shipment' then
          keys := keys || ('shipment:' || (p->>'entity_id'));
        else
          null;
      end case;
    when 'internal_notes' then
      keys := array['history', case
        when p->>'booking_ref' is not null then 'booking:' || (p->>'booking_ref')
        when p->>'entity_type' = 'support_ticket' then 'request:' || (p->>'entity_id')
        when p->>'entity_type' = 'mrn_request' then 'mrn:' || (p->>'entity_id')
      end];
    when 'clients' then
      keys := array['customers',
        desk_chat_key('whatsapp', 'wa:' || (p->>'whatsapp_id')),
        desk_chat_key('telegram', p->>'telegram_chat_id')];
    when 'shipments' then
      keys := array['shipments', 'shipment:' || (p->>'shipment_id'), 'booking:' || (p->>'booking_ref')];
    when 'shipment_events' then
      keys := array['shipments', 'shipment:' || (p->>'shipment_id')];
    when 'ops_users', 'bot_settings' then
      keys := array['team'];
    else
      keys := '{}';
  end case;
  return keys;
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
  keys text[];
  k text;
  marker text;
  seen text;
begin
  -- Writes nobody at the desk can see move nothing.
  if tg_op = 'UPDATE' then
    case tg_table_name
      -- The bot rewrites a draft on every answer the customer types; nobody
      -- at the desk is shown a draft until it is sent.
      when 'bookings' then
        if old.status = 'draft' and new.status = 'draft' then return null; end if;
      -- WhatsApp's delivered/read receipts on a message already sent.
      when 'notification_outbox' then
        if old.status = 'sent' and new.status = 'sent' then return null; end if;
      -- Every WhatsApp message refreshes the client's row with the same name
      -- and a new updated_at.
      when 'clients' then
        if (to_jsonb(old) - 'updated_at') = (to_jsonb(new) - 'updated_at') then return null; end if;
      -- Signing in stamps last_seen.
      when 'ops_users' then
        if (to_jsonb(old) - 'last_seen') = (to_jsonb(new) - 'last_seen') then return null; end if;
      else
        null;
    end case;
  end if;

  -- What the row stood for and what it stands for now: a paper moved from
  -- one booking to another changes both cases.
  keys := case tg_op
    when 'INSERT' then desk_activity_keys(tg_table_name, to_jsonb(new))
    when 'DELETE' then desk_activity_keys(tg_table_name, to_jsonb(old))
    else desk_activity_keys(tg_table_name, to_jsonb(new)) || desk_activity_keys(tg_table_name, to_jsonb(old))
  end;

  -- In name order, so two transactions never wait on each other's rows the
  -- other way round.
  for k in select distinct x from unnest(keys) as x where x is not null order by x loop
    -- Once per key per transaction. The trigger is per written row, and a
    -- statement that writes ten thousand rows (a clean-up, a backfill) would
    -- otherwise update the same counter ten thousand times inside one
    -- transaction - each update slower than the last, as the row's versions
    -- pile up. The keys already moved are kept in transaction-local settings
    -- (set_config(..., true)), gone at commit - spread over 64 of them, so a
    -- connection that lives for days does not collect a setting per record.
    marker := 'desk_activity.b' || (hashtext(k) & 63);
    seen := coalesce(current_setting(marker, true), '');
    continue when position('|' || k || '|' in seen) > 0;
    begin
      insert into desk_activity as a (scope, version) values (k, 1)
      on conflict (scope) do update set version = a.version + 1, changed_at = now();
      perform set_config(marker, seen || '|' || k || '|', true);
    exception when others then
      -- lock_not_available after 250 ms, or anything else: the write goes on.
      null;
    end;
  end loop;
  return null;
end
$func$;

revoke execute on function desk_activity_touch() from anon, authenticated;
revoke execute on function desk_activity_keys(text, jsonb) from anon, authenticated;

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
