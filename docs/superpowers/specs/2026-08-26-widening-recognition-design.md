# Eleven products, and a gate that makes them honest (C1.2 · widening)

> **Status:** design, approved 2026-08-26. **Client-only** — every surface it
> consumes is already shipped and versioned upstream (`GET /v1/connectors`,
> `GET /v1/items/resolve`, `POST /v1/agents/*`). Nothing here proposes a gateway
> contract. Six slices; slice 1 is a pure refactor and slice 2 is the only one
> that changes behaviour on a shipped surface.
>
> **Shipped so far:** slice 1, the registry (#74, `a373c10`); slice 2, the
> connector-health gate (#76, `33b2f34`); slice 3, Linear + CircleCI (#87,
> `4a7cf52`); slice 4, Confluence + PagerDuty (feature commits only:
> `1739294`, `736b32b`, `177bd51`, `206a3b2` on this branch — PR not yet
> opened at the time of writing). All four landed before or alongside this
> document's own edits, so read slices 1-4 as the design they were built from
> rather than as a proposal. Two things settled under review are corrected in
> place in §4: `unknown` renders no freshness line even when the gateway
> supplies a timestamp, and the reasoning behind which states withhold lanes is now
> written down rather than assumed. Slice 4 amends its own letter in three
> places and records a gateway-side gap — see the subsection after §3's table.
> Slices 5-6 are unbuilt.

## What this delivers

The client recognises five products. The gateway ships **94 bundled connectors**
(`Nimbus/packages/gateway/src/connectors/bundled-connector-registry.ts`). This
design closes six of that gap — Linear, Sentry, Confluence, PagerDuty, Notion,
CircleCI — and, more importantly, restructures recognition so the twelfth
product is a module rather than an argument.

It also fixes a defect the widening would otherwise multiply by eleven: a
service lane on a connector the owner never configured answers *empty*, which
reads as "you have no work" rather than "Nimbus isn't connected to this".

## Findings that shaped it

### F1 — recognition is the cheapest lane in the product

`Recognition.product` **is** the gateway's connector id, so a dashboard needs no
resolve call at all (`src/background/handlers.ts:556-570`):

```ts
if (recognition.kind === "home") {
  // No resolve call: a dashboard has no indexed item, and `Recognition.product`
  // IS the gateway's connector id, so the only parameter these lanes need is
  // already in hand. This is also why a service lane works on a pairing that
  // never received the `resolve` scope — it needs only `agents`.
  return { ok: true, scope: "service", ..., service: PRODUCT_SERVICE_ID[recognition.product] };
}
```

One recogniser entry plus one service id yields three working lanes — `catchup`,
`decisions`, `ownership` — with no resolve scope, no indexed item, and no new
gateway surface. Nothing else in this repo converts a table row into three agent
answers.

### F2 — but `home` is a path, not a host

Every shipped matcher returns `homeMatch` only for an exact dashboard path: `/`
for GitHub (`recognise.ts:78-86`), `/` or `/dashboard` for GitLab, `/dashboard`
for Bitbucket Cloud, the instance root for Jenkins, and `/jira/your-work` or
`/secure/Dashboard.jspa` for Jira. A new product whose only entry is its
dashboard path therefore fires on a page few people sit on. **Item matchers are
not optional garnish on this feature — without them the widening buys far less
than the product count suggests.**

### F3 — `service` is unvalidated upstream, so an unconfigured connector answers empty

`requireCatchupParams` and `requireOwnershipParams`
(`Nimbus/packages/gateway/src/ipc/agents-rpc.ts:163`, `:699`) accept any
non-empty string up to `MAX_SERVICE_LEN`. There is no connector allowlist. A
lane asked about a service with no credential runs happily and returns nothing —
indistinguishable, in the panel, from a genuinely quiet week.

### F4 — the signal that fixes F3 already exists, and is already reachable

`GET /v1/connectors` is mounted in the same read-only HTTP server that serves
`/v1/clips`, `/v1/items/resolve` and `/v1/audit`
(`Nimbus/packages/gateway/src/ipc/http-server.ts:449`), and is classified
`{ kind: "public" }` — no bearer, no scope (`http-route-auth.ts:49`). It returns
one `ConnectorHealthSnapshot` per connector that has a `sync_state` row:
`connectorId`, `state`, `backoffAttempt`, and optionally `retryAfter`,
`backoffUntil`, `lastError`, `lastSuccessfulSync` (`connectors/health.ts:30-38`).

`state` is a seven-member union — `healthy`, `not_configured`, `degraded`,
`error`, `rate_limited`, `unauthenticated`, `paused` — and upstream is explicit
that `not_configured` and `unauthenticated` are **deliberately not folded
together**: the first means no credential was ever stored, the second means one
was presented and rejected. Their remedies differ, and so must ours.

One subtlety with teeth: `buildSnapshot` returns `not_configured` for a **missing
row** (`health.ts:411-418`), which is also the state of a connector configured
moments ago that has not yet ticked. The copy must survive both readings.

**And an absent row is the common case, not an edge one — this is a correction.**
The only production insert into `sync_state` lives inside `transitionHealth`
(`health.ts:139`), which the scheduler reaches on sync success, on pause/resume
and on error paths. A connector the scheduler has never touched therefore has no
row at all, and `getAllConnectorHealth` — which selects `FROM sync_state` — simply
omits it. That is exactly the never-configured connector this whole gate exists
for.

So **a successful read whose map omits our service id means `not_configured`, not
`unknown`.** Upstream says as much in its own code: `getConnectorHealth`, the
single-connector accessor, answers `not_configured` for that missing row, and
`engine/connector-health-caveat.ts` consumes it that way. Reading the *list*
endpoint and inventing a different meaning for absence than the gateway's own
per-service accessor gives was the error.

`unknown` narrows accordingly, and is better for it: it now means **the read
itself failed** — 404, unreachable, timeout, malformed body — which is the one
situation where ungating is right, because the gate is unavailable rather than
answered. Conflating "answered, and this connector is absent" with "could not
ask" cost the feature its most common case.

The residual risk is named under Risks below and is unchanged in kind: if our
service id is wrong, absence now says "never synced" instead of showing three
lanes. That is not worse — with a wrong id those lanes answer nothing anyway —
and it surfaces the problem instead of hiding it.

> **Status:** slice 2 shipped the earlier reading (absence → `unknown`). The
> correction above is spec-level; the code change is a follow-up, tracked
> separately, and is small: one branch in `handleResolve` plus its tests.

### F5 — six parallel tables keyed by one union

`PRODUCT_NAMES`, `PRODUCT_SERVICE_ID` (`shared/types.ts:156`), `BUILT_IN_ORIGINS`,
`BUILT_IN_SURFACES`, `MATCHERS` (`shared/recognise.ts`) and the hand-written
`PRODUCTS` set in `shared/origins.ts:11` are six independently-maintained lists
over the same five members. Adding a product means editing six places correctly.
At eleven that is a drift farm, and the one existing guard covers a single pair
of them.

## The design

### 1 · A registry, one module per product

`src/shared/recognise.ts` becomes `src/shared/recognise/`:

| File | Contents |
| --- | --- |
| `index.ts` | `recognise()`, `surfaceLine()`, `sameItem()` — the resolver, nothing product-specific |
| `registry.ts` | the ordered `PRODUCT_RULES`; every table in F5 derives from it |
| `github.ts` `gitlab.ts` `bitbucket.ts` `jenkins.ts` `jira.ts` | ported unchanged |
| `linear.ts` `sentry.ts` `confluence.ts` `pagerduty.ts` `notion.ts` `circleci.ts` | new |

Each module exports exactly one rule:

```ts
export interface ProductRule {
  readonly product: Product;            // a literal member of PRODUCT_IDS
  readonly serviceId: string;           // the gateway's connector id
  readonly name: string;                // "Linear" — today's PRODUCT_NAMES entry
  readonly hosts: readonly HostRule[];  // SaaS origins and tenant suffixes
  readonly selfHostable: boolean;       // may it appear in the Options product picker?
  match(segments: readonly string[]): Match | null;
}

type HostRule =
  | { kind: "origin"; origin: string; pathPrefix?: string }
  | { kind: "suffix"; suffix: string; pattern: string; pathPrefix?: string };
```

**The split is along the grain of the problem.** A product's host identity —
origins, tenant suffix, path prefix, permission pattern, service id — is regular
data. Its path shapes are irregular code: GitLab's `-` separator and Jenkins'
repeating `job/<name>` pairs do not express in any pattern table worth writing.
A declarative matcher DSL was considered and rejected for exactly that reason —
it would need a function escape hatch, and the two hardest products would end up
back where they started, with a new abstraction on top of them.

**Shared hosts stop being branches inside a matcher.** Confluence and Jira both
claim `*.atlassian.net`; a future GitHub Actions rule would claim `github.com`
alongside GitHub. Both resolve through `pathPrefix` plus registry order — the
generalisation of the rule `recognise()` already applies to user entries ("User
entries first so a configured prefix can win over a built-in bare host",
`recognise.ts:233`), rather than a second copy of it.

**Self-hosted origins stay siloed by product, and that is already true.**
`matchOrigin` picks the entry with the **longest matching path prefix** among
those whose origin equals the page's (`shared/origins.ts:98-114`), and
`recognise()` then runs `MATCHERS[entry.product]` — that product's matcher and
no other. Two products self-hosted on one host are therefore two entries
(`https://internal.corp/jira` → jira, `https://internal.corp/wiki` → confluence),
resolved by prefix length, and a Confluence-shaped path under a **Jira-only**
entry stays unrecognised rather than becoming a Confluence page. The registry's
`hosts` list governs **built-in** hosts only; it never widens what a user's own
entry matches. Nothing in this design changes that, and the test named under
Testing pins it.

**`Product` stays a literal union.** `types.ts` keeps one `PRODUCT_IDS` array
`as const` and derives `Product` from it, so `Record<Product, …>` exhaustiveness
still holds and the registry imports types rather than the reverse. The six
tables of F5 become derivations of `PRODUCT_RULES`; the existing drift guard
survives, now guarding the derivation instead of a human's diligence.

### 2 · Two new surface kinds

`SurfaceKind` gains `doc` and `incident`. Neither appears in any `LANE_RULES`
entry, so `laneBelongsOnSurface` returns false for every lane and the panel
renders what a Jira issue renders today: header, freshness, Related, the
`glossary` term lane, capture as last resort. Targeted fetch is NOT among them
and this originally said it was — see Amendment 5. The absence of a lane is
expressed in the type system, not in a comment.

### 3 · What each product matches

| Product | Item path | Kind | `ref` | Dashboard (`home`) |
| --- | --- | --- | --- | --- |
| Linear | `/<ws>/issue/<TEAM-123>/…` | `issue` | `TEAM-123` | `/<ws>`, `/<ws>/inbox`, `/<ws>/my-issues` |
| Sentry | `/organizations/<org>/issues/<id>/`, `<org>.sentry.io/issues/<id>/` | `incident` | `<org>#<id>` | `/issues/`, `/organizations/<org>/issues/` |
| Confluence | `/wiki/spaces/<KEY>/pages/<id>/…` | `doc` | `<KEY>/<id>` | `/wiki/`, `/wiki/home` |
| PagerDuty | `/incidents/<ID>` | `incident` | `<ID>` | `/incidents` |
| Notion | `/<ws>/<slug>-<32hex>`, `/<32hex>` | `doc` | the 32-hex id, dashes stripped | `/<ws>` |
| CircleCI | `/pipelines/<vcs>/<org>/<repo>/<n>` | `build` | `<org>/<repo> #<n>` | `/pipelines`, `/home` |

**A tenant-suffix host rule must never claim bare `/`.** `<org>.sentry.io` and
`<sub>.pagerduty.com` are `suffix` rules, and a suffix matches every subdomain —
including `status.`, `www.`, `support.` and `blog.`, which are not tenants.
A dashboard path of `/` would therefore recognise `status.pagerduty.com` as a
PagerDuty dashboard and offer three service lanes about someone else's status
page: a confidently wrong header, which is the one failure `recognise.ts`'s
opening comment exists to prevent. So every `suffix` rule's `home` paths are
specific (`/incidents`, `/issues/`), never the root. Jira Cloud already dodges
this by matching `/jira/your-work` and `/secure/Dashboard.jspa` rather than `/`;
this makes the dodge a rule. `origin` rules may still claim `/`, because a single
named host has no sibling subdomains to be confused with.

**Specific paths are necessary and not sufficient — the host must be constrained
too.** That rule alone still admits `status.pagerduty.com/incidents` and
`blog.sentry.io/issues/`: the suffix matches the host and the path is a
recognised dashboard, so both checks pass and the header is wrong again. A
must-not-match fixture for the bare root would not catch either, because neither
is the root. So a `suffix` rule additionally carries an **excluded-label list**
— `www`, `status`, `support`, `blog`, `docs`, `help` — checked against the
leftmost label, and every product's fixtures must include at least one helper
subdomain **on a recognised path**, not merely on `/`.

A denylist is the honest instrument here rather than a tenant-shaped pattern:
tenant labels are arbitrary customer strings with no structure to match on, so
there is nothing to allowlist. It will not be exhaustive. What it misses does
NOT fail the way an unknown host fails, which this paragraph originally claimed:
a missed vendor label is treated as a tenant, and the product's own matcher is
the only thing left. Amendment 4 records what shipped instead — a documented
minimum subdomain length carrying the short labels structurally, and no pretence
that an item-id pattern backstops the list.

**Sentry is `incident`, not `issue`, despite Sentry's own wording.** The kind
exists to gate lanes, and an error group poses the operational question a
PagerDuty incident poses, not the planning question a Jira or Linear ticket
poses. Grouping it with tickets would put it in the wrong bucket the day a lane
lands for either. The human-facing wording is corrected where wording belongs —
`labelFor`, which already carries this exact escape hatch for "GitLab MR" — so
the kind is `incident` and the label reads "Sentry issue".

**Self-hosted comes free.** Widening the `Product` union widens what a user's
`ConfiguredOrigin` entry may name, so self-hosted Sentry, Confluence Server and
(later) Grafana work through the existing per-origin configuration with no
further code. `selfHostable` exists to keep SaaS-only products out of that
picker.

**No manifest change.** `optional_host_permissions` is already
`["http://*/*", "https://*/*"]` (`src/manifest/manifest.ts:111`), granted
per-origin at runtime. New built-in products are `BUILT_IN_SURFACES` rows, not
new static permissions.

#### Amendments (Slice 4)

Slice 4 shipped Confluence and PagerDuty largely as designed, with five
corrections the evidence gathered while building it forced, plus one gap that
belongs to the gateway rather than to this design. Amendments 4 and 5 came out
of the whole-branch review, which re-fetched the pages the earlier evidence
rested on.

- **Amendment 1 — the "no lane" guarantee is a derived array, not a
  hand-written union.** §2 said the absence of a lane on `doc`/`incident` must
  be "expressed in the type system, not in a comment", but the spec's own
  `SurfaceKind` was still a plain union literal. A plain union lets a second,
  hand-written kind list — `lane-rules.test.ts`'s `ALL_KINDS` — typecheck
  while incomplete, which is exactly how a new kind could have arrived with no
  lane-coverage test at all. `SurfaceKind` is now derived from a
  `SURFACE_KINDS` `as const` array, the same pattern `PRODUCT_IDS` already
  used, so every `Record<SurfaceKind, …>` — including the test's own kind
  list — is a compile error the day it falls behind.
- **Amendment 2 — `excludedLabels` is per rule, not one shared list.** §3
  proposed one denylist (`www`, `status`, `support`, `blog`, `docs`, `help`)
  applied to every `suffix` rule. `www.atlassian.net` is verified live as a
  real Jira Cloud tenant — it 302s to `id.atlassian.com` carrying a live site
  ARI — so a shared list containing `www` would have made Jira stop
  recognising a genuine customer's site the moment Confluence needed a
  denylist for something else. The set of subdomains a vendor reserves is a
  fact about that vendor, so `excludedLabels` lives on the `HostRule` that
  needs it, and Confluence's own rule declares none.
- **Amendment 3 — the split is longest-matching-prefix via `matchOrigin`, not
  registry order.** §1 said two products sharing a host "resolve through
  `pathPrefix` plus registry order". Registry order does no such thing:
  `suffixEntry` turns every matching `suffix` rule into a candidate
  `ConfiguredOrigin` carrying its own `pathPrefix` and hands all of them to
  `matchOrigin`, which already picks the longest matching prefix for
  self-hosted siloing. Reusing it gets the `${prefix}/` boundary check for
  free — the reason `/wiki` cannot claim `/wikifoo` — and removes
  `RULE_BY_PRODUCT`'s key order from the load-bearing set entirely; the
  ordering test in `recognise.test.ts` asserts the outcome on both sides of
  the split rather than the order of the table.
- **Amendment 4 — the host guards are the whole host-level defence, and half of
  that guard is now a documented length rule.** §3 justified the mechanism
  partly on `status.pagerduty.com` being an Atlassian Statuspage whose
  lower-case incident ids an id pattern would reject, making that pattern a
  second line of defence. Re-fetched during review:
  `status.pagerduty.com/api/v2/summary.json` is a 404, so it is not a Statuspage
  at all; its real routes are `/incident_details/:id` and
  `/incidents/details/:id`, not `/incidents/:id`; every path there 200s from one
  SPA shell, which is the only reason the original check appeared to confirm
  anything; and its ids are UPPER-case `P`-prefixed (`PV31RQ5`), the same shape
  as a tenant's. No id pattern backstops the host guard — `INCIDENT_ID` only
  keeps the item arm narrow on a host that has already been accepted. What ships
  in its place is structural: `HostRule`'s suffix arm gained
  `minTenantLabelLength`, the vendor's DOCUMENTED minimum subdomain length,
  checked in `suffixEntry` beside `excludedLabels`. PagerDuty declares `5`
  (Support, "Account Subdomains": "a minimum of five characters"), which refuses
  `go`, `app`, `api`, `www`, `eu`, `docs` and `blog` — and every future short
  vendor host — without listing any of them, leaving `excludedLabels` holding
  only the ≥5-character vendor names, twenty of them. `.atlassian.net` declares
  no length at all, for the same reason it declares no labels.
- **Amendment 5 — `doc` and `incident` pages get no targeted fetch.** §2 and the
  "Item pages on the new products carry no agent lane" bullet both listed
  targeted fetch among what the new surfaces deliver. The gateway's fetch
  boundary is a closed union — `FetchableService = "github" | "gitlab" |
  "bitbucket" | "jenkins" | "jira"`
  (`packages/gateway/src/sync/fetch-host-boundary.ts`) — so neither Confluence
  nor PagerDuty is fetchable, and neither Sentry nor Notion will be. The panel
  offers resolve, Related, freshness and capture; a fetch button on these
  surfaces would name an action the gateway refuses.

**A known gap, and it is the gateway's to close.** `confluence-sync.ts` indexes
a page under `<site>/wiki/pages/viewpage.action?pageId=<id>` — a valid
Confluence address, but not one Cloud's own UI ever serves; Cloud renders
`/wiki/spaces/<KEY>/pages/<id>/<Title>`. `GET /v1/items/resolve`'s match
ladder is resolve-key based (exact, query-stripped, then trimmed trailing path
segments) and cannot bridge the two shapes, so a Confluence page this client
recognises correctly still reports *not indexed* even when the gateway holds
it — Related still answers, because it matches on the title, not the URL. The
fix is upstream and outside this design's scope: preferring the Confluence
API's own `_links.webui` (site-relative, already the shape a browser shows)
over the constructed `viewpage.action` URL. Shipped as
[Nimbus#1364](https://github.com/nimbus-agent/Nimbus/pull/1364), opened
alongside this slice.

### 4 · The connector-health gate

`getConnectors(origin, doFetch)` in `gateway-client.ts` reads
`GET /v1/connectors`, narrows the body with a guard, and yields
`Map<serviceId, { state, lastSuccessfulSync }>`. The route takes no bearer, but
the client calls it **only when paired**: pairing is the consent moment, and an
unpaired extension makes no gateway reads. Results are cached in
`connector-health-store.ts` over `chrome.storage.local` — mirroring
`agent-run-store.ts`, because the service worker is evicted — and concurrent
reads share one request through the existing `single-flight.ts`.

**The cache exists to dedupe, not to persist.** The TTL is **60 seconds**, and
its only job is to collapse the reads a single sitting produces — a panel
reopened twice in a minute, or two tabs opening panels at once — into one
loopback request. It deliberately does not survive as a rendering source beyond
that, because the sequence that matters is the remedial one: a user told "Nimbus
has never synced Linear" leaves, configures the connector, and comes back.

**Stated precisely, because the obvious phrasing overclaims:** that user's next
panel open reflects the change *once the entry has aged past 60 seconds* — not
unconditionally. Someone who configures a connector and returns within the same
minute can see the stale answer one more time. That is a deliberate ceiling on
the staleness, not an accident, and the alternative was rejected: invalidating
on configuration would mean the client watching for an event the gateway does not
emit to it, and a forced refresh on every open discards the dedupe the cache
exists for. Sixty seconds is the whole exposure, it self-heals with no user
action, and no other reading of "reflect that" is true.

Stale-while-revalidate was considered and rejected
for the same reason it usually is on a fast local read: it buys milliseconds and
pays for them with a panel that changes shape after the user has begun reading
it.

On a recognised dashboard, the state decides what renders:

| State | Behaviour |
| --- | --- |
| `healthy` | Three lanes, plus a freshness line from `lastSuccessfulSync` |
| `degraded`, `rate_limited`, `paused` | Three lanes **with a caveat line** — the answers are real, possibly missing recent items |
| `not_configured` | No lanes; one line saying Nimbus has never synced this service |
| `unauthenticated` | No lanes; the credential was rejected — a different problem, a different remedy |
| `error` | No lanes; the last sync failed |
| `unknown` | Three lanes, no note, **no freshness line** — byte-identical to a client without this gate |

**The freshness line follows the lanes, with one exception.** It renders whenever
the lanes render and the gateway supplied a `lastSuccessfulSync` — including the
three impaired states, where the age is what tells a reader whether "possibly
missing recent items" means minutes or a fortnight. It does *not* render on the
three withheld states even when a timestamp exists: those pages are one honest
sentence, and dating a sync whose answers are being withheld invites the reader
to think some answer is still available. And it never renders on `unknown`, which
is the exception that matters: `parseConnectorHealth` keeps a timestamp while
coercing an unrecognised state, so without this rule a gateway that grew an
eighth state would show a line no older gateway does — and `unknown`'s whole job
is to be indistinguishable from a client that never had this gate.

**Why `error` and `unauthenticated` withhold lanes, when `degraded` and `paused`
do not.** This was challenged during slice 2's review, on a fair argument: a
connector whose *last* sync failed still holds everything it indexed before that,
so the lanes would have answered — with real data. By the row above it, that
looks like the same case as `degraded`.

It is not, and the difference is what these three lanes are *for*. `catchup`,
`decisions` and `ownership` are recency questions — "what changed while I was
away" is not partially wrong when the feed behind it stopped at an unknown point;
it is wrong. `degraded`, `rate_limited` and `paused` describe a connector that is
still working: impaired, self-healing or deliberately stopped, missing a bounded
recent window that the freshness line quantifies. `error` and `unauthenticated`
describe a connector that is **broken and needs the owner to act** — and the size
of what is missing is exactly what nobody can know. Answering a recency question
from an index that silently stopped is the one place staleness misleads most.

So the split is not severity, it is answerability: **withhold when an answer
would be confidently wrong, caveat when it would merely be incomplete.** The
alternative — lanes plus a caveat whenever a `lastSuccessfulSync` exists — was
considered and rejected on that reasoning. What the review *did* find, and what
was a genuine defect, was `error`'s copy claiming Nimbus "cannot answer from that
connector right now"; it now says only that the last sync failed, so anything
since then is missing.

Four rules govern the copy and the failure paths:

1. **`not_configured` must not assert.** It is also the state of a connector
   configured a minute ago (F4). The line says what is *known* — Nimbus has
   never synced this service — not what the user did or failed to do.
2. **No invented commands.** `/v1/connectors` supplies no remedy string, and
   `parseScopeGap` already set this precedent: absent a machine-readable detail,
   fall back to generic guidance rather than printing a CLI command the client
   guessed (`gateway-client.ts`).
3. **`lastError` is never rendered.** It is free-form upstream text bound for an
   injected page DOM, and an error string can carry a URL with a credential in
   it. The panel names the state; the gateway's own surfaces carry the detail.
4. **Degradation is silence.** A 404, an unreachable gateway, or a body that
   fails the guard all yield `unknown`, and `unknown` renders the lanes ungated —
   exactly today's behaviour. An older gateway loses the gate, not the feature,
   and is not nagged about it.
5. **This read never originates a connection-error state.** An offline gateway is
   already reported by the paths that own it — `unreachable` copy in the panel
   ("Can't reach Nimbus — is the gateway running?", `panel-in-page.ts:93`, `:128`)
   and a `failed`/`unreachable` lane state (`:1145`). A health read that failed
   for the same reason must not race that message with a second one phrased
   differently; it degrades to `unknown` and leaves the report to whichever call
   the user's next action actually makes. This is why `unknown` does not
   distinguish "route absent" from "gateway offline": the two differ in cause but
   not in what this gate should do, and the offline case is already covered
   downstream.

**The gate applies to all eleven products, including the five already shipped.**
That is a deliberate behaviour change on a shipped surface, and it is a defect
fix: today a GitHub dashboard whose connector is unconfigured runs three lanes
that each answer empty. One rule, no special cases; it earns a changelog entry
of its own.

## Slices

Six PRs, each independently reviewable:

1. **The registry, no new products.** Modules, derivations, `origins.ts`'s
   `PRODUCTS` derived too. Acceptance bar: **every existing test passes
   untouched**. No user-visible change, no changelog entry.
2. **The connector-health gate**, applied to the five shipped products. Endpoint,
   guard, store, the seven-state behaviour, silent degradation. The behaviour
   change and its changelog entry land here, before any new product depends on it.
3. **Linear + CircleCI** — plain SaaS origins on existing kinds. Proves the
   registry with zero new mechanics.
4. **Confluence + PagerDuty** — introduces `doc` and `incident`, the
   path-prefixed sibling on the already-granted `*.atlassian.net`, and the
   tenant-subdomain host rule.
5. **Sentry + Notion** — the two whose URL shapes must be verified against real
   pages first. Notion ships last, or not at all if its ids do not normalise
   cleanly.
6. **Docs** — `architecture.md` gains the registry and the gate;
   `development.md` gains manual checks for the surfaces that are not
   unit-testable; `ROADMAP.md` records what shipped; `CHANGELOG.md` under
   `## [Unreleased]`.

## Testing

- **Per product**, a fixture table of real URLs — matching *and* must-not-match —
  asserted through `recognise()` end to end rather than against the matcher in
  isolation, so registry ordering is covered by the same tests.
- **Shared-host ordering**: `*.atlassian.net/wiki/spaces/…` is Confluence while
  `/browse/ENG-1` on that same host stays Jira; and a Confluence-shaped path
  under a **user-configured Jira Server origin** must not become Confluence.
- **Self-hosted siloing**: two entries on one host (`https://internal.corp/jira`,
  `https://internal.corp/wiki`) each recognise their own product and neither
  matches the other's paths — the longest-prefix rule in `matchOrigin`, pinned
  from the recogniser's side.
- **Non-tenant subdomains**: `status.pagerduty.com/`, `www.pagerduty.com/` and
  `blog.sentry.io/` are **not** recognised as dashboards. One case per `suffix`
  rule, in the must-not-match list.
- **The gate**: a table test over all seven states → (lanes rendered? caveat?),
  plus `unknown` → ungated.
- **The cache is a dedupe, not a memory**: two panel opens inside the TTL make
  one request; an open after it makes a second — so a connector configured
  between two sittings is reflected on the next open.
- **The body guard**: an unrecognised `state` string degrades to `unknown`
  rather than throwing; `lastSuccessfulSync` arrives as an ISO string, not a
  `Date`, because it crossed JSON.
- **The drift guard** extends to the derivations: every rule has a non-empty
  `serviceId`, every built-in host has a surfaces row whose pattern is exactly
  `hostPermissionPattern(origin)`, and `PRODUCT_IDS` matches the registry keys.
- **e2e**: every new surface gets a row in the checklist that gates each PR.
- No `satisfies never` exhaustiveness backstops — exhaustiveness belongs in the
  return type, or it becomes permanently-uncovered lines in the Sonar gate.

## Risks and limitations

- **`PRODUCT_SERVICE_ID` is convention between two repos, not contract** —
  `types.ts:141-152` says so itself. Going from five to eleven multiplies the
  exposure, and reading `/v1/connectors` does not fully close it:
  `getAllConnectorHealth` returns only connectors that have a `sync_state` row
  (`health.ts:336-343`), so a service id we got **wrong** and a service that has
  simply **never synced** are indistinguishable from here. Detectable drift, not
  preventable drift — documented rather than guarded, because a guard that
  cannot tell those apart would lie. Per F4's correction, absence resolves to
  `not_configured`, so the drift case now reads as "Nimbus has never synced X"
  rather than as three empty lanes: still wrong if the id is wrong, but wrong out
  loud instead of quietly.

  Two mitigations were considered and **rejected**. A checked-in JSON fixture of
  upstream connector ids is a second hand-maintained copy of an upstream list —
  the drift shape this design spends slice 1 removing, reintroduced one layer
  out, and stale the moment upstream adds a connector. A runtime check ("our
  `serviceId` appears in no `/v1/connectors` row") fails for the same reason the
  paragraph above gives: on a user who does not use that service, absence is the
  correct and expected answer. What *is* worth having is a **developer-only**
  check that reads the sibling repo's `bundled-connector-registry.ts` when it
  exists on the machine and skips when it does not — useful locally, and
  explicitly **not a CI gate**, since a check that always skips in CI is a gate
  that proves nothing while looking green.
- **Eleven built-in rows in Options**, each its own page-access grant. The list
  and the grant burden both grow. Grouping is worth a look; not in this arc.
- **Three URL shapes are unverified and must be checked against real pages before
  their matcher is written** — not from memory, and not from this table:
  1. **Notion.** Slug-plus-id URLs have no stable separator guarantee, and a
     wrong match is a confidently wrong header. Check specifically against
     database-view URLs (`/<ws>/<db-hash>?v=<view-hash>`), where the **query
     value is also a 32-hex id** and must not be captured as the page id, and
     against inline subpages and public pages. Drop Notion if it will not
     normalise.
  2. **Sentry's two spellings.** `sentry.io/organizations/<org>/…` and the
     tenant-subdomain `<org>.sentry.io/…` must produce the *same* `ref` for the
     same issue, or `sameItem` will treat one issue as two.
  3. **Linear workspace subdomains.** `<workspace>.linear.app` may or may not be
     a supported address; this design assumes only `linear.app/<ws>/…`. Adding a
     `*.linear.app` suffix rule on an unconfirmed scheme would be exactly the
     unverified guess the rule above forbids, so it is deliberately **not** in
     the design: confirm the address first, then add it as a `suffix` rule with
     specific `home` paths per the bare-`/` rule.
     **Verified (Slice 3, Task 3): first-party evidence against it.** Linear's
     own engineering blog on multi-region support states verbatim that its
     client (`linear.app`) and API (`api.linear.app`) stay the single primary
     domains "regardless of where your workspace is hosted" — a deliberate
     choice not to fragment by subdomain or region. No source found (Linear's
     docs, its changelog, or third-party integration guides) shows or uses a
     `<workspace>.linear.app` address in practice. This settles the question
     this item raised: there is no subdomain scheme to confirm, so a later
     slice should not re-open it without new evidence.
- **Item pages on the new products carry no agent lane.** They deliver resolve,
  Related and freshness — real C1/C3 value, and honestly less than a lane. Not
  targeted fetch: the gateway's `FetchableService` is a closed union that names
  neither product (Amendment 5). Giving `issue`, `build`, `doc` and `incident` lanes of their own
  is the natural follow-on, and is a C2 question, not a recognition one.

## Out of scope

- Any new gateway surface. This design consumes only shipped, versioned routes.
- Lanes for `issue`, `build`, `doc` or `incident` (a C2 question).
- Connector health anywhere but the panel's dashboard gate — the Options page
  showing per-connector status is a plausible follow-up, not part of this.
- GitHub Actions as a second connector on `github.com`. The registry is designed
  so that it is a module; adding it is not this arc's work.
