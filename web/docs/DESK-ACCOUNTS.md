# Who can sign in to the desk

Until October 2026 the operations desk had one password. Everyone typed the same
`ADMIN_SECRET` and then typed whatever name they liked beside it, so "confirmed
by Sara" meant only that somebody had typed `Sara`. Each person now has a
username and a password of their own, and the name on every decision comes from
the sign-in, not from the browser.

---

## Switching it on

The columns live in `supabase/migrations/20261012120000_desk_accounts.sql`, and
were applied to the live database (`kverwgcnvnferjewvvyr`) on 12 October 2026. A
fresh database gets them from `npm run db:push`, from the Supabase MCP server's
`apply_migration`, or by pasting the file into **Supabase → SQL Editor → New
query → Run**. It is safe to re-run.

**Until it is applied nobody is locked out.** The desk notices the columns are
missing, Settings → Team and access says so in an amber line, and everyone signs
in with their name and the shared `ADMIN_SECRET`, exactly as before. The same is
true for the few minutes between a deploy and the migration: a server already
running keeps every open session, because the one check it cannot make with the
old columns - whether a password has changed since the token was issued - is
skipped rather than failed.

---

## Making an account

**Settings → Team and access**, as an administrator:

| Field | What it is |
|---|---|
| Full name | What the desk shows everywhere: on bookings, assignments, the audit trail. Spaces and capitals are fine. |
| Username | What they type to sign in. Lowercase letters, digits, `.`, `-`, `_`. Left blank, it is made from the name: "Ariful Islam" → `ariful.islam`. |
| Password | At least 8 characters. Read it out to them; the desk never shows it again. |
| Role | Read only, Agent, Supervisor, Administrator — what each one may do is listed on the same card. |

Changing a role, or switching somebody off, is the same card: change the select
or the tick and press Save on that row.

- **Set password / Change password** on a row sets somebody's password. It also
  ends every session they had open — they sign in again.
- **Set my password** in the account menu (top right) is open to everybody,
  whatever their role.
- A person can always be switched off. That ends their sessions at once.
- The desk refuses any change that would leave it with no active administrator.

---

## How a session works

Signing in exchanges the username and password for a **signed token**: HMAC-SHA256
over a small payload, keyed with `ADMIN_SECRET`. There is no sessions table —
nothing to clean up, and a server that has forgotten everything still recognises a
valid token. The desk keeps it in `localStorage` and sends it as `x-desk-token` on
every request.

A session ends when:

- seven days pass (the token carries its own expiry);
- the password is changed (the token carries `password_set_at`, and a token issued
  against a different one is refused);
- the person is switched off (`active` is checked on every single request).

Passwords are stored as a scrypt digest with a random salt per person
(`lib/admin/desk-auth.js`). The plain password is never written anywhere — not to
the database, not to the audit trail, not to a log line.

---

## `ADMIN_SECRET` is still the master key

It has to be. It is the key the deployment holds, and an administrator who forgets
their own password must not be able to lock the desk for good.

- Typed as a password on the sign-in screen it works for anybody on the team, and
  the use is written to the audit trail as `desk_sign_in_with_secret`.
- Sent as the `x-admin-secret` header it still authorises the API directly, which
  is what the scripts, `/api/admin/*` and the tests use.
- Someone who signs in with it and has no password of their own is told to set
  one, and Settings shows a **No password** mark beside their name.

So treat it the way you treat the database's service-role key: it is a deployment
secret, not a desk password to pass around. Rotating it (see
`docs/ROTATE-CREDENTIALS.md`) signs everybody out, because every token was signed
with it.

Eight wrong passwords for one username slow further attempts on that server for
ten minutes. Serverless instances come and go, so it is a speed bump rather than a
lock — the real protections are the scrypt cost and a password worth having.

---

## What the browser can no longer do

Before, the desk sent `operator=<name>` with every request and the server believed
it. Now, when a request carries a token, `operatorFor()` takes the name from the
token and ignores the field. Holding somebody else's token is the only way to act
as them — typing their name is not.

The `operator` field still decides identity for requests authorised by the raw
`ADMIN_SECRET`, because that is how the scripts and the older admin endpoints
work, and whoever holds that secret can act as anybody in any case.

---

## Deleting records

An administrator can delete a booking, a customer request, an MRN application,
a shipment, a whole customer, or a team member's sign-in. Nobody else can — not
a supervisor, not an agent — and the server checks the role on every one of
these, not just the screen.

| Where | What it deletes |
|---|---|
| Case page → ⋯ → Delete this booking / request / application | That record and its own rows: its documents, internal notes, tasks and queued messages. Not the shipment it became, and not the customer. |
| Shipment page → Delete | The shipment and its milestone updates. Not the booking it came from. |
| Chat header → bin icon | **The customer and everything about them**: every message, every file, their bookings, requests, MRN applications and shipments. |
| Settings → Team → bin icon | That person's sign-in. Nothing they did: "confirmed by Sara" stays. |

### The dialog

Before anything goes, the desk asks the server what *would* go and reads it
back — "3 documents, 41 messages and 1 shipment" — then makes the administrator
type the reference (`MKY-BKG-2`, or the customer's name) before Delete turns on.
The typed text is checked again on the server. A red button gets pressed on the
wrong row eventually; typing a reference does not happen by accident.

### Thirty days

A deletion removes the rows for real, so the record is off every screen, count
and search the moment it goes — there is no "and not deleted" filter anywhere to
forget. The rows themselves are kept whole in `deleted_records`, and
**Settings → Recently deleted** puts any of them back, under the same ids, so
everything that pointed at them still does.

After 30 days the copy and the files are destroyed. The purge runs after any
deletion and from `/api/cron/outbox` (which can be called by hand or on a
schedule), at most once an hour per server.

Until then the files are still in the private `booking-docs` bucket: that is
what makes an undo possible, and it is the honest meaning of "recoverable for
30 days". Anyone who needs a deletion to be immediate and final should delete
and then call `/api/cron/outbox` once the 30 days are up — or ask for the
retention to be shortened in `KEEP_DAYS`.

### What a deletion never touches

The audit trail. Every deletion writes `record_deleted` to it with who, what,
and how many rows went; every restore writes `record_restored`. A tool that
quietly erased the record of its own use would be the wrong tool.
