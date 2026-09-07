-- ===========================================================================
-- Migration 005 - a confirmed booking becomes a shipment
--
-- Roadmap step 4 has Operations "Create Booking in the system" after they
-- confirm. That step did not exist: a booking stayed a booking, and the
-- shipments table only ever held the demo rows. So a customer could book, be
-- confirmed, then track their own chassis and be told we had never heard of it.
--
-- Confirming now creates the shipment, and the shipment remembers which booking
-- it came from so either reference finds it.
-- ===========================================================================

alter table shipments add column if not exists booking_ref text;
alter table shipments add column if not exists chat_id     text;
alter table shipments add column if not exists channel     text;
alter table shipments add column if not exists model       text;
alter table shipments add column if not exists incoterm    text;
alter table shipments add column if not exists engine_condition text;

create index if not exists shipments_booking_ref_idx on shipments (booking_ref);

-- Shipment references are sequential rather than random, because operations
-- staff read them aloud, write them on paperwork and sort by them.
create sequence if not exists shipment_seq start with 26001;

create or replace function next_shipment_id(prefix text default 'MKY')
returns text language sql volatile as $func$
  select prefix || '-' || nextval('shipment_seq')::text;
$func$;

-- ---------------------------------------------------------------------------
-- Tracking a booking reference has to work even before a shipment exists, so
-- the customer who just booked can ask "where is it" and get a real answer.
-- ---------------------------------------------------------------------------
create or replace function find_shipments (
  q           text,
  match_count int default 5
)
returns setof shipments
language sql stable
as $func$
  select *
  from shipments s
  where upper(s.shipment_id) = upper(q)
     or upper(coalesce(s.booking_ref, ''))  = upper(q)
     or upper(coalesce(s.acid_id, ''))      = upper(q)
     or upper(coalesce(s.bl_number, ''))    = upper(q)
     or upper(coalesce(s.container_no, '')) = upper(q)
     or s.vin_norm = upper(regexp_replace(coalesce(q, ''), '[^A-Za-z0-9]', '', 'g'))
     or s.customer_name ilike '%' || q || '%'
  order by s.updated_at desc
  limit match_count;
$func$;

-- ---------------------------------------------------------------------------
-- Operations staff. Named so an audit trail says who confirmed what, rather
-- than every decision reading "operations". Authentication is still the shared
-- admin secret; this is attribution, not access control.
-- ---------------------------------------------------------------------------
create table if not exists ops_users (
  id         bigint generated always as identity primary key,
  name       text not null unique,
  role       text not null default 'operator',   -- operator | supervisor
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

alter table ops_users enable row level security;
