# MKY Desk design system

The rules, tokens, components and layouts the MKY Desk is built from. Everything here is real code:

- the tokens are the custom properties at the top of `public/desk/desk.css`;
- the components are CSS classes in the same file;
- the JavaScript helpers that build the components live in `public/desk/ui.js`.

There is no framework and no build step, so this document is the only place the system is written down. When a page needs something that isn't here, add it here and to `desk.css` first, then use it.

Who it is for: the operations team of three to ten people, all day, on laptops at 1280–1440 px (often at 125% display scaling) and on 1920 px monitors. The desk is in English. Customers write in English and Arabic.

## Principles

1. **One primary action per view.**
   - The Next step card has exactly one filled button.
   - In the viewer, the primary button follows the evidence. A paper that does not match the booking makes "Ask for a new one" the primary.
   - When the primary scrolls out of view, a copy appears in the case header on a desktop, or in the bottom bar on a phone. Two copies are never on screen at once.
2. **Status is always a word, an icon and a colour, never colour alone.** A badge reads "Waiting for the customer" with a clock, in amber. A person who cannot tell amber from green still reads the word and sees the clock.
3. **Newest urgency first.** The server sorts the inbox: problems, then urgent, then overdue, then high priority, then oldest first. The design makes that order visible:
   - the stripe on the left of each row;
   - the age, which turns amber, then red;
   - the Urgent badge, and the word OVERDUE under the age.
4. **Colour means one thing everywhere.**

   | Colour | Means |
   |---|---|
   | Blue | Ours to do |
   | Amber | Waiting on the customer, or getting late |
   | Green | Done |
   | Red | Something is wrong |
   | Grey | Closed, or neutral |

   Brand blue is also the colour of links and the primary button. Nothing else is blue.
5. **Quiet until it matters.** Text is ink on white. Secondary text is a darker grey than before (at least 6.5:1). Lines are hairlines. Red is spent once per row.
6. **Text, never HTML.** Every string reaches the page as a text node or an attribute through `h()`. Icons are inline SVG built from static path data. A test fails the build if any desk file assigns `innerHTML`.
7. **Right to left where the customer wrote right to left.**
   - Every piece of user-written text has `dir="auto"` or sits in a `<bdi>`. That covers names, messages, notes and answers.
   - A conversation line is laid out on its own, so an Arabic line runs right to left and the English line under it runs left to right.
   - File names are isolated left to right, the way a file manager shows them.
   - The desk's own chrome stays English and left to right.

## Tokens

All tokens are CSS custom properties on `:root`. Don't use a raw colour, size, gap, radius or shadow in a rule.

### Colour

**Neutrals.** A cool slate scale, used through role tokens.

| Token | Value | Role token | Used for |
|---|---|---|---|
| `--n-0` | `#ffffff` | `--surface` | cards, lists, inputs |
| `--n-25` | `#fbfcfd` | `--surface-2` | table heads, dialog footers, row hover |
| `--n-50` | `#f5f6f8` | `--bg` | page background, transcript |
| `--n-100` | `#eef0f3` | `--surface-sunk` | quiet tags, segmented track, icon tiles |
| `--n-150` | `#e6e9ed` | `--line` | hairlines between rows |
| `--n-200` | `#d9dde3` | `--line-strong` | button borders, card dividers |
| `--line-input` | `#858d99` | | the edge of a text field (3.3:1, WCAG 1.4.11) |
| `--n-500` | `#6b7482` | `--ink-placeholder` | placeholders only (4.7:1) |
| `--n-600` | `#4f5865` | `--ink-3` | secondary text (7.2:1 on white) |
| `--n-700` | `#3d4450` | `--ink-2` | strong secondary text (9.8:1) |
| `--n-900` | `#15181d` | `--ink` | body text (17.8:1) |

**Brand.**

| Token | Value | Used for |
|---|---|---|
| `--brand-600` (`--accent`) | `#1d5bd6` | primary button, links, focus ring, active tab |
| `--brand-700` | `#1749b0` | hover, active nav text |
| `--brand-50` / `--brand-100` | `#eef3fe` / `#dce6fc` | active nav, staff bubbles, focus halo |

**Semantic.** Each tone has four values: text, soft background, border and solid. Text on its soft background is always at least 5.6:1.

