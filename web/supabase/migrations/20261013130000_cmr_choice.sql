-- ---------------------------------------------------------------------------
-- Whether MKY issues the CMR for this booking too.
--
-- MKY obtains the MRN and the EUR.1 - it needs the invoice and the Brief to do
-- it - and it has its own CMR. The customer is asked once, in the same
-- question as the MRN, because a booking is meant to take two or three steps:
--
--   MKY: MRN + CMR   -> mrn_choice = mky_issue, cmr_choice = mky_issue
--   MKY: MRN only    -> mrn_choice = mky_issue, cmr_choice = own
--   I have an MRN    -> mrn_choice = existing,  cmr_choice = own
--
-- null is a booking made before this was asked: nothing is claimed about it.
-- A CMR from the customer is proof the vehicle reached the port and is never
-- required to book, so nothing here gates a submission.
-- ---------------------------------------------------------------------------

alter table bookings add column if not exists cmr_choice text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_cmr_choice_check') then
    alter table bookings add constraint bookings_cmr_choice_check
      check (cmr_choice is null or cmr_choice in ('mky_issue', 'own'));
  end if;
end $$;

comment on column bookings.cmr_choice is
  'mky_issue when MKY issues the CMR for this booking; own when the customer arranges it.';
