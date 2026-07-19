# Quick-Clip Entry Points — Design

**Date:** 2026-07-19
**Status:** Approved (brainstorming) — ready for implementation plan

## Goal

Let a user clip the active tab **without opening the toolbar popup**, via two new
entry points — a right-click **context menu** and rebindable **keyboard
shortcuts** — for both "clip page" and "clip selection". Both funnel through the
same capture → clip → offline-queue path the popup already uses, and confirm the
result with a lightweight in-page **toast** (with a toolbar-badge fallback on
pages where a script can't be injected).

## Non-goals

- **Link / image / target-page clipping** (right-click a link → clip *that* page).
  It would require fetching an arbitrary URL, which the loopback-only
  `host_permissions` posture forbids. Out of scope.
- **Tag entry on quick-clip.** Quick-clips are tagless (fuss-free); tagging stays
  a popup feature.
- **Configurable toast** (position, duration, opt-out) and **system
  notifications** (would need the `notifications` permission).
- **Changing the gateway HTTP contract.** This is client-only, using the existing
  `POST /v1/clips`.

## Constraints (non-negotiable)

- **Locked contract.** Only `POST /v1/clips`, `/pair/confirm`, `/related`. Quick
  clips use `POST /v1/clips` exactly like popup clips.
- **Loopback-only.** No new `host_permissions`; the only network destination
  stays `127.0.0.1` / `localhost`.
- **The bearer token is the only secret** — never logged, never placed in the
  page DOM. The injected toast shows only clip status + the page's own title.
- **XSS-safe injection.** The toast is built with `textContent` only — no
  `innerHTML`, no anchor/`href`, mirroring the panel's backstop. It lives in a
  shadow root so page CSS can't interfere.
- **TypeScript strict, no `any`; no `console.*` in `src/`; Biome clean.**

## Architecture

The background service worker owns both new triggers and performs the whole clip
itself (the popup is not involved). Today the popup does the capture front-half
(`activeTab` → `runCapture` → `buildClipPayload`) and sends a `clip` message that
`handleClip` turns into `POST /v1/clips` (+ offline-enqueue on failure). Quick-clip
**reuses both halves** so behavior is identical:

```
quickClip(mode):                         # runs in the service worker
  tab     = activeTab()                  # browser/tabs seam
  capture = runCapture(tab.id, mode)     # browser/scripting seam — same capture-in-page as popup
  payload = buildClipPayload(capture, [])# shared/clip.ts — quick-clips carry no tags
  result  = handleClip(payload, deps)    # background/handlers.ts — POST + offline queue, unchanged
  showFeedback(tab.id, result)           # toast, or badge fallback
```

- **`background/quick-clip.ts`** (new) — pure `quickClip(mode, deps)` with injected
  dependencies (`activeTab`, `runCapture`, `handleClip`, `showFeedback`) so it is
  unit-testable with no real `chrome`. Returns nothing; side effects are the clip
  and the feedback.
- **Selection mode** re-runs the in-page capture (`window.getSelection()` via
  `capture-in-page`), **not** the context-menu `info.selectionText`, so a
  context-menu selection clip is byte-identical to a popup selection clip
  (readable body, title, canonicalUrl).
- The capture front-half (`activeTab` + `runCapture` + `buildClipPayload`) is
  identical to the popup's `clip()`. Extract it into a shared helper
  (e.g. `captureForClip(mode, deps)` in `shared/clip.ts` or a small
  `background`/`capture` module) used by **both** the popup and `quickClip`, so
  there is one capture path, not two. (The popup keeps sending a `clip` message;
  `quickClip` calls `handleClip` directly — same back-half either way.)

## Entry points

### Context menu (`contextMenus` permission)

Registered idempotently by the SW on `runtime.onInstalled` (and re-created on
startup to survive SW restarts):

- **`clip-page`** — title "Clip page to Nimbus", `contexts: ["page"]`.
- **`clip-selection`** — title "Clip selection to Nimbus", `contexts: ["selection"]`
  (Chrome shows it only when text is selected).

A right-click on selected text shows "Clip selection"; a right-click on the page
(no selection) shows "Clip page". `contextMenus.onClicked` maps the clicked
`menuItemId` → `quickClip("article" | "selection")`.

### Keyboard commands (`commands`)

Rebindable at the browser's extension-shortcuts page:

- **`clip-page`** — default `Alt+Shift+C` → `quickClip("article")`.
- **`clip-selection`** — default `Alt+Shift+S` → `quickClip("selection")`.
- Existing **`show_related`** = `Alt+Shift+R` — unchanged.

`commands.onCommand` (via the existing `browser/runtime` `addCommandListener`)
routes the command name to `quickClip`.

## Feedback: the toast

A tiny injected toast, mirroring the related-panel injection pattern:

- **`capture/toast-in-page.ts`** (new injected entry, bundled to `toast.js`) —
  self-contained script that exposes `globalThis.__nimbusToast(state)`; mounts a
  shadow-root host in the corner, renders the toast via a pure view, and
  auto-dismisses after ~2.5s (removing the host).
- **`capture/toast-view.ts`** (new pure module) — `renderToast(doc, state)` builds
  the toast DOM with **`textContent` only**; unit-tested in jsdom for all states.
- The SW shows it with the same two-step `executeScript` pattern as `runCapture`:
  inject `toast.js`, then `executeScript(func: (s) => __nimbusToast(s), args: [state])`.

**States** (`FeedbackState`):
- **saved** → "Clipped to Nimbus ✓" + the clip's title (truncated).
- **offline** → "Offline — saved to retry queue" (matches the offline-queue result).
- **error** → mapped from the clip error, e.g. not-paired → "Pair a browser first
  (Options)", unreachable handled as offline, otherwise "Couldn't clip this page".
- **empty-selection** (a client-side guard, not a clip result) → "Select some text
  first."

**Badge fallback.** On restricted pages where injection fails (`chrome://`, the
Chrome Web Store, the PDF viewer) — where capture also can't run — `showFeedback`
catches the inject error and flashes the toolbar badge (`✓` on success, `!` on
error) for ~1.5s, then restores the offline-queue count badge via the existing
`syncQueueState`.

## Manifest / permissions

- **`permissions`** += `contextMenus` (justification for the store: "Adds
  right-click 'Clip to Nimbus' menu entries"). No new host permissions;
  loopback-only preserved. No `notifications`.
- **`commands`** += `clip-page`, `clip-selection` with the default keys above.
- **`web_accessible_resources`** — `toast.js` is injected by the extension via
  `scripting.executeScript({ files: ["toast.js"] })`, same mechanism as
  `panel.js`/`capture.js`; it does not need to be web-accessible (matching the
  existing injected scripts).
- `esbuild.mjs` gains a `toast` entry (→ `dist/<target>/toast.js`);
  `scripts/check-build.mjs` asserts it is present in each target.
- `store/listing.md` gains the `contextMenus` justification (the listing↔manifest
  parity test enforces one justification per permission).

## Browser seam

- **`browser/context-menus.ts`** (new) — the thin typed seam over
  `chrome.contextMenus`: `createMenu(item)`, `removeAllMenus()`, and
  `addMenuClickListener(fn)`. The only place `chrome.contextMenus.*` is touched,
  keeping SW logic unit-testable.
- `browser/runtime.ts` `addCommandListener` already exists — reused for the two
  new commands.

## Error handling / edge cases

- **Not paired** → `handleClip` returns the not-paired error; toast "Pair a
  browser first (Options)". Nothing is queued (no token, no payload to retry).
- **Gateway unreachable** → `handleClip` enqueues (existing offline queue); toast
  "Offline — saved to retry queue"; the badge count updates as today.
- **Restricted page** (no injectable content) → toast inject throws → badge
  fallback.
- **"Clip selection" with no selection** → `capture` yields an empty selection;
  `quickClip` short-circuits to the empty-selection toast (no clip sent).
- **Rapid double-trigger** (double hotkey / menu) → the existing dedup-by-URL on
  `POST /v1/clips` (`created`/`updated`) and the queue single-flight guard make a
  repeat idempotent.
- **SW asleep on hotkey** → the command/menu event wakes the SW (MV3); `quickClip`
  re-reads the connection via `getConnection` as the message path already does.

## Testing

**Unit (Vitest + the chrome-mock harness):**
- `quick-clip.ts` — `quickClip` with injected deps: saved, offline-enqueue,
  not-paired, empty-selection, and inject-fails→badge paths; asserts it calls
  `handleClip` with the right payload and `showFeedback` with the mapped state.
- `toast-view.ts` — `renderToast` in jsdom for each state: correct text, no
  `innerHTML`/anchors (XSS backstop), markup-in-title stays inert.
- SW wiring — `commands.onCommand` routing (`emitCommand`) and
  `contextMenus.onClicked` routing map ids/commands → the right `quickClip(mode)`;
  menu registration on install is idempotent (via a `contextMenus` mock added to
  the harness).
- `browser/context-menus.ts` seam — registers/forwards the real `chrome.*` calls.
- `manifest.test.ts` — `contextMenus` permission present; `clip-page` /
  `clip-selection` commands present with keys; both targets.
- `store-listing.test.ts` — parity holds with the new `contextMenus` justification.

**Build/manual:**
- `check-build.mjs` asserts `toast.js` in `dist/chrome` and `dist/firefox`.
- `development.md` checklist: hotkey + right-click "clip page" and "clip
  selection" on a normal page (saved toast), with the gateway down (offline
  toast), on a `chrome://` page (badge fallback), and while unpaired (pair
  prompt).

## File structure

- **Create:** `src/background/quick-clip.ts`, `src/browser/context-menus.ts`,
  `src/capture/toast-in-page.ts`, `src/capture/toast-view.ts`; the matching
  `test/unit/*.test.ts`.
- **Modify:** `src/manifest/manifest.ts` (permission + commands),
  `src/background/service-worker.ts` (wire menu/command → `quickClip`, register
  menus), `src/shared/clip.ts` or a small helper (shared `captureForClip`),
  `src/popup/popup.ts` (use the shared capture helper — behavior unchanged),
  `esbuild.mjs` (`toast` entry), `scripts/check-build.mjs` (assert `toast.js`),
  `store/listing.md` (justification), `CHANGELOG.md`.
