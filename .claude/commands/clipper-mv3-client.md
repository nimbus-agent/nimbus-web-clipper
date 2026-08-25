---
name: clipper-mv3-client
description: >
  The non-obvious mechanics of the Nimbus Web Clipper: which gates prove what and which
  pass while proving nothing, the coupled sites nothing enforces, the MV3 traps that
  exist only as a comment inside one file, and which half of the pairing/token contract
  belongs to the gateway repo. Use when asked "what should I run before pushing", "why
  did CI fail when local was green", "why does my Playwright script hang", "why did
  adding a permission break a test", or before touching `src/background/service-worker.ts`,
  `src/manifest/manifest.ts`, `esbuild.mjs`, `scripts/`, or `.github/workflows/`.
---

# Nimbus Web Clipper — the MV3 client

## What this skill is not

`docs/architecture.md` explains how the code fits together — the layer map, the clip
pipeline, the two state machines, the invariant table. `docs/development.md` carries the
manual checklists. Read those for design. This file is only the part that is costly to
rediscover: what the gates do and do not prove, the sites that must move together with
nothing to catch you, and the mechanics that live as a comment inside one file you have no
reason to open.

## The gate set

CI (`.github/workflows/ci.yml`, `ubuntu-24.04`) has **two** jobs. `build-test` runs exactly
five steps, in order:

```bash
bun run typecheck   # tsc --noEmit, strict
bun run lint        # biome check .   (src + test + scripts + esbuild.mjs)
bun run test        # bunx vitest run
bun run build       # bun esbuild.mjs → dist/chrome + dist/firefox
bun run check-build # scripts/check-build.mjs
```

The whole suite runs in about fifteen seconds. `bun run lint` is a real gate for behaviour,
not style: `noConsole` is `"error"` inside `src/` (`biome.json`), so a debug `console.log`
left in an extension source file fails CI.

The second job is `e2e`: `bunx playwright install chromium` → `bun run build` →
`bun run test:e2e`. It runs on every PR and is a required part of the gate set, so **five
green steps is not "CI is green"**. Locally it needs a browser download and a build first,
which is why it is the step most often skipped before pushing.

**Three PR checks those five steps cannot reproduce**, and they are the usual answer to
"local was green, why did CI fail":

- the `e2e` job above, whenever you did not run it locally.
- `.github/workflows/codeql.yml` — `Analyze (javascript-typescript)` on every PR to `main`,
  plus a Monday cron. Nothing local runs it.
- `.github/workflows/cla.yml` — fires on `pull_request_target`, so it also runs for
  external contributors' forks. An outside PR is red until the author comments the exact
  signing phrase; that is contributor-side, not a code problem.

`.github/workflows/sonar.yml` is a **separate, blocking** check: `sonar-project.properties`
sets `sonar.qualitygate.wait=true`, so a gate ERROR fails the PR. But the analysis step is
`if: env.SONAR_TOKEN != ''` — absent the secret it skips and the check goes green having
scanned nothing.

`.gitlab-ci.yml` is a **hand-maintained warm-standby mirror** of those same five steps — and
of `build-test` only: it has no e2e job, because the `oven/bun` image carries no browser.
Nothing checks the two against each other — adding a gate to `ci.yml` and not to
`.gitlab-ci.yml` is silent drift. Its `before_script` encodes a real trap: the `oven/bun` image ships
without `git`, and Biome's `vcs.useIgnoreFile: true` needs it or the run scans
`node_modules`.

## Gates that prove less than they look like they prove

- **`bun run test:coverage` enforces no floor.** `vitest.config.ts` deliberately sets no
  thresholds. The *only* coverage gate is SonarCloud's "Sonar way" 80%-on-new-code, applied
  to the lcov that script emits. A green local `test:coverage` says nothing about coverage.
- **The mock gateway validates nothing.** `scripts/screenshots/mock-gateway.ts`'s `serve()`
  builds its `Request` from method + headers only — **the POST body is dropped** — and
  `handleRequest` returns a fixture for every route without reading a bearer token. Pairing
  against it succeeds with any six digits (`scripts/verify-setup.ts` literally types
  `429173`). A manual pass against the mock exercises **no** part of I30, scopes, 401/403
  mapping, the rate limit, or the 1 MiB cap. Use it for panel/options rendering; use a real
  gateway for anything about auth.
- **`mock-gateway.test.ts` is self-consistency, not contract verification.** It asserts the
  fixtures match *this client's own types*. A fixture built from our assumptions cannot
  catch a mismatch with the real gateway — see below.
