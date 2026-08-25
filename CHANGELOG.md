# Changelog

All notable changes to Local Archive are documented here. Earlier entries retain the former internal name where it describes the historical implementation.

## [3.0.0] - 2026-08-23

- Telegram history exports now use Telegram Web's already-authorized
  `appMessagesManager.requestHistory` through a versioned static page bridge,
  with one-request-per-second throttling, direct cursor pagination, inclusive
  date upper bounds, and a rendered fallback when the private manager is not
  available; the receipt records `history_source=telegram-web-api` and exact
  completion state.
- Telegram native exports now resolve document/photo bytes through Telegram
  Web's own download manager, using bounded local chunks and the same per-item
  limits as the rendered connector; media failures remain explicit omissions
  instead of silently dropping the message.
- Firefox consumer proof now verifies recent, date-range, and entire-chat
  exports with zero visible scroll attempts and the exact native history source.

- Release documentation now describes the Telegram Web scope, automatic
  inactive-tab history traversal, rendered-source coverage limits, and the
  exact support/security intake required before an AMO listing.
- Added the canonical `docs/launch-checklist.md` release gate and a generated
  `RELEASE-MANIFEST.json` receipt for matching Firefox/source artifacts.
- Terminal background-export receipts cancel throttled stale progress packets
  and the background owner ignores late non-terminal updates, preventing a
  finished export from reopening as active after a source reload.
- Background exports now wait for the connector to report a readable
  conversation after SPA hydration; navigation completion alone no longer
  starts collection and produces a false live-layout failure.

- Release evidence binds each headless consumer proof to the exact package
  SHA-256, while the save boundary re-hashes the ZIP before Firefox downloads it.
- CI now selects the release ZIP only through `RELEASE-MANIFEST.json` and
  rejects consumer proofs whose filename or hash diverges.
- Archive verification requires the exact set of ZIP media paths referenced by
  the JSON/HTML outputs, rejecting unreferenced or missing attachment files.
- Telegram attachment limits are explicit: photos 10 MB and other files 100 MB
  per item.

## [3.0.0-rc.1] - 2026-08-16

### Added

- A Rust 2024 domain and archive core compiled to optimized WebAssembly.
- Typed export-range, request, settings, connector, archive, verification, and export-lifecycle boundaries.
- Native Rust coverage for inclusive dates, repaired preferences, connector origins, legal state transitions, unencrypted ZIPs, AES-256 ZIPs, and Firefox duplicate download names.
- Consumer proof that the running Firefox connector reports the exact `rust-wasm` core version used by the package.

### Changed

- Moved range filtering, preference normalization, connector validation, state progression, ZIP generation, encryption, and verification out of TypeScript and into Rust.
- Reduced TypeScript to Firefox APIs, DOM extraction, UI rendering, and byte transport.
- Pinned the production toolchain to Rust 1.97.1, Node.js 24.19.0, npm 11.17.0, WXT 0.21.4, and `wasm-pack` 0.15.0.
- Embedded the optimized WebAssembly synchronously so Firefox MV3 entrypoints require no remote code, top-level `await`, or visible bootstrap page.
- Removed the redundant local-processing note from the primary popup and shortened attachment limits to decision-relevant text.

## [2.0.0] - 2026-08-16

### Added

- A compact Firefox toolbar popup for the current Telegram conversation.
- Three real range modes: a maximum number of recent messages, inclusive dates, or all history Telegram exposes.
- Eight interface languages: English, Russian, Ukrainian, German, French, Spanish, Brazilian Portuguese and Polish.
- Shared saved defaults for format, attachment inclusion, recent-message count and language.
- A source-connector registry that keeps Telegram-specific extraction separate from the reusable archive request and ZIP service.
- A compact in-tab progress panel with cancellation, terminal message count, skipped-attachment count and **Show file**.
- An isolated Firefox E2E that invokes the real browser action, exports recent and date-range fixtures, reopens both ZIPs and captures exact English/Russian states.

### Changed

- Repositioned the product as **Local Archive**, with Telegram as the first connector rather than the product boundary.
- Replaced the large in-page configuration dialog with a familiar 390 px browser-extension popup.
- Reduced the ordinary flow to conversation, range, format, attachments and one **Export ZIP** action.
- Made older-message loading automatic for every range mode and explained the boundary in the popup.
- Fixed quick-export attachment limits at 10 MB for photos and 100 MB for other files; skipped items are reported instead of silently disappearing.
- Exported spoiler text is readable immediately in the saved HTML rather than hidden behind another interaction.
- Kept the connector boundary explicit so additional sources are added only
  after their own consumer-proven adapter and release contract exist.

