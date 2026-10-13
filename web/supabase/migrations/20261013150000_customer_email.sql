-- ---------------------------------------------------------------------------
-- Where a booking's confirmation is emailed.
--
-- The confirmation email has existed all along and almost never went anywhere:
-- it looked for an address in customer_contact, which holds the phone number.
-- There was nowhere to put an email, so there was never one to find.
--
-- Asked for after the request has been submitted, never before - it is not a
-- condition of booking - and only two emails are ever sent to it: the
-- confirmation when Operations confirms, and the notice when the shipment
-- reaches the destination port.
-- ---------------------------------------------------------------------------

alter table bookings add column if not exists customer_email text;

comment on column bookings.customer_email is
  'Where this booking''s confirmation and delivery notice are emailed. Asked for after submission; null means the chat is the only channel.';