| Tone | Meaning | Text | Background | Border | Solid (stripes, meters) |
|---|---|---|---|---|---|
| blue | ours to do | `#1b4fc4` | `#e8effd` | `#b9cdf5` | `#1d5bd6` |
| amber | waiting or getting late | `#8a4a00` | `#fdf1dc` | `#efcd92` | `#c47a12` |
| green | done | `#146c3c` | `#e4f4ea` | `#a9d8bb` | `#23874f` |
| red | wrong or failed | `#b3261e` | `#fdeceb` | `#f1b5b0` | `#c42b22` |
| gray | closed or neutral | `#4a5260` | `#eef0f3` | `#d5d9df` | `#8a929e` |

**Channels.** Used only for the channel mark, never for status.

| Channel | Mark | Background |
|---|---|---|
| WhatsApp | `--wa: #138a4a` (4.4:1) | `--wa-bg` |
| Telegram | `--tg: #1f6fb2` (5.3:1) | `--tg-bg` |

**Internal notes.** `--note-bg` `#fff8e1`, `--note-line`, and `--note-ink` `#5b4200` (8.9:1). The yellow is reserved for things that never leave the desk.

### Type

| Token | Size | Use |
|---|---|---|
| `--text-xs` | 12 px | counts inside badges, `kbd`, eyebrows. Never sentences. |
| `--text-sm` | 13 px | metadata, captions, table headers, timestamps |
| `--text-md` | 14 px | body and controls (the `body` default) |
| `--text-lg` | 15 px | reading text: inbox row titles, chat bubbles, card titles, checklist names |
| `--text-xl` | 18 px | page titles (`h1`), the Next step title, dialog titles |
| `--text-2xl` | 22 px | reserved |

Line heights:

| Token | Value | Use |
|---|---|---|
| `--lh-tight` | 1.25 | controls |
| `--lh-snug` | 1.35 | headings |
| `--lh-body` | 1.5 | body |
| `--lh-read` | 1.55 | messages |

A right-to-left line in a bubble gets 1.7, because Arabic needs more height. Weights: 400, 560 (medium), 620 (semibold) and 700. Body text on a phone goes to 15 px.

Fonts, system only:

