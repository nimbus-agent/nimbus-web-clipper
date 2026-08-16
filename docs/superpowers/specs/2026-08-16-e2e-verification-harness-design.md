# An e2e verification harness — Phase 1

**Status:** design, approved 2026-08-16.

**Scope:** Phase 1 of three. The goal agreed with the maintainer is *every
automatable section* of `docs/development.md`; this spec covers the harness
itself plus the four features that have never been verified by a human. Phases 2
and 3 reuse what this establishes and get their own spec→plan cycles.

## Why this exists

`docs/development.md` lists **17 sections and roughly 136 numbered steps** for
surfaces that unit tests cannot reach: injected content scripts, the popup and
options DOM, and the service-worker glue. It is the only thing standing between
those surfaces and a regression.

Nobody runs it. Four features shipped to `main` in the last week — the service
lanes (**C2.3**), the input lanes (**C2.5** / glossary / **4.2**), the related
lane (**4.1**) and capture (**C3.2**) — with their sections never exercised. The
debt grows by one section per slice, and the document's own framing ("the parts
not unit-tested") quietly implies *unchecked* rather than *checkable*.

A harness that runs in CI converts that from a promise into a gate.

## What already exists, and what actually has to be built

`scripts/screenshots/` is further along than a first glance suggests, and this
spec's first draft got it wrong. Recording the correction because it changes what
Phase 1 is:

- **The mock speaks every locked route already** — `pairConfirm`, `ingest`,
  `related`, `itemsFetch`, `resolve`, `agents`, `agentRuns`, `health`, plus a
  `/sample` article page to inject the panel into. An earlier reading claimed
  ingest/related/fetch were missing; they are in the `switch` at
  `mock-gateway.ts:91`, not the `if` chain above it.
- **`handleRequest` is already pure** `Request → Response` (`:50`), with a
  separate Node adapter — so it is unit-testable without a socket, and can grow a
  parameter without growing a dependency.
- **`capture.ts` already loads the built extension into real Chromium**, seeds a
  paired connection, and resolves the extension id off the MV3 service worker.

So the gap is not coverage of routes. **It is that the mock cannot vary.** Every
route returns one fixture, so it models the happy path and nothing else — while
verification is almost entirely about the other paths: a resolve that misses, a
fetch that returns `not-configured`, a clip that 429s, a gateway that stops
answering. That, plus a runner that asserts instead of screenshotting, is Phase 1.

## The six decisions

### 1. Scenarios, not global state

`handleRequest(req)` becomes `handleRequest(req, scenario)`, and each test starts
its own mock on its own port with its own scenario object. No shared mutable
state, no control endpoint, no ordering dependency between tests, and nothing to
reset between them.

The alternative — a `POST /__scenario` control route mutating a running server —
was rejected. It makes every test's meaning depend on what ran before it, which
is the standard way a browser suite becomes flaky, and flake is the one failure
mode that would make this gate worse than nothing (see decision 6).

Within a scenario, **resolve keys off the requested `url`**, so a single run can
hold a page that resolves, a page that misses, and a page that is unrecognised —
which is exactly what the capture and related sections need in one browser
session.

A scenario is a plain object with per-route overrides and a default; anything it
does not name falls back to today's fixture, so existing behaviour is the
zero-config case and the screenshot script needs no scenario at all.

### 2. One launcher, shared with the screenshot script

The knowledge in `capture.ts` is the most expensive thing in this repo to
rediscover, and all of it is load-bearing:

- `headless: true` resolves to Playwright's *headless shell*, which silently
  loads no extensions — the MV3 worker never appears. The fix is
  `headless: false` plus an explicit `--headless=new` flag.
- The extension id is generated at load time and must be read from the service
  worker, which registers lazily and needs a page opened first, with a timeout so
  a failure is loud rather than a hang.
- The whole script runs under **node, not bun**: Playwright drives Chromium over
  `--remote-debugging-pipe`, which needs stdio fds 3/4, and Bun on Windows does
  not wire them up — every launch hangs until timeout.

That moves into a shared launcher fixture consumed by both the screenshot script
and the e2e suite. Two copies would drift, and drift in *this* code does not
present as an obvious break — it presents as flake, which is the thing we are
least able to afford.

### 3. `@playwright/test` as the e2e runner

A new devDependency; only bare `playwright` is present today. It buys the three
things that make a browser gate trustworthy — automatic retries, trace-on-failure
artifacts, and per-worker browser isolation — none of which are worth hand-rolling
on top of Vitest.

Vitest remains the unit runner. The two do not mix: `bun run test` stays exactly
what it is, and `bun run test:e2e` is separate. This matters for the Sonar
coverage gate too, which reads `coverage/lcov.info` from the unit run and must not
start seeing browser runs.

