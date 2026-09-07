-- ===========================================================================
-- Migration 010 - client requests, in the console
--
-- support_tickets was a place to write down that somebody wanted a call. The
-- console works it as a queue, which needs the same three things a booking
-- needed: who owns it, how urgent it is, and how long it has been theirs.
--
-- Additive and idempotent.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Ownership and urgency
-- ---------------------------------------------------------------------------
alter table support_tickets add column if not exists assigned_to       text;
alter table support_tickets add column if not exists assigned_at       timestamptz;
alter table support_tickets add column if not exists priority          text not null default 'normal';
alter table support_tickets add column if not exists status_changed_at timestamptz;
alter table support_tickets add column if not exists booking_ref       text;
alter table support_tickets add column if not exists request_type      text;
alter table support_tickets add column if not exists client_id         bigint references clients(id);

update support_tickets
   set status_changed_at = coalesce(status_changed_at, created_at)
 where status_changed_at is null;

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'support_tickets_priority_check') then
    alter table support_tickets add constraint support_tickets_priority_check
      check (priority in ('normal', 'high', 'urgent'));
  end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- 2. The statuses a request actually moves through
--
-- open/resolved was too coarse to run a desk from: an operator could not tell
-- a request nobody had touched from one somebody was already on the phone
-- about. The old two values remain legal, so every existing row and the
-- existing endpoint keep working.
-- ---------------------------------------------------------------------------
do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'support_tickets_status_check') then
    alter table support_tickets add constraint support_tickets_status_check
      check (status in ('open', 'assigned', 'in_progress', 'waiting_client', 'resolved', 'closed'));
  end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- 3. The clock, kept by the database, for the same reason bookings have one:
--    several things move a status and one of them will forget.
-- ---------------------------------------------------------------------------
create or replace function touch_ticket_status_changed()
returns trigger
language plpgsql
as $func$
begin
  if new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  return new;
end;
$func$;

drop trigger if exists support_tickets_status_changed on support_tickets;
create trigger support_tickets_status_changed
  before update on support_tickets
  for each row
  execute function touch_ticket_status_changed();

-- ---------------------------------------------------------------------------
-- 4. Which desk a request belongs to, as a type the console can group by.
--
-- Derived from the department for rows written before this column existed, so
-- the queue is not empty for everything raised so far.
-- ---------------------------------------------------------------------------
update support_tickets
   set request_type = case department
     when 'Booking Operations'    then 'booking'
     when 'Tracking Desk'         then 'tracking'
     when 'Customs Documentation' then 'documents'
     when 'Accounts & Payments'   then 'accounts'
     else 'other'
   end
 where request_type is null;

create index if not exists support_tickets_queue_idx on support_tickets (status, priority, status_changed_at);
create index if not exists support_tickets_assigned_idx on support_tickets (assigned_to, status) where assigned_to is not null;
create index if not exists support_tickets_booking_idx on support_tickets (booking_ref) where booking_ref is not null;

-- ---------------------------------------------------------------------------
-- 5. Shipments: who last touched them, so the timeline names a person.
-- ---------------------------------------------------------------------------
alter table shipment_events add column if not exists operator text;
alter table shipment_events add column if not exists source   text default 'operations';

-- ---------------------------------------------------------------------------
-- 6. The client-request queue, assembled in Postgres.
--
-- Same reasoning as booking_queue: the console must not fetch tickets and then
-- a booking per row to find out which vehicle a caller is ringing about.
-- ---------------------------------------------------------------------------
create or replace view client_request_queue as
select
  t.ticket_ref,
  t.status,
  t.priority,
  t.assigned_to,
  t.assigned_at,
  t.department,
  coalesce(t.request_type, 'other') as request_type,
  t.customer,
  t.contact,
  t.summary,
  t.channel,
  t.chat_id,
  t.client_id,
  t.booking_ref,
  t.created_at,
  t.status_changed_at,
  t.resolved_at,
  t.resolved_by,
  t.resolution_note,
  t.customer_told_at,
  b.vin           as booking_vin,
  b.status        as booking_status,
  b.customer_name as booking_client,
  c.display_name  as client_display_name,
  c.telegram_username
from support_tickets t
left join bookings b on b.booking_ref = t.booking_ref
left join clients  c on c.id = t.client_id;

revoke all on client_request_queue from anon, authenticated;
