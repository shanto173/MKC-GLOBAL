-- ===========================================================================
-- Call-backs on the task list but not on the desk - 2026-10-08
--
-- NOT A MIGRATION, AND NOT RUN AUTOMATICALLY. Read it, run the SELECTs, then
-- run the rest by hand in the Supabase SQL editor.
--
-- Until the fix of 2026-10-08 a tap on "Talk to an agent" wrote only an
-- operations task (client_callback). The support ticket - which is what the
-- desk's call-back list shows - was written only when the customer typed their
-- problem. A customer who tapped and never typed was told "I have logged your
-- request" and is invisible on the desk; one real customer is in that state.
--
-- Section 1 opens the missing request for every such task still open and
-- points the task at it, exactly as the bot now does at the tap.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Taps with no request on the desk
-- ---------------------------------------------------------------------------

-- What would be opened. Nothing is written by this statement.
select t.task_ref, t.channel, t.chat_id, t.created_at, t.payload->>'phone_on_file' as phone_on_file
  from operations_tasks t
 where t.task_type = 'client_callback'
   and t.status in ('open', 'in_progress')
   and t.payload->>'ticket_ref' is null
   and t.chat_id is not null
   and not exists (
         select 1 from support_tickets s
          where s.chat_id = t.chat_id
            and s.created_at >= t.created_at - interval '5 minutes')
 order by t.created_at;

begin;

with missing as (
  select t.*
    from operations_tasks t
   where t.task_type = 'client_callback'
     and t.status in ('open', 'in_progress')
     and t.payload->>'ticket_ref' is null
     and t.chat_id is not null
     and not exists (
           select 1 from support_tickets s
            where s.chat_id = t.chat_id
              and s.created_at >= t.created_at - interval '5 minutes')
),
opened as (
  insert into support_tickets
    (ticket_ref, channel, chat_id, client_id, department, request_type, customer, contact, summary, status, created_at, status_changed_at)
  select 'MKY-TKT-' || to_char(m.created_at at time zone 'UTC', 'YYMMDD') || '-' || upper(substr(md5(m.task_ref), 1, 4)),
         case when m.chat_id like 'wa:%' then 'whatsapp' else coalesce(m.channel, 'telegram') end,
         m.chat_id,
         m.client_id,
         'Booking Operations',
         'booking',
         coalesce(c.whatsapp_name, c.display_name, c.full_name),
         coalesce(nullif(m.payload->>'phone_on_file', ''),
                  (case when m.chat_id like 'wa:%' then 'whatsapp' else coalesce(m.channel, 'telegram') end) || ':' || m.chat_id),
         -- The words the bot now writes on a request not yet described
         -- (lib/flow/contact.js AWAITING_DETAILS), so the next tap finds it.
         'Asked to speak to an agent - has not said what about yet.',
         'open',
         m.created_at,
         m.created_at
    from missing m
    left join clients c on c.id = m.client_id
  returning ticket_ref, chat_id, created_at
)
update operations_tasks t
   set payload = t.payload || jsonb_build_object('ticket_ref', o.ticket_ref, 'department', 'Booking Operations'),
       idempotency_key = 'ticket:' || o.ticket_ref,
       updated_at = now()
  from opened o
 where t.task_type = 'client_callback'
   and t.chat_id = o.chat_id
   and t.created_at = o.created_at;

-- Check before committing: every open call-back task now names its request.
select t.task_ref, t.chat_id, t.payload->>'ticket_ref' as ticket_ref, s.status, s.summary
  from operations_tasks t
  left join support_tickets s on s.ticket_ref = t.payload->>'ticket_ref'
 where t.task_type = 'client_callback' and t.status in ('open', 'in_progress')
 order by t.created_at;

commit;

