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
- Quick clip — clip the page or a selection without opening the popup: right-click → "Clip page / Clip selection to Nimbus", or press Alt+Shift+C / Alt+Shift+S. A small in-page toast confirms the result.
- Related items — an on-demand panel of related items already in your index.
- Offline retry queue — clips made while the gateway is down are saved and retried automatically.

Requires a running Nimbus gateway with the web-clipper surface. See https://nimbus-agent.dev/user-guide/install/.

## URLs

- Homepage: https://nimbus-agent.dev/user-guide/web-clipper/
- Support: https://github.com/nimbus-agent/nimbus-web-clipper/issues
- Privacy policy: https://nimbus-agent.dev/user-guide/web-clipper-privacy/

## Permission justifications

- `activeTab`: Read the current tab's content only in response to a user action on that tab — clicking Clip in the popup, choosing a "Clip to Nimbus" right-click menu item, or pressing one of the extension's keyboard shortcuts — so the page can be captured without broad host access.
- `scripting`: Inject the extension's own scripts into that tab on that user action: the page-capture script, the related-items panel, and the small confirmation toast shown after a right-click/shortcut clip.
- `storage`: Persist the paired gateway origin and bearer token, and the offline clip-retry queue, in local extension storage.
- `alarms`: Wake the background worker to drain the offline retry queue while it is non-empty.
- `contextMenus`: Add right-click "Clip page / Clip selection to Nimbus" menu entries so a page can be clipped without opening the popup.
- `host_permissions`: Talk to the local Nimbus gateway on http://127.0.0.1 and http://localhost only — the extension never contacts any other origin.
- `optional_host_permissions`: **Nothing is granted at install.** These are optional, per-site permissions the user grants one origin at a time from the Options page, and can revoke there. They let the extension recognise which page you are on (for example, "this is a pull request in repo X") without you having to open the panel first. The pattern is broad because self-hosted Bitbucket, Jenkins and Jira instances live on company hostnames that cannot be known in advance — there is no fixed list to declare. Chrome displays this as "Read your data on all websites"; it is listed as optional, and until a user explicitly grants a specific site the extension has access to none of them. Granting a site never changes where data can be sent: the only network destination remains the local gateway on 127.0.0.1 / localhost.
