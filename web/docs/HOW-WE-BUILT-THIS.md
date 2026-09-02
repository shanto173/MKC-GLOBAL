# How we built the MKC Global chatbot

A plain-English explanation of what we made, how it works, and why we made each
choice. No programming knowledge needed.

Written for anyone at MKC Global who needs to understand the system.

---

## 1. What problem does it solve?

Customers ask the same questions all day:

- *"Where is my shipment?"*
- *"What documents do I need?"*
- *"How long does it take from Rotterdam?"*
- *"I want to book a shipment."*

A staff member has to stop work, look it up, and reply. At night and on Friday
and Saturday, nobody replies at all.

The chatbot answers these instantly, 24 hours a day, in Telegram or on the
website. When a customer wants to book, it collects the details and saves the
booking, then emails our team.

**The most important rule: the bot never guesses.** It only tells a customer
something it actually looked up in our database. If it does not know, it says so
and offers to pass the customer to a human.

---

## 2. The five parts

Think of it like an office.

| Part | What it is | Its job in simple words |
|---|---|---|
| **Telegram** | The chat app customers already use | The front desk where customers walk in |
| **Vercel** | A company that runs our code on the internet | The office building. Always open, we pay nothing |
| **Supabase** | An online database | The filing cabinet. Shipments, bookings, documents |
| **OpenAI** | The AI service | The clerk who understands the question and writes the reply |
| **Resend** | An email service | The post room that sends confirmation emails |

All five have a free plan. Today the whole system costs about **$5**, which is
prepaid credit for the AI and will last a very long time.

---

## 3. What happens when a customer sends a message

Say a customer types: **"Where is MKC-24001?"**

```
1. Customer types in Telegram
        |
2. Telegram sends the message to our code on Vercel
        |
3. Our code asks the AI: "What does this person want?"
        |
4. AI replies: "They want shipment MKC-24001. Look it up."
        |
5. Our code runs a real database search in Supabase
        |
6. Database returns: departed Rotterdam, MSC Aurora, ETA 8 September
        |
7. Our code gives that answer to the AI: "Here are the facts."
        |
8. AI writes a friendly sentence using ONLY those facts
        |
9. Customer receives the reply. Total time: about 3 seconds.
```

**Step 5 is the key.** The AI is not allowed to answer from memory. It must ask
our database first. This is why the bot cannot invent a fake shipment status.

The AI has five things it is allowed to do:

1. **Look up a shipment** — by reference, ACID, B/L, container, or customer name
2. **Search company documents** — services, ports, documents, customs, payment
3. **Create a booking** — save a new booking request
4. **List past bookings** — from that same chat
5. **Create a support ticket** — pass the customer to a human department

Nothing else. It cannot delete data, change a shipment, or quote a price.

---

## 4. How the bot knows about our company

We gave it two files:

**A PDF** — the company handbook. Services, the five Egyptian ports we serve,
required documents, how ACID and MRN work, transit times, payment terms,
cut-off times, claims, and department contacts.

**An Excel file** — the operational data. Five sheets: Shipments, Tracking
Events, Clients, Departments, Company Info.

We then run two commands:

- `npm run seed` — reads the Excel and fills the database tables
- `npm run ingest` — reads the PDF and Excel, cuts the text into small pieces,
  and stores each piece in the database in a way the computer can search by
  *meaning*, not just by keyword

That second part matters. If a customer asks *"how long from Holland?"*, the
handbook says *"Rotterdam to Alexandria 11 to 13 days"*. The words do not match,
but the meaning does, and the system still finds it.

**To update the bot's knowledge, you do not touch any code.** Replace the Excel
with a fresh export, or drop a new PDF in the folder, and run those commands
again.

---

## 5. What happens when someone books

This is the part that saves the most staff time.

The bot asks for the details one or two at a time, like a normal conversation:
name, contact, origin country, port of loading, destination port, what the
cargo is, weight, volume, Incoterm, ready date.

Then it reads the summary back and waits for the customer to say yes.

When they confirm:

1. A booking is saved in the database with a reference like `MKC-BKG-260902-AC3N`
   and status `pending_review`
2. A **PDF confirmation** is created
3. The **customer** gets an email with the PDF
4. **Our booking inbox** gets an email with the PDF, with reply-to set to the
   customer so staff can answer directly
5. A **staff Telegram group** gets the PDF as a file *(being set up)*

The PDF clearly says **"this is a request, not a confirmed booking"**. Space and
price are always confirmed by a human. The bot never quotes a price — that would
create real liability if it got it wrong.

**Important safety design:** the booking is saved to the database *first*, and
only then do the emails go out. If the email service is down, the booking is
still safe. We never lose a customer's booking because of an email problem.

---

## 6. The order we built it

1. **Planned the shape** — one "brain" shared by Telegram and the website, so we
   never write the same logic twice
2. **Designed the database** — 8 tables: shipments, tracking events, bookings,
   support tickets, clients, company documents, chat history, and a small table
   that stops the same message being answered twice
3. **Created the demo PDF and Excel** — realistic MKC data so we could test
   properly before touching real customer records
