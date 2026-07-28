# Nimbus Web Clipper

[![CI](https://github.com/nimbus-agent/nimbus-web-clipper/actions/workflows/ci.yml/badge.svg)](https://github.com/nimbus-agent/nimbus-web-clipper/actions/workflows/ci.yml)
[![CodeQL](https://github.com/nimbus-agent/nimbus-web-clipper/actions/workflows/codeql.yml/badge.svg)](https://github.com/nimbus-agent/nimbus-web-clipper/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Save what you read into your private, local-first [Nimbus](https://github.com/nimbus-agent/Nimbus)
index — straight from the browser. A Chrome + Firefox (MV3) extension that clips
the readable article or your current selection into Nimbus, where it becomes
searchable alongside your Drive files, email, and bookmarks.

- **Clip an article** — extract the readable content of the current page and send
  it to your local index.
- **Clip a selection** — highlight text and clip just that.
- **Related items** — an on-demand panel surfaces related things already in your
  index, without leaving the tab.

Everything stays on your machine: the extension talks **only** to a Nimbus
gateway running on `127.0.0.1`. There are no remote servers, no telemetry, and
no cloud calls.

> **Status:** dev-loadable in both Chrome and Firefox. Pairing, article/selection
> capture, and clip ingest (`POST /v1/clips`), the related-items panel
> (`POST /v1/clips/related`), the offline retry queue, connection management
> (pairing status + unpair), quick-clip entry points (right-click context menu +
> `Alt+Shift+C` / `Alt+Shift+S`, confirmed by an in-page toast), and terminal-413 /
> rate-limited-429 handling are all implemented. Store listing assets and
> tag-driven publishing to the Chrome Web Store and Firefox AMO are in place (see
> [`store/`](./store/)): the store accounts, first submissions, and all seven
> repository secrets are configured, so the next `vX.Y.Z` tag uploads to both
> stores automatically ([store/publishing.md](./store/publishing.md)). See the
> [changelog](./CHANGELOG.md) for the per-slice breakdown.

## How it works

```text
┌──────────────────────────┐        HTTP (bearer)        ┌────────────────────────────┐
│  Browser extension (MV3)  │  ───────────────────────►  │  Nimbus gateway (127.0.0.1) │
│  popup · options · SW     │                            │  POST /v1/clips             │
│                           │  ◄───────────────────────  │  POST /v1/clips/pair/confirm│
│                           │            JSON            │  POST /v1/clips/related     │
└──────────────────────────┘                            └────────────────────────────┘
```

Pairing is owner-consented: you run `nimbus clip pair` on the machine running the
gateway, it prints a one-time 6-digit code, and you enter that code in the
extension's options page to mint a long-lived bearer token. The token is the only
secret the extension holds; it lives in the browser's extension storage and is
revocable from the gateway with `nimbus clip revoke`.

## Requires

A running Nimbus gateway with the web-clipper surface (shipped in the Nimbus
monorepo). See <https://nimbus-agent.dev/user-guide/install/>.

## Install (developer / sideload)

The extension is dev-loadable today; tag-driven store publishing is wired up (see
[Releasing](#releasing)) and its one-time
[store bootstrap](./store/publishing.md) — accounts, first submissions, and the
seven repository secrets — is done, so the next tag uploads to both stores.

```bash
bun install
bun run build      # → dist/chrome and dist/firefox
```

- **Chrome:** `chrome://extensions` → enable Developer mode → **Load unpacked** →
  pick `dist/chrome`.
- **Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary
  Add-on** → pick `dist/firefox/manifest.json`.

## Releasing

Releases are tag-driven. Push a semver tag and CI does the rest:

```bash
git tag v0.1.0
git push origin v0.1.0
```

`publish.yml` stamps the tag version into the manifest, builds and packages a zip
per browser target, and attaches them to a GitHub Release. Once store credentials
are configured it also uploads to the Chrome Web Store and Firefox AMO and submits
each for review. See [store/publishing.md](./store/publishing.md) for the one-time
store bootstrap (accounts, first manual submission, and the repository secrets the
automated upload needs).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The HTTP wire contract is owned by the
Nimbus gateway repository; this repo builds against that stable surface.

## See also

- [Roadmap](./ROADMAP.md) — where this extension is going and why it wins
- [Architecture](./docs/architecture.md) — how it's built today
- [Documentation](./docs/) — design specs and architecture reference
- [Store assets](./store/) — listing copy, privacy policy, screenshots, and the
  [publishing guide](./store/publishing.md)
- [Changelog](./CHANGELOG.md) — notable changes per release
- [Nimbus](https://github.com/nimbus-agent/Nimbus) — the gateway this extension talks to
- [nimbus-vscode](https://github.com/nimbus-agent/nimbus-vscode) — the sibling editor client

## License

[MIT](./LICENSE)
