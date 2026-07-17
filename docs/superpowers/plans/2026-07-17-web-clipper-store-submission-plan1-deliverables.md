# Store Submission — Plan 1: Deliverables + Screenshot Harness

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the in-repo text deliverables needed to create the Chrome Web Store and AMO listings by hand, plus a deterministic screenshot harness (loopback mock gateway + Playwright capture) that produces the committed store screenshots.

**Architecture:** Three cohesive additions — `store/` deliverable docs (listing copy, privacy policy, AMO reviewer notes), a `scripts/screenshots/` harness (typed canned fixtures + a `node:http` mock gateway + a Playwright capture driver), and two committed image sets under `store/screenshots/`. Two drift-guard unit tests keep the listing honest against the manifest and the fixtures honest against the locked HTTP contract.

**Tech Stack:** TypeScript (strict), Vitest, Bun (runs the `scripts/` TS directly), `node:http`, Playwright (Chromium), Biome.

Reference spec: `docs/superpowers/specs/2026-07-17-web-clipper-store-submission-design.md`. This is **Plan 1 of 2**; Plan 2 (CI upload automation in `publish.yml`) is written separately after this plan lands.

## Global Constraints

- **TypeScript strict; no `any`.** `unknown` + narrowing at boundaries. (`tsconfig.json` includes `scripts/**/*`, so harness TS is typechecked.)
- **No `console.*` in `src/`.** `scripts/` is exempt via a `biome.json` override — Task 4 extends that override to `scripts/**/*.ts`.
- **Loopback only.** The mock gateway binds `127.0.0.1`. Never any remote host.
- **Screenshots are exactly 1280×800** (Chrome Web Store dimension). Guaranteed by a fixed Playwright viewport + viewport-only (not full-page) screenshots.
- **Public URLs point at `nimbus-agent.dev`** (homepage `https://nimbus-agent.dev/web-clipper`, privacy `https://nimbus-agent.dev/web-clipper/privacy`, support `https://github.com/nimbus-agent/nimbus-web-clipper/issues`).
- **No real secrets or PII in fixtures or screenshots.** The mock bearer token is a clearly-fake constant.
- **Verification per task:** `bun run typecheck`, `bun run lint`, `bun run test` all pass before each commit.
- **Import style:** TS imports carry the `.ts` extension (repo convention, `allowImportingTsExtensions`).

---

### Task 1: Store listing copy + parity test

**Files:**
- Create: `store/listing.md`
- Test: `test/unit/store-listing.test.ts`

**Interfaces:**
- Consumes: `composeManifest(target, version)` from `src/manifest/manifest.ts` — `.permissions` is `["activeTab", "scripting", "storage", "alarms"]`.
- Produces: `store/listing.md` with a `## Permission justifications` section whose back-ticked keys equal the manifest permissions plus `host_permissions`.

- [ ] **Step 1: Write the failing parity test**

Create `test/unit/store-listing.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { composeManifest } from "../../src/manifest/manifest.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Extract the back-ticked keys from the `## Permission justifications` section. */
function justifiedPermissions(md: string): Set<string> {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^##\s+Permission justifications\s*$/.test(l));
  if (start === -1) {
    throw new Error("store/listing.md: missing '## Permission justifications' heading");
  }
  const keys = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) {
      break; // next section
    }
    const key = line.match(/^-\s+`([^`]+)`\s*:/)?.[1];
    if (key) {
      keys.add(key);
    }
  }
  return keys;
}

describe("store/listing.md ↔ manifest permission parity", () => {
  test("justifies exactly the manifest permissions plus the host_permissions group", () => {
    const md = readFileSync(resolve(ROOT, "store/listing.md"), "utf8");
    const justified = justifiedPermissions(md);
    const manifest = composeManifest("chrome", "0.0.0");
    const expected = new Set<string>([...manifest.permissions, "host_permissions"]);
    expect(justified).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/store-listing.test.ts`
Expected: FAIL — `ENOENT` reading `store/listing.md` (file does not exist yet).

- [ ] **Step 3: Author `store/listing.md`**

Create `store/listing.md`:

