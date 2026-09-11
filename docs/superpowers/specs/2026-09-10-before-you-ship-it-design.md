# C10 — Before you ship it

**Status:** design · 2026-09-10

## 1. The problem

The client answers seven questions about the page you are on. None of them is
the one you ask immediately before a deploy: *is this safe to ship right now?*

The gateway already answers it. `GET /v1/preflight/deploy` returns a deploy
verdict over three checks — active P1 incidents, failing CI runs, open merge
conflicts — and `GET /v1/metrics/dora` returns the four DORA metrics for a
service. Both are contracted, shipped, and have never been read by this client.

They are reachable **today**. Both sit on `dispatchReadOnlyDataGet` in
`packages/gateway/src/ipc/http-server.ts` — the same public, no-bearer table
this client already reads `GET /v1/connectors` from. No new token scope, no
re-pairing, no upstream work required to start.

One thing blocks them, and it is the whole of this phase's novelty: **the client
does not know which Nimbus service the page in front of it belongs to.**

## 2. `deploy.preflight` is not `agents.preflight`

Before anything else, because the names collide and one of them is a trap.

`agents.preflight` is a member of `EXTERNAL_EXCLUDED_AGENT_METHODS`
(`packages/gateway/src/ipc/agents-rpc.ts`) — deliberately absent from every
external surface, because a caller that can invoke it can queue consent prompts
on the owner's machine. It will never appear in the `GET /v1/agents` roster.

`GET /v1/preflight/deploy` is a different thing entirely: a side-effect-free
read over the local index, on the public read-only table.

This matters beyond trivia. Since C6 the panel offers only lanes the roster
publishes (`src/background/agents-capability.ts`). A lane registered as
`preflight` would be withheld on every gateway forever, and the roster check
would *look* correct while testing a completely different thing upstream has
decided must never be exposed. This is the same family of error as C2.1's
`whyPeek`, and it is why §4 does not make this a lane.

**Naming rule:** `deploy-preflight` in code, "Deploy readiness" in the UI. Never
bare `preflight`.

## 3. The service binding — the new concept

A Nimbus **service** is a `[metrics.dora.<id>]` block in the gateway's own
config, carrying `repos = [...]` as provider URNs. It is not anything this
client models. `PRODUCT_SERVICE_ID` in `src/shared/recognise/registry.ts` maps a
product to its *connector* id (`"github"`, `"jenkins"`) — a different axis, and
not what these routes want.

The gateway holds the reverse map internally (`buildServiceIdentityResolver` in
`packages/gateway/src/metrics/service-identity.ts`) and even assembles a
`knownServices` list — but only for the I13 write dispatcher. **No GET route
exposes either.** §7 proposes one; this section is what ships without it.

### 3.1 The binding scope — what a binding is keyed by

A binding answers "this **repo-level scope** maps to that Nimbus service". The
client has no such coordinate today, and `Recognition` cannot be made to yield
one by string-splitting:

- `ref` is documented as *"Human header text"* / *"Short identity for the
  header"* and on a `pr` it is per-PR (`"acme/web #482"`), so it identifies the
  wrong thing at the wrong granularity.
- `forgeFile` carries `{ repo, refAndPath }` but **only** on `kind === "file"`.
- Splitting `ref` per product is exactly the drift `forgeFile`'s own comment
  says the registry exists to prevent: "the three forges spell the same
  coordinate differently and deriving it twice is the drift".

So the registry supplies it, the same way it supplies `forgeFile`:
`ProductRule.match` gains an optional `scope` on `Match`, carried through to
`Recognition`. Each product spells its own.

**It is not always a forge repo, and the type must not pretend otherwise.**
GitHub, GitLab and Bitbucket yield `owner/repo`. **Jenkins yields a job path** —
a job hierarchy, not a repository, and one that need not resemble the
`repos = ["github:owner/repo"]` URNs in the gateway's config at all. That is
fine: the scope's only job is to be a stable key the user binds *once*. It is
never sent to the gateway and never parsed by it. The service id is what
crosses the wire.

