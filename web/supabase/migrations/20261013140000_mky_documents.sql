-- ---------------------------------------------------------------------------
-- The papers MKY issues itself: the CMR, and the MRN declaration sheet.
--
-- Until now every document in the system was one a customer sent us. These are
-- the other direction: a form Operations fills in, saves, comes back to, and
-- issues as a PDF when it is right.
--
-- WHY A FORM THAT IS SAVED BEFORE IT IS ISSUED.
--
-- A CMR is filled in from six places - the invoice, the Brief, the booking, the
-- loading address, the carrier, the terminal - and the person doing it is
-- interrupted. A form that only existed while a dialog was open meant starting
-- again. `fields` holds what has been typed so far; `status` says whether it is
-- still a draft or has been issued; and issuing writes the PDF to storage and
-- files it against the booking, where it is listed, opened and printed like any
-- other paper.
--
-- One of each kind per booking. Issuing again replaces the PDF and keeps the
-- same document number, because a CMR number that changed under a driver who
-- already has a copy is worse than no number at all.
-- ---------------------------------------------------------------------------

create table if not exists mky_documents (
  id          bigint generated always as identity primary key,
  booking_ref text not null,
  kind        text not null check (kind in ('cmr', 'mrn')),
  -- What has been typed into the form, by field key (lib/mky-docs.js).
  fields      jsonb not null default '{}'::jsonb,
  status      text not null default 'draft' check (status in ('draft', 'issued')),
  -- The number printed on the paper. Kept across re-issues.
  document_no text,
  storage_path text,
  issued_at   timestamptz,
  issued_by   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (booking_ref, kind)
);

alter table mky_documents enable row level security;

create index if not exists mky_documents_booking_idx on mky_documents (booking_ref);

comment on table mky_documents is
  'Papers MKY issues: a CMR, an MRN declaration sheet. Filled in at the desk, saved as a draft, issued as a PDF.';
