# Capture as the last resort

**Status:** design, approved 2026-08-16. Implements roadmap **C3.2**.

**Upstream read at:** `Nimbus` @ `b0fbe14a` (`origin/main`, past `v1.27.0`), plus the
in-flight `dev/asaf/related-item-and-fields`. Contract claims below were read from
that source.

**Branching:** this branch is stacked on `feat/richer-related-lane` (PR #57), not on
`main`. Both slices rework `panel-view.ts` and `panel-in-page.ts` substantially, and
rebasing a second set of changes onto a 1,500-line file is worse than ordering them.
#57 merges first.

## What this builds

The panel's last dead end becomes a way out. On a page the gateway cannot help with —
an internal wiki, a vendor console, a connector that isn't configured — the panel
offers to capture the page and ingest it, so the index has *something* rather than
nothing.

Capture is not being restored as the main road. It is the fallback for surfaces no
connector models, and the panel says so, permanently.

## Why this is unblocked now

C3.2's brief lists two blocking defects: **Nimbus#1005** (clip bodies truncated to 512
characters while `wordCount` reported the full length) and **Nimbus#1006** (`web_clip`
routing to OpenAI embeddings when a key is set, contradicting the store listings'
local-only claim). Both are **CLOSED** upstream as of 2026-08-11.

The roadmap still describes them as open and still cites them as this item's blocker.
That is stale, and the correction belongs in this slice — see the last section.

## The six decisions

### 1. The offer appears where the gateway has already failed, never instead of it

Capture is the worse answer. A connector models a pull request; a DOM scrape produces a
lower-fidelity copy of data the gateway already has properly. So the offer is gated on
the gateway having nothing left to try:

| Header state | Offer capture? | Why |
| --- | --- | --- |
| `unrecognised` | **Yes** | The brief's actual target. No connector models this page at all. |
| `not-indexed`, `fetchable: true` | **No** | C3.1's fetch is the better answer and it is right there. |
| `not-indexed`, `fetchable: false` | **Yes** | The gateway has said it cannot fetch this. |
| `fetch-blocked: unfetchable` | **Yes** | Terminal. |
| `fetch-blocked: not-configured` | **Yes** | Terminal. Likely the most common real dead end. |
| `fetch-blocked: needs-fetch-scope` | **Yes** | Terminal until the user re-pairs. |
| `unresolvable` | **Yes** | The URL resolves to nothing and never will. |

On a fetchable miss the offer appears only **after** a fetch has been attempted and
failed *terminally* — which lands in one of the `fetch-blocked` rows above. So the rule
needs no separate "has a fetch been tried" flag: the states the panel is already in
encode it.

A **transient** fetch failure is deliberately not an offer. Rate limiting renders *"Rate
limited — try again shortly"* with a Try again button (`panel-view.ts:457-458`), and a
retry is a better answer than a scrape; putting a capture button beside it would invite
the user to take the lower-fidelity path over a wait of seconds. Capture appears only
where nothing else will ever work.

**`unrecognised` keeps its Options hint, demoted.** Today that state says only *"Add
this site under Recognised surfaces in Options."* For a self-hosted Bitbucket that is
still the right answer and a capture would be the wrong one — a real connector beats a
scrape. So the hint stays; the capture offer joins it as the answer for pages no
connector will ever model.

**Restricted pages need no check.** `isRestrictedUrl` (`quick-clip.ts:14`) exists
because a hotkey can fire on `chrome://`. The panel cannot: it is an injected content
script, so its presence proves the page was injectable. The offer cannot appear
somewhere capture would fail.

### 2. Capture, preview, clip — the popup's shape, not a new one

The flow is: **click → capture the pinned page → preview → send → re-resolve.**

The panel asks the worker to capture, gets a `CaptureResult` back, and only then builds
and sends a clip. Two steps, matching the popup. A single "capture and clip it" message
would give the extension a second place that turns a page into a `ClipPayload`, and the
1.3 preview exists precisely because there is one such place and it can be shown.

**The captured page is the PINNED page, not the tab's current URL.** The panel pins the
page it was opened on and notices navigation (the C1.3/page-context slice). Capture must
use the same pinned URL, or a background SPA navigation would let the panel offer to save
one page and actually save another — the exact defect that slice exists to prevent.

### 3. The preview is 1.3's, off switch included

A panel capture is page content leaving the browser, which is what 1.3's preview is for.
It reuses `shared/preview.ts` + `shared/preview-view.ts` and honours the same Options
setting the popup does, so there is **one rule for outbound content** regardless of which
surface triggered it.

This is deliberately *not* C4.2's treatment. C4.2 made the fetch confirm mandatory because
a targeted fetch is an **I13 write**: the gateway reaches out to a third party under the
user's stored credential, and the user is authorising that reach. A capture sends only
what the user is already looking at, to their own machine — the same act as a popup clip,
so it gets the popup's rule, not the fetch's.

The brief's *"one gesture"* is therefore read as: one gesture, plus whatever confirmation
the user has already chosen to keep. A user who turned the preview off gets literally one
gesture.

### 4. The honesty is keyed on the item, not on the moment

The brief requires the panel to be *"honest that this is a captured copy, not connector
data"*. The obvious implementation flags the state right after capturing — and is wrong,
because a page captured last week resolves like anything else and would then present as
connector data. That is the same dishonesty, delayed by a week.

So the discriminator is the **item**: a resolved item with `service: "nimbus"` and
`type: "web_clip"` renders as a captured copy, whichever way the panel arrived at it —
capturing it just now, or opening the panel on it a month later. One state, one wording,
no expiry.

