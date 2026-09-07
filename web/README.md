# MKC Global Logistics — AI chatbot

Telegram + web chatbot for a freight forwarding company. It answers from the
company's live database, not from the model's imagination: shipment status,
document requirements, transit times, and it takes new booking requests and
writes them back to the database.

**Start here → [`docs/SETUP.md`](docs/SETUP.md)** (step-by-step, no prior
Supabase or Vercel experience assumed).

**Explaining this to a colleague? → [`docs/HOW-WE-BUILT-THIS.md`](docs/HOW-WE-BUILT-THIS.md)**
— plain English, no programming knowledge needed.

---

## How it works

A customer message meets a **deterministic state machine** first, and a language
model only if the machine has nothing to say.

```
Telegram ──► api/telegram.js ──► lib/flow/machine.js ──► booking · tracking · contact
                                       │                          │
                                       │ nothing to say           └──► Supabase
                                       ▼
                                lib/agent.js  (the model, for questions)
```

The rule the design rests on: **the model may read, it may not decide.** It
reads a chassis number out of a sentence and answers questions from the company
knowledge base. Whether a vehicle may be booked, what documents are outstanding,
and whether a request goes to Operations are decided from rows in Postgres.

The model has no booking tools — `create_booking` and friends are filtered out of
its tool list. That is the enforcement; a prompt can be argued with, a tool that
was never offered cannot be called.

