-- ===========================================================================
-- Migration 009 - the operations console
--
-- Migration 008 gave the desk a work queue. This gives it the things an
-- operator needs to run a shift: who owns a request, how urgent it is, how
-- long it has been theirs, and whether the client has come back.
--
-- Additive and idempotent. No existing column is dropped, and every default is
-- chosen so rows written before this migration read correctly after it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Ownership, priority, and the clock
--
-- "Has someone else already handled this?" is the question a shared queue
-- cannot answer without these columns, and two people working the same request
-- is the most expensive kind of duplicated effort here - both of them talk to
-- the client.
-- ---------------------------------------------------------------------------
alter table bookings add column if not exists assigned_to        text;
alter table bookings add column if not exists assigned_at        timestamptz;
alter table bookings add column if not exists assigned_by        text;
alter table bookings add column if not exists priority           text not null default 'normal';

-- When the status last moved. Ageing is measured from this, not from
-- created_at: a request that came back from the client this morning has been
-- the desk's problem for an hour, not for three days.
alter table bookings add column if not exists status_changed_at  timestamptz;
alter table bookings add column if not exists client_responded_at timestamptz;

-- Set once for rows that predate the column, so ageing is not measured from
-- the epoch on every historic request.
update bookings
   set status_changed_at = coalesce(submitted_at, created_at)
 where status_changed_at is null;

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_priority_check') then
    alter table bookings add constraint bookings_priority_check
      check (priority in ('normal', 'high', 'urgent'));
  end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- 2. The clock, kept by the database
--
-- Several things move a booking's status: the client's own flow, the console,
-- and the submit function. Setting status_changed_at in each of them means
-- forgetting it in one of them, and the symptom is a queue that quietly reports
-- the wrong waiting time - which is worse than no waiting time at all, because
-- people believe it.
-- ---------------------------------------------------------------------------
create or replace function touch_booking_status_changed()
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

drop trigger if exists bookings_status_changed on bookings;
create trigger bookings_status_changed
  before update on bookings
  for each row
  execute function touch_booking_status_changed();

-- ---------------------------------------------------------------------------
-- 3. Staff, with roles that mean something
--
-- ops_users held a name and a free-text role used only for attribution. The
-- role is now a closed list the server checks before it will perform an action,
-- because a permission enforced only by hiding a button is not a permission.
-- ---------------------------------------------------------------------------
alter table ops_users add column if not exists email      text;
alter table ops_users add column if not exists created_by text;
alter table ops_users add column if not exists last_seen  timestamptz;

-- Existing rows carry role 'operator'; map it onto the new vocabulary before
-- the constraint is applied, or the migration fails on real data.
update ops_users set role = 'ops_agent'      where role in ('operator', 'agent');
update ops_users set role = 'ops_supervisor' where role in ('supervisor');
update ops_users set role = 'admin'          where role in ('administrator');
update ops_users set role = 'ops_agent'
 where role is null or role not in ('ops_agent', 'ops_supervisor', 'admin', 'read_only');

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'ops_users_role_check') then
    alter table ops_users add constraint ops_users_role_check
      check (role in ('ops_agent', 'ops_supervisor', 'admin', 'read_only'));
  end if;
end
$do$;

create unique index if not exists ops_users_email_idx on ops_users (lower(email)) where email is not null;

-- ---------------------------------------------------------------------------
-- 4. Tasks the console can actually work
-- ---------------------------------------------------------------------------
alter table operations_tasks add column if not exists title       text;
alter table operations_tasks add column if not exists next_action text;
alter table operations_tasks add column if not exists due_at      timestamptz;
alter table operations_tasks add column if not exists shipment_id text;

-- The task types the console raises. Added to the existing list rather than
-- replacing it, so tasks written by migration 008's code stay valid.
do $do$
begin
  if exists (select 1 from pg_constraint where conname = 'operations_tasks_type_check') then
    alter table operations_tasks drop constraint operations_tasks_type_check;
  end if;
  alter table operations_tasks add constraint operations_tasks_type_check
    check (task_type in (
      'new_booking_request', 'mrn_request', 'document_review', 'client_callback',
      'booking_confirmation', 'review_booking', 'create_booking',
      'client_action_response', 'update_shipment', 'other'
    ));
end
$do$;

-- ---------------------------------------------------------------------------
-- 5. Document review
--
-- `status` and `rejection_reason` arrived in 008. What was missing is the
-- reason as a CODE rather than prose, so the console can offer the same short
-- list every time and a report can count them.
-- ---------------------------------------------------------------------------
alter table booking_documents add column if not exists rejection_code   text;
alter table booking_documents add column if not exists reviewed_at      timestamptz;
alter table booking_documents add column if not exists replaces_id      bigint references booking_documents(id);

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'booking_documents_reject_code_check') then
    alter table booking_documents add constraint booking_documents_reject_code_check
      check (rejection_code is null or rejection_code in
        ('unreadable', 'wrong_document', 'incomplete', 'wrong_vin', 'wrong_client', 'expired', 'other'));
  end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- 6. Internal notes
