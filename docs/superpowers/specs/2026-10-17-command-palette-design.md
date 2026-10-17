# 3.1 — The command palette

**Status:** design · 2026-10-17 · revised after review (§13)

## 1. The problem

Phases C1–C10 gave a recognised page up to a dozen things to do: seven agent
lanes (offered per surface and per gateway roster), deploy readiness on a PR or
build, related items, define-a-selection, clip page, clip selection. Every one
of them is reached the same way: open the panel, find the lane, expand it. On a
PR that is a hotkey, a scroll and a click before the question is even asked.

The roadmap already re-aimed **3.1** at this (*"the palette becomes the keyboard
route into the C2 lanes for the resolved item, not a list of capture verbs"*).
Nothing else left in the client-only phases serves the *frictionless UX*
pillar, and nothing here needs another repo.

**The palette is a launcher, not a second panel.** It lists what this page can
do, you pick one with the keyboard, and the answer lands where answers already
land: the panel. It renders no agent output of its own.

## 2. Goals, non-goals, anti-goals

**Goals**

- One shortcut opens a small overlay on any injectable page. Type to filter,
  `↑`/`↓` to move, `Enter` to run, `Esc` to dismiss.
- The list is **exactly** what the panel would offer on this page, nothing
  more or less: the same roster gate, surface rules, home-connector gating and
  titles. When a panel is already open on the same page, that includes the
  candidate it has picked (§5.2).
- Choosing a lane opens the panel (or reuses the open one) with that lane
  expanded **and asked**, the same as the user clicking it open.
- Clip page / clip selection run the existing one-gesture quick clip.
- On a restricted page the shortcut fails closed, visibly.

**Non-goals**

- A free-text ask box. Phase 5's reframe rules it out, and there is no
  endpoint for it.
- Palette-only actions. Anything listed must already exist as a panel lane, a
  panel section or a quick-clip verb. (DORA, briefs, the activity page, Options
  are §10 candidates, not v1.) That also leaves out a "Fetch this item" row on a
  `not-indexed` page. Targeted fetch is an I13 write behind the C4.2 preview,
  and it stays a panel gesture.
- A mouse-first entry point. The palette exists for the keyboard; the panel
  keeps its four click-driven triggers (C1.5), so an unbound palette shortcut
  loses no capability. Rows are still clickable (§4.3).
- Fuzzy matching. The list never exceeds ~12 rows; case-insensitive substring
  match on the title is enough.

**Anti-goals: this fails even if it works when…**

- the palette offers a lane the panel then refuses or doesn't show (drift
  between two lane lists);
- an instant row disappears once the page resolves (the list must only grow);
- opening the palette spends an agent run, or a page load does;
- a palette lane runs against a different page than the one the palette was
  opened on;
- the palette steals keystrokes from the page when it isn't open, or leaves a
  listener behind after it closes;
- a page script can drive it (synthesised key events into an open shadow root)
  or block it (a planted host element).

## 3. Constraints that shape it

- **One more `suggested_key` fits; a second would not.** Chrome caps suggested
  keys at four, and three are taken (`show_related`, `clip-page`,
  `clip-selection`). The palette takes the last slot. Any later command must
  ship unbound, which also means making `suggested_key` optional in
  `ManifestCommands`' `CommandDef`, where it is required today.
- **activeTab still covers it.** The command is a user gesture; injection is
  `chrome.scripting.executeScript`, like `panel.js`. No permission changes, so
  `store-listing.test.ts` stays as it is.
- **`suggested_key` is a suggestion** (the C1.5 lesson). An unbound palette
  shortcut shows as **Not set** in Options stage 2 for free, because
  `shortcuts-view.ts` is driven from `getAll`.
- **Recognition needs the worker.** `recognise()` reads the self-hosted origins
  from `chrome.storage`, so an injected script can't know the surface kind by
  itself. §4.1 has the worker hand it in.
- **Lane lists are computed in the page today.** `lanesFor`
  (`src/panel/lane-input.ts`) builds them from the resolve response, but
  `paint()` in `panel-in-page.ts` adds rules of its own on top: the built-in
  Related lane on every surface except `home`, hiding lanes on `home` when the
  connector is unhealthy, and per-surface titles (`LANE_TITLES` and
  `laneTitle`). §5 is about not copying those.
