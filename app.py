"""ABC Global Forwarding — Streamlit customer service chatbot demo."""

from __future__ import annotations

import html
import re
from datetime import datetime
from pathlib import Path

import pandas as pd
import streamlit as st

from chatbot_logic import (
    EGYPT_PORTS,
    HELP_OPTIONS,
    MAIN_MENU,
    ORIGIN_REGIONS,
    BotReply,
    extract_reference,
    faq_reply,
    find_client,
    intent_from_text,
    is_greeting,
    load_clients,
    load_faqs,
    shipment_status_reply,
    welcome_reply,
)


APP_DIR = Path(__file__).resolve().parent
CLIENTS_PATH = APP_DIR / "data" / "clients.csv"
FAQS_PATH = APP_DIR / "data" / "qna.csv"
FORM_URL = "https://example.com/abc-global-forwarding/booking-form"

st.set_page_config(
    page_title="ABC Global Forwarding Inbox",
    page_icon="🚢",
    layout="wide",
    initial_sidebar_state="collapsed",
)


@st.cache_data
def get_clients() -> list[dict[str, str]]:
    return load_clients(CLIENTS_PATH)


@st.cache_data
def get_faqs() -> list[dict[str, str]]:
    return load_faqs(FAQS_PATH)


CLIENTS = get_clients()
FAQS = get_faqs()


def init_state() -> None:
    if "messages" not in st.session_state:
        st.session_state.messages = [
            {
                "role": "assistant",
                "text": (
                    "Hello! Welcome to **ABC Global Forwarding**. "
                    "How can I help you today?"
                ),
            }
        ]
    st.session_state.setdefault("flow", "menu")
    st.session_state.setdefault("booking", {})
    st.session_state.setdefault("last_client", None)


def add_message(role: str, text: str) -> None:
    st.session_state.messages.append({"role": role, "text": text})


def reply(bot_reply: BotReply | str) -> None:
    add_message("assistant", bot_reply.text if isinstance(bot_reply, BotReply) else bot_reply)


def route_to_main_menu() -> None:
    st.session_state.flow = "menu"
    reply(welcome_reply())


def track_reference(reference: str) -> None:
    client = find_client(reference, CLIENTS)
    if client:
        st.session_state.last_client = client
        reply(shipment_status_reply(client))
        st.session_state.flow = "menu"
    else:
        reply(
            "I couldn't find that reference in the demo database. Please check it and try "
            "again. You can test **SHP-24001** or **ACID-908344**."
        )
        st.session_state.flow = "tracking_waiting"


def start_tracking(reference: str | None = None) -> None:
    if reference:
        track_reference(reference)
    else:
        st.session_state.flow = "tracking_waiting"
        reply(
            "Please type your **shipment number** or **ACID number**.\n\n"
            "Example: SHP-24001 or ACID-908341"
        )


def start_booking() -> None:
    st.session_state.booking = {}
    st.session_state.flow = "booking_region"
    reply(
        BotReply(
            "Great — let's create a new freight booking. Which origin region are you shipping from?",
            tuple(ORIGIN_REGIONS),
        )
    )


def start_help() -> None:
    st.session_state.flow = "help_menu"
    reply(BotReply("What do you need help with?", tuple(HELP_OPTIONS.keys())))


