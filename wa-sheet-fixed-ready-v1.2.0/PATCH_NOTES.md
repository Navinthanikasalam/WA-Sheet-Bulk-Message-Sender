# WA Sheet 1.1.0 — multi-group sending patch

## Fixed
- The Group source now supports selecting multiple groups with checkboxes.
- Campaigns send one message directly to each selected WhatsApp group instead of extracting members and sending to their phone numbers.
- Group discovery is restricted to WhatsApp's left chat pane, preventing Group Info controls such as `ic-closeGroup info` from being mistaken for a group name.
- The sender searches for and opens each group before sending text or media.
- Existing phone-number campaigns continue to use the original workflow.

## Install over the existing project
Replace `background.js`, `content.js`, `popup.js`, `popup.html`, `popup.css`, `manifest.json`, and `README.md` with these files. Keep the original `icons/` and `lib/xlsx.full.min.js` folders. Then open `chrome://extensions` and click **Reload** for WA Sheet.

## Use
1. Open WhatsApp Web and clear any active chat-list search.
2. Open WA Sheet → **Group Contacts**.
3. Click **Refresh Groups**.
4. Tick any number of groups and click **Continue with selected groups**.
5. Compose, review, and start the campaign.

WhatsApp Web changes its DOM periodically. Test with two small groups first and keep reasonable delays.

## 1.1.1 group synchronization fix
- Uses WhatsApp's own **Groups** chat filter instead of trying to infer groups from unstable icons or hidden IDs.
- Scans the complete virtualized group list by scrolling its real scroll container.
- Restores the **All** filter after synchronization so group search/sending works normally.

## 1.1.2 group opening/sending fix
- Clicks the actual inner WhatsApp chat cell with pointer and mouse events rather than only the outer list-row wrapper.
- Adds an Enter-key fallback for exact Search results.
- Supports newer WhatsApp compose-box selectors.
- Reads the current chat name from title attributes as well as visible header text.
- Reports separately when a group opens but posting is disabled.

## 1.1.3 chat-title verification fix
- Ignores the avatar's `Profile details` tooltip when verifying the opened chat.
- Checks every title/text candidate in the conversation header and matches the selected group.
- Prefers the complete chat-row title so names containing emoji are no longer truncated.

## 1.2.0 automatic ban-risk reduction safeguards
- Optional safety mode, enabled by default.
- Enforces a conservative minimum delay plus randomized extra delay.
- Applies a small batch size and longer cooldown between batches.
- Uses rolling extension-level hourly and 24-hour send limits.
- Automatically pauses a campaign after repeated consecutive failures.
- Shows the safety-pause reason and allows manual resume after review.

These controls reduce abusive sending patterns but cannot guarantee that WhatsApp will not restrict an account. Message only recipients/groups that expect the content and follow WhatsApp's terms.