Those two values are `CLIP_SERVICE` and `CLIP_TYPE` in
`packages/gateway/src/clips/clip-ingest.ts:7-8`. Hardcoding them couples the client to
gateway constants; the precedent is `Product`, which already hardcodes the connectors'
own `SERVICE_ID` values. Recorded as a real coupling rather than waved away: if the
gateway renames either, this header silently degrades to the ordinary resolved arm — it
does not break, it just stops being honest, which is the failure mode worth knowing.

**It cannot reuse the `resolved` arm.** That arm renders a surface line sourced from
recognition, and an unrecognised page has no recognition to source it from. The captured
arm names the item and its freshness, states that this is a copy you saved, and shows no
surface line.

### 5. The lanes need no new rule

`LANE_RULES` gates page lanes on `SurfaceKind`. A captured wiki page is `unrecognised`,
so it has no surface, so `impact` and `expert` correctly do not appear — they are
questions about a change under review, and this is a wiki page. The glossary lane still
works, because its rule declares no surfaces and its input is a term. Related answers
against the new item like any other.

Nothing to add. This is the C2.3/C2.5 lane-rules design paying off: a new kind of
resolved item needed no lane change at all.

### 6. One capture per panel, and no silent re-capture

A capture in flight disables the offer, mirroring C3.1's one-fetch-per-panel rule. Once
the item exists, the header is the captured arm and the offer is gone — so re-clicking
cannot produce a duplicate.

Re-capturing to refresh a stale copy is **not** in this slice. It is a real feature and a
different one: it needs a freshness judgement the panel does not have, and quietly
overwriting a copy the user saved deliberately is worse than showing them an honest
"Updated 3 weeks ago" and letting them decide.

## Shape

Client, `src/shared/messages.ts`:

```ts
/** Capture the pinned page. The panel's step 1 — the payload is previewed and
 *  sent by the existing `clip` request, never ingested by this one. */
export interface CaptureRequest {
  readonly kind: "capture";
  readonly pageUrl: string;
}

export type CaptureResponse =
  | { readonly kind: "capture"; readonly ok: true; readonly capture: CaptureResult }
  | { readonly kind: "capture"; readonly ok: false; readonly reason: CaptureError };
```

`CaptureError` covers the honest failures: the tab is gone, injection was refused, or the
page yielded nothing capturable. Each gets its own panel line — "couldn't read this page"
is not the same as "this page has no readable content", and the user can act on one of
them.

## Layers

- `src/shared/capture-offer.ts` — **new, pure**: the decision-1 table as one predicate
  over `HeaderState`, plus the captured-copy discriminator from decision 4. New rather
  than inline because it is a rule over seven states that two files consult, and
  `panel-view.ts` (916 lines) is not where a rule belongs. Same precedent as
  `lane-input.ts`.
- `src/background/capture-tab.ts` — the inject-and-read step, factored out of
  `quick-clip.ts` so the hotkey path and the panel path share one injection, one
  restricted-URL check, and one failure vocabulary. `quick-clip.ts` keeps its toast; the
  panel renders its own states.
- `src/background/handlers.ts` + `service-worker.ts` — route `capture`.
- `src/panel/panel-view.ts` — the offer button, the reused preview, the captured header.
- `src/panel/panel-in-page.ts` — the capture state machine (idle → capturing → previewing
  → sending → re-resolving), generation-guarded like every other panel request.

## Testing

**Pure**: the offer predicate against all seven header states, including the two that
must NOT offer; the captured discriminator against a `web_clip` item, a connector item,
and an item whose service matches but type does not; the capture state machine's
transitions.

**Handler**: capture → clip → resolve; a clip that fails mid-flow leaves the panel on an
honest error and no captured header; a capture on a pinned URL that no longer matches the
tab is refused rather than silently capturing the new page.

**Render (jsdom)**: the offer's presence on each eligible state, the preview reusing 1.3's
markup, the captured header naming the item without a surface line.

**Manual** (`docs/development.md`): capture-in-page is not unit-testable. The pass needs a
real unrecognised page, a `not-configured` dead end, and a re-open of the panel on an
already-captured page to prove the honesty is durable rather than momentary.

## Not in this slice

- **Tags from the panel.** The popup owns filing; a rescue gesture is not the moment to
  ask someone to categorise.
- **Selection-mode capture.** Article only. A selection capture from the panel would
  compete with the glossary and related-on-selection gestures that already own selections.
- **Re-capture / refresh** — decision 6.
- **Any change to `POST /v1/clips`.** This slice is a pure consumer; the ingest contract
  is untouched.

## Corrections to the roadmap

**C3.2's `Depends` line is stale.** It names **Nimbus#1005** and **Nimbus#1006** as
blockers. Both closed upstream on 2026-08-11. The roadmap's pillar-2 section also still
describes them as "two open defects gate this pillar" and the north-star section still
sequences a rename behind #1006 being live. All three claims are now false; this slice
corrects the C3.2 brief and pillar 2, and flags the rename sequencing as needing its own
re-read rather than editing a decision this slice did not make.

**"Offer capture only after resolution and sync have both missed" undersold the target.**
Read literally it describes a recognised page whose resolve and fetch both failed — but
the brief's own *What* and *Done when* name an internal wiki and a vendor console, which
never reach resolve at all: they are `unrecognised`, a state that had no path forward
whatsoever. Both readings ship here (decision 1), but the second is the one that closes
the phase.