- `--font`: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, …`, then `"Noto Sans Arabic", "Noto Naskh Arabic", "Segoe UI Arabic", Tahoma`;
- `--mono`: `ui-monospace, "Cascadia Mono", Consolas, …`, for references, chassis numbers and MRNs.

Times and counts use `font-variant-numeric: tabular-nums`, so a column of ages lines up.

### Spacing, radii, elevation, layers, motion

| Group | Tokens |
|---|---|
| Spacing (4 px steps) | `--sp-1` 4 · `--sp-2` 8 · `--sp-3` 12 · `--sp-4` 16 · `--sp-5` 20 · `--sp-6` 24 · `--sp-8` 32 · `--sp-10` 40 · `--sp-12` 48 |
| Radii | `--r-xs` 4 (kbd, focus) · `--r-sm` 6 (buttons, inputs, tags) · `--r-md` 8 (cards, lists, menus) · `--r-lg` 12 (dialogs, bubbles) · `--r-full` (badges, avatars) |
| Shadows | `--shadow-xs` (cards) · `--shadow-sm` (selected segment, raised chips) · `--shadow-md` (menus) · `--shadow-lg` (dialogs, toasts) |
| Layers | `--z-sticky` 20 (case header, phone pane switch) · `--z-top` 30 (top bar) · `--z-menu` 40 · `--z-tabbar` 50 · `--z-offline` 60 · `--z-toast` 90 (toasts are also a popover, above dialogs) · `--z-skip` 100 |
| Motion | `--dur-fast` 120 ms (hover, colour) · `--dur-base` 180 ms (toasts, dialogs, bottom bar) · `--ease`. `prefers-reduced-motion` turns all of it off. |
| Control heights | `--h-sm` 32 · `--h-md` 36 · `--h-lg` 40. Nothing a person clicks to act is shorter than 32 px. |
| Shell | `--side-w` 224 · `--rail-w` 76 · `--top-h` 56 · `--case-head-h` (set by `case.js` from the real header) |

## Components

Each component lists its classes, its JavaScript helper if it has one, and its variants and states.

### Button: `.btn`

| Variant | Class | When |
|---|---|---|
| Primary | `.btn-primary` | The one action of the view. Filled brand blue. |
| Secondary | `.btn` (or `.btn-secondary`) | Other actions. White with a border. The default. |
| Ghost | `.btn-ghost` | Low-weight actions: "Set aside", "Cancel", pager, "…". |
| Danger | `.btn-danger` | The confirm button of a destructive dialog. Filled red. |
| Danger ghost | `.btn-ghost.btn-danger-ghost` | A destructive action offered next to others: "Reject request", "Remove". |
| Icon only | `.btn-icon` | Needs `aria-label` and `title`, for example "More actions". |

Sizes: `.btn-sm` (32 px), the default (36 px) and `.btn-lg` (40 px, for the Next step primary). Use `.btn-block` for full width.

States:

- hover darkens;
- `:focus-visible` shows a 2 px brand outline;
- `:disabled` or `[aria-disabled="true"]` is at 50% opacity with a `not-allowed` cursor;
- `[aria-busy="true"]` shows the progress cursor, and the label changes to "Sending…" or "Saving…".

Helper: `actionButton(spec, onclick, { cls, showReason, iconName })`.

- `spec.kind` is one of primary, secondary, ghost, danger, danger-secondary or danger-ghost.
- A disabled spec keeps its reason as a tooltip. Clicking it shows the reason as a toast. `showReason: true` also prints the reason under the button.

### Status badge: `.badge`

Helper: `badge(words, tone, { outline, small, icon })`.

- `tone` is blue, amber, green, red or gray.
- The icon comes from the tone unless you pass one: blue `dot`, amber `clock`, green `check`, red `alert`, gray `minus`.
- `outline: true` is for "whose turn" badges.
- `small: true` (20 px) is for dense places: table cells, chat rows, team rows.

#### Every status, one table

The words come from the server (`workflow.js` and `lib/admin`). The desk only chooses the tone and the icon. Turn badges are outlined with a person icon.

| Kind | Stored value | Badge words | Tone | Icon |
|---|---|---|---|---|
| Booking | `draft` | Draft — the customer is still filling it in | gray | minus |
| | `pending_review` | New request | blue | dot |
| | `under_review` | Being checked | blue | dot |
| | `needs_client_action` | Waiting for the customer | amber | clock |
| | `confirmed` | Confirmed | green | check |
| | `rejected` | Rejected | red | alert |
| | `cancelled`, `expired` | Cancelled, Expired | gray | minus |
| Call-back | `open` | New — nobody has it yet | blue | dot |
| | `assigned`, `in_progress` | Taken, In progress | blue | dot |
| | `waiting_client` | Waiting for the customer | amber | clock |
| | `resolved` | Resolved | green | check |
| | `closed` | Closed | gray | minus |
| MRN application | `draft` | Customer still filling it in | gray | minus |
| | `submitted` | New application | blue | dot |
| | `under_review` | Being worked on | blue | dot |
| | `approved` | Approved — record the number | blue | dot |
| | `missing_information` | Waiting for the customer | amber | clock |
| | `issued` | MRN issued | green | check |
| | `rejected` | Rejected | red | alert |
| | `cancelled` | Cancelled | gray | minus |
| Document | `received`, `pending_verification` | Received, not checked | blue | eye (checklist) / dot |
| | `verified` | Checked, or Checked by *name* | green | check |
| | `replacement_requested` | New copy asked for — *reason* | amber | refresh |
| | `rejected` | Rejected | red | alert |
| | (chassis differs) | Chassis differs from the booking | red | alert |
| | (bot could not read) | The bot couldn't read it — check it by eye | red | alert |
| | (still reading) | Arrived, still being read | gray | clock |
| | (none yet) | Not received | amber | clock |
| Shipment | Delivered, Customs cleared, released | as stored | green | check |
| | On hold, any "delay" | as stored | red | alert |
| | Loaded, Vessel departed, In transit, Arrived, Customs clearance in progress, Out for delivery | as stored | blue | dot |
| | Booking confirmed awaiting cargo, Awaiting pickup, Received at origin warehouse | as stored | gray | minus |
| | (ETA passed, not yet arrived) | Late *n* d | red | alert |
| Message (ours) | `queued` | Queued | – | clock |
| | `sent` | Sent | – | ✓ |
| | `delivered` | Delivered | – | ✓✓ |
| | `read` | Read | brand | ✓✓ |
| | `failed` | Not delivered, plus the reason in words and Retry | red block | alert |
| Turn | `ops` / `client` / `none` | Our turn / Customer's turn / Nothing to do | blue / amber / green | person |
| Inbox flags | priority `urgent` / `high` | Urgent / High | red / amber | alert |
| | overdue (server SLA) | OVERDUE, under the age | red text | alert (on the age) |
| | outside office hours | After hours | tag | clock |
| Customer | `opted_out_at` | Wrote STOP | red | alert (badge) / lock (chat list) |
| | `is_blocked` | Blocked | red | lock |
| Team | active / switched off | Active / Switched off | green / gray | check / minus |

### Tag: `.tag`

Helper: `tag(words, { icon, quiet, href })`. A tag says what kind of thing something is, not its state: Booking, Call-back, Arabic, English, WhatsApp, After hours. It is a 24 px square-cornered label with a border; `.tag-quiet` has no border and a grey fill. A tag with `href` is a link.

### Avatar: `.avatar`

Helper: `avatar(name, { size: 'sm' | '' | 'lg', channel })`.

- Shows the initials of the first two words. Arabic names give Arabic initials.
- One of six colour pairs is picked from the name, so a person always looks the same. The colour carries no meaning.
- `channel` adds a small WhatsApp or Telegram mark at the bottom right.
- Avatars are `aria-hidden`: the name is always written beside them.

### Channel mark

`channelBadge(channel)` gives the icon and the word. `channelIcon(channel)` gives the icon with the word for screen readers only, for rows where space is tight.

### List row: `.row` (inbox), `.chat-row`, `.result`

The inbox row is a grid. The header (`.list-head`) and every row share fixed column widths, so each column lines up down the list:

| # | Column | Content |
|---|---|---|
| 1 | Stripe | `.row-mark.mark-{red,amber,blue,green,gray}`. Urgency: red for a problem, urgent or overdue; amber for high priority or waiting; blue for ours; green for done. |
| 2 | Kind | `.row-kind`: truck (booking), phone (call-back), stamp (MRN), triangle (problem). The word is in the link for screen readers. |
| 3 | What needs doing | The sentence, in 15 px semibold. It is a link stretched over the whole row. Under it, the detail on one line, clamped, with the full text on hover. |
| 4 | Customer | Channel icon and name, then the reference in mono, or the kind of work when there is no reference. |
| 5 | Status | One status badge (see "Row status" below), then Urgent or High, then the After hours tag. |
| 6 | Owner | Avatar and name, "You", or the **Take it** button (`.row-take`) when nobody has it and it is ours to do. |
| 7 | Age | Clock icon and "12 min", toned by the age thresholds below, with **OVERDUE** in red under it when the server says so. Right aligned. |

#### Row status

`statusOf()` in `inbox.js`:

| Kind | Status badge |
|---|---|
| Booking | The server's words: New request, Being checked, Confirmed, Rejected. "Waiting for the customer" is shortened to "Waiting on customer", the tab's own words, so it fits its column. |
| Call-back | New (nobody has it), In progress (somebody has it), Waiting on customer, then Resolved or Closed. |
| MRN application | New application, Approved (record the number), Waiting on customer, MRN issued. |
| Problem | Unreadable (a paper the bot could not read), Not delivered (a message that failed), Held (waiting for a template, or the customer wrote STOP). |

Buttons inside a row (Take it, Retry, Set aside) sit above the stretched link (`z-index: 1`), so they stay their own targets.

Column widths:

| Screen | Customer | Status | Owner | Age |
|---|---|---|---|---|
| 1361–1679 px | 196 | 184 | 124 | 76 |
| 1680 px and wider | 280 | 240 | 160 | 88 |
| Rail (1101–1360 px) | 190 | 168 | 116 | 64 |

From 1101 down to 981 px the customer column goes, and the name moves into the detail line. At 980 px and below the row becomes two lines: the sentence and age, then the tags and owner.

#### Age thresholds

`ageTone()` in `inbox.js`:

| Tab | Neutral | Amber | Red |
|---|---|---|---|
| Needs us | under 30 min | 30 min to 2 h | 2 h or more, or whenever the server says `overdue` (SLA from Settings: 2 h for a new request, 4 h under review) |
| Waiting on customer | under 24 h | 24 h or more (time to chase) | never: it is not our delay |
| Done today | always | – | – |

A red age also gets an alert icon and the screen-reader words "waiting too long", or "overdue" when the server says so (then OVERDUE is also written under the age). Amber says "getting late".

### Card and section header: `.card`, `.card-head`, `.section-head`

- A card is white with a hairline border, an 8 px radius and padding of 16 by 20 px.
- `.card-head` holds an `h2` (15 px semibold with an optional 16 px icon), a quiet note (`.card-sub`) and tools on the right (`.card-tools`, for a progress meter or a badge).
- `.section-head` is the header of a group without a card: an icon, an `h2`, and a `.count`. Search groups use it.
- `.stack` gives a vertical 16 px gap.

### Key-value list with inline edit: `.kv`

This replaces the column of "Correct" links.

```
<dl class="kv">
  <div class="kv-row"><dt class="kv-key">Chassis (VIN)</dt>
    <dd class="kv-val"><bdi class="mono">WDB…</bdi>
      <button class="icon-btn kv-edit" aria-label="Correct chassis (vin)">✎</button></dd></div>
