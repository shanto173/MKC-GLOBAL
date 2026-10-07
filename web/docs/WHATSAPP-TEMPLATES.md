# WhatsApp message templates — to create in WhatsApp Manager

WhatsApp lets a business send free text only within 24 hours of the customer's
last message. Outside that window the bot (and the desk) can only send a
**template that Meta has approved**. These are the templates the outbox uses;
the names must match `bot_settings.whatsapp_templates` exactly.

Create each one twice — language **English** (`en`) and **Arabic** (`ar`) — with
the same name. Category: **Utility**. Approval usually takes minutes, sometimes
up to 48 hours, so submit them first.

Where: business.facebook.com → WhatsApp Manager → Account tools → Message
templates → Create template → Utility → Custom.

Rules Meta enforces (a template breaking one is rejected):
- variables are `{{1}}`, `{{2}}`… in order, and each needs a sample value;
- the body may not start or end with a variable, and may not be mostly variables;
- no links shorteners, no promotional wording in Utility templates.

Add one **Quick reply** button to every template: English `Reply`, Arabic `رد`.
A tap counts as the customer writing, which reopens the 24-hour window so the
conversation can continue normally.

---

## mky_booking_confirmed
Booking confirmed by Operations (customer outside the window).

| | |
|---|---|
| EN | Your booking {{1}} is confirmed. Shipment {{2}} has been opened for it. Reply to this message for the details and your confirmation document. |
| AR | تم تأكيد حجزك رقم {{1}}. اتفتحت الشحنة رقم {{2}} عليه. رد على الرسالة دي عشان نبعتلك التفاصيل ومستند التأكيد. |
| Samples | {{1}} `MKY-BKG-261007-A1B2` · {{2}} `MKY-26001` |

## mky_booking_confirmed_doc
Same event, with the confirmation PDF attached. **Header: Document** (upload any sample PDF when creating).

| | |
|---|---|
| EN | Your booking {{1}} is confirmed. The confirmation document is attached. Keep it and quote the reference in any correspondence. |
| AR | تم تأكيد حجزك رقم {{1}}. مستند التأكيد مرفق. احتفظ بيه واذكر رقم الحجز في أي مراسلات. |
| Samples | {{1}} `MKY-BKG-261007-A1B2` |

## mky_booking_rejected
| | |
|---|---|
| EN | We could not confirm your booking request {{1}}. Reason: {{2}}. Reply to this message and our team will go through it with you. |
| AR | للأسف ما قدرناش نأكد طلب الحجز رقم {{1}}. السبب: {{2}}. رد على الرسالة دي وفريقنا هيراجعه معاك. |
| Samples | {{1}} `MKY-BKG-261007-A1B2` · {{2}} `the chassis number on the invoice does not match` |

## mky_information_needed
| | |
|---|---|
| EN | To continue your booking {{1}} we need: {{2}}. Please reply to this message with it. |
| AR | عشان نكمل حجزك رقم {{1}} محتاجين: {{2}}. من فضلك رد على الرسالة دي وابعته. |
| Samples | {{1}} `MKY-BKG-261007-A1B2` · {{2}} `a clearer copy of the MRN` |

## mky_document_needed
| | |
|---|---|
| EN | For your booking {{1}} we need a new copy of a document: {{2}}. Please reply to this message and send it. |
| AR | محتاجين نسخة جديدة من مستند لحجزك رقم {{1}}: {{2}}. من فضلك رد على الرسالة دي وابعته. |
| Samples | {{1}} `MKY-BKG-261007-A1B2` · {{2}} `the invoice is not readable` |

## mky_shipment_update
| | |
|---|---|
| EN | Update on your shipment {{1}}: {{2}}. Reply to this message if you have any questions. |
| AR | تحديث على شحنتك رقم {{1}}: {{2}}. رد على الرسالة دي لو عندك أي سؤال. |
| Samples | {{1}} `MKY-26001` · {{2}} `the vessel has arrived at Alexandria` |

## mky_message_from_team
A message from a person at the desk, sent outside the window.

| | |
|---|---|
| EN | A message from the MKY team about {{1}}: {{2}}. Reply to this message to continue. |
| AR | رسالة من فريق MKY بخصوص {{1}}: {{2}}. رد على الرسالة دي عشان نكمل. |
| Samples | {{1}} `MKY-BKG-261007-A1B2` · {{2}} `we have received your documents and are checking them` |

## mky_request_resolved
| | |
|---|---|
| EN | Your request {{1}} has been resolved. Reply to this message if you need anything else. |
| AR | طلبك رقم {{1}} اتحل. رد على الرسالة دي لو محتاج أي حاجة تانية. |
| Samples | {{1}} `MKY-TKT-261007-0042` |

## mky_please_reply
Sent from the desk when a person needs to talk to a customer whose window has closed.

| | |
|---|---|
| EN | Hello from MKY Forwarding. Our team has an update for you. Please reply to this message so we can continue. |
| AR | أهلاً من MKY Forwarding. فريقنا عنده تحديث ليك. من فضلك رد على الرسالة دي عشان نكمل. |
| Samples | (no variables) |

---

### If Meta renames or rejects one
Change the name in the desk → Settings → WhatsApp templates (it edits
`bot_settings.whatsapp_templates`). Until a template is approved, a message that
needs it waits in the desk's Problems list as "needs template" — it is never sent
as free text, because Meta would refuse it.