### Fixed

- Moved ZIP generation to the extension background, removing the Firefox page-realm failure `Permission denied to access property "flush"`.
- Prevented repeated quick exports from inheriting messages or media from a previous run.
- Made the selected inclusive date range explicit in human-readable localized text.

### Security

- Conversation access begins from an explicit toolbar action.
- The manifest contains no required persistent host permission or registered content script.
- Conversation content is not stored in extension settings, uploaded for processing, or used for telemetry.

## [1.1.0] - 2026-08-11

### Fixed

- Moved ZIP generation out of Firefox's page-isolated content realm, fixing the real export failure `Permission denied to access property "flush"`.
- Replaced raw implementation exceptions with stable, actionable error states that preserve retry and never expose private content.
- Kept the action footer and terminal result visible at constrained desktop and mobile viewport sizes.
- Cleared collection state before every current-chat run so repeated exports cannot inherit messages or media from a previous archive.
- Current-chat collection now traverses toward newer messages before continuing through older history, preventing a virtualized chat opened in the middle from silently omitting its newer rendered page.

### Added

- Typed content-to-background archive protocol with sender validation, safe-path validation, and explicit failure codes.
- Text-only, balanced, and all-media presets with a conservative balanced default for new users.
- Saved-file receipts showing the exact filename and archive size, isolated **Show downloaded ZIP** and **Verify downloaded ZIP** actions, and a direct repeat-export path.
- A typed local downloaded-ZIP verifier that requires the completed receipt's filename, checks safe/unique paths and consistent encryption, parses `export-summary.json` plus every saved `messages.html`/`result.json`, reconciles chat/message counts, rejects foreign or inconsistent archives, and returns only a bounded verification report.
- Recoverable AES verification UX with an explicit forgotten-password warning, wrong-password feedback, correct-password proof, and immediate field clearing after every attempt.
- An always-visible pre-export completeness warning with oldest-loaded timestamp and initial visible-message count, a required history-readiness acknowledgement, a live collection counter, a stronger saved-file warning, and concise extraction guidance.
- Local AES-256 password protection enabled by default for new and reset configurations, with non-persistent secret handling, WinZip AES compatibility guidance, and a twice-confirmed unencrypted opt-out.
- OS-specific AES opening recommendations for Windows, macOS, and Linux, with direct links to the official PeaZip and 7-Zip publisher sites.
- A plain two-card protection decision: **Recommended: password-protected ZIP** versus **Easiest to open: unencrypted ZIP**, while preserving AES-by-default and the second confirmation for readable archives.
- A single compact three-step pre-export review beside the export action, combining automatic history coverage, the light/moderate/heavy workload estimate, and the encrypted-ZIP opening/verification path.
- A user-controlled history-loading mode that clears the dialog out of Telegram's way, preserves the configured export, refreshes the oldest-loaded date and visible count on return, and invalidates stale acknowledgement.
- Named post-download receipts for exact-file, folder-fallback, and Firefox-Downloads fallback outcomes.
- Export reports in both the receipt and `export-summary.json`, covering scope, covered date range, chats, messages, included media, item-level omissions, reasons, pending work, encryption state, and partial status.
- Headless Firefox consumer test that installs the packaged extension in a disposable profile, invokes the real browser action, and independently verifies the history acknowledgement, current-chat, two-selected-chat, category, media-limit, stopped-partial, AES-256 encrypted ZIP, exact downloaded-file reveal, and local downloaded-ZIP verification paths.
- Desktop and mobile product evidence generated by the real Firefox test path.
- Maintained selector-variation contracts, a complete independently reopened 1,000-message archive test, and a published compatibility/support matrix.
- A fail-closed rendered-message compatibility diagnostic, plus full isolated consumer runs on Firefox 142.0.1, 148.0.2, and 153.0.1.
- Bidirectional virtualized-history coverage across `.im_message_wrap`, `[data-scope="bubble"]`, and `.message-list-item` in the exact Firefox consumer path.
- A media-heavy exact-consumer scenario containing 16 independently fetched 2 MiB files, a 32.1 MiB downloaded ZIP, and local reopen verification.
- A network-dependent, account-free live-origin smoke test for the current Telegram Web K shell, plus scheduled CI execution twice a week and typed evidence that injection succeeds and missing chat content fails closed.
- A per-tab live Telegram layout gate that inspects the actual open chat for readable message identifiers and content before collection, fails closed on unsupported surfaces, rechecks immediately before a current-chat run, and repeats after every selected or category chat is activated.
- An optional private nearby-history ZIP test that takes up to 10 real messages from the current and adjacent rendered pages through the production parser, selected HTML/JSON builders, background ZIP creation and validation, selected AES state, and the same local reopen verifier; it restores the starting position without saving a file or uploading content.
- A shorter first-run review: readiness and the main action remain visible while history, workload, and ZIP-opening detail stays behind one disclosure and opens automatically only for recovery or a requested walkthrough.
- An explicit long-run and multi-chat boundary immediately before collection, stating that the authorized tab is not a complete account backup and that every chat is checked and reported separately.
- A task-oriented **Next step** callout in the expanded review, an explicit shared per-item limit note for voice messages and stickers, and a completed-AES receipt card with opening steps plus official PeaZip/7-Zip links.

