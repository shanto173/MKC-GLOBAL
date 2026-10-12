-- ---------------------------------------------------------------------------
-- Operations takes a chat over, and the bot stops answering it.
--
-- Until now the desk told the truth plainly: "the bot keeps answering;
-- replying here does not pause it." A colleague typing an answer and the bot
-- typing a different one into the same conversation is the worst thing this
-- system can do to a customer, and the only way out was to be quick.
--
-- WHY ON clients AND NOT ON conversation_sessions.
--
-- The session is the bot's own scratch state, keyed channel:chat_id, and a
-- customer who sends "reset" deletes it (api/whatsapp.js, handleReset). A hold
-- that disappeared because the customer cleared their side would put the bot
-- back into a conversation a person is in the middle of - silently, and at the
-- worst possible moment. The customer is the durable thing here.
--
-- bot_hold_at doubles as the flag and the clock: null is "the bot answers",
-- and a time is when a person took it over, which is what the desk shows and
-- what tells somebody a chat has been held since Tuesday.
-- ---------------------------------------------------------------------------

alter table clients add column if not exists bot_hold_at timestamptz;
alter table clients add column if not exists bot_hold_by text;

comment on column clients.bot_hold_at is
  'When Operations took this conversation over. Not null means the bot does not answer this customer (lib/flow/machine.js, runFlow).';
comment on column clients.bot_hold_by is
  'The operator who took it over, for the chat header and the audit trail.';

-- The desk asks for "every chat a person is holding" to keep them visible, so
-- nobody is left waiting in a conversation the bot has been told to stay out
-- of. Partial: the rows that matter are the few, not the many.
create index if not exists clients_bot_hold_idx on clients (bot_hold_at desc) where bot_hold_at is not null;
