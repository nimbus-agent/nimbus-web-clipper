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
`options`, `capture`, and the injected panel/toast) into `dist/<target>/` as a
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
                    │                    postResolve(resolveUrl)
                    │                    POST /v1/clips/resolve
                    │                              │
                    │              ┌───────────────┼──────────────┐
                    │           200 item        200 null        404
                    │              │               │              │
                    ▼              ▼               ▼              ▼
              "unrecognised"   "resolved"    "not indexed"   "can't resolve
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
  before the product's path pattern is applied — then preserved in `resolveUrl`,
  which must stay byte-identical to the `canonical_url` the connector indexed.
  Path matching is case-sensitive for the same reason.
- **`POST /v1/clips/resolve` is proposed, not contracted.** It does not exist on
  the shipped gateway, which is why it lives in `PROPOSED_PATHS` rather than the
  locked `CLIP_PATHS`. A **404 means the route is absent** and surfaces as an
  honest "this gateway can't resolve pages yet"; a **200 with `item: null` is a
  real miss**. Keeping those distinct is what lets the client ship today and flip
  to live with no code change. Resolution is at most one item — the panel never
  passes ranked related hits off as "the page".

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
| — | The bearer token / pairing code is never logged, never in a page DOM | `noConsole` in `src/` (Biome); token held only in the SW + storage |
| — | No `console.*` in `src/`; strict TypeScript, no `any` | `biome.json` (`noConsole`, `noExplicitAny`) + `tsc --noEmit` |
| — | The wire contract is not redesigned here | Owned by the Nimbus gateway repo; this repo builds against it |