**No runtime dependency is added.** The "bundled, no runtime deps" rule
(`CLAUDE.md`) constrains what ships in `dist/`; this is dev-only, like
`playwright` and `@mozilla/readability` already are.

### 4. `test/e2e/`, one file per checklist section

A section maps to a file, so what is covered is legible without reading the
assertions. Phase 1 lands four:

| File | Section |
| --- | --- |
| `test/e2e/related-lane.e2e.ts` | Related lane (richer rows) |
| `test/e2e/capture.e2e.ts` | Capture as the last resort (C3.2) |
| `test/e2e/service-lanes.e2e.ts` | Service lanes (C2.3) |
| `test/e2e/input-lanes.e2e.ts` | Lanes that take an input (C2.5 · glossary · 4.2) |

**One of the four has no numbered steps to map.** Sixteen of the seventeen
sections are numbered lists — 136 steps in total — but *Related lane (richer
rows)* is a single un-numbered bullet, which a reviewer of the 4.1 slice already
flagged as an outlier against every sibling section. The coverage markers of
decision 6 need something to attach to, so this phase **numbers that section**
as part of covering it, matching its siblings. That is a docs change the harness
forces, not scope creep.

### 5. CI: a second job, not a bigger first one

`ci.yml` gains an `e2e` job beside `build-test` — ubuntu-24.04, build, install
Chromium, run, upload traces on failure. Separate rather than appended so a
browser failure is distinguishable at a glance from a typecheck failure, and so
the existing job's runtime is untouched.

### 6. The honesty rule, and the flake rule

Two rules that are the point of the exercise rather than decoration.

**Coverage cannot silently diverge from the checklist.** Each e2e file names, in
its header, the checklist steps it covers **and** the steps in its section it
deliberately cannot. `development.md` gains a per-step marker. Without this the
suite and the document drift into disagreeing about what has been verified —
which is precisely the confusion that produced this debt.

Some steps are **permanently human**, and the harness must not pretend otherwise:

- whether Chrome actually *bound* `Alt+Shift+R` — a browser-level fact
  (`suggested_key` is a suggestion; the C1.5 brief exists because it silently
  failed to bind);
- native extension context-menu clicks, which are not in the page and not
  drivable by Playwright;
- anything requiring a real connector's data, which a mock cannot honestly stand
  in for.

The harness can exercise the *shared handler* those triggers converge on — C1.5's
"one handler, several triggers" — but never the binding. Claiming the binding is
covered would be the dishonest kind of green.

**A flaky gate is worse than no gate.** People learn to re-run a flaky job, and
then it stops being a gate at all while still costing everyone time. So: no
arbitrary sleeps; assert on observable state, never on elapsed time; one scenario
and one mock port per test; and any test that cannot be made deterministic is
deleted rather than retried into submission.

## Layers

- `scripts/screenshots/mock-gateway.ts` — `handleRequest` grows a scenario
  parameter; `startMockGateway` takes a scenario and a port. Still pure at its
  core, still unit-testable, still the only place the wire fixtures live.
- `scripts/screenshots/gateway-fixtures.ts` — grows the scenario type and the
  named scenarios Phase 1 needs (a miss, a `not-configured` fetch, an
  unrecognised page).
- `scripts/e2e/launch.ts` — **new**: the shared launcher, factored out of
  `capture.ts` with its comments intact.
- `scripts/screenshots/capture.ts` — consumes the launcher; otherwise unchanged.
- `test/e2e/*.e2e.ts` — the four suites.
- `playwright.config.ts` — **new**: runner config, retries, trace on failure.
- `.github/workflows/ci.yml` — the `e2e` job.
- `docs/development.md` — per-step coverage markers.

## Testing the harness itself

The mock's scenario routing is pure, so it gets ordinary Vitest unit tests
alongside the existing ones — a scenario override returns the override, an unnamed
route falls back to the default fixture, and resolve keys off the URL. The
launcher is exercised by the suites themselves; a broken launcher fails every e2e
file at once, loudly, which is the correct behaviour for it.

## Not in this phase

- **Sections belonging to Phases 2 and 3.** Named in the phasing table agreed with
  the maintainer, not re-litigated here.
- **Firefox.** The harness loads the Chrome build. Firefox's MV3 extension loading
  differs enough to be its own decision, and `check-build` already guards
  per-target completeness.
- **Visual regression.** Screenshots stay a store-asset concern; asserting on
  pixels would make this gate flaky by construction.
- **Replacing `development.md`.** The document survives Phase 1 with markers
  added. It is pruned to the genuinely-human remainder only after Phase 3, when
  that remainder is actually known.
