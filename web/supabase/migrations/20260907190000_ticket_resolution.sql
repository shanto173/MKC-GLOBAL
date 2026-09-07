-- ===========================================================================
-- Migration 007 - support tickets can be resolved
--
-- A ticket had a status column and nothing else: no record of who closed it,
-- when, or what they did. The operations desk now works tickets from the
-- console, so a resolution needs somewhere to live and the customer needs to
-- be told.
--
-- Additive and idempotent. Run in: Supabase Dashboard -> SQL Editor -> Run.
-- The code works before this is applied (status alone is updated) and records
-- the extra detail once it is.
-- ===========================================================================

alter table support_tickets add column if not exists resolved_at     timestamptz;
alter table support_tickets add column if not exists resolved_by     text;      -- which operator
alter table support_tickets add column if not exists resolution_note text;      -- what was done, sent to the customer
alter table support_tickets add column if not exists customer_told_at timestamptz;

create index if not exists support_tickets_status_idx on support_tickets (status, created_at desc);
