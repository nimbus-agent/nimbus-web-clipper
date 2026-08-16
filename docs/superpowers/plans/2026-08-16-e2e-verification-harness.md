# E2E Verification Harness — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the four never-run sections of `docs/development.md` into a CI gate that runs the real extension in real Chromium.

**Architecture:** The existing store-screenshot harness already loads the built extension and seeds a paired connection; its launcher is extracted for reuse. The mock gateway becomes scenario-driven so tests can model misses, refusals and failures rather than only the happy path. `@playwright/test` runs `test/e2e/*.e2e.ts`, one file per checklist section, and a Vitest guard keeps the suite and the checklist from disagreeing about what is verified.

**Tech Stack:** Playwright + `@playwright/test` (new devDep), Vitest (unchanged, unit only), Node for the browser driver, Bun for everything else, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-16-e2e-verification-harness-design.md` — read it before Task 1.

## Global Constraints

- **Worktree:** `C:\gitrep\nimbus-web-clipper\.claude\worktrees\e2e-harness`, branch `feat/e2e-verification-harness`. Never edit the main checkout.
- **No runtime dependency may be added.** `@playwright/test` is a **devDependency**; the shipped `dist/` keeps its "bundled, no runtime deps" guarantee.
- **Vitest stays the unit runner.** `bun run test` must not start running browsers — the SonarCloud gate reads `coverage/lcov.info` from that run.
- **The browser driver runs under `node`, not `bun`.** Playwright uses `--remote-debugging-pipe` (stdio fds 3/4) and Bun on Windows does not wire them up; every launch hangs until timeout. Follow how `package.json`'s `screenshots` script already does this.
- **`headless: true` is forbidden** — it selects Playwright's headless *shell*, which silently loads no extensions. Use `headless: false` plus the `--headless=new` arg.
- **No arbitrary sleeps.** Assert on observable state (a locator, a value), never on elapsed time. A test that cannot be made deterministic is deleted, not retried into submission.
- **One mock, one ephemeral port, one scenario per test.** `listen(0)`; never a fixed port.
- TypeScript strict, **no `any`**. Biome clean. `scripts/` and tests may use `console`; `src/` may not.
- Commit messages: Conventional Commits ending with
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **Do NOT `git push` and do NOT open a pull request.**

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/screenshots/gateway-fixtures.ts` | Wire-shaped fixtures + the `Scenario` type and named scenarios. |
| `scripts/screenshots/mock-gateway.ts` | `handleRequest(req, scenario)`; `startMockGateway(scenario, port)`. |
| `scripts/e2e/launch.ts` | **New.** The shared launcher: build dir, extension id, seeded pairing. |
| `scripts/screenshots/capture.ts` | Consumes the launcher; otherwise unchanged. |
| `playwright.config.ts` | **New.** Runner config: retries, trace on failure, node driver. |
| `test/e2e/*.e2e.ts` | One file per checklist section. |
| `test/unit/e2e-coverage.test.ts` | **New.** The marker drift guard, both directions. |
| `test/unit/mock-gateway.test.ts` | Grows scenario tests. |
| `.github/workflows/ci.yml` | The `e2e` job. |
| `docs/development.md` | Coverage markers; numbered related-lane section. |

---

## Task 1: A mock that can vary

**Files:**
- Modify: `scripts/screenshots/gateway-fixtures.ts`
- Modify: `scripts/screenshots/mock-gateway.ts`
- Test: `test/unit/mock-gateway.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Scenario {
    readonly resolve?: Readonly<Record<string, unknown>>;  // keyed by the `url` query param
    readonly resolveDefault?: unknown;
    readonly related?: unknown;
    readonly ingest?: unknown;
    readonly itemsFetch?: unknown;
    readonly agentRun?: unknown;
    readonly status?: Readonly<Record<string, number>>;    // path → HTTP status override
  }
  export function handleRequest(req: Request, scenario?: Scenario): Promise<Response>;
  export function startMockGateway(scenario?: Scenario, port?: number): Server;
  export const SCENARIOS: { readonly happyPath: Scenario; readonly resolveMiss: Scenario;
    readonly fetchNotConfigured: Scenario; readonly rateLimited: Scenario };
  ```
  Tasks 3, 5 and 6 consume `SCENARIOS` and `startMockGateway`.

**Context you need.** `handleRequest` is already a pure `Request → Response` with a separate Node adapter (`mock-gateway.ts:50`) — keep it pure, add a parameter, do not introduce module-level mutable state. Every scenario field is optional and falls back to today's fixture, so the screenshot script keeps working with no scenario at all.