- **Page lanes need a resolved subject.** The panel won't send `agent-run`
  until its own `resolve` has landed and `pageSubject` holds (or a candidate is
  picked on an ambiguous page). The worker re-resolves on every run anyway.
- **The panel reads the selection once, at mount** (`panel-in-page.ts`, the
  `selected` read in `mount()`). An already-open panel learns about a new
  selection only through its selection hook, never from a lane intent.

## 4. Shape

```
 hotkey ──▶ worker: open_palette(tab)
              ├─ restricted URL ─▶ badge "!" (showFeedback), stop
              ├─ recognise(tab.url, origins) ─▶ PaletteInit
              └─ inject palette.js ─▶ __nimbusPalette(init)
                     │  instant rows (exact, from init):
                     │    Deploy readiness · Related · Clip page · Clip selection
                     ├─ send resolve ─▶ add lane rows (incl. glossary)
                     └─ Enter on a row (restore selection, remove host)
                          ├─ lane / deploy / related / candidates / define
                          │     ─▶ worker: palette-intent(sender tab, intent)
                          │           ─▶ panel hook (inject panel.js if absent)
                          └─ clip page / selection
                                ─▶ worker: quick-clip(sender tab, mode) ─▶ quickClip()
```

### 4.1 The command, and what the worker hands the palette

`open_palette` in `ManifestCommands` and the manifest, with description
"Open the Nimbus command palette". **Suggested key: `Alt+Shift+K`**, chosen
for no default binding in Chrome or Firefox and kin to the `Ctrl/Cmd+K`
palette convention. The manual pass confirms it binds on both
browsers before release (see §8). Routed in the `addCommandListener` if-chain
in `service-worker.ts` next to `show_related`.

Before injecting, the worker runs `recognise(tab.url, origins)`. Reading the
origins from storage is an await, but the activeTab grant outlives it, just
as `openPanel`'s `activeTab()` lookup does today. It then passes the result to `__nimbusPalette` as
a `PaletteInit` through the second `executeScript` call's `args`:

```ts
interface PaletteInit {
  readonly recognition: Recognition; // the same value resolve would carry
}
```

That makes the surface-dependent instant rows right from the first frame:
Related is withheld on `home`, and Deploy readiness is decided by
`deployBelongsOnSurface` plus `scope`/`origin`, exactly as
`appendDeploySection` decides it. Nothing instant ever has to disappear.

### 4.2 Restricted pages

The worker checks `isRestrictedUrl` (`capture-tab.ts`) **before** injecting and
calls `showFeedback` with `restricted=true`, which flashes the toolbar badge.
The roadmap brief said "fail closed with a toast". A toast can't be injected on
exactly those pages, which is why `feedback.ts` already falls back to the
badge. The brief is corrected, not met as written. When `palette.js`
injection is rejected on a page `isRestrictedUrl` didn't catch (the Web
Store, a PDF viewer), the palette path shows the same badge. **This is
palette-only.** `openPanel`'s silent `.catch`, shared by the panel's hotkey,
menu and cue, is deliberate (see its own comment) and stays unchanged.

### 4.3 The overlay

A new injected entry `palette-in-page.ts` → `palette.js`, with the pure render in
`palette-view.ts`, sitting in `src/palette/` beside `src/panel/`. It follows
the cue/toast pattern: the file sets `__nimbusPalette`, and a second
`executeScript` func calls it (a new `showPalette` in `src/browser/scripting.ts`).

- **Host and isolation:** `#nimbus-palette-host`, an open shadow root,
  `:host{all:initial}` and inlined CSS, max z-index, like the panel. Open, not
  closed, for the reason the cue gives: closed buys nothing against an
  isolated-world script's real attack, which is synthesised input. So **every
  key and pointer handler rejects `!event.isTrusted`.**
- **Host trust, and the toggle:** `__nimbusPalette` treats a host as its own
  only if that host carries the `__nimbusClose` expando that this module sets.
  An expando set from the extension's isolated world is not visible to page
  script, so a page that plants `<div id="nimbus-palette-host">` cannot forge
  one. Its own host means toggle: close and stop. Anything else under the id
  is removed (`querySelectorAll`, every match, as `cue-in-page.ts` does), and
  the palette mounts fresh. A planted decoy therefore cannot swallow the first
  press.
