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

### 3.1 The shape

```ts
// src/shared/services.ts — pure: the type, its guard, the slug→id guess
export interface ServiceBinding {
  readonly product: Product;        // which forge
  readonly repo: string;            // the repo coordinate the recogniser holds
  readonly serviceId: string;       // the Nimbus [metrics.dora.<id>] id
  readonly defaultBranch?: string;  // target_ref fallback on `home`
}
```

Keyed by `${product}:${repo}`. Persisted by
`src/background/service-binding-store.ts`, modelled on `origin-store.ts`: no
secret, filtered through its guard on read (stored data is external input, never
cast), and readable from Options because `chrome.storage.local` is shared across
extension contexts. It joins the `*-store.ts` set **without** `keyed-store.ts`,
for the reason that file's header already gives.

`serviceId` is validated against the route's own bound — 1..64 characters — at
the guard, not at the input, so a binding restored from storage is checked by
the same rule as one typed today.

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
deploy-readiness section on an unbound repo shows an input pre-filled with a
guess — the last path segment of the repo slug, so `acme/payments-api` seeds
`payments-api` — and validates on submit.

Options gains a read-and-manage table of existing bindings, the same shape
configured origins already have: see what is bound, correct a typo, drop a
binding when a service is renamed upstream. Binding is a panel gesture;
*managing* bindings is an Options one.

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

`pr`, `build`, `home`. Not `issue`, `doc`, `incident` or `file`: a deploy
verdict is about a service at a ref, and those four surfaces supply neither.

### 4.3 `target_ref`

Required (1..255 chars) and matched **exactly** against `metadata.branch` in
`selectFailingCiRuns` — a branch name, never a SHA or a tag. Resolved in order:

1. The resolved item's `metadata.branch`, via `GET /v1/items/{id}`.
2. The binding's `defaultBranch`.
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

`DoraMetricValue` is `{ value, unit, sample, gap }` and every field is rendered:

- A `null` value is a **gap**, never a zero.
- `sample` is always shown. `low_sample` fires below three.
- `approximate_lead_time`, `no_deployment_data`, `mixed_source`, `no_repos`,
  `no_pagerduty_mapping` and `unknown_service` each print their own sentence.

A metrics page that hides its own uncertainty is the failure mode here, and
these four numbers carry theirs on the wire. They get shown.

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

`GATEWAY_PATHS` in `src/shared/gateway.ts` gains `preflightDeploy`,
`metricsDora` and `itemById` — the single list, as always.

### 6.1 Gap vocabulary as a `Record`, not a switch

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

- **S1 — the binding and the section.** `src/shared/services.ts`,
  `service-binding-store.ts`, `deploy-client.ts`, `src/shared/deploy.ts`,
  `src/panel/deploy/`, the Options bindings table, `GATEWAY_PATHS`. The
  decision-shaped half, and the half whose new concept has to prove itself.
- **S2 — the DORA page.** `src/dora/`, `src/shared/dora.ts`, the build-entry
  wiring, reusing S1's bindings for the service picker.
- **Upstream** runs alongside from day one.

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

ROADMAP gains Phase C10; `CHANGELOG.md`'s `[Unreleased]` records the
user-facing half as each slice lands.
