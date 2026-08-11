# Panel page context — one panel, one page

**Date:** 2026-08-11
**Status:** Design, approved. Implementation plan to follow.
**Roadmap items:** closes the SPA-navigation gap recorded in C1.3's status; lands
the "the rule that put it there is written down" half of C2.3 without adding a
lane.

## What this builds

An open panel describes exactly one page — the one its header names — and offers
only the lanes that page's surface can actually answer.

Two defects in the shipped panel, one slice. Neither needs a gateway change, a
contract change, or a new agent.

## Defect 1 — the header and the lanes can disagree

`panel-in-page.ts` paints the header **once**, from the URL at mount
(`loadHeader`), but every lane message reads `window.location.href` at **send**
time:

- `panel-in-page.ts:513` — `agent-state`
- `panel-in-page.ts:575` — `agent-run`
- `panel-in-page.ts:729` — `resolve`
- `panel-in-page.ts:774` — `fetch`

GitHub, GitLab and Jira are all SPAs, so a client-side navigation leaves the
panel mounted with no repaint. Open the panel on `acme/web #482`, navigate to
`#517`, expand *What breaks if it lands*: the header says #482, and
`handleAgentRun` resolves #517 and answers about it. The panel is not merely
stale — it attributes one item's answer to another item's name. Same shape for
the targeted fetch: the button says *"Fetch this from GitHub"* under a header
naming #482 and fetches #517.

C1.3's roadmap status records the stale header. The divergence is the worse half
and was not recorded.

## Defect 2 — lanes fire where they cannot answer

`panel-in-page.ts:669`:

```ts
const showAgentLanes = shown.kind === "resolved";
```

Any resolved item, not any resolved **pull request**. So a resolved Jira issue or
Jenkins build offers *What breaks if it lands* and *Who should review it*, and
`agentParams` (`handlers.ts:369`) hands the Jira URL to `agents.impact` as
`fileOrPrUrl`. The user gets a lane whose question does not apply, answered from
an input the agent was not built for. ROADMAP C2.3: *"A lane that fires
everywhere is noise, and noise is how ambient UI dies."*

## The decision — pin, don't follow

The panel captures its page at mount and keeps it. It does not re-resolve on
navigation by itself.

Rejected: **follow the page automatically** (reset and re-resolve on every URL
change). It reads well and it is wrong here. A fast click-through on a PR list
fires a resolve per navigation, and the panel's whole point is that nothing runs
until you ask — a panel that silently re-reads on every route change is a panel
doing gateway work you did not request. Debouncing manages the burst; it does not
change what the panel decided to do on its own.

Rejected: **pin with no detection at all**. It fixes the divergence and leaves
the panel silently describing a page you left, with no way to tell from the panel
that it is doing so. Honest about the item, dishonest about the situation.

So: pin for correctness, and tell the user when the pin no longer matches where
they are, with one button that re-reads deliberately.

## Identity, not URL equality

`resolveUrl` **preserves sub-tab segments and the query string** on purpose
(`recognise.ts:192-207`): canonicalisation is the gateway's job, and the client
does identity normalisation only. So URL inequality is the wrong staleness test —
clicking a PR's **Files** tab changes the URL and not the item, and a banner there
would be a lie in the other direction.

The recogniser already computes the item's identity: `(product, kind, ref)`.
`acme/web #482` on `github`/`pr` is stable across `/files`, `/commits`,
`?diff=split` and a fragment. That triple is the comparison:

| Navigation | Identity | Panel |
| --- | --- | --- |
| `#482` → `#482/files` | unchanged | nothing. The header's claim is still true. |
| `#482` → `#517` | changed | banner |
| `#482` → repo home (unrecognised) | changed | banner |
| unrecognised → `#482` | changed | banner |

A new pure `sameItem(a: Recognition, b: Recognition): boolean` in `recognise.ts`
owns this. Two `ok: false` recognitions compare **equal** — both are "no item
here", and their `reason` (`unknown-host` vs `unrecognised-path`) is a diagnostic
about the URL, not a different item. Without that rule, wandering between two
unrecognised pages under an open panel would re-banner for no user-visible
change.

## Detection

Neither browser gives a content script a portable hook for this:

- `popstate` fires for back/forward only, never for `pushState`.
- Patching `history.pushState` is invisible from the isolated world the panel is
  injected into, so page-initiated navigations would be missed.
