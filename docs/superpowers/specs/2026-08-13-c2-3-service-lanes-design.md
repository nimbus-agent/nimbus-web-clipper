# Service lanes — ask about the product, on the page that asks it

**Status:** design, approved 2026-08-13. Implements roadmap **C2.3**.

**Upstream read at:** `Nimbus` @ `ea37e0d0` (past `v1.27.0`). Every contract claim
below was read from that source, not from this repo's roadmap — which is stale in
three places, corrected in the last section.

## What this builds

Three new agent lanes — **catchup**, **decisions**, **ownership** — on a new class
of recognised page: the product's own dashboard.

Item pages are untouched. `impact` and `expert` keep their `["pr"]` gate and their
resolve-backed path. What this slice adds is a second, parallel way for a lane to
exist: gated on the *product* rather than on a resolved item.

## Why now

C2.1 shipped two lanes on pull requests. C2.3's brief then proposed mapping the
remaining agents onto the pages they belong on — and named `catchup`, `decisions`
and `ownership` as the browser-viable set, because all three accept `{ service }`,
which the recogniser already knows.

That much is true. What the brief did not confront is that **those three answer a
different question than the two already shipped.** `impact` and `expert` answer
about *this pull request*. `catchup`, `decisions` and `ownership` answer about
*the whole connector*. Dropping them onto item pages would put the same answer on
every page of that host — which collides with C2.3's own rule, written into the
brief: *"A lane that fires everywhere is noise, and noise is how ambient UI dies."*

So the lanes need a page whose scope matches the scope of the answer. That page is
the dashboard.

## The five decisions

### 1. `service` is the connector id, and the client already knows it

`item.service` is written by each connector from a flat `SERVICE_ID` constant —
`"bitbucket"`, `"github"`, `"gitlab"`, `"jenkins"`, `"jira"`
(`packages/gateway/src/connectors/bitbucket-sync.ts:17` and siblings). Not
per-repo, not per-instance. `catchup { service: "bitbucket" }` means *everything
across all of Bitbucket*.

Those five values are exactly this repo's `Product` union. That has two
consequences, and both are load-bearing:

**A service lane needs no resolve call at all.** `Recognition.product` is the
service id, so `handleAgentRun` on a dashboard goes recogniser → invoke, skipping
`resolveForAgent` entirely. There is no item to resolve, no `found` outcome to
require, and no gateway round-trip before the invoke. It also means these lanes
work on a pairing that never received the `resolve` scope — they need only
`agents`.

**The scope is coarser than "repo", so the trigger page must be too.** A repo home
page is not a tighter scope than a pull-request page — both are just
`"bitbucket"`. A repo-scoped trigger would name a precision the agent cannot
honour. The dashboard is the one page whose scope is the connector, and it is
already where a human goes to ask "what happened while I was away".

### 2. The product→service mapping is written out, not cast

A new `PRODUCT_SERVICE_ID: Record<Product, string>` lives in `src/shared/types.ts`,
carrying a comment naming it as a mirror of upstream's connector `SERVICE_ID`
constants.

Today it is an identity map, and writing it out anyway is the entire point. The
agreement between this client's `Product` union and the gateway's connector ids is
**convention between two repositories, not contract**. A cast, or a bare
`product as string`, would encode that agreement invisibly and rot silently the
day upstream renames a connector. A named map is greppable from both sides and
fails as a type error rather than as a lane that quietly asks about a service that
no longer exists.

Where a resolved item is in hand, `item.service` still wins — it is gateway-sourced
truth, and the map is only for the case where there is no item to ask.

### 3. Home is a `SurfaceKind`, so lane gating needs no new mechanism

`SurfaceKind` gains `"home"`. `LANE_SURFACES` is already
`Record<AgentLane, readonly SurfaceKind[]>`, so the three lanes declare
`["home"]` and the existing gate does the rest — including the type error that
fires when a new lane forgets to declare its surfaces at all.

This is the reason the panel gets a new header arm rather than a second panel or a
separate injected surface. The lane machinery, the run store, the error rendering
and the navigation notice are all reused unchanged; what is genuinely new is one
header arm and one recogniser branch per product.

### 4. The dashboard header is not a miss state

`HeaderState` gains a service arm: the product name, no item link, no freshness
line, no fetch button, no candidate chooser.

A dashboard has no indexed item, and **that is correct rather than a failure**. It
must not borrow copy from `not-indexed` or `unresolvable`, which describe a page
that should have resolved and didn't. Offering the C3.1 fetch button here would be
worse still: it would propose fetching a dashboard into the index as an item.

The related lane is suppressed on home. `/v1/clips/related` keyed on a dashboard's
title and URL returns noise dressed as recall.

### 5. The ambient cue stays silent on dashboards

C1.3's cue has one contract: *this page resolves to exactly one indexed item, and
here it is*. A dashboard resolves to none. A cue there would also fire on the
single most-visited page on the host, every visit — the exact noise the ambient
slice was careful to avoid, and the reason it made every non-`found` outcome
silence rather than a cue that leads nowhere.

