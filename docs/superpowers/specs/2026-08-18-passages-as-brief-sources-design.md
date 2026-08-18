# Passages as brief sources

**Status:** design, approved 2026-08-18. Implements a roadmap item that **does not exist
yet** — see *Corrections to the roadmap*. It delivers **2.3 "Highlight-stitching"** in the
shape **C5.2** re-aimed it to, as a new **C5.3**.

**Branching:** on `main` (`b99c017`, *feat(brief): research briefs from the tabs you have
open (#61)*). Nothing is stacked.

**No upstream read was needed.** Every route, cap and body shape this slice touches was
already read and recorded by the C5.1 design; this slice sends the same
`POST /v1/briefs/{id}/sources` body it already sends, with a different `body` string in it.
**The gateway does not change, and does not need to know.**

## What this builds

A brief's sources are whole pages. But reading is not whole pages — you find the three
paragraphs that matter and you want the brief built on *those*, not on the navigation
chrome, the comment thread and the eleven other sections that happened to share the URL.

This slice adds a right-click **"Add to brief"** on any selection. Passages accumulate
across pages and across tabs; the brief composer shows them as sources you can pick,
alongside the tabs you have open; and a page you highlighted three times arrives at the
gateway as one source containing those three passages, in the order you collected them.

Because the text is captured **when you highlight it**, a passage survives closing the tab
— and, for the first time in this extension, the pre-send preview can show the user the
*actual text that will leave*, not a description of it.

## Why this is unblocked now

C5.2 recorded the re-aim and named the reason:

> **2.3 "Highlight-stitching" is re-aimed.** Its reframe note already said the collect UI
> would have to live as a panel lane. A brief's source list is the better home for
> "assemble several things into one"; the selection half becomes a follow-up to C5.1.

Two facts make it a client-only slice:

1. **The client supplies the body.** `BriefSourceBody` is `{url, title, body, capturedAt,
   truncated}` (`src/shared/brief.ts`). Nothing in the contract says `body` is a whole page
   — the gateway is told what the source text *is*, and it is the client's job to say so
   honestly. A stitched excerpt set is a legal source today.
2. **The gesture already exists.** `MENU_CLIP_SELECTION` proves a selection-scoped
   right-click entry works, and `runCapture(tabId, "selection")` already returns
   `{url, title, body}` for the live selection. This slice re-points that machinery at a
   store instead of at `POST /v1/clips`.

## The decisions

### 1. The menu collects; the composer reviews

2.3's reframe note said the collect UI "has to live as a panel lane, not as a second
overlay". That was right about the *overlay* and wrong about the *lane*, for two reasons
this repo has since learned:

- A panel lane costs a gesture per page — you must summon the panel before you can
  highlight into it. The whole value of collecting is that it is cheap enough to do while
  reading.
- `panel-in-page.ts` is 1,939 lines. C2.5 already had to lift its lane gate out into
  `lane-input.ts` to keep the file workable, and it was 1,256 lines when that was written.

So: **collecting is a context-menu entry, and the collection is reviewed where sources are
already picked** — the brief composer. Nothing in `src/panel/` changes.

`src/background/menus.ts` was built for exactly this ("adding an entry is a table edit plus
a `menuAction` arm"), and the `never` assignment in the worker's menu switch turns
"someone added a `MenuAction` member and forgot to route it" into a compile error.

### 2. Collect reuses `runCapture`, never `info.selectionText`

The two shipped selection menus (`define-selection`, `related-to-selection`) read
`info.selectionText` off the click. That is correct **there**: `term.ts` refuses anything
over its length cap anyway, so a browser-truncated field can never produce a silently
short answer — it produces a refusal.

A passage is long by nature, and `selectionText` is truncated by the browser without
saying so. Collecting from it would file a silently cut excerpt under the user's own
selection gesture — the exact defect class `buildSourceBody`'s `truncated` field exists to
prevent. So the collect path runs `runCapture(tabId, "selection")`, the same call the clip
path uses, and takes `CaptureResult.body`.

### 3. Several passages from one page are ONE source

All passages sharing a URL are stitched, in collection order, into a single source body
with a light separator between them. This is 2.3's own acceptance bar ("a single clip
preserving order and source"), aimed at a brief.

The alternative — one source per passage, all carrying the same URL — was rejected: it
declares the same URL many times in `sources`, makes dedupe the gateway's problem rather
than ours, and lets five highlights on one page eat a quarter of the twenty slots a run
has.

The separator is a visible marker, not a blank line. The body is a set of excerpts, not
continuous prose, and a reader (human or model) that cannot see the joins will quote across
one as if the page had said it.

### 4. `capturedAt` is the OLDEST passage's time

A stitched body is only as fresh as the oldest text in it. `capturedAt` says when this text
was read from the page; taking the newest passage's time would overstate the freshness of
everything above it. Understating is the safe direction, so the group's `capturedAt` is its
earliest passage's.

This is also the only `capturedAt` in the brief path that is **not** `deps.now()` — a tab
source is captured during the run, a passage source was captured minutes or hours before
it. Recording the run time for a passage would be a plain untruth.

### 5. A collected page that is also an open tab is ONE row, passages by default

The composer shows one row per URL. Where a group's URL matches a named tab, the row is in
**passages mode** and carries a *use the whole page instead* toggle.

Passages win by default because highlighting is the user telling the composer which part
matters, and C2.5's brief names the cost of ignoring that: *"Throwing that answer away one
control later is exactly the kind of small betrayal that trains people to stop using a
panel."*

The toggle is offered **only when that tab is currently open and named** — whole-page mode
means "capture this tab at start", and a row for a closed tab has nothing to capture. A
group whose tab is gone still appears, still picks and still sends: its text is already
held.

Both kinds count against the same `BRIEF_CAPS.maxSources` (20) counter. A URL is declared
exactly once, in exactly one mode.

### 6. The pick list becomes one ordered union, not two arrays

`BriefStartRequest.tabIds: readonly number[]` becomes:

```ts
readonly picks: readonly ({ kind: "tab"; id: number } | { kind: "passages"; url: string })[];
```

One ordered list rather than `tabIds` plus `passageUrls`, because the order the composer
displayed is then the order the gateway is told, with no merge rule in the handler to get
wrong. A tab pick is identified by tab id (the composer has one) and a passage pick by URL
(the collection's key).

The composer is a page, so this is untrusted cross-boundary input and gets a guard in
`messages.ts` like every other message — including rejecting a `kind` outside the union and
a `url` that is not a string.

### 7. The preview distinguishes a page from a set of passages — and shows the passages

`buildBriefPreview` today renders `"N pages"` and one title/URL row per source. Left alone
it would say *pages* while sending *excerpts*: a small lie, in the direction of claiming
more was sent than was.

So a preview source carries its kind. The count reads `"4 sources — 2 pages, 2 sets of
passages"`, and a passages row says `3 passages` where a page row says the address alone.

**And the part that is new:** for a passage source the body is already known at preview
time, because it was captured at collect time. Every other preview this repo has shown
describes an intent — *this URL will be read* — because the text does not exist yet. This
one can show the text itself, collapsed per source under the passage count.

`SYNTHESIS_NOTICE` is unchanged and still applies verbatim: the client still cannot know
where synthesis runs, and passages do not change that.

### 8. Caps are enforced at COLLECT time, and a full collection refuses rather than evicts

Two caps, both checked when a passage is added:

| Cap | Value | On breach |
| --- | --- | --- |
| one page's stitched body | `BRIEF_CAPS.extractionCapBytes` (200 KB) | refuse the add, toast says so |
| pages held in the collection | 20 (`BRIEF_CAPS.maxSources`) | refuse the add, toast says so |

Enforcing at collect time rather than at feed time is deliberate. `buildSourceBody`'s
truncate-and-declare is the right answer for a page the client extracted on the user's
behalf; it is the wrong answer for text the user selected by hand, where the honest move is
to say *now*, while they are standing there having just right-clicked, that this one did not
fit. The run-time truncation path stays as the backstop and, for passages, can then never
fire.

**Refuse, never evict.** The clip queue drops its oldest entry under storage pressure; this
store must not, because a passage exists in exactly one place and was put there by hand.
A refusal the user can act on immediately beats a silent loss they discover at send time.

An exact-duplicate add (same URL, same text) is a no-op with its own toast — re-highlighting
the same paragraph is a mis-click, not an instruction to send it twice.

### 9. Passages fed into an accepted run are removed; a failed run keeps them

The collection is cleared of exactly the groups that were **accepted into a run that
reached `/run`** — the same moment `brief-handlers.ts` writes the disclosure log entry,
and for the same reason: that is the moment the text left.

Leaving them would mean the next brief silently re-sends text the user already sent, which
is the failure mode a persistent collection invites. A run that fails before `/run` keeps
everything, because nothing left. A group skipped for `run_capacity` keeps its passages,
because it was never fed.

The cost is real and accepted: re-running the same sources with a tweaked question needs
re-collecting. Manual per-row remove and a clear-all in the composer cover the rest.

### 10. No badge

The offline queue owns the toolbar badge (`feedback.ts`, the queue's badge tracking). A
second writer would mean the two states overwrite each other and neither is trustworthy.
The collect confirmation is the shipped in-page toast — *"Added — 3 passages from this
page."* — which is also the only surface that can report the refusals in decision 8.

### 11. No new manifest permission, and collecting works on an ungranted page

`contextMenus`, `activeTab`, `scripting` and `storage` are all already in
`permissions` (`src/manifest/manifest.ts`). Nothing is added, so the per-target manifest
composition and its drift check are untouched.

A context-menu click grants `activeTab` on the clicked tab, so a passage can be collected
from a page whose origin was never granted for enumeration — and that is correct, not a
leak in C1.4's model. That model is about **silent** reads: `tabs.query` withholds
`url`/`title` without a host grant, so the composer may not *name* a tab it may not *read*.
A passage is the opposite case: the user selected the text and right-clicked it. The
gesture is the grant, exactly as it is for `MENU_CLIP_SELECTION` today.

The consequence to state plainly in the composer: a passage group may name a URL that has
no row in the tab list. That is a page you acted on, not one we enumerated.

### 12. A stitched passage set is never a clip in this slice

2.3's original acceptance bar was *one coherent clip*. C5.2 re-aimed the collect UI at a
brief's source list, and this slice stops there. Sending a stitched body to `POST /v1/clips`
is a separate question about the ingest path — `mode` is `"article" | "selection"` and
neither describes an assembled excerpt set, so it needs an answer, not an assumption.

## Shape

```
src/shared/passage.ts             NEW  pure: the collection's rules
src/background/passage-store.ts   NEW  chrome.storage.local persistence
src/background/passage-collect.ts NEW  the collect action, injected deps
src/background/menus.ts                one MENU_ITEMS row + one menuAction arm
src/background/service-worker.ts       one switch arm routing to passage-collect
src/shared/messages.ts                 BriefStartRequest.picks + its guard
src/shared/preview.ts                  BriefPreview sources gain a kind + passage text
src/shared/preview-view.ts             render a passages row
src/background/brief-handlers.ts       picks -> source union; feedAll skips capture for
                                       passages; clear fed groups after /run
src/brief/brief-view.ts                passage rows, whole-page toggle, remove, cap counter
src/brief/brief.ts                     send picks; request the collection
src/brief/brief.css                    the new row affordances
```

### `src/shared/passage.ts`

```ts
export type Passage = {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly at: number;
};

export type PassageGroup = {
  readonly url: string;
  readonly title: string;
  readonly passages: readonly Passage[];
};

export const PASSAGE_CAPS = { maxPages: BRIEF_CAPS.maxSources } as const;

export function groupPassages(all: readonly Passage[]): readonly PassageGroup[];
export function stitch(group: PassageGroup): string;
export function groupCapturedAt(group: PassageGroup): number;   // decision 4
export function addPassage(
  all: readonly Passage[],
  next: Passage,
): { ok: true; all: readonly Passage[] } | { ok: false; reason: PassageRefusal };
export function isPassage(v: unknown): v is Passage;            // storage read guard
```

`addPassage` is the single mutation, and it owns every rule in decision 8 — duplicate,
per-page bytes, page count. A store that only persists what this function returns cannot
drift from the rules, and every rule is testable without a browser.

**Grouping is by exact URL string.** Two visits to the same page under different query
strings are two groups, and an SPA navigation makes a new one. That is the correct
behaviour — they are different addresses and the brief will cite them as such — and it is
the same identity `CandidateTab.url` uses, so decision 5's row match is a string equality
and not a normalisation question. Canonicalisation stays the gateway's job (`recognise.ts`).

### `src/background/passage-collect.ts`

```ts
export interface PassageCollectDeps {
  readonly runCapture: (tabId: number, mode: "article" | "selection") => Promise<CaptureResult>;
  readonly update: (m: (all: readonly Passage[]) => AddResult) => Promise<AddResult>;
  readonly showFeedback: (tabId: number, state: ToastState, restricted?: boolean) => Promise<void>;
  readonly now: () => number;
}
```

The same shape as `QuickClipDeps`, for the same reason: the action is pure orchestration
over injected seams and is tested without a browser. Restricted-URL refusal reuses
`isRestrictedUrl`; an empty capture body is its own toast (*"Nothing selected."*), because
the browser only offers a selection entry when there is a selection, so an empty one is a
browser-level surprise worth reporting rather than swallowing.

### `passage-store.ts`

`getPassages` / `updatePassages`, mirroring `clip-queue-store.ts` — including its
serialized read-modify-write chain, since a menu click and a composer read can interleave
on the same key. It differs in one place, decision 8: a failed write **refuses**, and never
retries by dropping the oldest.

## Layers

| Layer | Knows about | Does not know about |
| --- | --- | --- |
| `shared/passage.ts` | grouping, stitching, caps, duplicates | storage, tabs, the gateway |
| `passage-store.ts` | one storage key, the write chain | why anything is collected |
| `passage-collect.ts` | capture, the store, the toast | the brief protocol |
| `brief-handlers.ts` | a source is a tab or a group | how a group was collected |
| `brief-view.ts` | rows, modes, the cap counter | storage, capture |

`handleBriefTabs` grows one field (`passages`) rather than the composer gaining a second
round trip: the composer renders once, from one answer, and cannot show a tab list and a
passage list that disagree about the same URL.

## Failure surface

| Case | Answer |
| --- | --- |
| Selection empty at collect | toast *"Nothing selected."* |
| Restricted page | toast, the clip path's existing wording |
| Duplicate passage | toast *"Already collected."*, no write |
| Page over 200 KB | toast *"That page's passages are full."*, no write |
| 21st page | toast *"Collection is full — send or clear a brief first."* |
| Storage write fails | refuse and say so; the held collection is left intact |
| Passage group's tab closed | row still shown, still sendable — text is already held |
| Group's URL also an open tab | one row, passages mode, whole-page toggle |
| Group's URL on an ungranted origin | row shown; no toggle (nothing to capture) |
| `run_capacity` hits a passage group | skipped like any source; its passages are kept |

A passage source **cannot** fail to capture, so it never enters `skipped` and the report's
shortfall list stays true. That is a property worth asserting in a test: the only way a
passage group misses a run is a gateway refusal.

## Testing

**Pure (`test/unit/`, node):**
- grouping by exact URL; stitch order is collection order; the separator is present between
  passages and absent around a single one
- `groupCapturedAt` returns the oldest, including when passages were added out of order
- `addPassage`: duplicate refused; per-page byte cap refused at the boundary; 21st page
  refused; a refusal never mutates
- `isPassage` rejects every malformed stored shape
- preview: page row vs passages row wording; the mixed count string; passage text present

**Handlers (injected deps):**
- collect: empty body, restricted URL, duplicate, cap refusal, success writes once
- `handleBriefStart` with mixed picks: create declares every URL once; `feedAll` does not
  call `capture` for a passage source; feed order matches `picks` order; `capturedAt` is the
  group's oldest; a fed group is cleared only after `/run` is accepted; a failed run clears
  nothing; `run_capacity` keeps the unfed groups
- message guard: `picks` rejects an unknown `kind`, a non-string url, a non-number id

**DOM (jsdom docblock):** composer renders a passage row with its count and age; the
whole-page toggle appears only for an open named tab and flips the row's mode; remove drops
one row; the cap counter counts both kinds.

**E2E (`test/e2e/passages.e2e.ts`, against `mock-gateway.ts`):** the gate that matters, and
the composer has none today — the four shipped specs cover capture and three lane surfaces.
Playwright cannot click a browser context menu (it is OS-level chrome, outside the page), so
the collection is seeded through the harness's `sw.evaluate` into `chrome.storage.local` and
the spec drives everything downstream: the composer's rows, the whole-page toggle, the
preview, and — the assertion no unit test can make — that the body the mock gateway actually
received contains both passages with the separator between them, under one declared source.

**Manual (`docs/development.md`):** the collect gesture itself and its toasts, which is
precisely the half the e2e cannot reach — a context menu is one of the surfaces that
checklist exists for. One step: highlight on two pages, collect three passages across them,
confirm each toast, then open the composer.

## Not in this slice

- **Stitched passages as a clip** (decision 12).
- **Reordering passages within a group.** Collection order is reading order; a reorder UI is
  composer weight for a case we have not hit.
- **Editing a passage's text.** The value of the preview is that it shows what was captured;
  a text box in front of it makes that claim unverifiable.
- **A panel lane for the collection** (decision 1). If the composer proves too far away, that
  is a follow-up with evidence behind it.
- **Passage-level citations.** The gateway cites a source; a source is a page. Finer-grained
  citation is a gateway question, not a client one.

## Corrections to the roadmap

- **2.3 "Highlight-stitching" is delivered, re-aimed — not as written.** Its own acceptance
  bar ("multiple highlights on a page become a single clip") is **not** met and is not
  intended to be; C5.2 already re-aimed it at a brief's source list. 2.3 gets a status line
  saying so, pointing at C5.3.
- **Phase C5 gains C5.3 "Passages as brief sources"**, 🟢 · M. The roadmap has no brief for
  this work — C5.2 named the re-aim in prose and stopped there.
- **2.3's reframe note is wrong about where the collect UI must live.** It says the collect
  UI "has to live as a panel lane, not as a second overlay". The overlay half stands; the
  lane half was written before C1.5 gave the panel a second entry point and before
  `panel-in-page.ts` reached 1,939 lines. Decision 1 records the reason.
- **C5.1's "the set it can name is the set it can read" needs one qualifier**, not a
  correction: it holds for *enumeration*. A passage is named because it was acted on, not
  because it was enumerated (decision 11).