</dl>
```

How it behaves:

- **At rest.** The pencil (`.kv-edit`) is invisible. It appears on the hovered row, and when keyboard focus is in the row. On touch screens (`hover: none`) it is always visible. It stays in the tab order and the accessibility tree.
- **Editing.** Choosing the pencil turns that one row into an input with Save and Cancel (`.kv-row.is-editing`, `.kv-form`). Enter saves and Escape cancels. One field is saved per request, carrying the version the page was drawn from, exactly as before.
- **Empty values** read "Not given" in placeholder grey (`.kv-empty`), not a dash.
- **Compact variant.** `.kv-compact` is for dialogs, such as the confirm dialog's summary.
- **Phone.** Under 760 px the key sits on its own line above the value.

### Tabs and segmented filter: `.tabs` / `.tab`, `.seg` / `.seg-item`

- **Tabs** switch between lists of the same kind of thing: Needs us, Waiting on customer and Done today. They are underlined, with a count pill (`.tab-count`) that turns brand when active. On a phone they show short labels (`.short`), while screen readers still hear the long ones.
- **The segmented filter** narrows the current list: All, Bookings, MRN, Call-backs, Problems, Mine. It is a grey track, and the active item is a raised white segment.
  - Each item has a count. A zero count drops to regular weight (`.is-zero`).
  - A non-zero Problems count is a red pill (`.is-alert`).
  - The current item has `aria-current`.
  - On a phone the track scrolls sideways rather than wrapping.
- Shipments uses the segmented filter for On the way, Delivered and All.

### Search field: `.search` (top bar), `.search-field` (in a page)

- An input with a 16 px search icon inside, on the left.
- The top bar's field shows a `/` key hint until it is focused. Pressing `/` anywhere outside a field focuses it.
- In-page fields (Chats, Shipments) are `<label class="search-field">` with the icon and the input.

### Composer: `.composer`

Top to bottom:

1. The **channel banner**:
   - window open: quiet line, "WhatsApp window open · 23 h left";
   - fewer than 3 h left: amber banner;
   - window closed: amber banner with the "please reply" template button;
   - opted out or blocked: red banner;
   - can't send for another reason: grey banner;
   - Telegram: quiet line, "Telegram · no time limit".
2. The **composer box** (`.composer-box`): a borderless textarea (15 px, `dir="auto"`) and a row with Saved replies, the Ctrl+Enter hint (`kbd`) and Send. The box takes the focus ring as a whole. It is disabled, grey, when nothing can be sent.
3. The **error line**, when a send failed, in the server's words.

On a phone the hint and the bot-state lines are hidden, and Send keeps its place on the right.

### Chat bubble: `.msg`, `.bubble`

| Who | Side | Fill |
|---|---|---|
| Customer (`.msg-in`) | left | white with a border |
| Bot (`.msg-bot`) | right | grey |
| Staff (`.msg-staff`) | right | brand-50, the name in brand |
| Notification (`.msg-system`) | right | warm grey |

Details:

- Each bubble has a corner cut toward its side.
- The meta row holds who sent it (except the customer), the time, and the delivery tick in words.
- A tapped button is a dashed pill, not a bubble.
- A failed message gets a red block under the bubble: "Not delivered." with the reason in words, and Retry or "Sent again".
- Long messages clamp at 12 lines and have "Show all".
- File messages (document, image, video, audio) show a **file chip** (`.file-chip`): a file icon and the file name in a left-to-right `<bdi>`. The caption, if any, goes under it as text.
- Day separators are pills (`.day`).

### Document card and checklist item: `.checklist`, `.check-item`

One row per required paper:

- a 32 px status circle (`.check-icon.tone-*`: check, eye, alert, refresh or clock);
- the paper's name (15 px semibold);
- the state in words, coloured by tone;
- the file name, left to right, truncated;
- one button: secondary **Check** (eye icon) when the paper needs eyes, ghost **View** when it is done. Missing papers have no button.

The card's header carries a segmented progress meter (`.progress`), one segment per paper in its tone, with the words "1 of 3 checked".

### Dialog: `.dialog`

- A native `<dialog>` opened with `showModal()`: focus stays inside, Escape closes, and the backdrop is 50% ink.
- **Header**: an 18 px title, a subtitle, an optional extra area (`.dialog-extra`, used for the viewer's pager) and a close button.
- **Body**: scrolls.
- **Footer** (`.dialog-actions`): on a light surface. Cancel is secondary, and the action is primary, or danger if it cannot be undone.
- The first field takes the focus on open.
- One action key per dialog, so a retried press is recognised by the server.
- `.dialog-xl` is the document viewer, 1280 by 900 at most.
- On a phone a dialog is full screen.

### Toast: `.toast`

Helpers: `toast(message, tone, { timeout, icon })` and `toastError(err)`.

| Tone | Icon | Left border | Use |
|---|---|---|---|
| `ok` | check-circle | green | it worked |
| `info` | circle | blue | worth knowing, such as a colleague changing the case |
| `warn` | alert, or the icon passed | amber | it couldn't be done, but nothing broke |
| `bad` | alert, on a dark red surface | | it failed |

`toastError()` sorts an error by its cause:

| Cause | Toast |
|---|---|
| offline | warn, with the wifi-off icon |
| 403 | warn, with a lock icon and the server's sentence about the role |
| 409, stale | info |
| anything else | bad |

Toasts stack bottom left, last 4.5 s (9 s for warn and bad), have a dismiss button, and are a manual popover, so they show above an open dialog. `role="status"` is used for ok and info, `role="alert"` for warn and bad.

### Banner and callout: `.banner`, `.callout`

- **A banner** is the state of a whole region: the WhatsApp window, opted out, read-only role, offline. It comes in green, amber, red and gray, plus a quiet variant: icon, bold lead words, the sentence, and an optional button.
- **A callout** is a message inside a card: same chassis on another booking, a shipment open, does not match the booking, the bot couldn't read it. It comes in the same tones, with a 16 px icon.
- **The offline bar** (`#offline`) is a dark sticky strip at the very top with a wifi-off icon: "Offline — retrying. Nothing you have typed is lost."

