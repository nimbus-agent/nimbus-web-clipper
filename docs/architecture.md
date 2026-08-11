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

## The agent lanes (Phase C2.1)

On a resolved page (the `resolved` header state, and only that one) the panel
offers two collapsed lanes below Related — *what breaks if it lands* (`agents.impact`) and
*who should review it* (`agents.expert`) — each answered by an agent that
already exists behind the gateway. Two routes:

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