```ts
// src/shared/services.ts — pure: the type, its guard, the slug→id guess
export interface ServiceBinding {
  readonly product: Product;        // which forge or CI product
  readonly scope: string;           // registry-supplied repo-level key
  readonly serviceId: string;       // the Nimbus [metrics.dora.<id>] id
  readonly defaultBranch?: string;  // target_ref fallback (§4.3)
}
```

Keyed by `${product}:${scope}`. A product whose rule supplies no `scope` offers
no deploy readiness — the section simply does not appear, the same way `doc`
carries no lane at all.

### 3.1.1 Storage, and the writer that has to be single

Persisted by `src/background/service-binding-store.ts`: no secret, filtered
through its guard on read (stored data is external input, never cast), values
bounded at the guard by the route's own 1..64 limit on `serviceId`.

**Unlike `origin-store.ts`, this store has two would-be writers** — the panel's
inline bind and the Options management table — and that changes the design.
`origin-store.ts` is safe because `setOrigins` has exactly one caller
(`options.ts:314`, `getOrigins() → transform → setOrigins()`); a second writer
would make that read-modify-write a lost-update race.

`createWriteChain()` from `keyed-store.ts` **does not fix this on its own**. It
is an in-memory lock scoped to one JS context; the Options page and the service
worker are different contexts, so a chain held in the worker would serialize the
worker against itself while Options overwrote it regardless — a race that looks
fixed and is not.

The fix is upstream of the lock: **the service worker is the only writer.**
Options mutates bindings by messaging the worker (§6.2) rather than writing
`chrome.storage` directly, and the worker serializes its own writes with
`createWriteChain()`. Reads stay direct from either context — `chrome.storage`
is shared, and a stale read costs nothing here.

### 3.2 Validation with no new route

The client cannot list services. It does not need to.

An unknown service id does not error. `unconfiguredEnvelope`
(`packages/gateway/src/ipc/preflight-rpc.ts`) returns a normal envelope with
`verdict: "warn"` and `gap: "unknown_service"` on all three checks. So **binding
validates by asking**: the Bind action fires one preflight call with the typed
id, and refuses to save an id every check reports as `unknown_service`.

Upstream separated `unknown_service` from `no_repos` deliberately (F24) so this
is unambiguous: a service that exists with no repos bound is a different, more
fixable problem, and the client says so differently — it saves that binding and
reports the gap.

### 3.3 The gesture

Bind **inline, in the panel**, where you noticed it was missing. The
deploy-readiness section on an unbound scope shows an input pre-filled with a
guess — the last path segment of the scope, so `acme/payments-api` seeds
`payments-api` — and validates on submit. The guess is a convenience only; a
Jenkins job path will often seed nonsense, and the user retypes it.

Options gains a read-and-manage table of existing bindings, the same shape
configured origins already have: see what is bound, correct a typo, drop a
binding when a service is renamed upstream. Binding is a panel gesture;
*managing* bindings is an Options one. Both go through the worker (§3.1.1).

## 4. Deploy readiness is a section, not a lane

It renders like a lane and is not one.

**Rejected — an eighth member of `AGENT_LANES`.** Maximum reuse, but it needs an
exemption from the C6 roster gate (§2), a fabricated `runId` for a store built
entirely around poll cycles, and it collides by name with an agent upstream
refuses to expose. Carving an exception into the invariant C6 exists to enforce,
to admit the one reader that is not an agent, is how that invariant stops
meaning anything.

**Rejected — a new "direct lane" kind in `LaneState`.** Honest, and one
interaction model. But it perturbs `AGENT_LANES`, `LANE_RULES`, `AGENT_ERRORS`,
`agent-run-store.ts` and `agents-capability.ts` at once, each carrying its own
exhaustiveness invariant, to serve a single synchronous non-agent read.

