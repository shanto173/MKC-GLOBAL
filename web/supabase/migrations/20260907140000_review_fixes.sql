-- ===========================================================================
-- Migration 006 - fixes from the Phase 6 review
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Stop customer-facing search returning other customers' rows.
--
-- find_shipments ended with `customer_name ilike '%' || q || '%'`, and it is
-- called by the customer-facing tracking tool with whatever the customer typed.
-- Typing the single letter "a" returned five other customers, complete with
-- their email addresses, into the model's context.
--
-- Three separate holes are closed here:
--   * name matching is opt-in, and only the admin console asks for it
--   * LIKE metacharacters are escaped, so "%" no longer matches everyone
--   * an empty or punctuation-only query matches nothing. It used to match
--     plenty: `coalesce(booking_ref,'') = ''` is true for every row without a
--     booking reference, and a query of punctuation normalises to the empty
--     string, which equalled the vin_norm of every row without a VIN.
--
-- The signature gains a parameter, so the old two-argument function is dropped
-- first; two-argument callers bind to the new one and get the safe default.
-- ---------------------------------------------------------------------------
drop function if exists find_shipments(text, int);

create or replace function find_shipments (
  q             text,
  match_count   int default 5,
  include_names boolean default false
)
returns setof shipments
language sql stable
as $func$
  select *
  from shipments s
  where length(btrim(coalesce(q, ''))) > 0
    and (
         -- No coalesce to '' here: that made rows with a NULL reference match
         -- an empty query. A NULL comparison yields NULL, which is correct.
            upper(s.shipment_id)  = upper(btrim(q))
         or upper(s.booking_ref)  = upper(btrim(q))
         or upper(s.acid_id)      = upper(btrim(q))
         or upper(s.bl_number)    = upper(btrim(q))
         or upper(s.container_no) = upper(btrim(q))
         or (
              length(regexp_replace(coalesce(q, ''), '[^A-Za-z0-9]', '', 'g')) >= 6
              and s.vin_norm = upper(regexp_replace(q, '[^A-Za-z0-9]', '', 'g'))
            )
         or (
              include_names
              and length(btrim(coalesce(q, ''))) >= 3
              and s.customer_name ilike
                  '%' || replace(replace(replace(btrim(q), chr(92), chr(92) || chr(92)), '%', chr(92) || '%'), '_', chr(92) || '_') || '%'
            )
        )
  order by s.updated_at desc
  limit match_count;
$func$;

-- ---------------------------------------------------------------------------
-- 2. One booking, one shipment - enforced by the database.
--
-- createShipmentFromBooking checked for an existing row and then inserted, with
-- nothing between the two. Two operators confirming at the same moment both saw
-- "none" and both inserted, so one truck got two shipment references and the
-- customer got two different "confirmed, track it with..." messages.
--
-- Worse, that check used maybeSingle(), which returns null once more than one
-- row matches - so after a single double-click the guard was defeated forever
-- and every later confirm added another shipment.
-- ---------------------------------------------------------------------------
create unique index if not exists shipments_booking_ref_unique
  on shipments (booking_ref)
  where booking_ref is not null;

-- ---------------------------------------------------------------------------
-- 3. The sequence is not the public's to spend.
--
-- next_shipment_id touches no RLS-protected table, so with Supabase's default
-- grants the browser-exposed anon key could call it over PostgREST and burn
-- reference numbers. It cannot create a shipment, but it can make ours jump.
-- ---------------------------------------------------------------------------
revoke execute on function next_shipment_id(text) from anon, authenticated;
revoke all on sequence shipment_seq from anon, authenticated;
