# Contributing to Local Archive

Thanks for helping improve private, dependable chat exports.

## Before changing code

- Use synthetic connector-specific fixtures; never commit real conversation data.
- Preserve the explicit-click access model. The existing background entrypoint is narrowly owned by local ZIP generation; new site access, persistent work, telemetry, remote code, or external processing requires a separate security and privacy decision.
- Keep platform-specific extraction inside `src/connectors/` or the corresponding injected adapter. Shared settings, archive generation, protocol messages, and human-facing copy must remain source-neutral unless a capability truly belongs to one connector.
- Keep every catalog in `src/shared/product-i18n.ts` complete; the `LocaleMessages` type must reject missing keys in any supported language.
- Keep the legacy snapshot immutable. Changes belong in the active engine and extension entrypoints.

## Local setup

Use the pinned Rust 1.97.1 toolchain, Node.js 24.19, npm 11.17, and `wasm-pack` 0.15:

```bash
npm ci
npm run dev
```

## Required verification

Before opening a pull request, run:

```bash
npm run check
npm run check:consumer
```

The first command validates Rust formatting, Clippy with denied warnings, Rust tests, WebAssembly generation, TypeScript boundaries, settings persistence, generated ZIPs, Firefox Manifest V3 invariants, localization parity, package size, absence of remote executable surfaces, and Mozilla add-on linting. The consumer check installs the packaged add-on in a disposable headless Firefox profile, invokes the browser action, proves the running Rust/WASM engine identity, and verifies the downloaded archive.

For changes that affect a connector's DOM parsing, archive generation, injection, or saving, add a minimal synthetic fixture and assert the exported consumer artifact, not only an internal helper result. Never automate a contributor's active Firefox profile.

## Pull requests

Explain:

1. the user-visible problem;
2. the causal change;
3. privacy or permission impact;
4. exact verification performed;
5. screenshots for material UI changes.

Do not include generated `.output/`, signed add-ons, secrets, or real personal data in commits.