**A fixture bug this task must fix.** `RELATED`'s items are typed `readonly RelatedHit[]` — the **client** type — but the mock serves the **wire**. `RelatedHit` carries `type?` and `modifiedAt?` (camelCase, renamed at the HTTP boundary by `gateway-client.ts`), while the wire sends `type` and `modified_at`. Because both are optional the fixture omits them entirely, so a related-lane e2e could never assert the kind chip or the "Updated …" line — the panel would render neither, correctly, and the test would be asserting nothing. Give the fixture its own wire type and populate both fields.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/mock-gateway.test.ts`:

```ts
describe("scenarios", () => {
  test("no scenario returns today's fixtures (the screenshot path)", async () => {
    const res = await handleRequest(new Request("http://127.0.0.1:8765/v1/clips/related", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RELATED);
  });

  test("a related override replaces the fixture", async () => {
    const related = { items: [] };
    const res = await handleRequest(
      new Request("http://127.0.0.1:8765/v1/clips/related", { method: "POST" }),
      { related },
    );
    expect(await res.json()).toEqual(related);
  });

  test("resolve is keyed off the url query param", async () => {
    const scenario: Scenario = {
      resolve: { "https://github.com/acme/web/pull/482": RESOLVE_FIXTURE },
      resolveDefault: { found: false, reason: "not_indexed", service: null, fetchable: false },
    };
    const hit = await handleRequest(
      new Request("http://127.0.0.1:8765/v1/items/resolve?url=https%3A%2F%2Fgithub.com%2Facme%2Fweb%2Fpull%2F482"),
      scenario,
    );
    expect(await hit.json()).toEqual(RESOLVE_FIXTURE);

    const miss = await handleRequest(
      new Request("http://127.0.0.1:8765/v1/items/resolve?url=https%3A%2F%2Fwiki.internal%2Frunbook"),
      scenario,
    );
    expect((await miss.json()).found).toBe(false);
  });

  test("a status override wins over the body (rate limiting)", async () => {
    const res = await handleRequest(
      new Request("http://127.0.0.1:8765/v1/clips", { method: "POST" }),
      { status: { "/v1/clips": 429 } },
    );
    expect(res.status).toBe(429);
  });

  test("the related fixture carries the wire's type and modified_at", () => {
    // Guards the defect this task fixes: typed against the CLIENT shape, the
    // fixture silently omitted both fields and no e2e could assert the chip
    // or the freshness line.
    for (const item of RELATED.items) {
      expect(typeof item.type).toBe("string");
      expect(typeof item.modified_at).toBe("number");
    }
  });
});
```

Import `Scenario`, `SCENARIOS` and `RESOLVE_FIXTURE` alongside the file's existing imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run test/unit/mock-gateway.test.ts`
Expected: FAIL — `handleRequest` takes one argument; `Scenario` is not exported.

- [ ] **Step 3: Give the related fixture its wire shape**

In `gateway-fixtures.ts`, replace the client-typed `RelatedResponse` with a wire-shaped one and populate the new fields:

```ts
/**
 * The WIRE shape of a related hit — deliberately NOT `RelatedHit` from
 * `src/shared/types.ts`. That is the CLIENT type, which carries `modifiedAt`
 * (camelCase) because `gateway-client.ts` renames it at the HTTP boundary.
 * The mock stands in for the gateway, so it must speak `modified_at`.
 *
 * Typing this against the client shape was a real defect: both new fields are
 * optional there, so the fixture omitted them and the panel correctly rendered
 * no kind chip and no freshness line — leaving an e2e for those rows asserting
 * nothing at all.
 */
export interface RelatedHitWire {
  readonly id: string;
  readonly title: string;
  readonly service: string;
  readonly type: string;
  readonly snippet: string;
  readonly url: string | null;
  readonly modified_at: number;
}

export interface RelatedResponse {
  readonly items: readonly RelatedHitWire[];
}
```

Then add `type` and `modified_at` to each of the three `RELATED.items` — `"web"`/`"note"` services with types `"page"`, `"note"`, `"page"`, and fixed epoch-ms literals (e.g. `1_700_000_000_000`, minus a day, minus a week). Fixed, never `Date.now()`, for the reason the file's existing comments already give.

- [ ] **Step 4: Add the scenario type and the named scenarios**

In `gateway-fixtures.ts`:

```ts
/**
 * Per-test overrides for the mock. Every field is optional and falls back to the
 * canned fixture, so the screenshot script needs no scenario at all.
 *
 * A plain object passed at construction — NOT a control endpoint mutating a
 * running server. A control endpoint would make each test's meaning depend on
 * what ran before it, which is the standard way a browser suite becomes flaky.
 */
export interface Scenario {
  /** Keyed by the exact `url` query param `GET /v1/items/resolve` receives. */
  readonly resolve?: Readonly<Record<string, unknown>>;
  /** Answer for any url absent from `resolve`. Defaults to RESOLVE_FIXTURE. */
  readonly resolveDefault?: unknown;
  readonly related?: unknown;
  readonly ingest?: unknown;
  readonly itemsFetch?: unknown;
  readonly agentRun?: unknown;
  /** Path → HTTP status, applied before the body is chosen. */
  readonly status?: Readonly<Record<string, number>>;
}

const NOT_INDEXED = { found: false, reason: "not_indexed", service: null, fetchable: false } as const;

export const SCENARIOS = {
  happyPath: {},
  /** Every url misses, and the gateway says it cannot fetch them either. */
  resolveMiss: { resolveDefault: NOT_INDEXED },
  fetchNotConfigured: {
    resolveDefault: NOT_INDEXED,
    itemsFetch: { status: "not_configured" },
  },
  rateLimited: { status: { "/v1/clips": 429 } },
} as const satisfies Record<string, Scenario>;
```

- [ ] **Step 5: Thread the scenario through the mock**

In `mock-gateway.ts`, add `scenario: Scenario = {}` as `handleRequest`'s second parameter. At the top of the function, apply a status override before anything else:

```ts
  const override = scenario.status?.[url.pathname];
  if (override !== undefined && override !== 200) {
    return new Response(null, { status: override });
  }
```

Make resolve consult the scenario:

```ts
  if (req.method === "GET" && url.pathname === GATEWAY_PATHS.resolve) {
    const target = url.searchParams.get("url") ?? "";
    const keyed = scenario.resolve?.[target];
    return jsonResponse(keyed ?? scenario.resolveDefault ?? RESOLVE_FIXTURE);
  }
```

and give `related`, `ingest`, `itemsFetch` and `agentRun` the same `scenario.X ?? FIXTURE` treatment at their existing sites. Then thread it through the adapter: `serve(req, res, port, scenario)` and `startMockGateway(scenario: Scenario = {}, port: number = DEFAULT_PORT)`.

Keep the direct-run block at the file's end working — it calls `startMockGateway()` with no arguments.

- [ ] **Step 6: Run the tests and the gates**

Run: `bunx vitest run test/unit/mock-gateway.test.ts && bun run typecheck && bun run lint`
Expected: PASS, exit 0, clean.

- [ ] **Step 7: Commit**

