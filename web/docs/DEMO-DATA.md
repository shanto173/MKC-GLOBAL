# Demo data

**The one file for testing or filming the bot.** Everything to type, per menu,
in English and in Arabic. Reset between takes with `/reset`.

Two earlier versions of this - DEMO-SCRIPT.md and TEST-DATA.md - were deleted:
three overlapping lists of test data is how somebody films with a chassis
number that was already booked.

---

## KIT A

| Field | Value |
|---|---|
| Chassis / VIN | `WMA06XZZ8KM745219` |
| Make | `MAN` |
| Model | `TGX 18.500` |
| Make + model in one | `MAN TGX 18.500` |
| Client name | `Nile Cargo Egypt` |
| Port of loading | `Hamburg` |
| Destination | `Port Said` |
| MRN | `26LTVR375677905219` |
| ACID | `5403302021162974530` |
| EUR.1 | `AA 7567790` |
| Weight | `8,266 kg` |
| Value | `18,500.00 EUR` |
| Incoterm | `FOB Hamburg` |
| Seller on the papers | UAB V.I.P INVESTMENT, Vilnius, Lithuania |
| Vehicle year | 2016 |
| Files | `takeA-invoice.pdf` · `takeA-cmr-transport.pdf` · `takeA-mrn-export-declaration.pdf` |
| Extra files | `takeA-acid-nafeza.pdf` · `takeA-invoice-WRONG-CHASSIS.pdf` |

## KIT B

| Field | Value |
|---|---|
| Chassis / VIN | `XLRTEH4300G512884` |
| Make | `DAF` |
| Model | `XF 480 FT` |
| Make + model in one | `DAF XF 480 FT` |
| Client name | `Horus Logistics` |
| Port of loading | `Rotterdam` |
| Destination | `Damietta` |
| MRN | `26LTVR366626942884` |
| ACID | `5403304380856638858` |
| EUR.1 | `AA 6662694` |
| Weight | `8,266 kg` |
| Value | `18,500.00 EUR` |
| Incoterm | `FOB Rotterdam` |
| Files | `takeB-invoice.pdf` · `takeB-cmr-transport.pdf` · `takeB-mrn-export-declaration.pdf` |
| Extra files | `takeB-acid-nafeza.pdf` · `takeB-invoice-WRONG-CHASSIS.pdf` |

## KIT C

| Field | Value |
|---|---|
| Chassis / VIN | `VF622GPA000123457` |
| Make | `Renault` |
| Model | `T High 520` |
| Make + model in one | `Renault T High 520` |
| Client name | `Pyramid Freight` |
| Port of loading | `Vilnius` |
| Destination | `Alexandria` |
| MRN | `26LTVR057185873457` |
| ACID | `5403301743740030109` |
| EUR.1 | `AA 5718587` |
| Weight | `8,266 kg` |
| Value | `18,500.00 EUR` |
| Incoterm | `FOB Klaipeda` |
| Files | `takeC-invoice.pdf` · `takeC-cmr-transport.pdf` · `takeC-mrn-export-declaration.pdf` |
| Extra files | `takeC-acid-nafeza.pdf` · `takeC-invoice-WRONG-CHASSIS.pdf` |

Each chassis can be booked **once**. After that it is blocked and shows the
duplicate message instead.

---

# MENU 1 — Book my shipment

## 1a. One answer at a time — KIT A

| # | Bot asks | You send |
|---|---|---|
| 1 | — | tap **📦 Book my shipment** |
| 2 | VIN / Chassis number | `WMA06XZZ8KM745219` |
| 3 | Make / Brand | `MAN` |
| 4 | Client name | `Nile Cargo Egypt` |
| 5 | Port of loading | `Hamburg` |
| 6 | Egyptian destination port | `Port Said` |
| 7 | Do you already have an MRN? | tap **1️⃣ I already have an MRN** |
| 8 | Upload Invoice, Brief, MRN | `takeA-invoice.pdf` |
| 9 | — | `takeA-cmr-transport.pdf` |
| 10 | — | `takeA-mrn-export-declaration.pdf` |
| 11 | Summary card | tap **✅ Confirm** |

Result: 🎉 Booking request confirmed + a PDF of the request.

## 1b. Pasted in one message — KIT B

Tap **📦 Book my shipment**, then paste:

```
Chassis: XLRTEH4300G512884
Make: DAF XF 480 FT
Client: Horus Logistics
Loading: Rotterdam
Destination: Damietta
```

Then: **1️⃣ I already have an MRN** → the three `takeB-` files → **✅ Confirm**.

