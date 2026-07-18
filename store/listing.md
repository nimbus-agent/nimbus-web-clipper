# Store Listing Copy — Nimbus Web Clipper

Single source of truth for the Chrome Web Store and AMO listing fields. Paste
these verbatim into each dashboard; keep this file in sync with any dashboard edit.

## Name

Nimbus Web Clipper

## Short summary

Clip articles and selections into your private, local-first Nimbus index. Loopback-only, no telemetry, no cloud.

<!-- ≤132 chars (Chrome Web Store) — the line above is within budget; AMO summary reuses it (≤250). -->

## Category

Productivity

## Single purpose (Chrome Web Store)

Clip the readable article or the current selection from the active tab into the
user's local-first Nimbus index running on 127.0.0.1, and show related indexed
items on demand.

## Full description

Save what you read into your private, local-first Nimbus index — straight from
the browser.

Nimbus Web Clipper clips the readable article or your current text selection into
Nimbus, where it becomes searchable alongside your Drive files, email, and
bookmarks. An on-demand panel surfaces related things already in your index,
without leaving the tab.

Everything stays on your machine. The extension talks only to a Nimbus gateway
running on 127.0.0.1 — there are no remote servers, no telemetry, and no cloud
calls. Pairing is owner-consented: you run `nimbus clip pair` on the machine
running the gateway, it prints a one-time 6-digit code, and you enter that code
in the extension's options page to mint a long-lived bearer token. The token is
the only secret the extension holds; it lives in the browser's extension storage
and is revocable from the gateway with `nimbus clip revoke`.

Features:
- Clip an article — extract the readable content of the current page.
- Clip a selection — highlight text and clip just that, with optional tags.
- Related items — an on-demand panel of related items already in your index.
- Offline retry queue — clips made while the gateway is down are saved and retried automatically.

Requires a running Nimbus gateway with the web-clipper surface. See https://nimbus-agent.dev/install.

## URLs

- Homepage: https://nimbus-agent.dev/web-clipper
- Support: https://github.com/nimbus-agent/nimbus-web-clipper/issues
- Privacy policy: https://nimbus-agent.dev/web-clipper/privacy

## Permission justifications

- `activeTab`: Read the current tab's content only when the user clicks Clip or opens the related panel, so the page can be captured without broad host access.
- `scripting`: Inject the capture and related-panel scripts into the active tab on that user action.
- `storage`: Persist the paired gateway origin and bearer token, and the offline clip-retry queue, in local extension storage.
- `alarms`: Wake the background worker to drain the offline retry queue while it is non-empty.
- `host_permissions`: Talk to the local Nimbus gateway on http://127.0.0.1 and http://localhost only — the extension never contacts any other origin.