### Empty, loading and error states

| State | Helper | What it shows |
|---|---|---|
| Empty | `emptyState(title, detail, action, { icon, tone })` | A 48 px icon in a soft circle, a title saying what the place is for, one line of help, and at most one action. `tone: 'done'` makes the icon green, for "Nothing needs you right now". |
| Error | `errorState(err \| message, retry)` | Takes the error itself where it can. A 403 shows a lock and "Your role cannot open this" with the server's reason, and no retry. Offline shows wifi-off, "You are offline", and that nothing typed is lost. Anything else shows the message and Try again. |
| Loading | `skeleton(n, { kind })` | A placeholder shaped like what is coming: `'rows'` (circle, two lines, a pill, a short bar, as in the inbox, chats, search and shipments), `'cards'` (a tall card then shorter ones, for the case, shipment and settings pages) or `'lines'`. It shimmers, and stays still under `prefers-reduced-motion`. |

### Table: `.table`

- Used for Shipments and for the team and template tables in Settings.
- A 40 px header on the light surface, in 13 px semibold grey.
- Cells have 12 px padding and hairline rows.
- `.table-hover` highlights rows.
- `.cell-sub` is the second line in a cell, for a chassis or a vessel. `.nowrap` keeps references whole.
- A row that opens something has one `.stretch` link covering the row.

