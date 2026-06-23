# Nimbus Web Clipper

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

> **Status:** scaffolding. The build, CI, and a loadable empty MV3 shell are in
> place; the clip / pair / related features are designed in
> [`docs/`](./docs/) and land next.

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
monorepo). See <https://nimbus-agent.dev/install>.

## Install (developer / sideload)

The extension is dev-loadable today; store submission is a follow-on.

```bash
bun install
bun run build      # → dist/chrome and dist/firefox
```

- **Chrome:** `chrome://extensions` → enable Developer mode → **Load unpacked** →
  pick `dist/chrome`.
- **Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary
  Add-on** → pick `dist/firefox/manifest.json`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The HTTP wire contract is owned by the
Nimbus gateway repository; this repo builds against that stable surface.

## See also

- [Documentation](./docs/) — design spec, architecture, and the implementation plan
- [Nimbus](https://github.com/nimbus-agent/Nimbus) — the gateway this extension talks to
- [nimbus-vscode](https://github.com/nimbus-agent/nimbus-vscode) — the sibling editor client

## License

[MIT](./LICENSE)