- **`check-build`'s file list is hand-written.** `REQUIRED_FILES` in
  `scripts/check-build.mjs` is a literal array. Adding an entry to `ENTRIES` in
  `esbuild.mjs` without adding its output to `REQUIRED_FILES` leaves the new bundle
  unguarded and `check-build` still prints OK. The reverse direction fails loudly, which is
  why the omission is the one that ships. `test/unit/build-artifacts.test.ts` now closes
  that gap by comparing the two arrays as text — but it is a regex over source, so
  renaming `ENTRIES`, `HTML_CSS` or `REQUIRED_FILES` makes it throw rather than pass
  vacuously. That file's header comment used to enumerate "3 bundles" long after there
  were nine; it no longer restates the list, and neither should you.

## The wire contract is not yours

The gateway owns it. In `C:/gitrep/Nimbus`: `packages/gateway/src/clips/` (pairing window,
token store, ingest, related, scopes), `packages/gateway/src/ipc/http-write-routes.ts`
(caps, rate limits, the I13 allowlist), `packages/gateway/src/ipc/http-server.ts`
(`/v1/items/resolve`, the read routes). **Nothing in this repo checks against it** — the
gateway paths appear here only inside doc comments. The contract was mis-guessed once
already: `src/shared/gateway.ts` records that `resolve` was "briefly modelled here as
PROPOSED while this client was built against a guessed shape", corrected by
`1c02ff7 fix(panel): adapt resolve to the shipped GET /v1/items/resolve contract (#38)`.
When you touch a route, read the gateway source, not the fixture.

Fixed upstream, not negotiable here (invariant **I30**, `clips/pairing-window.ts`):

- The window is opened by the **owner** via `nimbus clip pair` — in-memory, `PAIRING_TTL_MS`
  120s, `PAIRING_MAX_ATTEMPTS` 5, single-use, dropped by a gateway restart.
- **Scopes are recorded when the owner opens the window**, never taken from the confirming
  request. This client cannot ask for a scope; it can only report the gap.
- No live window → `POST /v1/clips/pair/confirm` returns **403**. That is why
  `confirmPair` maps 403 → `pairing_failed`, and not to `server_error`.

The mapping that will bite you: `clips/api-scopes.ts` sets
`LEGACY_SCOPES = ["clip", "briefs"]`, so **every browser paired before scopes existed lacks
`resolve`, `fetch` and `agents`** and hits 403 first. `gateway-client.ts` therefore parses
the 403 body into a `scopeGap` (`{ required, granted }`) and surfaces a pasteable
`nimbus clip scopes …` line. Folding a 403 into `server_error` blames the gateway for a
grant the owner simply has not made.

Also upstream, and deliberately paired constants (`http-write-routes.ts`): `POST /v1/clips`
carries `MAX_BODY_BYTES_ARTICLE` (1 MiB) *because* it is held to
`MAX_REQUESTS_PER_WINDOW_CLIP` (20/min) rather than the 60/min default — the abuse bound is
cap × rate. This client never truncates (`buildClipPayload` sends the whole body), so 413 →
`payload_too_large` is terminal and, correctly, **not queued** (`handlers.ts` queues only
`unreachable` / `server_error` / `rate_limited`).

One more hand-maintained coupling: `AGENT_LANES` in `src/shared/types.ts` **is** the wire
agent name — `invokeAgent` passes a member straight into `POST /v1/agents/{agent}`.
Upstream derives `HTTP_AGENT_NAMES` from its handler map minus `HTTP_EXCLUDED_AGENT_METHODS`
(`ipc/agents-rpc.ts`). A rename or a new exclusion there 404s a lane here, and no gate in
either repo notices.

## MV3 mechanics that actually bite

- **`chrome.alarms.create` cancels and replaces a same-named alarm, restarting its
  countdown.** `src/browser/alarms.ts` exists for that one fact: `ensureAlarm` reads first
  and only creates when absent. Calling `create` on every queue change would push the next
  fire out forever and the offline queue would never drain. `rearmAlarm` is the deliberate
  replace.
- **Alarms are the eviction net, never the poll cadence.** `chrome.alarms` has a one-minute
  floor (and Chrome ignores delays under 0.5 min with a warning) while an agent run finishes
  in seconds — so `AGENT_POLL_ALARM` in `service-worker.ts` only resumes runs whose worker
  died; the live cadence is a `setTimeout` backoff. Do not "simplify" one into the other.
- **A `void promise` with no `.catch` fails the test run.** In an MV3 worker an unhandled
  rejection is a warning; under Vitest it fails the suite. Every fire-and-forget in
  `service-worker.ts` carries `.catch(() => undefined)` for that reason.
- **There is no `web_accessible_resources`** in `src/manifest/manifest.ts`, so an injected
  surface cannot load a CSS file. `panel.js`, `toast.js` and `cue.js` each `attachShadow`
  and inline a `STYLES` string.
