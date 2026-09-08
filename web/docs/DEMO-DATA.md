# Demo data

Everything below is written the way the **bot** wants it: plain lines you can
copy and send. Nothing here is laid out as a table, because a table copied out of
a document arrives in the chat as backticks and row numbers run together — the
bot reads that too now, but it is not what you should be sending.

Bot — your MKY bot in Telegram
Operations console — https://mkc-global.vercel.app/ops/ — sign in as `Ariful`
Health check — https://mkc-global.vercel.app/api/health

---

# HOW MUCH YOU CAN PASTE

**Any shape. One message.** Labels, no labels, a sentence, Arabic, or a table
copied from somewhere else. Two layers read it: fixed patterns first, and where
those find nothing, the language model — which **extracts only**. Every value
either layer produces is validated exactly as if you had typed it on its own: a
chassis still has to look like a chassis, a port still has to be one of the five
we serve.

All four of these send the same booking.

Labelled:

```
Chassis: WMA06XZZ8KM745219
Make: MAN TGX 18.500
Client: Nile Cargo Egypt
Loading: Hamburg
Destination: Port Said
```

On one line:

```
WMA06XZZ8KM745219, MAN TGX 18.500, Nile Cargo Egypt, from Hamburg to Port Said
```

As a sentence:

```
Hi, I need to ship a MAN TGX 18.500 for Nile Cargo Egypt. The chassis is WMA06XZZ8KM745219. We are loading it in Hamburg and it needs to come into Port Said.
```

Or a table copied out of a document, mangled on the way in — still read
correctly, and this exact shape is now a regression test:

```
VIN / Chassis number`WMA06XZZ8KM745219`Make / Brand`MAN`Client name`Nile Cargo Egypt`Port of loading`Hamburg`Egyptian destination port`Port Said
```

The label can be anything recognisable — Chassis, VIN, Make, Brand, Client,
Customer, Loading, From, Destination, To — and the separator can be a colon, an
equals sign, a backtick, a pipe, or just two spaces. Partial pastes are fine:
send three of the five and it asks for the other two.

---

# THE THREE KITS

The same three vehicles as the PDFs in `web/data/`. Chassis, MRN and ACID are
checksum-correct, and the numbers in the papers match the numbers here.

## KIT A — MAN, into Port Said

Paste this to book it in one message:

```
Chassis: WMA06XZZ8KM745219
Make: MAN TGX 18.500
Client: Nile Cargo Egypt
Loading: Hamburg
Destination: Port Said
```

One answer at a time instead — send these in order:

```
WMA06XZZ8KM745219
MAN
Nile Cargo Egypt
Hamburg
Port Said
```

On the paperwork — MRN `26LTVR375677905219` · ACID `5403302021162974530` ·
EUR.1 `AA 7567790` · 8,266 kg · 18,500.00 EUR · FOB Hamburg · seller
UAB V.I.P INVESTMENT, Vilnius, Lithuania.

Files — `takeA-invoice.pdf`, `takeA-cmr-transport.pdf`,
`takeA-mrn-export-declaration.pdf`. Spares: `takeA-acid-nafeza.pdf`,
`takeA-invoice-WRONG-CHASSIS.pdf`.

## KIT B — DAF, into Damietta

```
Chassis: XLRTEH4300G512884
Make: DAF XF 480 FT
Client: Horus Logistics
Loading: Rotterdam
Destination: Damietta
```

One at a time:

```
XLRTEH4300G512884
DAF
Horus Logistics
Rotterdam
Damietta
```

On the paperwork — MRN `26LTVR366626942884` · ACID `5403304380856638858` ·
EUR.1 `AA 6662694`.

Files — `takeB-invoice.pdf`, `takeB-cmr-transport.pdf`,
`takeB-mrn-export-declaration.pdf`. Spares: `takeB-acid-nafeza.pdf`,
`takeB-invoice-WRONG-CHASSIS.pdf`.

## KIT C — Renault, into Alexandria, MKY issues the MRN

```
Chassis: VF622GPA000123457
Make: Renault T High 520
Client: Pyramid Freight
Loading: Vilnius
Destination: Alexandria
```

One at a time:

```
VF622GPA000123457
Renault
Pyramid Freight
Vilnius
Alexandria
```

On the paperwork — MRN `26LTVR057185873457` · ACID `5403301743740030109` ·
EUR.1 `AA 5718587`.

Files — `takeC-invoice.pdf`, `takeC-cmr-transport.pdf`,
`takeC-mrn-export-declaration.pdf`. Spares: `takeC-acid-nafeza.pdf`,
`takeC-invoice-WRONG-CHASSIS.pdf`.

---

# MENU 1 — Book my shipment

## 1a. One answer at a time — KIT A

1. Tap **📦 Book my shipment**
2. VIN / Chassis number → `WMA06XZZ8KM745219`
3. Make / Brand → `MAN`
4. Client name → `Nile Cargo Egypt`
5. Port of loading → `Hamburg`
6. Egyptian destination port → `Port Said`
7. Do you already have an MRN? → tap **1️⃣ I already have an MRN**
8. Upload Invoice, Brief, MRN → send `takeA-invoice.pdf`
9. → send `takeA-cmr-transport.pdf`
10. → send `takeA-mrn-export-declaration.pdf`
11. Summary card → tap **✅ Confirm**

**What you get back:** 🎉 *Booking request confirmed*, **and a PDF headed
BOOKING REQUEST — STATUS: AWAITING CONFIRMATION.** Keep it; you will compare it
with the second one later.

Send the documents **as files, not photos** — Telegram re-encodes photos to
JPEG, which strips the text layer and forces slower image reading.

## 1b. The whole booking in one message

Tap **📦 Book my shipment**, then paste any kit block from above. It goes
straight to the MRN question.

## 1c. Talking normally — no fixed phrases

Start a fresh booking and send these, one message at a time:

`the lorry needs collecting near Bremen and dropping at the Suez one`
→ keeps loading **Bremen** and destination **Suez Port**, asks for the chassis

`sorry the chassis is WMA06XZZ8KM745219`
→ takes the number out of the sentence

`its a big scania`
→ make **Scania**, properly cased

`bill it to Cairo Heavy Haulage`
→ client **Cairo Heavy Haulage**, not the whole sentence

Anything else worth trying, at any step:

`here is my chasis number : WMA06XZZ8KM745219` → finds the number

`I want my car to go to Port Said` → keeps the destination, asks for the chassis

`we ship from Hamburg` · `loading at Klaipeda` · `pick up at Rotterdam`
→ keeps the loading port

`chassis WMA06XZZ8KM745219 from Klaipeda going to Alexandria`
→ fills three fields at once

`my number is +20 100 555 1234` → kept as your contact, then asks again

`you can reach me at ariful@example.com` → same

`how long does shipping take?` → answers it, and the booking is untouched

`where is my shipment` → switches to tracking

`I do not have it yet` → explains why the chassis cannot be skipped

`Alexandria Trading Co` as the **client name** → stays a client name, *not* read
as a destination

That last one is the one to point at: a place is only read as a destination when
the sentence points at it. A company name containing a city stays a company name.

## 1d. MKY issues the MRN — KIT C

1. VIN / Chassis number → `VF622GPA000123457`
2. Make / Brand → `Renault`
3. Client name → `Pyramid Freight`
4. Port of loading → `Vilnius`
5. Egyptian destination port → `Alexandria`
6. Do you already have an MRN? → tap **2️⃣ I need MKY to issue the MRN**
7. Export details → paste this:

```
Exported from Lithuania by UAB Baltic Auto, invoice 4471, buyer Pyramid Freight Cairo.
```

8. Upload Invoice, Brief → send `takeC-invoice.pdf`
9. → send `takeC-cmr-transport.pdf`
10. Summary card → tap **✅ Confirm**

Only **two** documents — it does not ask for an MRN the client does not have. An
MRN application appears in the console under **MRN Requests**.

## 1e. Edit before confirming

At the summary card, tap **✏️ Edit information** → **2️⃣ Make** → send `Scania`.

Editing the **chassis** re-runs the duplicate check; editing the **route** asks
for the loading point and then the destination.

## 1f. Already booked

Tap **📦 Book my shipment**, then send `WDB96340310777421`.

Also blocked: `YV2RT40A8FB712905` and `WDB96340310889134`.

## 1g. Wrong-chassis document

At the document step, send a WRONG-CHASSIS file. Each names a chassis one digit
off its own kit, and it does **not** count as the invoice.

`takeA-invoice-WRONG-CHASSIS.pdf` holds `WMA06XZZ9KM745219`, where A is
`WMA06XZZ8KM745219`

`takeB-invoice-WRONG-CHASSIS.pdf` holds `XLRTEH4390G512884`, where B is
`XLRTEH4300G512884`

`takeC-invoice-WRONG-CHASSIS.pdf` holds `VF622GPA900123457`, where C is
`VF622GPA000123457`

## 1h. Rejected inputs

`12345` as the chassis → not a chassis number

`Aswan` as the destination → not a port we serve, with the five listed

`/cancel` mid-booking → asks first, then drops only the unfinished request

Tapping **Book** again after abandoning one → offers **Continue booking /
Start over**

---

# MENU 2 — Track my shipment

Tap **🚚 Track my shipment**, then send any of these:

`WDB96340310777421` → MKY-26025 · In transit · MSC Aurora · ETA 2026-09-19

`MKY-BKG-260907-4YMR` → the same, by booking reference

`MKY-26025` → the same, by shipment reference

`wdb9634 0310 777421` → the same; spacing and case do not matter

`MKY-BKG-000000-XXXX` → not found → Try again / Contact team / Main menu

Then tap **🔄 Refresh status**. To prove it re-reads the database rather than
repeating itself, change the status in the console (**Shipments → MKY-26025**)
between the two taps.

Other trackable units:

`YV2RT40A8FB712905` → booking MKY-BKG-260907-9KI6 → shipment MKY-26035

`WDB96340310889134` → booking MKY-BKG-260907-3HN2 → shipment MKY-26027

A booking that has been confirmed but has no shipment yet says so, rather than
showing empty fields. Where the database holds no vessel or arrival date it reads
**Not assigned yet** and **Not available yet** — never a guess.

---

# MENU 3 — Contact our team

Tap **💬 Contact our team** → four buttons.

## 3a. Talk to Operations

Tap **4️⃣ 👨‍💼 Talk to Operations**, then send:

```
My invoice shows the wrong gross weight. Call me on +20 100 555 1234
```

🎫 Ticket `MKY-TKT-…` is opened with Booking Operations and appears in the
console under **Client Requests**.

**The variant worth filming:** tap **📱 Share my number** *first*. It takes the
number and then asks what the problem is — it will not raise a ticket that tells
the desk a phone number and nothing else.

## 3b. Booking

Tap **1️⃣ 📦 Booking**, then send `MKY-BKG-260907-4YMR`.

A reference belonging to somebody else returns "we could not find it" — the same
answer as a genuine miss, so the bot cannot be used to discover whether a
reference exists.

## 3c. Shipment tracking

Tap **2️⃣ 🚚 Shipment tracking**, then send `WDB96340310777421`.

## 3d. Documents

Tap **3️⃣ 📄 Documents** → **2️⃣ Missing documents**. Run this during an
unfinished booking and it lists exactly what is outstanding, computed from the
database rather than recited.

---

# COMMANDS

`/start` — welcome and main menu

`/menu` — main menu

`/book` — straight into booking

`/track` — straight into tracking

`/cancel` — stop the unfinished booking, after asking

`/help` — what the bot can do

`/reset` — clear the conversation and the visible messages

---

# ARABIC

**Yes — the bot replies in Arabic and takes the whole booking in Arabic.**

Every reply carries both languages: Egyptian colloquial Arabic first, a divider,
then the same message in English. That is deliberate — these cards get forwarded
to drivers, brokers and customs agents, and a card in one language only is
useless to at least one of them.

## A complete booking in Arabic — KIT A

Send these one at a time.

```
عايز أحجز شحنة
```
→ تمام، يلا نبدأ الحجز. ابعتلي رقم الشاسيه

```
رقم الشاسيه WMA06XZZ8KM745219
```
→ تمام! الوحدة دي جديدة عندنا

```
مرسيدس أكتروس
```
→ الحجز هيتسجل باسم مين؟

```
شركة النيل للنقل
```
→ هتشحن من فين؟

```
الشحن من فيلنيوس
```
→ وميناء الوصول في مصر؟

```
الإسكندرية
```
→ تمام! عندك رقم MRN بالفعل؟

Or the whole thing in one message:

```
رقم الشاسيه: WMA06XZZ8KM745219
الماركة: مرسيدس أكتروس
العميل: شركة النيل للنقل
الشحن من: فيلنيوس
ميناء الوصول: الإسكندرية
```

**What gets stored** — worth showing on camera, because it is the point:

Chassis → `WMA06XZZ8KM745219`, taken out of the Arabic sentence

Make → `Mercedes-Benz`, مرسيدس transliterated for the paperwork

Model → `Actros`, أكتروس split off the make

Loading → `Vilnius`, from فيلنيوس, because it goes on the bill of lading

Destination → `Alexandria Port (incl. El Dekheila)`, الإسكندرية matched to our
port list

Client → `شركة النيل للنقل`, **left in Arabic** — a wrong Latin guess at
somebody's company name is worse than Arabic they can read

## Other Arabic phrases

`الشحنة فين` → starts tracking

`عايز أكلم موظف` → contact the team

`معنديش الرقم دلوقتي` → explains the chassis cannot be skipped

`ماشي ابعت العربية من كوبر لبورسعيد` → loading Koper, destination Port Said

`1` `2` `3` → the three menu choices

Franco-Arabic works too — `el sha7na fen?` is understood and answered in Arabic
script.

---

# OPERATIONS CONSOLE

https://mkc-global.vercel.app/ops/ — sign in with your name (`Ariful`) and the
admin secret. This is the half that makes it a product rather than a chatbot.

## The walkthrough

1. **Dashboard** — clickable counters. Point at **Waiting for client** next to
   **Overdue**: the desk is never marked late for something the client owes.
2. **Booking Queue** — the **TURN** column, blue **US** against amber
   **CLIENT**, and the **Next action** column saying what to do.
3. **Open the booking from 1a**:
   - **Next required action** in a box at the top
   - **Booking readiness** — the ticklist
   - **Documents** tab → **Verify** one, then **Reject / replace** another and
     watch the client receive the message in Telegram
   - **Messages** tab → the two composers, yellow **internal note** and blue
     **message to client**, deliberately impossible to confuse
4. **Create the booking** → enter a reference → **Confirm booking**. The modal
   lists exactly what the client will be told.
5. **Back to Telegram:** 🎉 *Your booking is confirmed*, **plus a second PDF**,
   this one headed **BOOKING CONFIRMATION — STATUS: CONFIRMED**.

**Hold the two PDFs side by side.** The first says *AWAITING CONFIRMATION*, the
second *CONFIRMED*. A client confirming their request and Operations confirming
the booking are different events, and the bot never conflates them.

## The other screens

**MRN Requests** — the application from 1d; record an MRN and the client is told

**Document Review** — everything waiting to be checked, across all bookings

**Client Requests** — the ticket from 3a, with the phone number and what they
said; reply, or **Send and wait for them**

**Confirmed Bookings** — what was confirmed, by whom, with its shipment

**Shipments** — MKY-26025 → set a vessel or ETA, tick **Tell the client**, then
Refresh in Telegram

**My Tasks** — just what is assigned to you

## Client responds → it comes back

Worth demonstrating: from a booking, use **Request info** to ask the client for
something. The request moves to **Waiting for Client** and leaves the desk's
pile. Reply in Telegram, and it reappears in the queue as **Under Review** with a
green **New reply** badge.

---

# MORE KITS

```bash
npm run testdocs -- <CHASSIS> "<CLIENT>" <MAKE> "<MODEL>" <CITY> <PORT> <PREFIX>
```

```bash
npm run testdocs -- ZFA25000002468013 "Delta Motors" Iveco "S-Way 480" Genoa Genoa takeD
```

Files land in `web/data/` as `takeD-invoice.pdf` and so on. Use a chassis nobody
has booked — anything not in the blocked list above.