The Shipments table:

| Column | Content |
|---|---|
| Shipment | mono link |
| Customer | channel icon and name |
| Vehicle | vehicle, with the chassis below |
| Route and vessel | route, with a ship icon and the vessel below |
| Status | badge |
| Arrives | the date and how far off ("13 Oct · in 5 d", "tomorrow", "arrived"), or a red "Late 2 d" badge once the date has passed without arriving |
| Updated | "3 h ago" |

On a phone every row becomes a stacked card with "Label: value" lines.

### Form controls

- **Inputs.** `.input` (36 px; `.input-small` 32 px) with a `--line-input` border at 3.3:1. On focus the border turns brand with a 3 px brand-100 halo.
- **Labels.** `.label` is 13 px semibold `ink-2`.
- **Fields.** `.field` stacks a label, a control, a hint and an error with 6 px gaps. The hint is `.field-hint`, 13 px grey. The error is `.field-error`, 13 px red, and the server's per-field sentence goes here.
- **Check boxes and radio buttons.** `.check` and `.radio` are 18 px native controls in the brand colour. A `.radio` is a bordered option that turns brand-tinted when chosen.
- **Layout.** `.form-grid` lays fields out in columns of at least 220 px. `.form-actions` holds a primary save and, where it helps, the "Last changed by…" line.

