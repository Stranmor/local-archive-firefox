<p align="center">
  <img src="assets/icon-master.png" width="96" height="96" alt="Local Archive icon">
</p>

<h1 align="center">Local Archive</h1>

<p align="center"><strong>A practical conversation exporter for Firefox.</strong></p>

Local Archive saves the open Telegram Web conversation as a local ZIP. Version 3.0 ships a Telegram page-manager connector with a rendered fallback on a typed Rust/WebAssembly core.

## Workflow

1. Open a conversation in Telegram Web.
2. Click Local Archive in the Firefox toolbar.
3. Choose the range, output format, and whether to include attachments.
4. Click **Export ZIP**. When the selected range needs older history, Local Archive collects it in an inactive same-session helper tab, so the visible conversation does not scroll; leave the source tab open until the result appears.

The toolbar panel supports:

- the most recent N messages;
- an inclusive start and end date;
  - all history Telegram Web can reach through the signed-in source session;
- readable HTML, structured JSON, or both;
  - Telegram photos up to 10 MB and other files up to 100 MB per item. History and native attachment bytes are read through Telegram Web's signed-in page manager when available; skipped items are counted in the result;
- English, Russian, Ukrainian, German, French, Spanish, Brazilian Portuguese, and Polish.

Export progress appears as a compact panel inside the source tab while the history scan runs out of your way in the background. It shows the collected message count, elapsed time, and—after saving—the exact ZIP filename and size. If Telegram reloads while the run is active, reopening Local Archive restores the live progress or the recent terminal result for five minutes; the popup also marks the tab busy and disables a duplicate start. Closing the source tab cancels that background run so an orphaned helper cannot keep working unnoticed. The ordinary workflow does not open a second product dialog, show archive-opening tutorials, or hide spoiler text in the exported HTML.

## Current scope

| Connector | Status | Notes |
| --- | --- | --- |
| Telegram Web | Version 3.0 | Current conversation, range filtering, HTML/JSON, optional attachments |
| Other web apps | Planned | Added through the same request and archive contract |

The product is intentionally Telegram-only until another source has its own consumer-proven adapter and release contract.

## Development installation

Requirements: Firefox 142 or newer, Node.js 24.19, npm 11.17, Rust 1.97.1, and `wasm-pack` 0.15.

```bash
npm ci
npm run build
```

Then open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…**, and select:

```text
.output/firefox-mv3/manifest.json
```

This is the intended development route. The add-on is temporary and disappears after Firefox restarts; Mozilla signing is not needed for local development.

For a repeatable no-click development loop, Firefox can expose its DevTools server through a Unix socket inside a mode-`0700` runtime directory. With that browser instance running, use:

```bash
npm run dev:install
```

The bundled Rust development loader waits for that socket, verifies the exact add-on ID and version, hashes the unpacked build, installs it as a temporary add-on, reads it back from Firefox, and writes an atomic installation receipt. This route deliberately does not bypass Firefox signing for permanent installation; it automates the supported temporary-development lifecycle.

## Permissions and data handling

The extension uses the temporary tab access created by the explicit toolbar click. It can request optional access only to the selected supported source if Firefox does not provide that temporary grant for the invocation. The remaining Firefox APIs inject the connector, save local defaults, build the ZIP, download it, and reveal the completed file on request.

Conversation content is read from the signed-in Telegram Web session and the ZIP is assembled locally. Telegram uses the page's own authorized history manager through a static bridge and never extracts tokens or cookies. The extension has no analytics, account service, remote executable code, or upload backend. See `PRIVACY.md` and `SECURITY.md` for the maintained boundary.

## Rust-first architecture

Rust owns export requests, inclusive range validation and filtering, settings normalization, connector descriptors, legal export-state transitions, archive path validation, ZIP creation, AES-256 handling, and archive verification. It is compiled to optimized WebAssembly and loaded synchronously from the packaged extension. TypeScript is limited to Firefox APIs, DOM extraction, UI rendering, and byte transport across the WebExtension boundary.

This boundary is deliberate: invalid domain transitions are rejected by the Rust core, while source-specific browser behavior remains in the platform adapter that can actually observe it.

## Archive contents

Depending on the chosen format and available attachments:

```text
messages.html
result.json
export-summary.json
css/style.css
js/script.js
photos/
video_files/
voice_messages/
stickers/
files/
```

`export-summary.json` records the requested range, saved message count, attachment omissions, terminal outcome, and (for date exports) whether the oldest requested calendar target was reached. `result.json` carries the same receipt in machine-readable form. If Telegram reaches its oldest reachable edge before a requested date, the receipt says so explicitly; “all history” is not an account-wide Telegram backup.

## Support and security

Use the [public issue tracker](https://github.com/Stranmor/local-archive-firefox/issues)
for product questions and reproducible bugs, and use
[private GitHub Security Advisories](https://github.com/Stranmor/local-archive-firefox/security/advisories/new)
for vulnerability reports. Never attach conversation exports, tokens, cookies,
browser profiles, or credentials to a public issue.

The release gate is maintained in [`docs/launch-checklist.md`](docs/launch-checklist.md).

## Verification

```bash
npm run typecheck
npm test
npm run check
npm run check:consumer
```

The consumer test installs the packaged extension into a disposable headless Firefox profile, invokes the real toolbar action, exercises recent and inclusive-date exports, and inspects the downloaded ZIP. It never uses the operator’s Firefox profile, display, focus, input, or clipboard.

## Architecture and attribution

The current flow is documented in `docs/architecture.d2` and rendered in `docs/architecture.svg`. The Telegram connector is derived from the MIT-licensed **Telegram Web Chat Exporter** userscript by Sisyphus; see `NOTICE.md`.

Local Archive is independent and is not affiliated with Telegram, Mozilla, or their owners. The project is MIT licensed; see `LICENSE`.