- **Placement:** top-centre, about 480px wide, 16px from the edge on narrow
  viewports. When the panel is open **at mount** it sits to the panel's left
  and never covers it. Checking once at mount is enough: anything that opens
  or closes the panel afterwards (a click on the cue, a context-menu pick, the
  panel hotkey) moves focus out of the palette, and that closes it.
- **ARIA:** the input is `role="combobox"` with `aria-controls` pointing to a
  `role="listbox"`; rows are `role="option"` with `aria-selected`; the input
  tracks the active row via `aria-activedescendant`. The container is
  `role="dialog"` with an `aria-label`.
- **Keys** (a pure reducer in `palette-view.ts`, so it is unit-testable):
  printable keys filter; `↑`/`↓` wrap through the enabled rows; `Enter` runs
  the active row; `Esc` closes. `Tab` is not trapped: it closes the palette,
  the same as focus leaving it. If the filter matches nothing, the listbox
  shows one disabled "No matching actions" row, `aria-activedescendant` is
  cleared, and `Enter` does nothing.
- **Pointer:** a click on a row runs it. The dialog calls `preventDefault()` on
  `pointerdown`, so the input keeps focus and the row is still in the DOM when
  `click` fires. Close-on-leave is a `focusout` handler that closes only when
  `relatedTarget` is outside the shadow root, not a bare `blur`.
- **Escape precedence:** the panel's Escape is a document-level capture
  listener. The palette's is a **window-level capture** listener, so it fires
  first, and it calls `stopImmediatePropagation()` and `preventDefault()`.
  One `Esc` closes the palette and leaves the panel open.
- **Focus on close** depends on how the palette closes:
  - **Dismissed** (Esc, Tab, focus leaving, the toggle): focus goes back to
    the page element that had it at mount, if that element is still
    connected.
  - **Quick clip:** the same, after the selection is restored (§4.5).
  - **Panel intent:** focus is **not** restored to the page. It would bounce
    page → panel, and focusing a page input can collapse the selection §4.5
    just restored. The panel takes focus instead (§6.2).
