# Prompt: make the MKY operations desk easy to understand

Copy the prompt below into your coding/design agent with access to this repository.

Review basis: the live URL `https://mkyglobalforwarding.vercel.app/desk/` was inspected on 9 October 2026 and showed the sign-in page. Authenticated screens were reviewed through the local source, not through a logged-in production session. The live sign-in title differs from the local source, so verify the deployed revision before claiming they are identical.

---

You are a senior product designer and frontend engineer redesigning the existing MKY Global Forwarding operations desk. Implement the redesign in this repository. This desk helps a small forwarding team manage customers using a WhatsApp and Telegram booking bot: review shipment requests, check vehicle documents, handle requests for a person, process MRN applications, reply to customers, and update confirmed shipments.

The goal is a simple, understandable working tool. A new colleague should be able to open a screen and answer: What is this? What needs my attention? Who is responsible? What should I do next? Will this action message the customer?

## 1. Understand the existing product before designing

Inspect these files and follow their imports to the relevant handlers:

- Shell, navigation and shared components: `web/public/desk/index.html`, `app.js`, `ui.js`, `desk.css`, `live.js`.
- Work queue and cases: `inbox.js`, `case.js`, `workflow.js`.
- Conversations and customer message previews: `chats.js`, `conversation.js`, `preview.js`.
- Documents and media: `viewer.js`.
- Tracking, search and configuration: `shipments.js`, `search.js`, `settings.js`.
- API: `web/api/admin/ops.js` and the modules under `web/lib/admin/`, especially `desk-inbox.js`, `desk-case.js`, `desk-chat.js`, `desk-files.js`, `desk-shipments.js`, `desk-settings.js`, `desk-search.js`, and `desk-shared.js`.
- Actual booking rules: `web/lib/ops/workflow.js`. Check these against the frontend workflow module; the server determines valid actions, readiness, permissions and transitions.
- Existing design decisions: `web/docs/DESK-DESIGN-SYSTEM.md`, `DESK-UX-AUDIT.md`, and `WHATSAPP-AND-DESK.md`. Some improvements are already implemented. Inspect the current code before treating historical audit findings as current defects.

The frontend uses plain JavaScript ES modules and CSS with no framework or build step. Improve that implementation and reuse the existing APIs. Keep working functionality, booking rules, server permissions, audit history, version conflict checks, retry protection, and efficient background refresh. Do not introduce a framework migration as part of this redesign.

Make a short inventory of existing screens and actions, and distinguish observed problems from proposed improvements. If the live page is behind sign-in, report that limitation and use a local test setup for visual review. Do not change production data to inspect the interface.

## 2. Design for the people and their mindset

Use these perspectives throughout every section:

- **New operations agent:** “I don't know the terminology yet. Show me what to check and what happens when I click.” Needs understandable labels, short explanations, visible blockers and guided decisions.
- **Experienced operations agent:** “I have several customers waiting. Help me find and finish the next task quickly.” Needs a scannable queue, ownership, fewer unnecessary clicks and stable drafts.
- **Supervisor:** “What is overdue, unassigned or stuck, and who can handle it?” Needs team ownership, priority, exceptions and the existing reassignment controls.
- **Administrator:** “What changes the bot's behavior, and when does it take effect?” Needs clearly grouped settings, examples, validation and saved-change feedback.
- **Read-only colleague or manager:** “What is happening, and why is this delayed?” Needs accessible history and explanations of restrictions, without misleading editable controls.
- **Customer, indirectly:** “Did they understand my request? What do I need to send? Did my message reach anyone?” Make customer-facing previews, language, requested information and actual delivery outcomes clear to staff.

These are design perspectives; only Agent, Supervisor, Administrator and Read only are existing permission roles. Do not invent extra access roles. Consider common mistakes: two staff acting on the same case, confusing receipt with document verification, assuming an update was delivered because it was saved, or believing a chat is automatically paused when an agent replies.

## 3. Navigation and overall hierarchy

Keep four main destinations: **Inbox, Chats, Shipments, Settings**. Give each a short purpose statement:

- Inbox: “Requests and issues that need your team.”
- Chats: “Read customer messages and reply.”
- Shipments: “Track confirmed shipments and update customers.”
- Settings: “Manage the team and how the bot works.”