def handle_message(text: str) -> None:
    text = text.strip()
    if not text:
        return
    add_message("user", text)

    # Tracking phrases and references work from any point in the conversation.
    reference = extract_reference(text)
    intent = intent_from_text(text)
    if reference and (intent == "tracking" or st.session_state.flow in {"menu", "tracking_waiting"}):
        track_reference(reference)
        return
    if intent == "tracking" and st.session_state.flow not in {"booking_from_port", "booking_documents"}:
        start_tracking(reference)
        return

    flow = st.session_state.flow

    if flow == "tracking_waiting":
        reference = extract_reference(text)
        if reference:
            track_reference(reference)
        else:
            reply("That doesn't look like a shipment or ACID number. Try a format such as **SHP-24001** or **ACID-908341**.")
        return

    if flow == "booking_region":
        selected = next((region for region in ORIGIN_REGIONS if region.lower() == text.lower()), None)
        if not selected:
            aliases = {"eu": "European Union", "uk": "United Kingdom", "usa": "United States", "us": "United States"}
            selected = aliases.get(text.lower())
        if selected:
            st.session_state.booking["origin_region"] = selected
            st.session_state.flow = "booking_from_port"
            reply(f"Thanks. Which **departure port** in the {selected} will the freight leave from?")
        else:
            reply(BotReply("ABC currently accepts origins in the EU, UK, or USA. Please choose one:", tuple(ORIGIN_REGIONS)))
        return

    if flow == "booking_from_port":
        st.session_state.booking["from_port"] = text
        st.session_state.flow = "booking_to_port"
        reply(BotReply("Which Egyptian destination port should receive the freight?", tuple(EGYPT_PORTS)))
        return

    if flow == "booking_to_port":
        selected = next((port for port in EGYPT_PORTS if port.lower() == text.lower()), None)
        if selected:
            st.session_state.booking["to_port"] = selected
            st.session_state.flow = "booking_documents"
            reply(
                "Route saved. Please upload the available booking documents below: **MRN, ACID, "
                "commercial invoice, packing list, and vehicle documents**."
            )
        else:
            reply(BotReply("Please choose one of ABC's supported destination ports:", tuple(EGYPT_PORTS)))
        return

    if flow == "help_menu":
        issue = next((item for item in HELP_OPTIONS if item.lower() == text.lower()), None)
        if issue:
            department = HELP_OPTIONS[issue]
            ticket = f"ABC-{1000 + len(st.session_state.messages) * 7}"
            reply(
                f"I've logged **{issue.lower()}** as ticket **{ticket}** and routed it to "
                f"**{department}**. In a live system, an employee from that team would join this chat."
            )
            st.session_state.flow = "menu"
        else:
            reply(BotReply("Please select the closest issue:", tuple(HELP_OPTIONS.keys())))
        return

    lowered = text.lower()
    if lowered in {item.lower() for item in MAIN_MENU}:
        if lowered == "new booking":
            start_booking()
        elif lowered == "order tracking":
            start_tracking()
        else:
            start_help()
        return

    if is_greeting(text):
        route_to_main_menu()
        return
    if intent == "booking":
        start_booking()
        return
    if intent == "help":
        start_help()
        return

    answer = faq_reply(text, FAQS)
    if answer:
        reply(answer + "\n\nWould you like a new booking, order tracking, or help?")
        st.session_state.flow = "menu"
    else:
        reply(BotReply("I can help with bookings, tracking, and support. Choose an option below:", tuple(MAIN_MENU)))
        st.session_state.flow = "menu"


def format_message(text: str) -> str:
    safe = html.escape(text)
    safe = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", safe)
    return safe.replace("\n", "<br>")


def render_messages() -> None:
    message_html: list[str] = []
    for message in st.session_state.messages:
        role = message["role"]
        label = "You" if role == "user" else "ABC Assistant"
        timestamp = datetime.now().strftime("%H:%M")
        message_html.append(
            f'<div class="message-row {role}">'
            '<div class="message-bubble">'
            f'<div class="message-text">{format_message(message["text"])}</div>'
            f'<div class="message-meta">{html.escape(label)} · {timestamp}</div>'
            "</div>"
            "</div>"
        )
    # Use Streamlit's HTML renderer directly. Markdown treats indented HTML as a
    # code block, which would expose the tags instead of drawing chat bubbles.
    st.html(
        '<div class="chat-canvas">' + "".join(message_html) + "</div>",
    )


def current_options() -> list[str]:
    flow = st.session_state.flow
    if flow == "menu":
        return MAIN_MENU
    if flow == "booking_region":
        return ORIGIN_REGIONS
    if flow == "booking_to_port":
        return EGYPT_PORTS
    if flow == "help_menu":
        return list(HELP_OPTIONS.keys())
    return []


def render_option_buttons() -> None:
    options = current_options()
    if not options:
        return
    st.markdown('<div class="quick-label">Quick replies</div>', unsafe_allow_html=True)
    columns = st.columns(2 if len(options) > 3 else len(options))
    for index, option in enumerate(options):
        if columns[index % len(columns)].button(option, key=f"quick_{st.session_state.flow}_{index}", width="stretch"):
            handle_message(option)
            st.rerun()


def reset_chat() -> None:
    for key in ("messages", "flow", "booking", "last_client", "booking_uploads"):
        st.session_state.pop(key, None)
    init_state()


init_state()

