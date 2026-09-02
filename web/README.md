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

A customer message goes to one agent loop shared by both channels:

1. The model receives the message plus the conversation history.
2. It decides which **tool** it needs. Tools are the only source of facts:

   | Tool | What it does |
   |---|---|
   | `track_shipment` | SQL lookup by reference, ACID, B/L, container or customer name |
   | `search_knowledge` | Vector search over the company PDF/Excel (pgvector), keyword fallback |
   | `create_booking` | Validates, de-duplicates, inserts, then emails/pings the PDF |
   | `list_my_bookings` | Bookings made from this chat |
   | `create_support_ticket` | Escalates to one of five departments |

3. Tool results go back to the model, which writes the reply.
4. The last 8 exchanges are stored in Supabase so the conversation has memory
   across serverless invocations.

The system prompt forbids inventing shipment data, quoting prices, or serving
ports outside the five supported Egyptian destinations.

## Layout

```
api/
  telegram.js        Telegram webhook (secret-token verified, de-duplicated)
  chat.js            JSON endpoint for the website widget
  health.js          config + database self-check
  admin/setup.js     one-click webhook registration
lib/
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
supabase/schema.sql        the whole database, idempotent
public/index.html          website chat widget
data/                      demo PDF + Excel (replace with real exports)
```

## Commands

```bash
npm install
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

- [ ] Replace demo data with real shipment exports, and schedule `seed`
- [ ] Rotate the Telegram token
- [ ] Rate-limit `/api/chat`
- [ ] Set RESEND_API_KEY / OPS_EMAIL / STAFF_CHAT_ID so bookings reach a human
- [ ] Verify a sending domain in Resend so customers actually get their copy
- [ ] Add a privacy notice — you are storing chat history
- [ ] Decide how long to keep `conversations` rows
