# Architecture

How the Nimbus Web Clipper is built today. This is a reference for *what is* —
the roadmap ([`../ROADMAP.md`](../ROADMAP.md)) is *what's next*, and the
per-feature design specs under [`superpowers/specs/`](./superpowers/specs/) are
the record of how each slice was reasoned through. When code and this document
disagree, the code wins — fix the document.

## What it is

A Chrome + Firefox **Manifest V3** extension that clips the readable article or
the current selection of a web page into the user's local-first
[Nimbus](https://github.com/nimbus-agent/Nimbus) index, and surfaces related
indexed items in an on-demand panel.

It is a **thin client** over a locked HTTP contract. It talks to exactly one
place — a Nimbus gateway on `127.0.0.1` — and holds exactly one secret, the
bearer token minted at pairing. There are no cloud calls and no telemetry.

## Four load-bearing decisions

Everything else follows from these. Each is an invariant, not a preference.

### 1. Loopback only

The only network destination is the gateway on `127.0.0.1` / `localhost`.
`host_permissions` is restricted to those origins — never `<all_urls>`, never a
remote host. Origin validation lives in [`src/shared/gateway.ts`](../src/shared/gateway.ts)
and rejects anything else, so a mistyped or malicious gateway URL fails closed
rather than exfiltrating a clip. This is the client-side counterpart to the
gateway's invariant **I6** (the gateway binds `127.0.0.1` only) — not an
implementation of it; it is *why* the tool can call itself private.

### 2. The bearer token is the only secret

The token lives in extension storage (`chrome.storage.local`), is held by the
background service worker, and is **never logged and never placed in a page DOM**.
The pairing code is treated the same. Pairing is **fail-closed** (invariant
**I30**): the gateway only mints a token inside a short, owner-opened window, and
the extension redeems a 6-digit code against `/v1/clips/pair/confirm`. Because the
token is the *only* secret, revocation is simple — unpair locally, or
`nimbus clip revoke` on the gateway.

### 3. Bundled, no runtime dependencies

[`esbuild.mjs`](../esbuild.mjs) bundles each entry point (`background`, `popup`,
`options`, `capture`, and the injected panel/toast/cue) into `dist/<target>/` as a
fully-inlined IIFE. `@mozilla/readability` is a *devDependency* inlined into the
capture bundle. The shipped extension has **no `node_modules`** — which keeps it
bundle-size-honest and auditable, the same discipline the proposed Nimbus SDK is
expected to inherit.

### 4. One manifest, two targets

[`src/manifest/manifest.ts`](../src/manifest/manifest.ts) exposes
`composeManifest(target, version)`. Chrome gets `background.service_worker`;
Firefox gets `background.scripts` + `browser_specific_settings.gecko.id`.
Everything else is shared, and because the manifest is *typed TypeScript* rather
than static JSON, a drift between the two targets is a compile error, not a
runtime surprise. `scripts/check-build.mjs` then asserts each `dist/<target>` is a
complete, loadable MV3 extension.

## Layer map

The codebase is deliberately split so that **pure logic never touches a
`chrome.*` API directly** — which is what keeps the interesting parts unit-testable
in a node environment.

```
┌─────────────────────────────────────────────────────────────────┐
│  Entry points (each bundled independently)                       │
│                                                                   │
│  popup/        options/        capture/ (injected)   panel/toast  │
│  clip · tags   pair · connms   Readability/selection  (injected)  │
│     │              │                    │                 │       │
│     └──────────────┴─── chrome.runtime messaging ─────────┘       │
│                              │                                     │
│                    ┌─────────▼──────────┐                          │
│                    │  background/ (SW)   │  owns token + all I/O   │
│                    │  service-worker.ts  │  routes every message   │
│                    └─────────┬──────────┘                          │
│                              │                                     │
│   ┌──────────────────────────┼───────────────────────────────┐   │
│   │  background pure core (deps injected, no chrome.* import)  │   │
│   │  handlers · gateway-client · queue-flush · rate-limit-...  │   │
│   └──────────────────────────┼───────────────────────────────┘   │
│                              │                                     │
│                    ┌─────────▼──────────┐                          │
│                    │  browser/ seam      │  the ONLY place         │
│                    │  storage tabs ...   │  chrome.* is touched    │
│                    └─────────┬──────────┘                          │
└──────────────────────────────┼───────────────────────────────────┘
                               │ HTTP (bearer)
                    ┌──────────▼───────────┐
                    │  Nimbus gateway       │  127.0.0.1 only
                    │  POST /v1/clips        │
                    │  POST /v1/clips/pair/confirm
                    │  POST /v1/clips/related
                    │  GET  /v1/items/resolve
                    │  POST /v1/items/fetch  ← WRITE, see below
                    └───────────────────────┘
```

- **`src/manifest/`** — typed manifest compose (`composeManifest`).
- **`src/background/`** — the MV3 service worker and its pure core (see below).
- **`src/browser/`** — the thin typed seam over `chrome.*` (`storage`, `tabs`,
  `scripting`, `runtime`, `action`, `alarms`, `context-menus`). The only module
  layer that imports WebExtension APIs.
- **`src/capture/`** — page capture injected into the tab: `capture-in-page.ts`
  (Readability / selection → `CaptureResult`) with a pure `fallback.ts`
  (meta-description/URL bookmark when no readable content is found), plus the
  injected `toast` (result feedback) and `panel` (related items) views.
- **`src/popup/`**, **`src/options/`** — the toolbar popup (clip / clip-selection
  + tags + status + queue view) and the options page (gateway URL + 6-digit
  pairing form + connection management).
- **`src/shared/`** — pure modules shared across every entry: `types.ts`
  (cross-module types), `clip.ts` (tag parsing + payload builder), `gateway.ts`
  (endpoints + loopback origin validation), `messages.ts` (typed envelope +
  guards), `queue.ts`, `related.ts`, `origins.ts` + `recognise.ts` (page
  recognition — see below).

## The message envelope

The popup, options page, and injected panel are separate bundles; they reach the
service worker only through `chrome.runtime` messaging. Every message crossing
that boundary is **`unknown` until a type guard narrows it** — never `any`.
[`src/shared/messages.ts`](../src/shared/messages.ts) defines the request/response
unions (`ExtensionRequest` / `ExtensionResponse`) and a guard per request kind
(`isClipRequest`, `isPairRequest`, `isRelatedRequest`, the queue trio,
`isConnectionStatusRequest`, `isUnpairRequest`).

`service-worker.ts` is a dispatcher: each guard gates a call to a **pure handler**
with its dependencies injected, and every branch returns `true` (async response)
and **fails closed** — a rejected handler still sends a well-formed error response
rather than leaving the caller hanging:

```ts
if (isClipRequest(message)) {
  handleClip(clipDeps, message)
    .then(async (res) => { await syncQueueState(); respond(res); })
    .catch(() => respond({ kind: "clip", ok: false, reason: "server_error" }));
  return true;
}
```

## Discovery, connection health, and the trust panel

Setup used to mean typing a gateway URL before Nimbus could say anything about
the page you were on. This closes that gap: the extension finds a local
gateway itself, tells the truth about whether the connection is actually
healthy, and answers "where does my data go?" from real settings rather than a
fixed blurb.

### Discovery is two candidates, never a scan

[`DISCOVERY_CANDIDATES`](../src/shared/discovery.ts) is a frozen two-element
array — `http://127.0.0.1:7474`, then `http://localhost:7474` — not a port
range. A sweep is slow, it is the one behavior in this extension that would
look like malware to anyone watching the socket table, and it buys a case the
manual URL field already covers (a gateway on a nonstandard port). `127.0.0.1`
goes first because it is the literal address invariant **I6** binds the
gateway to; `localhost` is the fallback, and deliberately never probed first,
because on Windows it can resolve to `::1` under dual-stack resolution — an
address a gateway bound to IPv4 loopback only refuses. `handleDiscover`
(`src/background/handlers.ts`) probes the two candidates **sequentially**,
stopping at the first hit: concurrent probing would always dial a candidate
expected to fail, for a tiebreak between two routes to the same gateway that
buys nothing. Each `probeReachable` call is guarded with `.catch(() => false)`
so one candidate's rejection can never cost the next one its turn.
`pickReachable` returning `null` is not a failure state — it means "ask the
user," and the manual URL field never goes away.

### The health probe is the one tokenless call, and repeats the loopback check

`probeHealth` (`src/background/gateway-client.ts`) — `GET /v1/health`, an
800ms timeout — is the only route in the gateway client that carries no bearer
token. Every other route inherits the origin discipline of a stored
`Connection`; this one has no connection to inherit it from, which is exactly
why it re-asserts `isLoopbackOrigin` itself rather than trusting its caller.
Today `DISCOVERY_CANDIDATES` is a frozen constant, so the check can never
actually fail — it is asserted anyway, for whoever makes that list
configurable later, so **I6** stays enforced at the one place nothing else is
enforcing it. A non-loopback origin never reaches `fetch` at all.

### `stale` is set from one wrap around `respond`, not a hook per route

A response carrying `reason: "unauthorized"` means the gateway rejected the
stored token, and every route that can 401 must react the same way — flip
`stale`, so Options can say "Needs re-pairing" instead of leaving the user to
guess. `service-worker.ts` does this in exactly one place: the message
listener wraps `rawRespond` in a local `respond` that checks
`carriesUnauthorized(res)` before every send, rather than a hook wired into
each handler. A per-handler hook would drift the moment someone added a new
route and forgot it; wrapping the one function every route already calls means
the check cannot drift, and a future route inherits the behavior for free
just by calling `respond`.

The write this triggers — `markStale()` — and every other writer of the
connection record (`setConnection`, `clearConnection`, `markClipSuccess`,
`clearStale`) go through **one serialised write chain** in
[`connection-store.ts`](../src/background/connection-store.ts) rather than
writing `chrome.storage.local` directly. The obvious reason is the usual
lost-update guard: a clip success and a 401 arriving together would both read
the pre-change record, and the second write would drop the first one's edit.
The less obvious reason is why `setConnection` and `clearConnection` — which
replace the whole record, called from `handlePair` and `handleUnpair` — go
through the same chain rather than writing directly: without it, a queue flush
that 401s while the user is re-pairing can interleave as *read-modify-write
reads the OLD record → `setConnection` writes the NEW one → the read-modify-write
writes back its transform of the old one*, silently reverting a fresh token to
the dead one it just replaced and telling the user to re-pair a browser they
have just re-paired. Narrow window, severe outcome — closed by putting every
writer on one chain. The chain is in-memory only, and that is sufficient: it
orders overlapping writes within one service-worker lifetime, and MV3 runs
exactly one service-worker instance at a time — across an eviction there is no
chain, and no other writer alive to race with either.

### Staged Options: locking is for never-configured, never for broken

`stagesFrom` (`src/options/setup-view.ts`) drives four ordered Options
stages — connect, connection, sites, trust — and the rule that decides which
are open is deliberate: **locking is for never-configured, never for
broken.** An unpaired browser locks stages 2 and 3; a *paired* browser with a
stale token or an unreachable gateway flags stage 1 as needing attention but
leaves 2 and 3 open. The reason is concrete, not a general principle:
**Unpair lives in stage 2**, and re-locking a broken connection's stage 2
would hide the only control that fixes the very condition that caused the
lock. Stage 4 — the trust panel — is **always** open regardless of pairing
state, because "where does my data go?" has to be answerable before you
commit to pairing, not only after. Locked stages are dimmed and inert in the
CSS, never removed from the DOM — a hidden stage is indistinguishable from a
missing feature, and a locked one at least tells you it exists. `healthLine`
checks `stale` before `reachable` for the same never-broken-silently reason: a
revoked token and a stopped gateway look identical from the outside, and only
one of them has a fix the user can act on — telling someone to check whether
their gateway is running when the real answer is "re-pair" is exactly the
silent failure this ordering exists to end.

## The clip pipeline

One pipeline serves **both** entry points — the popup's `clip` message and the
quick-clip route (context menu / `Alt+Shift+C` hotkey). Both build the same
`clipDeps` and call the same `handleClip`, so their behavior can never drift.

```
gesture (popup button │ context menu │ hotkey)
      │
      ▼
capture-in-page.ts  ──►  CaptureResult { url, canonicalUrl?, title, mode, body, readableFound }
      │                    (Readability, or fallback.ts bookmark)
      ▼
handleClip(deps)  ──►  clip.ts builds ClipPayload  ──►  postClip → gateway POST /v1/clips
      │
      ├─ 2xx            → respond ok { status: "created" | "updated" }
      ├─ transient      → enqueue + respond { ok:false, queued:true }   (unreachable / 429 / 5xx)
      └─ terminal       → respond { ok:false, queued:false }            (400 invalid / 413 too-large)
      │
      ▼
syncQueueState()  → repaint toolbar badge; arm/clear the flush alarm
```

The gateway's status codes are mapped to a small, closed set of typed reasons in
[`gateway-client.ts`](../src/background/gateway-client.ts): `unreachable`,
`unauthorized`, `rate_limited` (429 + `Retry-After`), `payload_too_large` (413),
`invalid_request` (400), `server_error`. **The distinction between transient and
terminal is the whole game** — it decides whether a failed clip is queued for
retry or reported and dropped.

## Showing what leaves (Phase 1.3 / C4.2)

Two different outbound requests get a confirm step: the popup's clip, and the
panel's targeted fetch. They share **one pure builder module**
([`shared/preview.ts`](../src/shared/preview.ts)) and **one pure renderer**
([`shared/preview-view.ts`](../src/shared/preview-view.ts)); the popup and the
panel each supply only their own DOM around them.

```
ClipPayload  ──► buildClipPreview  ──┐
                                     ├──► renderPreview(doc, …) ──► popup DOM │ panel Shadow DOM
FetchTarget  ──► buildFetchPreview ──┘
```

- **One builder per request shape, both fed the real thing.** `buildClipPreview`
  takes the `ClipPayload` the popup is *about to send* — not a second
  description assembled for display — so the preview cannot describe one request
  while another goes out. `buildFetchPreview` does the same for `FetchTarget`.
  A drift between what is shown and what is sent would need a change to the send
  path itself, which is the point.
- **Fields are listed explicitly, never iterated off the object.** This is the
  defence of the one hard invariant here: *the bearer token must never appear in
  a preview.* An `Object.keys(payload)` loop would faithfully render whatever a
  future caller happened to pass in — which is exactly how a secret reaches a
  screen. Adding a field to the preview is a deliberate line of code; inheriting
  one is not possible. (The token is not in `ClipPayload` today. This holds the
  property by construction rather than by remembering to re-check.)
- **The excerpt is cut; the reported length is not.** `bodyLength` is the length
  of the **whole** body even when only `EXCERPT_CHARS` of it is shown, because
  the user is agreeing to send the whole body. A preview that quietly reported
  only the part it displayed would understate what leaves — the same failure
  mode as no preview at all, wearing a preview's clothes.
- **Only the popup gets an off switch, and only for clips.** `preview-pref.ts`
  stores `preview-enabled` and **defaults to on, including when the read fails**
  — fail safe, not fail quiet: showing a preview the user turned off is an
  annoyance, while sending without one because storage returned something odd is
  precisely what this surface exists to prevent. The fetch confirm has no switch
  at all; it is an I13 write under the user's stored provider credential.
- **Quick-clip has no preview, deliberately.** The context menu and
  `Alt+Shift+C` are *one-gesture* paths — there is no popup DOM to render into,
  and interposing a confirm step would defeat the gesture. They report in the
  toast afterwards, and the trust panel says so in those words rather than
  implying every clip is confirmed.

## The recognition pipeline

Capture pushes a page *into* the index. Recognition asks the opposite question —
**what is this page, and is it already in the index?** — and it is the foundation
the roadmap's Phase C2 agent lanes hang off.

```
Alt+Shift+R / popup button
      │
      ▼
panel-in-page.ts  ──{ kind:"resolve", pageUrl: location.href }──►  service worker
                                                                        │
                            getOrigins()  ◄── the user's self-hosted instances (storage)
                                   │
                            recognise(url, origins)   shared/recognise.ts — PURE
                                   │
                    ┌──────────────┴───────────────┐
                    │                              │
              not recognised                  recognised
              (no gateway call)         { product, kind, ref, resolveUrl }
                    │                              │
                    │                    resolveItem(resolveUrl)
                    │                    GET /v1/items/resolve?url=
                    │                              │
                    │       ┌──────────┬──────────────────────┬───────────┬──────────┐
                    │     found    not_indexed /            ambiguous   403 / 404
                    │       │     unresolvable_url                │          │
                    ▼       ▼            │                        ▼          ▼
              "unrecog-  "resolved"      ▼                    chooser →   "needs-
               nised"                "not indexed"            "chosen"    scope" /
                                     (one header state for                "can't
                                      both — see note below)              resolve
                                                                          pages yet"
```

Four decisions worth knowing before you change any of it:

- **Recognition runs in the service worker, not the injected panel.** The
  configured origins live in extension storage and the bearer token lives in the
  SW; putting classification in the page would drag both into an injected script
  for no gain. The panel is a dumb renderer that sends one message and renders
  the state it gets back.
- **`location.href` is the recognition input, not the DOM's canonical link.** On
  a self-hosted Jenkins build or a Bitbucket PR the URL *is* the identity, and a
  canonical link is usually absent. The related-items query still reads the DOM
  canonical — a different question, kept separate.
- **The product is declared per origin, never inferred from the path.** Bitbucket,
  Jenkins and Jira are routinely self-hosted, often behind a reverse proxy on a
  sub-path, so origins are matched longest-prefix-wins and the prefix is stripped
  before the product's path pattern is applied. Path matching is case-sensitive
  for the same reason.
- **The gateway owns canonicalisation — the client does identity normalisation
  only.** `resolveUrl` is the address-bar URL with exactly one narrow change: the
  matched path prefix swapped for the matcher's normalised form (today only Jira
  does this, upper-casing the issue key). Query string and sub-tab path segments
  are sent as-is; stripping them client-side is exactly the duplicate
  canonicalisation this design removed. `GET /v1/items/resolve?url=` runs the URL
  through its own `canonicalizeUrl` (drops the fragment, `utm_*`/click-ids, a
  trailing slash) and then a bounded match ladder — exact key, then the
  query-stripped key, then up to three trimmed trailing path segments — reporting
  which rung matched as `matchKind`. `path_trimmed` is a weaker claim than the
  other two (part of the URL was discarded to get a hit) and the panel renders it
  as such; `exact` and `query_stripped` are shown with equal confidence. Identity
  normalisation stays client-side because the ladder is case-sensitive — a
  lower-cased Jira key would miss rungs 1 and 2 and then get trimmed away
  entirely on rung 3.