**→ [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** explains the flows, the
idempotency, and where every business rule actually lives.

### What the model still does

| Tool | What it does |
|---|---|
| `track_shipment` | shipment lookup by reference, ACID, B/L, container |
| `search_knowledge` | vector search over the company PDF/Excel, keyword fallback |
| `list_my_bookings` | bookings made from this chat |
| `create_support_ticket` | escalates to one of five departments |

### The three flows

1. **Book my shipment** — chassis check, the basics, MRN choice and documents,
   the summary and the yes. Four steps, inline buttons throughout.
2. **Track my shipment** — by chassis or reference, with an ownership check, and
   a Refresh that re-reads the database rather than repeating itself.
3. **Contact our team** — booking, tracking, documents, or a person.

Conversation state lives in `conversation_sessions`, so a restart, a redeploy, a
webhook retry or a second worker all continue the same conversation.

**Both channels run the same flow.** Telegram draws inline keyboards; the
website widget gets the same choices back as `options` and draws its own
buttons. Either way a client can just type the number — "2" means the second
choice offered, except where a question was asked, in which case it is the
answer to that question.

## Layout

```
api/
  telegram.js        Telegram webhook (secret-token verified, de-duplicated)
  chat.js            JSON endpoint for the website widget
  health.js          config + database self-check
  cron/outbox.js     drains queued notifications, every 5 minutes
  admin/bookings.js  the Operations queue: review, confirm, reject, ask
  admin/tasks.js     the internal work queue
  admin/mrn.js       MRN applications
  admin/setup.js     one-click webhook registration
lib/
  flow/              THE STATE MACHINE - where booking is actually decided
    machine.js         one place where every transition is chosen
    states.js          every state, in one list
    store.js           conversation_sessions - state that survives a restart
    booking.js         steps 1-4, the chassis check through the yes
    tracking.js        lookup with an ownership rule
    contact.js         the four contact routes
    keyboards.js       inline keyboards and their callback payloads
    messages.js        every word said to a client, in both languages
  bookings.js        booking rules: duplicates, required fields, submission
  documents.js       what arrived, what is missing, whose vehicle it is for
  mrn.js             MRN applications MKY makes on a client's behalf
  operations.js      the work queue + the OperationsNotifier interface
  outbox.js          nothing important is sent from inside a handler
  settings.js        business values MKY can change without a deployment
  clients.js         Telegram identity, and who may see what
  audit.js           who did what, redacted
  agent.js           the tool-calling loop and system prompt
  notify.js          booking emails (Resend) + staff Telegram ping
  pdf.js             branded booking confirmation PDF, built in memory
  tools.js           tool schemas + the SQL behind them
  llm.js             OpenAI / Anthropic adapter (plain fetch, no SDK)
  supabase.js        service-role client
  session.js         conversation memory
  telegram.js        Bot API helpers
  config.js          all environment variables in one place
scripts/
  generate-demo-data.mjs   builds the demo PDF + Excel
  seed-db.mjs              Excel  -> shipments / events / clients
  ingest.mjs               PDF+Excel -> embedded knowledge base
  set-webhook.mjs          point the bot at a deployment
  find-chat-id.mjs         resolve your staff Telegram group id
  test-notify.mjs          render a sample PDF, --send to deliver it
  smoke-test.mjs           talk to the agent from the terminal
supabase/migrations/       the whole database, idempotent, CLI-pushable
public/index.html          website chat widget
data/                      demo PDF + Excel (replace with real exports)
```

## Commands

```bash
npm install
npm test              # 78 tests: no network, no token, no model
npm run outbox -- --list       # what is waiting to be sent
npm run outbox                 # send it now
npm run gen:data      # regenerate the demo PDF + Excel
npm run seed          # load Excel into Supabase
npm run ingest        # build the RAG knowledge base
npm run smoke         # ask the agent 6 test questions
npm run smoke -- --chat        # interactive terminal chat
npm run setup:webhook -- https://your-app.vercel.app
npm run chatid        # find your staff Telegram group id
npm run test:pdf      # render a sample booking PDF
npm run test:pdf -- --send     # and actually deliver it
```

## When a booking is made

`create_booking` writes the row first, then notifies. Notification failures are
logged and swallowed — a booking is never lost because an email bounced.

| Who | Receives |
|---|---|
| Customer | Confirmation email + PDF, when their contact is an email address |
| `OPS_EMAIL` | New-booking email + PDF, reply-to set to the customer |
| `STAFF_CHAT_ID` | The PDF as a Telegram document with a summary caption |

Each channel activates only when its environment variable is set, so you can
run with none, some, or all of them. `/api/health` reports which are live.

## Switching the model

`.env` → `LLM_PROVIDER=openai` or `anthropic`.

```
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-5
```

Embeddings always use OpenAI (`text-embedding-3-small`), because Anthropic has
no embeddings endpoint. Without an OpenAI key, knowledge search silently falls
back to Postgres full-text search — worse, but functional.

## Security notes

- `SUPABASE_SERVICE_ROLE_KEY` is server-only and bypasses Row Level Security.
  RLS is enabled with no policies on every table, so the public anon key can
  read nothing even if it leaks.
- The Telegram webhook verifies `X-Telegram-Bot-Api-Secret-Token`.
- `/api/chat` is open to the internet and spends LLM credits. Add a captcha,
  a login, or Vercel rate limiting before advertising it publicly.
- Rotate the bot token in @BotFather if it has ever been pasted anywhere.

## Before real customers

- [ ] **Re-register the webhook** (`npm run setup:webhook -- https://…`). The old
      registration did not subscribe to `callback_query`, so every inline button
      is dead until this is run once.
- [ ] Apply migration 008 (`npm run db:push`)
- [ ] Set `CRON_SECRET` so failed notifications are retried
- [ ] Fill in `bot_settings.required_mrn_documents` and `acid_required` — both
      are deliberately empty, because inventing a customs requirement is not
      acceptable. See "Business decisions still needed" below.
- [ ] Replace demo data with real shipment exports, and schedule `seed`
- [ ] Rotate the Telegram token
- [ ] Rate-limit `/api/chat`
- [ ] Set RESEND_API_KEY / OPS_EMAIL / STAFF_CHAT_ID so bookings reach a human
- [ ] Verify a sending domain in Resend so customers actually get their copy
- [ ] Add a privacy notice — you are storing chat history
- [ ] Decide how long to keep `conversations` rows

## Business decisions still needed from MKY

Three values are deliberately left unset. The software works without them; it
just cannot guess them, and guessing a customs requirement or reading out an
invented phone number would be worse than saying nothing.

| Where | What is needed | What happens meanwhile |
|---|---|---|
| `bot_settings.required_mrn_documents` | what MKY needs from a client to apply for an MRN on their behalf | the bot collects a free-text description and raises a Customs Documentation task saying the list is undefined |
| `bot_settings.acid_required` | whether an ACID registration is required from the client at booking time | not asked for |
| `OPERATIONS_PHONE` (or `bot_settings.operations_phone`) | the number to give a client who asks for a person | the bot logs a callback task and says a number has not been configured, rather than reading out the `.env.example` placeholder |

Set the first two in the `bot_settings` table; no deployment is needed.