### Menu: `details.menu`

- A `<details>` with a `<summary>` button and a `.menu-list` of `.menu-item`s. Each item has a title and an optional grey sub-line. `.menu-danger` turns the title red.
- Disabled items stay listed with their reason.
- `.menu-up` opens upward, used by Saved replies above the composer. `.menu-right`, or `.menu-flip` added automatically when a menu would leave the screen, aligns the menu right.
- Clicking outside or pressing Escape closes any open menu.

## Layout patterns

### App shell

- **Sidebar** (224 px, sticky, full height):
  - the brand mark and name;
  - the navigation: Inbox, Chats, Shipments, Settings (administrators only);
  - the Inbox count, which is red while there are problems;
  - two shortcuts under Inbox, "Assigned to me" and "Problems", with their counts;
  - a hint at the foot: "Press / to search".
- **Rail.** At 1360 px and below the sidebar becomes a 76 px rail: icon over a 12 px label, with the count on the icon. A laptop at 1280×800 and 125% gets 150 px back for the work.
- **Top bar** (56 px, sticky, translucent): the search field (up to 680 px), then the **account menu** on the right. The menu shows an avatar and name; open, it holds the name, role and Sign out.
- **Content**: 20 by 24 px padding, at most 1760 px wide.
- **Phone** (760 px and below):
  - the sidebar is replaced by a fixed bottom tab bar with counts;
  - the top bar keeps the brand mark, search and account menu;
  - content has 12 px gutters.

### Inbox

1. Page head: title, a one-line purpose, and "Updated hh:mm".
2. Tabs, then the segmented filter.
3. One list card with the column header and rows, then "Show more" when there are more.

At 1920 px the list fills the content width, and the extra goes to the customer and status columns (280 and 240 px). There is no list-and-preview split; see "Left out" below.

### Case page

- **Sticky case header**, across the full width under the top bar:
  - line 1: "← Inbox", the reference in 18 px mono, the status badge, the turn badge and priority;
  - line 2: the facts (vehicle · chassis · route · came in);
  - right side: the owner control (avatar, "Sara has this", Take it over / Take it / Put back), and the copy of the primary action once the Next step card has scrolled out of view.

  `case.js` measures the header and sets `--case-head-h`, so the conversation can stick under it.
