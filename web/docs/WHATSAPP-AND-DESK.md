# WhatsApp channel and the MKY Desk — the plan

Status: being built on branch `whatsapp-channel` (7 October 2026).
This is both the plan and the specification the code is checked against.

---

## 1. Decisions

| Decision | Why |
|---|---|
| **WhatsApp is a second transport into the existing engine** (`lib/flow/*`), exactly as `docs/workflow/whatsapp-technical.html` proposed. Same steps, same rules, same database as Telegram. | One set of booking rules, one set of tests, one desk. The friend's n8n workflow re-implemented the flow with fewer rules and is not used (it stays, unpublished, in n8n as a reference). |
| **One language per conversation.** The client chooses English or Arabic once; every message after that is in that language only. Changeable any time. | MKY's request. Two languages stacked in every message is long and hard to read on a phone. |
| **One database.** The live Supabase project gets new tables and columns (migration `20261007090000`); nothing is moved or renamed. | Telegram and WhatsApp customers appear in one desk. Additive and idempotent, so it is safe on the live project. |
| **No Google Sheets.** Everything is in Postgres (Supabase). | Already the case; restated because it was asked. |
| **A new desk at `/desk/`** replaces the operations console. `/ops/` and `/ops.html` point to it. | The console grew a screen per table. People think in customers and requests, not tables. |
| **Every change works before its migration is applied.** New columns and tables are feature-detected; a missing one degrades to today's behaviour. | Production serves real Telegram customers; a deploy can land before the database change. |
| **Deployment**: branch `whatsapp-channel` → Vercel preview. Production only after MKY has checked the preview and the migration is applied. | The Telegram bot is live. |

---

## 2. The conversation (both channels)

### 2.1 Language first

```
New client writes anything
        │
        ▼
"Welcome to MKY Forwarding 👋  أهلاً بيك في MKY Forwarding
 Which language would you like?  تحب نكمل بأنهي لغة؟"
   [ English ]  [ العربية ]
        │ tap, or type english / عربي / en / ar
        ▼
Main menu, in that language only      ──►  everything after: one language
```

Rules:
- Asked only when the client has never chosen **and** nothing is in progress. A Telegram client half-way through a booking is never interrupted; they keep the bilingual messages until their next menu.
- Answering the question with anything else (a chassis number, "hi", a file) does **not** dead-end: the language is taken from the script they wrote in (Arabic letters → Arabic, Latin → English; digits/emoji only → ask again once, then English), and the message is then handled normally.
- "language", "اللغة", "english", "عربي" switch at any time, from any state, without losing the booking in progress.
- The choice is stored on the client (and on the session when there is no client row yet). Notifications sent later by the outbox, PDFs, and the assistant's answers all use it.
- With no choice (old sessions, tests, migration not yet applied) messages stay bilingual exactly as today.

### 2.2 Steps — identical to Telegram

Main menu: **Book my shipment · Track my shipment · Talk to an agent.**
Booking: name → phone → chassis (duplicate check) → make → loading port → destination → MRN choice → documents (loop until nothing missing) → review card → confirm/edit/cancel → submitted (reference + PDF). Tracking, talk-to-an-agent (office hours, after-hours urgency, direct line), MRN-by-MKY, the knowledge assistant: unchanged.

WhatsApp differences, all in the transport, none in the rules:

| Telegram | WhatsApp |
|---|---|
| "Share my number" reply keyboard | The sender's number is known. Phone step offers **[Use +20 100…] [Another number]**. |
| Inline keyboard, any size | ≤3 buttons → reply buttons; 4–10 → a list ("Choose"); >10 → split. Titles ≤20 (buttons) / ≤24 (list rows) characters, asserted at build time. |
| Message ≤4096 chars | Interactive body ≤1024: longer text is sent as a text message first, then the buttons with a short prompt. Plain text >4096 is split on paragraph boundaries. |
| Albums | No albums: every file is its own message; the batch logic (last to finish answers for all) applies unchanged. |
| Pinned status card | None; status changes are messages. |
| /reset deletes the chat | Cannot delete WhatsApp messages: "reset" clears our side and says so. |
| Bot may message any time | 24-hour window: free text only within 24 h of the client's last message; otherwise an approved template (§3.5). |