Dashboards are panel-only: the user summons the panel, the same as C1.3 kept the
panel itself user-summoned.

## Components

| Module | Change |
| --- | --- |
| `src/shared/types.ts` | `SurfaceKind` gains `"home"`; `AGENT_LANES` gains `catchup`/`decisions`/`ownership`; `LANE_SURFACES` declares `["home"]` for the three; new `PRODUCT_SERVICE_ID`. |
| `src/shared/recognise.ts` | One dashboard branch per matcher; `KIND_NAMES.home`; `surfaceLine` handles an empty `ref`. |
| `src/background/handlers.ts` | `handleAgentRun`/`handleAgentState` branch on `kind === "home"` before `resolveForAgent`; `agentParams` grows the service arm. |
| `src/background/agent-run-store.ts` | `StoredRun.itemId` becomes a discriminated subject; `makeKey` encodes the kind. |
| `src/panel/panel-view.ts` | New `HeaderState` service arm; suppress related + fetch on home. |
| `src/panel/panel-in-page.ts` | Skip resolve and related on home; three new `LANE_TITLES`. |

### The recogniser branch

Each matcher gains a dashboard case, matched against the same `ConfiguredOrigin`
list — built-in hosts and user-configured self-hosted entries with optional path
prefixes — that item pages already use. A self-hosted Jenkins at `/jenkins` works
with no new mechanism.

| Product | Dashboard |
| --- | --- |
| GitHub | root (no segments) |
| GitLab | root, or first segment `dashboard` |
| Bitbucket | first segment `dashboard` |
| Jenkins | instance root (no segments after the prefix) |
| Jira | `/jira/your-work` (Cloud), `/secure/Dashboard.jspa` (Server) |

Two rules the matchers must hold to:

- **Item patterns are tried first.** A dashboard branch may only match paths no
  item matcher claims. The existing "the product is NEVER guessed from the path"
  rule is unchanged — the product still comes from the origin entry.
- **`ref` is the empty string, constant per product.** `sameItem` compares
  `(product, kind, ref)`, so two self-hosted Jenkins instances compare equal at
  `kind: "home"`. That is **correct, not a bug**: `service: "jenkins"` is
  literally the same scope for both, so there is no "you've moved on" to
  announce and no second cache entry to keep. `surfaceLine` returns the label
  alone when `ref` is empty, so the header reads "Jenkins dashboard" rather than
  "Jenkins dashboard · ".

Checked against the current matchers: every dashboard path above returns `null`
from its product's item matcher today — GitHub and Jenkins because a rootless
segment list fails their first guard, GitLab because `indexOf("-")` is `-1`,
Bitbucket because `/dashboard` has no repo segment, Jira because the first segment
is not `browse`. So the dashboard branch adds a case to a hole, and no existing
fixture changes meaning.

`resolveUrl` is still computed on a home recognition and is meaningless there.
Nothing may call resolve with it — see the handler rule below.

### The run store subject

`StoredRun.itemId: string` becomes:

```ts
type RunSubject =
  | { readonly kind: "item"; readonly id: string }
  | { readonly kind: "service"; readonly service: string };
```

with `makeKey` encoding the kind alongside the value. A synthetic string key
(`"service:bitbucket"`) was considered and rejected: upstream item ids are
`` `${service}:${externalId}` `` (`packages/gateway/src/index/item-key.ts:7`), so a
synthetic key would share a namespace *shape* with real ids — confusable by
inspection, and one connector rename away from being ambiguous in fact.

Entries written by the current version fail the new guard and are dropped. That
costs at most one re-run: this store is a ten-minute cache
(`AGENT_RUN_CACHE_TTL_MS`), not durable state. Keying by service also means the
answer is computed once per product rather than once per page.

### Handler rules

- On `kind === "home"`, `handleAgentRun` and `handleAgentState` **must not call
  `resolveItem`.** There is no item, and the dashboard URL would resolve to
  `unresolvable` — a miss reported for a page that was never supposed to resolve.
- `agentParams` sends `{ service: PRODUCT_SERVICE_ID[product] }` for all three
  service lanes, and nothing else. No `sinceMs`, no `minConfidence`, no `limit` —
  see *Deferred* below.
- `not_paired` still applies on home: the invoke needs a token.
- **An `AgentLane` member is the wire agent name.** `invokeAgent` passes the lane
  straight through as the agent in `POST /v1/agents/{agent}`, so `catchup`,
  `decisions` and `ownership` must be spelled exactly as upstream's handler keys.
  A lane named for the UI rather than the agent would 404 as `unsupported`.

### Lane copy

Order in `AGENT_LANES` is render order, so `catchup` is declared first — it is the
question the dashboard exists to answer.

| Lane | Title |
| --- | --- |
| `catchup` | What happened while I was away |
| `decisions` | What got decided |
| `ownership` | Who owns what |

## Error handling

Unchanged from C2.1 — the service lanes reuse `AGENT_ERRORS`, `failedResponse` and
`renderLaneBody` as they stand. Two notes specific to this slice:

- `not_resolved` is now reachable on home pages only via the recogniser gate (an
  unrecognised URL), never via a resolve outcome, because no resolve happens.