```markdown
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/store-listing.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the whole suite + lint + typecheck**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add store/listing.md test/unit/store-listing.test.ts
git commit -m "feat(store): listing copy + manifest-permission parity test"
```

---

### Task 2: Privacy policy + AMO reviewer notes

**Files:**
- Create: `store/privacy-policy.md`
- Create: `store/amo-reviewer-notes.md`

**Interfaces:**
- Consumes: nothing (prose deliverables).
- Produces: the policy text (published to `nimbus-agent.dev` by the owner) and the AMO source-build instructions the reviewer needs.

These are prose deliverables with no code test; verification is a content checklist plus the repo still linting/testing green.

- [ ] **Step 1: Author `store/privacy-policy.md`**

Create `store/privacy-policy.md`:

```markdown
# Privacy Policy — Nimbus Web Clipper

_Last updated: 2026-07-17_

Nimbus Web Clipper is a local-first browser extension. It does not collect,
transmit, sell, or share any personal data, and it contains no analytics or
telemetry.

## What the extension does

When you clip a page or open the related-items panel, the extension sends the
page content (or your selection) to a Nimbus gateway running on your own machine
at `127.0.0.1` (loopback). That is the only network destination the extension
ever contacts. It cannot reach any remote server: the extension declares host
access to `http://127.0.0.1` and `http://localhost` only.

## What is stored, and where

- **Pairing token and gateway origin.** After you pair with your local gateway,
  the extension stores a bearer token and the gateway's loopback origin in the
  browser's local extension storage (`chrome.storage.local`) on your device. The
  token is used only as the `Authorization` header on requests to your local
  gateway. It is never logged, never placed in a web page, and never sent
  anywhere else. You can revoke it at any time on the gateway with
  `nimbus clip revoke`.
- **Offline clip queue.** Clips made while the gateway is unreachable are stored
  locally and retried automatically. The bearer token is not stored in the queue.

All of this data stays on your device. Uninstalling the extension removes it.

## No third parties, no tracking

The extension makes no cloud calls, includes no third-party analytics or
advertising code, and does not track you across sites.

## Contact

Questions: https://github.com/nimbus-agent/nimbus-web-clipper/issues
```

- [ ] **Step 2: Author `store/amo-reviewer-notes.md`**

Create `store/amo-reviewer-notes.md`:

```markdown
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
```

- [ ] **Step 3: Content checklist (manual verification)**

Confirm, by reading both files:
- Privacy policy states: no collection/telemetry, loopback-only, token stored
  locally in `chrome.storage.local`, revocable with `nimbus clip revoke`.
- Reviewer notes give the exact `bun install` + `bun run build` commands and name
  every output bundle (`background`, `popup`, `options`, `capture`, `panel`).

- [ ] **Step 4: Verify the repo still lints/tests green**

Run: `bun run lint && bun run test`
Expected: all pass (no code changed; this confirms the new files don't trip Biome).

- [ ] **Step 5: Commit**

```bash
git add store/privacy-policy.md store/amo-reviewer-notes.md
git commit -m "docs(store): privacy policy + AMO reviewer notes"
```

---

### Task 3: Mock gateway fixtures + contract-shape test

**Files:**
- Create: `scripts/screenshots/gateway-fixtures.ts`
- Test: `test/unit/mock-gateway.test.ts`

**Interfaces:**
- Consumes: `RelatedHit` from `src/shared/types.ts`.
- Produces: `PAIR_CONFIRM: PairConfirmResponse`, `CLIP_INGEST: ClipIngestResponse`, `RELATED: RelatedResponse` — imported by the mock server (Task 4) and the capture driver (Task 5).

- [ ] **Step 1: Write the failing contract-shape test**

Create `test/unit/mock-gateway.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { CLIP_INGEST, PAIR_CONFIRM, RELATED } from "../../scripts/screenshots/gateway-fixtures.ts";

