# How the bot decides things

This document exists because of one rule, and everything below is a consequence
of it:

> The model may read. It may not decide.

A language model reads a chassis number out of a sentence, answers a question
about transit times, and writes a friendly reply. It does not decide whether a
vehicle may be booked, what documents are outstanding, or whether a request goes
to Operations. Those are decided from rows in Postgres by code you can read, and
tested by 78 tests that run with no network and no API key.

---

## The two layers

A message arriving on Telegram meets the **state machine** first.

```
Telegram ──► api/telegram.js ──► lib/flow/machine.js ──► lib/flow/{booking,tracking,contact}.js
                                       │                          │
                                       │ handled: false           ├──► lib/bookings.js    ─┐
                                       ▼                          ├──► lib/documents.js    ├─► Supabase
                                lib/agent.js  (the model)         ├──► lib/mrn.js          │
                                       │                          └──► lib/operations.js  ─┘
                                       └──► track_shipment · search_knowledge
                                            list_my_bookings · create_support_ticket
```

The machine handles a message when it is a command, a tapped button, a file, or
an answer to a question it asked. Anything else — "how long does it take to
Alexandria?" — it declines, and the model answers from the knowledge base.

**The model has no booking tools.** `create_booking`, `update_booking`,
`lookup_vehicle` and `check_documents` are filtered out of the tool list
(`toolsForTurn()` in `lib/agent.js`). This is the enforcement. A prompt can be
argued with; a tool that was never offered cannot be called.

Set `BOOKING_ENGINE=llm` to restore the old behaviour. It exists so this change
can be rolled back with an environment variable rather than a redeploy, not
because it is a supported production setting.

---

## Where the conversation lives

`conversation_sessions`, one row per chat:

| column | meaning |
|---|---|
| `current_state` | one of the names in `lib/flow/states.js` |
| `active_flow` | `booking` · `tracking` · `contact` · null |
| `active_booking_ref` | the request being built |
| `context` | flow bookkeeping only — a pending document id, a chosen department |

Nothing about where a conversation is lives in a module variable. Two
invocations a second apart are different processes; the second reads the first
one's state out of this table. That is why a restart, a redeploy, a webhook
retry and a second worker all continue the same conversation.

**Business data never goes in `context`.** It goes in `bookings`,
`booking_documents`, `mrn_requests` — tables you can query, audit and correct.

---

## The booking flow

```
                 ┌──────────────┐
   /book  ──────►│  BOOK_VIN    │
                 └──────┬───────┘
                        │ lookup_vehicle verdict
        ┌───────────────┼───────────────────┐
        │               │                   │
   already_booked   known_not_booked      new
        │               │                   │
        ▼               └─────────┬─────────┘
  reference + route               ▼
  STOP, no new request    BOOK_MAKE → BOOK_CLIENT_NAME → BOOK_POL → BOOK_DESTINATION
                                                  │
                                                  ▼
                                        BOOK_MRN_CHOICE
                                     ┌────────────┴────────────┐
                              "I have one"              "MKY issues it"
                                     │                          │
                                     │                  mrn_requests row
                                     │                  + Operations task
                                     │                          │
                                     └────────────┬─────────────┘
                                                  ▼
                                          BOOK_DOCUMENTS
                                     (loops until nothing is missing)
                                                  │
                                                  ▼
                                     BOOK_FINAL_CONFIRMATION ◄──┐
                                          │            │        │
                                     ✅ Confirm    ✏️ Edit ──────┘
                                          │        (VIN change re-runs
                                          ▼         the duplicate check)
                                    BOOK_SUBMITTED
```

### Step 1 is not advisory

`lookupVehicle()` returns one of three verdicts from a single query against
`bookings` filtered to the live statuses. `already_booked` ends the flow. There
is no path through the code that reaches a second request for a chassis that
already has one.

Three separate things enforce that, because one is not enough:

1. the flow refuses at step 1;
2. `submit_booking_request()` re-checks inside the transaction, so a request
   that arrives between the card and the yes is caught;
3. a partial unique index, `bookings_live_vin_unique`, makes it impossible at
   the database level.

### Step 4 is a transaction

`submit_booking_request(booking_ref, chat_id, task_ref)` does the ownership
check, the duplicate check, the status change and the Operations task in one
Postgres function. A double tap, a retried webhook and two workers racing all
produce one submission and one task. The second caller is told `already: true`
and the client sees one message.

### What is required, and who decides

Nothing about required documents is written in the code. It comes from
`bot_settings`:

| key | default | why |
|---|---|---|
| `required_booking_documents` | `["invoice","brief","mrn"]` | the roadmap's list |
| `required_booking_documents_mky_mrn` | `["invoice","brief"]` | a client who has asked MKY to obtain the MRN cannot send one |
| `required_mrn_documents` | `[]` | **awaiting MKY** — see below |
| `acid_required` | `false` | **awaiting MKY** |
| `allow_submit_while_mrn_pending` | `true` | whether a request waits for the MRN |

`required_mrn_documents` is deliberately empty. Nobody has told us what Egyptian
customs needs for an MRN application, and inventing a customs requirement is the
one thing this system must never do. While it is empty the MRN branch collects a
free-text description and raises a Customs Documentation task whose note says
exactly that. Fill the setting in and the same code asks for those items instead
— no deployment needed.

---

## Received is not verified

`booking_documents.status` moves through
`received → pending_verification → verified | rejected | replacement_requested`.

The bot may say **received**. Only Operations may say **verified**. A file
arriving proves a file arrived: not that the invoice is legible, is for this
vehicle, or is an invoice at all. The confirmation card shows ✅ against a
received document and never uses the word "verified".

A document whose own chassis number disagrees with the booking is neither
received nor missing — it is its own problem, reported before anything else,
because a mismatch is what gets a customs declaration rejected.

---

## Nothing important is sent from a handler

```
   something happens  ──►  notification_outbox row  ──►  drain  ──►  Telegram
   (one transaction)       (idempotency_key)              │
                                                          ├─ inline, right after the trigger
                                                          └─ /api/cron/outbox every 5 minutes
```

Two failures this replaces, both seen in the field:

- Operations confirmed a booking, the Telegram call timed out, the operator saw
  "customer told" and the customer heard nothing, ever.
- A retried webhook re-ran the confirmation and the customer was told twice,
  with two different shipment references in the two messages.

The idempotency key fixes both. `booking_confirmed:MKY-BKG-…` can only exist
once, so a retry is a no-op rather than a second message.

Failures retry on a backoff of 1, 5, 15, 60, 240 and 720 minutes and then go to
`dead`. A client who has blocked the bot is marked `dead` immediately — retrying
that forever is how an outbox becomes permanent background load.

`npm run outbox -- --list` shows the queue.

---

## Who may see what

A booking reference is short, quotable, and gets forwarded between brokers.
Without an ownership rule, anyone holding one could read another company's
route, vessel and arrival date.

A record is visible to a chat when the chat created it, or when the client
behind the chat owns it (`clients.telegram_user_id` → `bookings.client_id`).

**Not-found and not-yours return the same answer**, so the bot cannot be used to
discover whether a reference exists.

Shipment rows with no owning chat and no booking are demo data. They are
invisible unless `allow_unowned_shipment_tracking` is set to `true`, which a
demo environment does deliberately.

---

## Idempotency, in three places

| what | mechanism |
|---|---|
| a retried Telegram update | `claim_telegram_update()` — one statement, first caller wins; a crashed worker's claim is reclaimable after 2 minutes |
| a double-tapped Confirm | `submit_booking_request()` — the second caller gets `already: true` |
| a re-run notification | `notification_outbox.idempotency_key` unique index |

Every tapped button is acknowledged with `answerCallbackQuery` **before** any
slow work, because Telegram gives up after a few seconds and leaves the client
looking at a dead button.

---

## The Operations workflow

```
   client confirms
        │
        ▼
   pending_review ──► under_review ──► confirmed ──► shipment opened
        │                  │                          + client told (outbox)
        │                  ├──► needs_client_action ──► client asked, comes back
        │                  └──► rejected ──────────► client told, with the reason
        └──► cancelled
```

`operations_tasks` is the queue. A task is a row, so it can be counted, assigned,
aged and reported on — and it exists whether or not any notification reached
anybody. `OperationsNotifier` (`lib/operations.js`) fans a copy out to whichever
chat channels are configured; Pumble is one of them and is off by default. None
of them can affect whether a booking succeeded.

The console is `/ops.html`, protected by `ADMIN_SECRET`, which travels in a
header and never in a URL.

---

## Testing

```bash
npm test
```

78 tests, no network, no Telegram token, no model. `tests/helpers/fake-db.mjs`
is an in-memory PostgREST that is deliberately strict about the two things the
concurrency guards are built from: unique violations raise `23505`, and a
conditional update that matches nothing returns an empty array rather than
pretending to have worked.

That the whole booking flow is testable this way is the architecture's own
proof. If a booking needed a model in the loop, none of these tests could exist.
