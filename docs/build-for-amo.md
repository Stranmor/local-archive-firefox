# Reproducible Firefox build and AMO handoff

This document describes how to reproduce and inspect the Telegram-only Firefox
package and prepare the reviewer handoff. It does not publish anything.

## Toolchain

- Node.js `24.19.0`
- npm `11.17.0`
- Rust `1.97.1` with target `wasm32-unknown-unknown`
- `wasm-pack 0.15.0`
- WXT `0.21.4`
- Firefox Manifest V3, minimum Firefox `142.0`

## Build from source

```bash
npm ci
npm run package:release
```

The command validates the project, builds the Telegram-only extension, runs
Mozilla lint, creates the Firefox ZIP and creates a deterministic source
archive. Local deliverables are copied to `artifacts/` with SHA-256 checksums
and a `RELEASE-MANIFEST.json` receipt binding version, sizes, hashes, and
source-file count.

The unpacked extension is written to:

```text
.output/firefox-mv3/
```

For AMO, upload only the newly generated Firefox package and its matching
source archive from the same run. The build also writes
`artifacts/AMO-SUBMISSION.json`, a typed unpublished handoff receipt. Do not
reuse an older package or a signed development XPI.

## Verification

```bash
npm run check
npm run check:consumer
```

`npm run check` performs Rust formatting/Clippy/tests, the optimized
WebAssembly build, TypeScript and Vitest checks, the production Firefox build,
manifest/package-size/locale/runtime assertions, and `web-ext lint`.

`npm run check:consumer` installs the exact packaged ZIP temporarily in a
disposable headless Firefox profile and verifies Telegram recent-message,
inclusive-date, HTML/JSON, attachment, progress, reload-recovery, and archive
readback paths. The fixture proves the packaged browser route and archive
contract; it does not prove access to every live Telegram conversation.

The consumer test uses loopback WebDriver and a disposable profile. It never
opens a visible window or touches the operator's Firefox profile, screen,
focus, input, or clipboard.

## Manual review path

1. Load `.output/firefox-mv3/manifest.json` as a temporary add-on.
2. Open Telegram Web and choose a conversation.
3. Click Local Archive in Firefox's toolbar or Extensions menu.
4. Choose recent messages, an inclusive date range, or all reachable history.
5. Choose HTML, JSON, or both; optionally include attachments.
6. Click **Export ZIP** and keep the Telegram tab open until completion.
7. Confirm the result reports the saved message count and actual coverage.

## Permission boundary

The package declares `activeTab`, `scripting`, `storage`, and `downloads`, plus
the exact optional host permission `https://web.telegram.org/*`. The normal
path reads the current Telegram tab only after the toolbar click. The
background entrypoint is a local ZIP service and performs no external content
upload. `storage` holds only UI defaults.

The canonical support route is
`https://github.com/Stranmor/local-archive-firefox/issues`; vulnerability reports
use the private GitHub Security Advisory route at
`https://github.com/Stranmor/local-archive-firefox/security/advisories/new`.

## Reproducible generated code and no remote runtime code

The source archive contains the Rust crate, lockfile, toolchain declaration,
TypeScript adapter, maintained exporter source, and deterministic WebAssembly
embedding script. Generated bindings and WebAssembly are rebuilt by
`npm run rust:build`; they are not source authority. The extension does not
download scripts, load remote executable code, include telemetry, or require an
extension-operated server.