- **All four resolve outcomes are HTTP 200 — a miss is an answer, not a
  failure.** `found` (with `item` + `matchKind`), `not_indexed`, `unresolvable_url`
  and `ambiguous` (up to 5 candidates, `truncated` when the gateway held more back
  — see below) are modelled as a closed `ResolveOutcome` union, never as a
  generic 200/404 split. A 403 is `insufficient_scope`: every token paired before
  the gateway grew scopes lacks `resolve` (`LEGACY_SCOPES` is `["clip","briefs"]`),
  and the panel says so by name (`nimbus clip scopes`) rather than reporting a
  Nimbus error — the fix is a re-grant, not a re-pair. A 404 means this gateway
  build has no resolve route at all, and still surfaces as "this gateway can't
  resolve pages yet". Resolution is at most one item — the panel never passes
  ranked related hits off as "the page".
- **`not_indexed` and `unresolvable_url` render as the same header state.** The
  client models both as distinct `ResolveOutcome` arms (`not-indexed` and
  `unresolvable` in `ResolveOutcome`, kept apart because they mean different
  things server-side: one is "we looked and it isn't there", the other is "we
  couldn't even parse the URL you sent"). But `unresolvable_url` can only happen
  if this client sent the gateway a `resolveUrl` its own `canonicalizeUrl` can't
  parse — a bug in `recognise()`, not a fact about the user's page. The panel
  deliberately has no `HeaderState` arm for it: `panel-in-page.ts`'s
  `headerFrom` folds `unresolvable` into `not-indexed` before it ever reaches
  `renderHeader`, so both read as "Not indexed." to the user. A user-facing
  "can't resolve this URL" distinction would be reporting a client bug as if it
  were information about their page.
- **`chosen` is a separate header state from `resolved`, not a rendering of the
  same state.** When the outcome is `ambiguous`, the panel renders a chooser over
  `candidates`; picking one repaints the header as `chosen`. A candidate has no
  `modified_at` — the gateway sends freshness only for a resolved item, never for
  a candidate — so rendering a chosen candidate as `resolved` would mean
  inventing an age for it, which is precisely the invisible staleness this header
  exists to avoid. `truncated` renders no chooser at all: the gateway sends an
  empty candidate list on that arm specifically so the client cannot imply the
  right answer is sitting on a shortened menu.
- **The freshness line says "Updated", not "Indexed", and the distinction is not
  cosmetic.** `modified_at` is the item's own last-modified time as its source
  system reports it — GitHub's `updated_at` for a pull request. It has no relation
  to when the row was written: a targeted fetch can index a PR in under a second
  and be told it was last touched three days ago. The header said "Indexed" until
  the C3.1 manual pass caught it against a real connector item; every unit fixture
  and the earlier manual pass had used web *clips*, whose `modified_at` IS the clip
  time, so the wrong label was accurate by coincidence. When adding a fixture here,
  prefer a connector-sourced item over a clip — the two agree on this field only
  for clips, which is exactly what hid the bug.

### Page access is a different axis from network access

Recognition needs to see the URL of pages that are not the gateway. That is
**page access**, and it is opt-in at runtime (`optional_host_permissions` +
`src/browser/permissions.ts`), granted from the Options page.

Two scopes that are easy to conflate, and deliberately are not the same:

- **Recognition is configured per origin** — scheme + host + port, plus an
  optional path prefix. `https://corp.example/jira` and
  `https://corp.example/jenkins` are two independent entries.
- **The browser permission is granted per host** — `https://corp.example/*`.
  Match patterns carry neither a path constraint we'd want nor a port at all, so
  one grant covers every configured prefix on that host, and revoking it
  withdraws access from all of them. The Options UI says so when a host carries
  more than one entry (`sharedHostNote`). It is inert at install, and it never changes where the extension
can *send* anything — that remains loopback-only (**I6**). Grants are host-scoped
(`https://corp.example/*`) even when the configured origin carries a path prefix,
because the browser's permission warning is per-host either way.

Today the panel works without any grant at all: `Alt+Shift+R` and the popup
button are user gestures, which give `activeTab`. The grant buys gesture-free
recognition, which Phase C2 is the first to need.

### One panel, one page

An injected panel captures `window.location.href` at mount, and re-pins it only
on an explicit re-read — the notice's own **Re-read page** button, described
below. The pinned URL is sent with the four messages that carry a page URL:
resolve, fetch, `agent-run` and `agent-state`. Two messages deliberately do not
carry it: `related` carries no URL at all, and `recognise` — the watcher's own
probe, described next — deliberately carries the LIVE `window.location.href`,
because its whole job is comparing the pin against where the tab actually is.

The reason is that the header is painted from one resolve response while the
lanes are expanded later, and GitHub, GitLab and Jira are all SPAs: reading the
live URL per send let a lane answer about the tab's current page under a header
naming the page the panel was opened on. Pinning makes that divergence
unrepresentable rather than unlikely.

A 500 ms watcher (plus `popstate`, and skipped while `document.hidden`) compares
the tab's **item identity** against the pin — `(product, kind, ref)` from
`recognise()`, not the URL, because `resolveUrl` keeps sub-tab segments and the
query string on purpose, so a pull request's Files tab is a different URL and the
same item. On a real change the panel renders a notice naming the item it is
still about, and **Re-read page** re-pins and resets the page-scoped state. It
never re-resolves on its own: nothing in this panel reaches the gateway without
being asked.

Two rules hold the mechanism together. The watcher paints **only when the notice
appears or disappears**, never per tick, because `HeaderState.resolved`'s `nowMs`
is frozen at response time and timer-driven repaints would hide real staleness.
And every `recognise` send takes a `recogniseSeq` ticket: rapid navigation puts
several in flight, and a late answer about an earlier URL would otherwise clear a
notice that a newer answer had just raised.

The classification itself rides on a dedicated `recognise` message
(`handleRecognise`) that runs the pure recogniser and makes **no gateway call and
no token read** — the panel cannot classify a URL itself, because the configured
origins live in the worker, and shipping that list into a content script would
expose the user's internal hostnames to save a message that costs no network.

#### What the related lane asks about

The lane sends `itemId` whenever the panel's header names an item — `resolved`,
or the candidate the user picked on an `ambiguous` page — read from the same
header state the panel renders, so the lane cannot describe a different item than
the header above it. The gateway then queries on that item's own title and drops
it from its own results.

Two rules are deliberately independent. **Precedence for the query text** is
`selection` → `itemId` → `title`, so *What's related to this?* keeps working on a
resolved page. **Self-exclusion** is keyed on the id being *present*, not on it
having won — otherwise selecting a phrase on a pull request would return that
pull request as its own top hit.

`title` is sent even alongside `itemId`: a gateway predating the `itemId` query
ignores the id and falls back to the title, and dropping it would leave that
gateway with an empty query, which it answers with zero hits. `canonicalUrl` is
the one field withheld once an id exists — the gateway uses it to exclude the
whole *host*, which on a working surface throws away exactly the items worth
showing.

## The targeted-fetch path

A resolve miss (`not-indexed`) can mean the gateway has a connector for this
service but has never synced *this* item — `fetchable: true` says so. **C3.1**
turns that miss into a button: ask the gateway to go fetch and index that one
item through the connector that already owns it, then re-resolve.

```
not-indexed, fetchable ─{ click "Fetch this from GitHub" }─►  panel-in-page.ts
                                                                     │
                                       { kind:"fetch", pageUrl: location.href }
                                                                     │
                                            service worker → recognise() gate
                                                                     │
                                             fetchItem(origin, token, pageUrl)
                                       POST /v1/items/fetch — under `fetch` scope
                                                                     │
      ┌───────────┬─────────────────────┬───────────────┬───────────┼──────────┐
   indexed    not_found /          not_configured   rate_limited  403      timeout
              unsupported_url /                                 (scope)   (client
              no_targeted_fetch                                            abort)
      │           │                     │                │          │         │
  re-resolve  "unfetchable"      "no connector      "Try again"  needs-    "Still
  (no header  — nothing to        configured on      — safe,     fetch-    working"
   built from  do)                your gateway"       nothing     scope    — re-
   the fetch                                          was sent              resolve,
   response)                                           yet"                 not
                                                                             re-fetch
```

- **`POST /v1/items/fetch` is a WRITE, not a read with side effects.** It is an
  explicit addition to invariant **I13**'s write allowlist (see
  [`src/shared/gateway.ts`](../src/shared/gateway.ts)), because it causes an
  *outbound* request to a real provider (GitHub, Jira, …) under the gateway
  owner's stored credential — a materially different action than `resolve`,
  which only reads the local index. That is why it needs its own explicit user
  gesture (the button click; nothing fetches on panel open) and its own `fetch`
  token scope, distinct from `resolve`. A token that can resolve pages cannot
  fetch one until the owner separately grants `fetch` — repeating `resolve`'s
  scope guidance in that state would be a dead end, so `fetch-blocked` /
  `needs-fetch-scope` gets its own copy in `panel-view.ts`.
