# Contributing

Thanks for helping improve the Nimbus Web Clipper!

## Prerequisites

- [Bun](https://bun.sh) v1.2+
- Chrome 110+ and/or Firefox 121+ (for loading the extension)
- A running [Nimbus gateway](https://nimbus-agent.dev/user-guide/install/) with the
  web-clipper surface, for manual testing

## Setup

```bash
bun install
```

## Develop

```bash
bun run typecheck   # tsc --noEmit (strict)
bun run lint        # biome check src/
bun run test        # vitest run
bun run build       # esbuild → dist/chrome + dist/firefox
bun run watch       # rebuild on save
```

### Loading the built extension

- **Chrome:** `chrome://extensions` → Developer mode → **Load unpacked** →
  `dist/chrome`.
- **Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary
  Add-on** → `dist/firefox/manifest.json`.

After `bun run watch`, reload the extension from the browser's extensions page to
pick up a rebuild.

## Architecture notes

- **Loopback only.** The extension talks only to the Nimbus gateway on
  `127.0.0.1` / `localhost`. Do not add network calls or `host_permissions` for
  any other origin.
- **The bearer token is the only secret.** It lives in extension storage and is
  held by the background service worker. Never log the token or the pairing code,
  and never write either into the page DOM.
- **No `any`; TypeScript strict.** Use `unknown` for data crossing a boundary
  (messages, gateway responses) and narrow with a type guard. Biome enforces the
  rules in `biome.json`, including `noConsole` in `src/` — the extension ships to
  users, so there are no stray `console.*` calls in `src/`.
- The HTTP wire contract (`/v1/clips`, `/v1/clips/pair/confirm`,
  `/v1/clips/related`) is owned by the Nimbus gateway repo. Treat it as fixed here.

## Pull requests

- Keep PRs focused; include tests for behavior changes.
- `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
  must pass (CI runs the same on Ubuntu).

## Releases

Releases are tag-driven: pushing a `vX.Y.Z` tag runs `.github/workflows/publish.yml`,
which builds, zips each browser target, and attaches them to a GitHub Release. The
tag version is stamped into the manifest at build time.
