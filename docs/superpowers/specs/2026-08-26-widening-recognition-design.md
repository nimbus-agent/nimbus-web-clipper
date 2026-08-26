# Eleven products, and a gate that makes them honest (C1.2 · widening)

> **Status:** design, approved 2026-08-26. **Client-only** — every surface it
> consumes is already shipped and versioned upstream (`GET /v1/connectors`,
> `GET /v1/items/resolve`, `POST /v1/agents/*`). Nothing here proposes a gateway
> contract. Six slices; slice 1 is a pure refactor and slice 2 is the only one
> that changes behaviour on a shipped surface.

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

**`Product` stays a literal union.** `types.ts` keeps one `PRODUCT_IDS` array
`as const` and derives `Product` from it, so `Record<Product, …>` exhaustiveness
still holds and the registry imports types rather than the reverse. The six
tables of F5 become derivations of `PRODUCT_RULES`; the existing drift guard
survives, now guarding the derivation instead of a human's diligence.

### 2 · Two new surface kinds

`SurfaceKind` gains `doc` and `incident`. Neither appears in any `LANE_RULES`
entry, so `laneBelongsOnSurface` returns false for every lane and the panel
renders what a Jira issue renders today: header, freshness, Related, the
`glossary` term lane, targeted fetch on a miss, capture as last resort. The
absence of a lane is expressed in the type system, not in a comment.

### 3 · What each product matches

| Product | Item path | Kind | `ref` | Dashboard (`home`) |
| --- | --- | --- | --- | --- |
| Linear | `/<ws>/issue/<TEAM-123>/…` | `issue` | `TEAM-123` | `/<ws>`, `/<ws>/inbox`, `/<ws>/my-issues` |
| Sentry | `/organizations/<org>/issues/<id>/`, `<org>.sentry.io/issues/<id>/` | `incident` | `<org>#<id>` | `/issues/`, `/organizations/<org>/issues/` |
| Confluence | `/wiki/spaces/<KEY>/pages/<id>/…` | `doc` | `<KEY>/<id>` | `/wiki/`, `/wiki/home` |
| PagerDuty | `/incidents/<ID>` | `incident` | `<ID>` | `/`, `/incidents` |
| Notion | `/<ws>/<slug>-<32hex>`, `/<32hex>` | `doc` | the 32-hex id, dashes stripped | `/<ws>` |
| CircleCI | `/pipelines/<vcs>/<org>/<repo>/<n>` | `build` | `<org>/<repo> #<n>` | `/pipelines`, `/home` |

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

### 4 · The connector-health gate

`getConnectors(origin, doFetch)` in `gateway-client.ts` reads
`GET /v1/connectors`, narrows the body with a guard, and yields
`Map<serviceId, { state, lastSuccessfulSync }>`. The route takes no bearer, but
the client calls it **only when paired**: pairing is the consent moment, and an
unpaired extension makes no gateway reads. Results are cached in
`connector-health-store.ts` with a short TTL over `chrome.storage.local` —
mirroring `agent-run-store.ts`, because the service worker is evicted — and
concurrent reads share one request through the existing `single-flight.ts`.

On a recognised dashboard, the state decides what renders:

| State | Behaviour |
| --- | --- |
| `healthy` | Three lanes, plus a freshness line from `lastSuccessfulSync` |
| `degraded`, `rate_limited`, `paused` | Three lanes **with a caveat line** — the answers are real, possibly missing recent items |
| `not_configured` | No lanes; one line saying Nimbus has never synced this service |
| `unauthenticated` | No lanes; the credential was rejected — a different problem, a different remedy |
| `error` | No lanes; the last sync failed |

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
- **The gate**: a table test over all seven states → (lanes rendered? caveat?),
  plus `unknown` → ungated.
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
  cannot tell those apart would lie.
- **Eleven built-in rows in Options**, each its own page-access grant. The list
  and the grant burden both grow. Grouping is worth a look; not in this arc.
- **Notion and Sentry matchers are unverified.** Notion's slug-plus-id URLs have
  no stable separator guarantee, and a wrong match is a confidently wrong header
  — the failure `recognise.ts`'s opening comment exists to prevent. Verify
  against real pages before writing either matcher; drop Notion if it will not
  normalise.
- **Item pages on the new products carry no agent lane.** They deliver resolve,
  Related, freshness and targeted fetch — real C1/C3 value, and honestly less
  than a lane. Giving `issue`, `build`, `doc` and `incident` lanes of their own
  is the natural follow-on, and is a C2 question, not a recognition one.

## Out of scope

- Any new gateway surface. This design consumes only shipped, versioned routes.
- Lanes for `issue`, `build`, `doc` or `incident` (a C2 question).
- Connector health anywhere but the panel's dashboard gate — the Options page
  showing per-connector status is a plausible follow-up, not part of this.
- GitHub Actions as a second connector on `github.com`. The registry is designed
  so that it is a module; adding it is not this arc's work.
