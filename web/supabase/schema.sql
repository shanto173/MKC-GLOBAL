-- ===========================================================================
-- MKC Global Logistics chatbot - Supabase schema
-- Run this once in: Supabase Dashboard -> SQL Editor -> New query -> Run
-- Safe to re-run (idempotent).
-- ===========================================================================

create extension if not exists vector;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- 1. Customers
-- ---------------------------------------------------------------------------
create table if not exists clients (
  id               bigint generated always as identity primary key,
  full_name        text not null,
  company          text,
  email            text,
  phone            text,
  telegram_user_id text unique,
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. Shipments  (the "live status" the bot reads from)
-- ---------------------------------------------------------------------------
create table if not exists shipments (
  shipment_id       text primary key,              -- e.g. MKC-24001
  acid_id           text unique,                   -- Egyptian ACID number
  bl_number         text,                          -- Bill of Lading
  container_no      text,
  customer_name     text not null,
  customer_email    text,
  customer_phone    text,
  origin_port       text not null,
  destination_port  text not null,
  mode              text default 'Sea FCL',
  status            text not null,
  mrn_status        text,
  payment_status    text,
  delivery_status   text,
  cargo_description text,
  gross_weight_kg   numeric,
  volume_cbm        numeric,
  vessel            text,
  etd               date,
  eta               date,
  updated_at        timestamptz not null default now()
);

create index if not exists shipments_customer_idx on shipments using gin (customer_name gin_trgm_ops);
create index if not exists shipments_acid_idx     on shipments (acid_id);

-- ---------------------------------------------------------------------------
-- 3. Shipment tracking events (milestone history)
-- ---------------------------------------------------------------------------
create table if not exists shipment_events (
  id          bigint generated always as identity primary key,
  shipment_id text not null references shipments(shipment_id) on delete cascade,
  event_time  timestamptz not null default now(),
  location    text,
  description text not null
);

create index if not exists shipment_events_ship_idx on shipment_events (shipment_id, event_time desc);

-- ---------------------------------------------------------------------------
-- 4. Bookings  (the bot WRITES here)
-- ---------------------------------------------------------------------------
create table if not exists bookings (
  id                bigint generated always as identity primary key,
  booking_ref       text unique not null,
  channel           text not null default 'telegram',
  chat_id           text,
  customer_name     text not null,
  customer_contact  text not null,               -- email or phone
  company           text,
  origin_country    text not null,
  origin_port       text not null,
  destination_port  text not null,
  cargo_description text not null,
  gross_weight_kg   numeric,
  volume_cbm        numeric,
  incoterm          text,
  ready_date        date,
  notes             text,
  status            text not null default 'pending_review',
  raw               jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists bookings_chat_idx on bookings (chat_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 5. Human handoff tickets
-- ---------------------------------------------------------------------------
create table if not exists support_tickets (
  id          bigint generated always as identity primary key,
  ticket_ref  text unique not null,
  channel     text not null default 'telegram',
  chat_id     text,
  department  text not null,
  customer    text,
  contact     text,
  summary     text not null,
  status      text not null default 'open',
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 6. RAG knowledge base (chunks from the company PDF / Excel / policies)
-- ---------------------------------------------------------------------------
create table if not exists documents (
  id         bigint generated always as identity primary key,
  source     text not null,          -- file name
  title      text,
  content    text not null,
  metadata   jsonb default '{}'::jsonb,
  embedding  vector(1536),           -- text-embedding-3-small
  fts        tsvector generated always as (to_tsvector('english', content)) stored,
  created_at timestamptz not null default now()
);

create index if not exists documents_fts_idx on documents using gin (fts);
-- IVFFlat only helps once rows exist; creating it early is harmless.
create index if not exists documents_embedding_idx
  on documents using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ---------------------------------------------------------------------------
-- 7. Conversation memory
-- ---------------------------------------------------------------------------
create table if not exists conversations (
  id         text primary key,       -- "telegram:12345" or "web:<uuid>"
  channel    text not null,
  chat_id    text not null,
  messages   jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 8. Telegram retry de-duplication
-- ---------------------------------------------------------------------------
create table if not exists processed_updates (
  update_id  bigint primary key,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Search functions
-- ---------------------------------------------------------------------------

-- Vector similarity search over the knowledge base.
create or replace function match_documents (
  query_embedding vector(1536),
  match_count     int default 5,
  min_similarity  float default 0.15
)
returns table (id bigint, source text, title text, content text, similarity float)
language sql stable
as $func$
  select d.id, d.source, d.title, d.content,
         1 - (d.embedding <=> query_embedding) as similarity
  from documents d
  where d.embedding is not null
    and 1 - (d.embedding <=> query_embedding) > min_similarity
  order by d.embedding <=> query_embedding
  limit match_count;
$func$;

-- Keyword fallback when no embedding key is configured.
create or replace function search_documents_fts (
  query_text  text,
  match_count int default 5
)
returns table (id bigint, source text, title text, content text, similarity float)
language sql stable
as $func$
  select d.id, d.source, d.title, d.content,
         ts_rank(d.fts, websearch_to_tsquery('english', query_text)) as similarity
  from documents d
  where d.fts @@ websearch_to_tsquery('english', query_text)
  order by similarity desc
  limit match_count;
$func$;

-- Fuzzy shipment lookup: matches shipment id, ACID, BL, container or customer.
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
     or s.customer_name ilike '%' || q || '%'
  order by s.updated_at desc
  limit match_count;
$func$;

-- ---------------------------------------------------------------------------
-- Row Level Security: lock everything down.
-- The server talks to Supabase with the service_role key, which bypasses RLS.
-- With RLS on and no policies, the public anon key can read nothing.
-- ---------------------------------------------------------------------------
alter table clients           enable row level security;
alter table shipments         enable row level security;
alter table shipment_events   enable row level security;
alter table bookings          enable row level security;
alter table support_tickets   enable row level security;
alter table documents         enable row level security;
alter table conversations     enable row level security;
alter table processed_updates enable row level security;
