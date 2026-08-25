# Security policy

## Supported version

Security fixes are applied to the latest released Local Archive version.

## Reporting a vulnerability

Report vulnerabilities through the repository's [private GitHub Security Advisory](https://github.com/Stranmor/local-archive-firefox/security/advisories/new). Do not disclose an unpatched vulnerability in a public issue.

Include the affected version, Firefox version, reproduction steps, expected impact, and the smallest non-sensitive evidence needed to verify the report.

Never attach:

- real Telegram conversation exports;
- session cookies, tokens, or browser profiles;
- private conversations or identifying screenshots;
- credentials or personal media.

Use synthetic fixture data instead. If private reporting is unavailable, open a public issue containing no exploit details or private data and ask for a secure contact route.

## Security model

Local Archive requests optional access only to the exact Telegram Web origin supported by version 3.0, uses no registered always-running content script, stores only local defaults, and bundles its executable dependencies. The Telegram connector is injected from the user-initiated export workflow and reads only the supported source tab or its inactive same-session helper. Telegram's static page bridge is exposed only to `web.telegram.org`, uses a versioned `postMessage` contract, delegates history and attachment downloads to Telegram Web's own authenticated managers, bounds media chunks, and never extracts tokens or cookies. ZIP generation is owned by a typed Rust/WebAssembly core in the extension background context, so page-realm objects never enter the archive engine.

The message boundary validates extension identity, originating tab and connector, request shape, entry count, archive paths, content types, and compression level before producing a file. Release checks fail if permission, executable-code, Rust-engine, or exposure boundaries change without explicit review.