describe("mock gateway fixtures — locked contract shape", () => {
  test("pair/confirm returns a non-empty token and label", () => {
    expect(typeof PAIR_CONFIRM.token).toBe("string");
    expect(PAIR_CONFIRM.token.length).toBeGreaterThan(0);
    expect(typeof PAIR_CONFIRM.label).toBe("string");
    expect(PAIR_CONFIRM.label.length).toBeGreaterThan(0);
  });

  test("clip ingest returns an id and a created|updated status", () => {
    expect(typeof CLIP_INGEST.id).toBe("string");
    expect(["created", "updated"]).toContain(CLIP_INGEST.status);
  });

  test("related returns RelatedHit items including a url:null hit", () => {
    expect(RELATED.items.length).toBeGreaterThan(0);
    for (const hit of RELATED.items) {
      expect(typeof hit.id).toBe("string");
      expect(typeof hit.title).toBe("string");
      expect(typeof hit.service).toBe("string");
      expect(typeof hit.snippet).toBe("string");
      expect(hit.url === null || typeof hit.url === "string").toBe(true);
    }
    expect(RELATED.items.some((h) => h.url === null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/unit/mock-gateway.test.ts`
Expected: FAIL — cannot resolve `scripts/screenshots/gateway-fixtures.ts` (does not exist).

- [ ] **Step 3: Write the fixtures module**

Create `scripts/screenshots/gateway-fixtures.ts`:

```ts
// Canned, deterministic responses for the loopback mock gateway used to drive
// deterministic store screenshots. Not shipped in dist/. The RelatedHit typing
// keeps these in lockstep with the locked /v1/clips/related contract; a unit test
// re-asserts the shape at runtime.
import type { RelatedHit } from "../../src/shared/types.ts";

export interface PairConfirmResponse {
  readonly token: string;
  readonly label: string;
}

export interface ClipIngestResponse {
  readonly id: string;
  readonly status: "created" | "updated";
}

export interface RelatedResponse {
  readonly items: readonly RelatedHit[];
}

/** A clearly-fake token — never a real secret. */
export const PAIR_CONFIRM: PairConfirmResponse = {
  token: "mock-bearer-token-not-a-real-secret",
  label: "Mock Device",
};

export const CLIP_INGEST: ClipIngestResponse = {
  id: "clip_mock_0001",
  status: "created",
};

export const RELATED: RelatedResponse = {
  items: [
    {
      id: "n_001",
      title: "Designing local-first software",
      service: "web",
      snippet: "Seven ideas for software that keeps your data on your own machine…",
      url: "https://www.inkandswitch.com/local-first/",
    },
    {
      id: "n_002",
      title: "Note — hybrid retrieval tradeoffs",
      service: "note",
      snippet: "When re-ranking dense + keyword results beats either alone…",
      url: null,
    },
    {
      id: "n_003",
      title: "Readability.js internals",
      service: "web",
      snippet: "How the article extractor scores DOM nodes to find the main content…",
      url: "https://github.com/mozilla/readability",
    },
  ],
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/unit/mock-gateway.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify typecheck (the `RelatedHit` typing is enforced) + lint + full suite**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/screenshots/gateway-fixtures.ts test/unit/mock-gateway.test.ts
git commit -m "feat(screenshots): typed mock-gateway fixtures + contract-shape test"
```

---

### Task 4: Mock gateway server + `mock-gateway` script + Biome override

**Files:**
- Create: `scripts/screenshots/mock-gateway.ts`
- Modify: `biome.json` (extend the `scripts/**` console override to `.ts`)
- Modify: `package.json` (add the `mock-gateway` script)

**Interfaces:**
- Consumes: `CLIP_PATHS` from `src/shared/gateway.ts`; the fixtures from Task 3.
- Produces: `startMockGateway(port?): http.Server` — imported by the capture driver (Task 5); and a `bun run mock-gateway` command.

- [ ] **Step 1: Extend the Biome console override to `scripts/**/*.ts`**

In `biome.json`, change the last override's `includes` from:

```json
      "includes": ["scripts/**/*.mjs", "esbuild.mjs"],
```

to:

```json
      "includes": ["scripts/**/*.mjs", "scripts/**/*.ts", "esbuild.mjs"],
```

- [ ] **Step 2: Write the mock gateway server**

Create `scripts/screenshots/mock-gateway.ts`:

```ts
// Loopback mock of the Nimbus gateway's three locked endpoints, plus a sample
// article page to inject the related panel into. Dev/CI fixture only — never
// bundled into dist/. Run directly: `bun run mock-gateway`.
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { CLIP_PATHS } from "../../src/shared/gateway.ts";
import { CLIP_INGEST, PAIR_CONFIRM, RELATED } from "./gateway-fixtures.ts";

export const DEFAULT_PORT = 8765;

const SAMPLE_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Designing local-first software</title>
  <link rel="canonical" href="http://127.0.0.1/sample" />
</head>
<body style="max-width:680px;margin:40px auto;font:16px/1.6 system-ui,sans-serif">
  <h1>Designing local-first software</h1>
  <p>Local-first software keeps your data on your own machine while still
  supporting collaboration and sync. This sample page exists so the related
  panel has a real article context to render against.</p>
  <p>The extension reads the page title and canonical URL, asks the local Nimbus
  gateway for related items, and shows them in an on-demand side panel.</p>
</body>
</html>
`;

export function startMockGateway(port: number = DEFAULT_PORT): Server {
  const server = createServer((req, res) => {
    const json = (body: unknown): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/sample") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(SAMPLE_PAGE);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    switch (req.url) {
      case CLIP_PATHS.pairConfirm:
        json(PAIR_CONFIRM);
        return;
      case CLIP_PATHS.ingest:
        json(CLIP_INGEST);
        return;
      case CLIP_PATHS.related:
        json(RELATED);
        return;
      default:
        res.writeHead(404).end();
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`mock gateway listening on http://127.0.0.1:${port}`);
  });
  return server;
}

// Start only when run directly (not when imported by the capture driver).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startMockGateway();
}
```

- [ ] **Step 3: Add the `mock-gateway` package script**

In `package.json`, add to `scripts` (after `"clean"`):

```json
    "mock-gateway": "bun scripts/screenshots/mock-gateway.ts"
```

- [ ] **Step 4: Verify the server serves the contract + sample page**

Run in one shell: `bun run mock-gateway`
In another shell:

```bash
curl -s -XPOST http://127.0.0.1:8765/v1/clips/pair/confirm
curl -s -XPOST http://127.0.0.1:8765/v1/clips/related
curl -s http://127.0.0.1:8765/sample | head -1
```

Expected: the first returns `{"token":"mock-bearer-token-not-a-real-secret","label":"Mock Device"}`; the second returns the related items JSON with a `"url":null` hit; the third prints `<!doctype html>`. Stop the server (Ctrl-C).

- [ ] **Step 5: Verify typecheck + lint + full suite**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass (the console call in the server is allowed by the extended override).

- [ ] **Step 6: Commit**

```bash
git add scripts/screenshots/mock-gateway.ts biome.json package.json
git commit -m "feat(screenshots): loopback mock gateway + sample page + mock-gateway script"
```

---

### Task 5: Playwright capture driver + `screenshots` script

**Files:**
- Modify: `package.json` (add the `playwright` devDependency + the `screenshots` script)
- Create: `scripts/screenshots/capture.ts`

**Interfaces:**
- Consumes: `startMockGateway`, `DEFAULT_PORT` from Task 4; the built `dist/chrome/` extension (from `bun run build`).
- Produces: `store/screenshots/{chrome,firefox}/{popup,options,panel}.png` at 1280×800 — committed in Task 6.

- [ ] **Step 1: Add Playwright and the `screenshots` script**

```bash
bun add -d playwright
bunx playwright install chromium
```

In `package.json`, add to `scripts`:

```json
    "screenshots": "bun scripts/screenshots/capture.ts"
```

- [ ] **Step 2: Write the capture driver**

Create `scripts/screenshots/capture.ts`:

```ts
// Deterministic store-screenshot capture. Loads the built dist/chrome extension
// in Chromium, seeds a paired connection pointing at the loopback mock gateway,
// and shoots the popup, options page, and injected related panel at 1280×800.
// Run: `bun run build && bun run screenshots`. Manual/integration — not a unit test.
//
// If the MV3 service worker fails to load under headless, launch Chromium with
// `--headless=new` (Playwright's `headless: true` maps to new headless on current
// Chromium; older builds may need the explicit arg below).
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { DEFAULT_PORT, startMockGateway } from "./mock-gateway.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXT_DIR = resolve(ROOT, "dist/chrome");
const OUT_CHROME = resolve(ROOT, "store/screenshots/chrome");
const OUT_FIREFOX = resolve(ROOT, "store/screenshots/firefox");
const ORIGIN = `http://127.0.0.1:${DEFAULT_PORT}`;
const VIEWPORT = { width: 1280, height: 800 } as const;
const SHOTS = ["popup.png", "options.png", "panel.png"] as const;

async function main(): Promise<void> {
  mkdirSync(OUT_CHROME, { recursive: true });
  mkdirSync(OUT_FIREFOX, { recursive: true });

  const server = startMockGateway();
  const context = await chromium.launchPersistentContext("", {
    headless: true,
    viewport: VIEWPORT,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });

  try {
    // Resolve the dynamically-generated extension id from the MV3 service worker.
    let [sw] = context.serviceWorkers();
    if (!sw) {
      sw = await context.waitForEvent("serviceworker");
    }
    const extId = new URL(sw.url()).host;

    // Seed a paired connection (storage key "connection") pointing at the mock.
    await sw.evaluate(
      async (conn) => {
        await chrome.storage.local.set({ connection: conn });
      },
      { origin: ORIGIN, token: "mock-bearer-token-not-a-real-secret", label: "Mock Device", pairedAt: 0 },
    );

    // Popup — composited centered on a padded canvas (the popup is ~360px wide).
    const popup = await context.newPage();
    await popup.setViewportSize(VIEWPORT);
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.addStyleTag({
      content:
        "html{margin:0;min-height:800px;display:flex;align-items:center;justify-content:center;background:#eef1f7}" +
        "body{box-shadow:0 12px 40px rgba(0,0,0,.18);border-radius:12px;overflow:hidden}",
    });
    await popup.screenshot({ path: resolve(OUT_CHROME, "popup.png") });

    // Options — paired state fills the viewport.
    const options = await context.newPage();
    await options.setViewportSize(VIEWPORT);
    await options.goto(`chrome-extension://${extId}/options.html`);
    await options.waitForLoadState("networkidle");
    await options.screenshot({ path: resolve(OUT_CHROME, "options.png") });

    // Related panel — inject panel.js into the loopback sample page, wait for items.
    const sample = await context.newPage();
    await sample.setViewportSize(VIEWPORT);
    await sample.goto(`${ORIGIN}/sample`);
    await sample.bringToFront();
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id !== undefined) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["panel.js"] });
      }
    });
    await sample.locator(".nimbus-related__item").first().waitFor({ timeout: 5000 });
    await sample.screenshot({ path: resolve(OUT_CHROME, "panel.png") });

    // Firefox reuses the Chromium captures (AMO dimension rules are looser).
    for (const name of SHOTS) {
      copyFileSync(resolve(OUT_CHROME, name), resolve(OUT_FIREFOX, name));
    }
    console.log(`wrote ${SHOTS.length} screenshots to store/screenshots/{chrome,firefox}/`);
  } finally {
    await context.close();
    server.close();
  }
}