st.markdown(
    """
    <style>
    :root {
      --abc-green: #075e54;
      --abc-green-2: #128c7e;
      --abc-mint: #dcf8c6;
      --abc-paper: #efeae2;
      --abc-ink: #182229;
      --abc-muted: #647178;
      --abc-line: #d9e0dc;
    }
    .stApp {
      background: linear-gradient(135deg, #064d47 0%, #0a7467 48%, #083e3b 100%);
      color: var(--abc-ink);
    }
    [data-testid="stHeader"], [data-testid="stSidebar"] { display: none; }
    .block-container { max-width: 1320px; padding: 2rem 2rem 3rem; }
    h1, h2, h3, p { font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .brand-kicker { color: #d6fff6; font-size: .78rem; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
    .page-title { color: #fff; font-size: clamp(1.8rem, 4vw, 3.2rem); font-weight: 760; letter-spacing: -.035em; line-height: 1.03; margin: .35rem 0 .5rem; }
    .page-subtitle { color: #c8e6e1; font-size: 1rem; margin: 0 0 1.35rem; }
    [data-testid="stVerticalBlockBorderWrapper"] {
      background: rgba(255,255,255,.98);
      border: 1px solid rgba(255,255,255,.28) !important;
      border-radius: 24px;
      box-shadow: 0 22px 60px rgba(0, 28, 26, .28);
      overflow: hidden;
    }
    .chat-header {
      display: flex; align-items: center; gap: .8rem;
      background: var(--abc-green); color: white;
      margin: -1rem -1rem .75rem; padding: 1rem 1.15rem;
    }
    .avatar {
      width: 44px; height: 44px; flex: 0 0 44px; border-radius: 50%;
      display: grid; place-items: center; background: #fff; color: var(--abc-green);
      font-weight: 850; letter-spacing: -.04em; border: 2px solid rgba(255,255,255,.6);
    }
    .chat-title { font-weight: 750; font-size: 1.02rem; line-height: 1.2; }
    .chat-subtitle { opacity: .78; font-size: .78rem; margin-top: .15rem; }
    .verified {
      display: inline-grid; place-items: center; width: 18px; height: 18px;
      border-radius: 50%; margin-left: .3rem; background: #1da1f2; color: white;
      font-size: 12px; font-weight: 900; vertical-align: 1px;
    }
    .header-icons { margin-left: auto; font-size: 1.15rem; letter-spacing: .3rem; opacity: .92; white-space: nowrap; }
    .secure-notice {
      background: #d9fdd3; border-radius: 9px; color: #49605b; font-size: .78rem;
      text-align: center; margin: .35rem auto 1rem; padding: .55rem .75rem; max-width: 78%;
    }
    .chat-canvas {
      min-height: 520px; max-height: 590px; overflow-y: auto; padding: .25rem .45rem 1rem;
      background-color: var(--abc-paper);
      background-image:
        radial-gradient(circle at 20px 20px, rgba(7,94,84,.045) 2px, transparent 2px),
        radial-gradient(circle at 50px 45px, rgba(7,94,84,.035) 1px, transparent 1px);
      background-size: 70px 70px, 64px 64px;
      border-radius: 12px;
    }
    .message-row { display: flex; margin: .58rem .4rem; }
    .message-row.user { justify-content: flex-end; }
    .message-bubble {
      max-width: 84%; border-radius: 8px; padding: .65rem .75rem .38rem;
      background: #fff; box-shadow: 0 1px 1px rgba(0,0,0,.1); position: relative;
    }
    .message-row.user .message-bubble { background: var(--abc-mint); }
    .message-text { font-size: .91rem; line-height: 1.48; }
    .message-meta { color: #7b8783; font-size: .62rem; margin-top: .25rem; text-align: right; }
    .quick-label { color: #6d7975; font-size: .7rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; margin: .5rem 0 .35rem; }
    .stButton > button, .stLinkButton > a {
      border-radius: 999px !important; border: 1px solid #b8d7cf !important;
      background: #f4fbf9 !important; color: var(--abc-green) !important; font-weight: 700 !important;
    }
    .stButton > button:hover, .stLinkButton > a:hover { border-color: var(--abc-green-2) !important; background: #e5f5f0 !important; }
    [data-testid="stChatInput"] { border-radius: 999px; background: white; }
    .panel-title { color: #0d5149; font-size: 1rem; font-weight: 800; margin: .25rem 0 .2rem; }
    .panel-copy { color: #67736f; font-size: .85rem; line-height: 1.5; margin-bottom: .8rem; }
    .status-card { background: #f2f8f6; border: 1px solid #d8e8e3; border-radius: 15px; padding: .9rem; margin: .5rem 0 .9rem; }
    .status-label { color: #6a7773; font-size: .65rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .status-value { color: #123d37; font-weight: 750; margin-top: .18rem; }
    .route-pill { display: inline-block; padding: .28rem .55rem; margin: .18rem .15rem .18rem 0; border-radius: 999px; background: #e7f3ef; color: #176a5e; font-size: .72rem; }
    hr { border-color: #e7ecea !important; }
    [data-testid="stDataFrame"] { border-radius: 12px; overflow: hidden; }
    @media (max-width: 800px) {
      .block-container { padding: 1.15rem .8rem 2rem; }
      .page-title { font-size: 2rem; }
      .chat-canvas { min-height: 440px; max-height: 520px; }
      .header-icons { display: none; }
      .message-bubble { max-width: 92%; }
    }
    </style>
    """,
    unsafe_allow_html=True,
)

