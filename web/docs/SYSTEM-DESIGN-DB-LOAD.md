# Database load: the desk and the bot

What the operations desk and the bot ask of the database, what that will cost
with ten people at the desk and 500 customer messages a day, and what was
changed so it stays small. Every number here was measured; where a number is a
projection, the model it comes from is written next to it.

Branch `db-load`, merged with `brand-chat` (files in conversations) on
`release-2026-10-09`. The migrations this work adds, to apply after the code
is deployed (the desk works with or without them):

| Migration | What it does |
|---|---|
| `supabase/migrations/20261009120000_desk_activity.sql` | The change signal: a `desk_activity` table and a trigger on 14 tables that moves a version when something the desk shows is written. |
| `supabase/migrations/20261009121000_hot_path_indexes.sql` | 16 indexes, each for one read the desk or the bot makes often. |
| `supabase/migrations/20261009123000_desk_activity_chat_files.sql` | After `20261009120000`: a paper (`booking_documents`) also moves its conversation's version, because a conversation now shows the paper each file became (section 9). |

(`20261009122000_chat_files_bucket.sql`, brand-chat's, widens the storage
bucket's types and size; it is independent of these.)

No new environment variables. The ETag reads `VERCEL_DEPLOYMENT_ID` (or
`VERCEL_GIT_COMMIT_SHA`), which Vercel sets itself.

---

## 1. In one table

One operator, one minute, the desk visible. "Calls" are PostgREST requests:
each is a transaction on the pool the bot's writes go through (section 7).

| | Before | After, before the migration | After, with the migration |
|---|---:|---:|---:|
| Inbox open, nothing happening | **135** (counts 22 + inbox 23, every 20 s) | 42 (inbox 14, every 20 s; the counts come with it) | **4** (one pulse read per 15 s; 1 per minute when idle) |
| Inbox open, a colleague takes a case | 135 | 42 | 4 + one inbox (14, or 1 if another operator on the same instance already worked it out) |
| Case page open, colleagues working other cases | **120** (counts 22 + case 11 + conversation 7, every 20 s) | 90 (counts 14 + case 10 + conversation 6) | **4** (+ the sidebar counts when the inbox moves) |
| Refresh tick with no change | 45 | 14 | **1** |
| A known customer's WhatsApp message | 14 | 11 | 11 |
| A known customer's Telegram message | 10 | 9 | 9 |
| A WhatsApp delivery receipt | 2 | 2 | 2 (now indexed: was a scan of the whole outbox) |
| Outbox drain with nothing due | 1 | 1 | 1 |

Ten operators and 500 customer messages a day (section 6): **~443,000 desk
calls a day before, ~57,000 after** - and at the peak, **22 calls a second
before, about 4 after**, most of them one-row reads.

---

## 2. How it was measured

* **Calls, by counting them.** `tests/helpers/count-db.mjs` wraps the fake
  database and records every call that would have been one PostgREST request -
  table, kind, filters. The desk's views and the bot's turns were run against a
  seeded desk (20 open bookings with papers, call-backs, MRN applications,
  failing chats) on the code as it was (`6993e5c`) and as it is. The numbers in
  the tables are those counts. `tests/db-load.test.mjs`, `tests/bot-load.test.mjs`,
  `tests/desk-live.test.mjs` and `tests/desk-minute.test.mjs` hold the new
  numbers as budgets.
* **The live database, read only.** `pg_stat_statements`, `pg_stat_user_tables`,
  `pg_indexes`, `pg_stat_activity`, role settings, and `EXPLAIN (ANALYZE,
  BUFFERS)` of SELECTs only. Nothing was written.
* **At scale, on a real Postgres.** The live tables hold a few dozen rows, so
  their plans say little about next year. Every migration was applied to PGlite
  (Postgres in WebAssembly) with a year of data - 5,000 clients,
  10,000 bookings, 30,000 papers, 200,000 messages, 50,000 notifications,
  100,000 audit rows, 8,000 shipments - and the hot reads were planned and timed
  before and after the indexes. PGlite is slower than the real server; the
  ratios and the plan shapes are what carry over.
* **In a browser.** The desk was served locally against the fake database with
  the triggers emulated, and driven in headless Edge for three minutes while
  every request it made was logged (section 8.4).

---

## 3. The live database today

`max_connections` 60, `shared_buffers` 224 MB, PostgreSQL 17.6, PostgREST 14.5.
The application's tables hold 0-85 rows each; everything fits in memory and
every statement executes in well under a millisecond.

**Where the time goes is not the statements.** `pg_stat_statements` since
2026-10-06 17:34 (2.75 days of testing):

| | calls | mean |
|---|---:|---:|
| PostgREST's per-request `set_config(...)` (one per request) | 7,627 | 0.04 ms |
| `ops_users` `name ilike $1` - who is asking, on every desk request | 568 | 0.10 ms |
| `conversation_sessions` by id | 420 | 0.05 ms |
| the inbox's five reads (booking_queue ×2, client_request_queue, mrn_requests, audit) | 217 each | 0.1-0.5 ms |
| `booking_queue` decided, ordered by `confirmed_at` (the heaviest desk read) | 217 | 0.50 ms, max 12.6 ms |

Each PostgREST request is `BEGIN`, a `set_config` of nine request settings,
the statement, `COMMIT`, on one of a small pool of connections (one idle
connection at the time of reading; PostgREST opens up to its pool size on
demand). The `authenticator` role runs with `statement_timeout` 8 s and
`lock_timeout` 8 s. So the cost the desk imposes is the **number** of requests,
and the risk is the pool: the inbox fired five requests at once, then a dozen
more, for every operator, every 20 seconds, while the bot's writes waited for a
connection in the same queue. The 5-17 second hangs seen in the live test on
2026-10-08 (lib/supabase.js) are what a saturated pool looks like from the
client.

**Plans on live** (`EXPLAIN ANALYZE`, read-only): every hot read is a
sequential scan of a few dozen rows, 0.1-4 ms, with planning time larger than
execution (the queue views take 2-10 ms to plan). Nothing is slow today. What
grows: the tables most-scanned sequentially are `shipments` (2,048 seq scans -
the bot's pinned status card reads a chat's shipments with no index on
`chat_id`), `clients` (1,571), `processed_whatsapp_messages` (659 - the flood
check and the per-chat queue, no index on `chat_id`), `bookings` (1,300),
`conversation_sessions` (963), `notification_outbox` (575).

**Indexes that already exist** were checked before writing any:
`bookings (chat_id, created_at)`, `(status, priority, status_changed_at)`,
`booking_documents (booking_ref)`, `(status, uploaded_at)`,
`chat_messages (channel, chat_id, created_at)` and a partial index on failed
messages, `conversation_sessions (chat_id)`, `notification_outbox (status,
available_at)`, `operations_tasks (status, created_at)`,
`support_tickets (status, created_at)`, `mrn_requests (booking_ref)`,
`(status, created_at)`, `audit_logs (entity_type, entity_id, created_at)`.
Several of the "likely" indexes in the brief were therefore already there; the
ones missing are in section 5.4.

---

## 4. Calls, view by view

Seeded desk, 20 open bookings. "Before" is `6993e5c`. "Worked out" is a load
that computes the view (with the migration, one more call: the pulse read that
decides whether it must); "unchanged" is a load that sends back the ETag it was
given, with nothing it shows changed since.

### 4.1 The desk

| GET view | Before | After: worked out | After: unchanged (304, with the migration) | What changed |
|---|---:|---:|---:|---|
| `me` (once per sign-in) | 5 | 4 | - | team list cached; message-log probe remembered |
| `counts` | 22 | 14 | 1 | shares the inbox's rows |
| `inbox` | 23, and +1 per failing chat, +3 per loose paper, +3 per MRN application without a name | 14 here; at most 18 with every kind of row, at any size | 1 | four rounds of parallel reads; names batched |
| `case` (booking) | 11 | 10 | 1 | its own booking's version |
| `case` (request) | 7 | 6 | 1 | its own request's version |
| `chat` (conversation) | 7 | 6 | 1 | its own chat's version |
| `chats` (list) | 6 | 5 | 1 | |
| `shipments` | 4 | 3 | 1 | a page of 100, filtered in the database |
| `shipment` | 6 | 5 | 1 | its own shipment's version |
| `settings` | 4 | 3 | 1 | |
| `search` | 6 | 5 | not polled | client columns only |
| `pulse` | - | 1 | - | new |

One call in every "before" row is the operator check (`ops_users ilike`), now
read once per instance per 30 seconds.

**Per refresh tick**, before: the counts and the screen, every 20 seconds -
45 calls on the inbox, 40 on a case, 35 on a conversation. After: one pulse;
a screen only when something it shows moved.

### 4.2 The bot

| | Before | After |
|---|---:|---:|
| WhatsApp, known customer, text | 14 | **11** |
| WhatsApp, first message from a new number | 21 | 18 |
| Telegram, known customer | 10 | **9** |
| WhatsApp delivery receipt | 2 | 2 |
| Outbox drain, nothing due | 1 | 1 |

The WhatsApp turn, after: claim (rpc) · refresh the client row (returns it) ·
stamp the window · log the message in · **this chat's recent claims (one read,
was three)** · release anything held · the client's language · the session ·
save the session · log the reply · mark the claim done. The outbox drain at the
end now runs only when something was queued or released (section 5.6).