- The Navigation API (`navigation.addEventListener("navigate")`) is Chromium-only.
- `chrome.webNavigation.onHistoryStateUpdated` would work from the worker and
  costs a new, broad-sounding permission on a client whose privacy story is the
  product. Not for this.

So: a **500 ms `setInterval` string compare** of `window.location.href` against
the last URL checked, plus a `popstate` listener that runs the same check
immediately. The interval does string work only. A message goes out **at most
once per distinct URL** — not once per tick.

The `popstate` listener goes on `mount`'s existing `AbortController` signal, with
every other page listener; the interval is cleared in `stopPolling`, beside the
lane poll timers it already clears. No new lifecycle.

## One new message — `recognise`

The panel cannot classify a URL itself: origins live in the worker
(`src/background/origin-store.ts`), and the panel only ever receives the
`recognition` embedded in a resolve response. Comparing identities needs the live
URL classified.

```ts
{ kind: "recognise", pageUrl: string }   →   { kind: "recognition", recognition: Recognition }
```

`handleRecognise(deps, req)` is `recognise(req.pageUrl, await deps.getOrigins())`
and nothing else: **no gateway call, no token read, no network**. It is the same
pure function `handleResolve` and `resolveForAgent` already gate on, exposed on
its own so the panel can ask "is this still the same item?" without asking the
gateway anything.

Rejected: **shipping the origins list to the panel** so it can recognise locally.
It would put the user's configured internal hostnames into a content script on
every page the panel opens on, to save a message that costs no network. Answering
one question is less exposure than handing over the config that answers all of
them.

## The banner

`PanelState` grows one optional field:

```ts
readonly navAway?: { readonly onReread: () => void };
```

A function on the state follows `Lane.render`'s existing precedent in this type,
rather than making `renderShell` take a fifth positional callback after
`onChoose` and `onFetch`.

`renderShell` renders it **between the header and the lanes**, so it coexists
with every header state — `resolved`, `ambiguous`, `chosen`, `needs-scope`,
`error`, and all four fetch states — instead of competing with them as another
`HeaderState` arm. Copy: *"You've navigated away from this page."* plus a
**Re-read page** button.

The notice is a `role="status"` region so a screen-reader user learns the panel's
subject no longer matches the tab.

## Re-read resets the page-scoped state

**Re-read page** re-pins to the current URL and clears everything scoped to the
old page — `laneState`, `laneOpen`, `chosen`, `fetchState`, `relatedBody`,
`relatedExpanded`'s stored value and the `fetchSent` latch — then re-runs
`loadHeader` and `loadRelated`. No agent runs: a lane starts `collapsed`, and
expanding it stays the only thing that invokes.

**`fetchSent` resets.** One-fetch-per-panel exists to stop a second outbound
provider request for the *same item*; a different item, behind an explicit click,
is a different question, and the rule's purpose is intact.

**A stored lane answer for the new page still replays.** `agent-run-store` keys
by item id, so a lane whose item was already answered comes back `done` on first
expand without a second run, exactly as C2.2 shipped it.

**In-flight responses from before the re-read are dropped.** There is nothing to
cancel — C2.2 deferred abort because upstream has no cancellation to hook into,
and a UI-only abort would lie about what happened. Instead the reset increments a
generation counter that each in-flight `sendAgentRun` / `pollLane` / `sendFetch`
response checks before it stores or paints, the same guard shape as the existing
`closed` flag (`panel-in-page.ts:489`) and for the same reason: a response landing
after its subject is gone must not repaint.

## Lane gating — a table, not a condition

```ts
// src/shared/types.ts, beside AGENT_LANES
export const LANE_SURFACES: Record<AgentLane, readonly SurfaceKind[]> = {
  impact: ["pr"],
  expert: ["pr"],
};
```

`showAgentLanes` becomes a filter of `AGENT_LANES` by the **recognised**
`SurfaceKind`. On a Jenkins build or Jira issue the panel shows its header and
Related, and no lane that cannot answer.

Gated on the recogniser's `kind` (a closed union this repo owns), not on
`ResolvedItem.type` (a free-form string from the wire). A `Record` keyed by
`AgentLane` also makes the next lane a table row that fails to typecheck if it
omits its surfaces — which is the written-down rule C2.3's done-when asks for,
delivered a slice early.

**The gate stays render-level.** `handleAgentRun` is not changed to refuse a
lane that does not belong on the page's surface: it would need a new
`AGENT_ERRORS` member for a state the shipped UI cannot reach, and every arm of
that union is documented as reachable and renderable. `messages.ts` already
rejects an unknown lane id; a *known* lane paired with a mismatched page is
exactly what ships today, so this is a correctness gate, not a boundary check.

