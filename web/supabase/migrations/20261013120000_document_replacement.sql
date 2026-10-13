-- ---------------------------------------------------------------------------
-- A second copy of a paper does not quietly take the first one's place.
--
-- One type may arrive twice - a clearer scan, the right vehicle's invoice
-- after the wrong one, or the same file sent again because the customer was
-- not sure it had arrived. The newest simply won: the booking changed under
-- Operations, a paper they had already checked stopped being the one the
-- booking used, and nobody was asked anything.
--
-- Now the second one waits ('pending_replace') while the customer is asked
-- whether it replaces the first, and their answer settles it: the old one
-- becomes 'replaced', or the new one becomes 'duplicate'. Both stay on file -
-- what was sent is a record, and a wrong answer has to be recoverable - and
-- neither counts towards what the booking still needs.
--
-- replaces_id already existed for this and was never written; it is what the
-- new row points at, so the desk can show what a paper came in place of.
-- ---------------------------------------------------------------------------

alter table booking_documents drop constraint if exists booking_documents_status_check;

alter table booking_documents add constraint booking_documents_status_check
  check (status = any (array[
    'received',
    'pending_verification',
    'verified',
    'rejected',
    'replacement_requested',
    -- Sent while we already held one of its type; waiting on the customer.
    'pending_replace',
    -- The customer said the newer one replaces this.
    'replaced',
    -- The customer said to keep the first one; this is the extra copy.
    'duplicate'
  ]));

comment on column booking_documents.replaces_id is
  'The document this one was sent to replace, once the customer has said so.';

-- The flow asks about these the moment they arrive, so it reads them by
-- booking and status on every file that lands in a chat with an open draft.
create index if not exists booking_documents_pending_replace_idx
  on booking_documents (booking_ref)
  where status = 'pending_replace';