```bash
git add scripts/screenshots/ test/unit/mock-gateway.test.ts
git commit -m "feat(mock): scenarios, and a related fixture that speaks the wire

The mock spoke every locked route already; what it could not do is vary.
Every route returned one fixture, so it modelled the happy path while
verification is almost entirely about the other paths.

Scenarios are a plain object passed at construction, not a control
endpoint mutating a running server: a control endpoint makes each test's
meaning depend on what ran before it.

Also fixes a real fixture defect. RELATED's items were typed against the
CLIENT RelatedHit, which carries modifiedAt (renamed at the HTTP
boundary) — so the wire's type/modified_at were absent, the panel
correctly rendered no chip and no freshness line, and an e2e for those
rows would have asserted nothing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: One launcher, shared

**Files:**
- Create: `scripts/e2e/launch.ts`
- Modify: `scripts/screenshots/capture.ts`

**Interfaces:**
- Consumes: `startMockGateway`, `Scenario` (Task 1).
- Produces:
  ```ts
  export interface Harness {
    readonly context: BrowserContext;
    readonly sw: Worker;          // playwright's service-worker handle
    readonly extId: string;
    readonly origin: string;      // http://127.0.0.1:<ephemeral>
    readonly close: () => Promise<void>;
  }
  export async function launchExtension(opts?: {
    scenario?: Scenario; viewport?: { width: number; height: number };
    timezoneId?: string; locale?: string; pairedAt?: number;
  }): Promise<Harness>;
  ```
  Tasks 3, 5 and 6 consume `launchExtension`.

**Context you need — every line of this is load-bearing and was paid for once already.** Move it, do not rewrite it, and carry the explanatory comments across:

- `headless: true` selects Playwright's headless **shell**, which silently loads no extensions — the MV3 worker never appears. Use `headless: false` with an explicit `--headless=new` arg.
- The extension id is generated at load; read it from the service worker's URL host. The worker registers lazily, so open a page first, then take `context.serviceWorkers()[0]` or `waitForEvent("serviceworker", { timeout: 15_000 })` — with the timeout, so a failure is loud rather than a hang.
- `launchPersistentContext("")` — the **empty** user-data dir — asks Playwright for a throwaway profile per context. That is what gives each test empty `chrome.storage` and no leaked pairing. Do **not** replace it with a minted directory plus cleanup hooks; that duplicates what it already does.
- Pairing is seeded through the worker:
  `sw.evaluate(conn => chrome.storage.local.set({ connection: conn }), { origin, token, label, pairedAt })`. The ephemeral port rides in on `origin`; nothing else needs to know it.

**The port must be ephemeral.** `startMockGateway(scenario, 0)`, then read the assigned port back off the server (`(server.address() as AddressInfo).port`) and build `origin` from it. A fixed port collides under parallel workers and between concurrent CI jobs.

- [ ] **Step 1: Write the launcher**

Create `scripts/e2e/launch.ts` containing the extraction described above, with `close()` shutting down both the browser context and the mock server. Default `pairedAt` to the existing `1_782_898_200_000` literal so screenshots stay pixel-stable, and default `timezoneId: "UTC"`, `locale: "en-US"` for the same reason.

- [ ] **Step 2: Point `capture.ts` at it**

Replace `capture.ts`'s launch/seed/extension-id block with a single `launchExtension({ viewport: VIEWPORT })` call and use the returned `context`, `sw`, `extId` and `origin`. Delete the now-duplicated constants it no longer owns. Everything after — the three screenshots and the Firefox copy — stays exactly as it is.

- [ ] **Step 3: Prove the screenshot script still works**

Run: `bun run build && bun run screenshots`
Expected: exits 0 and rewrites `store/screenshots/chrome/{popup,options,panel}.png`. Confirm with `git status` that the three PNGs are either unchanged or differ only trivially; a *missing* file or a crash means the extraction broke the launcher.

- [ ] **Step 4: Gates**

Run: `bun run typecheck && bun run lint`
Expected: exit 0, clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e/launch.ts scripts/screenshots/capture.ts
git commit -m "refactor(e2e): extract the extension launcher for reuse

The headless-shell trap, the lazy service-worker id, the node-not-bun
constraint and the seeded pairing are the most expensive knowledge in
this repo to rediscover. A second copy for the e2e suite would drift,
and drift in this code does not present as a break — it presents as
flake.

Ports are ephemeral now: a fixed port collides under parallel workers
and between concurrent CI jobs. The extension learns the port because
it rides in on the seeded connection's origin.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: The runner, and the first suite

**Files:**
- Create: `playwright.config.ts`
- Create: `test/e2e/related-lane.e2e.ts`
- Modify: `package.json`, `docs/development.md`, `biome.json` (only if `test/e2e` needs an override)

**Interfaces:**
- Consumes: `launchExtension` (Task 2), `SCENARIOS` (Task 1).
- Produces: the marker convention Task 4 enforces — an e2e file declares its ids in an exported const:
  ```ts
  export const COVERS = ["related-lane-1", "related-lane-2"] as const;
  ```

**Context you need.** Add `@playwright/test` as a **devDependency**. `bun run test` stays Vitest-only — add a separate `test:e2e` script running under **node**, mirroring how the existing `screenshots` script does it. Exclude `test/e2e/**` from the Vitest config so the unit run does not try to execute browser specs.

**The related-lane section has no numbered steps** — it is a single un-numbered bullet, the outlier a reviewer flagged during the 4.1 slice. Number it as part of this task so markers have something to attach to. Its content becomes five steps: (1) items from the same host appear, (2) each row has a kind chip, (3) each row has an "Updated …" line, (4) rows group under a service heading with a count, (5) the preview line is body prose, not the title repeated. The bullet's last sentence — judge whether groups are mostly one row each — becomes a sixth, **human** step: it is a design judgement, not an assertion.

- [ ] **Step 1: Add the runner**

```bash
bun add -d @playwright/test
```

Create `playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

// The suites drive a real Chromium with the built extension loaded, so they are
// deliberately serial-per-file and modest on workers: each spec owns a browser
// context and a mock gateway on its own ephemeral port.
export default defineConfig({
  testDir: "test/e2e",
  testMatch: /.*\.e2e\.ts/,
  // Retries exist for infrastructure flake (a slow worker registration), never
  // as a way to live with a nondeterministic assertion. A test that needs the
  // retry to pass is deleted, not tolerated.
  retries: process.env["CI"] === undefined ? 0 : 1,
  timeout: 30_000,
  reporter: process.env["CI"] === undefined ? "list" : [["list"], ["html", { open: "never" }]],
  use: { trace: "retain-on-failure" },
});
```

Add to `package.json` scripts, next to `screenshots`:

```json
"test:e2e": "playwright test"
```

Playwright's own CLI transpiles the specs and the `.ts` modules they import, so no node flags are needed — and its binary is a node entry point, so the `--remote-debugging-pipe` constraint that forces `screenshots` to run under `node scripts/screenshots/capture.ts` is satisfied by construction. **If a launch hangs on Windows**, that constraint is the first suspect: invoke the CLI through node explicitly rather than reaching for a timeout bump, and record what you found.

**Do NOT touch `vitest.config.ts`.** Its `include` is an allowlist — `["test/unit/**/*.test.ts"]` — so `test/e2e/*.e2e.ts` is already outside the unit run. Adding an `exclude` would be a no-op change to a config file that is currently correct. Step 5 below is what proves this rather than assuming it.