Explain the distinction between Inbox and Chats through these descriptions and contextual links. Bookings, call-backs and MRN applications remain case types within the queue; avoid multiplying top-level pages for each database table. Keep search available across the desk. Add a separate overview only if it solves a demonstrated need that the Inbox cannot meet.

Use a calm, readable layout with company branding, consistent spacing, clear text labels and restrained status colors. Keep labels visible at common laptop sizes where practical. Do not make essential guidance depend on hover. Prioritize useful operational information over decorative charts or counters.

## 4. Inbox: “What should I work on now?”

Preserve the existing work-state tabs and type/ownership filters, but make their differences obvious. Use labels such as **Needs attention**, **Waiting for customer**, and **Completed today**. Keep **Assigned to me** as an ownership shortcut, separate from filters for Bookings, Call-back requests, MRN applications and Issues. Do not invent new filter behavior that the API does not support without implementing it.

Each row should reveal the task, customer, relevant reference, status, owner and waiting time in a consistent order. For example: “Review invoice — Ahmed Hassan — New booking — Unassigned — Waiting 35 min.” Keep urgency and sort order consistent with server rules. Explain when work is waiting on a customer rather than suggesting the team is late.

Change “Take it” to **Assign to me**. Use explicit issue actions such as **Retry sending** and **Dismiss issue**. Explain dismissal: it removes the alert but does not fix delivery or delete the underlying file. Only offer retries where they can work. Keep the full reason available when a row's detail is shortened.

## 5. Booking case: “Can this booking move forward?”

Lead with customer and vehicle identity, booking reference, route, owner and current state. Put a single **Next action** card above the working details. State the reason, the blocker if any, and one primary action derived from the server response.

Organize the case around:

1. Next action and what is blocking progress.
2. Required documents and verification progress.
3. Customer, vehicle and route details.
4. MRN information when relevant.
5. Internal notes and activity history.

Keep the conversation alongside the work on desktop. On phones provide a clear **Booking / Conversation** switch. Preserve access to linked shipment updates after confirmation. Show the customer's latest answer next to the original request for information.

Explain **Chassis / VIN** as “The vehicle's unique identification number.” Explain the MRN, ACID, EUR.1 and CMR document terms with short, accurate descriptions validated against the repository's domain documentation; do not add legal requirements from assumption. Distinguish the customer's submitted request reference from any shipping booking reference entered by staff.

Use explicit buttons such as **Review documents**, **Request missing information**, **Record shipping reference**, and **Confirm booking**. A disabled primary action should say what would enable it. Keep rejection, cancellation and supervisor overrides accessible but subordinate. Do not present a simplified progress indicator that contradicts conditional server rules.

## 6. Document review: “Can I trust this file?”

Show the original PDF/image and extracted information together. Make the filename, document type, received time, required status and review state clear. Compare important extracted values against the booking and identify specific differences: “The chassis number on this invoice differs from the booking.”

Use **Mark as verified**, **Request replacement**, and the existing correction/re-reading actions where available. Never imply that a received file or successful extraction is already verified. Show unreadable files and uncertain values honestly. Explain missing documents and files not linked to a booking. Separate customer documents from files sent by MKY.

Keep decisions visible while reading. Preserve the existing mismatch safeguards and permitted override paths. Preview any replacement request in the customer's language before sending it.

## 7. Chats: “What did the customer say, and can I reply?”

Use a familiar conversation list and message panel. Show customer identity, channel, language, last message and unread indication, with links to related bookings and requests. Current unread indicators are stored per browser; do not label them as a shared team read/response status unless that capability is implemented.

Clearly distinguish customer messages, bot replies, staff replies, automated notifications, internal notes, and delivery states. Internal notes must visibly say **Internal — customer cannot see this**. Keep saved replies editable before sending. Preserve file attachments, captions, previews, progress and partial-failure recovery.

Explain the actual send restriction beside the composer: normal reply available, approved template required, customer opted out, disconnected channel, blocked customer, or missing reply destination. Derive this from server composer state rather than hardcoding eligibility. For a closed WhatsApp window use wording such as: “Send the approved reply-request template. You can type a normal reply after the customer responds.”

