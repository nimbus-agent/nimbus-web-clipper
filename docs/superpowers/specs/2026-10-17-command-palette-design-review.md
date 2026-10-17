# Review: 3.1 — The Command Palette (`2026-10-17-command-palette-design.md`)

**Reviewed against:** `2026-10-17-command-palette-design.md` and current `main` (`src/panel/`, `src/background/`, `src/browser/`, `src/shared/`, `src/manifest/`).

Overall, the spec is tight, well-scoped, and fits the extension's architecture and security invariants (trusted-event gates, sender-derived `tabId`, no new permissions, four-command ceiling, and single-source lane derivation). Below are the open questions, edge cases, and concrete improvements found when tracing the design against the existing implementation.

---

## 1. High-Impact Bugs & Architectural Tensions

### 1.1 Glossary intent fails when the panel is already open (§4.5, §6.1, §7)
- **What the spec says (§7):** *"A glossary row sends `{kind:"lane", lane:"glossary"}`. The panel takes the term from its own mount snapshot, which sees the selection because §4.5 restored it."*
- **What the code does (`src/panel/panel-in-page.ts:2163`):** The panel reads `window.getSelection()` **only once, inside `mount()`**.
- **The bug:** If the panel is **already open** when the user selects text on the page, opens the palette, and runs the glossary row:
  1. `deliverIntent` hits the existing panel's `__nimbusIntent` hook (`callIntentHook` returns `true`, so `mount()` does not run).
  2. The open panel still has `term = { kind: "none" }` (or a stale term from when the panel originally mounted).
  3. Receiving `{ kind: "lane", lane: "glossary" }` calls `sendAgentRun("glossary")`, which immediately bail-outs on `!laneCanRun("glossary", laneContext())` (`lane-input.ts:131`), and `lanesFor` doesn't even render the glossary lane because `term.kind === "none"`.
- **Suggestion:** Have the palette's glossary row send `{ kind: "selection", text: savedSelectionText, intent: "define" }` (which `PanelIntent` in §6.1 already supports via `applySelection(text, "define")`), rather than `{ kind: "lane", lane: "glossary" }`.
  - That works identically whether the panel is already open or freshly mounted.
  - It also removes the fragility of `Selection.addRange()` throwing if the host page mutated the DOM while the palette was open (DOM selection restoration in §4.5 is then only needed for `quick-clip` selection and ambient mount snapshots when a *page* lane is chosen).

### 1.2 Instant `Related items` row on a `home` surface before `resolve` settles (§2, §4.4)
- **What the spec says (§4.4):** *"instant rows: Related · Clip page · Clip selection"* and *"3. Related items (instant), on every surface except `home`, as in the panel."*
- **What the code does:** Page recognition (`recognise()`) runs in the service worker because self-hosted origins (`getOrigins()`) live in `chrome.storage`. Content scripts do not know `surfaceKind` until the `resolve` (or `recognise`) response arrives from the worker.
- **The tension:** At mount time (before `resolve` returns), the palette cannot know that the current tab is a `home` surface (e.g., a GitHub/Jira/Jenkins dashboard).
  - If `Related items` is rendered instantly on mount, it will appear on `home` dashboards as the active first row and then **vanish** when `resolve` lands — violating the no-jump feel and, if the user presses `Enter` quickly, sending `{ kind: "related" }` to a panel that does not render a Related lane on `home` (tripping Anti-goal 1).