---

## 5. What was changed, and what each costs

### 5.1 (a) A change signal instead of re-fetching whole views

**`desk_activity`** holds versions. Nine are **areas** of the desk - bookings,
requests, outbox, messages, problems, history, customers, shipments, team - for
the lists. The rest are **records**, one row each, made the first time the
record is written: `booking:<ref>`, `request:<ref>`, `mrn:<ref>`,
`shipment:<id>`, `chat:<channel>:<chat id>`, for the pages that show one.
A trigger on 14 tables moves the right ones on every insert, update and delete:
a paper moves its booking, the bookings area and the chat it came in (an MKY
document, filed with no chat, its booking's chat - `20261009123000`); a
message moves its chat and the messages area; the session row (the bot's
step, the WhatsApp window) moves its chat only. Writes nobody can see move nothing: a draft being typed into, a
delivery receipt on a notification already sent, a WhatsApp name refreshed
unchanged, an operator's `last_seen`.

**`GET view=pulse&watch=booking:…,chat:…`** reads the nine areas and the
watched records in one call (an index scan: 0.1 ms with 28,000 rows in the
table). The desk polls it, and fetches a screen only when one of that screen's
versions moved. Which versions a screen depends on is one function,
`scopesOf(view, params)` in `public/desk/live.js`, imported by the browser
(when to fetch) and by the server (whether to answer 304), so the two cannot
disagree.

**Conditional GET.** Every polled view answers with an ETag made of the view,
its parameters, the operator and role, the versions of its scopes, a clock
bucket and the build. Sent back unchanged it is answered **304 after the one
pulse read**, without the view being worked out. The browser keeps the last
answer per URL; on 304 `api()` returns the very same object, so a screen sees
nothing changed and does not redraw.

**One inbox per instance.** The inbox's rows are the same for everyone (tabs,
filters and "mine" are cut per request). They are worked out once per instance
per set of versions and shared, by every operator and by `view=counts`; a
request arriving while they are being worked out waits for that computation.

