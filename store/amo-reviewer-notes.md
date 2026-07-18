# AMO Reviewer Notes — Building from Source

The Firefox add-on is bundled with esbuild (each entry point is compiled to a
single IIFE) and `@mozilla/readability` is inlined at build time. Per AMO policy,
here is how to reproduce the exact submitted build from the accompanying source.

## Toolchain

- Bun (https://bun.sh) — used to run the build. Any recent Bun (1.x) works.
- No global tools required; all build dependencies are dev dependencies in
  `package.json` and are installed by `bun install`.

## Build steps

```bash
bun install --frozen-lockfile
bun run build        # esbuild → dist/chrome and dist/firefox
```

The Firefox artifact is the contents of `dist/firefox/` (this is what is packaged
into the submitted zip).

## What each output bundle is

- `background.js` — the MV3 background event page (`src/background/service-worker.ts`).
- `popup.js` — the toolbar popup (`src/popup/popup.ts`).
- `options.js` — the options / pairing page (`src/options/options.ts`).
- `capture.js` — the page-capture script injected on a Clip action
  (`src/capture/capture-in-page.ts`); `@mozilla/readability` is inlined here.
- `panel.js` — the related-items panel injected on demand
  (`src/panel/panel-in-page.ts`).

`manifest.json` is generated from `src/manifest/manifest.ts` at build time.

## Network behaviour

The extension contacts `http://127.0.0.1` / `http://localhost` only (declared in
`host_permissions`). There are no remote hosts, analytics, or telemetry.
