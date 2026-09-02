# MKC Global Logistics — chatbot

> **Production bot lives in [`web/`](web/).** Telegram + web chat, backed by a
> Supabase database, deployed on Vercel.
> **Setup guide: [`web/docs/SETUP.md`](web/docs/SETUP.md)**
>
> The Streamlit app documented below is the original local prototype. It is kept
> for reference; it does not connect to the live database.

---

# ABC Global Forwarding Chatbot

A local Streamlit prototype for freight bookings, shipment tracking, FAQ answers, and department-based support routing. The interface is inspired by a verified business conversation in WhatsApp, while using original ABC branding.

## What is included

- Guided new-booking flow for freight from the EU, UK, or USA to five supported Egyptian ports
- Multi-file upload step for MRN, ACID, invoice, packing list, and vehicle documents
- Example external booking-form link
- Instant shipment or ACID lookup against 10 fictional sample clients
- Help menu that routes issues to Booking Operations, Accounts & Payments, Tracking Desk, Customs Documentation, or Customer Care
- Small CSV-based FAQ knowledge base for simple questions
- Responsive two-panel interface and quick-reply buttons

## Run in VS Code

Open this folder in VS Code, then open **Terminal → New Terminal** and run:

### macOS / Linux

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
streamlit run app.py
```

### Windows PowerShell

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
streamlit run app.py
```

Streamlit will print a local address, normally `http://localhost:8501`. Open it in your browser.

## Try the demo

- Say `hi` and use the quick-reply menu.
- Ask `Where is my order SHP-24004?`
- Enter `ACID-908345` in the quick tracking lookup.
- Ask `What documents do I need?`
- Start a new booking and upload any safe sample PDF or image.

## Replace the demo data

- Edit `data/clients.csv` to replace the fictional shipment records.
- Edit `data/qna.csv` to add or change FAQ answers and their pipe-separated keywords.
- Replace `FORM_URL` near the top of `app.py` with your real booking-form URL.

This is a local prototype. Uploaded files are held only in the current Streamlit session and are not permanently saved. For production, add authentication, encrypted persistent storage, API/database access, audit logging, and a real employee handoff channel.