## Files

| File | Change |
| --- | --- |
| `src/shared/recognise.ts` | new pure `sameItem(a, b)` |
| `src/shared/types.ts` | new `LANE_SURFACES` |
| `src/shared/messages.ts` | `RecogniseRequest` / `RecognitionResponse` + guards |
| `src/background/handlers.ts` | new pure `handleRecognise` |
| `src/background/service-worker.ts` | route `recognise` |
| `src/panel/panel-view.ts` | `PanelState.navAway`, rendered by `renderShell` |
| `src/panel/panel-in-page.ts` | pin the URL; the four send sites above; the watcher; the reset + generation counter; the lane filter |
| `docs/architecture.md` | the pinned-context rule in the recognition-pipeline section |
| `CHANGELOG.md` | the user-facing entry |
| `ROADMAP.md` | the corrections below |

## Tests

Vitest, node env except where the DOM is the subject (jsdom docblock, as today).

- `sameItem` — sub-tab, query-param, fragment, trailing slash, Jira key case,
  different PR, different repo, recognised↔unrecognised, both-unrecognised-equal.
- `LANE_SURFACES` — the filter yields both lanes on `pr` and none on `build` /
  `issue`; the table is total over `AGENT_LANES`.
- `handleRecognise` — returns the recognition for configured and built-in
  origins, and makes **no** gateway call (injected deps assert it).
- `messages.ts` guards — the new request/response round-trip, and rejection of a
  malformed `recognition`.
- `renderShell` (jsdom) — the notice renders under each `HeaderState` arm,
  carries `role="status"`, and its button calls `onReread` once.
- The reset (jsdom) — clears lane state, `chosen`, `fetchState` and `fetchSent`;
  a response from before the reset neither stores nor paints.

## Out of scope

- **New lanes.** `LANE_SURFACES` is the seam C2.3 will use; this slice adds no
  member.
- **Auto-surfacing the panel.** It stays user-summoned.
- **Abort.** Still blocked upstream (C2.2).
- **C2.5.** Lanes on a chosen candidate need the picked id carried through
  `agent-run`; that is a message-contract change and its own slice. This slice's
  gate is layered *above* the `resolved`-only condition C2.5 will relax, so the
  two do not collide.

## Roadmap corrections this slice records

Three claims in `ROADMAP.md` are wrong and were found while scoping this. All
three are corrected as part of this work, in the repo's existing habit of
recording a corrected claim rather than quietly editing it:

1. **C2.3 names `agents.preflight` for a deploy/build page. It is not reachable.**
   Upstream excludes it from the HTTP surface deliberately —
   `HTTP_EXCLUDED_AGENT_METHODS` in `packages/gateway/src/ipc/agents-rpc.ts:799`,
   alongside `agents.premortem` and `agents.whyPeek` — because it has side
   effects on the owner's machine that an external caller should not be able to
   trigger unprompted. Same class of error C2.1 already had to correct for
   `agents.why` / `agents.whyPeek`.
2. **C2.3 names `agents.ghost` and `agents.conflicts`. Both take a local file
   path.** `requireFileParam` (`agents-rpc.ts:239`) requires `{ file: string }`,
   the same local-checkout wall that put "why" into C2.4. What *is* browser-viable
   over the HTTP surface is the service-scoped set — `catchup`, `decisions`,
   `ownership` (all accept `{ service }`, which the recogniser already knows) and
   `glossary` (`{ term }`, which a selection supplies).
3. **C1.5 says the panel has "exactly one entry point".** The popup's
   *Show related* button has existed since Slice 2 (`src/popup/popup.html:18`,
   commit `e99749b`). What C1.5 actually still buys is a context-menu trigger and
   surfacing the bound-or-unbound shortcut in Options.

Verified against `C:/gitrep/Nimbus` at `aaa637d0`, read from source — not from
this roadmap's own account of it.

## Done when

- Navigating under an open panel never produces a header and a lane that describe
  different items, in Chrome and Firefox, on a real GitHub PR.
- Switching a PR's sub-tab produces no banner and no re-read.
- Navigating to a different item shows the notice; **Re-read page** makes the
  panel describe the new page with no lane running until expanded.
- A resolved Jenkins build and a resolved Jira issue show the header and Related,
  and no agent lane.
- `typecheck`, `lint`, `test`, `build`, `check-build` green.
