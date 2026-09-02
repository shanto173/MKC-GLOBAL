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

Leave `LLM_PROVIDER=openai` and `OPENAI_MODEL=gpt-4.1-nano`.
That is the cheapest model that still calls tools reliably — about USD 0.10 per
million input tokens, so roughly 20,000 customer chats for $5. If booking
conversations ever feel clumsy, change one line to `gpt-4.1-mini`.

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
  events         34
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
   (name on the left, value on the right). Skip `APP_BASE_URL` for now.

   > If Vercel says a variable already exists, delete that row from the paste and
   > edit the existing one instead (**⋯ → Edit**). And remember: environment
   > variables only take effect on a **new** deployment — after changing any,
   > go to **Deployments → ⋯ → Redeploy**.
6. Click **Deploy**. Wait ~1 minute.

You now have a URL like `https://mkc-global-bot.vercel.app`.

### Check it

Open `https://your-app.vercel.app/api/health` in a browser. You want:

```json
{ "ready": true, "database": "ok", "rows": { "shipments": 12, "documents": 32 }, "pdf": "ok (3213 bytes)" }
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

## Step 7 — Booking notifications (email + Telegram)

Out of the box a booking lands silently in the `bookings` table. This step
makes it arrive in an inbox and a staff group, with a confirmation PDF attached.

Nothing here is required — skip it and bookings still save correctly. Each part
you configure switches itself on.

### 7a. Email via Resend (free, 3,000/month)

1. [resend.com](https://resend.com) → sign up (GitHub login works)
2. **API Keys** → **Create API Key** → name it `mkc-bot` → copy the `re_...` value
3. Add to `web/.env` **and** to Vercel → Settings → Environment Variables:

   ```
   RESEND_API_KEY=re_xxxxxxxxxxxx
   OPS_EMAIL=your-bookings-inbox@gmail.com
   ```

> ⚠️ **Until you verify a domain, Resend only lets you send to the address you
> signed up with**, from `onboarding@resend.dev`. That is fine for testing — set
> `OPS_EMAIL` to your own address. Customers will NOT receive their copy yet.

**To email real customers**, verify a domain in Resend → **Domains** → add
`mkcglobal.com` → add the DNS records it shows you → then set:

```
MAIL_FROM=MKC Global Logistics <bookings@mkcglobal.com>
```

Verifying a domain also keeps your mail out of spam folders, which matters more
than it sounds for booking confirmations.

### 7b. Telegram staff group

1. In Telegram, create a group, e.g. **MKC Bookings**
2. Add **@MKC_Global_bot** to it
3. Send any message in the group (`hello` is fine)
4. Run:

   ```powershell
   npm run chatid
   ```

   It prints something like `STAFF_CHAT_ID=-1002345678901` (group ids are
   negative). Put that in `.env` and in Vercel.

The script briefly detaches the webhook to read pending messages, then puts it
back — the bot keeps working.

### 7c. Test it

```powershell
npm run test:pdf            # renders data/sample-booking.pdf, sends nothing
npm run test:pdf -- --send  # actually emails and pings the group
```

Then check `https://your-app.vercel.app/api/health` — the `notifications`
block tells you which channels are live, and `pdf` confirms PDF rendering works
in the deployed function.

### What each party receives

| Who | Gets |
|---|---|
| Customer | "We have your booking request" email + PDF, if their contact is an email |
| `OPS_EMAIL` | "New booking request" email + PDF, reply-to set to the customer |
| Staff group | The PDF as a Telegram document, with a one-glance caption |

If a notification fails — wrong key, Resend down, bot removed from the group —
the booking is **still saved**. Failures are logged in Vercel → Logs and never
shown to the customer.

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
