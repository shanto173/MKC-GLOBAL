import unittest
from pathlib import Path

from chatbot_logic import extract_reference, faq_reply, find_client, load_clients, load_faqs


ROOT = Path(__file__).resolve().parents[1]


class ChatbotLogicTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.clients = load_clients(ROOT / "data" / "clients.csv")
        cls.faqs = load_faqs(ROOT / "data" / "qna.csv")

    def test_database_has_ten_clients(self):
        self.assertEqual(len(self.clients), 10)

    def test_extracts_shipment_reference_from_question(self):
        self.assertEqual(extract_reference("Where is my order SHP-24004?"), "SHP-24004")

    def test_extracts_acid_reference_without_dash(self):
        self.assertEqual(extract_reference("please find acid908345"), "ACID-908345")

    def test_finds_client_by_either_reference(self):
        by_shipment = find_client("SHP-24001", self.clients)
        by_acid = find_client("acid 908341", self.clients)
        self.assertEqual(by_shipment["Name"], "Amelia")
        self.assertEqual(by_acid["shipment_id"], "SHP-24001")

    def test_returns_none_for_unknown_reference(self):
        self.assertIsNone(find_client("SHP-99999", self.clients))

    def test_faq_answer_is_selected(self):
        answer = faq_reply("What documents do I need?", self.faqs)
        self.assertIn("MRN", answer)


if __name__ == "__main__":
    unittest.main()