- [ ] **Step 2: Number the related-lane section**

In `docs/development.md`, replace the single bullet under `## Manual verification — Related lane (richer rows)` with six numbered steps as described above, keeping the original wording of each claim. Mark step 6 as human with the text: **(human — a design judgement, not an assertion).**

- [ ] **Step 3: Write the suite**

Create `test/e2e/related-lane.e2e.ts`:

```ts
/**
 * Covers `docs/development.md` → "Manual verification — Related lane (richer rows)".
 *
 * COVERS steps 1-5. Step 6 is NOT covered and cannot be: it asks whether the
 * service groups are mostly one row each, which is a design judgement about
 * whether grouping earns its place — not a property a machine can assert.
 */
import { expect, test } from "@playwright/test";
import { launchExtension } from "../../scripts/e2e/launch.ts";

export const COVERS = [
  "related-lane-1",
  "related-lane-2",
  "related-lane-3",
  "related-lane-4",
  "related-lane-5",
] as const;

test("a resolved page's related rows carry kind, freshness and grouping", async () => {
  const h = await launchExtension();
  try {
    const page = await h.context.newPage();
    await page.goto(`${h.origin}/sample`);
    await page.bringToFront();
    await h.sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id !== undefined) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["panel.js"] });
      }
    });

    const rows = page.locator(".nimbus-related__item");
    await expect(rows.first()).toBeVisible();

    // related-lane-2: every row names its kind.
    await expect(page.locator(".nimbus-related__kind").first()).toBeVisible();
    // related-lane-3: every row dates itself, in the header's wording.
    await expect(page.locator(".nimbus-related__age").first()).toContainText("Updated ");
    // related-lane-4: rows group under a service heading carrying a count.
    await expect(page.locator(".nimbus-related__group-head").first()).toContainText("·");
    // related-lane-5: the preview line is body prose, not the title repeated.
    const title = await rows.first().locator(".nimbus-related__title").innerText();
    const snippet = await rows.first().locator(".nimbus-related__snippet").innerText();
    expect(snippet).not.toBe(title);
    // related-lane-1: the fixture's hits are all present — nothing host-filtered away.
    await expect(rows).toHaveCount(3);
  } finally {
    await h.close();
  }
});
```

- [ ] **Step 4: Run it**

Run: `bun run build && bun run test:e2e`
Expected: PASS. If the panel never appears, the launcher is at fault, not the assertions — re-read Task 2's context notes before touching this file.

- [ ] **Step 5: Confirm the unit run is untouched**

Run: `bun run test`
Expected: PASS with the same file count as before this task — no `.e2e.ts` spec appears in Vitest's output.

- [ ] **Step 6: Gates and commit**

Run: `bun run typecheck && bun run lint`

