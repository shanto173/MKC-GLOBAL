-- ===========================================================================
-- Migration 003 - stop optional booking fields blocking a booking
--
-- bookings.origin_country was NOT NULL from the general-freight schema, but the
-- booking tool never required it: a customer says "from Vilnius", not "from
-- Lithuania". Every draft insert therefore failed on a constraint the customer
-- was never asked to satisfy, and the bot looped asking for a country it did
-- not need. The port is what matters operationally; the country is derived.
-- ===========================================================================

alter table bookings alter column origin_country drop not null;

-- Same reasoning: on Telegram we may never learn an email or phone, and the
-- chat itself is a valid way to reach the customer. The code still fills this
-- with "telegram:<chat id>" rather than leaving it empty.
alter table bookings alter column customer_contact drop not null;