**Chosen — its own panel section, rendering through the lanes' pure views.**
Related and the capture offer are already sections rather than lanes; this joins
them. Nothing in the agent-lane machinery moves, no exemption is needed, and the
roster gate is never consulted because this was never an agent. The cost is that
expand/collapse and loading affordances are implemented once more rather than
inherited — paid once, in a pure module, against not weakening a live invariant.

### 4.1 Where it lives

`src/panel/deploy/` — `deploy-section.ts` (the in-page controller) and a pure
`deploy-view.ts`, rendering through the existing views in `src/panel/findings/`.

**It does not go inside `createPanel`.** That function is roughly 1,360 lines of
a 2,126-line `panel-in-page.ts`; ROADMAP flagged the file as a smell at 1,939
lines and it has grown since. `panel-in-page.ts` gains one mount call and
nothing else. Untangling `createPanel` is its own work and is **not** in this
phase — this design only declines to make it worse.

### 4.2 Surfaces

**`pr` and `build`.** Not `home`, `issue`, `doc`, `incident` or `file` — and the
reasons differ, which an earlier draft of this section got wrong by giving them
all the same one.

- **`home` is excluded because it has no scope at all.** `homeMatch`
  (`src/shared/recognise/rule.ts`) returns `ref: ""` by construction, constant
  per product, and its own comment says "nothing resolves a dashboard". It is
  the product root, not a repo landing page. There is nothing to key a binding
  by, so there is no service to ask about. "Pick one of my services" is a real
  question, and §5's page is where it already gets a picker.
- **`file` is excluded on judgment, not for want of coordinates.** It has both:
  `forgeFile` carries `{ repo, refAndPath }`. Reading a source file is simply
  not a pre-deploy gesture, and a deploy verdict on it would be noise on the
  surface C7 built for a different question. This one could be revisited on
  evidence; the others could not.
- `issue`, `doc` and `incident` supply no repo-level scope.

### 4.3 `target_ref`

Required (1..255 chars) and matched **exactly** against `metadata.branch` in
`selectFailingCiRuns` — a branch name, never a SHA or a tag. Resolved in order:

1. The resolved item's `metadata.branch`, via `GET /v1/items/{id}` — the
   normal path on both `pr` and `build`.
2. The binding's `defaultBranch`, when the page resolves to no item, or to one
   carrying no branch.
3. Neither — the CI check goes dark and the section says which one and why.

`GET /v1/items/resolve` cannot supply this: it answers
`{ id, service, type, title, url, modified_at }` and deliberately carries no
metadata ("Metadata only, NEVER a body — resolve is a resolver"). The full row,
including `metadata`, comes from the public `GET /v1/items/{id}`.

**That read happens in the background worker, never the panel.**
`GET /v1/items/{id}` returns the item `body`; only the branch string may cross
into the page. Same rule that keeps the token out of the DOM, and the same place
C9 resolves item ids.

Degradation is partial by construction: **only `failing_ci_runs` is ref-scoped.**
`active_p1_incidents` and `merge_conflicts` are service-wide and answer with no
ref at all. A missing branch costs one check of three, not the answer.

### 4.4 The rendering rule that is load-bearing

`verdict` has two values. `warn` is returned both for "found problems" and for
"could not evaluate" — upstream chose it for the latter because it is the only
value that fails closed in every consumer, old and new, and the reason travels
in the `gap` instead.

So: **`count: 0` with `gap: "unknown_service"` means "could not evaluate"** — not
"all clear", and not "problems found". The section renders the gap, never the
count alone. Every `PreflightGap` member gets its own sentence.

### 4.5 Links

`IncidentFinding`, `CiFinding` and `PrFinding` each carry `url: string | null`.
Titles render as links through `safeHttpUrl`, the same path C8.1 established and
C9 finished. This is the first surface to arrive with links already in hand
rather than earning them a phase later.

### 4.6 The wire, verified

Transcribed from `packages/gateway/src/preflight/preflight.ts`. `src/shared/deploy.ts`
declares these and nothing beyond them; every field is guarded, never cast.