```bash
git add playwright.config.ts package.json bun.lock test/e2e/ docs/development.md
git commit -m "feat(e2e): the runner, and the related-lane suite

@playwright/test as a devDependency — retries for infrastructure flake,
trace on failure, per-worker isolation. Vitest stays the unit runner and
bun run test never starts a browser, so the Sonar coverage gate keeps
reading what it always read.

The related-lane section was the one checklist section written as a
single un-numbered bullet, so it had nothing for coverage markers to
attach to; it is numbered here. Its last claim — whether the groups are
mostly one row each — stays human: that is a design judgement about
whether grouping earns its place, not an assertion.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: The drift guard

**Files:**
- Create: `test/unit/e2e-coverage.test.ts`
- Modify: `docs/development.md`

**Interfaces:**
- Consumes: the `COVERS` convention (Task 3).

**Context you need.** This is the same shape as `test/unit/doc-references.test.ts`, whose own comment states the reasoning: *"the cheap version: no new script, no new CI wiring — it rides the existing suite."* Read that file first and follow it. It lives in the **unit** suite deliberately, so it runs on every `bun run test` without a browser.

Marker format in `development.md`: an HTML comment at the end of the step's line, `<!-- e2e:related-lane-2 -->`. Invisible when rendered, greppable, and it cannot disturb the numbering.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/e2e-coverage.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECKLIST = resolve(ROOT, "docs/development.md");
const E2E_DIR = resolve(ROOT, "test/e2e");

const MARKER = /<!--\s*e2e:([a-z0-9-]+)\s*-->/g;
const DECLARED = /"([a-z0-9-]+)"/g;

function markersInChecklist(): string[] {
  const src = readFileSync(CHECKLIST, "utf8");
  return [...src.matchAll(MARKER)].map((m) => m[1] ?? "");
}

function idsDeclaredByTests(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(E2E_DIR).filter((f) => f.endsWith(".e2e.ts"))) {
    const src = readFileSync(join(E2E_DIR, file), "utf8");
    const block = /export const COVERS = \[([^\]]*)\]/.exec(src);
    if (block?.[1] !== undefined) {
      out.push(...[...block[1].matchAll(DECLARED)].map((m) => m[1] ?? ""));
    }
  }
  return out;
}

describe("e2e coverage markers stay in step with the suite", () => {
  test("every marker in the checklist is declared by some e2e file", () => {
    const declared = new Set(idsDeclaredByTests());
    const orphaned = markersInChecklist().filter((id) => !declared.has(id));
    // A step claiming coverage that no test provides is the worse direction:
    // it reads as verified and is not.
    expect(orphaned).toEqual([]);
  });

  test("every id an e2e file declares appears in the checklist", () => {
    const markers = new Set(markersInChecklist());
    const unmarked = idsDeclaredByTests().filter((id) => !markers.has(id));
    // The other direction: a covered step still presented as manual sends a
    // human to re-do work a machine already does.
    expect(unmarked).toEqual([]);
  });

  test("marker ids are unique — a duplicate hides a gap", () => {
    const seen = markersInChecklist();
    expect(seen.length).toBe(new Set(seen).size);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run test/unit/e2e-coverage.test.ts`
Expected: FAIL — the five `related-lane-*` ids are declared by the suite but appear nowhere in `development.md`.

- [ ] **Step 3: Add the markers**

Append `<!-- e2e:related-lane-N -->` to related-lane steps 1–5 in `docs/development.md`. Leave step 6 unmarked — it is human.

Add a short note under that section's heading:

```markdown
Steps carrying an `e2e:` marker are covered by `test/e2e/` and run in CI;
unmarked steps are human. `test/unit/e2e-coverage.test.ts` fails if the two
ever disagree.
```

- [ ] **Step 4: Prove the guard can fail in both directions**

Temporarily change one marker to `<!-- e2e:related-lane-99 -->`, run `bunx vitest run test/unit/e2e-coverage.test.ts`, and confirm the first test fails. Restore it. Then temporarily delete a marker and confirm the *second* test fails. Restore it, re-run, confirm green. Record both observations in your report — a guard that cannot fail is exactly the defect this slice exists to prevent.

- [ ] **Step 5: Commit**

```bash
git add test/unit/e2e-coverage.test.ts docs/development.md
git commit -m "feat(e2e): make the coverage claim enforceable

A convention nobody checks is a convention that rots — this whole slice
exists because a checklist nobody ran rotted. So the markers are checked
in both directions: no step may claim coverage no test provides, and no
test may cover a step the document still presents as manual.

Same shape and same reasoning as doc-references.test.ts, and in the unit
suite for the same reason: it rides the existing run, no browser needed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: The capture suite

**Files:**
- Create: `test/e2e/capture.e2e.ts`
- Modify: `docs/development.md`

**Interfaces:**
- Consumes: `launchExtension`, `SCENARIOS.resolveMiss`, `SCENARIOS.fetchNotConfigured`.

**Context you need.** The capture section has 7 steps. Read them in `docs/development.md` before writing. Their automatability:

- **1, 2** (capture on an unrecognised page; the terminal *"Saved a copy of …"* line) — automatable. The mock's `/sample` page is unrecognised by `recognise()`, which is exactly the case.
- **3** (a recognised page's captured header survives a reopen) — automatable with a `resolve` scenario returning a `service: "nimbus"` / `type: "web_clip"` item for that URL.
- **4** (no durable header on the unrecognised page) — automatable, the negative of 3.
- **5** (`Update this copy` reports `updated`; one item not two) — **human**. It asserts against a real index via `nimbus search`; the mock cannot honestly stand in for "one item, not two".
- **6** (SPA navigation mid-capture yields `url-changed`) — automatable: drive `history.pushState` between the click and the response.
- **7** (preview off; status lines are the only feedback) — automatable via the Options preview toggle, or by seeding the pref directly through the worker.

Declare `COVERS` for 1, 2, 3, 4, 6, 7 and state in the header comment that 5 is human and why.

- [ ] **Step 1: Write the suite**

Create `test/e2e/capture.e2e.ts` with a header comment naming the covered steps and step 5's exclusion, an exported `COVERS`, and one `test()` per covered step. Each test: `launchExtension({ scenario })`, open a page, inject `panel.js` through the worker exactly as Task 3's suite does, then assert on locators — `.nimbus-related__capture` for the offer, the terminal success line's text for steps 2/4, `.nimbus-related__recapture` for step 3's durable header, and the `url-changed` sentence for step 6.

Every test wraps its body in `try { … } finally { await h.close(); }` so a failure cannot leak a browser into the next spec.

- [ ] **Step 2: Run it**

Run: `bun run build && bun run test:e2e`
Expected: PASS, related-lane and capture suites both green.

- [ ] **Step 3: Add the markers**

Append `<!-- e2e:capture-N -->` to capture steps 1, 2, 3, 4, 6 and 7. Leave 5 unmarked, and append to its text: **(human — asserts against a real index; a mock cannot honestly stand in for "one item, not two")**.

- [ ] **Step 4: Gates and commit**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: PASS — including the drift guard, now that the markers exist.

```bash
git add test/e2e/capture.e2e.ts docs/development.md
git commit -m "feat(e2e): cover capture as the last resort

