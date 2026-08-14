# Setup, trust, and the lane inputs — the rest of the client-only backlog

**Status:** design, approved 2026-08-14. Implements roadmap **3.5**, **1.4**,
**1.2**, **C1.5**, **1.3**, **C4.2**, **C2.5**, the glossary lane deferred out of
**C2.3**, **4.2**, and **1.1**.

**Upstream read at:** `Nimbus` @ `a68945e5` (past `v1.27.0`). Every contract claim
below was read from that source, not from this repo's roadmap — which is stale or
incomplete in three places, corrected in the last section.

## What this builds

Every remaining 🟢 client-only item on the roadmap, in five slices. Nothing here
needs a new gateway surface; three of the five needed an upstream fact checked
before they could be called buildable at all, and all three checked out.

| Slice | Roadmap items | Theme |
| --- | --- | --- |
| 1 | 3.5 · 1.4 · 1.2 | Setup that works |
| 2 | C1.5 | A panel you can always reach |
| 3 | 1.3 · C4.2 | Show what leaves |
| 4 | C2.5 · glossary · 4.2 | The lane path takes an input |
| 5 | 1.1 | Never clip twice |

Slices 1 and 2 are ordered: they share the Options layout and the context-menu
registration module, and splitting them means deciding the same layout twice.
Slices 3, 4 and 5 are independent of each other and of 1–2.

## Why now, and why together

Two reasons, and the second is the load-bearing one.

**The capability is built; the funnel isn't.** C1 through C3 shipped recognition,
resolve, an ambient cue, five agent lanes and targeted fetch. Reaching any of it
takes: install → find Options → type a gateway URL → run `nimbus clip pair` →
enter a code → add self-hosted origins → grant page access per host → toggle
*Surface automatically* per host. Eight steps before the first payoff, against
`average_daily_users: 0`. Every feature shipped since C1 sits behind that funnel,
and no C-phase item addresses it.

**Four of these items render into the same Options surface.** 3.5's discovery,
1.4's health, 1.2's trust panel and C1.5's shortcut visibility all land in
`options.html`. Shipping them as four independent slices means four rounds of
conflicting layout decisions on one file, each justified in isolation. Designing
the surface once and sequencing the delivery is the only way that file survives.

This is why the work is one spec and five pull requests, rather than one of
either.

> **A note on headings.** Subsections below are titled, not numbered. Almost every
> roadmap id this spec implements is of the form `1.1`–`4.2`, so a numbered
> subsection would collide with an item id on the same page — `1.1` would mean
> both "never clip twice" and whatever the first subsection of slice 1 happened to
> be. Cross-references name the slice and the topic instead.

## Slice 1 — Setup that works

### Options becomes a staged flow, not a wall of knobs

Today `options.html` is three flat sections — *Pair this browser*, *Connection*,
*Recognised surfaces* — all visible at once on a fresh install. It becomes four
ordered stages:

```
1  Connect            gateway discovery + the 6-digit code
2  Connection         health: origin, reachable, last clip, queue depth, shortcuts
3  Your sites         the existing Recognised surfaces list
4  Where data goes    the trust panel + the preview switch
```

Stages 2 and 3 stay collapsed and inert until stage 1 completes. Stage 4 is always
open — a user must be able to read what the extension can reach **before** pairing
anything, or the trust panel is answering a question they have already had to
commit to.

The stage-state decision is pure: a new `src/options/setup-view.ts` exports
`stagesFrom(status)` returning each stage's state from the connection status
alone. `options.ts` renders it. No stage logic in the DOM glue — the repo's
standing rule, and this is the first Options code with enough branching for it to
matter.

**Locking is for never-configured, never for broken.** The state is
`"active" | "done" | "needs-attention" | "locked"`, and a stage that has completed
once never returns to `locked`. A stale token or an unreachable gateway moves
stage 1 to `needs-attention` and leaves 2 and 3 open.