```ts
export type PreflightVerdict = "ok" | "warn";   // two values. NOT "pass"/"clear".

export type PreflightGap =
  | null
  | "unknown_service"
  | "no_pagerduty_mapping"
  | "no_repos"
  | "unknown_mergeable_state"
  | "pagerduty_urgency_without_priority";

export interface PreflightCheck<F> {
  readonly count: number;
  readonly findings: readonly F[];
  readonly gap: PreflightGap;
}

export interface DeployPreflightResult {
  readonly service: string;
  readonly target_ref: string;
  readonly computed_at: string;          // ISO 8601
  readonly verdict: PreflightVerdict;
  readonly checks: {                     // a keyed dictionary, not a list
    readonly active_p1_incidents: PreflightCheck<IncidentFinding>;
    readonly failing_ci_runs: PreflightCheck<CiFinding>;
    readonly merge_conflicts: PreflightCheck<PrFinding>;
  };
}
```

Findings: `IncidentFinding { id, title, status: "triggered"|"acknowledged",
severity, opened_at_ms, pagerduty_service_id, url }`; `CiFinding { id, title,
conclusion: "failure"|"cancelled"|"timed_out", modified_at_ms, branch, head_sha,
url }`; `PrFinding { id, title, number, mergeable_state, modified_at_ms, url }`.
`url` is `string | null` on all three.

Request bounds, enforced client-side before sending so a rejected request is
never round-tripped: `service` 1..64, `target_ref` 1..255, `max_findings` an
integer 1..50 defaulting to 10.

There is **no** `no_ref`, `missing_target_ref`, `no_ci_connector` or
`service_unconfigured`. A missing ref is not a gap member — it manifests as
`failing_ci_runs` matching nothing, which §4.3 and §4.4 handle.

## 5. The DORA page

`src/dora/` — `dora.ts` → `dora.js`, plus `dora.html`/`dora.css` and a pure
`dora-view.ts`. Mirrors `src/ledger/` exactly, which is the closest existing
shape: a page over a gateway read, with a pure view module beside it.

The service picker is seeded from §3's bindings, which is why this is slice two.

### 5.1 Nested windows, not a trend

`GET /v1/metrics/dora` takes `since` and **no `until`**. Every window therefore
ends at *now*: 7d, 30d and 90d are three **nested** windows, not three
consecutive periods. Disjoint periods are not expressible on the current
contract at all.

Stitching them into a line would draw a slope that means nothing — the same
metric at three resolutions, which any reader would take as change over time.
**The page does not draw a line.**

It renders the four metrics across the three nested windows side by side, each
column labelled as a window ending now. That is still directional, and it is the
true signal: a change-failure rate worse over 7 days than over 90 is a real
statement about the recent past. A slope between overlapping windows is not.

`until` is proposed upstream (§7). A genuine series lands the day it does — the
pattern C7's file lanes and C9's links both followed.

### 5.2 Honesty rules

```ts
export type DoraGap =
  | null
  | "unknown_service"
  | "no_pagerduty_mapping"
  | "no_repos"
  | "no_deployment_data"
  | "low_sample"
  | "approximate_lead_time"
  | "mixed_source";

export interface DoraMetricValue {
  readonly value: number | null;
  readonly unit: string;
  readonly sample: number;
  readonly gap: DoraGap;
}

export interface DoraMetricsResult {
  readonly service: string;
  readonly since_ms: number;
  readonly computed_at: string;
  readonly metrics: {
    readonly deployment_frequency: DoraMetricValue;
    readonly lead_time_for_changes: DoraMetricValue;
    readonly change_failure_rate: DoraMetricValue;
    readonly mttr: DoraMetricValue;
  };
}
```

Every field is rendered:

- A `null` value is a **gap**, never a zero.
- `sample` is always shown. `low_sample` fires below three.
- `approximate_lead_time`, `no_deployment_data`, `mixed_source`, `no_repos`,
  `no_pagerduty_mapping` and `unknown_service` each print their own sentence.

