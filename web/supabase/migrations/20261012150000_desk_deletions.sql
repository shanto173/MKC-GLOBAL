-- ---------------------------------------------------------------------------
-- An administrator can delete a record, and take it back for thirty days.
--
-- WHY A LEDGER RATHER THAN A deleted_at COLUMN ON EVERY TABLE.
--
-- The desk reads bookings, tickets, shipments, chats and documents from two
-- dozen queries spread over the inbox, the counts, the chats list, search, the
-- case page and the activity pulse. Hiding a deleted record by adding
-- "deleted_at is null" to each of them means one forgotten query shows data
-- somebody asked us to erase - the exact failure this feature exists to
-- prevent. So a deletion really deletes the rows, and the rows are kept here,
-- whole, until they are purged.
--
-- payload is an array of { table, rows }, in the order the rows were deleted:
-- children first, the thing itself last. Restoring walks it backwards, so a
-- parent row is back before the rows that point at it.
--
-- files is what is still in the storage bucket: a deletion leaves the objects
-- alone so a restore can find them, and the purge removes them (the desk does
-- that - Postgres cannot reach the bucket).
--
-- The audit trail is NOT part of any payload. "Sara confirmed MKY-BKG-2 on
-- Tuesday" is a record of what a person did, not the customer's data, and a
-- deletion that quietly erased its own history would be the wrong tool.
-- ---------------------------------------------------------------------------

create table if not exists deleted_records (
  id          bigint generated always as identity primary key,
  kind        text not null,                      -- booking | request | mrn | shipment | customer | person
  reference   text not null,                      -- MKY-BKG-2, the person's name, the client id
  label       text,                               -- what to show in the list
  summary     jsonb not null default '{}'::jsonb, -- { bookings: 1, chat_messages: 41, files: 3 }
  payload     jsonb not null default '[]'::jsonb, -- [{ table, rows: [...] }], children first
  files       jsonb not null default '[]'::jsonb, -- [{ bucket, path }], removed at purge
  deleted_by  text not null,
  deleted_at  timestamptz not null default now(),
  purge_after timestamptz not null,
  restored_at timestamptz,
  restored_by text
);

alter table deleted_records enable row level security;

create index if not exists deleted_records_due_idx on deleted_records (purge_after) where restored_at is null;
create index if not exists deleted_records_recent_idx on deleted_records (deleted_at desc);

-- ---------------------------------------------------------------------------
-- Putting one back.
--
-- In SQL rather than in the desk because every id in this database is
-- `generated always as identity`, and a row only goes back under the id it
-- had - the documents, notes and messages that point at it were kept with the
-- numbers they were written with. Only INSERT ... OVERRIDING SYSTEM VALUE may
-- say so, and PostgREST has no way to.
--
-- A row that is somehow already there is left as it is rather than failing the
-- restore: two tables of a customer's history are worth more than an
-- all-or-nothing rule about the one row somebody re-created by hand.
-- ---------------------------------------------------------------------------

create or replace function restore_deleted_record(record_id bigint)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  rec     deleted_records%rowtype;
  part    jsonb;
  tbl     text;
  cols    text;
  item    jsonb;
  put     int;
  done    jsonb := '{}'::jsonb;
begin
  select * into rec from deleted_records where id = record_id for update;
  if not found then
    raise exception 'There is no deleted record %', record_id using errcode = 'no_data_found';
  end if;
  if rec.restored_at is not null then
    raise exception 'That was already put back on %', rec.restored_at using errcode = 'invalid_parameter_value';
  end if;

  -- Backwards: the thing itself was deleted last, so it goes back first, and
  -- the rows that point at it follow.
  for part in
    select value from jsonb_array_elements(rec.payload) with ordinality as t(value, n) order by n desc
  loop
    tbl := part ->> 'table';
    if tbl is null or to_regclass(format('public.%I', tbl)) is null then
      continue;
    end if;
    -- The columns that may be written, named one by one.
    --
    -- `select *` cannot be used: vin_norm and its like are GENERATED ALWAYS,
    -- and Postgres refuses any value for them at all - OVERRIDING SYSTEM VALUE
    -- covers identity columns and nothing else. They are left out and computed
    -- again from the row being put back, which is what they were in the first
    -- place. (attgenerated = '' is "not generated"; 's' is stored.)
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum)
      into cols
      from pg_attribute a
     where a.attrelid = format('public.%I', tbl)::regclass
       and a.attnum > 0 and not a.attisdropped and a.attgenerated = '';
    if cols is null then
      continue;
    end if;

    put := 0;
    for item in select value from jsonb_array_elements(coalesce(part -> 'rows', '[]'::jsonb)) loop
      execute format(
        'insert into public.%I (%s) overriding system value '
        'select %s from jsonb_populate_record(null::public.%I, $1) as r on conflict do nothing', tbl, cols, cols, tbl)
        using item;
      put := put + 1;
    end loop;
    done := done || jsonb_build_object(tbl, put);
  end loop;

  update deleted_records set restored_at = now() where id = record_id;
  return done;
end;
$$;
