# Filming the Telegram bot

Every scene below starts from a clean chat and uses data that is live right
now. Nothing here needs setting up first.

**Reset between takes:** send `/reset`. It clears the conversation, deletes any
unfinished booking, and wipes the visible messages (Telegram only lets a bot
delete its own for 48 hours, so anything older stays on screen — start a fresh
chat if you need a truly empty window).

---

## Before you start

| | |
|---|---|
| Bot | your MKY bot in Telegram |
| Console | https://mkc-global.vercel.app/ops/ — sign in as `Ariful` |
| Old console | https://mkc-global.vercel.app/ops.html (only if you want to show it) |

Have the three document kits to hand. **Each kit can only be booked once** — a
chassis that has a live booking is refused, which is the point of Scene 5.

---

## Scene 1 — The welcome (20 seconds)

**You:** `/start`

**Bot:**
```
👋 Welcome Ariful to MKY Forwarding!
How can we help you today?
━━━━━━━━━━━━
[📦 احجز شحنة / Book my shipment]
[🚚 تتبع شحنتي / Track my shipment]
[💬 تواصل مع فريقنا / Contact our team]
```

Worth saying to camera: **three buttons, both languages, no typing.**

---

## Scene 2 — Book a shipment, tapping through (2–3 minutes)

Use **Kit A**. Tap **📦 Book my shipment**, then send one line at a time:

| You send | Bot asks next |
|---|---|
| `WMA06XZZ8KM745219` | ✅ *This unit is new* → Make |
| `MAN` | Client name |
| `Nile Cargo Egypt` | Where it ships from |
| `Hamburg` | Egyptian port (lists all five) |
| `Port Said` | ✅ *Perfect!* → **Do you already have an MRN?** |

Tap **1️⃣ I already have an MRN**, then send the three files **as documents**,
in this order:

| File | Bot replies |
|---|---|
| `takeA-invoice.pdf` | ✅ Invoice received → ⚠️ **Just a little more** (Brief, MRN) |
| `takeA-cmr-transport.pdf` | ✅ Brief received → ⚠️ **Almost there** (MRN) |
| `takeA-mrn-export-declaration.pdf` | ✅ **Perfect! We have everything** + the summary card |

Then tap **✅ Confirm**.

**Bot:** 🎉 *Booking request confirmed!* — followed by a **PDF of the request**.

> Point out on camera: it says **request** confirmed, not booking confirmed.
> The client has confirmed their request; Operations has not confirmed the
> booking. They are different things and the bot never conflates them.

Each upload takes a few seconds — it is reading the PDF and pulling the chassis
number out of it. Worth letting that breathe rather than cutting it.

---

## Scene 3 — Booking by pasting (45 seconds)

Reset first: `/reset`. Use **Kit B**. Tap **📦 Book my shipment**, then paste
this as **one message**:

```
Chassis: XLRTEH4300G512884
Make: DAF XF 480 FT
Client: Horus Logistics
Loading: Rotterdam
Destination: Damietta
```

The bot takes all five at once and jumps straight to **Do you already have an
MRN?** Good moment to say: *however the client writes it, one at a time or all
at once.*

---

## Scene 4 — MKY issues the MRN (1 minute)

Reset. Use **Kit C**, but tap **2️⃣ I need MKY to issue the MRN** instead.

```
VF622GPA000123457
Renault
Pyramid Freight
Vilnius
Alexandria
```

The bot opens an MRN application, gives you its reference, and asks for export
details. Type anything plausible:

```
Exported from Lithuania by UAB Baltic Auto, invoice 4471, buyer is Pyramid Freight Cairo.
```

Then send only **`takeC-invoice.pdf`** and **`takeC-cmr-transport.pdf`** — it
does **not** ask for the MRN, because the client does not have one. That is the
detail worth pointing at.

---

## Scene 5 — The duplicate guard (30 seconds)

Reset. Tap **📦 Book my shipment** and send a chassis that is already booked:

```
WDB96340310777421
```

**Bot:**
```
✅ This unit is already booked.

Booking Ref: MKY-BKG-260907-4YMR
Route: Vilnius → Alexandria Port (incl. El Dekheila)

No need to submit another request.
[🚚 Track shipment]  [🏠 Main menu]
```