- **Six wire outcomes collapse to four client-facing ones, deliberately not
  five.** `not_found`, `unsupported_url` and `no_targeted_fetch` differ in *why*
  the gateway declined but are identical in what the user can do about it —
  nothing — so `gateway-client.ts#parseFetchBody` collapses all three into one
  `unfetchable` outcome. `indexed` and `rate_limited` keep their own arms
  because each drives genuinely different client behavior (re-resolve; a safe
  retry). `not_configured` is the one arm that stays separate even though its
  *user-visible result* ("nothing happens") looks like `unfetchable`'s: an
  unconfigured connector must say so **by name** — "No GitHub connector is
  configured on your gateway." — instead of inviting a retry that can only ever
  fail again the same way. Folding it into `unfetchable` would turn a permanent,
  nameable condition into generic "can't fetch this" noise, which is exactly
  what C3.1's done-when ("an unconfigured connector says so plainly instead of
  retrying") rules out.
- **A client-side timeout is not a failure — it is modelled as its own
  `FetchError` arm, never collapsed into `unreachable`.** `fetchItem`'s 30s abort
  firing means *our* wait gave up; it says nothing about whether the gateway's
  outbound call to the provider is still running. Reporting it as a failure
  would assert something we have not established, and a retry there would risk
  a second outbound provider request for work that may already be in flight or
  done. `unreachable` means the connection itself failed — nothing was sent, so
  a retry is unambiguously safe. That is why the `timeout` header
  (`fetch-retry`/`still-working`, "Still working — your gateway may not have
  finished. Nothing was lost.") wires its recovery button to send
  `{kind:"resolve"}`, **not** a second `{kind:"fetch"}`: it re-checks whether the
  item showed up rather than asking the gateway to fetch it again.
- **One fetch per panel — a latch, not a counter.** `panel-in-page.ts` tracks a
  boolean, `fetchSent`, that means "an outbound provider request *may currently
  be in flight*", not merely "a fetch message was sent". Once set it stays true
  for the life of that panel instance — the Fetch button never reappears, even
  if a recovery re-resolve comes back as another miss — because the panel
  cannot distinguish "still fetching" from "the fetch died", and re-offering the
  button in that gap would risk firing a second outbound request for work that
  might still be running. `rate_limited` is the one outcome that clears the
  latch back to false: the gateway returns it **before** any outbound call
  happens, so nothing is in flight and a second click is exactly as safe as the
  first. Reopening the panel is the deliberate escape hatch — a fresh resolve by
  then either finds the item or offers the button again.
- **The confirm step sits in front of the request, and `fetchSent` stays behind
  it.** Clicking Fetch no longer sends anything: it names the target and opens
  the preview (see [Showing what leaves](#showing-what-leaves-phase-13--c42)
  above). The latch is set where it always was — inside the confirmed path, in
  `sendFetch` — and **not** when the preview opens. Opening a preview is not an
  attempt: nothing is in flight, so nothing needs latching. Setting it on open
  would mean a cancelled preview permanently disabled the button, turning "no
  thanks" into "never again" for that panel. Both routes into a fetch (the
  initial button and a `rate_limited` "Try again") go through the same confirm,
  because both fire the same outbound provider request.

## The ambient path (Phase C1.3, the deferred half)

C1.3 shipped the panel **user-summoned** and said why: ambient auto-surfacing
waits until the lanes have real answers. C2 gave them real answers, so this
slice adds the other half — a small cue that tells you the panel would have
something to say, before you ask it. Full reasoning, including the four
decisions behind the shape of it:
[`docs/superpowers/specs/2026-08-13-ambient-surfacing-design.md`](./superpowers/specs/2026-08-13-ambient-surfacing-design.md).

On a host the user has **granted page access to** and **switched "Surface
automatically" on for**, landing on a page that resolves to exactly one
indexed item mounts a small corner cue naming it. Clicking it opens the
existing panel on that item; dismissing it silences that item in that tab.
Nothing runs — no agent, no lane. Everything that is not a resolved item is
silence: not-indexed, ambiguous, unresolvable, every resolve error, an
unpaired gateway, a restricted page.

```
chrome.tabs.onUpdated (changeInfo.url present)   ← lock #1: the browser omits
      │                                             this field on ungranted hosts
      ▼
addNavigationListener (src/browser/tabs.ts)
      │
      ▼
~600ms debounce, per tab (AMBIENT_DEBOUNCE_MS, service-worker.ts) — SPA URL churn
      │
      ▼
decideAmbient (src/background/ambient.ts) — PURE, the whole decision
      │
      ├─ tab active? ──────────────────────────────── no ──→ silence
      ├─ host granted AND toggled on? (isAmbientUrl) ─ no ──→ silence   ← lock #2
      ├─ recognise(url, origins)  [pure, no gateway call] ── no ──→ silence
      ├─ already cued for this item, this tab? (sameItem) ─ yes ─→ silence
      ├─ resolve()  [one loopback call]
      │    ├─ found ──→ re-check the tab still exists and is still on this URL
      │    └─ anything else (miss / ambiguous / any error) ──→ silence
      └─ "show" → showCue(tabId, cue) injects cue.js, calls __nimbusCue(state)
```

- **The trigger chain.** `chrome.tabs.onUpdated` (wrapped as
  `addNavigationListener`) fires on history-API navigations too, which is what
  lets an SPA — GitHub, GitLab, Jira all rewrite the URL without a page load —
  reach the listener at all. Each firing resets a ~600ms per-tab debounce
  (`AMBIENT_DEBOUNCE_MS`) before `decideAmbient` runs, so a client-side
  navigation that rewrites the URL twice costs one resolve, not two. On a
  `"show"` decision, the worker calls `showCue` (`src/browser/scripting.ts`),
  which injects `cue.js` and then calls its `__nimbusCue` global — the same
  two-step pattern `toast.js` already uses.

- **Why the decision lives in a pure module, and the worker only wires.**
  `decideAmbient` (`src/background/ambient.ts`) takes every dependency
  injected — `enabledHosts`, `getOrigins`, `lastCued`, `resolve`, `currentUrl`
  — and imports no `chrome.*` API. That is what makes the feature's actual
  behavior a Vitest decision table in a node environment: granted × enabled ×
  active × recognised × each resolve outcome × dedupe × dismissal, run without
  a browser. `service-worker.ts` supplies the real deps and does exactly the
  two things a pure function cannot: hold a real per-tab debounce timer and
  call `chrome.scripting.executeScript`. This is the same split the rest of
  `src/background/` follows (see "Why the pure core is testable" below) —
  applied here to a decision with more branches than most.

- **The two permission locks.** The first is the browser's own, not ours:
  `chrome.tabs.onUpdated`'s `changeInfo.url` is populated only for tabs the
  extension holds host permission on (`addNavigationListener`'s doc comment
  states this explicitly), so a page on a host the user never granted is
  invisible to the listener by construction — no code of ours runs at all.
  The second is `isAmbientUrl` inside `decideAmbient`, checking the user's
  **"Surface automatically"** toggle. The two are deliberately independent:
  the grant is what makes gesture-free recognition possible; the toggle is
  the separate decision to be interrupted about it. Someone may want the
  first on `github.com` and the second only on their team's Jira. Because the
  first lock is enforced by the platform and the second is enforced by this
  code, only the second is a property this repo can assert in a test — which
  is exactly what keeps the first from silently becoming a coincidence rather
  than a guarantee (see the design spec's framing of the same point).

- **Why the dedupe map is in memory, keyed by item rather than URL.**
  `lastCuedByTab` (`service-worker.ts`, a module-scope
  `Map<tabId, Recognition>`) is cleared on `chrome.tabs.onRemoved` and never
  written to `chrome.storage.local`. Not persisting it is deliberate: a
  service-worker eviction re-cues the same item once, and that is a better
  failure than a suppression that outlives the reason for it — the same
  reasoning decision 4 in the design spec applies to permanent dismissal.
  It is keyed by `sameItem` (`product` + `kind` + `ref`, from
  `shared/recognise.ts`) rather than by URL because `resolveUrl` deliberately
  keeps sub-tab path segments and the query string (see "the recognition
  pipeline" above) — a pull request's *Files changed* tab is a different URL
  and the same item. Keying the dedupe map by URL would re-cue on every
  sub-tab switch, which is precisely the nagging the per-item key exists to
  prevent. The entry is written only **after** `showCue` actually mounts the
  cue, never when an attempt merely starts — so a run abandoned because the
  tab closed or navigated mid-resolve leaves no trace, and the very next
  landing on that item still gets a cue.

- **The generation counter, not cancellation.** A per-tab
  `ambientGeneration` counter increments on every navigation; after the
  `resolve` await returns, `runAmbient` checks its own generation is still
  current and drops the result if a newer navigation has since started. This
  is deliberately not an `AbortController` — see the design spec's
  "Deferred, with reasons" — because caller-side cancellation would mean
  threading a signal through `resolveItem`/`handleResolve`, a seam the panel
  shares, to save a request whose work the gateway may have already begun.
  What actually matters is correctness, and the generation check plus the
  post-resolve re-check of the tab's URL buys that without the plumbing.

- **Why every non-`found` outcome is silence.** `not_indexed`,
  `unresolvable_url`, `ambiguous`, every `ResolveError`, a throw from the
  resolve route, an unpaired gateway, a restricted page that rejects
  injection — all of them collapse to no cue and no trace. The panel is
  where errors get *spoken*, because the user asked it something directly;
  the ambient path never earned the right to interrupt a page someone is
  reading with a problem report. The deliberate cost: a user who grants,
  toggles on, and is not paired sees nothing and is not told why. That state
  is answered where it lives — the Options row shows the toggle as on, next
  to the existing connection status that already reports the pairing.

- **The cue retracts itself.** Once mounted, `cue-in-page.ts` runs the same
  500ms URL watch the panel already uses (`NAV_CHECK_MS`, mirroring
  `panel-in-page.ts`) and tears itself down on a URL change — the identical
  defect the panel-page-context slice (2026-08-11) fixed for the panel,
  paid for once here rather than re-learned. It also tears down if the panel
  appears by any other route (the hotkey, the popup button, the context
  menu all inject it directly): a mounted `#nimbus-related-host` means the
  cue has nothing left to add, and two surfaces answering the same question
  is worse than one.

- **Clicking through carries no page URL.** The `cue-open` message
  (`shared/messages.ts`) is a bare signal — the tab id comes from the
  message's own `sender`, never from the payload, because the cue runs in an
  untrusted page and a payload-supplied tab id would be forgeable. The
  worker calls the same `injectPanel` every other entry point uses; the cue
  tears itself down first so the cue and the panel are never on screen
  together.

The Options prerequisite this slice discovered — that `github.com`,
`gitlab.com`, `bitbucket.org` and Jira Cloud had no row at all, and so no way
to be granted page access, because the Grant button lives on a row — is C1.4's
gap, not this feature's; see C1.4 in [`ROADMAP.md`](../ROADMAP.md) for what
closed it.

## A second way into the panel (Phase C1.5)

C1.3 shipped the panel behind `Alt+Shift+R`, and — as the roadmap's own
2026-08-11 correction records — the popup's **Show related** button, which
means the panel was never actually reachable by hotkey alone. What was still
true is that `suggested_key` in the manifest is exactly that, a *suggestion*:
when another extension already holds `Alt+Shift+R`, the browser leaves the
command unbound, reports nothing to the page, and the keystroke goes wherever
the other extension sends it — which is precisely what happened in Chrome
during the Phase C1 manual pass. This slice adds a context-menu entry the
browser cannot silently withhold, and a way for the user to see, rather than
guess, what their browser actually bound.

### `openPanel` — the one path every in-worker trigger converges on

`openPanel(tabId?)` (`service-worker.ts`) is the single function the hotkey's
`addCommandListener`, the context menu's `show-related` branch, and the
ambient cue's `openPanelForCue` all call to inject the panel. (The popup calls
`injectPanel` directly — it is its own bundle and cannot reach a function
defined inside the service worker, so its convergence is on *behavior*, not on
a shared call site.) Routing every in-worker trigger through one function is
not tidying for its own sake: the panel must not behave differently depending
on how it was summoned, and three call sites each carrying their own
"resolve the tab, then inject" logic is exactly how that kind of drift starts
— a fix landing on one path and quietly not reaching the other two.

### `menuAction` returns `null`, not a default

`menuAction` (`src/background/menus.ts`) maps a context-menu id to an action,
and an id it does not recognise returns `null` rather than falling back to
"clip the page." That reads as defensive boilerplate until you look at what it
replaced: the previous handler routed every non-selection menu id as a clip —
`menuItemId === "clip-selection" ? "selection" : "article"` — because there
had only ever been two ids and one of them was the selection case. The moment
a third entry (`show-related`) existed, that logic would have silently
clipped the page on a right-click meant to open the panel. Returning `null`
for an unrecognised id is what makes that latent bug impossible rather than
merely unlikely: an id this module does not know about now does nothing,
which is the only safe default for an action with side effects.

### The shortcut readout exists because the browser will not tell you otherwise

Options stage 2 now lists all three commands with the shortcut the browser
actually bound, via `getAllCommands()` (`src/browser/commands.ts`) — never the
manifest's `suggested_key`. This is the only surface that can say so: an
unbound command reports nothing anywhere else — no error, no empty state,
nothing hinting a shortcut was ever supposed to exist. `Alt+Shift+R` silently
failing to bind in Chrome is the defect the whole slice traces back to.
`shortcutRows` (`src/options/shortcuts-view.ts`) renders an unbound shortcut
as the words **"Not set"**, never a blank cell — a blank cell reads as a
rendering bug, and "Not set" reads as the true state of the world.

### A copyable path, not a link — per target

`shortcutsHint` (`src/options/shortcuts-view.ts`) tells the user where to fix
a binding as prose plus a pasteable path, not an `<a href>` — forced, not
stylistic. Chrome refuses to let an extension page navigate to
`chrome://extensions/shortcuts`; a link there would silently do nothing, which
is a second invisible failure stacked on the one this slice exists to fix.
Firefox's equivalent lives at `about:addons` → the gear menu, a different path
entirely — which is why the hint branches on `isFirefoxRuntime()`
(`src/browser/runtime.ts`, derived from the extension's own URL scheme, never
the spoofable user agent) rather than being one string for both targets.

### Why `registerMenus` isolates each entry in its own try/catch

`registerMenus` (`src/background/menus.ts`) wraps each `create` call in the
`MENU_ITEMS` table individually rather than letting one throw abort the rest
of the loop. `show-related` is deliberately **last** in that table, so without
this, a throw while creating either clip entry would take out precisely the
entry this slice exists to add — and the caller already swallows the whole
registration (`registerContextMenus().catch(() => undefined)`), so that loss
would be silent. Isolating each entry does not make a failure louder; it stops
one bad entry from deleting the rest.

## The agent lanes (Phase C2.1 / C2.3)

On a resolved page (the `resolved` header state) the panel offers two collapsed
lanes below Related — *what breaks if it lands* (`agents.impact`) and
*who should review it* (`agents.expert`) — each answered by an agent that
already exists behind the gateway. C2.3 added a second class of lane, gated on
a different page kind and skipping resolve entirely — see "Item lanes vs.
service lanes" below. Two routes, shared by both classes:

```
POST /v1/agents/{agent}        202 { runId }            · 404 unknown agent · 429 busy (Retry-After)
GET  /v1/agents/runs/{id}      200 { status, brief?, failureReason? } · 404 · 410
```

Expanding a lane is the only trigger — nothing runs on panel open, and within
one panel session a second expand of an already-`running`/`done`/`failed` lane
never re-invokes (only its Re-run button does): `onLaneToggle` sends `agent-run`
only while the lane's in-memory state is still `collapsed`. Across a panel
*reopen* that in-memory state is gone and every lane starts `collapsed` again,
so the first expand does send `agent-run` — and the handler's own cache decides:
`running`/`done` short-circuit, `failed` re-invokes (see the store bullet
below).

A `chosen` header — a candidate the user picked out of an ambiguous answer —
gets **no** lanes. `agent-run` carries only `{lane, pageUrl}`, so the handler
re-resolves the page and gets the same ambiguous answer back, which
`resolveForAgent` refuses as `not_resolved`; a lane there would contradict its
own header with a refusal it could never retry past. Deferred as ROADMAP
**C2.5**, which is where the picked id gets carried through the message.

`impact` receives `recognition.resolveUrl` as
`fileOrPrUrl`; `expert` receives the resolved item's `title` as `topicOrFile` —
both request bodies pass through to the gateway's validator verbatim, so the
client sends exactly the shape each agent's own scope expects, no more.

- **404 and 410 on the poll route collapse into one `stale` state.** Upstream
  distinguishes "unknown, possibly lost to a gateway restart" from "known, but
  past its TTL" — but the client's answer to both is identical: re-issue, never
  keep waiting. Modelling two client-facing reasons for one recovery action
  would be a distinction with no behavioral difference, so `AGENT_ERRORS`
  (`src/shared/types.ts`) has exactly one `stale` member and `getAgentRun`
  (`gateway-client.ts`) folds both statuses into it before the client ever sees
  a difference. `renderLaneBody` gives `stale` a working Re-run button — as it
  does four other reasons: `not_paired`, `unreachable`, `server_error` and
  `agent_failed`, five of the nine `AGENT_ERRORS` in all. The rule is whether a
  retry *from this panel* can succeed, not whether the fix is local:
  `unreachable`/`server_error`/`stale` are transport blips, `agent_failed`
  reached the agent and may answer differently next time, and `not_paired` is
  fixed in Options but retried here — its copy names pairing first, so the
  button is never the whole instruction. The remaining four (`unauthorized`,
  `insufficient_scope`, `unsupported`, `not_resolved`) get guidance and no
  button: each needs re-authentication, a scope grant, a different gateway or a
  different page before any retry could do anything but fail identically.
- **`chrome.alarms` is the EVICTION NET, not the poll cadence.** The real
  cadence is an in-worker `setTimeout` loop (`tickAgentPoll`/`scheduleAgentPoll`
  in `service-worker.ts`) that backs off from 500ms toward a 2s ceiling while
  the worker is alive — agent runs finish in seconds, and `chrome.alarms` has a
  hard one-minute floor, so alarm-driven polling would turn a two-second answer
  into a minute-long wait. The alarm (`AGENT_POLL_ALARM`) exists only so a run
  whose worker was evicted mid-poll is still picked up: on wake, its handler
  (`resumeAgentPolls`) reads the store's still-running runs and resumes a
  `setTimeout` loop for each, then clears the alarm once nothing is left
  running. `activeAgentPolls` (an in-memory `Set<runId>`) keeps a periodic
  alarm tick — which Chrome fires whether or not an eviction actually
  happened — from spawning a second, uncoordinated backoff loop for a run
  already being polled locally.
- **Runs outlive the panel; the store is what makes that true.** `putRun`
  persists every state transition to `chrome.storage.local`
  (`agent-run-store.ts`), keyed by resolved item id + lane, with a TTL mirroring
  the gateway's own and a bounded, oldest-first eviction cap. Closing and
  reopening the panel — or the worker itself being evicted and restarted mid-run
  — replays from that store through `handleAgentRun`, NOT `handleAgentState`: a
  reopened panel holds no lane state, so every lane starts `collapsed` and the
  first expand sends `agent-run` exactly as a first-ever expand does.
  (`handleAgentState` is only an OPEN panel's ~1s repaint poll — it never
  invokes.) `handleAgentRun` then reads the store and short-circuits on a cached
  `running` or `done`, which is what makes re-expanding a finished lane replay
  the brief instead of spending a second model call. A cached `failed` is
  deliberately NOT short-circuited: a failure is not an answer, `agent-run` only
  ever arrives from an explicit user action, and re-invoking self-heals the
  moment the cause is fixed (a scope granted, a gateway brought back up). Note
  the panel paints one optimistic "Working…" frame on any expand that sends
  `agent-run` — including a cached hit, since the paint precedes the round trip.
- **The brief renders as `textContent`, never parsed, never `innerHTML`.** On a
  gateway with an LLM configured, the brief is model output rendered inside a
  Shadow DOM that overlays the user's authenticated session on the page it was
  opened on (e.g. `github.com`). Interpreting any of it as markup — even a
  "safe subset" markdown pass — would be a direct prompt-injection-to-XSS path:
  a brief containing `<img src=x onerror=...>` must create zero elements, only
  a text node. The same rule applies to `failed`'s `failureReason`/`detail` —
  it is free text from the gateway, not from the model, but it is still
  attacker-adjacent (an agent's own explanation of why it failed) and gets the
  identical `textContent` treatment in `renderLaneBody`. This is the line most
  likely to be "optimised" away by someone adding rich formatting later — the
  cost (no headings, no bold, no clickable links) is accepted deliberately, and
  a real safe renderer is its own separate, explicit decision, not a drive-by
  addition here.
- **No `busy` `AgentError` member.** A 429 from the invoke route never
  reaches the panel as a failure. `invokeAgent` (`gateway-client.ts`) reports
  it as `{ ok: false, reason: "busy", retryAfterMs }`; `handlers.ts`'s
  `invokeWithRetry` is what absorbs it — backing off for the gateway's own
  `Retry-After` (sized at ~1s, because a slot frees when some other run
  finishes) and retrying exactly once. A second `busy` within that window
  means genuine contention a longer wait would not fix, and reports
  `server_error` rather than backing off again — `busy` itself never escapes
  as a stored lane state.
- **Abort is deferred, not shipped.** C2.2 named it in the roadmap, but
  `agents.*` has no upstream cancellation — no `AbortController`, no job
  registry a cancel could target. A UI-only "abort" that just stopped polling
  would claim to cancel a run that is, in fact, still going. See ROADMAP.md's
  C2.2 entry for the correction.

### Which lanes appear where

`LANE_RULES` (`src/shared/types.ts`) says what each lane needs before it can be
asked anything. It is a discriminated union, not a table of independent fields,
because the two arms are exclusive and each carries something the other must not
have:

- `{input: "page", surfaces}` — the lane's whole input comes from the page, so it
  declares which `SurfaceKind`s it belongs on. `impact` and `expert` are
  `["pr"]`; `catchup`, `decisions` and `ownership` are `["home"]` — see the next
  section for what `"home"` is and why those three could not simply join the
  other two.
- `{input: "term"}` — the lane's input is a selection the user made, so a surface
  list would be meaningless. `glossary` is the only member.

`impact` and `expert` were previously gated on "the page resolved to an item"
alone, so a resolved Jira issue or Jenkins build offered *What breaks if it
lands* and handed that page's URL to `agents.impact` as its `fileOrPrUrl` — a
question that does not apply, from an input the agent was not built for.

The table is keyed by `AgentLane`, so adding a lane without declaring its rule is
a type error. Surface gating is on the recogniser's `kind` — a closed union this
repo owns — and not on `ResolvedItem.type`, which is a free-form string from the
wire.

### Lanes that take an input (C2.5 · glossary · 4.2)

Two optional fields on `agent-run`/`agent-state` carry everything a lane needs
beyond the page, both narrowed in `messages.ts` because both arrive from a
content script. The run and the poll must send identically: they key one cache
entry, so a poll that dropped a field would look up a different subject and
report `collapsed` forever. `src/panel/lane-input.ts` is the single source both
read from, which is what makes that impossible rather than merely unlikely.

**`itemId` — the candidate the user picked.** On an ambiguous page the panel
offers a chooser; before this the answer was thrown away one control later,
because `handleAgentRun` re-resolved for itself, got `ambiguous` again, and
refused with `not_resolved` under a header naming the item just picked.
`resolveForAgent` now honours a supplied id **only after confirming it appears in
the candidate set that resolve produced** — an id the gateway never offered is
refused. The carried item is typed `ResolveCandidate`, not `ResolvedItem`, so
nothing downstream can read a `modifiedAt` that a picked candidate does not have.

**`term` — a selection.** `glossary` skips the recogniser gate and the resolve
call entirely: `POST /v1/agents/glossary` takes `{ term }` and no URL, and the
gate exists to decide which page URLs may reach the gateway. So the lane answers
on any page the panel opens on, including one the recogniser rejects — often
exactly where an unfamiliar term is. Like a service lane, it needs only the
`agents` scope. The term is normalised once, in `shared/term.ts` (whitespace
collapsed, control characters turned into spaces so two lines do not weld into
one word), and anything over 128 characters is **refused, never truncated** —
answering about the first 128 characters of a 3,000-character selection would
look exactly like the feature working. The panel renders that refusal itself,
without a round trip, because it is the side that still has the user in front of
it; the message guard refuses the same input independently.

`RunSubject` (`agent-run-store.ts`) grew a third arm for terms, with a
**sub-budget of 6 inside the unchanged 16**: items and services are bounded by
what the user visits, a term is bounded only by what can be selected, so the
unbounded subject must not evict the bounded ones. A PR brief is expensive to
regenerate; a term lookup is cheap and usually asked once.

**Delivery.** Two selection-context menu entries — *Define in Nimbus* and *What's
related to this?* — carry `info.selectionText`, which is authoritative in a way
the page is not: the browser captures it when the menu opens, so it survives a
page script that clears the selection, and it includes text selected inside an
`<input>` or `<textarea>`, which `window.getSelection()` reports as empty. The
worker cannot deliver by re-injecting `panel.js` — that entry self-toggles and
would close the panel it is trying to reach — so `deliverSelection`
(`browser/scripting.ts`) calls a hook on the mounted panel's host element and
injects only on a miss. The element id and hook name live in
`src/shared/panel-host.ts` so the two sides cannot drift; a mismatch there fails
silently, which is the worst way for this to fail. A panel also snapshots any
live selection when it mounts, so the lane appears — collapsed — without a menu
entry at all; that is the convenience path, and the menu is the contract.

#### Capture as the last resort (Phase C3.2)

Capture is the fallback for a page nothing else can help with, not a second way
to get a page nothing else *tried*. Which header states offer it follows
directly: `unrecognised`, a `not-indexed` miss that is `fetchable: false`, and
every terminal `fetch-blocked` arm (`unfetchable`, `not-configured`,
`needs-fetch-scope`) all offer capture, because in each of them the gateway has
nothing left to try. A `not-indexed` miss that **is** fetchable does not — C3.1's
fetch button is the better answer and it is right there, and a scrape would be a
lower-fidelity copy of data the connector already models properly. A *transient*
fetch failure (`rate_limited`) is deliberately not an offer either: a retry beats
a scrape, so the panel renders "Try again," not a capture button, while the
gateway is only busy rather than permanently unable.

**Capture refuses on a pinned-URL mismatch, because the DOM cannot be pinned.**
The panel pins the URL it opened on, but on an SPA the live page can navigate
while a capture is in flight — and capturing that live DOM under the pinned
URL would file the new page's content against the old page's address, a
corrupt index entry that is worse than either capturing the wrong page or
refusing outright. So the check is an equality test against the pinned URL,
run twice: once before injecting `capture.js` (closing the window before
injection starts), and once against `CaptureResult.url` — `location.href` read
*inside* the page at capture time — on the result that comes back (closing the
window opened by the injection round-trip itself, which an SPA can navigate
inside of). Either mismatch yields `url-changed`, never a captured item filed
under the wrong address.

**The scheme guard lives in the worker, not the panel, because the caller is a
content script.** The panel's offer only ever renders on an injectable page, so
a well-behaved panel could never send a `capture` message for `chrome://` or
similar. But the panel is untrusted input the same as every other cross-boundary
sender in this repo — a hostile or compromised page script can send whatever
`capture` message it likes — so `capture-tab.ts` re-checks `isRestrictedUrl`
itself before injecting, rather than trusting that the rendering rule holds.
The guard's correctness does not depend on the offer never being rendered
somewhere it shouldn't be.

**The captured-copy header keys off `service`/`type`, not recency.** A resolved
item with `service: "nimbus"` and `type: "web_clip"` renders as a captured
copy, whichever way the panel arrived at it — capturing it just now, or
opening the panel on it a month later. Flagging the state right after
capturing instead would be wrong: a page captured last week resolves like
anything else on a later visit and would then quietly present as connector
data, the same dishonesty the header exists to prevent, just delayed. Those two
values are `CLIP_SERVICE` and `CLIP_TYPE`, named once in `src/shared/types.ts`
rather than left as a literal buried in a predicate — each with the upstream
`file:line` (`packages/gateway/src/clips/clip-ingest.ts:7-8`) in its comment.
This is a real coupling to a constant this repo does not own, across two
separate repositories with nothing to import from: if the gateway ever renames
either value, the header silently degrades to the ordinary resolved arm rather
than breaking outright — the failure mode worth knowing, not solved locally by
vendoring a shared-constants package the "bundled, no runtime deps" rule
forbids. It is the same class of duplication the proposed Nimbus SDK (see "The
SDK seam" below) exists to absorb.

**The durability that header promises holds only on a recognised page.** A
resolve request is only ever sent for a page the pure recogniser accepts —
`handleResolve` (`src/background/handlers.ts`) short-circuits to
`not-indexed` on an unrecognised URL, before any gateway call, and that gate is
deliberate: it is the C1.4 page-access privacy boundary, and loosening it to
ask the gateway about arbitrary un-configured URLs was considered and
rejected. So a wiki page captured today can never come back as a resolved
`web_clip` item on a later visit — it stays `unrecognised` every time, gateway
untouched. The panel's answer there is not the durable header; it is a
terminal *"Saved a copy of …"* confirmation rendered once, right after a
successful save, which is what makes the unrecognised path honest without
needing the gateway to ever be asked about that URL again.

Full reasoning:
[`docs/superpowers/specs/2026-08-16-capture-as-last-resort-design.md`](./superpowers/specs/2026-08-16-capture-as-last-resort-design.md).

### Item lanes vs. service lanes (Phase C2.3)

`impact` and `expert` answer about *this pull request* — a resolved item, keyed
by the gateway's item id. `catchup`, `decisions` and `ownership` answer about
*the whole connector* — everything indexed from one service, e.g. all of
GitHub. That is a coarser scope than any item page can honestly claim, so it
needed a page whose scope actually matches: the product's own dashboard,
recognised as `SurfaceKind: "home"` (GitHub root; GitLab root or `/dashboard`;
Bitbucket `/dashboard/*`; Jira Cloud `/jira/your-work` and Server
`/secure/Dashboard.jspa`; Jenkins instance root, past any configured path
prefix).

**A service lane makes no resolve call.** `Recognition.product` already IS the
gateway's connector id — the five `Product` values are exactly upstream's
per-connector `SERVICE_ID` constants — so `resolveForAgent` (`handlers.ts`)
branches on `recognition.kind === "home"` before ever calling `resolveItem`,
and returns a `service`-scoped result straight from the recogniser. There is no
item to resolve and no `found` outcome to require, which also means a service
lane works on a pairing that never received the `resolve` scope — it needs only
`agents`. `PRODUCT_SERVICE_ID` (`src/shared/types.ts`) is the map from
`Product` to that connector id. It is written out rather than cast so the
coupling between this client's `Product` union and the gateway's connector ids
— convention between two repositories, not contract — is greppable from both
sides. That buys **discoverability, not enforcement**: the map only checks that
every `Product` has an entry, so an upstream connector rename (e.g.
`"jenkins"` → `"jenkins-ci"`) would keep it typechecking green while every
Jenkins lane quietly answered about a service that no longer exists.

**The run store keys on scope, not just on an item.** `StoredRun`'s subject is
a `RunSubject` — `{kind:"item", id}` or `{kind:"service", service}` — and
`agent-run-store.ts`'s `makeKey` encodes the kind alongside the value, so an
item id and a service id can never collide even if they happened to share a
string. One consequence is deliberate: **two self-hosted instances of one
product share a single cached answer.** `jenkins.dev.local` and
`jenkins.prod.local` both recognise as `product: "jenkins"`, so
`catchup { service: "jenkins" }` is one scope and one cache entry — navigating
between them replays the stored answer instead of re-invoking. That mirrors
the gateway's own data model: connector-written item ids carry no host
component, so upstream itself has no per-instance segmentation to preserve
here.

**Cached runs are cleared on unpair, and on a confirmed re-pair.** A stored
brief belongs to the gateway that produced it; either event may point the
extension at a different gateway, so both call the run store's `clearRuns`
(`handlePair`/`handleUnpair` in `handlers.ts`) rather than let a brief from the
old gateway answer for the new one.

**The panel header for a dashboard is not a miss state.** It names the product
and states the scope ("across all indexed Jenkins builds") — deliberately not
the instance host, which would understate the answer's real, connector-wide
scope — and carries no item link, no freshness line, no fetch button and no
candidate chooser. The related lane is suppressed there too: `/v1/clips/related`
keyed on a dashboard's own title and URL would return noise dressed as recall.
The related *request* still fires in parallel with resolve, before recognition
is known, and its answer is simply discarded — a deliberate, documented
trade-off (see the design spec) rather than an oversight, because both fixes
considered cost more than the one wasted loopback call: short-circuiting
`handleRelated` would tax every item-page related request to save a call on the
dashboard path, and checking the URL from the panel would work for the
built-in SaaS hosts and silently not for self-hosted Jenkins/Jira/Bitbucket,
exactly where dashboards matter most.

**The ambient cue (C1.3) stays silent on a dashboard.** Its one contract is
"this page resolves to exactly one indexed item, and here it is"; a dashboard
resolves to none, so it gates closed by the same non-`found`-is-silence rule
every other miss already uses. Dashboards are panel-only — the user summons
the panel, same as C1.3 kept the panel itself user-summoned.

**`ownership` is a known-weak lane.** It derives ownership from git blame over
configured `[[filesystem.roots]]`; with none configured — the normal case for a
browser-first user — the gateway returns a gap-only brief rather than an
answer. The client cannot detect this in advance (there is no read that reports
whether roots are configured), so the lane cannot be hidden when it will not
answer. The gap brief already carries its own remedy (a `nimbus index add`
line), and the client must never pattern-match that free-text brief to add its
own action beside it — briefs are rendered with `textContent` and never parsed,
and a client that greps gateway prose breaks silently the first time upstream
rewords a sentence.

Full reasoning: `docs/superpowers/specs/2026-08-13-c2-3-service-lanes-design.md`.

## Research briefs

One question across several tabs you have open, answered by the gateway reading
them together. It is the first capability here whose input is a *set* of pages
rather than the page you are on, and that shapes almost every decision below.

**Its own page, not a panel lane.** The panel deliberately pins the one page it
was opened on, so its header and its lanes can never describe different items. A
brief spans many tabs, so a lane would fight that invariant rather than extend
it. The popup was ruled out on a harder mechanic: it is destroyed on blur, and a
run outlives it. So `brief.html` is a normal extension page, reached from a popup
button and an Options link — both click-driven, deliberately not a `commands`
entry (see C1.5 on why a hotkey-only capability can vanish silently).

**The staged protocol.** Five routes, in order: `POST /v1/briefs` (create) →
`POST /v1/briefs/{id}/sources` once per tab (feed) → `POST /v1/briefs/{id}/run` →
`GET /v1/briefs/{id}` (poll) → `POST /v1/briefs/{id}/save`. `src/background/brief-client.ts`
owns the wire; `src/background/brief-handlers.ts` owns the order.

**Every picked tab is declared at create, even the ones that then fail to
capture.** `BriefRun.declared` is fixed at create and never grows, and the
gateway reports the shortfall in the report's `gaps` ("2 of 3 sources"). Capturing
first and declaring only the survivors would produce a report with no gap entry —
hiding the shortfall by routing around the contract's own honesty mechanism. The
client adds *which* tabs and *why*, which the gateway cannot know.

**The extraction cap is 200 KB, and that number is load-bearing.**
`MAX_RUN_BYTES / MAX_SOURCE_BYTES` is exactly 16, so a client that truncated at
the gateway's 256 KB per-source ceiling would fit only sixteen sources into a run
whose declared limit is twenty — the seventeenth feed refused, every time.
Upstream sized the run budget against a 200 KB client cap and says so. Asserted
by a test against the real constants, not left as a comment.

**Two different `413`s.** `payload_too_large` arrives for both an over-cap source
and a full run, distinguished only by `detail`: `source_too_large` re-cuts and
retries that one source, `run_capacity` stops feeding and runs what was already
accepted. Collapsing them would turn a run that is complete enough to answer into
what looks like a client bug.

**Truncate and declare** — the opposite of the clip path. `POST /v1/clips` has no
way to say a body was cut, so a truncated clip would be a silent lie (the defect
Nimbus#1005 actually was). `BriefSource.truncated` is a contract field, so here
the honest move is to cut and say so, and the page names the shortened sources.

**The worker is the only poller.** Live cadence is a `setTimeout` backoff in the
service worker (to a 5s ceiling, slower than the lanes' 2s because synthesis runs
for tens of seconds); `BRIEF_POLL_ALARM` is the eviction net only, and is
disarmed **only when no run is left running** — two briefs can overlap, since the
gateway allows three concurrent runs, and clearing on the first would orphan the
second. The page never polls and never calls the gateway; it sends a message and
renders what comes back. Polls honour `pairingGeneration` for the same reason
agent polls do: a poll that outlives its pairing must write nothing.

**No text captured FOR a run is ever persisted.** `BriefSource.body` built from
an open tab is ephemeral by contract ("never written to disk"), and this client
must not hold what the gateway refuses to hold. `chrome.storage.local` gets the
run record (id, question, declared url/title, phase) and the disclosure log —
asserted by tests that grep the whole store. For the same reason briefs are
**never queued**: the offline queue persists payloads, and there is nothing
here it may persist. A passage (below) is the one deliberate exception: it is
captured *before* any run exists, by the user's own gesture, and must survive
a closed tab — so it is the one piece of source text this client holds **ahead
of any send**. The queue's own persisted `body` is text the user already
committed to sending; a passage is text held before that moment ever arrives.

### Passages: a source collected ahead of any run

A right-click **Add to brief** on a selection stores the text immediately,
under its own `passages` key in `chrome.storage.local` — separate from the run
record above, because a passage outlives any single run and is not cleared by
one. One pure module, [`src/shared/passage.ts`](../src/shared/passage.ts),
owns every rule (grouping by fragment-stripped URL, stitching with
`PASSAGE_SEPARATOR`, every cap); [`passage-store.ts`](../src/background/passage-store.ts)
only persists what that module returns, so it cannot drift from the rules.
It differs from the offline queue's storage in one deliberate place: a failed
write **refuses** rather than evicts — the queue drops its oldest entry under
pressure, but a passage exists in exactly one place and was put there by hand,
so a refusal the user can act on beats a silent loss. The collect gesture
itself reuses `captureTab` — the same call the clip path makes — rather than
the menu click's browser-truncated `selectionText`, so a passage can never be
a silently short excerpt. Full reasoning:
[`docs/superpowers/specs/2026-08-18-passages-as-brief-sources-design.md`](./superpowers/specs/2026-08-18-passages-as-brief-sources-design.md).

### Why there is a local disclosure log

The gateway's egress ledger does **not** cover a brief's model call.
`THIS_BINARY_COVERAGE.model` is `none` (`egress/egress-coverage.ts`) — the `model`
source type is declared but its appender has not landed — and
`agent-brief-egress.ts` covers `agents.*` briefs, which is a different route from
`/v1/briefs`. So `nimbus prove` shows nothing for a brief's synthesis, and without
a local record the only disclosure (`Report.synthesis`) dies with the run's
30-minute TTL.

C4.1's caution — read the gateway's record rather than keep a private one that
could quietly disagree — binds wherever a gateway record exists. For this class
none does, and a local record cannot disagree with one that was never written.

The log is written when `/run` is **accepted** — the moment of egress — not when
the report arrives, so a run that fails during synthesis still gets an entry: the
source text left either way. Eviction favours keeping **unsaved** runs, which is
the opposite of the intuitive rule: `brief-save.ts` persists `synthesis` as its
own metadata field on the saved item, so dropping a saved run's entry loses a
pointer, while dropping an unsaved one loses the only record anywhere. It renders
in Options stage 4 and is **not** cleared on unpair — a past egress does not
un-happen when the pairing changes.

### Also searching what Nimbus has indexed (C5.4)

`useIndex` is one boolean that travels a short, fully-typed path:
`brief-view.ts`'s checkbox → `index-pref.ts` (`isIndexSearchEnabled` /
`setIndexSearchEnabled`, read on load, written on toggle) → the `useIndex`
field on the `brief-start` message (`messages.ts`) → `buildCreateBody`'s third
parameter (`shared/brief.ts`), which puts it on the `POST /v1/briefs` body. No
step in between reinterprets it; the pref store is the only place it can turn
itself off, and it does that by never turning on in the first place —
`index-pref.ts` defaults **off** and falls back **off** on a read failure,
the opposite direction from `preview-pref.ts`, because the fail-safe direction
for a control that *widens* what a run consults is "don't."

**The disclosure names a bound, not a list.** With the flag on, the gateway
searches the index during the run, over a corpus this client cannot read in
advance — so `buildBriefPreview` cannot name the items the way it names every
tab and passage. Naming a guess the finished report would then contradict
would be worse than the alternative: `INDEX_NOTICE` (`shared/preview.ts`)
states that the gateway will also search what it has indexed, that it may draw on
up to 8 items that cannot be listed before the run, and that the question text
itself is what gets searched — including that the search may send that text
to whichever embedding provider the gateway is configured to use. The report
that comes back is where enumeration belongs: every item actually used is
cited, and an indexed citation is visibly marked as such (`renderCitations`)
rather than reading like a tab the user picked.

**The egress record completes when the report does.** `brief-log.ts`'s entry is
written when `/run` is accepted, before any report exists, so it carries
`usedIndex` and nothing about what came back. When the run settles,
`settleRun` patches it with the synthesis model and `countIndexHits(report)` —
the number of **distinct** indexed items cited, so a clip quoted in three
findings counts once and the recorded number can never exceed the bound the
pre-send notice named. Options renders the count beside the marker, and only
when it was recorded: a run whose report never arrived keeps the marker without
a count rather than implying zero.

**The user-facing noun tracks the shipped gateway, not a branch.** It shipped
narrow — *your saved clips* — while the gateway still scoped the brief search
to `itemType: "web_clip"`, because `publish.yml` uploads to two public store
listings off a `v*` tag with no manual gate, so a claim that is only true of an
unmerged branch would have reached users before the behaviour did. That filter
is gone (Nimbus#1253), so the nouns widened together: the composer checkbox and
its hint, the Options toggle and its hint, `INDEX_NOTICE`, and the egress-log
line. A citation's "from your index" never moved and never needed to — a clip
*is* in your index, so it was true on both sides of the change.

The rule outlives this instance: when a client string describes gateway
behaviour, it states what the shipped gateway does. `test/unit/preview.test.ts`
pins whichever side of that is currently true, so widening early — or failing
to widen after the gateway does — fails loudly rather than drifting.

The index widens what a brief may draw on; it does not replace what the user
chose — `POST /v1/briefs` 400s on an empty `sources` array regardless of
`useIndex`, so a brief cannot be built from the index alone, and the composer
still requires at least one picked tab or passage. Full reasoning:
[`docs/superpowers/specs/2026-08-19-briefs-over-your-index-design.md`](./superpowers/specs/2026-08-19-briefs-over-your-index-design.md).

### What the client cannot promise

It cannot say synthesis stays on your machine. `createBriefLlm` resolves
`[briefs].prefer_local` and falls back to remote when no local provider is
available; `GET /v1/health` reports only liveness; `/v1/admin/status` needs the
admin token this client does not hold. So the pre-run confirmation names every
source and states the uncertainty, the report's `synthesis.remote` is what
actually happened, and the model is named on its own line — because on a remote
run the banner is the gateway's `disclosure` string verbatim, and that string is
not guaranteed to name the model.

A gateway-side proposal to close this is written up **in the Nimbus repo**, not
this one — `2026-08-17-brief-synthesis-destination-design` on the
`dev/asafgolombek/briefs-prerun-disclosure` branch: a synthesis policy echoed at
create, a request-side `requireLocal` that may only tighten it, and the `model`
egress class raised behind a router chokepoint.

Full reasoning: `docs/superpowers/specs/2026-08-17-research-briefs-design.md`.

## Two state machines worth understanding

These are the parts that are easy to get subtly wrong, and where most of the
hard-won behavior lives.

### The offline retry queue

Persisted in `chrome.storage.local` via
[`clip-queue-store.ts`](../src/background/clip-queue-store.ts); drained by
[`queue-flush.ts`](../src/background/queue-flush.ts). Rules:

- **An entry leaves the queue only on success.** A failure *marks* the attempt
  (increments `attempts`, records `lastReason`) and **keeps** the entry.
- **Every mutation is a delta** applied through the serialized `updateQueue`, so a
  concurrent popup "remove" is never clobbered by the flush's own write.
- **The token is never stored in the queue** — it is re-read from the connection
  at flush time. A queued clip carries no secret.
- **Automatic flush skips what can't self-fix.** Entries whose `lastReason` is
  `invalid_request` (400) or `payload_too_large` (413) are terminal; only an
  explicit user **manual** retry attempts them again.
- **A round stops early** on `unreachable`, `unauthorized`, or `rate_limited` —
  the gateway is down, the token is dead, or the window is closed, so continuing
  just burns attempts.

Flush is triggered three ways: the periodic `chrome.alarms` tick, the cold-start
drain, and a popup retry. The two background triggers are coalesced through a
**single-flight** guard so a fresh wake can't POST the same clips twice; the popup
retry stays direct because it is user-initiated and may carry a specific `url` or
the `manual` flag. **The alarm exists only while the queue is non-empty** — there
are no idle wakeups.

### The rate-limit pause

When the gateway answers `POST /v1/clips` with `429` + `Retry-After`, we stop
flushing until that window elapses. Managed by
[`rate-limit-pause.ts`](../src/background/rate-limit-pause.ts):

- **The deadline is persisted, not held in memory.** An MV3 service worker is
  evicted after ~30s idle and every wake runs the startup drain — an in-memory
  pause would evaporate exactly when it matters.
- **It is clamped** to the gateway's own maximum `Retry-After` (120s), so a
  backwards system-clock correction can't strand a deadline far in the future and
  stall the drain forever.
- **A successful clip clears it early** — a 2xx proves a slot is free, so there's
  no reason to wait out the remainder.
- **The pause gate in `flushQueue` is the authority; the alarm is only a hint.**
  While paused, the flush alarm is re-armed to fire near the gateway's reset time
  instead of at an arbitrary point in the fixed one-minute cadence. Because that
  re-armed delay only ever *shrinks*, concurrent callers racing on stale state can
  at worst fire the alarm early — and the gate simply no-ops it.

```
        429 + Retry-After                 Retry-After elapses (alarm fires)
 RUNNING ─────────────────►  PAUSED  ──────────────────────────────►  RUNNING
   ▲                          │  (flushQueue gate returns early;         ▲
   │                          │   alarm re-armed to reset time)          │
   └──────────────────────────┘                                         │
        successful clip clears the pause early ──────────────────────────┘
```

## Why the pure core is testable

The handlers, the gateway client's status mapping, the queue-flush logic, and the
capture fallback are all **pure functions with their dependencies injected** —
`getConnection`, `postClip`, `updateQueue`, `nowMs`, and so on are passed in, not
imported. `service-worker.ts` is the *one* place that wires the real
`chrome.*`-backed implementations together; it is deliberately thin glue. That
split is why `test/unit/` (Vitest, node env; DOM tests opt into jsdom via a
docblock) can exercise the real decision logic without a browser — the seam is the
test seam.

The surfaces that *can't* be unit-tested this way — the injected capture/panel/
toast scripts, the popup/options DOM, and the service-worker glue itself — are
covered by the manual checklist in [`development.md`](./development.md).

## An MV3 subtlety: synchronous listener registration

A service worker must register its event listeners **synchronously during module
evaluation** — that is what MV3 actually requires. But the startup *work* (badge
paint, context-menu registration, and a queue drain that ends in a network round
trip) must not gate worker startup, or a hung gateway would stall event dispatch.
So `service-worker.ts` registers every listener synchronously and then detaches
the startup sequence as a deliberate fire-and-forget (`void runStartupSequence()`,
marked `// NOSONAR` on that exact line). This is intentional, not a forgotten
`await`.

## The SDK seam: where this goes next

The gateway client, pairing orchestration, token store, and 429/413/offline
handling in `src/background/` are hand-rolled here — and duplicated in
`nimbus-vscode`. The proposed **Nimbus SDK** (roadmapped in the SDK repo, not
here) extracts that into one spec-driven package that every surface consumes via
small per-runtime adapters.

This repo is a **Phase 1 consumer and proof surface**. The architecture above is
already shaped for that migration: `gateway-client.ts`, `handlers.ts`, and
`connection-store.ts` are exactly the units the SDK generalizes, and the
dependency-injection seam means they can be swapped for SDK calls **without
touching** the message routing, the capture pipeline, or the state machines. Until
the SDK lands, this local implementation is the reference it generalizes from — so
changes here are potential upstream contributions.

## Invariants, in one place

| # | Invariant | Enforced by |
| --- | --- | --- |
| **I6** | Loopback only — one destination, no `<all_urls>`, no remote host | Client-side, mirrors gateway I6: `src/shared/gateway.ts` origin validation + restricted `host_permissions` |
| — | Page access is opt-in (configured per origin, granted per host) and never widens the network destination | `optional_host_permissions` (inert at install) + `src/browser/permissions.ts`; `shared/origins.ts` is deliberately a separate validator from `shared/gateway.ts` |
| **I30** | Pairing is fail-closed — token minted only in an owner-opened window | Gateway; extension redeems, never assumes |
| **I13** | A targeted fetch is a WRITE (outbound provider request), gated by an explicit click and its own `fetch` scope — never fired on panel open | `src/panel/panel-in-page.ts`'s `sendFetch` (button click only) + the gateway's `fetch` token scope; see [the targeted-fetch path](#the-targeted-fetch-path) |
| — | The bearer token / pairing code is never logged, never in a page DOM | `noConsole` in `src/` (Biome); token held only in the SW + storage |
| — | No `console.*` in `src/`; strict TypeScript, no `any` | `biome.json` (`noConsole`, `noExplicitAny`) + `tsc --noEmit` |
| — | The wire contract is not redesigned here | Owned by the Nimbus gateway repo; this repo builds against it |
