-- ===========================================================================
-- Migration 004 - the life of a booking after the customer sends it
--
-- Roadmap steps 4 and 5: a request reaches Operations, someone checks it,
-- confirms or rejects it, and the customer is told. Until now a booking went
-- in as pending_review and nothing could move it, so the customer never heard
-- back from the system - only from a person, by email, if anyone remembered.
-- ===========================================================================

alter table bookings add column if not exists confirmed_at    timestamptz;
alter table bookings add column if not exists confirmed_by    text;   -- which operator
alter table bookings add column if not exists ops_notes       text;   -- why rejected, or what changed
alter table bookings add column if not exists customer_told_at timestamptz;
alter table bookings add column if not exists edit_history    jsonb default '[]'::jsonb;

-- Operations works a queue ordered by age, filtered by status.
create index if not exists bookings_status_created_idx on bookings (status, created_at desc);

-- ---------------------------------------------------------------------------
-- Statuses a booking can hold:
--   draft           the customer has not confirmed the summary yet
--   pending_review  sent to Operations, waiting for a human
--   confirmed       Operations accepted it; the customer has been told
--   rejected        Operations declined it, with a reason in ops_notes
--   cancelled       the customer withdrew it
-- Enforced here rather than in code so a bad value cannot reach the queue.
-- ---------------------------------------------------------------------------
do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_status_check') then
    alter table bookings add constraint bookings_status_check
      check (status in ('draft','pending_review','confirmed','rejected','cancelled'));
  end if;
end
$do$;