This is not a nicety. **Unpair lives in stage 2** (`options.html:25`), so a rule
that re-locks on a bad connection would hide the only control that fixes a bad
connection — the user would be locked out of recovery by the very condition
recovery exists for. Same for stage 3: revoking page access for a host must stay
possible when the gateway is down, because a user who wants to withdraw access is
most likely to want it when something is wrong.

### Discovery probes, and does not scan

`GET /v1/health` is served unauthenticated on the same server as the clip routes
(`packages/gateway/src/ipc/http-server.ts:428`, `dispatchReadOnlyDataGet`),
returning `{ status: "ok", gateway: "read_only_http" }`. That is what discovery
probes. The conventional port is 7474.

A new pure `src/shared/discovery.ts` owns the ordered candidate list —
`http://127.0.0.1:7474` then `http://localhost:7474` — and the pure "which probe
won" decision. `gateway-client.ts` grows `probeHealth(origin)`: a `GET` with a
short (~800 ms) timeout, mapping to `{ reachable: boolean }`.

**The order is load-bearing, and the probes stay sequential.** `127.0.0.1` is
first because the gateway binds `127.0.0.1` and nothing else (**I6**), so it is
the literal address of the thing we are looking for. `localhost` is second and
will rarely fire: on Windows in particular it may resolve to `::1` first under
dual-stack resolution, and a gateway bound to IPv4 loopback refuses that — which
is exactly why it must not be probed first, and why it is kept at all only for a
gateway reached by name.

Probing the two concurrently was considered and rejected. It would always open a
connection to the candidate we expect to fail, and when both succeed it needs a
tiebreak rule that buys nothing — the two are the same gateway. A refused
connection returns fast rather than consuming the timeout, so the sequential
worst case is one short refusal plus one 800 ms budget, not two full budgets.

**Two rules, both non-negotiable:**

**No port scanning.** Not a range, not a sweep. Probing dozens of loopback ports
is slow, it is the single behaviour in this extension that would look like
malware to anyone watching, and it buys a case the manual field already covers. A
miss falls back to the existing text input, which does not go away.

**The probe still passes `isLoopbackOrigin`.** This is the client's **first
tokenless gateway call** — every other call carries a bearer token, and the token
path has its own origin discipline. A tokenless call must not become the one
place the loopback invariant (**I6**) is checked more loosely. The candidate list
is a constant in this repo, so today the check cannot fail; it is asserted anyway,
because the next person to make the list configurable will not read this
paragraph.

### Connection health is four facts and one honest failure

`handleConnectionStatus` grows to return:

```ts
{ paired, origin, label, pairedAt, lastClipAt, queueDepth, reachable, stale }
```

`queueDepth` comes from the existing queue store. `reachable` comes from the same
`probeHealth` discovery uses — one probe, two consumers.

`lastClipAt` is a new timestamp, written on clip success. It lives in
`connection-store.ts` rather than a new module: it is the same `chrome.storage`
concern, keyed to the same connection, and cleared by the same unpair. A separate
store would have to be cleared in a second place, which is how a stale timestamp
outlives the gateway that produced it — exactly the defect the last release fixed
for cached agent briefs.

`stale` is set when any authed call returns 401. This is what 1.4's done-when
actually asks for — *"a dead token surfaces as 'needs re-pairing', not a silent
failure"*. Without it, a revoked token is indistinguishable from a gateway that is
merely down, and the user is told to check whether the gateway is running when the
real fix is to re-pair.

### The trust panel states the caveats it just acquired

Stage 4 is static copy driven by the **real** configured origin and the **real**
granted-host list — never hardcoded strings that could drift from what the
extension is actually doing. It states: one network destination, the loopback
check in `shared/gateway.ts`, no telemetry, MIT, no runtime dependencies, and page
access as a separate axis granted per host.

It must also state the two caveats this spec's own decisions create:

- **The popup lookup sends a URL.** From slice 5, opening the popup sends the
  current page's URL to the gateway. That is a new class of outbound data and it
  gets named here, not discovered.
- **The preview covers the popup path only.** From slice 3, clips made from the
  popup are previewed before sending; clips made by hotkey or context menu are
  shown afterwards in the toast. So the panel says *"the popup shows you before,
  the hotkey shows you after"* — never a blanket *"nothing leaves without you
  seeing it"*, which would be false for the fastest path in the extension.

A trust panel that overclaims is worse than no trust panel. It converts a
verifiable pitch into a discoverable lie, and this one is being written for a
product whose store listing already carries an unresolved privacy claim
(**Nimbus#1006**).

## Slice 2 — A panel you can always reach

### One handler, several triggers

`Alt+Shift+R` did not bind in Chrome during the Phase C1 manual pass;
`suggested_key` is a suggestion, and when something else holds the combo the
browser leaves the command unbound, reports nothing, and passes the keystroke to
the page. The popup's *Show related* button means this was survivable rather than
fatal, but a keyboard-first user lands in a state where the feature looks broken.

A *Show related* context-menu entry is added, routed into **the same `injectPanel`
path** the command and the popup button already use. Not a parallel path — the
panel must not be able to drift between its triggers.

Each trigger is a user gesture, so `activeTab` still covers it. No new permission.

### Menu registration lifts out of `quick-clip.ts`

Context-menu entries are registered in `quick-clip.ts` today, which was correct
when every entry was a clip verb. This slice adds a panel entry and slice 4 adds
two selection entries, none of which are quick-clip's business.

Registration moves to a new `src/background/menus.ts` owning every entry and its
routing. `quick-clip.ts` keeps the clip behaviour and stops owning the menu.

### Options reports whether the shortcut is actually bound

A new `src/browser/commands.ts` seam over `chrome.commands.getAll()` — the thin
typed layer every `chrome.*` call goes through in this repo. Stage 2 lists each
command and its binding, naming any that is unbound.

**The cross-browser wrinkle is stated, not papered over.** Chrome will not let an
extension page navigate to `chrome://extensions/shortcuts`; Firefox's equivalent
lives elsewhere again. So the fix is per-target instructions plus a copyable path
— not a link that silently does nothing, which would be a second invisible
failure stacked on the one this slice exists to fix.

## Slice 3 — Show what leaves

### One pure builder, two shapes

A new pure `src/shared/preview.ts`:

```ts
buildPreview(payload: ClipPayload): ClipPreview       // title, url, canonicalUrl,
                                                      // mode, tags, excerpt, length
buildFetchPreview(target: FetchTarget): FetchPreview
```

`FetchTarget` is a new type in `shared/types.ts` naming what a fetch is about — service, type, and identifier — assembled from the `Recognition` and the resolve outcome the panel already holds.

`src/popup/preview-view.ts` renders the clip shape; the panel renders the fetch
shape. The roadmap says C4.2 *"folds directly into 1.3's preview component"* — it
does, as a second variant of one module, not a second module.

**The token is never in a preview**, asserted by a test that fails if any field of
the built preview contains it. This is the invariant most likely to be broken by a
future "just show the whole request" convenience.

### Preview is on by default in the popup, and only there

The popup gains a confirm/cancel step between capture and send. Capture already
happens in the popup before the message is sent (`popup.ts:37`), so the payload to
preview is in hand with no new round-trip.

Default on, with an off switch in Options stage 4 — next to the trust copy rather than under Connection, because "show me what gets sent before it goes" is a trust control and belongs where the trust claims are made. Per 1.3's stated bar
(*"inspect the payload and confirm/cancel"*).

Quick-clip is **unchanged**. Its whole value is that it is one gesture; adding a
confirm step turns the fastest path into the slowest and there would be no reason
left to use it. The asymmetry is real, and the answer is to say so in the trust
panel (the trust panel, slice 1) rather than to pretend it away in either direction.

### The fetch preview is a real preview, not a confirmation dialog

`POST /v1/items/fetch` causes the gateway to make an outbound request to a
configured provider under the user's stored credential — an explicit **I13**
write. The preview names what is about to be fetched: the service, the type, and
the identifier or URL. Not *"Fetch this item?"*, which asks the user to confirm
something they have not been told.

## Slice 4 — The lane path takes an input

Every lane today is derived entirely from the page: `impact` and `expert` from the
resolved item, `catchup` / `decisions` / `ownership` from the recognised product.
This slice is the first time a lane takes an input the page did not supply.

### `agent-run` grows two optional fields, both guarded

```ts
interface AgentRunRequest {
  readonly kind: "agent-run";
  readonly lane: AgentLane;
  readonly pageUrl: string;
  readonly itemId?: string;   // C2.5: the candidate the user picked
  readonly term?: string;     // glossary: the selected term
}
```

Same for `AgentStateRequest`. Both values arrive from a content script, so both
are untrusted cross-boundary input and both are narrowed by a guard in
`messages.ts` — the repo's standing rule, and the reason this is a contract change
rather than a render tweak.

**`term` is normalised and bounded in that guard, and an over-long one is
refused, not truncated.** A selection is whatever the user happened to drag, so
it can be a paragraph. The guard collapses runs of whitespace, strips control
characters, trims, and rejects anything longer than **128 characters** — the
lane then renders *"That's a passage, not a term — select a word or phrase."*

Truncating instead was considered and rejected: silently cutting a 3,000-character
selection down to its first 128 characters produces a query the user never asked
and an answer about a term they never selected, which looks like the feature
working. Refusing says what happened.

The bound is not about the wire. The term travels in the JSON body of
`POST /v1/agents/{agent}`, so no header limit is in play. It matters because
**the term becomes part of the cache key** — `makeKey` composes the subject value
into the `chrome.storage.local` key (`agent-run-store.ts:66`), so an unbounded
term writes an unbounded key into extension storage, and because a paragraph is
not a glossary lookup any agent run could usefully answer.

### A picked candidate is honoured, but verified first

C2.5's problem: `handleAgentRun` re-resolves the page for itself, and on an
ambiguous page the second resolve is ambiguous again, which `resolveForAgent`
refuses with `not_resolved`. Rendering lanes on a `chosen` header today would put
*"Nimbus couldn't pin this page to one indexed item"* directly beneath a header
naming the item the user just picked, with Re-run withheld — two dead controls.

`resolveForAgent` honours a supplied `itemId` **only after confirming it appears
in the ambiguous candidate set that the resolve produced**. An id the resolve did
not offer is refused, exactly as an unverified id from a page script should be.

A `chosen` candidate carries **no `modifiedAt`** — that is why it is a distinct
header state. Nothing in the lane path may read a freshness it does not have; the
freshness line is omitted on a chosen item rather than defaulted.

### Glossary is a new kind of lane, and `LANE_SURFACES` has to say so

`agents.glossary` is on the HTTP surface (it is not in
`HTTP_EXCLUDED_AGENT_METHODS`), takes `{ term?, limit? }`
(`packages/gateway/src/agents/_lib/glossary-types.ts`), and returns a brief with
three modes: `list` (no argument), `term` (resolved), and `miss` (unknown term,
with `suggestions`). That third mode is a real upstream state, so *"that term
isn't in your glossary — did you mean…"* is rendered from data, not invented.

`LANE_SURFACES` currently answers one question: which `SurfaceKind`s does this
lane belong on. Glossary needs a second: **does this lane require a term**. It
belongs on any recognised surface *where a term exists*, which no existing entry
can express. The table grows a required-input declaration alongside the surface
list, so a lane that needs an input and does not declare one stays a type error —
preserving the property C2.3 established.

### The run cache takes a third subject, not a rework

`RunSubject` in `agent-run-store.ts` is already a discriminated union — `item` and
`service` — keyed through `makeKey` with a NUL separator chosen so no arm can
collide with another. A term-scoped run is a third arm:

```ts
| { readonly kind: "term"; readonly term: string }
```

No key-scheme change, no migration. Without it, a second term would silently
replay the first term's answer, which is the failure mode the union was built to
prevent.

**Term runs get a sub-budget of 6 within the existing 16.** `MAX_STORED_RUNS` is
16, deliberately mirroring the gateway's own `MAX_RETAINED_TERMINAL_AGENT_RUNS`;
that total is unchanged, because holding more would cache briefs the gateway has
already evicted. What changes is that `putRun` evicts the oldest **term** entry
first once term entries exceed 6, before touching the global cap.

The reason is an asymmetry in cardinality, not a worry about bursts. Item and
service subjects are bounded by what the user visits — a handful of PRs, five
connectors. A term is bounded only by what can be selected, which is every
substring of every page. Terms are the one subject that can grow without limit,
so they are the one subject that needs a limit of its own. Without it, the
unbounded subject evicts the bounded ones, which is backwards: a PR brief is
expensive to regenerate and tied to work in progress, while a term lookup is
cheap and usually asked once.

### Selection reaches the lane path by menu, with a snapshot fallback

Two context-menu entries — *Define in Nimbus* and *What's related to this?* — take
the selection from `info.selectionText`, which is exactly how `clip-selection`
already works. Registered in slice 2's `menus.ts`.

The menu is the reliable path because it has no selection-loss problem: clicking
into the panel collapses the page selection, so a panel that reads
`window.getSelection()` at click time reads nothing. The panel additionally
snapshots any live selection **when it opens**, so an already-open panel is not
dead to a fresh selection — but that is the convenience path, not the contract.

4.2 (related-on-selection) rides the same delivery: `RelatedRequest.selection`
already exists (`messages.ts:62`) and is already honoured, so the related lane
re-runs with the selection and nothing new is needed on the gateway side.

### The lane-input logic does not go inside `panel-in-page.ts`

`panel-in-page.ts` is 1256 lines. A new pure `src/panel/lane-input.ts` owns "what
input does this lane need, and where did it come from" — the resolution of
`(lane, page, picked id, selected term)` into the request a lane sends.

This is not opportunistic refactoring: it is the module this slice's logic belongs
in, and putting it anywhere else means putting it in the largest file in the
repo.

## Slice 5 — Never clip twice

### It needs its own path, because `handleResolve` refuses the pages it targets

The roadmap's reframe says 1.1 should be built on the resolve read rather than on
`/v1/clips/related`. Correct — and incomplete. `handleResolve`
(`src/background/handlers.ts:190`) short-circuits on an unrecognised page and
**never calls the gateway**. Today a page URL leaves the browser only when it is a
recognised work surface.

An arbitrary article — the page 1.1 exists for — is unrecognised. So this is a new
`handleLookup`, resolving *any* URL, not a reuse of the existing handler.

### Clips are resolvable, verified upstream

`ingestClip` writes clips through `upsertIndexedItem` with a canonicalised URL
(`packages/gateway/src/clips/clip-ingest.ts:128–141`), and `upsertIndexedItem`
derives `resolve_key` from `canonicalUrl ?? url`. A clip is therefore resolvable
by `GET /v1/items/resolve` exactly like a connector item. No new contract, no new
scope beyond `resolve`.

### The answer is two different true statements, not one

Resolve returns the item's `service`, which lets the popup distinguish two cases
the brief collapsed into one:

- `nimbus` / `web_clip` → **"You clipped this on 3 Aug."** You have been here.
- any other service → **"GitHub already has this — clipping would add a second
  copy."** You have never clipped it; the connector indexed it, and clipping is
  the wrong move for a reason the user would not otherwise know.

The second is more useful than the feature as briefed, and it falls directly out
of the reframe: the client's job is to know what the index already holds, whatever
put it there.

### The lookup runs on popup open, and degrades silently

The lookup fires when the popup opens. The justification is a principle worth
writing down: **opening the popup is a clip gesture, and the clip it precedes
would send the URL *and the entire page body*. Sending the URL alone, first, to
tell you not to bother is strictly less exposure than the action it prevents.**

The cost is real and is not hidden: opening the popup to check the queue also
sends a URL. That is the caveat named in the trust panel (the trust panel, slice 1).

A pairing made before the gateway grew token scopes has no `resolve` scope. The
lookup then **degrades silently** — no state, no error. The user did not ask for
this lookup, and a scope-gap error in the popup would be a warning about a feature
they never invoked, on a surface whose job is to clip. The existing named re-grant
path (`nimbus clip scopes`) stays where it already is, in the panel.

**And the request is not made at all, because the client already knows its
scopes — it has just been throwing them away.** `POST /v1/clips/pair/confirm`
responds with `{ token, label, scopes }`
(`packages/gateway/src/ipc/http-write-routes.ts:1109`, asserted in
`http-write-routes.test.ts:869`), and `confirmPair` reads only `token` and
`label` (`gateway-client.ts:144`). The third field is dropped on the floor.

So this slice persists `scopes` on the connection record alongside `label` and
`pairedAt`, and the popup lookup checks for `resolve` locally before it opens a
socket. A pairing without the scope makes **no request per popup open**, rather
than one failed request per popup open.

Two consequences worth stating:

- **The token is still never parsed.** Scopes come from the pairing *response
  body*, not from decoding the credential. The token stays an opaque secret, as
  every rule in this repo requires; nothing here inspects it.
- **A re-grant without a re-pair must not strand the feature.** The owner can run
  `nimbus clip scopes` to widen an existing pairing, which the client would not
  otherwise hear about. The stored scope list is therefore refreshed from any
  `ScopeGap` the client receives — it already carries `granted`
  (`types.ts:222–226`) — so the record self-heals from the next authed call
  instead of pinning a stale "no" forever.

**Scope note:** the stored scopes are used *only* to gate this lookup. Every
other scope-gap path in the client keeps its current
ask-and-handle-the-answer behaviour. Pre-checking those too is a real
improvement and explicitly out of this spec's scope — it would touch the panel,
the fetch path and the lanes, none of which this work otherwise opens.

**Migration:** connections paired before this ships have no stored scope list.
That is `undefined`, not `[]`, and it means *unknown* — the lookup proceeds and
learns from the response, exactly as it would have without this change. Treating
unknown as "no scopes" would silently disable the feature for every existing
user.

## Testing

Unchanged from the repo's standing rules; the point is that this design keeps the
logic where those rules can reach it.

- **Pure modules with Vitest**: `discovery.ts`, `setup-view.ts`, `preview.ts`,
  `lane-input.ts`, the `LANE_SURFACES` required-input table, the `RunSubject`
  third arm, and the new guards in `messages.ts`.
- **DOM views via the jsdom docblock**: `preview-view.ts`, the staged Options
  render, the popup's lookup states.
- **Invariant tests**: the preview never contains the token; `probeHealth` refuses
  a non-loopback origin.
- **Manual dev-load pass** per `docs/development.md` for each slice's
  un-unit-testable surfaces. **C2.3's outstanding manual pass — which has never
  been run — is folded into slice 1's**, rather than being left dangling behind a
  shipped feature.

## What this does not build

- **C2.4** (a browser-viable "why") — blocked on a gateway-side decision.
- **C3.2** (capture as last resort) — gated on **Nimbus#1005** and **Nimbus#1006**.
- **C4.1** (what the gateway did for me) — needs a read surface over the egress
  ledger, proposed upstream.
- **Abort for agent runs** — still no upstream cancellation to hook into.
- **`agents.huddle` / `agents.janitor`** — no surface has yet earned them.

## Corrections to the roadmap

Recorded rather than silently edited, as the last three slices did.

**1. 1.1's reframe note is right but incomplete.** It says to build on the resolve
read instead of `/v1/clips/related`. It does not note that `handleResolve` refuses
unrecognised pages and never calls the gateway, so 1.1 cannot reuse that handler —
it needs its own lookup path, and that path sends a class of URL the client has
never sent. That is a design decision with a privacy dimension, not plumbing.

**2. C2.3's "glossary needs selection plumbing" undersold it.** Plumbing is the
smaller half. Glossary is the first lane whose input is not derived from the page,
so `LANE_SURFACES` needs a second predicate and `RunSubject` needs a third arm.
The store's union turned out to already anticipate this — which is why 4.4 is an
added arm and not a rework — but the lane table did not.

**3. The "thirteen agents" figure is stale, again.** The 2026-08-13 correction
already flagged this at `ea37e0d0`. It remains stale at `a68945e5` and this spec
does not fix it globally either; `HTTP_EXCLUDED_AGENT_METHODS` still has four
members (`preflight`, `premortem`, `whyPeek`, `negotiate`), and `glossary` is not
among them.

**4. `CLAUDE.md`'s pairing contract is stale.** It records
`POST /v1/clips/pair/confirm` as returning `{ token, label }`. Upstream returns
`{ token, label, scopes }`, and has for as long as token scopes have existed. The
line is corrected by the slice that starts using the third field (slice 5), not
here — the same convention every other roadmap correction in this repo follows.

**Verified and unchanged:** 4.2's claim that `RelatedRequest` already supports a
selection payload is true (`messages.ts:62`). C1.5's own 2026-08-11 correction —
that the panel had a popup button all along and was never unreachable — is
accurate; this spec builds the remaining half it names.

## Review dispositions

Findings from
[2026-08-14-setup-trust-and-lane-inputs-design-review.md](./2026-08-14-setup-trust-and-lane-inputs-design-review.md),
each verified against the code before it was accepted or argued with. All five
are addressed above; three are accepted as written, two are accepted with the
proposed mechanism replaced.

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | Stale/revoked state locks the user out of stages 2–3 | **Fixed as proposed.** Confirmed real. |
| 2 | Glossary term needs a length bound and sanitation | **Fixed; mechanism corrected.** Reject, don't truncate. |
| 3 | `localhost` dual-stack could make the probe fail | **Already handled; rationale now written down.** Concurrency rejected. |
| 4 | Term runs can evict item/service briefs | **Fixed as proposed.** Sub-budget of 6. |
| 5 | Don't re-request when the token lacks the scope | **Fixed; better mechanism available.** Scopes are already returned at pairing. |

**On 2** — the review's stated risk was HTTP header size. That does not apply: the
term travels in the JSON body of `POST /v1/agents/{agent}`. The real exposure is
the cache key, since `makeKey` composes the subject value into a
`chrome.storage.local` key. The bound is kept, for a different and verifiable
reason, and the review's *truncate* is replaced by *reject* so a mangled query
cannot masquerade as a working one.

**On 3** — the candidate list was already ordered `127.0.0.1` first, which is what
the finding asks for; the spec stated the order without justifying it, which is
why the concern was reasonable to raise. Concurrent probing is declined: it always
dials a candidate expected to fail and needs a tiebreak that buys nothing.

**On 5** — the review offered two mechanisms: cache the failure, or decode the
token. Decoding is out — the token is an opaque secret this repo never parses.
Caching a failure is unnecessary, because the gateway hands the client its scope
list at pairing and the client currently discards it. Persisting what we are
already given beats remembering what failed: it is correct on the first popup open
rather than the second, and it has no stale-negative to invalidate.
