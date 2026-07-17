# Store screenshots

Generated deterministically by `bun run screenshots` (see
`scripts/screenshots/capture.ts`) against the loopback mock gateway. Do not edit
the PNGs by hand — regenerate after any UI change and re-upload to the Chrome Web
Store and AMO dashboards.

- `chrome/` — 1280×800, the Chrome Web Store dimension.
- `firefox/` — the same captures, reused for AMO.

Run `bun run build` first: the harness loads the built `dist/chrome/` extension.
On a clean machine, `bun run screenshots:setup` installs the Chromium binary.

The capture driver itself runs under `node`, not `bun` — Playwright cannot launch
Chromium under Bun on Windows (it needs stdio fds 3/4 for `--remote-debugging-pipe`).
The `screenshots` package script already does this; there is nothing to remember.