- **Suggestion:** Either:
  1. Show `Related items` on mount as specified, but if the user triggers `{ kind: "related" }` on a `home` surface before `resolve` settled, treat `{ kind: "related" }` as "just open / focus the panel header" (which §6.1's comment `// just open / bring to front` already hints at, whereas §6.2 says *"scroll to the related lane"*), **and** document that `Related` disappearing on `home` when `resolve` lands is an accepted exception if the user hasn't navigated onto it; or
  2. Wait for `resolve` (which is a local loopback call) before enabling `Related`, or run the lightweight `{ kind: "recognise" }` if needed. (Option 1 with a graceful fallback in §6.2 when the Related lane is absent on `home` is simpler.)

### 1.3 Instant `glossary` row vs. the gateway's `offeredLanes` roster gate (§2, §4.4)
- **What the spec says (§4.4):** The glossary row is listed under *"instant rows"* when a selection exists, before `resolve` lands.
- **The tension:** `lanesFor` (`src/panel/lane-input.ts:94`) checks `ctx.offered !== null && !ctx.offered.includes(lane)` **before** checking `LANE_RULES[lane].input === "term"`. Before `resolve` returns, `offered` is `null` (fail-open), so `glossary` is shown. If `resolve` then returns an `offeredLanes` roster that omits `"glossary"`, the instant glossary row will disappear mid-session (or fail to appear in the panel if selected before `resolve` lands).
- **Suggestion:** Either wait for `resolve` before showing `glossary` (grouping it with the other agent lanes behind `"Looking up this page…"`), or explicitly note that `glossary` starts with `offered: null` and is pruned on `resolve` if the gateway roster excludes it.

### 1.4 State drift when the panel is already open (`chosen` candidate and SPA `navAway`) (§5, §6.2)
Two cases where an already-open panel and the palette will disagree:
1. **Candidate already picked on an `ambiguous` page (§5):**
   - §5 states: *"The panel passes it the candidate it has picked, if any; the palette always passes none."*
   - If the user already opened the panel on an ambiguous page and clicked a candidate (`chosen !== null`), the panel is currently showing all the page lanes (`What breaks if it lands`, etc.). Opening the palette next to that open panel will show **no lanes** and only *"Pick the item in the panel"* — violating Goal 2 (*"The list is **exactly** what the panel would offer on this page"*). Worse, picking *"Pick the item in the panel"* sends `{ kind: "candidates" }`, but `.nimbus-related__candidates` is no longer rendered in the panel once `chosen !== null`.
2. **Open panel pinned to an old SPA URL (`navAway`) (§6.2):**
   - `panel-in-page.ts` pins `pinnedUrl = window.location.href` at mount. If the user navigates to a new PR in the same SPA tab while the panel stays open (`navAway === true`), and then invokes the palette, the palette resolves the **current** `window.location.href`, whereas `deliverIntent` hands `{ kind: "lane", lane }` to the **old** panel still pinned to the previous PR (`sendAgentRun` sends `pageUrl: pinnedUrl`).
- **Suggestion:**
  - Since `panel.js` and `palette.js` execute in the same isolated content-script world and share the DOM (`#nimbus-related-host`), the panel can expose a lightweight read (or include it on `#nimbus-related-host`) for `{ pinnedUrl, chosen }`, **or**:
  - If the open panel's `pinnedUrl === window.location.href`, the palette can read the open panel's `chosen` candidate so its lane list matches the open panel;
  - If the open panel's `pinnedUrl !== window.location.href`, `applyIntent` in the panel should run `reread()` first and park the incoming intent until the new page's `loadHeader()` settles, so the panel never runs a lane against a stale pinned URL when summoned from the current page's palette.

---

## 2. Design & Refactor Clarifications (§4, §5, §6)

### 2.1 `visibleLanes` ordering vs. palette row ordering (§4.4 vs. §5)
- **What the spec says:**
  - §4.4 orders palette rows as: **(1) Agent lanes** → **(2) Deploy readiness** → **(3) Related items** → **(4) Clip page / Clip selection**.
  - §5 says `visibleLanes` returns `readonly { lane: LaneId | "related"; title: string; canRun: boolean }[]` and *"absorbs `lanesFor`, the Related prepend, the `home` connector gate, `LANE_TITLES`/`laneTitle`… and `laneCanRun`"*.
  - In `src/panel/panel-in-page.ts:1544`, the panel renders **`related` first**, followed by `agentLanes`, followed by `appendDeploySection`.
- **The tension:**
  - If `visibleLanes` prepends `"related"` at the front (for the panel), the palette cannot use `visibleLanes`'s order directly because `"related"` sits *after* `Deploy readiness` in the palette (and renders before `resolve` settles).
  - Also, on `surfaceKind === "home"` when `connectorHealthy === false`, `panel-in-page.ts:1539` currently suppresses all `agentLanes` — **including `glossary`** if text is selected on a home dashboard. Confirm whether `visibleLanes` should keep that exact suppression (for strict panel parity) or let `term` lanes bypass the `home` connector gate (matching `lanesFor`'s doc comment that a `term` lane depends only on `term`).
- **Suggestion:**
  - Keep `visibleLanes` focused on `AgentLane`s (or return `{ agentLanes, showRelated }` / keep `related` position caller-controlled) so the panel can place `Related` at the top while the palette places `Related` below `Deploy readiness`.
  - Avoid duplicating `surfaceKind` in `visibleLanes(ctx: LaneContext, gate: { surfaceKind; connectorHealthy })` — `ctx` already carries `surfaceKind: SurfaceKind | null` (`src/panel/lane-input.ts:49`). Passing `connectorHealthy: boolean` (or `connector: ConnectorHealth | null`) on `LaneContext` itself avoids a second parameter that could disagree with `ctx.surfaceKind`.
  - Minor naming note: the codebase type is `AgentLane` (`src/shared/types.ts:25`), not `LaneId`.

### 2.2 Completeness of the Resolve-State Table (§4.4)
Comparing the table in §4.4 against `HeaderState` in `src/panel/panel-view.ts` and `headerFrom` in `src/panel/panel-in-page.ts` leaves a few states underspecified:

1. **Deploy readiness across resolve failures/misses:**
   - In `panel-in-page.ts:1450` (`appendDeploySection`) and `1624`, `pinnedRecognition` is recorded from `res.recognition` **even when `!res.ok`** (e.g., `needs-scope`, `not_paired`, `unreachable`) or when the item is `not-indexed` / `ambiguous` / `captured`. Because `/v1/preflight/deploy` is a tokenless public endpoint, the panel shows Deploy readiness on any recognised `pr` or `build` with `scope` and `origin`, regardless of resolve outcome.
   - **Question:** Should the palette likewise offer the **Deploy readiness** row whenever `res.recognition.ok && deployBelongsOnSurface(res.recognition.kind) && res.recognition.scope && res.recognition.origin`, even if `res.ok === false` or `outcome.kind === "not-indexed"`? (It should, to preserve strict parity with `appendDeploySection`.)
2. **Recognised `file` surface when the file probe misses or is unsupported (`src/panel/panel-in-page.ts:547–553`):**
   - `file` + `found`: `pageSubject` is `true`, page lanes show.
   - `file` + `miss` (`remote_not_tracked` or `file_not_indexed`): `header` is `{ kind: "file", surface, banner }`, `pageSubject` is `false`. Does the palette show a disabled extra row with `banner`?
   - `file` + `unsupported` (gateway older than `/v1/items/resolve-file`): `header` is `{ kind: "file", surface }` with **no `banner`** and `pageSubject: false`. What should the palette's extra row say here (or should there be no extra row, matching "roster offers nothing")?
3. **Unrecognised page (`kind: "unrecognised"`) vs. recognised miss (`kind: "not-indexed"`):**
   - On an ordinary web article (e.g. a blog post on `example.com`), `header.kind` is `"unrecognised"`. Does the palette show a disabled row (`"Not a recognised Nimbus surface."`) above `Related` / `Clip page`, or `none` so clipping/related on normal web pages stays clean?
   - On `not-indexed`, `panel-view.ts` renders `"Not in your Nimbus index yet."` (when `fetchable: true`) or `"Not in your Nimbus index."` (when `fetchable: false`). Confirm that this status sentence is the disabled extra row's copy, and that a palette `fetch` intent is intentionally out of scope for v1 (since targeted fetch is an I13 write behind a confirm preview).

### 2.3 Host-Element Trust & Self-Toggle Mechanics (§4.3)
- **Decoy host elements:** `cue-in-page.ts:4–7` and `toast-in-page.ts` guard against a hostile page pre-planting `<div id="nimbus-cue-host">`. By contrast, `panel-in-page.ts:2190` checks `document.getElementById(HOST_ID)` and, if found, removes it and exits (toggling off). If `palette-in-page.ts` uses the two-step `showPalette` (`executeScript({ files: ["palette.js"] })` + `executeScript({ func: () => __nimbusPalette() })`) and checks `document.getElementById("nimbus-palette-host")` to decide whether to toggle closed, a page that plants `<div id="nimbus-palette-host">` will cause the first shortcut press to remove the decoy and not open the palette.
- **Suggestion:**
  - Have `showPalette` either behave like `injectPanel` (single `executeScript({ files: ["palette.js"] })` self-toggling entry) or, if using `__nimbusPalette()`, only toggle-close when the existing `#nimbus-palette-host` carries the authentic closure hook (e.g. a module-known `WeakSet` or unforgeable Symbol/closure reference, or `__nimbusClose` function), and otherwise remove all `document.querySelectorAll("#nimbus-palette-host")` decoys and mount fresh (matching `cue-in-page.ts:96`).

### 2.4 Mouse Click vs. `blur`-to-Close, and Focus Handoff (§4.3, §4.5, §6.2)
1. **Clicking a palette row blurs the input before `click` fires:**
   - §4.3 states that the palette closes on `blur` and that click handlers run rows. In browsers, pressing the mouse button (`mousedown` / `pointerdown`) on a `role="option"` row inside the listbox blurs the `<input role="combobox">` **before** `mouseup` and `click` fire. If the input's `blur` listener tears down the host synchronously, the row is removed from the DOM on `mousedown` and the `click` handler never fires.
   - **Suggestion:** Call `event.preventDefault()` on `mousedown` on the palette dialog/listbox (so clicking an option keeps focus on the combobox input until the action runs), or gate close-on-blur using `focusout` checking `! root.contains(event.relatedTarget)`.
2. **Focus restoration order when running a panel intent (§4.3 vs. §6.2):**
   - §4.3 says: *"Focus moves to the input on mount and goes back to the previously focused page element on close."*
   - §6.2 says: *"In every case the chosen lane or section gets keyboard focus, so the keyboard-only path continues into the answer."*
   - **Suggestion:** Only restore focus to the previously focused page element when the palette is **dismissed** (`Esc`, `Tab`, blur, toggle-close) or runs a **quick-clip**. When the palette closes to run a **panel intent**, skip focusing the old page element (or only restore selection ranges) so focus doesn't bounce `palette → page input (which can collapse the restored selection!) → panel`.
3. **Focus target inside the panel for each intent (§6.2):**
   - `mount()` in `panel-in-page.ts:2169` currently calls `close.focus()` synchronously, and `loadHeader()` resolves asynchronously later.
   - Specify what element receives focus for each `PanelIntent` once applied (including after a parked intent unparks on `loadHeader`):
     - `lane` / `related`: the `<summary class="nimbus-related__lane-title">` inside `[data-lane="<id>"]`.
     - `candidates`: the first `<button class="nimbus-related__candidate">` inside `.nimbus-related__candidates`.
     - `deploy`: `.nimbus-deploy-section` (which currently has no focusable heading unless the bind `<input>` or DORA `<button>` is rendered — give the section heading `tabIndex = -1` or focus the section container with `tabIndex = -1` while `"Checking deploy readiness…"` is loading).

---

## 3. Smaller Questions & Suggestions

1. **Closing the palette if the panel is toggled or closed while both are open (§4.3):**
   - §4.3 places the palette to the left of an open panel (`right: 356px` instead of `top-centre` when `#nimbus-related-host` is present). What if the panel opens or closes while the palette is already mounted (e.g., an ambient cue or context menu opens the panel), or is checking `document.getElementById(PANEL_HOST_ID) !== null` once at palette mount sufficient because any outside click/hotkey blurs and closes the palette anyway? (Checking at mount is almost certainly sufficient, worth one sentence confirming.)
2. **Empty filter state (§4.3 / §4.4):**
   - When the user types a substring that matches zero rows, what does the listbox render? A single disabled status row (e.g., `"No matching actions"`) with `aria-activedescendant=""` so `Enter` is a no-op?
3. **Selection byte cap vs. `MAX_TERM_CHARS` (§7, §11):**
   - In `src/shared/term.ts`, `normaliseTerm` already defines the term length limit, and `src/shared/messages.ts` uses `MAX_LOOKUP_URL_LEN = 8192` for URL bounds. If `PanelIntent`'s `selection` arm is only ever used for `define` and `related` (not full-article clipping, which goes through `quick-clip`), a cap like `4096` or `8192` characters in `isPanelIntent` is plenty and keeps oversized page selections from crossing the message guard; if a user selects 50 KB of text on a page, the palette shouldn't send a 50 KB `selection` intent that the worker guard then drops silently. Instead, the palette already runs `termStateFrom(rawSelection)` locally (via `visibleLanes`), so when `term.kind === "refused"`, the glossary row is already `canRun: false` (disabled in the palette!) and cannot be submitted on `Enter` in the first place.
4. **Parked intent lifetime in `panel-in-page.ts` (§6.2):**
   - Make sure `reread()` and `teardown()` clear any parked `pendingIntent`, and that a second `deliverIntent` arriving before `loadHeader()` finishes overwrites the parked intent (last user gesture wins) rather than queueing multiple runs.