- The three new agent names are dispatched by upstream's `AGENTS_RPC_HANDLERS` and
  are absent from `HTTP_EXCLUDED_AGENT_METHODS`, so a 404 `unsupported` from them
  means an older gateway, exactly as it does for `impact`/`expert`.

## Honest gaps, recorded rather than discovered later

**`ownership` will often answer nothing useful.** It derives ownership from git
blame over configured `[[filesystem.roots]]`, and with none configured it returns a
gap-only brief: *"There are no git-aware filesystem roots configured, so no
ownership can be derived"* (`packages/gateway/src/agents/ownership.ts:80`). For a
browser-first user whose gateway indexes connectors but no local checkouts, that is
the normal case, not the edge case.

The client cannot detect this in advance — there is no read that reports whether
roots are configured — so the lane cannot be hidden when it will not answer. It
renders the gap brief, which does satisfy C2.1's bar (*a cited brief, or a plain
"couldn't answer, and here's why" — never a silent empty lane*), and the gap brief
does say what to do about it. But it is a weaker lane than the other two, and this
is recorded here rather than left for the manual pass to find.

Shipping it anyway is a deliberate call: it was the explicit scope decision for
this slice, the failure mode is honest rather than misleading, and the lane becomes
useful the moment the user runs `nimbus index add` — with no client change.

## Testing

Pure modules carry the weight, as they do today.

- **Recogniser fixtures** per product: the dashboard URL, self-hosted variants
  with a path prefix, and near-misses that must **not** match home — in
  particular any path an item matcher claims, and paths one segment away from a
  dashboard.
- **`sameItem`** across two self-hosted instances of the same product at
  `kind: "home"` — asserts equal, with the reason in the test name.
- **`surfaceLine`** on a home recognition — label alone, no dangling separator.
- **Header rendering** of the service arm: names the product, and asserts the
  absence of the fetch button, the freshness line and the item link.
- **`LANE_SURFACES` gating**: the three service lanes render on `home` and on no
  other kind; `impact`/`expert` render on `pr` and not on `home`.
- **Run store**: subject-keyed round-trip for both kinds, an item and a service
  subject that would collide under a naive key staying distinct, and an
  old-shape stored entry being rejected rather than mis-read.
- **`handleAgentRun` on a home page**: asserts `resolveItem` is **never called**,
  and that the invoked params are exactly `{ service }` with the right value.

## Deferred, with reasons

**`sinceMs`, `minConfidence` and `limit` stay unsent.** The gateway owns these
defaults and re-reads its config per call — `[decisions].min_confidence` is
resolved in `handleDecisions` precisely so an edit applies without a restart.
Adding client-side knobs would buy nothing and create a second place for the same
number to disagree.

**`glossary` is not in this slice.** It takes `{ term?, limit? }` and is
genuinely item-adjacent — the useful version is driven by a selection, which is a
different trigger shape than "expand a lane on a recognised page" and needs
selection plumbing into the lane path that does not exist. Its own slice.

**Repo, project and job pages get no lanes.** They read as a tighter scope than
`{ service }` delivers. If upstream ever narrows these agents below the connector,
this is the first thing to revisit.

## Out of scope

- Any change to the C2.1 lanes, their params, or their resolve-backed path.
- The ambient cue (C1.3) — unchanged, and deliberately silent on dashboards.
- The C3.1 fetch path — a dashboard is not a fetchable item.
- C2.5 (lanes on a chosen candidate) — a separate, item-scoped slice.

## Roadmap corrections this slice carries

The C2.3 brief is stale in three ways, corrected in the same commit — the same
convention C2.1 followed when it corrected its own `why`/`whyPeek` claim.

1. **The agent count.** The roadmap says thirteen agents ship. Upstream at
   `ea37e0d0` has more, including `agents.negotiate`.
2. **The HTTP exclusion list.** The roadmap names three exclusions; there are
   four. `agents.negotiate` is excluded for a reason distinct from the other
   three — it has no side effects and its shape fits the runId+poll contract
   fine, but combined with `--person` it would let any holder of the `agents`
   token assemble a contribution dossier on any indexed person without the owner
   initiating it.
3. **The framing of the browser-viable set.** The brief presents `catchup`,
   `decisions` and `ownership` as lanes to map onto existing surfaces. They are
   service-scoped, so they need a service-scoped surface — which did not exist
   until this slice.

## Done when

- A dashboard page on any of the five products is recognised as `kind: "home"`,
  and the panel names the product without claiming an indexed item.
- The three service lanes appear there and nowhere else; `impact` and `expert`
  appear on pull requests and not on dashboards.
- Expanding a service lane invokes with `{ service }` and **makes no resolve
  call**, verified by test.
- A second dashboard visit within the cache TTL replays the stored answer rather
  than re-invoking, and does so across two different pages of the same product.
- `ownership` with no configured roots renders its gap brief, not an empty lane.
- The ambient cue does not fire on a dashboard.
- `typecheck`, `lint`, `test`, `build` and `check-build` are green.