Three other chassis are also blocked if you want alternatives:
`YV2RT40A8FB712905`, `WDB96340310889134`.

---

## Scene 6 — A document for the wrong vehicle (30 seconds)

During any booking's document step, send **`takeA-invoice-WRONG-CHASSIS.pdf`**.
It names a chassis one character different.

**Bot:** ⚠️ *That document shows chassis …, but this booking is for …* — and it
does **not** count as the invoice.

Say why it matters: a chassis mismatch is what gets a customs declaration
rejected, and it is exactly the typo a person skims past.

---

## Scene 7 — Track a shipment (45 seconds)

Reset. Tap **🚚 Track my shipment**, then send either:

```
WDB96340310777421
```
or the reference `MKY-BKG-260907-4YMR`.

**Bot:** 🔎 *Found it!*
```
📦 MKY-26025 — Mercedes-Benz
Chassis: WDB96340310777421
Status: In transit
Vessel: MSC Aurora
Route: Vilnius → Alexandria Port
ETA: 2026-09-19
Last update: In transit - ETA Alexandria 19 September
```

Then tap **🔄 Refresh status** — it re-reads the database rather than repeating
itself. To prove that on camera, change the status in the console (Shipments →
MKY-26025) between the two taps.

**Try a reference that does not exist** — `MKY-BKG-000000-XXXX` — and it offers
Try again / Contact our team / Main menu rather than inventing anything.

---

## Scene 8 — Contact our team (1 minute)

Reset. Tap **💬 Contact our team** → four choices.

**The one worth filming is 👨‍💼 Talk to Operations.** It asks for the problem
and a number. Type:

```
My invoice shows the wrong gross weight. Call me on +20 100 555 1234
```

**Bot:** 🎫 *Ticket MKY-TKT-… opened with Booking Operations.*

Then cut to the console → **Client Requests** and show the ticket sitting there
with the phone number and what they said.

You can also tap **📄 Documents → Missing documents** during an unfinished
booking and it lists exactly what is outstanding — computed from the database,
not recited.

---

## Scene 9 — The Operations side (2 minutes)

This is the half that makes the bot look like a product rather than a chatbot.

1. **Dashboard** — counters. Point at **Waiting for client** vs **Overdue**:
   the desk is never marked late for something the client owes.
2. **Booking Queue** — the **TURN** column. Blue **US**, amber **CLIENT**.
3. Open the booking from Scene 2. Show:
   - **Next required action** at the top, in a box
   - **Booking readiness** — the ticklist
   - **Documents** tab → **Verify** one, then **Reject / replace** another and
     watch the client get the message in Telegram
4. **Create the booking**, then **Confirm booking** — the modal lists what the
   client will be told.
5. Cut back to Telegram: 🎉 *Your booking is confirmed* **plus a second PDF**,
   this one headed **BOOKING CONFIRMATION**.

Hold the two PDFs side by side — the first says *AWAITING CONFIRMATION*, the
second says *CONFIRMED*.

---

## Scene 10 — Worth showing if you have time

| Say this | What happens |
|---|---|
| `عايز أحجز شحنة` | The whole flow in Arabic |
| `how long does shipping to Alexandria take?` mid-booking | Answered from the knowledge base, and the booking survives |
| `Aswan` as the destination | Refused, with the five ports we serve |
| `12345` as the chassis | Refused as not a chassis number |
| `/cancel` mid-booking | Asks first, then drops only the unfinished request |
| `/menu` then **Book** again | Offers **Continue booking / Start over** |

---

## If you need more kits

```bash
npm run testdocs -- <CHASSIS> "<CLIENT>" <MAKE> "<MODEL>" <CITY> <PORT> <PREFIX>
```

For example:

```bash
npm run testdocs -- ZFA25000002468013 "Delta Motors" Iveco "S-Way 480" Genoa Genoa takeD
```

Files land in `web/data/` as `takeD-invoice.pdf` and so on. Use a chassis
nobody has booked — anything not in the blocked list above.

---

## Two honest notes for the voiceover

**The bot never says a booking is confirmed when it is not.** A client
confirming their request and Operations confirming the booking are two separate
events, with two different messages and two different PDFs.

**Nothing on screen is invented.** Where the database holds no vessel or arrival
date, it says *Not assigned yet* and *Not available yet* — never a guess.
