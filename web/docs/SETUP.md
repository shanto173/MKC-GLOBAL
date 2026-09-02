# Setup guide — from zero to a live bot

Written for someone who has never used Supabase or Vercel. Follow it top to
bottom. Total time: about 45 minutes, all on free tiers.

You will need accounts on: [supabase.com](https://supabase.com),
[vercel.com](https://vercel.com), [github.com](https://github.com), and an
OpenAI API key from [platform.openai.com](https://platform.openai.com).

---

## What we are actually building

```
   Customer on Telegram              Customer on your website
            │                                  │
            └──────────────┬───────────────────┘
                           ▼
              Vercel  (your code, always on, free)
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
   Supabase DB      OpenAI (the brain)   Knowledge base
   shipments,       decides what to      your PDF + Excel
   bookings         look up              turned into searchable text
```

The important idea: **the AI never invents shipment data.** When a customer
asks "where is MKC-24001", the AI calls a tool that runs a real SQL query
against Supabase and answers only from what comes back.

---

## Step 1 — Create the Supabase project (10 min)

1. Go to [supabase.com](https://supabase.com) → **Start your project** → sign in with GitHub.
2. **New project**.
   - Name: `mkc-global-bot`
   - Database Password: click **Generate**, then **copy it somewhere safe**.
     (You will not need it for this project, but you cannot see it again.)
   - Region: pick the one closest to Egypt — `Central EU (Frankfurt)` is good.
   - Plan: **Free**.
3. Click **Create new project** and wait ~2 minutes while it provisions.

### Create the tables

4. In the left sidebar click **SQL Editor** → **New query**.
5. Open the file `web/supabase/schema.sql` from this project, copy **all** of it,
   paste it into the editor.
6. Click **Run** (or Ctrl+Enter). You should see *Success. No rows returned*.
7. Click **Table Editor** in the sidebar — you should now see `shipments`,
   `bookings`, `documents`, `conversations` and the rest.

### Copy your keys

8. Sidebar → **Project Settings** (gear icon) → **API**.
9. You need two values:
   - **Project URL** → looks like `https://abcdefgh.supabase.co`
   - **service_role** secret key → a long `eyJ...` string. Click *Reveal*.

> ⚠️ The `service_role` key can read and write everything and ignores all
> security rules. It goes on the server only. Never put it in a web page,
> never commit it to GitHub, never paste it in a chat.

---

## Step 2 — Fill in your local `.env` (5 min)

In a terminal:

```powershell
cd C:\Users\User\OneDrive\Documents\chatBot_mkc_global\web
copy .env.example .env
notepad .env
```

Fill in:

| Variable | Where it comes from |
|---|---|
| `SUPABASE_URL` | Step 1.9, Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Step 1.9, service_role key |
| `TELEGRAM_BOT_TOKEN` | BotFather (see Step 5) |
| `TELEGRAM_WEBHOOK_SECRET` | Invent one. Run `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` |
| `OPENAI_API_KEY` | platform.openai.com → API keys → Create new secret key |
| `ADMIN_SECRET` | Invent another random string, same way |

Leave `LLM_PROVIDER=openai` and `OPENAI_MODEL=gpt-4o-mini`.
`gpt-4o-mini` is cheap — roughly USD 0.15 per million input tokens, so a few
thousand customer chats cost a couple of dollars.

---

## Step 3 — Load the demo data (5 min)

```powershell
npm install
npm run gen:data    # creates the demo PDF + Excel in web/data/
npm run seed        # Excel -> Supabase tables
npm run ingest      # PDF + Excel -> searchable knowledge base
```

Expected output from `seed`:

```
  shipments      12
  events         33
  clients        12
```

Go back to Supabase → **Table Editor** → `shipments`. You should see 12 rows.
That is your "company database". Later you replace this with the real thing.

### Test it before deploying anything

```powershell
npm run smoke
```

This asks the bot six questions from your terminal — no Telegram, no
deployment. If this works, everything downstream will work.

For a free-form conversation:

```powershell
npm run smoke -- --chat
```

---

## Step 4 — Deploy to Vercel (10 min)

### Push to GitHub first

```powershell
cd C:\Users\User\OneDrive\Documents\chatBot_mkc_global
git add .
git commit -m "Add MKC Global chatbot"
git push
```

(`.env` is git-ignored, so your keys stay on your machine.)

### Import into Vercel

1. [vercel.com](https://vercel.com) → **Add New** → **Project**.
2. **Import** your GitHub repository.
3. **Important:** expand **Root Directory** and set it to `web`.
   Without this, Vercel will try to build the old Python Streamlit app.
4. Framework Preset: **Other**. Leave build/output commands empty.
5. Expand **Environment Variables** and add every line from your `.env`
   (name on the left, value on the right). Skip `PUBLIC_BASE_URL` for now.
6. Click **Deploy**. Wait ~1 minute.

You now have a URL like `https://mkc-global-bot.vercel.app`.

### Check it

Open `https://your-app.vercel.app/api/health` in a browser. You want:

```json
{ "ready": true, "database": "ok", "rows": { "shipments": 12, "documents": 40 } }
```

If `ready` is false, the JSON tells you exactly which variable is missing.
Fix it in Vercel → Settings → Environment Variables, then **Deployments →
⋯ → Redeploy**.

Now open `https://your-app.vercel.app` — the web chat should work.

---

## Step 5 — Connect Telegram (5 min)

You already made the bot with @BotFather: **@MKC_Global_bot**.

> 🔐 **Do this first.** Your original token was pasted into a chat, so treat it
> as public. In Telegram, message @BotFather → `/revoke` → pick your bot → it
> gives you a **new token**. Use that one everywhere below.

1. Put the new token in Vercel → Settings → Environment Variables →
   `TELEGRAM_BOT_TOKEN`, and in your local `.env`.
2. Redeploy (Deployments → ⋯ → Redeploy) so the new value is picked up.
3. Register the webhook — open this URL in your browser, with your own values:

   ```
   https://your-app.vercel.app/api/admin/setup?secret=YOUR_ADMIN_SECRET
   ```

   You should get back `"ok": true` and the webhook URL.

   (Or from your terminal: `npm run setup:webhook -- https://your-app.vercel.app`)

4. Open Telegram, find **@MKC_Global_bot**, press **Start**.

Try:

- `Where is MKC-24001?`
- `What documents do I need?`
- `I want to book a shipment from Rotterdam to Alexandria`

### Polish the bot in BotFather

- `/setdescription` — text shown before someone starts the bot
- `/setabouttext` — short text on the bot profile
- `/setuserpic` — your logo

---

## Step 6 — Put your real data in

This is the only part that changes when you go from demo to production.

### Option A — keep using Excel (easiest, no dev work)

Export shipments from your existing system into an Excel file with the **same
column names** as `web/data/MKC_Global_Operations.xlsx`, then:

```powershell
npm run seed -- --file data/real-shipments.xlsx
```

Re-run it whenever the data changes — daily, or on a schedule. It upserts, so
existing rows are updated rather than duplicated.

### Option B — connect your real database

If your shipment data lives in another system, the cleanest path is:

1. Keep Supabase as the bot's read layer.
2. Write a small sync job (a Vercel Cron, or a script on your server) that
   pushes changes into the `shipments` and `shipment_events` tables.

Only `web/lib/tools.js` knows how data is fetched, so swapping the source later
touches one file.

### Adding company documents to the knowledge base

Drop any PDF or XLSX into `web/data/` and run:

```powershell
npm run ingest
```

Tariff sheets, customs circulars, service handbooks, FAQ exports — all work.
Re-running replaces the chunks for files with the same name.

---

## Where things live in Supabase

| Table | What it holds | Who writes it |
|---|---|---|
| `shipments` | Live shipment status | you (`npm run seed` / sync job) |
| `shipment_events` | Milestone history | you |
| `bookings` | **Booking requests the bot takes** | the bot |
| `support_tickets` | Human handoff requests | the bot |
| `documents` | Knowledge base chunks + embeddings | you (`npm run ingest`) |
| `conversations` | Chat memory per customer | the bot |
| `clients` | Customer directory | you |

Check what the bot has booked: Table Editor → `bookings`, sort by `created_at`.

---

## Costs

| Service | Free tier | When you outgrow it |
|---|---|---|
| Vercel Hobby | 100 GB bandwidth, plenty of function calls | commercial use technically needs Pro ($20/mo) |
| Supabase Free | 500 MB database, 2 projects | Pro $25/mo at ~8 GB |
| OpenAI | pay as you go | ~$2–5/month at a few thousand chats |

Supabase pauses a free project after 7 days with no activity. A bot that gets
daily traffic never hits this; if it does, one click in the dashboard resumes it.

---

## Troubleshooting

**Bot does not reply at all**
Open `https://api.telegram.org/bot<YOUR_TOKEN>/getWebhookInfo` in a browser.
`last_error_message` tells you what Telegram saw. If `url` is empty, redo Step 5.3.

**"Unauthorized" in the Vercel logs**
`TELEGRAM_WEBHOOK_SECRET` in Vercel does not match the one used when the
webhook was registered. Set them the same and re-run Step 5.3.

**Bot replies but says it cannot find shipments**
`npm run seed` was never run, or ran against a different Supabase project.
Check `/api/health` — `rows.shipments` should be 12.

**Answers ignore the company documents**
`rows.documents` is 0 → run `npm run ingest`.

**Function timeout / no answer on long questions**
Vercel Hobby caps functions at 60s (already set in `vercel.json`). If you hit
it, switch `OPENAI_MODEL` to a faster model.

**Seeing the logs**
Vercel → your project → **Logs** tab. Everything the bot does prints there.