A metrics page that hides its own uncertainty is the failure mode here, and
these four numbers carry theirs on the wire. They get shown.

### 5.3 Three reads, independently fallible

The three windows are **three separate GETs**, issued concurrently through
`Promise.allSettled` — never `Promise.all`, which would let the slowest or
least-available window discard two good answers.

Each column renders its own outcome. A window that fails shows a failed column
beside the two that answered, naming the window that could not be read; it does
not blank the page, and it is never drawn as a zero or an empty metric. The page
is in an error state only when all three fail.

`since` is sent as the route's relative form (`7d` / `30d` / `90d`), which is
what it parses, rather than a client-computed epoch — one less thing to be
wrong about the boundary.

### 5.4 Getting there

`dora.html` is reached the way `ledger.html` and `brief.html` already are:
`chrome.tabs.create({ url: chrome.runtime.getURL("dora.html") })`, from a link
in Options beside the existing Activity and Briefs links.

It also accepts `?service=<id>`, and the deploy-readiness section links to it
that way when a scope is bound — so the metrics for the service you are looking
at are one click from the verdict about it. An absent or unknown `service`
parameter opens the picker rather than erroring.

## 6. The clients

`src/background/deploy-client.ts` holds both GETs, reusing `http-json.ts`'s
`readJson` and `isObject`. `src/shared/deploy.ts` carries the pure envelope
types and guards; `src/shared/dora.ts` the same for the metrics envelope.

**Neither client needs `parseScopeGap`.** These routes are unauthenticated, so
there is no 403 path, no `not_paired`, no scope gap, and no pasteable
`nimbus clip scopes` command. The error vocabulary is strictly smaller than the
agent lanes': unreachable, malformed, or an answer. This is worth stating
explicitly because every other client in `src/background/` has the scope path,
and its absence here is a property of the route, not an oversight.

`GATEWAY_PATHS` in `src/shared/gateway.ts` gains three entries — the single
list, as always:

```ts
preflightDeploy: "/v1/preflight/deploy",
metricsDora: "/v1/metrics/dora",
/** BASE, not a complete path: callers append `/${encodeURIComponent(id)}`. */
items: "/v1/items",
```

`items` is a base, following the `agents` / `agentRuns` precedent already
documented in that file: a static map cannot express a path parameter, and a
second map is what the resolve slice existed to delete.

### 6.1 The message envelope

The panel is a content script, Options and `dora.html` are extension pages;
none holds a token and none calls the gateway. Everything crosses
`chrome.runtime` through `src/shared/messages.ts`, `kind`-discriminated and
guarded there like every existing message — external data is `unknown` until a
guard narrows it, never `any`.

Four requests, and their replies:

- `deploy-preflight` — `{ product, scope, targetRef? }` → the envelope, or a
  refusal naming `unbound` / `unreachable` / `server_error`, carrying the slug
  guess when unbound so the panel can seed its input.
- `service-bindings-list` — the bindings, for the Options table and the DORA
  page's picker.
- `service-bind` and `service-unbind` — the **only** mutation path (§3.1.1),
  used by both the panel and Options. `service-bind` answers `unknown_service`
  when §3.2's validating call refuses the id.
- `dora-metrics` — `{ serviceId, since }` → one window's envelope. The page
  sends three (§5.3).

### 6.2 Gap vocabulary as a `Record`, not a switch

Both gap unions render through `Record<PreflightGap, string>` and
`Record<DoraGap, string>` — **not** a switch with a `satisfies never` backstop.

A `Record` forces every union member at the type level, can be proven exhaustive
by deleting an arm and watching the build go red, and leaves no permanently
unreachable line for coverage to count against the gate. Both halves of that are
traps this repo has already hit.

## 7. Proposed upstream — not yet contracted

