# WA Sheet — Bulk WhatsApp Sender (Chrome Extension)

## What it does
A WA Sheet–style Chrome extension: pick recipients from Manual Entry, an
Excel/CSV file, a public Google Sheet link, or a one or more visible WhatsApp groups, map the phone/message
columns, choose which rows to message (all or a checked selection), write
a template with `{{column}}` or `{column}` variables, optionally attach media, then send
automatically through your logged-in WhatsApp Web session.

## Install (unpacked, for testing/internal use)
1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this folder
4. Pin the "WA Sheet" icon, open a tab to **web.whatsapp.com** and scan the
   QR code once (normal WhatsApp Web login)
5. Click the extension icon to open the wizard

## How each source works
- **Manual Entry** — paste numbers with country code, comma or newline separated.
- **Excel / CSV** — drag a `.xlsx`/`.xls`/`.csv` file in (parsed locally with SheetJS, nothing uploaded anywhere).
- **Google Sheet** — paste the sheet URL. The sheet must be shared as
  "Anyone with the link — Viewer"; it's fetched as CSV via Google's export
  endpoint, no OAuth/sign-in required.
- **WhatsApp Groups** — open the Group Contacts tab, click **Refresh Groups**, tick one or more groups, and click **Continue with selected groups**. The campaign sends the composed message directly into each selected group. It does not extract or individually message group members.

After loading data you choose the phone & message columns from dropdowns,
then tick which rows to include (a "select all" checkbox is provided).

The Data step also supports duplicate removal and exporting the loaded contact
rows as CSV. The Review step supports a base delay, optional random gaps,
batch size and batch pauses, unsubscribe text, timestamps, and skipping a
persistent local unsubscribe list. Completed campaign results can be exported
from the Send step as a CSV report.

## How sending works
The extension does **not** use the WhatsApp Business API — it drives your
own logged-in WhatsApp Web tab the same way you would by hand: opening
each chat by phone number, typing the message, attaching media if any,
and clicking Send, with a delay between messages that you control.

**Because of that:**
- WhatsApp Web must stay open and logged in (the extension opens/reuses a tab for you).
- Chrome must stay running during a campaign — the popup can close, but don't close Chrome entirely.
- Numbers must include the country code and be on WhatsApp.
- Send speed is deliberately throttled (default 5s/message) — sending too fast is what gets numbers flagged by WhatsApp. Don't set this too low.
- WhatsApp periodically changes its web app's HTML, which can break the
  CSS selectors this extension uses to find the message box/send button.
  If sending suddenly stops working, that's the first thing to check —
  the selectors are all centralized at the top of `content.js`.

## Files
- `manifest.json` — extension config (Manifest V3)
- `popup.html/.css/.js` — the wizard UI and campaign builder
- `background.js` — service worker: owns the send queue, pause/resume/stop, persists progress in `chrome.storage.local` so a popup close/reopen doesn't lose progress
- `content.js` — runs on web.whatsapp.com; opens chats, types messages, attaches media, clicks send
- `lib/xlsx.full.min.js` — SheetJS, for parsing Excel/CSV entirely client-side

## Known limitations / next steps to discuss
- No message-template preview per-row scrolling yet (only shows the first selected row).
- Media captions rely on WhatsApp's caption box appearing after attaching — this can vary between image/video/document flows; test with your actual account before a big send.
- No "retry failed only" button yet — failed items stay visible in the results table but a one-click re-run isn't wired up.
- AI redrafting, AI reply analysis, chatbots, ban-risk prediction, and automatic
  contact/reply classification require an external AI/backend service and are
  not included in this local-only extension.
- This automates your **own** WhatsApp Web session — it's meant for your team's own outreach to numbers you have a right to message, not for spam; keep delays reasonable and respect WhatsApp's terms.

## Automatic ban-risk reduction safeguards
Version 1.2.0 adds an optional safety mode (enabled by default) with conservative minimum/random delays, small batches and cooldowns, rolling hourly/24-hour extension send limits, and automatic pausing after consecutive failures. Limits count successful sends made by this extension on the current Chrome profile.

This is risk reduction, not an anti-ban guarantee. WhatsApp can still restrict accounts based on consent, complaint/block rates, content, account history, and its terms. Only message recipients or groups that expect the content.