- **An `executeScript({ func })` body is serialised and evaluated in the page** — it cannot
  see this bundle's imports. That is why every injected surface is a two-step `files:` then
  `func:` call in `src/browser/scripting.ts`, and why the panel's element id and hook *name*
  live in `src/shared/panel-host.ts` as passed-in arguments.
- **`panel.js` self-toggles on re-injection.** Delivering data to an already-open panel via
  `injectPanel` closes it. `deliverSelection` calls the hook first and mounts only on a miss.
- **A tab id from a message payload is forgeable.** `CueOpenRequest` deliberately carries no
  payload; the worker uses `sender.tabId`, which `src/browser/runtime.ts` narrows out of
  `sender.tab?.id`.
- **`activeTab`, deliberately not `tabs`.** Unit tests fake `chrome.tabs.query`, so a grant
  that fails to apply for one entry point (context menu vs hotkey) shows up only as an empty
  `tab.url` in a real browser — `development.md` step 1 of the quick-clip checklist is the
  only thing that catches it.

## Coupled sites nothing else will remind you of

- **A manifest permission ⇄ `store/listing.md`.** `test/unit/store-listing.test.ts` asserts
  the back-ticked keys under `## Permission justifications` equal *exactly*
  `composeManifest().permissions` plus `host_permissions` and `optional_host_permissions`.
  Adding **or removing** a permission fails `bun run test` until the store copy is updated.
- **A new injected surface is five files:** `src/<area>/<x>-in-page.ts` (set
  `globalThis.__nimbusX`) → `ENTRIES` in `esbuild.mjs` → `REQUIRED_FILES` in
  `scripts/check-build.mjs` → a two-step wrapper in `src/browser/scripting.ts` → inline
  styles in a shadow root. Only steps 1–2 fail visibly if you skip the rest.
- **Editing a workflow can fail a unit test.** `test/unit/publish-workflow.test.ts` asserts
  the literal text and job ordering of `.github/workflows/publish.yml` (including that the
  source archive is built *after* the Release is attached);
  `test/unit/store-publishing-doc.test.ts` and `store-tooling.test.ts` do the same for
  `store/publishing.md` and the CLI devDependencies. `biome.json` turns
  `noTemplateCurlyInString` off for exactly one file so the GHA `${{ }}` assertions lint.
  `test/unit/workflow-hygiene.test.ts` applies to **every** workflow, including one you
  add: each job needs `timeout-minutes`, each `uses:` a 40-character SHA, each workflow a
  top-level `permissions:`, each checkout `persist-credentials: false`, each
  `pull_request`-triggered workflow a `concurrency:` group — and no tag-triggered workflow
  may set `cancel-in-progress: true`, because cancelling a release mid-upload can leave a
  store submission half-made.
- **A manifest permission ⇄ `store/privacy-policy.md`.** Nothing enforces this one. The
  policy enumerates what the extension stores and what it declares, and it is submitted to
  both stores — a new `chrome.storage.local` key or a new declared permission makes it
  wrong, silently, in the one document a reviewer reads most closely.
- **Pruning a design spec.** `test/unit/doc-references.test.ts` walks `ROADMAP.md`,
  `docs/*.md` and every `src/**/*.ts` for `docs/superpowers/<kind>/<date>-<slug>.md` and
  fails on a dangling reference. The one allowed exception is `INTENTIONALLY_PRUNED`, and
  the rule for adding to it is that the *surrounding prose* tells the reader the file is gone.
- **The manifest is TypeScript.** `esbuild.mjs` imports `composeManifest` directly, which is
  why the build runs `bun esbuild.mjs` and never `node esbuild.mjs`.
- **`keyed-store.ts` is the single-writer lock's named home, not its only copy.** The two
  run stores import `createWriteChain` / `readGuarded`; `brief-log-store`,
  `clip-queue-store` and `passage-store` keep their own chain on purpose, because each has
  a different write-failure policy (evict / drop-oldest / refuse) and persists an array
  rather than a keyed record. So grepping `createWriteChain` does **not** enumerate every
  store that locks — grep `let chain: Promise<unknown>` too.

## Test seams

- **Zero `vi.mock()` calls in the whole suite.** The convention is dependency injection —
  `handlers.ts`, `queue-flush.ts`, `quick-clip.ts`, `ambient.ts` take their deps as an
  object; `service-worker.ts` is the one place the real `chrome.*`-backed implementations
  are wired. Reach for a dep parameter, not a module mock.
- **Two chrome fakes, and they are not interchangeable.** `test/unit/chrome-stub.ts` is a
  minimal storage/tabs/scripting fake for store modules. `test/unit/helpers/chrome-mock.ts`
  is the full `vi.fn()` harness with listener registries, `emitMessage` /
  `emitMessageFromTab`, granted-origin tracking and `restore()` — required for anything that
  registers listeners.