---

## 3. WhatsApp transport

### 3.1 Files
- `api/whatsapp.js` — webhook. GET: verify-token handshake. POST: signature check → claim → client upsert → language → input → `runFlow` → deliver. **The function count stays at 12**: `api/status.js` is folded into `api/health.js` (rewrite keeps `/api/status` working).
- `lib/whatsapp.js` — Graph API client (`fetch`, no SDK; never throws into the flow; logs non-2xx).
- `lib/channels.js` — one way to talk to a client on any channel: `sendToChat({ channel, chatId }, message, opts)` where `message` is the engine's `{ text, inline?, keyboard?, document? }`. Telegram delegates to `lib/telegram.js`; WhatsApp renders (§2.2 table). Every send is logged to `chat_messages`.
- `lib/chatlog.js` — `logInbound`, `logOutbound`, `markDelivery(providerId, status, error)`. Best effort: a logging failure never blocks a reply.

### 3.2 Identity
`ctx = { channel: 'whatsapp', chatId: 'wa:<wa_id>', waId: '<wa_id>', clientId, userName: profile.name, language, messageId: wamid, correlationId }`.
The `wa:` prefix keeps a WhatsApp chat id from ever equalling a Telegram chat id in any `chat_id` column. `clients.whatsapp_id` is unique; `upsertWhatsAppClient` mirrors `upsertTelegramClient`. The wa_id is the client's phone, stored in `clients.phone` if none is on file.

