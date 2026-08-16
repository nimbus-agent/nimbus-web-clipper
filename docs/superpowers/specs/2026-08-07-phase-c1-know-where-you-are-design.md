# Phase C1 — Know Where You Are — Design

**Date:** 2026-08-07
**Status:** Approved — review notes integrated
**Roadmap:** [C1.1–C1.4](../../../ROADMAP.md#phase-c1--know-where-you-are-)

## Goal

Turn "a tab is open" into "**this is a Bitbucket PR in repo X, and here is the
indexed item for it**". This is the foundation of the roadmap's reframe from web
clipper to browser-side gateway client: everything in Phase C2 (running the
`why` / `impact` / `expert` agents from the page) is worthless without it.

Four pieces, shipped as one phase:

- **C1.2 Surface recognisers** — a pure module that classifies the current page
  (Bitbucket PR, GitHub PR, GitLab MR, Jenkins build, Jira issue) and derives the
  canonical URL that identifies it.
- **C1.1 Page → indexed item resolution** — send that URL to the gateway, get back
  at most one item, or an honest miss.
- **C1.3 The ambient panel shell** — grow the injected related-items panel into a
  header (what page is this, what item is it) plus a list of collapsible lanes.
- **C1.4 Per-origin, opt-in recognition** — the runtime host permission that lets
  recognition work without a user gesture, granted per origin, never as a static
  broad permission.

## Non-goals

- **A panel that opens by itself.** The panel stays user-summoned (`Alt+Shift+R`
  or the popup button), as today. Ambient auto-surfacing (roadmap 3.4) waits until
  C2 gives the lanes real answers — a panel that appears unbidden to show only
  related items is exactly the noise the roadmap says kills ambient UI.
- **Agent lanes.** The shell is built lane-agnostic *so that* C2 can add lanes,
  but this phase ships one lane: related items, the content that exists today.
- **Targeted sync on a miss (C3.1).** A resolve miss says "not indexed" and stops.
  The sync offer lands in that state later.
- **Capture changes.** The capture pipeline, the clip payload, the offline queue
  and the rate-limit machinery are untouched.
- **A toolbar badge for resolved pages.** Considered and deferred: it reintroduces
  passive per-navigation resolve calls this phase deliberately avoids.
- **Deciding the gateway contract.** The resolve route is *proposed* here and
  decided upstream (see [Proposed gateway contract](#proposed-gateway-contract)).

## Constraints (non-negotiable)

- **Loopback-only network destination.** The only origin the extension *sends* to
  remains `127.0.0.1` / `localhost` (**I6**). C1.4 grants **page access**, a
  different axis; the UI and the store listing must not blur the two.
- **No static broad host permission.** `optional_host_permissions` is inert at
  install; nothing is granted until the user grants a specific origin.
- **The bearer token is the only secret** — never logged, never in a page DOM,
  never returned to the panel or the Options page.
- **Don't fork the contract.** `POST /v1/clips/resolve` does not exist yet. The
  client is written against the proposed shape and **degrades honestly** when the
  gateway doesn't have it; it never fakes or approximates it from `/related`.
- **Never present fuzzy hits as the page.** Resolution is at-most-one. Related
  items are a lane, structurally and visually separate from the header.
- **XSS-safe injection.** Everything gateway-provided is rendered with
  `textContent`; the panel stays in a shadow root with inlined styles.
- **TypeScript strict, no `any`; no `console.*` in `src/`; Biome clean.**

## Architecture

Recognition and resolution both run in the **service worker**, not in the page.
The panel stays a dumb renderer: it reports where it is and renders what it is
told.

```
panel-in-page.ts  ──{ kind: "resolve", pageUrl: location.href, title }──▶  service-worker.ts
                                                                              │
                                                    handleResolve(deps, req)  │  background/handlers.ts
                                                      │                       │
                                                      ├─ getOrigins()         │  background/origin-store.ts
                                                      ├─ recognise(url, origins)  shared/recognise.ts  (pure)
                                                      │     └─ miss ─────────────────────────────┐
                                                      └─ postResolve(origin, token, resolveUrl)  │
                                                            └── POST /v1/clips/resolve           │
                                                                                                 ▼
panel-view.ts  ◀───────────── { recognition, item | null | reason } ─────────────────────────────┘
```

**Why the SW and not the page:** the configured origins live in extension storage,
the bearer token lives in the SW, and the classification logic must be
unit-testable in a node environment without a `chrome` global. Putting all three
in the page would drag storage access and gateway I/O into the injected script for
no gain.

**Why `location.href` and not `<link rel="canonical">`:** on the surfaces this
phase targets, the URL *is* the identity. A self-hosted Jenkins build page or a
Bitbucket PR usually has no canonical link element, and where one exists it is
often the site's marketing-normalised URL. The existing related-items query keeps
reading DOM canonical exactly as it does today — the two inputs serve different
questions and stay separate.

**One round trip, one state.** `resolve` returns recognition *and* resolution
together. The panel renders a single discriminated state rather than sequencing
two requests and interleaving their failure modes.

## New modules

| File | Kind | Purpose |
| --- | --- | --- |
| `src/shared/recognise.ts` | pure | `recognise(url, origins) → Recognition`. Host table + path patterns + canonicalisation. |
| `src/shared/origins.ts` | pure | The configured-origin model, validation, normalisation, dedupe. |
| `src/background/origin-store.ts` | storage | Persist configured origins in `chrome.storage.local`. |
| `src/browser/permissions.ts` | seam | The only place `chrome.permissions` is touched. |

Modified: `src/shared/messages.ts`, `src/shared/types.ts`,
`src/background/gateway-client.ts`, `src/background/handlers.ts`,
`src/background/service-worker.ts`, `src/panel/panel-view.ts`,
`src/panel/panel-in-page.ts`, `src/options/*`, `src/manifest/manifest.ts`.

### `shared/recognise.ts`

```ts
export type Product = "bitbucket" | "github" | "gitlab" | "jenkins" | "jira";
export type SurfaceKind = "pr" | "build" | "issue";

export type Recognition =
  | {
      readonly ok: true;
      readonly product: Product;
      readonly kind: SurfaceKind;
      /** Human header text, e.g. "Bitbucket PR". */
      readonly label: string;
      /** Short identity for the header, e.g. "acme/web #482". */
      readonly ref: string;
      /** The canonicalised URL sent to the gateway as the resolution key. */
      readonly resolveUrl: string;
    }
  | { readonly ok: false; readonly reason: "unknown-host" | "unrecognised-path" };

export function recognise(url: string, origins: readonly ConfiguredOrigin[]): Recognition;
```

**Host resolution.** A built-in table covers the SaaS hosts that need no
configuration — `bitbucket.org`, `github.com`, `gitlab.com`, `*.atlassian.net`.
Anything else must be declared by the user as `{ origin, product }` (C1.4 /
Options). The product is **never guessed from the path**: a proxied or
path-prefixed self-hosted instance would produce a confidently wrong header, and
a wrong header is worse than no header on a surface whose whole job is
recognition. An unknown host is `{ ok: false, reason: "unknown-host" }`.

**Matching a configured origin.** Entries may carry a path prefix
(`https://corp.example/jira`), so matching is **longest-prefix-wins**: pick the
entry whose origin and prefix are the longest match for the page URL, strip that
prefix, and apply the product's pattern to the remainder. This is what lets one
host carry several products — `https://corp.example/jira` and
`https://corp.example/jenkins` are distinct entries — and it settles the case
where a bare `https://corp.example` entry sits alongside a prefixed one. Built-in
SaaS entries have an empty prefix, so they fall out of the same rule.

**Path patterns**, per product, applied to the path *after* the configured prefix
is stripped (each also matching the sub-tabs that are still the same item):

| Product | Pattern | Also matches |
| --- | --- | --- |
| GitHub | `/{owner}/{repo}/pull/{n}` | `/files`, `/commits`, `/checks` |
| GitLab | `/{group}/{project}/-/merge_requests/{n}` | `/diffs`, `/pipelines` |
| Bitbucket Cloud | `/{workspace}/{repo}/pull-requests/{n}` | `/diff`, `/commits` |
| Bitbucket Server | `/projects/{KEY}/repos/{slug}/pull-requests/{n}` | `/overview`, `/diff` |
| Jenkins | `/job/{name}[/job/{name}]*/{buildNumber}` | trailing `/console`, `/changes` |
| Jira | `/browse/{KEY-123}` | `*.atlassian.net`, self-hosted `/jira/browse/...` |

Nested Jenkins folders (`/job/a/job/b/42`) are a first-class case, not an edge
case — folder-organised Jenkins is the norm at any size.

**Canonicalisation** produces `resolveUrl`: lowercase scheme and host, strip the
default port, strip the fragment, strip **all** query parameters (none of the
patterns above carry identity in the query), drop the trailing slash, and collapse
sub-tab paths onto the item itself. The configured path prefix is **preserved** —
`https://corp.example/jira/browse/ABC-1` is what the connector indexed, so it is
what the gateway is asked about. Two URLs a human would call "the same PR" must
produce byte-identical `resolveUrl` strings — this is the join key, so drift here
shows up as an unexplained resolve miss.

Adding a surface is one table entry plus fixtures. No other file changes.

### `shared/origins.ts`

```ts
export interface ConfiguredOrigin {
  /** Scheme + host [+ port] and an optional path prefix, e.g.
   *  "https://jenkins.corp.example" or "https://corp.example/jenkins". */
  readonly origin: string;
  readonly product: Product;
}
```

Validation: parseable as a URL, `http:`/`https:` only, query and fragment
stripped, host lowercased, trailing slash dropped. An **optional path prefix** is
allowed, so self-hosted instances behind a reverse proxy or on a sub-path
(`/jira`, `/jenkins`) are configurable.

Entries are **deduped by origin *and* prefix**, not by host: one product per
`origin + prefix`, so `https://corp.example/jira` and `https://corp.example/jenkins`
are two legitimate entries on one host. Re-adding an existing `origin + prefix`
replaces its product rather than creating a second entry. Lookup is
longest-prefix-wins (see `recognise.ts` above).


This module is **deliberately separate from `shared/gateway.ts`**. That module
validates the one origin the extension may *talk to* and its loopback rule is a
security invariant; this one validates origins whose *pages* may be recognised.
Sharing a helper between them would invite a future change that quietly relaxes
one by editing the other.

### `browser/permissions.ts`

A thin promise-wrapped seam over `chrome.permissions`: `hasOrigin(pattern)`,
`requestOrigin(pattern)`, `removeOrigin(pattern)`, and a change subscription.
`chrome.permissions.request` must run inside a user-gesture handler, so it is
called from the Options page's click handler — never from the service worker.

**The grant is host-scoped, even when the configured origin carries a prefix.**
A match pattern may include a path (`https://corp.example/jira/*`), but the
browser's permission warning is per-host either way, so a path-scoped grant buys
no privacy and costs exact-pattern bookkeeping in `permissions.contains` and in
revocation. One entry per host: `https://corp.example/*`. Revoking it therefore
silences every configured prefix on that host — the Options UI must say so where
a host carries more than one.

## Proposed gateway contract

> **⚠️ SUPERSEDED. Do not build against this shape.** It was written as a brief
> to open upstream, believing the route was undesigned there. It was already
> designed: the Nimbus repo's
> `2026-08-06-http-agents-route-and-resolve-by-url-design.md` §4 specifies
> `GET /v1/items/resolve?url=`, gated on a `resolve` scope, returning a
> `found`-discriminated shape with an `ambiguous` arm. The differences and the
> order to close them are in
> [`2026-08-07-c1-upstream-reconciliation.md`](./2026-08-07-c1-upstream-reconciliation.md).
> Kept verbatim below as the record of what C1 was built against.

```
POST /v1/clips/resolve
Authorization: Bearer <paired token>

  → { "canonicalUrl": "https://bitbucket.org/acme/web/pull-requests/482" }

  ← 200 { "item": { "id": "...", "service": "bitbucket", "type": "pr",
                    "title": "...", "canonicalUrl": "...", "url": "..." } }
  ← 200 { "item": null }        // known-shape page, not in the index
  ← 401                          // token rejected
  ← 404                          // this gateway has no resolve route
```

**Why a new route** rather than a `canonicalUrl` filter on `GET /v1/items` or a
resolve slot on `POST /v1/clips/related`:

- It is purely **additive** to the locked contract — no shipped endpoint changes
  shape.
- It is **structurally at-most-one**. A list endpoint would make "exactly one item
  or a miss" a client-side convention, and the C1.1 brief's central rule is that
  the client must never dress fuzzy hits up as the page. A route that cannot
  return a list cannot break that rule.
- It keeps **resolution separate from ranking**. `/related` is a ranked FTS query
  that uses `canonicalUrl` to *exclude* the current host; overloading it couples
  two different questions to one response shape.

Upstream cost, stated honestly in the proposal: `canonical_url` carries no SQL
index today (`unified-item-v3-sql.ts`), so the read brings a migration with it.

**The 404 discriminator is load-bearing.** A miss is a `200` with `item: null`;
an absent route is a `404`. That separation is what lets this client ship before
the route exists and flip to live with no code change. If upstream lands a
different shape, this repo consumes it — it does not fork.

## Message contract (client-internal)

```ts
export interface ResolveRequest {
  readonly kind: "resolve";
  readonly pageUrl: string;
  readonly title?: string;
}

/** The gateway's resolved item, narrowed by a guard before it reaches the panel. */
export interface ResolvedItem {
  readonly id: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly canonicalUrl: string;
  readonly url: string | null;
}

export type ResolveError =
  | "not_paired"      // no token yet
  | "unauthorized"    // 401 — re-pair
  | "unsupported"     // 404 — this gateway can't resolve pages yet
  | "unreachable"     // gateway down / timeout
  | "server_error";

export type ResolveResponse =
  | { kind: "resolve"; ok: true; recognition: Recognition; item: ResolvedItem | null }
  | { kind: "resolve"; ok: false; recognition: Recognition; reason: ResolveError };
```

`recognition` is present on **both** arms: a gateway failure must not erase the
fact that we know what page this is. Guards (`isResolveRequest`,
`isResolveResponse`, `isResolvedItem`) follow the existing `messages.ts` pattern —
cross-boundary data is `unknown` until narrowed.

An unrecognised page short-circuits in `handleResolve`: no gateway call is made,
and the response is `ok: true` with `item: null` and a failed `recognition`.

## Panel shell

`panel-view.ts` grows from three render functions into a shell of **header +
lanes**, all pure and jsdom-tested:

```ts
renderHeader(doc, state: HeaderState): HTMLElement
renderLane(doc, lane: Lane): HTMLElement          // collapsible, lane-content-agnostic
renderShell(doc, state: PanelState): HTMLElement
```

A `Lane` is `{ id, title, expanded, render(doc): HTMLElement }`. C2 adds
`why` / `impact` / `expert` by appending to the lane array; the shell does not
change. Related items become lane one, reusing `renderHits` **unchanged**.

Header states — and in **every one of them the related lane still works**, so
this phase cannot regress today's panel:

| State | Header reads |
| --- | --- |
| unrecognised host | "Not a recognised Nimbus surface" + a pointer to Options |
| recognised, resolving | "Bitbucket PR · acme/web #482 — checking Nimbus…" |
| recognised, resolved | the surface line + the exact indexed item it resolved to |
| recognised, `item: null` | "Not indexed" (C3.1's sync offer lands here) |
| gateway lacks the route | "This Nimbus gateway can't resolve pages yet" |
| not paired / unauthorized | the existing pairing wording, reused verbatim |

The first lane renders in parallel with the header — a slow or failing resolve
never blocks related items from appearing.

## C1.4 — the permission flow

Manifest gains:

```ts
optional_host_permissions: ["http://*/*", "https://*/*"]
```

Inert at install: nothing is granted, and the extension's *network* destination is
unchanged. Firefox supports `optional_host_permissions` in MV3 well below our
`strict_min_version` of 121.

Options grows a **Recognised surfaces** section: add an origin, pick its product,
then **Grant** (a `chrome.permissions.request` from the click) or **Revoke**.
Origins can be configured without being granted — recognition still works for a
user-summoned panel because the summoning gesture grants `activeTab`.

**What the grant actually buys, stated plainly in the UI and the spec:**
gesture-free recognition — reading the page URL without the user first summoning
the panel. Nothing in this phase requires it; C2 does. We ship the flow now rather
than bundling a permission ask into the phase that also introduces agent calls,
where it would read as buried.

**Two costs recorded deliberately:**

1. Chrome renders optional host permissions in the store listing as "Read your
   data on all websites (optional)". That string is alarming and it is the price
   of supporting self-hosted instances, whose hostnames cannot be enumerated in
   advance. The listing copy must explain it.
2. This is a permission-surface change, so the AMO review will look at it and
   `store/` listing copy must be updated in the same phase, not after.

## Error handling

| Condition | Behaviour |
| --- | --- |
| Unknown host | No gateway call. Header says unrecognised; related lane unaffected. |
| Known host, unmatched path | Same, with a distinct `unrecognised-path` reason for tests/telemetry-free debugging. |
| Not paired | Header reuses the existing "Pair a browser first (Options)" wording. |
| `404` from resolve | `unsupported` — a first-class state, not an error toast. |
| `401` | "Pairing expired — re-pair in Options.", matching the related lane. |
| Timeout / unreachable | "Can't reach Nimbus — is the gateway running?" |
| Malformed response | Guard rejects → `server_error`. Never rendered as an item. |

No new failure mode may take down the related lane, and nothing here writes to the
offline queue — resolve is a read.

## Testing

- **`recognise.ts`** — a fixture table of real URLs per product (SaaS and
  self-hosted, with ports, **path prefixes**, nested Jenkins folders, sub-tabs,
  tracking parameters, trailing slashes), each asserting product, kind, ref and
  the exact `resolveUrl` — including that the prefix survives canonicalisation.
  Plus negative fixtures: unknown hosts, near-miss paths, `file:`/`chrome:` URLs,
  and a prefixed entry that must **not** match a sibling path on the same host.
  Canonicalisation gets its own idempotence assertion (`f(f(x)) === f(x)`).
- **`origins.ts`** — validation and dedupe: two prefixed entries coexisting on one
  host, longest-prefix-wins against a bare host entry, and re-adding the same
  `origin + prefix` with a different product replacing rather than duplicating it.
- **`handleResolve`** — injected deps, no `chrome`: the unrecognised short-circuit,
  each gateway status mapping, and the rule that `recognition` survives failure.
- **`gateway-client.postResolve`** — status mapping via a stubbed `fetch`, with
  `404 → unsupported` and `200 { item: null } → miss` as distinct assertions.
- **`panel-view.ts`** — jsdom (docblock opt-in), one test per header state plus
  lane collapse/expand and the `textContent`-only assertion.
- **Manual** (`docs/development.md`): grant and revoke an origin, confirm the
  panel works on `activeTab` alone before any grant, and confirm a revoked origin
  stops being recognised gesture-free.

## Build sequence

1. `shared/recognise.ts` + `shared/origins.ts` + fixtures. Pure, no UI, nothing
   user-visible.
2. `background/origin-store.ts` + `browser/permissions.ts` + the Options
   "Recognised surfaces" UI + the manifest change.
3. The resolve path: `messages.ts` types and guards, `gateway-client.postResolve`,
   `handleResolve`, SW routing, plus a `/v1/clips/resolve` route on
   `scripts/screenshots/mock-gateway.ts` so the screenshot/manual harness can
   exercise it.
4. The panel shell: `panel-view.ts` header + lanes, `panel-in-page.ts` wiring,
   related items as lane one.
5. Docs: `docs/architecture.md` (the recognition layer and the resolve flow),
   `CHANGELOG.md` under `[Unreleased]`, `ROADMAP.md` (C1 status), `store/` listing
   copy for the optional permission, `docs/development.md` manual checklist.

Steps 1–4 are each independently shippable and reviewable; step 3 is the only one
that depends on the proposed contract, and it ships in its degraded state.

## Resolved and deferred questions

> **⚠️ Superseded in part.** This section, and *Proposed gateway contract* above,
> were written believing the resolve route was undesigned upstream. It was not —
> see [`2026-08-07-c1-upstream-reconciliation.md`](./2026-08-07-c1-upstream-reconciliation.md).
> The route, its auth scope and its response shape are decided in the Nimbus repo
> and differ from what is written here. The client's behaviour as shipped is
> unaffected (an absent route still 404s); the adaptation is scheduled against the
> upstream PR that lands the route.

Settled during design review. The first three are **positions this repo takes into
the upstream proposal**, not decisions it can make — the gateway owns the contract.

- **Token scope — ~~decided (client position)~~ WRONG, corrected upstream.** This
  claimed `POST /v1/clips/resolve` reuses the clip bearer token, on the reasoning
  that the contract had no scope concept. It has one: `api-scopes.ts` shipped in
  Nimbus #1062 with a `resolve` scope, and `LEGACY_SCOPES` — what an
  already-paired token gets — is `["clip", "briefs"]`, deliberately excluding it.
  Every browser paired today will therefore be **rejected** by the resolve route
  until it re-pairs, and this client currently maps that `403` to `server_error`.
- **Canonical-URL normalisation — deferred upstream, assumption stated here.** How
  the gateway indexes and queries `canonical_url` is its own design. What the
  client codes against is **byte-equality**: it sends the canonicalised
  `resolveUrl` and expects a match against the stored `canonical_url` as-is. This
  is the likeliest source of a silent miss — a connector may have written a URL
  our canonicalisation would have reshaped — so the proposal must say plainly
  whether the gateway normalises on its side, and a mismatch has to be
  distinguishable from a genuine "not indexed" during upstream bring-up.
- **Response payload — decided (client position).** The proposal asks for the
  identity fields (`id`, `service`, `type`, `title`, `canonicalUrl`, `url`) in the
  resolve response itself, so the header renders from one round trip. A shape that
  returned only an id would force a second read before the panel could say
  anything, which is latency the recognition surface can't absorb.
- **Path prefixes for self-hosted instances — decided (client-side).** Configured
  origins may carry a path prefix (`https://corp.example/jira`), matched
  longest-prefix-wins and stripped before the product's path pattern is applied,
  then preserved in `resolveUrl`. This is entirely a client concern and needs
  nothing from upstream.

