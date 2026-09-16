-- ---------------------------------------------------------------------------
-- The booking in three steps, and an agent right away.
--
-- MKY's workflow, as given: step 1 the client's name and a number to call,
-- step 2 the vehicle and its papers, step 3 the booking with the reference
-- the client keeps. Anything else goes to an agent right away - and after
-- 7 PM the bot says when the desk is back and gives the direct number for
-- anything that cannot wait.
--
-- Nothing structural changes: bookings.customer_contact already holds the
-- number and clients.phone already exists. What this adds is the four
-- business values behind the after-hours message, in bot_settings so the desk
-- can change them without a deployment.
-- ---------------------------------------------------------------------------

insert into bot_settings (key, value, note) values
  ('direct_phone', 'null'::jsonb,
   'The direct line read out to a client who asks for a person outside working hours, for anything urgent. Falls back to the DIRECT_PHONE environment variable, then to the operations phone. Null, with neither set, means no number is read out - never an invented one.'),
  ('support_hours_start', '9'::jsonb,
   'Hour of the day, 0-23, from which an agent answers. 9 is 9 AM.'),
  ('support_hours_end', '19'::jsonb,
   'Hour of the day, 0-23, until which an agent answers. 19 is 7 PM; a client asking for a person from then on is told the desk is back at support_hours_start.'),
  ('support_timezone', '"Africa/Cairo"'::jsonb,
   'IANA timezone the two hours above are read in.')
on conflict (key) do nothing;

-- The human-readable hours line, brought in line with the two numbers above -
-- but only where it is still the illustration the original seed shipped, so a
-- value the desk has already changed is left alone.
update bot_settings
   set value = '"Every day, 09:00-19:00 Cairo time"'::jsonb,
       updated_at = now(),
       updated_by = 'migration'
 where key = 'human_support_hours'
   and value = '"Sunday to Thursday, 09:00-17:00 Cairo time"'::jsonb;