Designed here, decided in the [Nimbus gateway repo](https://github.com/nimbus-agent/Nimbus).
Its own worktree, in parallel; the client ships against §3's fallback regardless
and adopts these if and when they land.

1. **`GET /v1/services`** — the configured service ids and their repo URNs, so
   repo → service resolves with no gesture and cannot drift from the gateway's
   config. Thin: the read-only server already loads exactly this via
   `resolveKnownServices`, but hands it only to the write dispatcher.
2. **`until` on `GET /v1/metrics/dora`** — makes disjoint windows expressible,
   and a real time series with them (§5.1).

**Where `/v1/services` mounts is upstream's decision, not this document's.** It
exposes the owner's service and repo configuration; whether that belongs on the
public read-only table beside `/v1/items` and `/v1/connectors`, or behind a
scope, is a call for the repo that owns the contract. This design states the
shape the client needs and nothing more.

If `/v1/services` lands, §3's binding becomes an **override** rather than the
only path — it is not wasted work, because a service whose repos are not
configured upstream still needs one.

## 8. Slices

- **S1 — the binding and the section.** The registry `scope` field and its
  per-product spellings (§3.1), `src/shared/services.ts`,
  `service-binding-store.ts` with the worker as sole writer,
  `src/shared/deploy.ts`, `deploy-client.ts`, the `messages.ts` envelope,
  `src/panel/deploy/`, the Options bindings table, `GATEWAY_PATHS`. The
  decision-shaped half, and the half whose new concept has to prove itself.
- **S2 — the DORA page.** `src/shared/dora.ts`, `src/dora/`, the build-entry
  wiring, the Options and panel links, reusing S1's bindings for the picker.
- **Upstream** runs alongside from day one.

The `scope` field is S1's first task, not a side effect of it: nothing else in
S1 has a key to work with until the registry supplies one.

## 9. Testing, and the gates that will fire

Unit (Vitest): `services.test.ts` (guard, bounds, the slug guess),
`service-binding-store.test.ts`, `deploy-client.test.ts` (wire parsing, every
gap member, the malformed-body path), `deploy-view.test.ts` and
`dora-view.test.ts` (jsdom via docblock).

E2E: `test/e2e/deploy-readiness.e2e.ts`. `scripts/mock-gateway.ts` gains both
routes plus `GET /v1/items/{id}`, or the suite and the store screenshots have
nothing to answer them.

Gates that fire on this change:

- **`build-artifacts.test.ts`** — the `dora` entry must land in `ENTRIES` **and**
  `HTML_CSS` in `esbuild.mjs` **and** `REQUIRED_FILES` in `check-build.mjs`.
  Missing the last one leaves a bundle nothing guards while check-build still
  prints OK — the silent direction, and the one that ships.
- **`e2e-coverage.test.ts`** — new `COVERS` ids need matching
  `<!-- e2e:<id> -->` markers in `development.md`.
- **`doc-references.test.ts`** — ROADMAP's link to this spec must resolve.
- **`store-listing.test.ts`** — expected to stay green. Both routes are
  loopback; `host_permissions` and `optional_host_permissions` are both
  unchanged. If that stops being true, `store/listing.md`'s permission
  justifications change in the same commit.

## 10. Before this spec is pruned

Durable content moves to `docs/architecture.md` **before** this file is deleted,
never left here to die with it:

- The service-binding concept, its storage shape, and why the client holds a map
  the gateway also holds internally.
- §2 — `deploy.preflight` versus `agents.preflight`, and why the roster gate
  must never be consulted for this section. This one is the most likely to be
  re-discovered painfully.
- §4's section-not-a-lane decision and the two rejected alternatives.
- §4.4's `warn` rule, and §5.1's nested-windows reasoning.
- §3.1's binding scope — in particular that it is **not** a forge repo on
  Jenkins, and why `ref` can never be it.
- §3.1.1's single-writer rule. A future editor "simplifying" Options to write
  storage directly, as `origin-store.ts` does, reintroduces the lost update
  silently.

ROADMAP gains Phase C10; `CHANGELOG.md`'s `[Unreleased]` records the
user-facing half as each slice lands.
