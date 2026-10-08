# MKY Desk: UX audit

What was wrong with the desk before the redesign, page by page, and what we changed. Each finding names the screenshot it was seen in. The fix column points to the component or pattern in [DESK-DESIGN-SYSTEM.md](DESK-DESIGN-SYSTEM.md).

**Screenshots.** The before and after sets were taken with headless Edge against a local copy of the desk: the real `public/desk` files and the real API, on an in-memory database seeded with a working day (9 customers, bookings at every stage, English and Arabic chats, a closed WhatsApp window, a customer who wrote STOP). File names are `<page>-<size>.png`:

- `w1440` is 1440×900;
- `w1280` is 1280×800 at 125% display scaling;
- `w1920` is 1920×1080;
- `phone` is 390 px wide.

Before is under `shots/before/`, after under `shots/after/`. They are kept outside the repo (in the session scratchpad, `desk-redesign/shots/`), because they are evidence for this change, not assets of the product.

## Everywhere

| # | Problem | Seen in | Fix |
|---|---|---|---|
| G1 | **No system behind the styles.** Chips, filter pills, tab counts, the owner pill, the `.pill` booking links and the `.jump` links were six different pill shapes, all slightly different in height (20–30 px), padding and weight. Buttons came in four heights (26, 28, 30, 36, 42 px). | `inbox-w1440`, `case-booking-w1440`, `settings-w1440` | One **badge** (status), one **tag** (kind and metadata), one **button** with three sizes, all built on tokens. |
| G2 | **Type was small and grey.** Secondary text was 12.5–13 px in `#5a6270`. Row metadata, times and channel words were 12–12.5 px. At 125% scaling it is readable, but at 100% on a 1920 monitor it is hard work all day. | `inbox-w1920` | A **type scale**: body 14 px, reading text (row titles, bubbles) 15 px, and nothing under 13 px except counts. Secondary text is at least 7:1 on white. |
| G3 | **Ad hoc spacing.** Gaps of 2, 3, 5, 6, 7, 9, 10, 11, 13 and 14 px sat side by side, so nothing lined up between cards. | all | A **4/8 spacing scale** (4, 8, 12, 16, 20, 24, 32, 40, 48), used through tokens only. |
| G4 | **Status was colour plus a word, but no shape.** Blue, amber and green chips differ only by hue: a person with colour-blindness, or a washed-out laptop screen, sees three grey pills. | `inbox-w1440` | The **status badge** always carries an icon by meaning: ● ours to do, clock for waiting, check for done, triangle for a problem, dash for closed. |
| G5 | **Sign out was unreachable on a phone.** The sidebar, which holds it, is hidden under 760 px, and nothing replaced it. | `inbox-phone` | The **operator menu** (avatar, name, role, Sign out) moves to the top bar, on every size. |
| G6 | **Errors read the same whatever the cause.** A permission refusal (403), a dropped connection and a server error all became the same dark red toast. | code review of `ui.js`, `case.js` | `toastError()` sorts them: offline (info, with a retry hint), not allowed (lock icon, the server's sentence), stale record (info), anything else (danger). Empty and error states get an icon and one clear action. |
| G7 | **Loading was a grey bar stack** shaped like nothing on the page, so the layout jumped when content arrived. | first paint of any page | **Skeletons shaped like the content** they stand for: list rows on the inbox and in chats, cards on the case page. |

## Inbox

| # | Problem | Seen in | Fix |
|---|---|---|---|
| I1 | **Width used badly.** At 1920 the list is capped at 1480 px. Each row is a sentence on the left and a stack of chips 900 px away on the far right. The eye has to cross the whole screen to connect "Check 3 documents" with "Urgent · Overdue · Nobody yet · 5 h". | `inbox-w1920` | A **columnar row**. Columns: what to do; customer and route; status tags; owner; age. Each column is aligned down the list, so you scan one column at a time. The list fills the content area. |
| I2 | **Urgency, age and ownership not scannable.** Age is a plain grey "5 h" whatever it means. "Nobody yet" is small amber text. Urgent, Overdue and New are three chips of the same weight as "Booking". | `inbox-w1440` | Age gets a **threshold tone**: neutral under 30 min, amber from 30 min, red from 2 h (and always red when the server says overdue). The left stripe follows the same urgency. Owner is an avatar with initials, or a **Take it** button right on the row. Each row gets one **status badge** (New request, Being checked, Not delivered…) with Urgent or High beside it, and OVERDUE is written under the age. The kind of work is an icon. |
| I3 | **The kind of work is a word, not a shape.** Bookings, call-backs, MRN applications and problems look identical until you read the chip. | `inbox-w1440` | A **kind icon** leads every row: truck, phone, stamp, triangle. |
| I4 | **Problem rows shout.** Three red titles, red chips and red stripes on top of the list make everything below look calm, even an urgent overdue booking. | `inbox-w1440` | Problem rows keep the red stripe and icon, but the title is ink, not red. Red is spent once per row. |
| I5 | **Filters and tabs are two rows that look alike.** Underline tabs and black-filled pills both read as navigation; the active filter's black fill is the heaviest thing on the page. | `inbox-w1440` | Tabs keep the underline. Filters become a **segmented filter** with counts, quiet when inactive and brand-tinted when active. A zero count is dimmed. |
| I6 | **Two-line problem detail pushes the list down.** The template sentence runs to 160 characters on one row. | `inbox-w1280` | The detail is clamped to one line on desktop (the full text is on hover and on the case page). |

## Case page (booking, call-back, MRN)

| # | Problem | Seen in | Fix |
|---|---|---|---|
| C1 | **Three cramped regions competing.** The header, the cards and the conversation all start at the same height with the same weight. At 1280 the next-step actions wrap onto two lines, and the facts line wraps under the title. | `case-booking-w1280` | A **sticky case header** across the full width: ref, status, turn, priority, owner, and the primary action once the Next step card scrolls away. Below it, two columns: work on the left, the conversation on the right, full height. Under 1360 px the sidebar becomes a rail, which gives the work column 170 px back. |
| C2 | **Actions not ranked.** "Ask the customer for something", "Reject request" and "More" are blue and red links of the same size beside the one primary button. They read as navigation, not as decisions. | `case-booking-w1440` | The **Next step card** is the anchor: exactly one primary button (large), secondary actions as outlined buttons, dangerous ones in danger style, and the rest under **More**. |
| C3 | **"Correct" repeated on every detail line.** Eight blue "Correct" links form a column of noise beside the values. | `case-booking-w1440` | A **key-value list with inline edit**. A pencil appears on the line you hover or focus (always visible on touch screens). Choosing it turns that one line into a field with Save and Cancel. Same API, one field at a time. |
| C4 | **Documents as plain rows.** The state is a coloured sentence, and Check and View look the same. The "1 of 3 checked" count is small grey text in the corner. | `case-booking-w1440` | A **checklist item**: a status icon in a tinted circle, the paper's name, the state in words, the file name, and one button. The button is a filled "Check" when the paper needs eyes and a quiet "View" when it is done. A segmented progress meter shows how many are checked. |
| C5 | **The conversation header eats the panel.** Name, channel, language, phone, WhatsApp name and bot state take 120 px before the first message. The window state is a small green line above the composer. | `case-booking-w1440`, `case-window-closed-w1440` | A compact **conversation header** (avatar, name, channel and language tags, phone). The window state is a **banner** directly above the composer: open shows "Window open · 23 h left"; closed is amber, with the template button; STOP is red. |
| C6 | **File messages in Arabic flip.** `فاتورة-7710.pdf` rendered as `pdf.7710-فاتورة`, because the bubble is right to left as a whole. | `case-booking-w1440`, `chats-arabic-w1440` | A file message is a **file chip**: icon, then the name isolated left to right, the way a file manager shows it. |
| C7 | **On a phone, the conversation is at the very bottom** of a long page, below details, notes and history. | `case-phone-phone` | A **Case / Chat switch** under the header on phones. "Chat" shows the conversation at full height with the composer in reach. |

## Document viewer

| # | Problem | Seen in | Fix |
|---|---|---|---|
| V1 | **The wrong primary action.** When the chassis on the paper differs from the booking, "Looks right" is still the blue primary button, and the right answer, "Ask for a new one", is the secondary one. | `viewer-w1440` | The **primary follows the evidence**: on a mismatch, "Ask for a new one" is primary and "Looks right anyway" is secondary. Otherwise it stays "Looks right". |
| V2 | **The decision scrolls away.** The buttons sit under a 12-row table. On a long reading they leave the panel. | `viewer-w1280` | The decision is a **sticky footer** of the reading panel. |
| V3 | **A whole row for Previous / 1 of 3 / Next.** | `viewer-w1440` | The pager moves into the dialog header beside the title. |

## Chats

| # | Problem | Seen in | Fix |
|---|---|---|---|
| H1 | **Rows have no visual anchor.** Name, time and a channel glyph only. Unread is a 9 px dot. | `chats-arabic-w1440` | A **list row** with an initials avatar carrying the channel mark, a bold name and time when unread, and an unread count dot with words for screen readers. |
| H2 | **Their bookings** are monospace pills crammed into a strip above the conversation. | `chats-arabic-w1440` | Booking and request links are **tags** with status badges, in a header strip with a label. |
| H3 | **The STOP state is a grey sentence** in the composer, easy to miss. | `chats-stop-w1440` | A red **opted-out banner** with the reason, above a disabled composer. |

## Shipments

| # | Problem | Seen in | Fix |
|---|---|---|---|
| S1 | **ETA is a raw ISO date** (`2026-10-13`). A late arrival looks the same as a future one. | `shipments-w1440` | **ETA as a date plus distance**: "13 Oct · in 5 d", and a red "Late 2 d" badge when the date has passed and the shipment is not delivered. |
| S2 | **The vessel is missing** from the table, although the API sends it. | `shipments-w1440` | A Vessel column. |
| S3 | **The search box clips its own placeholder** ("…customer or chass"). | `shipments-w1440` | A **search field** with an icon, sized to its placeholder. |

## Search

| # | Problem | Seen in | Fix |
|---|---|---|---|
| R1 | **Every group looks the same:** bookings, customers, shipments and call-backs are identical white cards with a grey count. | `search-w1440` | Grouped results with a **section header** (icon, title, count). Each result is a list row with an icon, title, detail, status badge and chevron. |
| R2 | **The empty state is bare.** | `search-empty-w1440` | An **empty state** with an icon and a tip for searching by the last six characters of the chassis. |

## Settings

| # | Problem | Seen in | Fix |
|---|---|---|---|
| T1 | **One long scroll** with a row of pill links at the top that scroll away. | `settings-w1440` | A sticky **section nav** on the left on wide screens; sections as calm cards with a section header. |
| T2 | **The team table is wide and grey.** Role selects are 260 px wide; "Seen 5 wk ago" is the same weight for an active colleague and a switched-off account. | `settings-w1440` | Avatars with initials, narrower selects, and a status badge for "Active" and "Switched off". |