st.markdown('<div class="brand-kicker">Customer service demo</div>', unsafe_allow_html=True)
st.markdown('<div class="page-title">Freight support, without the waiting.</div>', unsafe_allow_html=True)
st.markdown(
    '<div class="page-subtitle">Book freight to Egypt, track an active shipment, or reach the right department.</div>',
    unsafe_allow_html=True,
)

chat_col, info_col = st.columns([1.65, 0.85], gap="large")

with chat_col:
    with st.container(border=True):
        st.markdown(
            """
            <div class="chat-header">
              <div class="avatar">ABC</div>
              <div>
                <div class="chat-title">ABC Global Forwarding <span class="verified" title="Verified business">✓</span></div>
                <div class="chat-subtitle">Business account · typically replies instantly</div>
              </div>
              <div class="header-icons">⌕ ⋮</div>
            </div>
            <div class="secure-notice">🔒 Messages in this demo stay in your browser session.</div>
            """,
            unsafe_allow_html=True,
        )

        render_messages()

        render_option_buttons()

        if st.session_state.flow == "booking_documents":
            uploads = st.file_uploader(
                "Upload MRN, ACID, invoice, packing list, or vehicle documents",
                type=["pdf", "png", "jpg", "jpeg", "doc", "docx", "xls", "xlsx"],
                accept_multiple_files=True,
                key="booking_uploads",
            )
            if uploads and st.button("Continue with uploaded documents", type="primary", width="stretch"):
                names = ", ".join(file.name for file in uploads)
                add_message("user", f"Uploaded: {names}")
                st.session_state.booking["documents"] = [file.name for file in uploads]
                st.session_state.flow = "booking_form"
                booking = st.session_state.booking
                reply(
                    f"Documents received for **{booking['from_port']} → {booking['to_port']}**. "
                    "Please complete the booking form using the link below."
                )
                st.rerun()

        if st.session_state.flow == "booking_form":
            st.link_button("Open sample booking form ↗", FORM_URL, width="stretch")
            if st.button("Start another request", width="stretch"):
                add_message("user", "Start another request")
                route_to_main_menu()
                st.rerun()

        prompt = st.chat_input("Type a message or shipment number…")
        if prompt:
            handle_message(prompt)
            st.rerun()

with info_col:
    with st.container(border=True):
        st.markdown('<div class="panel-title">Inbox</div>', unsafe_allow_html=True)
        st.markdown(
            '<div class="panel-copy">ABC Global Forwarding<br><span style="color:#0b7b6d;font-weight:700">● Online</span></div>',
            unsafe_allow_html=True,
        )
        if st.button("↻ Reset conversation", width="stretch"):
            reset_chat()
            st.rerun()

        st.divider()
        st.markdown('<div class="panel-title">Quick tracking lookup</div>', unsafe_allow_html=True)
        st.markdown('<div class="panel-copy">Try SHP-24001 or ACID-908344.</div>', unsafe_allow_html=True)
        lookup = st.text_input("Shipment or ACID number", key="side_lookup", placeholder="SHP-24001")
        if st.button("Find shipment", type="primary", width="stretch"):
            reference = extract_reference(lookup)
            if not reference:
                st.warning("Enter a valid shipment or ACID number.")
            else:
                client = find_client(reference, CLIENTS)
                if client:
                    st.session_state.last_client = client
                else:
                    st.error("Reference not found in the demo database.")

        if st.session_state.last_client:
            client = st.session_state.last_client
            st.markdown(
                f"""
                <div class="status-card">
                  <div class="status-label">Latest shipment</div>
                  <div class="status-value">{html.escape(client['shipment_id'])}</div>
                  <div style="font-size:.82rem;color:#596762;margin-top:.45rem">{html.escape(client['shipment_status'])}</div>
                  <div style="font-size:.74rem;color:#74817d;margin-top:.5rem">{html.escape(client['from_port'])} → {html.escape(client['to_port'])}</div>
                </div>
                """,
                unsafe_allow_html=True,
            )

        st.divider()
        st.markdown('<div class="panel-title">Egypt destinations</div>', unsafe_allow_html=True)
        st.markdown(
            "".join(f'<span class="route-pill">{html.escape(port)}</span>' for port in EGYPT_PORTS),
            unsafe_allow_html=True,
        )

        with st.expander("View sample client database"):
            st.dataframe(pd.read_csv(CLIENTS_PATH), hide_index=True, width="stretch")

st.caption("Prototype only · All client names, references, routes, and statuses are fictional sample data.")
