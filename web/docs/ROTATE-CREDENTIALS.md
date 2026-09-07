# Replacing the keys and passwords

Every key below was typed into a chat window while we were building this, which
means it should be treated as known to somebody else. None of them has been
misused as far as we can tell — this is housekeeping, not an emergency — but a
key that has been pasted anywhere outside a password manager is no longer a
secret.

Work down the list in order. Each one takes two or three minutes.

Two of them I can rotate for you in one command; the other six can only be
replaced by the company that issued them, because only they can create the new
value.

---

## First: the two we invented ourselves

```
cd web
npm run rotate            # shows the new values, changes nothing
npm run rotate -- --apply # writes them to Vercel and .env
```

`ADMIN_SECRET` is the password to the operations console.
`TELEGRAM_WEBHOOK_SECRET` is how the bot proves an incoming message really came
from Telegram.

With `VERCEL_TOKEN` set in your environment the script updates Vercel and starts
a redeploy. Without it, it prints both values and you paste them into
**Vercel → your project → Settings → Environment Variables**, then
**Deployments → ⋯ → Redeploy**.

**When the redeploy is finished** — not before, or every message gets rejected:

```
npm run setup:webhook -- https://mkc-global.vercel.app
```

Then sign in to https://mkc-global.vercel.app/ops.html with the new secret.

---

## Then the six that only their owner can replace

Do these one at a time, and check `/api/health` after each: if `ready` is still
`true` and `checks` are all green, that one is done.

### 1. Telegram bot token

The most sensitive one: anybody with it can read every message your customers
send the bot and write to them as you.

1. Open Telegram, message **@BotFather**
2. `/mybots` → your bot → **API Token** → **Revoke current token**
3. Copy the new token
4. Vercel → Settings → Environment Variables → edit `TELEGRAM_BOT_TOKEN`
5. Also put it in `web/.env` on your machine
6. Redeploy, then `npm run setup:webhook -- https://mkc-global.vercel.app`

The old token stops working the moment you revoke it, so the bot is silent for
the few minutes in between.

### 2. Supabase service key

This key bypasses every access rule in the database. It can read and change
every booking, shipment and document you hold.

1. https://supabase.com/dashboard → your project → **Settings → API Keys**
2. Roll (regenerate) the **service_role** key
3. Update `SUPABASE_SERVICE_ROLE_KEY` in Vercel and in `web/.env`
4. Redeploy

### 3. Database password

1. Supabase → **Settings → Database → Reset database password**
2. You only need it again if you connect with `psql` or run
   `supabase db push`; nothing in the app uses it directly

### 4. OpenAI key

Spending on this key is billed to you.

1. https://platform.openai.com/api-keys
2. **Create new secret key**, then **Revoke** the old one
3. Update `OPENAI_API_KEY` in Vercel and `web/.env`, redeploy
4. Worth doing at the same time: **Settings → Limits** → set a monthly cap

### 5. Resend key

1. https://resend.com/api-keys → create a new key, delete the old one
2. Update `RESEND_API_KEY` in Vercel and `web/.env`, redeploy

### 6. Vercel token

1. https://vercel.com/account/tokens → delete the token, create one if you still
   want command-line deploys
2. Nothing in the app uses it — it is only for deploying from a terminal

---

## While you are in Resend: customers still get no email

Emails currently go out as `onboarding@resend.dev`, a shared address Resend lends
you for testing. It will only deliver to **your own** Resend account address, so
every customer confirmation silently goes nowhere. The ops inbox gets its copy,
which is why this was easy to miss.

Since this was found, two things changed so nothing is lost in the meantime:

- Telegram customers get their PDF **in the chat**, immediately
- the ops email says in a yellow box when the customer copy was **not** emailed

To turn customer email on properly you need a domain you own, e.g. `mkyglobal.com`:

1. https://resend.com/domains → **Add Domain**
2. Resend shows three DNS records (DKIM, SPF, and a return-path CNAME)
3. Add them wherever your domain's DNS lives (GoDaddy, Cloudflare, your host)
4. Wait for Resend to show **Verified** — usually minutes, sometimes hours
5. In Vercel set `MAIL_FROM` to something like
   `MKY Global Forwarding <bookings@mkyglobal.com>` and redeploy

Until step 5 is done, leave it as it is: the bot tells customers their PDF was
sent *in the chat*, and never claims an email that did not go.

---

## How to tell it worked

```
curl https://mkc-global.vercel.app/api/health
```

- `ready: true`
- every entry under `checks` true
- `database: "ok"`

Then send the bot a message on Telegram, and open the ops console. If the bot
answers and the console lists bookings, all of it is live.
