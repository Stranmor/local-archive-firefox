# Compatibility and support

Last updated: **August 25, 2026**.

Local Archive 3.0 targets Firefox `142` or newer and supports Telegram Web (`https://web.telegram.org/`).

## Supported workflow

- current open Telegram conversation;
- most recent N messages;
- inclusive start and end dates;
- all history returned by the open Telegram Web manager or, when that manager is unavailable, the rendered fallback;
- readable HTML, structured JSON, or both;
- optional photos, videos, voice messages, stickers, and files;
- English, Russian, Ukrainian, German, French, Spanish, Brazilian Portuguese, and Polish UI.

Telegram exports first use the signed-in page's `appMessagesManager.requestHistory` contract through the versioned page bridge; the connector recognizes maintained message containers including `[data-mid]`, `[data-message-id]`, `[data-scope="bubble"]`, `.message-list-item`, and `.im_message_wrap` only as a compatibility fallback. Telegram can change either private interface without notice, so every export checks the actual open conversation and records the selected history source.

## Honest limits

- Local Archive can save only content that the signed-in source session exposes; it does not create a separate account-backup authorization.
- “All available” is not a complete Telegram-account backup guarantee.
- Protected, expired, inaccessible, or oversized attachments may be omitted while message text remains available; omissions are recorded in `export-summary.json`.
- On Telegram's native path, attachment bytes come from Telegram Web's own download manager rather than a token or direct HTTP replay; the page bridge keeps binary transfer bounded and releases its page-session media cache after each item.
- Attachment limits are Telegram photos up to 10 MB and other files up to
  100 MB per item.
- The source tab must remain open while history and attachments are collected; Telegram's manager or the rendered fallback runs in an inactive same-session helper tab, so the user does not have to watch the chat scroll.
- A source-tab reload does not silently lose an active run: reopening Local Archive in the same Telegram URL restores the latest progress or terminal receipt for up to five minutes. Navigating to another source URL does not attach the old run to the new page.
- While that run is active, the popup reports the tab as busy and disables a second start; terminal completion or failure releases the busy state.

Run deterministic and isolated Firefox checks with:

```bash
npm run check
npm run check:consumer
```

The consumer suite uses a disposable headless profile and synthetic content. It does not use the operator’s Firefox profile, screen, focus, input, or clipboard.