### Changed

- Opening TeleArchive on an authorized Telegram tab now launches the export dialog without a second popup action.
- The export surface now uses a fixed action footer, independently scrollable content, clearer scope/output/media summaries, responsive layout, improved focus semantics, dark mode, and reduced-motion handling.
- The required pre-export review is now a compact collapsed dock on desktop and mobile, expands automatically when action is needed, and keeps its required/checked state and adjacent inline error visible; terminal receipts expand on desktop and wrap long filenames, coverage, and omission details without horizontal truncation.
- The AES footer now remains a one-line operational reminder to save the password and keep an AES-capable ZIP application available.
- The compact review now states that only rendered messages can be exported, while the expanded protection step exposes OS-specific official AES application links and a direct first-use walkthrough.
- Manual history inspection is now the optional **Preview older history** action; export itself automatically scans both newer and older rendered pages and reports the exact saved range.
- The compact review now says **Messages available in this tab** instead of implementation-oriented terminology.
- A completed receipt with an oldest-date goal now keeps a prominent **Reached: yes/no/unknown** line and the per-chat ratio above the detailed report.
- Archive assembly now runs in an extension-owned local background context; chat content still never leaves the browser or enters extension storage.
- The dialog now states before export that only content rendered in the active Telegram Web tab can be collected.
- Protection choices now render as visually distinct authored cards—with the recommended AES route unmistakably selected—and the consumer suite asserts their desktop and mobile geometry so native-button regressions fail before release.
- The protection decision now states before password entry that Firefox itself does not extract TeleArchive's AES ZIP and directs the user to PeaZip/7-Zip or the deliberately unencrypted route.
- A failed or not-yet-ready live layout check now includes a direct **Check again** action so users do not have to infer the recovery step.
- The collapsed review repeats the unrecoverable-password consequence for AES-256, and a verified multi-chat receipt exposes **Continue to batch** with completed-batch progress until the selection is finished.
- The expanded review now leads with a plain-language save/missing/open summary. Selections over 50 chats expose **Run all planned batches**, queue the remaining ZIPs with an explicit per-batch AES-password note, and finish with one aggregate receipt.
- Defaults can no longer remain in an impossible no-format state: attempting to clear both HTML and JSON immediately restores a valid pair and explains the requirement.

### Security

- Retained a least-privilege permission set: `activeTab`, `scripting`, `storage`, and `downloads`, with no persistent host permission or registered content script. `downloads` is consumed only by the user-invoked completed-receipt action that reveals the just-created file or, as a fallback, the default download folder.
- Restricted the sole web-accessible asset to the bundled 48 px icon on Telegram Web.

## [1.0.0] - 2026-08-10

### Added

- Firefox Manifest V3 extension built with WXT, TypeScript, and native WebExtension APIs.
- Explicit toolbar-triggered exporter with `activeTab`, `scripting`, and `storage` only.
- Responsive localized popup, full-tab settings, and isolated Shadow DOM export interface.
- Current-chat, category, and selected-chat export flows.
- HTML and JSON archive formats with configurable media inclusion and size limits.
- Partial-archive recovery when a long export is stopped.
- English and Russian localization.
- Contract tests that inspect a real generated ZIP.
- Deterministic manifest, privacy-boundary, localization, package-size, and Mozilla lint checks.

### Security

- No persistent host permissions, content scripts, background worker, telemetry, or remote executable code.
- Hardened URL, filename, media-fetch, timeout, and archive-path handling inherited from and extended beyond the 3.6.0 userscript baseline.