Six of seven steps. Step 5 stays human and says so: it asserts one item
exists rather than two, against a real index, and a mock cannot honestly
stand in for that.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: The two lane suites

**Files:**
- Create: `test/e2e/service-lanes.e2e.ts`, `test/e2e/input-lanes.e2e.ts`
- Modify: `docs/development.md`

**Context you need.** Both sections lean heavily on triggers a harness cannot drive, so the honest-exclusion work here is larger than the assertion work. Read both sections before writing.

**Service lanes (C2.3), 6 steps.** Steps 1–5 are automatable — a dashboard URL, the three lanes, the replay-on-reopen behaviour, the absence of service lanes on a PR, and no ambient cue. **Step 6 is human**: its whole point is the real `ownership` agent noticing an absent `[[filesystem.roots]]`, and the section itself says the mock's fixed brief cannot produce that gap brief. Note also that this section carries an **"Outstanding — this pass has not yet been performed"** banner; replace that banner with the coverage note, since 1–5 now run on every PR.

**Lanes that take an input (C2.5 · glossary · 4.2), 10 steps.** Steps 1, 2, 3, 5 and 6 all begin with a **right-click → context-menu** gesture. Extension context menus are not in the page and Playwright cannot click them. What the harness *can* do is drive the same worker path the menu converges on — the selection hook — and that is worth doing, but the header comment must say plainly that it covers the **handler, not the menu binding**. Step 10 (Firefox) is out of Phase 1 entirely: the harness loads the Chrome build. Steps 4, 7, 8 and 9 are automatable directly.

Split the difference honestly: mark the steps whose *behaviour* is covered, and add to each such step's text **(e2e covers the handler; the context-menu gesture itself is human)**.

- [ ] **Step 1: Write both suites**

Follow Task 3's suite structure exactly — header comment naming covered and excluded steps, exported `COVERS`, one `test()` per covered step, `try/finally` around each. Use a `resolve` scenario keyed to a dashboard URL for the service lanes, and seed selections through the worker for the input lanes.

- [ ] **Step 2: Run them**

Run: `bun run build && bun run test:e2e`
Expected: PASS across all four suites.

- [ ] **Step 3: Markers and honest annotations**

Add `<!-- e2e:service-lanes-N -->` to service-lane steps 1–5 and replace that section's "Outstanding" banner with the coverage note. Add `<!-- e2e:input-lanes-N -->` to the input-lane steps whose behaviour is covered, each with the handler-not-gesture annotation. Annotate step 10 **(human — Firefox; the harness loads the Chrome build)** and service-lane step 6 **(human — needs a real gateway with no `[[filesystem.roots]]` configured)**.

- [ ] **Step 4: Gates and commit**

Run: `bun run test && bun run typecheck && bun run lint`