- **Lifetime:** closes on any of the above, on a run, or on a URL change (the
  cue's check). All listeners hang off one `AbortController`, and the host is
  removed on close.
- **No persistence:** no recent-actions list and no storage.

### 4.4 Rows and their order

Rows render in this order:

1. **Lanes**, in `AGENT_LANES` order, with the panel's own per-surface titles
   (see §5). **All of them wait for resolve, the glossary lane included**:
   before resolve the roster is unknown (`offered` is `null`, which fails
   open), so an early glossary row could vanish when a roster without it
   arrives. Until resolve lands, one disabled row reads "Looking up this
   page…". The glossary lane appears when the page has a selection, under the
   panel's own title (the quoted term), and there is no separate "Define" row.
2. **Deploy readiness** (instant, from `PaletteInit`), on `pr`/`build` with a
   scope and origin. It does **not** depend on the resolve outcome. The panel
   mounts the deploy section from the recognition alone, on every outcome
   from not paired to ambiguous, because `/v1/preflight/deploy` is tokenless.
3. **Related items** (instant, from `PaletteInit`), on every surface except
   `home`, as in the panel.
4. **Clip page**, **Clip selection** (instant). Clip selection is disabled,
   with the hint "Select some text first", when there is no selection.

The active row on open is the first enabled row. Before resolve that is
Deploy readiness or Related, and it moves to the first lane when the lanes
arrive, **unless the user has already pressed an arrow key or typed**. Rows
never jump under a user who is mid-choice, and resolve only ever **adds** rows
above the instant ones. It never removes one.

**Resolve states follow the panel exactly.** The lane rows are whatever
`visibleLanes` returns for the `LaneContext` the shared header adapter
derives (§5). Where the panel's header has no page lanes but shows a status
sentence, the palette adds **one disabled row carrying that same sentence**,
taken from the same shared derivation rather than re-worded. The ambiguous
state is the one case with a next step.

| Panel header | Lane rows | Extra row |
|---|---|---|
| resolved / service / chosen / file found | as the panel shows them | none |
| ambiguous, no pick | glossary only, if a term | **Pick the item in the panel** → `candidates` intent |
| ambiguous, truncated (the gateway sent no candidates) | glossary only, if a term | disabled, the panel's "Too many matches to choose from…" line; there is no picker to send anyone to |
| file, miss (`banner` set) | glossary only, if a term | disabled, the `banner` sentence |
| file, unsupported (older gateway, no `banner`) | glossary only, if a term | none (the panel says nothing either) |
| captured copy | glossary only, if a term | none (as the panel) |
| not-indexed | glossary only, if a term | disabled, the panel's "Not indexed." line |
| needs-scope / not paired / gateway down / error | glossary only, if a term | disabled, the panel header's wording |
| unrecognised (an ordinary article) | glossary only, if a term | none, so Related and Clip stay clean on normal pages |
| home with an unhealthy connector | none (the gate hides every agent lane, glossary included) | none |

### 4.5 The page selection survives the palette

Focusing the palette's input collapses the page selection. Two things still
read it from the page afterwards: `quick-clip` (`runCapture` reads
`window.getSelection()` in the page) and a freshly injected panel's mount
snapshot. So at mount the palette **saves the selection's `Range`s and text**,
and before it sends any message it **restores those ranges and removes its
host**.

The glossary row does **not** depend on the restore. It carries the text it
saved (§6.1), because an already-open panel never re-reads the selection. The
restore matters only for Clip selection and for a panel freshly mounted by a
page-lane intent. If the restore throws (the page mutated the range's nodes),
Clip selection fails the way a lost selection already does today: the
"Select some text first." toast.

## 5. One lane list, not two

This is the load-bearing refactor, and it ships **first, on its own, with no
behaviour change** (slice 1).

### 5.1 The pure pipeline

Pull the panel's "which lanes are visible, under which titles" into pure code
in `src/panel/lane-input.ts`:

```ts
visibleLanes(ctx: LaneContext):
  readonly { lane: AgentLane; title: string; canRun: boolean }[]
showsRelated(ctx: LaneContext): boolean   // false on home
```

- **Agent lanes only.** `visibleLanes` returns no `"related"` entry. Each caller
  places Related where its own layout wants it: the panel puts it first, the
  palette puts it after Deploy readiness.
- **`LaneContext` gains `connectorHealthy`** (from `gatePolicy`) rather than
  taking a second `gate` argument. `ctx.surfaceKind` already exists, and two
  surface parameters could disagree. On `home` with an unhealthy connector,
  `visibleLanes` returns nothing, **glossary included**. That is what `paint()`
  does today (it gates the whole `agentLanes` list), so parity keeps it. If
  glossary should escape that gate, that's a separate panel change, not this
  one.
- It also absorbs `LANE_TITLES`/`laneTitle` (moved out of `panel-in-page.ts`)
  and `laneCanRun`.

The `LaneContext` is derived by shared code too, not built twice. `pageSubject`
depends on the panel's header kind (`resolved`, `service`, `chosen`, a found
`file`; **not** `captured`, **not** `ambiguous`), so the resolve-response →
header derivation (`headerFrom`, the `laneContext()` assembly and the status
sentence of §4.4) moves into a pure module. `paint()` and the palette both go
response → header → context → `visibleLanes`. The parity test runs that one
pipeline over every `SURFACE_KINDS` × resolve outcome × term present/absent ×
chosen/none fixture and checks it against the panel's rendered lane list.

The palette sends its own `resolve` rather than borrowing the panel's, so
opening the palette and then picking a lane costs two loopback resolves. That
is accepted: resolve is a local index read with no egress, and sharing a
worker-side cache to save one would add state for no user-visible gain.

### 5.2 When a panel is already open

`panel.js` and `palette.js` run in the same isolated world, so the palette can
ask an open panel about itself. The panel host gains a second expando beside
`__nimbusClose`:

```ts
__nimbusPanelState(): { pinnedUrl: string; chosenId: string | null }
```

- **Panel open on this page** (`pinnedUrl === location.href`) **with a pick:**
  the palette passes that candidate into the header derivation (matched by id
  against its own resolve's candidates, and treated as no pick if it's no
  longer among them). Its lanes then match the open panel's, and it shows no
  "Pick the item" row for a page that has already been picked.
- **Panel pinned to a different URL** (an SPA navigation while it stayed open,
  the panel's `navAway` state): the palette lists lanes for the **current**
  page, so §6.2 has the panel catch up before it runs anything.

## 6. Delivering the choice to the panel

### 6.1 The panel hook generalises `__nimbusSelection`

`PanelSelection` and `__nimbusSelection` (`src/shared/panel-host.ts`) become
`PanelIntent` and `__nimbusIntent`:

```ts
type PanelIntent =
  | { kind: "selection"; text: string; intent: "define" | "related" }
  | { kind: "lane"; lane: AgentLane }  // page lanes; never "glossary"
  | { kind: "deploy" }
  | { kind: "related" }      // open / bring to front, focus Related
  | { kind: "candidates" };  // ambiguous: open at the picker
```

**The glossary row sends `{kind:"selection", text, intent:"define"}`**, with
the text the palette saved at mount. `applySelection(text, "define")` already
sets the term, opens the glossary lane and asks, and it behaves the same
whether the panel is open or freshly mounted. A `{kind:"lane"}` intent for
`glossary` is refused by the guard (§7).

`deliverSelection` in `scripting.ts` becomes `deliverIntent` with the same
"call the hook; on a miss inject `panel.js`, then call it again" sequence,
which is what keeps the toggle-close from firing. The existing `"define"` and
`"related"` context-menu paths go through it unchanged.

### 6.2 The panel applies an intent

- **Stale pin first.** If the panel's `pinnedUrl !== location.href` when an
  intent arrives, it calls `reread()` and parks the intent until the new
  page's header lands. A palette lane never runs against the page the panel
  happened to be pinned to.
- **`lane`:** set `laneOpen[lane] = true` and call `sendAgentRun(lane)`, the
  path a first expand takes. On a freshly mounted or re-read panel the header
  hasn't resolved yet, so the intent is **parked** and applied once
  `loadHeader` lands. If the lane is then not visible (the page or roster
  changed between the two resolves), the panel opens normally and runs
  nothing. It never sends a run for a lane it wouldn't show. If the lane is
  already running or done, it is expanded and scrolled to, not re-asked: the
  worker's run cache answers, and `laneInFlight` guards the double-send.
- **`deploy`:** scroll the deploy section into view. It already asks on mount.
- **`related`:** bring the panel to the front and focus Related. On `home`
  there is no Related lane, so it focuses the header instead. The palette
  never offers Related on `home` (§4.1), so this is a fallback, not a path.
- **`candidates`:** scroll to the candidate list. If a pick has been made in
  the meantime, so there is no list, it falls back to the header.

**Parked-intent lifetime.** There is at most one parked intent. A second
intent before the header lands replaces it (the last gesture wins; runs never
queue). `reread()` re-parks the current one, and `teardown()` drops it.

**Focus targets**, applied when the intent is applied, including when a parked
one is released. Until then the mount-time focus on the close button stands.

| Intent | Receives focus |
|---|---|
| `lane`, `selection` (define) | that lane's `<summary>` (`[data-lane="<id>"] .nimbus-related__lane-title`) |
| `related` | the Related lane's `<summary>` |
| `candidates` | the first candidate button |
| `deploy` | the deploy section's heading, made focusable with `tabIndex = -1`; it has no focusable control while it reads "Checking deploy readiness…" |
| any fallback above | the header |

### 6.3 Is an agent run on Enter acceptable?

Yes. It is the same gesture weight as the click-to-expand that asks today, and
the palette is opened by an explicit shortcut. Moving the highlight and
filtering spend nothing; only `Enter` (or a click on a row) asks.

## 7. Messages

Two new worker messages in `src/shared/messages.ts`, each with a guard:

- `PaletteIntentRequest {kind:"palette-intent", intent: PanelIntent}` →
  `deliverIntent(sender.tabId, intent)`.
- `QuickClipRequest {kind:"quick-clip", mode:"article"|"selection"}` →
  `quickClip(quickClipDeps, mode, sender.tabId)`.

**Both take the tab from `sender.tab.id`, never from the payload**, the rule
`cue-open` set, and both refuse a sender with no tab. A palette can only act
on the page it is drawn on.

The guard checks values at runtime, not only in the type, since narrow types
over wide runtime values are the bug class this repo keeps finding:

- `intent.kind` must be one of the five arms.
- `lane` must be in `AGENT_LANES`, and must **not** be the term lane.
- `selection.text` is raw text, as `PanelSelection` carries today, so the
  panel stays the one place that normalises a term and words its refusal. The
  guard enforces only a non-empty string of at most **8192 characters**. That
  is a size bound, not a term rule; it matches `MAX_LOOKUP_URL_LEN`'s order
  of magnitude and sits far above `MAX_TERM_LENGTH` (128).

In practice an over-long selection never reaches the guard. The palette's own
`LaneContext` runs `termStateFrom` on the saved text, so a refused term
already comes back from `visibleLanes` as `canRun: false`. The glossary row
then renders disabled, with the panel's own reason, and `Enter` cannot send
it. The 8192-character bound is the backstop for a palette that ever gets that
wrong.

## 8. Testing, and the gates that will fire

- **Unit:**
  - `palette-view.ts`: rows per surface × outcome, instant rows from
    `PaletteInit`, filter and the empty-filter row, the key reducer including
    wrap, disabled rows, and the no-jump and only-grow rules.
  - `visibleLanes` and header-pipeline parity (§5.1).
  - The message guards: a wrong `lane` string, `lane: "glossary"`, an
    oversized `text`, a missing tab.
  - The worker routes, `recognise` → `PaletteInit`, and the restricted-page
    badge.
  - `deliverIntent`, hook hit and miss.
  - The panel, in jsdom: the parked intent (park, replace, re-park on
    `reread`, drop on `teardown`), the stale-pin re-read, each focus target,
    and `__nimbusPanelState`.
  - Host trust: a planted decoy is removed and the palette mounts.
- **E2E:** a new `test/e2e/palette.e2e.ts` against the mock gateway. It opens
  the palette the way `helpers.ts`'s `togglePanel` opens the panel, injecting
  `palette.js` from `sw.evaluate`, because Playwright cannot fire
  `chrome.commands`. **No test seam is added to the worker.** It covers:
  - filtering;
  - running a lane, with the panel showing it asked;
  - glossary into an **already open** panel;
  - a lane with a candidate already picked in the open panel;
  - Esc precedence with the panel open;
  - clicking a row;
  - clip page, and clip selection surviving the palette's focus (§4.5).

  Its `COVERS` ids get matching `<!-- e2e:<id> -->` markers in
  `development.md` (`e2e-coverage.test.ts`). Command routing and the
  restricted-page badge are **unit-only**, and their `development.md` steps
  say so.
- **Gates this will trip, on purpose:** `build-artifacts.test.ts` (add
  `palette` to `ENTRIES` and `palette.js` to `REQUIRED_FILES`; no
  `HTML_CSS` entry, because injected scripts inline their CSS) and
  `manifest.test.ts` (assert the new command and its key).
- **Manual (human-only, in `development.md`):** that `Alt+Shift+K` actually
  binds on a fresh Chrome and Firefox profile, and that it reaches the
  extension on GitHub, Jira and Confluence, which have their own keyboard
  shortcuts. If it collides, change the key before release, not after.

## 9. Slices

1. **One lane list.** The header adapter (with its status sentence),
   `visibleLanes`, `showsRelated`, `connectorHealthy` on `LaneContext`,
   `LANE_TITLES` moved, and the parity test. No behaviour change, so the
   existing panel tests stay green untouched.
2. **The intent hook and the two messages.** `PanelIntent`, `deliverIntent`,
   the parked intent and its lifetime, the stale-pin re-read, the focus
   targets, `__nimbusPanelState`, `palette-intent` and `quick-clip`. This is
   testable with no palette: the panel's existing selection paths run through
   it.
3. **The palette.** Entry, command, `PaletteInit`, restricted-page badge,
   overlay, host trust, rows, keys and pointer, e2e, and docs:
   `architecture.md` section, `development.md` checklist, CHANGELOG,
   ROADMAP 3.1 status, README / `store/listing.md` hotkey lines, and the
   `ENTRIES` list in `CLAUDE.md`.

## 10. Later, not now

Rows that open extension pages (the DORA page for the bound service, briefs,
activity, Options), a recent-actions memory, and a "Rerun <lane>" row are all
cheap once the shape exists. They wait until the v1 list has been used and we
see what people reach for.

## 11. Left to the builder

The exact visual styling (it should match the panel's tokens), the
"Looking up…" and "No matching actions" copy, whether `visibleLanes` returns
titles or title keys, how the status sentence is shared with
`panel-view.ts`, and the internal module split under `src/palette/`.

## 12. Before this spec is pruned

Write into `docs/architecture.md`:

- the one-lane-list rule (§5.1);
- the open-panel state read (§5.2);
- the intent hook, parked-intent lifetime, stale-pin re-read and focus
  targets (§6);
- sender-derived tabs for the two new messages (§7);
- the worker-supplied `PaletteInit` and the only-grow rule (§4.1, §4.4);
- host trust by isolated-world expando (§4.3);
- the Escape precedence (§4.3);
- the four-suggested-keys ceiling (§3).

## 13. Review dispositions

From `2026-10-17-command-palette-design-review.md`. Each finding was checked
against `main` before it was accepted.

| # | Finding | Disposition |
|---|---|---|
| 1.1 | Glossary as a `lane` intent fails on an already-open panel | **Fixed** as suggested: the glossary row sends a `selection`/`define` intent (§6.1). Verified: the panel reads the selection only in `mount()`. |
| 1.2 | Instant Related can't know about `home` before resolve | **Fixed, different mechanism** (§4.1): the worker runs `recognise` in the gesture and hands it over as `PaletteInit`, so instant rows are exact from the first frame. Neither suggested option was taken. The first accepts a disappearing row; the second makes Related wait on a loopback call it doesn't need. |
| 1.3 | Instant glossary vs. the roster gate | **Fixed** (§4.4): glossary waits for resolve with the other lanes. Verified: `lanesFor` checks `offered` before the term arm, and `offered` is `null` pre-resolve. |
| 1.4a | Open panel with a picked candidate | **Fixed** (§5.2): `__nimbusPanelState` exposes `chosenId`, and the palette feeds it into the shared derivation, so parity now includes the pick. |
| 1.4b | Open panel pinned to an old SPA URL | **Fixed** (§6.2): the panel re-reads and parks the intent when `pinnedUrl !== location.href`. A new anti-goal names the failure. |
| 2.1 | `visibleLanes` order, duplicated `surfaceKind`, `LaneId` | **Fixed** (§5.1): agent lanes only, Related placed by the caller, `connectorHealthy` on `LaneContext`, `AgentLane`. On the home gate, **strict parity is kept**: it hides glossary too, as `paint()` does today. Changing that is a panel decision outside this spec. |
| 2.2.1 | Deploy readiness across resolve outcomes | **Fixed** (§4.4): instant and outcome-independent. Verified in `appendDeploySection`, which is gated only on `pinnedRecognition`. |
| 2.2.2 | `file` miss vs. unsupported | **Fixed** (§4.4 table): the miss shows its `banner`; unsupported shows nothing, as the panel does. |
| 2.2.3 | Unrecognised vs. not-indexed copy; fetch | **Fixed** (§4.4 table, §2): unrecognised shows no extra row; not-indexed reuses the panel's sentence; fetch is an explicit v1 non-goal. The plan review later corrected the quoted copy: the panel says "Not indexed.", which is what the table now quotes. The same review added the truncated-ambiguous row. |
| 2.3 | Planted host defeats the toggle | **Fixed** (§4.3): a host counts as the palette's own only if it carries the module's expando, which page script can't see or forge; decoys are removed. **Deferred, out of scope:** the panel's own self-toggle (`panel-in-page.ts`, the tail `getElementById` check) has the same gap. A planted `#nimbus-related-host` makes the first press remove it and not open. That's a pre-existing panel defect, worth its own small fix rather than riding in this feature. |
| 2.4.1 | `blur` tears down before `click` | **Fixed** (§4.3): `preventDefault` on `pointerdown`, and `focusout` with a `relatedTarget` check. |
| 2.4.2 | Focus bouncing through the page | **Fixed** (§4.3): no page-focus restore on a panel intent. |
| 2.4.3 | Focus target per intent | **Fixed** (§6.2 table), including `tabIndex = -1` on the deploy heading. |
| 3.1 | Panel opened or closed while the palette is up | **Confirmed, no change to behaviour**: the check at mount is enough, and §4.3 now says why. |
| 3.2 | Empty filter | **Fixed** (§4.3). |
| 3.3 | Selection cap | **Fixed** (§7): 8192 characters, with the over-long case disabled before it can be sent. One correction: the review places `termStateFrom` "via `visibleLanes`". It runs while the palette builds its `LaneContext`, and `visibleLanes` only reads the result. |
| 3.4 | Parked-intent lifetime | **Fixed** (§6.2), with one refinement: `reread()` **re-parks** the intent rather than clearing it. The stale-pin path of 1.4b depends on the intent surviving a re-read. |
