# Local Archive architecture

Local Archive is a Telegram Web conversation exporter over one typed archive contract.

The ordinary Firefox flow is:

1. the toolbar popup identifies the active supported conversation;
2. the user chooses a recent-message count, inclusive date range, or all available history;
3. the Export click obtains source-origin access if Firefox requires it;
4. an automatic-history connector starts a same-session inactive helper tab; the source tab keeps only the compact progress surface, and collection begins only after the helper connector reports a readable conversation (not merely after navigation completes);
5. Telegram first calls Telegram Web's already-authorized `appMessagesManager.requestHistory` through a short-lived page bridge, so message history comes from the source manager rather than the rendered viewport; native attachments are resolved by Telegram Web's own download manager in bounded local chunks, and if the private page manager is unavailable, the connector records and uses its rendered-DOM fallback;
6. the Rust archive core in the extension background builds and verifies the ZIP and its receipt;
7. the helper tab is removed immediately after the terminal receipt reaches the source tab; the typed job receipt remains in Firefox session storage for five minutes so a source reload can recover it, while closing the source tab cancels the extension-owned helper and clears the job after the same bounded retention window.

The thin TypeScript connector owns source-specific page-manager/DOM history loading, message parsing, media discovery, progress rendering, and Firefox API calls. Automatic-history connectors run in an inactive same-session worker tab; the visible source tab receives only progress and the terminal receipt. The Rust/WebAssembly core owns connector descriptor validation, typed export requests and labels, settings normalization, inclusive range filtering, legal export-state transitions, normalized archive entries, safe paths, ZIP/AES construction, archive verification, and terminal receipts.

Telegram's native history path never extracts a token, cookie, or credential and never calls Telegram's HTTP/MTProto endpoint directly. It asks the signed-in Telegram Web page to use its own history and media managers, throttles history and media starts to one request per second, transfers media in bounded chunks, and keeps only opaque page-session references in the exporter; the bridge is static, versioned, origin-limited, and falls back to the legacy rendered adapter only when the manager contract is absent.

The popup and settings page share one defaults store for format, attachment inclusion, recent-message count, and UI language. They do not store conversation content.

The canonical diagram source is [`architecture.d2`](architecture.d2).