--
-- Kept apart from client messages on purpose, and in their own table rather
-- than a column on the booking, so that "who said what, when" survives and no
-- code path can accidentally hand one to Telegram: the notifier reads the
-- outbox, and nothing in the outbox comes from here.
-- ---------------------------------------------------------------------------
create table if not exists internal_notes (
  id          bigint generated always as identity primary key,
  booking_ref text,
  entity_type text not null default 'booking',
  entity_id   text,
  author      text not null,
  body        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists internal_notes_booking_idx on internal_notes (booking_ref, created_at desc);
alter table internal_notes enable row level security;

-- ---------------------------------------------------------------------------
-- 7. Indexes the queue needs
--
-- The console filters and sorts on these on every page load. Without them the
-- queue is a sequential scan that gets slower every week.
-- ---------------------------------------------------------------------------
create index if not exists bookings_queue_idx        on bookings (status, priority, status_changed_at);
create index if not exists bookings_assigned_idx     on bookings (assigned_to, status) where assigned_to is not null;
create index if not exists bookings_updated_idx      on bookings (created_at desc);
create index if not exists bookings_ref_idx          on bookings (booking_ref);
create index if not exists mrn_requests_open_idx     on mrn_requests (status, created_at);
create index if not exists tasks_assigned_open_idx   on operations_tasks (assigned_to, status, created_at);
create index if not exists documents_review_idx      on booking_documents (status, uploaded_at desc);
create index if not exists support_tickets_open_idx  on support_tickets (status, created_at desc);

-- ---------------------------------------------------------------------------
-- 8. SLA thresholds, and the console's own settings
--
-- Marked as placeholders. Nobody at MKY has told us how long a new request may
-- sit before it is late, and a number invented here would be presented to
-- operators as company policy.
-- ---------------------------------------------------------------------------
insert into bot_settings (key, value, note) values
  ('sla_new_request_hours', '2'::jsonb,
   'PLACEHOLDER - confirm with MKY. Hours a new request may wait before the console marks it overdue. Counted only while Operations owns it.'),
  ('sla_review_hours', '4'::jsonb,
   'PLACEHOLDER - confirm with MKY. Hours a request may stay Under Review before it is marked overdue.'),
  ('sla_mrn_hours', '8'::jsonb,
   'PLACEHOLDER - confirm with MKY. Hours an MRN application may wait.'),
  ('console_realtime', 'true'::jsonb,
   'Whether the console subscribes to live updates.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 9. The queue, as one query.
--
-- Everything the console's main screen shows, assembled in Postgres rather than
-- by the browser fetching bookings and then a document count per row. The
-- console pages this; it must never pull the whole table down and filter in
-- JavaScript.
-- ---------------------------------------------------------------------------
create or replace view booking_queue as
select
  b.booking_ref,
  b.status,
  b.priority,
  b.assigned_to,
  b.assigned_at,
  b.vin,
  b.make,
  b.model,
  b.customer_name,
  b.company,
  b.origin_port,
  b.destination_port,
  b.mrn_choice,
  b.mrn_number,
  b.chat_id,
  b.channel,
  b.client_id,
  b.created_at,
  b.submitted_at,
  b.status_changed_at,
  b.client_responded_at,
  b.confirmed_at,
  b.confirmed_by,
  b.ops_notes,
  b.needs_client_action,
  -- Documents attached to this request, counted by state so the queue can show
  -- "2/3" without a second round trip per row.
  coalesce(d.received, 0)  as documents_received,
  coalesce(d.verified, 0)  as documents_verified,
  coalesce(d.rejected, 0)  as documents_rejected,
  m.request_ref            as mrn_request_ref,
  m.status                 as mrn_status,
  s.shipment_id,
  s.status                 as shipment_status
from bookings b
left join lateral (
  select
    count(*) filter (where bd.status in ('received', 'pending_verification', 'verified')) as received,
    count(*) filter (where bd.status = 'verified')                                        as verified,
    count(*) filter (where bd.status in ('rejected', 'replacement_requested'))            as rejected
  from booking_documents bd
  where bd.booking_ref = b.booking_ref and bd.deleted_at is null
) d on true
left join lateral (
  select mr.request_ref, mr.status
  from mrn_requests mr
  where mr.booking_ref = b.booking_ref
  order by mr.created_at desc
  limit 1
) m on true
left join lateral (
  select sh.shipment_id, sh.status
  from shipments sh
  where sh.booking_ref = b.booking_ref
  limit 1
) s on true;

-- A view inherits the RLS of the tables beneath it in Postgres 15+, and every
-- one of those has RLS on with no policies. Revoked from the browser-facing
-- roles as well, belt and braces: only the service key reads this.
revoke all on booking_queue from anon, authenticated;
