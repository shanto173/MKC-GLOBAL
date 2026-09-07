# One unit, end to end

Everything below describes a single vehicle. Use these exact values and the
matched PDFs, and every cross-check in the bot has something real to agree on.

Regenerate the files at any time:

```bash
npm run testdocs -- W1T96340310484233
```

They land in `data/`, watermarked **SPECIMEN**, and are not valid for any real
shipment.

---

## The unit

| Field | Value |
|---|---|
| Chassis / VIN | `W1T96340310484233` |
| Make | `Mercedes-Benz` |
| Model | Actros 1845 LS, 2016 |
| Client name | `Nile Motors` |
| Port of loading | `Vilnius` |
| Destination | `Alexandria` |
| Gross weight | 8,266 kg |
| Value | 18,500.00 EUR |
| Incoterm | FOB Klaipeda |

Derived from the chassis, so they are the same every time you regenerate:

| | |
|---|---|
| MRN | `26LTVR610172694233` |
| ACID | `5403303639027120883` |
| EUR.1 | `AA 1017269` |

---

## The documents

| File | Reads as | Used for |
|---|---|---|
| `data/test-invoice.pdf` | `invoice` | required |
| `data/test-cmr-transport.pdf` | `brief` | required |
| `data/test-mrn-export-declaration.pdf` | `mrn` | required |
| `data/test-acid-nafeza.pdf` | `acid` | only when `bot_settings.acid_required` is `true` |
| `data/test-invoice-WRONG-CHASSIS.pdf` | `invoice`, chassis `W1T96340**9**10484233` | exercising the mismatch warning |

The required three come from `bot_settings.required_booking_documents`. Change
that row and the bot asks for something different, with no deployment.

---

## The happy path

Send `/start`, then tap through:

| You | The bot should |
|---|---|
| **📦 Book my shipment** | ask for the VIN / chassis number |
| `W1T96340310484233` | say **"This unit is new"**, then ask for the Make |
| `Mercedes-Benz` | ask for the client name |
| `Nile Motors` | ask where it ships from |
| `Vilnius` | list the five Egyptian ports |
| `Alexandria` | say **"Perfect! Let us continue"** and ask **"Do you already have an MRN?"** |
| **1️⃣ I already have an MRN** | ask for Invoice, Brief and MRN |
| send `test-invoice.pdf` | **"✅ Invoice received"** then **"⚠️ Just a little more"** — Brief, MRN |
| send `test-cmr-transport.pdf` | **"✅ Brief received"** then **"⚠️ Almost there — we just need your MRN"** |
| send `test-mrn-export-declaration.pdf` | **"✅ Perfect! We have everything we need"** and the summary card |
| **✅ Confirm** | **"🎉 Booking request confirmed"** — *not* "your booking is confirmed" |

The distinction on that last line is the point of the whole build: the client has
confirmed their **request**. Only Operations confirms the **booking**.

Then, in the console at `/ops.html`:

| Tab | What to do |
|---|---|
| **Bookings** | the request is waiting, with all three documents linked. Confirm it. |
| | the client gets **"🎉 Your booking is confirmed"** with a shipment reference |
| **Shipments** | the shipment now exists — set a vessel and an ETA |
| **Work queue** | the `new_booking_request` task was closed by the decision |

Back in the chat, **🚚 Track my shipment** → `W1T96340310484233` shows it.
**🔄 Refresh status** re-reads the database, so a vessel you set in the console
appears without restarting anything.

---

## Worth breaking on purpose

| Try this | What should happen |
|---|---|
| Book `W1T96340310484233` a second time | **"✅ This unit is already booked"** with the reference and route, and no second request |
| Send `test-invoice-WRONG-CHASSIS.pdf` during the document step | a warning that it names a different chassis — and it does **not** count as the invoice |
| Answer `Aswan` as the destination | refused, with the five ports we serve |
| Answer `12345` as the chassis | refused as not a chassis number, and nothing is stored |
| Tap **✅ Confirm** twice quickly | one submission, one Operations task, one message |
| Start a booking, then send `/cancel` | asked to confirm first; only the unfinished request is dropped |
| Start a booking, walk away, tap **📦 Book my shipment** again | offered **Continue** / **Start over** / **Main menu** — never silently resumed or discarded |
| Tap **💬 Contact our team → 👨‍💼 Talk to Operations** | with no `OPERATIONS_PHONE` set, it says a number is not configured rather than inventing one |
| Track a reference belonging to another chat | "we could not find a shipment" — identical to a genuine miss, so the bot cannot be used to test whether a reference exists |
| Ask "how long does shipping to Alexandria take?" mid-booking | answered from the knowledge base, and the booking survives |

---

## If something looks wrong

```bash
npm test                      # 94 tests, no network, no token, no model
npm run outbox -- --list      # messages waiting to reach a client
curl https://<your-app>/api/health
```

`/api/health` reports, by name, any table or function from migration 008 that
has not been applied — which is the most likely reason a freshly deployed bot
answers nothing at all.