- **Two columns**: `minmax(0, 1fr)` for the work and `clamp(360px, 32vw, 600px)` for the conversation. In the rail layout it is `clamp(340px, 34vw, 460px)`.
  - The left column stacks, 16 px apart: Next step, warnings, what we asked, documents, MRN, details, internal notes, history (the last 6, then "Show all").
  - The right column is the conversation card, sticky, filling the rest of the screen's height. Its header, transcript, banner and composer are always in view.
- **The Next step card** is the anchor:
  - a 4 px stripe in the turn's tone;
  - the "NEXT STEP" eyebrow;
  - an 18 px bold title and its detail;
  - one 40 px primary;
  - secondary actions as outlined buttons, destructive ones as red text;
  - everything the server marks `more` under an icon-only "…" menu.
- **980 px and below**: one column, the conversation 640 px tall, the header not sticky.
- **Phone**: a sticky **Case / Chat** switch under the header.
  - "Chat" hides the work and shrinks the header to the reference and its badges. The conversation fills the rest of the screen above the tab bar, with the composer in reach without scrolling.
  - "Case" shows the work, with the primary action in a bottom bar once the Next step card scrolls away. That bar has a "Chat" button that switches panes.

### Document viewer

- A full-height dialog.
- **Header**: the paper and the reference, the pager (Previous · 2 of 3 · Next; ← and → also work), and close.
- **Left** (1.3 fr): the PDF drawn by pdf.js on canvases at the screen's pixel density, with a file bar under it (file name, "Open in a new tab").
- **Right**: a scrolling panel (status badge and arrival time, mismatch callout, the reading table with Matches / Differs per field, or the type-in form for an unreadable paper) and a **pinned footer** with the decision. The footer shows the primary first, which follows the evidence. "Ask for a new one" replaces the panel with reasons, a note, the exact message preview, and Send / Back.
- **980 px and below**: the file goes above the panel. On a phone the footer stays pinned to the bottom.

### Chats

- **List** (300–380 px): a search field, then rows of avatar, name, time, last message, failed / STOP badges and the unread dot. Unread rows come first.
- **Pane**: a strip of the customer's bookings and open requests, as pill links with badges, then the conversation component.
- **Phone**: the list and the pane are separate routes, with "← All chats".

### Settings

- A 200 px sticky **section nav**: Team, Hours and phone, Documents, WhatsApp, Saved replies, each with an icon. The section in view is marked.
- Sections are cards with an icon, a title and one calm sentence on what the section does.
- Each section saves on its own. Errors appear beside the field they belong to.
- **1360 px and below**: the nav becomes a row of links above the cards.

## Accessibility checklist

- **Contrast.** Every text pair in the token tables is AA: body 17.8:1, secondary 7.2:1, badge text 5.6–6.9:1, white on brand 6:1. Field edges and meaningful icons are at least 3:1.
- **Focus.** A visible focus ring everywhere: 2 px brand with a 2 px offset, or a 3 px halo on fields. Dialogs move focus to their first field; menus return focus to their button on Escape.
- **Hit targets.** Primary controls are at least 32 px tall. Nav items are 38 px, the phone tab bar 48 px, Next step buttons 40 px.
- **Words with every colour.** Status badges have words and icons. Age has a number, plus screen-reader words when late. The stripe repeats information that is also a badge or the sort order.
- **Direction.** `dir="auto"` or `<bdi>` on everything a customer, a colleague or the bot wrote.
- **Landmarks.**
  - Navigation landmarks: the sidebar, the tab bar and the settings sections.
  - The page is `<main>`. The conversation is an `<aside>` with a label, and the transcript has `role="log"`.
  - A "Skip to content" link comes first in the page.
- **Live regions.** Toasts are announced. The inbox "Updated" time, search results and message previews are `aria-live="polite"`.

## Left out, on purpose

- **A list-and-preview split for the inbox on big screens.** A preview would need the case data, the actions and their dialogs a second time beside the list. That doubles the code that decides what a person may do, for a saving of one click. The team opens a case to act on it. The width goes to aligned columns instead.
- **A dark theme.** The desk is used in offices in daylight. A second palette doubles every contrast check. The tokens make it a later, contained change.
- **Sorting and column choosers in the inbox and shipments.** The server's order is the policy: urgency first. Letting each person re-sort would hide it.
