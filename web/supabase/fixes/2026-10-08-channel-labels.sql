-- ===========================================================================
-- Rows labelled with the wrong channel - 2026-10-08
--
-- NOT A MIGRATION, AND NOT RUN AUTOMATICALLY. Read it, run the SELECT, then
-- run the rest by hand in the Supabase SQL editor.
--
-- createTask() defaulted channel to 'telegram' whenever its caller passed
-- none. Two callers never did - the MRN request task (lib/mrn.js) and the
-- confirm-booking task (lib/admin/console.js) - so every such task for a
-- WhatsApp booking says Telegram. beginDocument(), createDraft() and the
-- document reply claim had the same default, and the desk read a missing
-- channel as Telegram in a dozen places. The code now takes the channel from
-- the chat id when none is given: "wa:..." is WhatsApp, a whole number is
-- Telegram, anything else is the website widget.
--
-- A WhatsApp chat id always starts "wa:", so a row with one and any other
-- channel is mislabelled - nothing else is touched here. The website block at
-- the end is separate, and commented out: review it before running it.
-- ===========================================================================

-- What is mislabelled, table by table. Nothing is written by this statement.
select 'operations_tasks'    as table_name, count(*) from operations_tasks    where chat_id like 'wa:%' and channel is distinct from 'whatsapp'
union all
select 'support_tickets',                   count(*) from support_tickets     where chat_id like 'wa:%' and channel is distinct from 'whatsapp'
union all
select 'notification_outbox',               count(*) from notification_outbox where chat_id like 'wa:%' and (channel is distinct from 'whatsapp' or telegram_chat_id is not null)
union all
select 'booking_documents',                 count(*) from booking_documents   where chat_id like 'wa:%' and channel is distinct from 'whatsapp'
union all
select 'bookings',                          count(*) from bookings            where chat_id like 'wa:%' and channel is distinct from 'whatsapp'
union all
select 'shipments',                         count(*) from shipments           where chat_id like 'wa:%' and channel is distinct from 'whatsapp'
union all
select 'chat_messages',                     count(*) from chat_messages       where chat_id like 'wa:%' and channel is distinct from 'whatsapp'
union all
select 'conversation_sessions',             count(*) from conversation_sessions where chat_id like 'wa:%' and channel is distinct from 'whatsapp';

begin;

update operations_tasks
   set channel = 'whatsapp', updated_at = now()
 where chat_id like 'wa:%' and channel is distinct from 'whatsapp';

update support_tickets
   set channel = 'whatsapp'
 where chat_id like 'wa:%' and channel is distinct from 'whatsapp';

-- A pending row labelled Telegram would be sent to Telegram and fail; labelled
-- WhatsApp it goes out on WhatsApp at the next drain (inside the window, or as
-- its template). A WhatsApp number is never a Telegram chat id.
update notification_outbox
   set channel = 'whatsapp', telegram_chat_id = null, updated_at = now()
 where chat_id like 'wa:%' and (channel is distinct from 'whatsapp' or telegram_chat_id is not null);

update booking_documents
   set channel = 'whatsapp'
 where chat_id like 'wa:%' and channel is distinct from 'whatsapp';

-- The draft's placeholder contact carried the channel too ("telegram:wa:…").
update bookings
   set channel = 'whatsapp',
       customer_contact = case when customer_contact = 'telegram:' || chat_id then 'whatsapp:' || chat_id else customer_contact end
 where chat_id like 'wa:%' and channel is distinct from 'whatsapp';

update shipments
   set channel = 'whatsapp'
 where chat_id like 'wa:%' and channel is distinct from 'whatsapp';

-- Expected to be zero: the transports always said which channel they were.
update chat_messages
   set channel = 'whatsapp'
 where chat_id like 'wa:%' and channel is distinct from 'whatsapp';

-- Run the SELECT at the top again: every count should now be 0.

commit;

-- ---------------------------------------------------------------------------
-- The website widget (optional - review first)
--
-- Its chat ids are the browser's session id, a UUID, never a whole number. A
-- task or document from it was labelled Telegram the same way. Telegram chat
-- ids are always whole numbers, so this cannot catch a Telegram row.
-- ---------------------------------------------------------------------------

-- select 'operations_tasks' as table_name, task_ref as ref, chat_id from operations_tasks
--  where channel = 'telegram' and chat_id is not null and chat_id !~ '^-?[0-9]+$' and chat_id not like 'wa:%'
-- union all
-- select 'booking_documents', id::text, chat_id from booking_documents
--  where channel = 'telegram' and chat_id is not null and chat_id !~ '^-?[0-9]+$' and chat_id not like 'wa:%';
--
-- begin;
-- update operations_tasks set channel = 'web', updated_at = now()
--  where channel = 'telegram' and chat_id is not null and chat_id !~ '^-?[0-9]+$' and chat_id not like 'wa:%';
-- update booking_documents set channel = 'web'
--  where channel = 'telegram' and chat_id is not null and chat_id !~ '^-?[0-9]+$' and chat_id not like 'wa:%';
-- commit;