```bash
git add test/e2e/ docs/development.md
git commit -m "feat(e2e): cover the service lanes and the input lanes

The honest-exclusion work here is larger than the assertion work. Five
of the input-lane steps start with a right-click on an extension context
menu, which is not in the page and not drivable — so those steps are
marked as covering the HANDLER the menu converges on, not the gesture.
Firefox is out of phase 1; the harness loads the Chrome build.

Service-lane step 6 needs the real ownership agent noticing an absent
[[filesystem.roots]], which the section itself says the mock's fixed
brief cannot produce. Its 'Outstanding — never performed' banner is
replaced: steps 1-5 now run on every PR.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: The CI gate

**Files:**
- Modify: `.github/workflows/ci.yml`, `docs/development.md`, `CHANGELOG.md`

**Context you need — two things here will silently break the job if missed.**

**1. The runner is egress-blocked.** `ci.yml`'s first step is `step-security/harden-runner` with `egress-policy: block` and an explicit `allowed-endpoints` list. Playwright's browser download is **not** on it, so `playwright install chromium` will fail with a network error that looks nothing like a firewall. The new job needs its own harden-runner step whose allowlist adds the Playwright CDN — start with `cdn.playwright.dev:443`. If the install still fails, harden-runner prints the endpoint it blocked: add exactly what it names rather than widening the policy.

**2. Cache the browser**, keyed on the resolved Playwright version, at `~/.cache/ms-playwright` — roughly 150 MB per run otherwise. A miss simply downloads, so a stale key degrades to today's cost rather than failing.

- [ ] **Step 1: Add the job**

Add an `e2e` job to `.github/workflows/ci.yml`, parallel to `build-test`, pinning every action to the same commit SHAs the existing job uses (do not float to tags). Shape:

harden-runner (allowlist = the existing list **plus** the Playwright CDN) → checkout → setup-bun → `bun install --frozen-lockfile` → restore `~/.cache/ms-playwright` keyed on the lockfile hash → `bunx playwright install --with-deps chromium` → `bun run build` → `bun run test:e2e` → upload `playwright-report/` and `test-results/` with `if: failure()`.

Give it `timeout-minutes: 15`, matching its neighbour.

- [ ] **Step 2: Verify the workflow is well-formed**

The repo has no YAML linter and this plan does not add one for a single file. Do two concrete checks instead:

```bash
bunx --yes js-yaml .github/workflows/ci.yml > /dev/null && echo "YAML parses"
```

then confirm structurally that the new job declares the same five things its neighbour does — `runs-on`, `timeout-minutes`, a harden-runner step, checkout with `persist-credentials: false`, and setup-bun — and that every `uses:` is pinned to a commit SHA rather than a tag, matching `build-test` exactly.

Be honest in your report that this establishes syntax and shape only. Whether the harden-runner allowlist is sufficient is established by a real run and nothing else.

- [ ] **Step 3: Changelog and the checklist preamble**

`CHANGELOG.md` is user-facing and this change is not — add nothing there. Instead, update `docs/development.md`'s top section to state that marked steps run in CI and unmarked ones are human, and that `bun run test:e2e` runs the suite locally.

- [ ] **Step 4: Full gates**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build && bun run test:e2e`
Expected: all green. `check-build` runs after `build`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml docs/development.md
git commit -m "ci: gate every PR on the e2e suite

A separate job, so a browser failure is distinguishable at a glance from
a typecheck failure and the existing job's runtime is untouched.

Two things that would have broken it quietly: the runner is
egress-blocked by harden-runner and Playwright's CDN was not on the
allowlist, so the browser install would have failed as an opaque network
error; and the ~150MB Chromium download is now cached, keyed on the
lockfile, because a gate people resent is a gate people route around.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Decision 1 (scenarios, ephemeral ports) → Task 1 + Task 2's port handling. Decision 2 (shared launcher, free profile isolation) → Task 2. Decision 3 (`@playwright/test`, Vitest untouched) → Task 3 Steps 1 and 5. Decision 4 (`test/e2e/`, one file per section) → Tasks 3, 5, 6. Decision 5 (CI job + cache) → Task 7. Decision 6 (honesty rule + drift guard + flake rule) → Task 4, plus the per-suite exclusions in Tasks 3, 5, 6 and the no-sleeps constraint in Global Constraints. The spec's "number the related-lane section" → Task 3 Step 2.

**Type consistency.** `Scenario` / `SCENARIOS` / `startMockGateway` defined in Task 1, consumed in Tasks 2, 3, 5, 6. `launchExtension` / `Harness` defined in Task 2, consumed in Tasks 3, 5, 6. The `COVERS` convention introduced in Task 3, enforced in Task 4, followed in Tasks 5 and 6. `RelatedHitWire` is defined once, in Task 1, and is the only place the wire's `modified_at` appears.

**Two judgement calls flagged for a reviewer.** Task 6 marks input-lane steps whose *behaviour* is covered while their *gesture* is not, annotating each rather than either claiming full coverage or leaving them wholly unmarked — a middle position worth disagreeing with. And Task 7 adds no `CHANGELOG.md` entry on the grounds that a CI gate is not a user-facing change; the repo's convention says record user-facing changes there, and this is deliberately read as out of scope.

**One thing the plan cannot verify locally.** Task 7's job only truly runs on GitHub. Step 2 checks that the YAML parses and matches the neighbouring job's shape, which is the most that can be established before a PR exists; the harden-runner allowlist in particular is confirmed only by a real run.