Trade-offs and why:

* **A counter row, not a sequence.** A sequence never blocks, but its new value
  is visible before the writing transaction commits; a desk reading the pulse
  in that millisecond would fetch the old data, remember the new version, and
  show the old data until the next change. A row is transactional: version and
  data become visible together. Verified on PGlite: a rolled-back write leaves
  the version where it was.
* **It must never cost the bot a write.** The bump has a 250 ms `lock_timeout`
  and catches every error; if it cannot get its row, the bump is skipped and
  the desk catches up at its next change or its 5-minute refresh. Rows are taken
  in name order within a transaction, so two transactions that each touch one
  table cannot deadlock on the counters; two multi-row statements touching the
  same records in different orders can wait on each other, and the 250 ms
  timeout (shorter than Postgres's 1 s deadlock check) ends that as a skipped
  bump, not an error.
* **Once per row per transaction.** Found on PGlite: a per-row trigger
  updating one counter row turned a 200,000-row insert into minutes, as the
  row's dead versions piled up inside the transaction. Transaction-local
  markers now limit each key to one bump per transaction. They are spread
  over 64 settings rather than one per record: a setting, once made, lives as
  long as the database connection, and PostgREST keeps its connections for
  days. 20,000 messages in one statement: about 1.1 s with the trigger,
  0.23 s without (PGlite, WebAssembly); a single row's write pays
  microseconds.
* **Both sides of an update.** An update moves the keys of the row as it was
  and as it is: a paper re-filed from one booking to another changes both
  cases.
* **It cannot fail a write.** The keys are worked out from the row as jsonb
  (a column a table lacks is null, not an error), every cast is guarded by
  its pattern, and the bump itself is inside an exception block.
* **Hot rows.** The `messages` area is moved by every message and receipt, so
  concurrent bot turns queue for it for the length of their (single-statement)
  transactions - milliseconds, at our rate a few per minute. It would matter at
  hundreds of messages a second; then that area can be split per channel or
  replaced by the per-chat rows it already has.
* **Growth.** One row per record ever written: ~30,000 a year at this volume.
  The pulse reads it by primary key; nothing scans it.
* **Clock-dependent answers.** "Overdue", "done today", "confirmed 4 min ago",
  and whether a WhatsApp window is still open change without a write. The ETag
  includes a clock bucket - 5 minutes, 1 minute for a conversation - and a
  screen is fetched at least every 5 minutes.
* **Without the migration** the desk works as before: `pulse` says
  `supported: false`, screens are fetched on the old 20-second timer (with the
  new discipline), the ETag is a hash of the answer (saves the bytes and the
  redraw, not the reads), and nothing is shared. The server asks again every
  5 minutes, so applying the migration takes effect without a deploy.
* **Considered and not done:** computing a fingerprint from `max(updated_at)`
  in one query - `bookings` has no `updated_at`, and an assignment or a
  document check changes nothing a timestamp records; bumping from the code
  paths that write - a dozen of them in the bot, and the next one would forget.

### 5.2 (b) Polling discipline (`public/desk/ui.js`)

| | |
|---|---|
| Active (input in the last 3 min) | pulse every 15 s |
| Idle | every 60 s; the first input after idling asks at once |
| Hidden tab | nothing (Page Visibility); shown again: at once |
| Focus, back online | at once |
| After the operator's own action | the screen reloads itself; one second later a pulse, for everything else the action touched |
| Errors | the wait doubles, up to 2 minutes; back to normal on the first success |
| Jitter | every wait ±15%, so ten desks do not ask in step |
| In flight | one refresh per subscription; asked again meanwhile, it runs once more after |
| Leaving a screen | its requests are aborted (`AbortController`), its subscriptions end |
| Minimum gap | a subscription may say "not more often than N"; a screen that names no scopes is refreshed at most every 20 s, as before |
| Maximum age | every subscription is refreshed at least every 5 minutes |

The rhythm is plain data (`RHYTHM` in `public/desk/live.js`) and the
scheduling a pure function (`pollDelay`), both tested.

### 5.3 (c) Caching on the server

| What | Where | How long | Invalidated |
|---|---|---|---|
| The team (`ops_users`), for "who is asking" and the assignee check | `teamList()` in desk-shared.js | 30 s per instance | at once by `user_save` and `bootstrap_admin` on that instance |
| "Does `chat_messages` exist" | `hasMessageLog()` | for good once yes; a no is re-checked every 5 min | - |
| Settings, saved replies, WhatsApp templates (desk and bot) | `lib/settings.js` (unchanged: it already cached) | 60 s per instance | at once by a settings write on that instance |
| The inbox's rows | `shared()` in desk-live.js | exactly as long as the versions and the 5-minute clock bucket stay the same | by any write it shows |

The bot's settings read was already cached for a minute: a warm bot turn makes
no `bot_settings` read (section 4.2). Every cache is keyed by the database
client, so a test that swaps the client never sees another test's data.

### 5.4 (d) Indexes (`20261009121000_hot_path_indexes.sql`)

PGlite, a year of data, median of three runs, before → after:

| Read | Before | After | Index |
|---|---:|---:|---|
| Chats list: newest 2,000 messages | 142 ms (seq scan of 200,000) | 2.1 ms | `chat_messages (created_at desc)` |
| Chats list: sessions by recency | 3.9 ms | 0.53 ms | `conversation_sessions (updated_at desc)` |
| Case history (audit by entity id) | 21 ms, 3,490 buffers | 0.09 ms | `audit_logs (entity_id, created_at desc)` |
| Case notifications (outbox by entity) | 9.8 ms | 0.07 ms | `notification_outbox (entity_id, created_at desc)` |
| Inbox: failed and held notifications | 12 ms (seq scan; `<> 'sent'` cannot use the status index) | 0.05 ms | partial `notification_outbox (created_at desc) where status <> 'sent'` |
| WhatsApp receipt → its notification | 1.0 ms here; a sequential scan of the whole outbox per receipt, all of it when nothing matches - most receipts are for the bot's own replies, which are not in the outbox | 0.05 ms | partial `notification_outbox (provider_message_id)` |
| Release held messages (every inbound WhatsApp message) | 0.14 ms | 0.03 ms | partial `notification_outbox (chat_id) where status = 'pending'` |
| Inbox: latest decided bookings | 12 ms (and **162 ms, 67,366 buffers** the way it was read before, through `booking_queue`) | 0.43 ms | partial `bookings (confirmed_at desc)` |
| Inbox: call-backs open or finished today | 4.1 ms | 2.5 ms (BitmapOr) | `support_tickets (status_changed_at desc)`, partial `(resolved_at desc)` |
| Shipments, first page | 3.7 ms | 0.17 ms | `shipments (updated_at desc, shipment_id desc)` |
| Bot: pinned card, this chat's shipments | 2.1 ms | 0.07 ms | partial `shipments (chat_id, updated_at desc)` |
| Bot: this chat's recent claims | 3.1 ms (seq scan of 20,000) | 0.04 ms | `processed_whatsapp_messages (chat_id, processed_at desc)` |
| Bot: answers waiting (MRN by chat) | 0.04 ms | 0.03 ms | partial `mrn_requests (chat_id, status)` |
| Conversation: the chat's call-backs | - | - | `support_tickets (chat_id, created_at desc)` |
| Notes on a call-back or MRN | - | - | `internal_notes (entity_id, created_at desc)` |
| Outbox drain | 0.07 ms | 0.06 ms | already indexed |
| Pulse | 0.03 ms | 0.03 ms | primary key |

Each index costs a little on every write to its table; the ones above are on
reads made on every message, every receipt or every desk refresh. Not added:
trigram indexes for the search box - it is typed into, not polled, and a
sequential scan of 10,000 bookings is a few milliseconds.

Plain `CREATE INDEX` (a migration runs in a transaction, which `CONCURRENTLY`
cannot): at today's table sizes the build blocks writes for milliseconds.

### 5.5 (e) Query shape

* **The inbox in four rounds.** It ended with a read per chat that had a failed
  message, three per paper with no booking and three per MRN application
  without a booking name, each awaited in turn. Now: round 1, what is open,
  decided and set aside; round 2, papers, versions and failures, together;
  round 3, the bookings behind them, in two reads; round 4, every customer name
  still missing, from at most four reads (`customersFor`). 14 to 18 calls
  whatever the size. A list of ids is split into reads of 150, side by side,
  so no `in.(…)` filter outgrows the URL.
  The output is item-for-item what it was, compared on seeded desks of 7, 30
  and 61 customers against the previous code.
* **Reads bounded by what is shown, not "the newest N".** Call-backs were the
  newest 400 of all time and MRN applications the newest 300, then filtered:
  once the business outgrew those numbers an old one still open would have
  dropped off the inbox. They are now read as open-or-finished-today. Decided
  bookings come from the `bookings` table, not `booking_queue`, whose three
  per-row subqueries ran for every decision ever made before it could sort them.
* **Shipments** read the columns they show, filter in the database, and page by
  `(updated_at, shipment_id)` ("Show more"). Before, a search for an older
  shipment beyond the newest 300 found nothing.
* **Search** reads only the client columns it shows.
* **Not changed here, and worth doing** (the conversation code belongs to the
  other work package): the chats list reads the newest 2,000 messages, every
  column, to find each chat's last one. A `distinct on (channel, chat_id)` view,
  or a `last_message_at` on `conversation_sessions`, would make it one small
  read; until then the new index makes it 2 ms instead of 140.

### 5.6 (f, g) The bot's turn, the outbox and background work

* **One read of the claims.** WhatsApp's flood check counted the chat's recent
  claims, and the wait for an earlier message then read this message's claim
  and the earlier ones. A claim's `processed_at` is never earlier than its
  `created_at`, so one read of the chat's claims touched in the last two
  minutes answers all three. Only an actual wait reads again. The ordering
  tests (`whatsapp.test.mjs`: "two quick messages are still answered in order
  while the first one's write is slow") are unchanged and pass.
* **The drain at the end of a turn** (`drainAfterTurn`) runs when this instance
  queued or released something since its last drain - every case it is there
  for, including a held message released by the customer writing - and
  otherwise at most once a minute, which still delivers retries as they come due
  (there is no cron on this plan: drains are the retry loop). The desk's drains
  after an action are unchanged. The drain itself reads
  `status = 'pending' and available_at <= now()` through its index, never the
  whole table.
* **The reply still goes before the session write** (unchanged); the turn still
  waits for the write before marking the message done.
* **Considered and not done:**
  * *The client's language, read beside the session.* It could come from the
    client row the transport read at the start - but that row is read before the
    message waits for the chat's previous one, which may be the customer choosing
    a language. The read is concurrent with the session read (no latency) and
    one call.
  * *The client row refreshed on every message* (one write, which also returns
    the row the turn needs). Skipping it when nothing changed needs a read first,
    or a cache of the client across instances that a STOP or a block made
    elsewhere would make wrong.
  * *Window stamp and release-held as one RPC.* Two calls, side by side, off
    the reply's path; one more database function for one call saved.

### 5.7 (h) Connections

supabase-js talks to PostgREST over HTTP (`lib/supabase.js`); the function
holds no database connection between calls, and an idle instance holds none at
all. PostgREST owns the pool: on demand up to its pool size, idle connections
released after its idle timeout; a request that finds the pool full waits for
one (PostgREST's acquisition timeout is 10 s by default), and our client gives
up at 4.5 s (`lib/supabase.js`). That is why the number of calls is the load
that matters here: every desk refresh competed for the same few connections as
the bot's writes, and a burst of desk refreshes made a customer's session write
wait. On the live database one PostgREST connection was open at the time of
reading, of `max_connections` 60. Nothing here opens direct Postgres
connections, and nothing should: the pooler (Supavisor) is for those.

---

## 6. Projected load: ten operators, 500 customer messages a day

**Assumptions.** Desk open 8 hours a day, visible 75% of it. Time split: inbox
50%, a case 30%, a conversation 15%, shipments 5%. Half the visible time busy,
half quiet. Busy means: an inbox-area change 2.2 times a minute (about 1,050 a
day: bookings and papers from the bot, desk actions, notifications), the open
case changed by someone else 0.2 times a minute, the open conversation getting
a message a minute. Two warm instances share the inbox (5 operators on it).

**Before**, per operator per visible minute: inbox 135, case 120, conversation
105, shipments 78 - weighted **123 calls a minute**, whatever is happening.

**After**, per operator per visible minute:

| Screen | Busy | Quiet |
|---|---:|---:|
| Inbox | 4 pulses + 1.7 refreshes × ~6.6 (shared) ≈ **15** | 4 + one refresh per 5 min ≈ **7** |
| Case | 4 + counts 11 + its case 2 + its conversation 7 ≈ **24** | ≈ **10** |
| Conversation (chats.js as it is) | 4 + list and conversation every 20 s, 39 + counts 11 ≈ **54** | ≈ **9** |
| Shipments | ≈ **15** | ≈ **8** |
| Weighted | **≈ 24** | **≈ 8** |

An idle desk (nobody touching it for 3 minutes) asks once a minute.

| Per day | Before | After |
|---|---:|---:|
| Desk (10 × 360 visible minutes) | 442,800 | ~57,000 |
| Bot (500 messages; 14 → 11 calls; ~700 replies × 3 receipts × 2) | ~11,200 | ~9,700 |
| Peak rate, desk | 22 calls/s, in bursts of 5+ at once per operator | 0.7/s quiet, ~4/s busy |

The conversation screen is the largest remaining item, and it is the other
work package's: subscribing its list to `scopesOf('chats')` and its open
conversation to `scopesOf('chat', …)` (section 9) takes it from ~54 to ~20 a
busy minute, and the desk total to ~19.

---

## 7. Staleness: what can be old, and for how long

| What | How old it can be | Why |
|---|---|---|
| Anything on a screen, after a change | one tick: 15 s active, 60 s idle | the pulse rhythm (before: 20 s) |
| The same, after the operator's own action | none: the screen reloads itself | |
| Time-dependent words ("overdue", "done today", "4 min ago") | 5 min | the ETag's clock bucket and the maximum age |
| WhatsApp's window on an open conversation (the switch to "template only") | 2 min | the pane is asked again every 2 minutes; the countdown is drawn in the browser; sending re-checks it on the server anyway |
| A refresh that failed (a 5xx, a timeout, a body cut off) | one tick | it is not counted as caught up, even when the screen's code does not say it failed |
| A read of the inbox that failed | one tick | the list is shown without it, marked partial: never shared, never given an ETag, asked for again |
| What a case shows of other records (the customer panel, another booking on the same chassis) | 5 min | a case follows its own record's version |
| Someone switched off or a role changed, on another instance | 30 s | the team cache (the desk secret is still the gate) |
| A bump skipped (its row busy for 250 ms) | until the next change, or 5 min | never at the expense of the write |
| A client changed that is tied to its chat only through the session (no WhatsApp id or Telegram chat id on the row) - blocked, opted out | 5 min on its conversation | a client row moves the chats its ids name; the composer's refusal is re-checked on the server when sending |
| The Chats list (chats.js), after a message, a booking or a customer moved | 20 s, or one tick after that | it follows `scopesOf('chats')`, and 'messages' moves with every message anywhere, so it keeps the old 20-second minimum gap; the operator's own send redraws it at once |
| The Chats list, when only a session changed (no message with it) | 5 min | a session moves its chat's version, not an area the list follows |
| A file in the open conversation, and the paper it became (read by the bot, checked, set aside, removed) | one tick | the conversation follows its chat's version, which its messages and (since `20261009123000`) its papers move |
| A conversation whose papers, messages or dealt-with failures could not be read | one tick | shown, marked partial: no ETag, asked for again |
| Before the migration | 20 s, as before | |

Nothing is cached past a write it depends on: versions are transactional, an
answer is reused only under exactly the versions it was worked out from, and
the browser's kept answers are used only after the server says 304.

**Partial rollback is the one way to make the desk stale.** If the triggers are
dropped but the table kept, versions stop moving and screens refresh only every
5 minutes. Roll back by dropping both (the desk then falls back to the timer
within 5 minutes):

```sql
do $$ declare t text; begin
  foreach t in array array['bookings','booking_documents','mrn_requests','support_tickets','notification_outbox',
    'chat_messages','conversation_sessions','audit_logs','internal_notes','clients','shipments','shipment_events',
    'ops_users','bot_settings'] loop
    execute format('drop trigger if exists desk_activity on public.%I', t);
  end loop; end $$;
drop function if exists desk_activity_touch();
drop function if exists desk_activity_keys(text, jsonb);
drop function if exists desk_chat_key(text, text);
drop table if exists desk_activity;
```

---

## 8. Proof

### 8.1 Tests

544 tests (495 before), all passing. The ones that hold the numbers:

* `tests/db-load.test.mjs` - the team read once for many requests; the inbox
  the same number of reads whatever the number of failing chats; a refresh
  with nothing changed is **one read** and a 304; a change the inbox shows is a
  new answer and one it does not show is still 304; ten operators share one
  inbox; the clock; before the migration; a case is not worked out again when
  another booking moves; a conversation answers 304 until its own chat moves;
  shipments paged by place, each exactly once, even with equal update times.
* `tests/bot-load.test.mjs` - a known WhatsApp customer's message is at most
  11 calls; the claims are read once; a quiet turn leaves the outbox alone and
  a held message is still sent the moment the customer writes; Telegram at most
  9.
* `tests/desk-live.test.mjs` - the browser's loop against a fake clock, page
  and server: one pulse a tick and no fetch when nothing changes; a change
  fetches the screens that show it, once; a hidden tab asks nothing; errors
  back off; one refresh in flight; 304 returns the same object; aborted
  requests; an older server; the minimum gap; record-scoped pages.
* `tests/desk-minute.test.mjs` - the browser's loop against the real API and
  the fake database with the triggers emulated: a quiet minute on the inbox is
  four reads; a colleague's change fetches the inbox once, within a tick; a
  chat message elsewhere fetches nothing; a case page is not fetched while
  colleagues work other bookings.

* `tests/desk-activity-sql.test.mjs` - the migrations applied to a real
  Postgres (PGlite, a pinned dev dependency, in-process): each kind of write
  moves exactly the versions it should, and the fake database's emulation of
  the trigger (which the other desk tests run on) moves the same ones for the
  same rows, write for write; a rolled-back write moves nothing; 20,000 rows
  in one statement move each key once.
* `tests/fixtures/inbox-golden.json` - what the old inbox (`6993e5c`) returned
  for three busy seeded desks at a fixed moment; the new one must return the
  same, item for item.

The triggers were also checked by hand on PGlite, rule by rule (36 kinds of
write, each moving exactly the expected rows), plus rollback, the bulk insert and
once-per-transaction.

### 8.2 Before and after, counted

See sections 1 and 4. The "before" numbers were counted on `6993e5c` with the
same seeded desk; the bot's on the same seed as `tests/bot-load.test.mjs`.

### 8.3 Reviewed

An independent read-only review of the branch found, and the branch then
fixed: an answer cut off mid-body could be kept and served back on a 304; a
failed conversation refresh counted as caught up; a partly failed inbox could
be shared and tagged like a whole one; a re-filed paper moved only its new
booking; a set-aside failure did not move its conversation; the trigger's
markers grew one setting per record on long-lived connections; a malformed
audit id could fail a write; a full end-of-turn drain left the rest for a
minute; long id lists in one URL; an MRN row named differently from before;
shipments kept rows that had left the filter. Each has a test.

### 8.4 In a browser

Headless Edge on the local desk, three minutes:

```
   2.1s  me 200 · pulse 200 · inbox 200        sign-in: the counts come with the inbox
  17.5s  pulse 200                              nothing happening: a pulse every ~15 s
  34.3s  pulse 200
  51.0s  pulse 200
  55.0s  --- a colleague takes MKY-BKG-0
  64.5s  pulse 200 · inbox 200                  fetched once; the row now says Omar
  73.1s  --- a chat message elsewhere
  81.3s  pulse 200                              the inbox is not fetched
  90.2s  --- case page MKY-BKG-1: case 200 · chat 200
  95.2s  --- another booking moves (MKY-BKG-4)
  98.1s  pulse 200 · counts 200                 the sidebar, not the case
 112.2s  --- this booking moves (MKY-BKG-1)
 125.6s  pulse 200 · counts 200 · case 200      now the case
```

No exceptions and no console errors.

---

## 9. The conversation and chats screens (with brand-chat's files)

`public/desk/ui.js` owns refreshing. On `release-2026-10-09` the Chats screen
and the conversation component use it the same way the case page does:

```js
// chats.js - app.js subscribes the list, ends both subscriptions and aborts
// every read when the screen is left.
export function renderChats({ route, main, subscribe, signal }) {
  …
  convo = mountConversation(convoEl, { channel, chatId, …, signal });
  // The open conversation on its own chat's version, not every message's;
  // every two minutes regardless, for the WhatsApp window.
  subscribe(scopesOf('chat', { channel, chat_id: chatId }), () => convo.refresh(), { maxAgeMs: 120_000 });
  …
  return {
    refresh: () => loadList({ quiet: true }),
    scopes: scopesOf('chats'),       // the list, on its areas
    minGapMs: RHYTHM.fallbackMs,     // 'messages' moves with every message anywhere: not more often than before
    dispose() { … },
  };
}

api({ view: 'chat', channel, chat_id }, { signal });   // aborted when the screen goes;
                                                        // a 304 returns the same object
subscribe(scopes, refresh, { minGapMs, maxAgeMs })      // -> { now(), unsubscribe() }
scopesOf(view, params)                                  // the scopes the server uses for 304
poke(ms)                                                // ask again soon (api() does it after a POST)
```

* `refresh` returns `false` for "did not load whole" (a failed read, or an
  answer the server marked `partial`); it is retried next tick.
* A screen may return `minGapMs` with its `scopes`; app.js passes it on. One
  that returns no `scopes` is refreshed when anything moves, at most every 20
  seconds.
* The conversation's files: the chat view reads the papers its file messages
  became (`lib/admin/desk-media.js`) on every load, so those papers move the
  chat's version (`20261009123000_desk_activity_chat_files.sql`): a photo the
  bot filed, a paper checked or set aside at the desk, an MKY document filed
  from the conversation (by its booking's chat, since it has none of its own).
  Where an inbound voice note or video was kept is a patch to its
  `chat_messages` row, and a file the desk sends is a `chat_messages` row:
  both already move the chat. While nothing in the chat moves, an open
  conversation answers 304 after the one pulse read, without reading the
  messages or the papers.
* What is never kept: `chat_files` (ten-minute links) and `document_url`
  (fifteen) have no scopes, so no ETag and never a 304; they and every other
  unpolled view, and every POST (a `chat_upload` answer carries a one-off
  signed upload address), say `Cache-Control: no-store`. The browser's `api()`
  keeps only answers that came with an ETag, and fetches with
  `cache: 'no-store'`; the conversation keeps each link until its
  `expires_at`, and fetches a fresh one when an image fails to load.
* A conversation whose messages, papers or dealt-with failures could not be
  read is drawn, marked `partial`, given no ETag and asked for again on the
  next tick - the same rule as the inbox.

---

## 10. Deploying

1. Deploy the branch. It works with or without the migrations.
2. Apply `20261009120000_desk_activity.sql`, `20261009121000_hot_path_indexes.sql`
   and `20261009123000_desk_activity_chat_files.sql` (`supabase db push`, or by
   hand, in that order: the last replaces a function the first makes).
3. Check (read-only):
   `select scope, version from desk_activity where scope not like '%:%';` -
   nine rows; and `GET ?resource=console&view=pulse` answers
   `supported: true`. Within five minutes every open desk switches to the
   pulse on its own.
4. Watch `pg_stat_statements` for the `desk_activity` read becoming the most
   frequent desk statement, and the inbox's reads dropping to a few per change.