- **Order matters for entry-point modules.** `service-worker.ts`, `panel-in-page.ts`,
  `cue-in-page.ts` and `toast-in-page.ts` register listeners / mount as a *module-evaluation
  side effect*. The pattern is: `installChromeMock()` → seed storage → `vi.resetModules()` →
  `await import(...)` → settle. Seeding after the import means the startup sequence never saw
  it; skipping `resetModules` means you are driving the previous test's listeners.
- **Know which helper is which — the names do not tell you.** `settle()`
  (`test/unit/service-worker.test.ts`) and `flush()` (`test/unit/panel-in-page.test.ts`) are
  **real macrotask ticks**, for letting chained storage/fetch awaits take a turn.
  `advanceTimers()` (`test/unit/panel-in-page.test.ts`) is the **fake**-timer helper —
  `vi.advanceTimersByTimeAsync`, and it requires `vi.useFakeTimers()` already active. It
  exists because the plain synchronous `vi.advanceTimersByTime` fires a timer without ever
  letting that callback's own `await` resolve.
- DOM tests opt in per file with a `// @vitest-environment jsdom` docblock; the default env
  is node. Readability tests need genuinely long multi-paragraph prose or its scoring
  heuristic finds no article (`capture-in-page.test.ts`).

## The three Playwright scripts

`screenshots`, `verify:setup` and `promo` are the only scripts in `package.json` that run
under **`node`, not `bun`** — Playwright drives Chromium over `--remote-debugging-pipe`,
which needs stdio fds 3/4, and Bun on Windows does not wire them up, so every launch hangs
until timeout. Do not "fix" them to `bun`.

Two more that cost real time to rediscover:

- **`headless: true` silently loads no extension.** It resolves to Playwright's separate
  headless-shell binary and the MV3 service worker never appears. Every script uses
  `headless: false` plus `args: ["--headless=new"]` to force the regular Chromium binary.
- **`server.close()` is not "the gateway stopped."** It stops accepting new connections but
  leaves established keep-alive sockets serving, and Chromium holds one — `verify-setup.ts`
  calls `closeAllConnections()` first, or step 6 reports a false PASS.

`bun run verify:setup` automates steps 1–6 of `development.md`'s "Setup that works". It is
**not in CI** and says so on screen: step 7 (Firefox) is impossible because Playwright cannot side-load an MV3 add-on
into Firefox, step 8 needs real GitHub/Jira/Jenkins hostnames, and step 5's clip is
synthesized (it sends the `clip` message, so it exercises `markClipSuccess` but does not
prove the popup button).

## Sonar specifics

- **`// NOSONAR` must be a trailing comment on the reported line.** Sonar anchors it to the
  issue's own line; a block comment above is ignored — learned twice (issue #20, and again
  on `void runStartupSequence();`). The two live markers are `src/manifest/manifest.ts`
  (`optional_host_permissions`, S5332) and the last line of
  `src/background/service-worker.ts` (S7785).
- **Cognitive complexity S3776 caps at 15** and has forced extractions repeatedly:
  `parseAgentRunBody` out of `getAgentRun`, `openPanelForCue` out of the message router,
  and then the router itself into four order-preserving slices (`routeCapturePair` /
  `routeIndexReads` / `routeQueueAndConnection` / `routeSubRouters`, nineteen branches
  between them). Order is load-bearing there: the guards are not disjoint by construction,
  only by the sequence they run in, so a new branch goes in its slice — not at the top.
- **A complexity refactor strands the comments that described the old shape.** The router
  split left three comments in two files still calling it "a fourteen-branch function",
  including one sitting directly above the code that says it is now four. Sonar does not
  read prose and no gate does either. After changing a shape, grep the phrase you just
  falsified — repo-wide, not in the file you edited.

## What only a human in a real browser can prove

`docs/development.md` holds the checklists. The ones unverifiable by construction, not
merely unwritten:

- **Service-worker eviction.** The suite fakes the eviction net by calling the alarm handler
  directly; whether Chrome preserves a registered alarm across a genuine eviction is
  Chrome's behaviour, not ours. Chrome (`background.service_worker`, ~30s idle) and Firefox
  (`background.scripts`) evict on entirely different rules — a pass in one is not evidence
  for the other.
- **`chrome.permissions.request` grant/revoke**, which needs a user gesture and so can only
  be driven from an Options click. Run it in both browsers; the C1 checklist notes this
  asymmetry is what caught a grant that resolved `false` on one target only.
- **Retry pacing.** A dev-loaded unpacked extension is not held to Chrome's 30-second alarm
  minimum, so observed retry timing in dev differs from a shipped zip.
- **Anything auth-shaped** — expiry, wrong code, 401 re-pair, 413, the 20/min limit —
  because the mock gateway accepts everything.

State which of these you actually ran. "Verified against the mock gateway" and "verified
against a real gateway" are different claims.
