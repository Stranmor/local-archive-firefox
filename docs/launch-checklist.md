# Local Archive launch gate

This is the canonical release gate for a public Firefox launch. It describes
what must be true before an AMO submission; it does not grant permission to
publish or contain any credentials.

## Product claim

- [ ] The public claim says **local export of the open Telegram conversation**,
      not an account-wide backup.
- [ ] The Telegram connector documents its page-manager/rendered-fallback
      boundary and the exact coverage receipt.

## Trust and support

- [ ] `PRIVACY.md`, `SECURITY.md`, the AMO listing, and the README describe the
      same connectors, permissions, local processing, and limits.
- [ ] The canonical public repository has a product issue tracker and private
      GitHub Security Advisory intake enabled.
- [ ] The listing links to the real privacy and support surfaces; no invented
      email, URL, testimonial, or production claim is used.
- [ ] MIT attribution in `NOTICE.md` is included in the source handoff.

## Build and package

- [ ] CI uses Node.js 24.19.0, npm 11.17.0, Rust 1.97.1, and wasm-pack 0.15.0.
- [ ] `npm run check` passes in a clean environment.
- [ ] `npm run check:consumer` passes in isolated Firefox at the minimum
      supported version and current stable.
- [ ] `npm run package:release` creates the current unsigned Firefox ZIP, the
      matching source ZIP, `SHA256SUMS.txt`, and `RELEASE-MANIFEST.json`.
- [ ] The source archive and Firefox ZIP come from the same build and version.
- [ ] From the project root, `sha256sum -c artifacts/SHA256SUMS.txt` passes.
- [ ] The AMO-signed XPI is produced by the AMO route; development XPI files
      are never reused as release artifacts.

## Compatibility and user proof

- [ ] Closed beta covers Telegram Web `k`/`a`, personal chats, groups, channels,
      long history, date ranges, media, cancellation, and reload recovery.
- [ ] No silent message loss is observed; incomplete coverage is visible in the
      receipt and export summary.
- [ ] At least 20 external beta users complete at least 50 real exports, with
      all failures mapped to a documented recovery path.

## External boundary

The final AMO upload, listing publication, and any public repository push are
external mutations. They require the exact destination, owner, and publication
authority. Everything before that boundary is reproducible locally and should
be completed by the release owner.