### 3.3 Inbound mapping
| Inbound | Engine input |
|---|---|
| text `menu` `start` `hi` `cancel` `reset` `help` (+ Arabic forms) | `command` |
| text `language` / `اللغة` / `english` / `عربي` | language switch |
| `STOP` / `توقف` | opt-out (§3.6) |
| other text | `text` |
| `interactive.button_reply.id` / `list_reply.id` | `callback` (ids are the engine's payloads: `menu:book`, `bk:confirm`…) |
| `button.payload` (template quick reply) | `callback` or `command` `/menu` |
| `contacts[0].phones[0]` | `contact` |
| `document`, `image` | file → `beginDocument` → 200 → background: caption, download by media id, `completeDocument`, batch, `document` |
| `audio`, `video`, `sticker`, `location`, `unsupported` | polite "I can read text, PDFs and photos" + menu |
| `reaction`, `statuses[]`, `errors[]` | no reply; statuses update `chat_messages` and the outbox row |

### 3.4 Order of business (mirrors `api/telegram.js`)
1. Verify `X-Hub-Signature-256` = HMAC-SHA256(**raw body**, `WHATSAPP_APP_SECRET`) with a timing-safe compare → else 401. (Raw body: Vercel parses JSON; the handler must read the raw bytes — `export const config = { api: { bodyParser: false } }` or equivalent.)
2. For each message: `claim_whatsapp_message(id)` — a retry loses the race.
3. Answer 200 quickly; files continue under `waitUntil`.
4. Mark as read + typing indicator (best effort).
5. Run the machine; if unhandled, the assistant answers in the client's language.
6. Drain the outbox (limit 5).

### 3.5 The 24-hour window and templates
`conversation_sessions.last_client_message_at` is stamped on every inbound message. `windowOpen` = within `whatsapp_window_hours` (default 24). Outbox rows for WhatsApp: window open → render and send as today; closed → the template from `bot_settings.whatsapp_templates[event_type]`, in the client's language, parameters filled from the payload. No template configured/approved → the row waits (`delivery_status = 'needs_template'`) and the desk shows it; it is **never** sent as free text outside the window (Meta would reject it, error 131047).

### 3.6 Failures and limits
| Meta says | We do |
|---|---|
| 131047 re-engagement (window closed) | Mark the outbox row `needs_template`; desk shows "customer hasn't written in 24 h". |
| 131026 / 131021 not a WhatsApp user / recipient = sender | Permanent failure, recorded. |
| 130429 / 131056 rate limits | Retry with backoff (outbox already does). |
| 131051 unsupported message type | Logged; the client gets the "I can read…" reply. |
| 132xxx template errors | Permanent for that template; desk shows the template name. |
| 190 / OAuth errors | Logged loudly; `/api/health` reports the token invalid. |
| Signature mismatch | 401, nothing processed. |
| Media URL expired | Fetch the URL again from the media id once, then fail the document politely. |

Opt-out: `STOP`/`توقف` sets `clients.opted_out_at`; the outbox stops sending marketing-like or proactive messages (it still answers when the client writes). `START`/`ابدأ` clears it.

Flood: more than 20 messages from one wa_id in 60 s → the extras are claimed and ignored with one "slow down" reply.

---

## 4. The MKY Desk

### 4.1 Who uses it and what they need

Booking desk, customs documentation, a supervisor; two to ten people; mostly a laptop all day, sometimes a phone. Their jobs, in order of frequency:

1. See what needs a person **now**.
2. Check a booking's documents against what the customer typed, and confirm it — or say exactly what is wrong.
3. Talk to the customer (they already know how WhatsApp looks).
4. Keep shipments moving and the customer told.
5. Find anything by chassis, reference, name or phone in one box.

### 4.2 Principles (and what each means on screen)

| Principle | On screen |
|---|---|
| **One place to look** (recognition over recall) | The Inbox is the home page and lists everything that needs a person — bookings, MRN applications, call-backs, failed messages — in one list, most urgent first. No hunting through seven menus. |
| **Say what to do, not what the data is** | Each row is a sentence: "Check 3 documents and confirm — Delta Trans, Volvo FH". Statuses are words ("Waiting for the customer"), never `needs_client_action`. |
| **One obvious next step** | Every case page has a "Next step" card with one primary button. Everything else is secondary. |
| **Show the consequence before it happens** | Any action that messages a customer shows the exact message, in the customer's language, before sending. Irreversible actions say so. |
| **Familiar shapes** | The conversation looks like a chat: customer left, us right, bot messages marked "Bot". |
| **Never colour alone** | Every status chip has a word; blue = ours to do, amber = waiting on the customer, green = done, red = something is wrong. |
| **Prevent errors rather than report them** | Buttons that cannot work are disabled with the reason beside them, not only on hover ("Two documents are not verified yet"). Double-clicks are ignored (each action carries an idempotency key). |
| **Nothing typed is ever lost** | Message drafts and notes are kept per case in the browser until sent. |
| **Stay true when others act** | Lists refresh every 20 s and on focus. An action on something another person just changed is refused with who and when: "Sara confirmed this 1 min ago — refreshed." |
| **Readable in both scripts** | Customer text is shown with `dir="auto"` per line; Arabic renders right-to-left. |

### 4.3 Layout

```
┌──────────┬────────────────────────────────────────────────────────────┐
│ MKY Desk │  🔍 Search chassis, reference, name, phone…      (/)       │
│          ├────────────────────────────────────────────────────────────┤
│ Inbox  7 │  Needs attention (7)  Waiting for customer (4)  Completed today (12) │
│ Chats    │  [All] [Bookings] [Call-back requests] [MRN applications] [Issues]  [Assigned to me] │
│ Shipments│ ────────────────────────────────────────────────────────── │
│ Settings │  🔴 Message failed — couldn't reach +20 100 555… · 5 min   │
│          │  🔵 Check 3 documents and confirm · Delta Trans · 2 h      │
│          │  🔵 Call back · Nile Motors · urgent · after hours · 40 m  │
│ ──────── │  🔵 Issue MRN · MKY-BKG-…-A1 · 1 d                         │
│ Ariful   │  ...                                                       │
│ Sign out │                                                            │
└──────────┴────────────────────────────────────────────────────────────┘
```

**Case page** (a booking, MRN request or call-back — same layout):

```
┌───────────────────────────────────────────────┬──────────────────────────┐
│ ← Inbox   MKY-BKG-261007-A1   Pending review  │  Delta Trans  🟢WhatsApp │
│ Volvo FH · YV2RT40A8FB712905 · Klaipeda → Alex│  +20 100 555 1234 · AR   │
├───────────────────────────────────────────────┤  ────────────────────────│
│ NEXT STEP                                     │  Conversation            │
│ All documents are in. Check them, then        │  [customer] السلام عليكم │
│ confirm the booking.                          │  [bot] أهلاً…            │
│ [ Confirm booking ]  Ask for something · Reject│  [Sara] ...  ✓✓ read     │
├───────────────────────────────────────────────┤                          │
│ DOCUMENTS                                     │  ── window open 21 h ── │
│ ✅ Invoice      checked by Sara        [View] │  ┌────────────────────┐  │
│ ⚪ MRN          received, not verified [View] │  │ Write in Arabic…   │  │
│ ⚠ Brief       chassis differs!        [View] │  └────────────────────┘  │
│                                               │  Saved replies ▾  [Send] │
│ DETAILS (click to correct)                    │                          │
│ INTERNAL NOTES (never sent)                   │                          │
│ HISTORY                                       │                          │
└───────────────────────────────────────────────┴──────────────────────────┘
```

Document viewer: the file on the left, what the bot read on the right (chassis, MRN, invoice number…) with mismatches against the booking highlighted, and two buttons: **Mark as verified** / **Request replacement** (reason: unreadable · wrong vehicle · wrong document · expired · other) → message preview in the customer's language → Send.

**Chats**: every conversation, newest first, unread first; WhatsApp and Telegram together, with a channel icon. Opening one shows the same conversation panel and the customer's bookings.

**Shipments**: confirmed shipments; change status / ETA / add an event; "tell the customer" is on by default and previews the message.

**Settings** (admin): team (names, roles), office hours, direct line, documents required, WhatsApp templates (which are configured; a test button), saved replies.

### 4.4 Desk edge cases

| Situation | Behaviour |
|---|---|
| Two people act on the same case | The second is refused with who/when; the page refreshes. |
| Customer writes while you type | The new message appears; your draft stays. |
| WhatsApp window closed | The banner takes the box's place: "Send the approved reply-request template. You can type a normal reply after the customer responds.", with the template button. What was typed is kept. |
| Window closes while you type | Send is refused with the same explanation; draft kept. |
| Message failed (Meta error) | One red line under the message with the reason in words (once for a run of the same), Retry sending where it can work, and it appears in Inbox → Issues. |
| Customer opted out | Composer disabled: "Wrote STOP on …". Replies to their own new messages still work. |
| Document unreadable / bot read nothing | Viewer says so; the person can type the values. |
| Signed file link expired | The viewer fetches a fresh one. |
| No documents required configured | Checklist says what is configured, never invents. |
| A role cannot do an action | Button disabled with "Only a supervisor can …". |
| Network drop | Banner "Offline — retrying"; actions are not sent twice (idempotency key). |
| Long lists | Paged (50) with "Show more"; search is server-side. |
| Very long customer text / Arabic | Wrapped, `dir="auto"`, never truncated without "Show all". |
| XSS in names/messages | All customer text set as text, never HTML. |
| Desk not configured (env missing) | A clear page saying which setting is missing. |

---

## 5. Bot edge cases (both channels)

| Situation | Behaviour |
|---|---|
| Same webhook delivered twice / out of order | Claimed by id; second is a no-op. Session state, not arrival order, decides. |
| Button tapped on an old message | The machine checks the move is legal from the current state (already does); stale → current step repeated. |
| Typed "2" instead of tapping | Picks the second offered button (already does). |
| Several files at once | Read in parallel; the last to finish answers for all. |
| Wrong file type / too big / password-protected / unreadable | Specific message saying what is accepted; the booking is not lost. |
| Document's chassis ≠ booking's | Reported first, before anything else. |
| Voice note, video, sticker, location | "I can read text, PDFs and photos" + menu. |
| Language switched mid-booking | Booking kept; next message in the new language. |
| Asks a question mid-booking | The assistant answers; the booking waits. |
| Comes back days later mid-draft | "You have an unfinished booking… Continue / Start over" (already does). |
| Writes after hours | Office hours, urgency question, direct line card on WhatsApp. |
| Blocked account | One message, nothing else processed. |
| Sends "STOP" | Opt-out recorded; confirmation sent once. |
| Floods messages | Rate-limited per chat. |
| Our server errors mid-turn | "Something went wrong" + retry button; the claim is marked failed so Meta's retry is processed. |
| WhatsApp token expired | Health check reports it; messages fail loudly in the log and the desk. |
| Customer's message has emoji / Arabic-Indic digits / mixed scripts | Normalised (already done for digits). |
| Empty or whitespace message | Ignored. |
| Profile name missing | Greeting without a name. |

---

## 6. Going live

Done on 7 October:
- Both migrations (`20261007090000`, `20261007100000`) are applied to the live Supabase project `kverwgcnvnferjewvvyr` and verified; existing bookings and clients untouched.
- Every table, column and function the code uses was checked against the live schema.
- A rehearsal against the live database, with Meta, Telegram and email faked, ran a full WhatsApp conversation (language, booking to the documents step, a real invoice read, a chassis mismatch caught, voice note, language switch, assistant answer in Arabic, cancel, STOP/START, a duplicate delivery) and the desk sending into it (window open, double click, window closed → template, opted out). All behaved as specified; all test rows were deleted.
- Branch `whatsapp-channel` builds on Vercel (preview deployment, behind Vercel Authentication).

Still to do:
1. **Meta**: in Business Settings → System users → *Automation2* → Assign assets → WhatsApp accounts → full control. From the app's WhatsApp → API Setup, copy the **Phone number ID** and **WhatsApp Business Account ID**.
2. **WhatsApp Manager**: submit the templates in `docs/WHATSAPP-TEMPLATES.md` (en + ar, Utility) — approval can take up to 48 h.
3. **Vercel env** (Production, and Preview if testing there): `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` (any long random string), optional `WHATSAPP_GRAPH_VERSION` (default `v23.0`).
4. **Deploy**: merge `whatsapp-channel` into `main`. The Telegram bot keeps working; clients who never chose a language are asked at their next hello.
5. **Meta webhook**: callback `https://mkc-global.vercel.app/api/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`, subscribe the `messages` field. (A preview deployment cannot receive it while Vercel Authentication protects previews.) Meta's "Test" button on the webhook page proves the signature check on the real host.
6. **First real test**: from a phone on the allowed list send "hi" → choose a language → book a test vehicle → open https://mkc-global.vercel.app/desk/ and find it in the Inbox.
7. **Supabase plan**: the free plan pauses the database after 7 idle days, which took the bot down in September. Pro ($25/month) does not pause.

---

## 7. Work packages

| Package | Owns | Must not touch |
|---|---|---|
| **A. Language** | `lib/flow/*`, `lib/i18n.js`, `lib/agent.js` (reply language), `lib/pdf.js` (language from client), flow tests | `api/*`, `lib/outbox.js`, `lib/notify.js`, `lib/telegram.js`, `lib/clients.js`, `lib/admin/*`, `public/*` |
| **B. WhatsApp** | `api/whatsapp.js`, `api/health.js` + `api/status.js` fold, `api/telegram.js` (logging, language wrap), `lib/whatsapp.js`, `lib/channels.js`, `lib/chatlog.js`, `lib/outbox.js`, `lib/notify.js`, `lib/clients.js`, `lib/documents.js`, `lib/storage.js`, `lib/config.js`, `vercel.json`, transport tests | `lib/flow/*` (except reading), `lib/admin/*`, `public/*` |
| **C. Desk** | `public/desk/*`, `public/ops*` redirects, `lib/admin/console.js`, `lib/ops/*`, `api/admin/*` routing, desk tests | `lib/flow/*`, `api/whatsapp.js`, `lib/outbox.js` |

Shared contracts already in the branch: `lib/lang.js` (turn language), `lib/flow/language.js` (stored language), the migration.