Display the existing bot conversation state in understandable words. Do not add working-looking Pause bot, Resume bot or Take over controls unless corresponding backend behavior exists or is explicitly implemented and verified.

## 8. Call-back requests and MRN applications

For call-backs, make customer contact, request topic, urgency, office-hours context, owner and the latest response obvious. Explain requests where the customer has not described the issue yet. Use existing assignment, in-progress, waiting, resolve and close actions with clear consequences. Distinguish an internal resolution note from text sent to the customer.

For MRN applications, show supplied information, related booking, missing information and the next review step. Explain that approval and recording an issued MRN are different steps. Recording a number must not imply this dashboard itself obtained it from a customs authority. Preserve the actual workflow and message effects.

## 9. Shipments: “Where is the vehicle, and what changed?”

Make active versus delivered shipments easy to scan. Include customer, reference, vehicle/VIN, route, vessel, current status and estimated arrival where supported. Format dates clearly, including relative time and meaningful late indicators. Keep estimate and actual status distinct.

On the detail screen, separate current shipment information, update form and history. Make **Notify customer** explicit, with a preview and clear channel/language. After saving distinguish **Update saved** from **Update saved; notification failed or is waiting**. A message accepted for sending is not proof it was delivered or read.

## 10. Search, Settings and sign-in

Search must support existing name, phone, chassis/VIN and reference queries. Group results by type, show recognizable identities and statuses, and open the relevant detail. Preserve query and filter context when navigating back. Explain partial VIN searching and no-results states.

Group Settings into **Team and access**, **Office hours and contact numbers**, **Required documents**, **WhatsApp messaging**, and **Saved replies**. For each setting explain what staff/customers experience, provide an example when useful, and show validation, save state and who last changed it. Use existing per-section saves. Protect unsaved edits during navigation.

Keep technical template names as administrator configuration; explain their purpose and do not imply the dashboard approves templates or changes WhatsApp's platform limits. Clearly distinguish document requirements when customers supply their own MRN versus when MKY handles it. Show role capabilities plainly and preserve server enforcement.

Make sign-in instructions and errors understandable. Preserve the existing authentication flow within this redesign. Keep sign-out accessible on every screen size.

## 11. Interaction, language and reliability

Use short contextual explanations rather than long instructional paragraphs. Label actions by the result, such as **Save note**, **Send request to customer**, or **Save update and notify customer**. Preview customer messages using the existing server preview endpoint, including language and whether delivery is direct, templated, waiting or unavailable.

Preserve English desk navigation and proper Arabic message rendering, including mixed-direction names, filenames, VINs and references. Use keyboard access, visible focus, accessible dialogs, readable contrast and text/icon status cues. Verify at 1280 and 1440 px, at 125% display scaling, and around 390 px mobile width.

Keep typed text, uploads, scroll position and focused inputs stable during refresh. Explain stale-record conflicts and partial data failures. An unavailable API is not an empty queue. Show meaningful loading, empty, error, offline, reconnecting, read-only and successful-action states. Avoid duplicate submissions and misleading delivery confirmations.

## 12. Deliver and verify

First present a concise current-state assessment, proposed navigation and section-by-section changes. Then implement the redesign in the existing frontend, with backend changes only where necessary and explicitly documented. Update the design documentation to reflect the final implementation.

Validate representative end-to-end tasks in a local/test environment: find and claim a booking; verify a matching document; handle a wrong VIN or unreadable file; request missing information and see the waiting state; complete the required MRN/reference steps and confirm; handle a call-back; reply normally; encounter closed-window and opted-out chats; recover from attachment failure; update a shipment with and without notification; search and return to the queue; and save an authorized setting. Also inspect supervisor, agent and read-only restrictions and a concurrent-edit conflict.

Reuse existing desk tests and fixtures. Run checks appropriate to changed behavior and visually inspect representative screens on desktop and mobile. Report what was actually verified, remaining limitations, and any unsupported capabilities discovered. Deliver working code and screenshots, with a short explanation of how the redesign improves the decisions people make. Prepare the result for review; production deployment is outside this prompt.

Acceptance criterion: a new agent can identify the next task, understand the blocker, take the permitted action and tell whether the customer was notified without guessing or needing a separate manual for every screen.