4. **Built the AI part** — the loop where the AI asks for information, we fetch
   it, and it writes the answer
5. **Tested from the terminal** — before any deployment, before Telegram
6. **Put it online** — GitHub for the code, Vercel to run it
7. **Connected Telegram**
8. **Added booking emails and the PDF**

We tested at every step instead of building everything and hoping. Several
problems were caught this way (next section).

---

## 7. Problems we hit, and how we fixed them

Worth reading — these are the things that would have caused real trouble.

**The bot created the same booking twice.**
It saved once when it had the details, then again when the customer said "yes,
book it". Two rows for one shipment would confuse the ops desk. *Fix:* before
saving, the code checks whether the same chat already booked the same cargo to
the same port in the last 30 minutes. If so, it returns the existing reference.

**The bot wrote the wrong year on a date.**
A customer said "ready on 15 September" and it saved **2023**-09-15. *Fix:* the
code now checks any date in the past and moves it forward to the correct year.

**The bot refused to answer a question it could answer.**
Asked "how long from Rotterdam to Alexandria", it said it did not know — even
though the handbook says 11 to 13 days. It had not bothered to search. *Fix:* we
changed its instructions to forbid saying "I don't know" unless it actually
searched first.

**Deployment kept failing silently.**
Our code was reaching GitHub but Vercel refused to publish it. The reason was
that the commits were recorded under the wrong email address, so Vercel thought
a stranger was trying to deploy. *Fix:* set the correct account email.

**Settings were saved but nothing changed.**
We added the email keys in Vercel and the system still said they were missing.
Vercel locks settings into a build when it publishes. Changing a setting does
nothing until you publish again. *Fix:* redeploy after changing any setting.
Remember this one — it will happen again.

**A tool for reading PDFs was rejecting valid PDFs.**
The library we used was from 2018 and refused our own file. We checked with a
current library and the file was perfectly fine. *Fix:* switched to the modern
one. This matters because real customs documents will be fed through it.

---

## 8. Keeping it safe

- The database key sits only on the server. It is never sent to a web browser.
- Every table is locked by default. Even if the public key leaked, it reads
  nothing.
- Telegram messages carry a secret password that only Telegram and our server
  know, so a stranger who finds the address cannot control the bot.
- The bot refuses to reveal customer email addresses, even when asked cleverly.
  We tested this.
- The bot never quotes prices.

**Still to do:** the website chat page is open to anyone on the internet and
spends our AI credit. Before we advertise it publicly we should add a limit.
Telegram is already protected.

---

## 9. What it costs

| Service | Free allowance | When we would pay |
|---|---|---|
| Vercel | Generous; enough for us | $20/month if we grow a lot |
| Supabase | 500 MB database | $25/month at about 8 GB |
| OpenAI | Pay as you go | ~$5 covers roughly 20,000 customer chats |
| Resend | 3,000 emails/month | Unlikely to exceed |

We picked the cheapest AI model that still works reliably, and tested six
different ones before choosing. The cheapest was also the fastest.

---

## 10. Where everything lives

- **Code:** github.com/shanto173/MKC-GLOBAL, in the `web` folder
- **Website:** https://mkc-global.vercel.app
- **Telegram bot:** @MKC_Global_bot
- **Database:** Supabase dashboard, project `mkc-global-bot`
- **Health check:** https://mkc-global.vercel.app/api/health — open this any
  time; it says in plain text whether every part is working

To see bookings the bot has taken: Supabase → **Table Editor** → **bookings**.

---

## 11. What is still to do

| Task | Why it matters |
|---|---|
| Put real shipment data in | The 12 shipments now are invented examples |
| Verify our email domain | Until then customers do not receive their confirmation — only our own inbox does |
| Finish the staff Telegram group | So the team sees bookings instantly |
| Replace the security keys | Some keys were shared during setup and should be renewed |
| Limit the website chat | To stop strangers using our AI credit |
| Decide how long to keep chat history | We store conversations; we should set a rule |

---

## 12. Honest limits

Worth being clear about what this is not.

- It **does not connect to our main system**. It reads a copy in Supabase. The
  copy has to be refreshed — by uploading an Excel export, or by a small
  automatic job we would still need to write.
- It **does not create invoices**. There is no pricing in it at all. It collects
  a booking request; a human prices and confirms.
- It **cannot change a shipment**. It only reads.
- It works in **English and Arabic**, but Arabic is untested with real customers.
- It is on **Telegram**, not WhatsApp. WhatsApp is possible and the main work is
  already done, but WhatsApp requires business verification with Meta, which
  takes days and is not free beyond a monthly allowance.

---

## Quick glossary

| Word | Plain meaning |
|---|---|
| **Deploy** | Publish the code so it runs on the internet |
| **Database** | An organised filing cabinet a computer can search instantly |
| **API key** | A password that lets our code use another company's service |
| **Environment variable** | A setting stored outside the code, like a password |
| **Repository (repo)** | The folder holding all our code and its history |
| **Webhook** | An address Telegram sends new messages to |
| **RAG** | Letting the AI search our own documents before answering |
| **Serverless** | Code that runs only when needed, so we pay nothing when idle |