await main();
```

- [ ] **Step 3: Verify typecheck + lint (script compiles against Playwright + @types/chrome)**

Run: `bun run typecheck && bun run lint`
Expected: pass. (`chrome.*` inside `sw.evaluate` callbacks typechecks against `@types/chrome`; the console call is allowed by the `scripts/**/*.ts` override.)

- [ ] **Step 4: Run the harness end-to-end**

Run: `bun run build && bun run screenshots`
Expected: prints `wrote 3 screenshots …`; `store/screenshots/chrome/` and `store/screenshots/firefox/` each contain `popup.png`, `options.png`, `panel.png`.

Troubleshooting (not part of the committed code): if the service worker never appears, re-run with the extension loaded under new headless by adding `"--headless=new"` to `args` and setting `headless: false`; if the panel selector times out, confirm `dist/chrome/panel.js` exists (it is built from `src/panel/panel-in-page.ts`).

- [ ] **Step 5: Commit the harness (script + deps only — images land in Task 6)**

```bash
git add package.json bun.lock scripts/screenshots/capture.ts
git commit -m "feat(screenshots): Playwright capture driver + screenshots script"
```

---

### Task 6: Generate + commit the screenshot assets

**Files:**
- Create: `store/screenshots/chrome/{popup,options,panel}.png`
- Create: `store/screenshots/firefox/{popup,options,panel}.png`
- Create: `store/screenshots/README.md`

**Interfaces:**
- Consumes: the capture driver from Task 5.
- Produces: the committed image assets the owner uploads to each dashboard.

- [ ] **Step 1: Regenerate the screenshots from a clean build**

Run: `bun run build && bun run screenshots`
Expected: the six PNGs are (re)written.

- [ ] **Step 2: Eyeball each screenshot**

Open the three `store/screenshots/chrome/*.png` and confirm: the popup shows the paired clip UI centered on the padded canvas; the options page shows the paired status; the panel shows the three related items (including the URL-less "Note — hybrid retrieval tradeoffs" hit rendered as plain text). Confirm **no real token or personal data** is visible.

- [ ] **Step 3: Add a short README for the assets**

Create `store/screenshots/README.md`:

```markdown
# Store screenshots

Generated deterministically by `bun run screenshots` (see
`scripts/screenshots/capture.ts`) against the loopback mock gateway. Do not edit
the PNGs by hand — regenerate after any UI change and re-upload to the Chrome Web
Store and AMO dashboards.

- `chrome/` — 1280×800, the Chrome Web Store dimension.
- `firefox/` — the same captures, reused for AMO.
```

- [ ] **Step 4: Commit the assets**

```bash
git add store/screenshots
git commit -m "feat(store): committed store screenshots (popup, options, related panel)"
```

---

## Self-Review

**Spec coverage (Plan 1 scope):**
- `store/listing.md` (copy, single-purpose, per-permission justifications, URLs) → Task 1. ✅
- `store/privacy-policy.md`, `store/amo-reviewer-notes.md` → Task 2. ✅
- Loopback mock gateway (three endpoints) → Task 4; typed fixtures → Task 3. ✅
- Playwright capture (popup / options / related panel, 1280×800, extension-id via `serviceWorkers()`, popup composited on a canvas) → Task 5. ✅
- Committed `store/screenshots/**`, Firefox reuse → Tasks 5–6. ✅
- Playwright devDependency + `mock-gateway` / `screenshots` package scripts → Tasks 4–5. ✅
- Drift guards: mock-gateway-vs-contract → Task 3; listing-vs-manifest-permissions → Task 1. ✅
- **Out of Plan 1 (Plan 2):** `publish.yml` CWS + AMO upload steps, `docs/store-submission.md`, `git archive` source zip. Not covered here by design.

**Notes on decisions:**
- The spec listed popup states "default / saved / queue-manager". The harness ships the **default paired** popup only, because "saved" and "queue-manager" are transient states that require driving a real clip flow from a standalone popup tab (whose active tab is the extension page, not a web page) — brittle and low-value for a listing. Additional states can be captured manually if ever wanted; Chrome Web Store needs only 1–5 shots and three strong deterministic shots suffice. This is a conscious narrowing, flagged here rather than silently dropped.
- Pair/clip response shapes are asserted structurally in Task 3 (only `RelatedHit` exists as a shared type); this matches the locked contract documented in `src/shared/gateway.ts`.

**Placeholder scan:** none — every step has concrete content/commands.

**Type consistency:** `startMockGateway`/`DEFAULT_PORT` (Task 4) are consumed with those exact names in Task 5; `PAIR_CONFIRM`/`CLIP_INGEST`/`RELATED` (Task 3) are consumed in Tasks 4–5; storage key `connection` and injected file `panel.js` match `src/background/connection-store.ts` and `src/browser/scripting.ts`.
