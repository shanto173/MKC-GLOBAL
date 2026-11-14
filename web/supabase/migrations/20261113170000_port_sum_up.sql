-- ===========================================================================
-- Port Sum Up + Team MKY
--
-- Port Sum Up lists bookings once origin, destination and VIN are known
-- (even as drafts, before documents). Funds amount/status live on the booking.
-- Team MKY is an internal chat with @mentions of a customer name or chassis.
-- ===========================================================================

alter table bookings add column if not exists port_amount numeric;
alter table bookings add column if not exists port_funds_status text not null default 'not_received';

do $do$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_port_funds_status_check'
  ) then
    alter table bookings add constraint bookings_port_funds_status_check
      check (port_funds_status in ('not_received', 'received', 'in_process'));
  end if;
end
$do$;

create index if not exists bookings_port_sum_idx
  on bookings (created_at desc, booking_ref)
  where vin is not null and origin_port is not null and destination_port is not null
    and status not in ('cancelled', 'expired', 'rejected');

create table if not exists team_messages (
  id          bigint generated always as identity primary key,
  author      text not null,
  body        text not null,
  mentions    jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);

alter table team_messages enable row level security;
revoke all on team_messages from anon, authenticated;
grant select, insert on team_messages to service_role;

create index if not exists team_messages_created_idx on team_messages (created_at desc, id desc);

-- Port Sum Up shows drafts once ports + VIN are set; bump then (and when
-- funds/assignee change on a listable draft). Other draft typing stays quiet.
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
  listable boolean;
  was_listable boolean;
begin
  -- Writes nobody at the desk can see move nothing.
  if tg_op = 'UPDATE' then
    case tg_table_name
      -- The bot rewrites a draft on every answer the customer types; nobody
      -- at the desk is shown a draft until it is sent.
      when 'bookings' then
        -- Except once it is one of Port Sum Up’s: a draft that has from-port,
        -- to-port and a chassis is on that list while the papers are still
        -- coming. So the moment it becomes one, and every later change to
        -- what the list shows of it, moves the desk; the rest of the bot’s
        -- typing into a draft still moves nothing.
        if old.status = 'draft' and new.status = 'draft' then
          listable := nullif(btrim(coalesce(new.vin, '')), '') is not null
            and nullif(btrim(coalesce(new.origin_port, '')), '') is not null
            and nullif(btrim(coalesce(new.destination_port, '')), '') is not null;
          was_listable := nullif(btrim(coalesce(old.vin, '')), '') is not null
            and nullif(btrim(coalesce(old.origin_port, '')), '') is not null
            and nullif(btrim(coalesce(old.destination_port, '')), '') is not null;
          if not listable then return null; end if;
          if was_listable
            and old.assigned_to is not distinct from new.assigned_to
            and old.port_amount is not distinct from new.port_amount
            and old.port_funds_status is not distinct from new.port_funds_status
            and old.customer_name is not distinct from new.customer_name
            and old.vin is not distinct from new.vin
            and old.origin_port is not distinct from new.origin_port
            and old.destination_port is not distinct from new.destination_port
          then return null; end if;
        end if;
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
      -- The conversation shows each paper beside the message that brought it.
      ref := desk_chat_key(p->>'channel', p->>'chat_id');
      -- One of ours, filed with no chat: the conversation it was sent from is its booking's.
      if ref is null and p->>'doc_type' = 'mky' and p->>'booking_ref' is not null then
        select desk_chat_key(b.channel, b.chat_id) into ref from bookings b where b.booking_ref = p->>'booking_ref';
      end if;
      keys := array['bookings', 'booking:' || (p->>'booking_ref'), ref];
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
    when 'team_messages' then
      -- What a colleague wrote to the team is part of what the desk has
      -- written down; Team MKY is read with the history area.
      keys := array['history'];
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

-- Team MKY messages move the history area, like a note on a case does.
do $do$
begin
  if to_regclass('public.team_messages') is not null then
    drop trigger if exists desk_activity on public.team_messages;
    create trigger desk_activity after insert or update or delete on public.team_messages
      for each row execute function desk_activity_touch();
  end if;
end
$do$;
