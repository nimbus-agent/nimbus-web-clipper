# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases are tag-driven (`vX.Y.Z`); see [README](./README.md#releasing) and `publish.yml`.

## [Unreleased]

### Fixed

- **The panel's freshness line said "Indexed" when it meant "Updated".** The time
  shown is the item's own last-modified time as its source reports it — GitHub's
  `updated_at` for a pull request — not when Nimbus indexed it. So a PR fetched
  seconds ago could read "Indexed 3 days ago", which was simply untrue. The line
  now reads "Updated 3 days ago". The value is unchanged and is the more useful
  one: how stale the underlying item is, rather than when a row was written.

### Added

- **Ask an agent about the pull request you are looking at.** On a PR the panel
  has resolved to a single indexed item, it now offers two lanes — *what breaks if
  it lands*, and *who should review it*. Expanding one runs the agent behind it;
  nothing runs until you ask. Answers survive closing the panel: reopening it and
  expanding the lane shows the same brief again without running the agent a second
  time. If a lane can't answer it says why, and offers a re-run only where one
  could actually succeed. On a page that matches several indexed items the lanes
  are not offered, even after you pick one — the run would resolve the page again
  and hit the same ambiguity, so a lane there could only ever fail.
- **On a resolve miss, fetch that one item.** On a page Nimbus recognises but has
  not yet indexed, the panel now offers to fetch that item through the connector
  that owns it — a GitHub PR, a Jira issue, a Jenkins build. Nothing is fetched
  until you ask: the button names exactly what it will fetch and from where (e.g.
  *"Fetch this from GitHub"*), and only ever fires once per panel. An unconfigured
  connector says so plainly instead of inviting a retry that can't work, and if the
  gateway is just slow to answer, the panel says it's still working rather than
  reporting a failure.
- **The panel knows what page you're on.** On a Bitbucket, GitHub or GitLab pull
  request, a Jenkins build or a Jira issue, the related-items panel now leads with
  what the page is — *"GitHub PR · acme/web #482"* — and, where the gateway
  supports it, the exact indexed item it resolves to. Resolution is at most one
  item: on a miss the panel says "Not indexed" rather than passing loose search
  hits off as the page. Related items move into a collapsible lane below the
  header, which is where the planned agent lanes will join them. The panel is
  still opened by you (`Alt+Shift+R` or the popup button) — nothing appears on its
  own, and the Related lane keeps working in every header state.
- **Self-hosted instances are configurable.** Bitbucket Cloud, GitHub, GitLab and
  Jira Cloud are recognised with no setup. Self-hosted Bitbucket, Jenkins and Jira
  are added under **Recognised surfaces** in Options as a URL plus which product it
  is — including instances behind a reverse proxy on a sub-path, e.g.
  `https://corp.example/jira`, and several products on one host. The product is
  never guessed from the URL shape, so the panel cannot be confidently wrong about
  where you are.
- **Opt-in page access, per host.** Options can grant Nimbus permission to
  recognise pages on a site without you opening the panel first, and revoke it
  again. Nothing is granted at install. This is page access only — it does not
  change where Nimbus can send data, which remains your local gateway on
  `127.0.0.1` and nothing else.

### Changed

- The panel now resolves pages against the gateway's shipped
  `GET /v1/items/resolve` route instead of the guessed shape Phase C1 was built
  against. It shows when the item was last updated, marks a closest-match result
  as weaker than an exact one, and lets you pick when several indexed items match
  the page. The not-paired, pairing-rejected and can't-reach-Nimbus messages for
  resolve are reworded to match the new contract, and a malformed resolve
  response now says "Couldn't read Nimbus's answer." instead of a generic error.
- **Scope guidance is a command you can paste, and one that's safe to run.**
  When a pairing predates a scope the panel needs (`resolve`, and now `fetch`),
  the fix-it text names your actual device and the exact resulting set, built
  from the gateway's own 403 response — not a guessed list. That matters
  because `nimbus clip scopes … --set` *replaces* the device's scope set
  rather than adding to it, so a guessed list could silently drop a scope you
  already held (e.g. `agents`).

## [0.2.0] - 2026-07-28

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
  the service worker restarted. The alarm is now created once and left alone,
  except when it is deliberately re-paced for a rate-limit pause.
- **Clips are no longer hammered when the gateway rate-limits.** The
  gateway caps `POST /v1/clips` at 20/min and answers `429` with a `Retry-After`;
  this was previously mapped to the generic `server_error`, so the popup reported a
  server failure and the offline queue re-POSTed every entry on the next tick. A
  `429` is now a distinct `rate_limited` reason: the clip is queued (it is
  transient, not terminal), the popup and quick-clip toast both say "Nimbus is busy
  — queued, will retry shortly.", the flush stops the round on the first `429`
  instead of draining into a closed window, and the next flush is paced off the
  gateway's `Retry-After` rather than the fixed one-minute alarm. A successful clip
  clears the pause early.
- **Duplicate "Clip to Nimbus" context-menu entries after an extension reload.**
  `removeAllMenus()` awaited `chrome.contextMenus.removeAll()`, which is not
  thenable per the pinned `@types/chrome`, so teardown resolved before the removal
  actually completed and a following create could race it into duplicate menu ids.
  The removal is now promisified via its callback (which also works on Firefox
  MV3). (#19)

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

[Unreleased]: https://github.com/nimbus-agent/nimbus-web-clipper/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/nimbus-agent/nimbus-web-clipper/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nimbus-agent/nimbus-web-clipper/releases/tag/v0.1.0