## 1c. MKY issues the MRN — KIT C

| # | Bot asks | You send |
|---|---|---|
| 1 | VIN / Chassis number | `VF622GPA000123457` |
| 2 | Make / Brand | `Renault` |
| 3 | Client name | `Pyramid Freight` |
| 4 | Port of loading | `Vilnius` |
| 5 | Egyptian destination port | `Alexandria` |
| 6 | Do you already have an MRN? | tap **2️⃣ I need MKY to issue the MRN** |
| 7 | Export details | `Exported from Lithuania by UAB Baltic Auto, invoice 4471, buyer Pyramid Freight Cairo.` |
| 8 | Upload Invoice, Brief | `takeC-invoice.pdf` |
| 9 | — | `takeC-cmr-transport.pdf` |
| 10 | Summary card | tap **✅ Confirm** |

Only **two** documents — it does not ask for an MRN the client does not have.

## 1d. Edit before confirming

At the summary card, tap **✏️ Edit information** → **2️⃣ Make** → send `Scania`.

## 1e. Already booked

Tap **📦 Book my shipment**, send `WDB96340310777421`.

Also blocked: `YV2RT40A8FB712905`, `WDB96340310889134`.

## 1f. Wrong-chassis document

At the document step of any booking, send the WRONG-CHASSIS file. Each names a
chassis one digit off its own kit:

| File | Chassis inside | Kit it belongs to |
|---|---|---|
| `takeA-invoice-WRONG-CHASSIS.pdf` | `WMA06XZZ9KM745219` | A is `WMA06XZZ8KM745219` |
| `takeB-invoice-WRONG-CHASSIS.pdf` | `XLRTEH4390G512884` | B is `XLRTEH4300G512884` |
| `takeC-invoice-WRONG-CHASSIS.pdf` | `VF622GPA900123457` | C is `VF622GPA000123457` |

## 1g. Talking normally - KIT A, one message at a time

The bot reads the answer out of whatever sentence it arrives in. Nothing below
is a fixed phrase; type it however you like.

| # | You send | What it does |
|---|---|---|
| 1 | `the lorry needs collecting near Bremen and dropping at the Suez one` | keeps **loading Bremen** and **destination Suez Port**, then asks for the chassis |
| 2 | `sorry the chassis is WMA06XZZ8KM745219` | takes the number out of the sentence |
| 3 | `its a big scania` | make **Scania**, properly cased |
| 4 | `bill it to Cairo Heavy Haulage` | client **Cairo Heavy Haulage**, not the whole sentence |

Other things worth trying at any step:

| You send | What it does |
|---|---|
| `here is my chasis number : WMA06XZZ8KM745219` | finds the number |
| `I want my car to go to Port Said` | keeps the destination, asks for the chassis |
| `we ship from Hamburg` / `loading at Klaipeda` / `pick up at Rotterdam` | keeps the loading port |
| `chassis WMA06XZZ8KM745219 from Klaipeda going to Alexandria` | fills **three fields at once** |
| `my number is +20 100 555 1234` | kept as your contact, then asks again |
| `you can reach me at ariful@example.com` | same |
| `how long does shipping take?` | answers it, booking untouched |
| `where is my shipment` | switches to tracking |
| `I do not have it yet` | explains why the chassis cannot be skipped |
| `Alexandria Trading Co` as the **client name** | stays a client name - not read as a destination |

## 1h. Rejected inputs

| Send | Result |
|---|---|
| `12345` as the chassis | not a chassis number |
| `Aswan` as the destination | not a port we serve |
| `/cancel` mid-booking | asks first, then drops only the unfinished request |

---

# MENU 2 — Track my shipment

Tap **🚚 Track my shipment**, then send any of these:

| Send | Finds |
|---|---|
| `WDB96340310777421` | MKY-26025 · In transit · MSC Aurora · ETA 2026-09-19 |
| `MKY-BKG-260907-4YMR` | same, by booking reference |
| `MKY-26025` | same, by shipment reference |
| `wdb9634 0310 777421` | same — spacing and case do not matter |
| `MKY-BKG-000000-XXXX` | not found → Try again / Contact team / Main menu |

Then tap **🔄 Refresh status**.

Other trackable units:

| Chassis | Booking | Shipment |
|---|---|---|
| `YV2RT40A8FB712905` | MKY-BKG-260907-9KI6 | MKY-26035 |
| `WDB96340310889134` | MKY-BKG-260907-3HN2 | MKY-26027 |

---

# MENU 3 — Contact our team

