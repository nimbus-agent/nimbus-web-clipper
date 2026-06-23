# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases are tag-driven (`vX.Y.Z`); see [README](./README.md#releasing) and `publish.yml`.

## [Unreleased]

### Added

- **Slice 1 — the end-to-end clip core.**
  - **Pairing:** the Options page redeems a 6-digit gateway code
    (`POST /v1/clips/pair/confirm`) to mint a long-lived bearer token, stored in
    `chrome.storage.local` and held by the background service worker.
  - **Capture:** readable-article extraction (Mozilla Readability, bundled) or
    the current selection, with a meta-description/URL bookmark fallback when no
    article is found.
  - **Clip ingest:** the toolbar popup clips the page or selection via
    `POST /v1/clips` with `Authorization: Bearer`, with per-reason status and
    error messaging.
- Thin typed `chrome.*` seam (`src/browser/`) that keeps pair/clip
  orchestration, payload building, tag parsing, origin validation, and status
  mapping pure and unit-tested.
- `docs/development.md` — dev-load steps and a manual verification checklist for
  the surfaces that are not unit-tested (capture-in-page, popup/options DOM,
  service-worker glue).

### Security

- **Loopback-only** network surface (`127.0.0.1` / `localhost`); origin
  validation uses the URL parser and rejects lookalike hosts such as
  `127.0.0.1.attacker.com`. HTTPS is excluded by design.
- The **bearer token is the only secret** — confined to the service worker and
  extension storage; never logged, never placed in the page or popup/options
  DOM, and never returned to the UI. The pairing code is likewise never logged.

[Unreleased]: https://github.com/nimbus-agent/nimbus-web-clipper/compare/main...HEAD
