# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases are tag-driven (`vX.Y.Z`); see [README](./README.md#releasing) and `publish.yml`.

## [Unreleased]

### Added

- **Quick-clip entry points.** Clip the current page or selection without opening
  the popup — via a right-click context menu ("Clip page / selection to Nimbus")
  or the `Alt+Shift+C` / `Alt+Shift+S` shortcuts (rebindable). The result is
  confirmed by an in-page toast (saved / offline-queued / error, worded exactly
  like the popup's status line), with a toolbar-badge flash on pages a script
  can't be injected into. A right-click always clips the tab that was clicked,
  even when it isn't the focused window's active tab. Adds the `contextMenus`
  permission; loopback-only and the locked clip contract are unchanged.

### Fixed

- **Oversized clips no longer retry forever.** The gateway rejects clip bodies
  over its size cap with `413 payload_too_large`; this was previously mapped to
  the generic `server_error` and treated as a transient/offline failure, so the
  clip was queued and silently retried on every flush — a retry that can never
  succeed. It's now a distinct, terminal `payload_too_large` reason: the popup
  and quick-clip toast report "Too large for Nimbus to save.", the item is not
  queued, and any already-queued entry that hits this on its next attempt stops
  auto-retrying (manual retry from the queue is still available).
- **The offline queue could stop draining for frequent clippers.** The flush alarm
  was re-created on every queue change, and `chrome.alarms.create` replaces a
  same-named alarm and restarts its countdown — so clipping more often than once a
  minute pushed the next flush out indefinitely and queued clips drained only when
  the service worker restarted. The alarm is now created once and left alone.
- **Clips are no longer lost or hammered when the gateway rate-limits.** The
  gateway caps `POST /v1/clips` at 20/min and answers `429` with a `Retry-After`;
  this was previously mapped to the generic `server_error`, so the popup reported a
  server failure and the offline queue re-POSTed every entry on the next tick. A
  `429` is now a distinct `rate_limited` reason: the clip is queued (it is
  transient, not terminal), the popup and quick-clip toast both say "Nimbus is busy
  — queued, will retry shortly.", the flush stops the round on the first `429`
  instead of draining into a closed window, and the next flush is paced off the
  gateway's `Retry-After` rather than the fixed one-minute alarm. A successful clip
  clears the pause early.

## [0.1.0] - 2026-07-19

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
- **Slice 2 — related-items sidecar.** An on-demand Shadow-DOM panel (opened from a
  "Show related" popup button or the `Alt+Shift+R` hotkey) that queries
  `POST /v1/clips/related` and lists related indexed items for the current page
  (title, service badge, snippet, link). Query-once-on-open; toggle / X / Esc to
  close. Renders via `textContent` only (DOM-XSS backstop); honors
  `prefers-color-scheme`. No new permissions.
- **Slice 3 — offline retry queue.** Clips that fail because the gateway is
  unreachable (or errors) are saved to a local queue and retried automatically — a
  `chrome.alarms` flush (live only while the queue is non-empty) plus drains on
  service-worker startup and on demand. A toolbar **badge** shows the pending count
  and the popup gains a **queue manager** (per-item Retry/Remove + Retry all). The
  bearer token is never stored in the queue (re-read at flush time); queue writes are
  serialized to prevent lost updates; the manager renders `textContent`-only and no
  links. Adds only the `alarms` permission; still loopback-only.
- **Connection management (Options).** The Options page now shows the current
  pairing — *"Paired as "<label>" to <origin>, since <date>."* — and adds an
  **Unpair** button (inline two-step confirm) that clears the stored connection. The
  state is fetched from the service worker as a **token-free** projection (the bearer
  token never enters the Options page). Unpair is local-only (the gateway contract has
  no revoke endpoint); queued offline clips survive an unpair and drain after
  re-pairing. No new permission.
- **Extension icons.** Real 16/48/128px toolbar and store icons (a Nimbus cloud
  with a clip/bookmark tag on a brand-blue tile), replacing the placeholder
  squares. Generated reproducibly by `scripts/gen-icons.py` (Python stdlib only,
  not part of the extension build).
- **Automated store publishing.** On a `vX.Y.Z` tag, `publish.yml` now uploads the
  built extension to the Chrome Web Store and Firefox AMO and submits each for
  review, in addition to attaching the zips to the GitHub Release. Firefox
  submissions include a `git archive` source bundle for AMO's source-code policy.
  Store steps run only when the store credentials are configured (see
  `store/publishing.md`); until then a tag still cuts a GitHub Release. The store
  CLIs (`chrome-webstore-upload-cli`, `web-ext`) are pinned devDependencies.

### Security

- **Loopback-only** network surface (`127.0.0.1` / `localhost`); origin
  validation uses the URL parser and rejects lookalike hosts such as
  `127.0.0.1.attacker.com`. HTTPS is excluded by design.
- The **bearer token is the only secret** — confined to the service worker and
  extension storage; never logged, never placed in the page or popup/options
  DOM, and never returned to the UI. The pairing code is likewise never logged.

[Unreleased]: https://github.com/nimbus-agent/nimbus-web-clipper/compare/main...HEAD