Tap **💬 Contact our team** → four buttons.

## 3a. Talk to Operations

Tap **4️⃣ 👨‍💼 Talk to Operations**, then send:

```
My invoice shows the wrong gross weight. Call me on +20 100 555 1234
```

Result: 🎫 Ticket `MKY-TKT-…` opened with Booking Operations.

Variant — share the number first: tap **📱 Share my number**, and it asks for
the problem before opening anything.

## 3b. Booking

Tap **1️⃣ 📦 Booking**, then send `MKY-BKG-260907-4YMR`.

## 3c. Shipment tracking

Tap **2️⃣ 🚚 Shipment tracking**, then send `WDB96340310777421`.

## 3d. Documents

Tap **3️⃣ 📄 Documents** → **2️⃣ Missing documents**. Run this during an
unfinished booking and it lists exactly what is outstanding.

---

# COMMANDS

| Command | Does |
|---|---|
| `/start` | welcome + main menu |
| `/menu` | main menu |
| `/book` | straight into booking |
| `/track` | straight into tracking |
| `/cancel` | stop the unfinished booking, after asking |
| `/help` | what the bot can do |
| `/reset` | clear the conversation and the visible messages |

---

# ARABIC

**Yes - the bot replies in Arabic and takes the whole booking in Arabic.**

Every reply carries both languages: Egyptian colloquial Arabic first, a divider,
then the same message in English. That is deliberate - these cards get forwarded
to drivers, brokers and customs agents, and a card in only one language is
useless to at least one of them.

## A complete booking in Arabic - KIT A

| # | You send | Bot replies |
|---|---|---|
| 1 | `عايز أحجز شحنة` | تمام، يلا نبدأ الحجز. ابعتلي رقم الشاسيه |
| 2 | `رقم الشاسيه WMA06XZZ8KM745219` | تمام! الوحدة دي جديدة عندنا |
| 3 | `مرسيدس أكتروس` | الحجز هيتسجل باسم مين؟ |
| 4 | `شركة النيل للنقل` | هتشحن من فين؟ |
| 5 | `الشحن من فيلنيوس` | وميناء الوصول في مصر؟ |
| 6 | `الإسكندرية` | تمام! عندك رقم MRN بالفعل؟ |

**What gets stored** - worth showing on camera, because it is the point:

| Field | Stored as | Why |
|---|---|---|
| Chassis | `WMA06XZZ8KM745219` | taken out of the Arabic sentence |
| Make | `Mercedes-Benz` | مرسيدس transliterated for the paperwork |
| Model | `Actros` | أكتروس, split off the make |
| Loading | `Vilnius` | فيلنيوس - it goes on the bill of lading |
| Destination | `Alexandria Port (incl. El Dekheila)` | الإسكندرية matched to our port list |
| Client | `شركة النيل للنقل` | left in Arabic - a wrong Latin guess at somebody's company name is worse than Arabic they can read |

## Other Arabic phrases

| Send | Does |
|---|---|
| `الشحنة فين` | starts tracking |
| `عايز أكلم موظف` | contact the team |
| `معنديش الرقم دلوقتي` | explains the chassis cannot be skipped |
| `ماشي ابعت العربية من كوبر لبورسعيد` | loading Koper, destination Port Said |
| `1` `2` `3` | the three menu choices |

Franco-Arabic works too - `el sha7na fen?` is understood and answered in Arabic
script.

---

# OPERATIONS CONSOLE

https://mkc-global.vercel.app/ops/ — sign in as `Ariful` with the admin secret.

| Screen | Shows |
|---|---|
| Dashboard | counters, my tasks, unassigned work, recent activity |
| Booking Queue | TURN column: **US** vs **CLIENT** |
| A booking | next action, readiness ticklist, documents, MRN, messages, activity |
| Documents tab | **Verify** / **Reject / replace** |
| Client Requests | the ticket from 3a |
| Shipments | MKY-26025 → set a vessel or ETA, then Refresh in Telegram |

Confirm the booking from Scene 1a and the client gets a second PDF, headed
**BOOKING CONFIRMATION** instead of **BOOKING REQUEST**.

---

# MORE KITS

```bash
npm run testdocs -- <CHASSIS> "<CLIENT>" <MAKE> "<MODEL>" <CITY> <PORT> <PREFIX>
```

```bash
npm run testdocs -- ZFA25000002468013 "Delta Motors" Iveco "S-Way 480" Genoa Genoa takeD
```

Files land in `web/data/` as `takeD-invoice.pdf` and so on.
