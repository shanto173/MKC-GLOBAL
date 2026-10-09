-- ===========================================================================
-- Indexes for the reads the desk and the bot make most
--
-- Each index below names the read it serves. The tables are small today -
-- every one of these reads is a sequential scan of a few dozen rows and takes
-- under a millisecond - but several of them grow with every message ever
-- sent, and a sequential scan grows with them: the outbox, the chat log, the
-- audit trail. Measured and explained in docs/SYSTEM-DESIGN-DB-LOAD.md, which
-- has the query plans before and after at 10,000 bookings and 200,000
-- messages.
--
-- Already there and not repeated: bookings (chat_id, created_at),
-- booking_documents (booking_ref), chat_messages (channel, chat_id,
-- created_at) and the failed-message partial index, conversation_sessions
-- (chat_id), notification_outbox (status, available_at), operations_tasks
-- (status, created_at), support_tickets (status, created_at).
--
-- Additive and idempotent. CREATE INDEX (not CONCURRENTLY, which cannot run
-- inside the migration's transaction) briefly blocks writes to its table
-- while it builds: milliseconds at today's sizes. On a much larger table,
-- build it by hand with CONCURRENTLY first; IF NOT EXISTS then skips it here.
-- ===========================================================================

-- WhatsApp delivery receipts: three per message we send, each looking up the
-- outbox row by Meta's id (lib/outbox.js noteDeliveryStatus). Without this,
-- every receipt scans the whole outbox, which keeps every notification ever.
create index if not exists notification_outbox_provider_idx
  on notification_outbox (provider_message_id)
  where provider_message_id is not null;

-- The case page's "messages sent about this booking" (desk-case.js).
create index if not exists notification_outbox_entity_idx
  on notification_outbox (entity_id, created_at desc);

-- The inbox's failed and held notifications: status <> 'sent' cannot use the
-- (status, available_at) index, and nearly every row is 'sent'.
create index if not exists notification_outbox_unsent_idx
  on notification_outbox (created_at desc)
  where status <> 'sent';

-- Every WhatsApp message a customer sends releases what was held for them
-- (lib/outbox.js releaseHeld): pending rows of one chat.
create index if not exists notification_outbox_pending_chat_idx
  on notification_outbox (chat_id)
  where status = 'pending';

-- A case's history, "who changed this" on a refused action, and which failed
-- messages were retried: audit rows by entity, across entity types. The
-- existing index leads with entity_type, which these reads do not give.
create index if not exists audit_logs_entity_id_idx
  on audit_logs (entity_id, created_at desc);

-- Notes on a call-back or an MRN application (desk-case.js notesFor).
create index if not exists internal_notes_entity_idx
  on internal_notes (entity_id, created_at desc);

-- "Done today", and papers that arrived after a decision: the latest decided
-- bookings (desk-inbox.js). Partial: a booking without a decision time is in
-- neither.
create index if not exists bookings_decided_idx
  on bookings (confirmed_at desc)
  where confirmed_at is not null;

-- Call-backs finished today (desk-inbox.js), alongside the open ones: the
-- read is "open, or status changed today, or resolved today", and Postgres
-- can combine indexes for an OR only when every branch has one.
create index if not exists support_tickets_changed_idx
  on support_tickets (status_changed_at desc);
create index if not exists support_tickets_resolved_idx
  on support_tickets (resolved_at desc)
  where resolved_at is not null;

-- A chat's call-backs on its conversation and its case (desk-chat.js, desk-case.js).
create index if not exists support_tickets_chat_idx
  on support_tickets (chat_id, created_at desc);

-- The Chats list: the newest messages across every chat, and the sessions
-- of chats that have none logged (desk-chat.js chatsView).
create index if not exists chat_messages_recent_idx
  on chat_messages (created_at desc);
create index if not exists conversation_sessions_updated_idx
  on conversation_sessions (updated_at desc);

-- Shipments, newest first, a page at a time (desk-shipments.js).
create index if not exists shipments_updated_idx
  on shipments (updated_at desc, shipment_id desc);

-- The bot's pinned status card reads this chat's shipments, newest first
-- (lib/pinned.js activeItems), whenever the menu is drawn: a sequential scan
-- of shipments each time - the most-scanned table on the live database.
create index if not exists shipments_chat_idx
  on shipments (chat_id, updated_at desc)
  where chat_id is not null;

-- Whether a customer's message answers something the desk asked
-- (lib/answers.js waitingOn): this chat's applications missing information.
create index if not exists mrn_requests_chat_idx
  on mrn_requests (chat_id, status)
  where chat_id is not null;

-- WhatsApp's flood check and the per-chat queue (api/whatsapp.js): this
-- chat's messages of the last two minutes, on every message.
create index if not exists processed_whatsapp_messages_chat_idx
  on processed_whatsapp_messages (chat_id, processed_at desc);
