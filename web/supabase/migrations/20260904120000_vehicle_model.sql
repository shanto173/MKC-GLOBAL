-- ===========================================================================
-- Migration 002 - vehicle-centric model
--
-- The business is used commercial vehicle import into Egypt, so the unit of
-- work is a VEHICLE identified by its VIN / chassis number, not a cargo
-- description. A booking is "move this VIN from A to B", and the paperwork
-- (invoice, MRN, EUR.1, ACID) all hangs off that same VIN.
--
-- Additive and idempotent: existing tables and rows are left alone.
-- Run in: Supabase Dashboard -> SQL Editor -> New query -> Run
-- Expected result: "Success. No rows returned".
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Vehicles - the thing being shipped
-- ---------------------------------------------------------------------------
create table if not exists vehicles (
  vin              text primary key,          -- chassis / VIN, e.g. W1T96340310484233
  make             text,                      -- Mercedes-Benz
  model            text,                      -- Actros 1845
  vehicle_type     text,                      -- truck / tractor unit / trailer / car
  year             int,
  colour           text,
  engine_condition text,                      -- e.g. "damaged engine", read off the invoice
  gross_weight_kg  numeric,
  value_amount     numeric,
  value_currency   text,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. Normalised VIN columns
--
-- Customers type a VIN with spaces, dashes and lower case. Rather than an RPC,
-- each table carries a generated column so the bot can filter on it directly
-- (vin_norm=eq.W1T96340310484233) and the index is used.
--
-- The expression is inlined rather than wrapped in a function so the column
-- stays valid even if someone later redefines that function.
-- ---------------------------------------------------------------------------
alter table vehicles add column if not exists vin_norm text
  generated always as (upper(regexp_replace(coalesce(vin, ''), '[^A-Za-z0-9]', '', 'g'))) stored;
create index if not exists vehicles_vin_norm_idx on vehicles (vin_norm);
create index if not exists vehicles_make_idx on vehicles using gin (make gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 3. Link shipments and bookings to a vehicle
-- ---------------------------------------------------------------------------
alter table shipments add column if not exists vin text;
alter table shipments add column if not exists make text;
alter table shipments add column if not exists model text;
alter table shipments add column if not exists vin_norm text
  generated always as (upper(regexp_replace(coalesce(vin, ''), '[^A-Za-z0-9]', '', 'g'))) stored;
create index if not exists shipments_vin_norm_idx on shipments (vin_norm);

alter table bookings add column if not exists vin text;
alter table bookings add column if not exists make text;
alter table bookings add column if not exists model text;
alter table bookings add column if not exists mrn_number text;
alter table bookings add column if not exists acid_number text;
alter table bookings add column if not exists eur1_number text;
alter table bookings add column if not exists mrn_needed boolean default false;
alter table bookings add column if not exists language text default 'en';
alter table bookings add column if not exists documents_complete boolean default false;
alter table bookings add column if not exists vin_norm text
  generated always as (upper(regexp_replace(coalesce(vin, ''), '[^A-Za-z0-9]', '', 'g'))) stored;
create index if not exists bookings_vin_norm_idx on bookings (vin_norm);

-- Cargo description was required in the general-freight model. A vehicle
-- booking identifies its cargo by VIN instead, so it must be optional now.
alter table bookings alter column cargo_description drop not null;

-- ---------------------------------------------------------------------------
-- 4. Uploaded documents
-- ---------------------------------------------------------------------------
create table if not exists booking_documents (
  id              bigint generated always as identity primary key,
  booking_ref     text,                        -- may arrive before the booking exists
  chat_id         text,
  channel         text default 'telegram',
  vin             text,
  doc_type        text not null,               -- invoice | mrn | eur1 | acid | brief | other
  file_name       text,
  storage_path    text,                        -- path in Supabase Storage
  mime_type       text,
  size_bytes      bigint,
  extracted       jsonb default '{}'::jsonb,   -- structured fields read out of it
  extraction_ok   boolean default false,
  needs_ocr       boolean default false,       -- scanned image, no text layer
  uploaded_at     timestamptz not null default now(),
  vin_norm        text generated always as
    (upper(regexp_replace(coalesce(vin, ''), '[^A-Za-z0-9]', '', 'g'))) stored
);

create index if not exists booking_documents_ref_idx  on booking_documents (booking_ref);
create index if not exists booking_documents_chat_idx on booking_documents (chat_id, uploaded_at desc);
create index if not exists booking_documents_vin_idx  on booking_documents (vin_norm);

-- ---------------------------------------------------------------------------
-- 5. Lock the new tables down, same as the rest.
-- ---------------------------------------------------------------------------
alter table vehicles          enable row level security;
alter table booking_documents enable row level security;

-- ---------------------------------------------------------------------------
-- 6. Teach the shipment search about VINs.
--
-- Customers track a truck by its chassis number far more often than by our
-- internal reference, and they type it with spaces and lower case.
-- Replaces the version from schema.sql; "returns setof shipments" now also
-- carries the vin/make/model columns added above.
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
     or upper(coalesce(s.acid_id, ''))      = upper(q)
     or upper(coalesce(s.bl_number, ''))    = upper(q)
     or upper(coalesce(s.container_no, '')) = upper(q)
     or s.vin_norm = upper(regexp_replace(coalesce(q, ''), '[^A-Za-z0-9]', '', 'g'))
     or s.customer_name ilike '%' || q || '%'
  order by s.updated_at desc
  limit match_count;
$func$;
