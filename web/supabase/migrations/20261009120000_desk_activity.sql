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
-- anything I am showing changed?". One row per area of the desk, whose
-- version goes up whenever a row it shows is written. The desk reads the
-- nine rows (GET ?view=pulse), and fetches a screen again only when one of
-- that screen's versions moved (docs/SYSTEM-DESIGN-DB-LOAD.md).
--
-- WHY TRIGGERS, AND WHY A ROW RATHER THAN A SEQUENCE. The bot writes these
-- tables from a dozen places; a trigger cannot be forgotten by the next one.
-- A counter row is transactional: its new version becomes visible in the same
-- instant as the write that caused it. A sequence would be lock-free, but its
-- new value is visible before the write commits - a desk reading the pulse in
-- that moment would fetch the old data, remember the new version, and show
-- the old data until something else changed.
--
-- NEVER AT THE EXPENSE OF A CUSTOMER'S WRITE. The bump waits at most 250 ms
-- for its row (lock_timeout) and is skipped on any error, so a busy or broken
-- signal costs the desk freshness - bounded by its 5-minute full refresh -
-- and never costs the bot a write. Rows are bumped in name order, so two
-- transactions never wait on each other's counters the other way round, and
-- each scope at most once per transaction, so a statement that writes ten
-- thousand rows costs one bump, not ten thousand.
--
-- Scopes, and what bumps them:
--   bookings   bookings (not a draft being typed), booking_documents, mrn_requests
--   requests   support_tickets
--   outbox     notification_outbox (not receipts on a message already sent)
--   messages   chat_messages
--   problems   chat_messages turning failed or no longer failed, audit_logs about a problem
--   history    audit_logs, internal_notes
--   customers  clients (not an update that only touches updated_at)
--   shipments  shipments, shipment_events
--   team       ops_users (not last_seen alone), bot_settings
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

create or replace function desk_activity_touch()
returns trigger
language plpgsql
security definer
set search_path = public
set lock_timeout = '250ms'
as $func$
declare
  scopes text[];
  s text;
begin
  case tg_table_name
    when 'bookings' then
      -- The bot rewrites a draft on every answer the customer types; nobody
      -- at the desk is shown a draft until it is sent.
      if tg_op = 'UPDATE' and old.status = 'draft' and new.status = 'draft' then return null; end if;
      scopes := array['bookings'];
    when 'booking_documents', 'mrn_requests' then
      scopes := array['bookings'];
    when 'support_tickets' then
      scopes := array['requests'];
    when 'notification_outbox' then
      -- WhatsApp's delivered/read receipts on a message already sent.
      if tg_op = 'UPDATE' and old.status = 'sent' and new.status = 'sent' then return null; end if;
      scopes := array['outbox'];
    when 'chat_messages' then
      scopes := array['messages'];
      if (tg_op <> 'DELETE' and new.status = 'failed') or (tg_op <> 'INSERT' and old.status = 'failed') then
        scopes := scopes || 'problems'::text;
      end if;
    when 'audit_logs' then
      scopes := array['history'];
      if (tg_op <> 'DELETE' and new.entity_type = 'problem') or (tg_op <> 'INSERT' and old.entity_type = 'problem') then
        scopes := scopes || 'problems'::text;
      end if;
    when 'internal_notes' then
      scopes := array['history'];
    when 'clients' then
      -- Every WhatsApp message refreshes the client's row with the same name
      -- and a new updated_at; that is not a change anybody can see.
      if tg_op = 'UPDATE' and (to_jsonb(old) - 'updated_at') = (to_jsonb(new) - 'updated_at') then return null; end if;
      scopes := array['customers'];
    when 'shipments', 'shipment_events' then
      scopes := array['shipments'];
    when 'ops_users' then
      -- Signing in stamps last_seen.
      if tg_op = 'UPDATE' and (to_jsonb(old) - 'last_seen') = (to_jsonb(new) - 'last_seen') then return null; end if;
      scopes := array['team'];
    when 'bot_settings' then
      scopes := array['team'];
    else
      return null;
  end case;

  -- Every list above is written in name order, so two transactions never
  -- wait on each other's rows the other way round.
  foreach s in array scopes loop
    -- Once per scope per transaction. The trigger is per row, and a statement
    -- that writes ten thousand rows (a clean-up, a backfill) would otherwise
    -- update this one row ten thousand times inside one transaction - each
    -- update slower than the last, as the row's versions pile up. The marker
    -- is transaction-local (set_config(..., true)) and gone at commit.
    continue when current_setting('desk_activity.' || s, true) = 'bumped';
    begin
      update desk_activity set version = version + 1, changed_at = now() where scope = s;
      perform set_config('desk_activity.' || s, 'bumped', true);
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
    'chat_messages', 'audit_logs', 'internal_notes', 'clients', 'shipments', 'shipment_events',
    'ops_users', 'bot_settings'
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
