"""Conversation and lookup logic for the ABC Global Forwarding demo chatbot."""

from __future__ import annotations

import csv
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


EGYPT_PORTS = [
    "Alexandria Port (including El Dekheila)",
    "Port Said",
    "Damietta Port",
    "Ain Sokhna Port",
    "Suez Port",
]

ORIGIN_REGIONS = ["European Union", "United Kingdom", "United States"]

MAIN_MENU = ["New booking", "Order tracking", "Help"]

HELP_OPTIONS = {
    "Problem with booking": "Booking Operations",
    "Problem with payment": "Accounts & Payments",
    "I cannot find my shipment": "Tracking Desk",
    "Documents or customs question": "Customs Documentation",
    "Something else": "Customer Care",
}


@dataclass(frozen=True)
class BotReply:
    text: str
    options: tuple[str, ...] = ()


def load_clients(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def load_faqs(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def extract_reference(text: str) -> str | None:
    """Extract a shipment or ACID reference from conversational text."""
    patterns = (
        r"\bSHP[-\s]?\d{4,}\b",
        r"\bACID[-\s]?\d{5,}\b",
    )
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            value = match.group(0).upper().replace(" ", "-")
            if value.startswith("SHP") and not value.startswith("SHP-"):
                value = value.replace("SHP", "SHP-", 1)
            if value.startswith("ACID") and not value.startswith("ACID-"):
                value = value.replace("ACID", "ACID-", 1)
            return value
    return None


def find_client(reference: str, clients: Iterable[dict[str, str]]) -> dict[str, str] | None:
    target = normalize(reference)
    for client in clients:
        if target in {normalize(client["shipment_id"]), normalize(client["acid_id"])}:
            return client
    return None


def shipment_status_reply(client: dict[str, str]) -> str:
    full_name = f"{client['Name']} {client['last_name']}"
    delivery = (
        "Delivery is complete."
        if client["delivery_status"].lower() == "complete"
        else "Delivery is not complete yet."
    )
    return (
        f"I found the shipment for **{full_name}**.\n\n"
        f"**Shipment:** {client['shipment_id']}  \n"
        f"**ACID:** {client['acid_id']}  \n"
        f"**Route:** {client['from_port']} → {client['to_port']}  \n"
        f"**Current status:** {client['shipment_status']}  \n"
        f"**MRN:** {client['MRN_status']}  \n"
        f"**Payment:** {client['payment_status']}  \n"
        f"**Delivery:** {client['delivery_status']}\n\n"
        f"{delivery}"
    )


def faq_reply(text: str, faqs: Iterable[dict[str, str]]) -> str | None:
    words = set(re.findall(r"[a-z0-9]+", text.lower()))
    best_score = 0
    best_answer: str | None = None
    for faq in faqs:
        keywords = {item.strip().lower() for item in faq["keywords"].split("|")}
        score = len(words & keywords)
        if score > best_score:
            best_score = score
            best_answer = faq["answer"]
    return best_answer if best_score > 0 else None


def is_greeting(text: str) -> bool:
    return normalize(text) in {"hi", "hello", "hey", "goodmorning", "goodafternoon"}


def intent_from_text(text: str) -> str | None:
    cleaned = text.lower()
    if any(phrase in cleaned for phrase in ("where is my order", "where is my shipment", "track", "tracking")):
        return "tracking"
    if any(phrase in cleaned for phrase in ("new booking", "book shipment", "make a booking")):
        return "booking"
    if any(phrase in cleaned for phrase in ("help", "support", "problem", "human", "employee")):
        return "help"
    return None


def welcome_reply() -> BotReply:
    return BotReply(
        "Hello! Welcome to **ABC Global Forwarding**. How can I help you today?",
        tuple(MAIN_MENU),
    )

