# Nimbus Web Clipper

[![CI](https://github.com/nimbus-agent/nimbus-web-clipper/actions/workflows/ci.yml/badge.svg)](https://github.com/nimbus-agent/nimbus-web-clipper/actions/workflows/ci.yml)
[![CodeQL](https://github.com/nimbus-agent/nimbus-web-clipper/actions/workflows/codeql.yml/badge.svg)](https://github.com/nimbus-agent/nimbus-web-clipper/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/kkfdgphcalcdbnpgknplfbflffalbcnk?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/nimbus-web-clipper/kkfdgphcalcdbnpgknplfbflffalbcnk)
[![Firefox Add-on](https://img.shields.io/amo/v/nimbus-web-clipper?label=Firefox%20Add-on&logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/firefox/addon/nimbus-web-clipper/)

Save what you read into your private, local-first [Nimbus](https://github.com/nimbus-agent/Nimbus)
index — straight from the browser. A Chrome + Firefox (MV3) extension that clips
the readable article or your current selection into Nimbus, where it becomes
searchable alongside your Drive files, email, and bookmarks.

- **Clip an article** — extract the readable content of the current page and send
  it to your local index.
- **Clip a selection** — highlight text and clip just that.
- **Related items** — an on-demand panel surfaces related things already in your
  index, without leaving the tab.
- **Know where you are** — the panel recognises a pull request, a build, an
  issue, an incident, a product dashboard or a **source file** (GitHub / GitLab /
  Bitbucket / Jenkins / Jira / Linear / Confluence / PagerDuty / CircleCI,
  self-hosted included) and names the indexed item behind the page you are on.
- **Run the agents from the page** — seven of the gateway's own agents answer
  about that item as panel lanes (impact, expert, why, catchup, decisions,
  ownership, glossary).
- **Ask about the file you are reading** — on a source file, *what breaks if this
  changes*, *who knows this file* and *who owns this*, answered against your own
  checkout. Needs a gateway that serves the file-resolve route.
- **Ask across your open tabs** — pick a set of tabs, ask one question, get a
  research brief with its sources named.
- **See what was done for you** — an Activity page reads the gateway's
  append-only egress ledger back, so nothing happens on your behalf unseen.

Everything stays on your machine: the extension talks **only** to a Nimbus
gateway running on `127.0.0.1`. There are no remote servers, no telemetry, and
no cloud calls.

> **Status:** available on the
> [Chrome Web Store](https://chromewebstore.google.com/detail/nimbus-web-clipper/kkfdgphcalcdbnpgknplfbflffalbcnk)
> and [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/nimbus-web-clipper/),
> and dev-loadable from source. Pairing, article/selection capture and clip ingest
> (`POST /v1/clips`), the related-items panel (`POST /v1/clips/related`), the
> offline retry queue, connection management (pairing status + unpair), quick-clip
> entry points (right-click context menu + `Alt+Shift+C` / `Alt+Shift+S`, confirmed
> by an in-page toast), and terminal-413 / rate-limited-429 handling are all
> implemented — as are the later phases: page recognition and per-origin page
> access (C1), the agent lanes (C2), targeted fetch and capture-as-last-resort
> (C3), the Activity page over the gateway's egress ledger (C4.1, partial —
> see the roadmap), research briefs over your open tabs and your index
> (C5), item lanes on an issue or an incident (C6), and the source-file lanes
> (C7 — these need a gateway carrying the file-resolve route; on an older one
> the page simply renders without them). Tagging `vX.Y.Z` builds, signs and submits to both stores
> ([store/publishing.md](./store/publishing.md)); each store's own review then
> gates the public rollout. See the
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

Those three are the clip path. The later phases added more loopback routes —
item resolve and targeted fetch, the agent runs, briefs and the egress-ledger
reads — each behind its own gateway token scope. `GATEWAY_PATHS` in
[`src/shared/gateway.ts`](./src/shared/gateway.ts) is the complete list.

Pairing is owner-consented: you run `nimbus clip pair` on the machine running the
gateway, it prints a one-time 6-digit code, and you enter that code in the
extension's options page to mint a long-lived bearer token. The token is the only
secret the extension holds; it lives in the browser's extension storage and is
revocable from the gateway with `nimbus clip revoke`.

## Requires

A running Nimbus gateway with the web-clipper surface (shipped in the Nimbus
monorepo). See <https://nimbus-agent.dev/user-guide/install/>.

## Install

**From the stores** (recommended):

- **Chrome / Edge / Brave** — [Chrome Web Store](https://chromewebstore.google.com/detail/nimbus-web-clipper/kkfdgphcalcdbnpgknplfbflffalbcnk)
- **Firefox** — [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/nimbus-web-clipper/)

The extension is a thin client — you also need a running
[Nimbus gateway](https://nimbus-agent.dev/user-guide/install/) with the web-clipper
surface. After installing, open the extension's **Options** page and pair it with your
local gateway (run `nimbus clip pair`, enter the 6-digit code). See the
[web clipper guide](https://nimbus-agent.dev/user-guide/web-clipper/) for the full flow.

### From source (developer / sideload)

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
- [Documentation](./docs/) — the architecture reference and the manual-verification checklist
- [Store assets](./store/) — listing copy, privacy policy, screenshots, and the
  [publishing guide](./store/publishing.md)
- [Changelog](./CHANGELOG.md) — notable changes per release
- [Nimbus](https://github.com/nimbus-agent/Nimbus) — the gateway this extension talks to
- [nimbus-vscode](https://github.com/nimbus-agent/nimbus-vscode) — the sibling editor client
- [Discussions](https://github.com/nimbus-agent/Nimbus/discussions) — ask a question
  about the clipper or Nimbus; bugs in the extension belong in this repo's issues

## License

[MIT](./LICENSE)
