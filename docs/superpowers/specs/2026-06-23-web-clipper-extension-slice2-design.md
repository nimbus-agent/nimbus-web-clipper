# Web Clipper Extension — Slice 2 (Related-items sidecar) Design Addendum

**Date:** 2026-06-23
**Status:** Approved (brainstorm) — ready for implementation plan
**Repo:** `nimbus-agent/nimbus-web-clipper` (this repo)
**Parent spec:** [`2026-06-23-web-clipper-extension-design.md`](./2026-06-23-web-clipper-extension-design.md) (§ "Slice 2 — Related-items sidecar")
**Upstream contract:** locked by Nimbus PR #718 (`POST /v1/clips/related`)

## Summary

An on-demand, in-page **Shadow-DOM sidecar** that surfaces related indexed items
for the current page. The user opens it from a "Show related" button in the clip
popup **or** a keyboard shortcut; a bundled `panel.js` is injected into the active
tab, reads the page context (title, canonical URL, current selection), and asks
the background service worker to query `POST /v1/clips/related`. The panel renders
the returned `RelatedHit[]`. It is **inbound-read** over loopback only; the bearer
token never leaves the service worker.

This addendum builds on Slice 1 (shipped): the `src/browser/` seam, the typed
message envelope, `gateway-client`, the connection store, and the
`capture.js`-style separate-injected-entry pattern all already exist.

## Goals

- Open a related-items panel **on demand** for the current page — never on page load.
- Query with the page `title` + `canonicalUrl` + any current text `selection`
  (selection is the primary query; the gateway de-prioritizes the page's own host).
- Render each `RelatedHit` (title, service badge, snippet, link), rendering a
  `url:null` hit as plain text.
- Reuse the load-bearing invariants: token + all gateway I/O in the SW; loopback
  only; on-demand injection (no declared `content_scripts`).

## Non-Goals

- Live re-query on selection change or a manual refresh control — **query once on
  open** (close + reopen to re-run). A refresh affordance may be a later slice.
- Click-outside dismissal — closing is via the trigger (toggle), an X button, or Esc.
- Persisting panel state / results across navigations or reloads.
- Any new gateway endpoint or contract change (`/v1/clips/related` is locked).
- Showing "already clipped" status or prior tags (deferred — needs a new gateway read).

## The locked HTTP contract (do NOT redesign)

| Route | Auth | Request body | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /v1/clips/related` | `Authorization: Bearer <token>` | `{ title?, canonicalUrl?, selection?, limit? }` | `200 { items: RelatedHit[] }` | `401 {error:"unauthorized"}` · `400 {error:"invalid_json"}` |

`RelatedHit = { id: string; title: string; service: string; snippet: string; url: string | null }`
— `url` is **nullable**; a URL-less hit renders as plain text.

`shared/gateway.ts` already exposes the path: `CLIP_PATHS.related = "/v1/clips/related"`,
so `endpointUrl(origin, "related")` is used unchanged.

## Interaction model (resolved at brainstorm)

1. **Trigger:** a "Show related" button in the clip popup **and** a `chrome.commands`
   hotkey (`show_related`, suggested `Alt+Shift+R`). Both inject `panel.js` into the
   active tab. (The toolbar button itself is already taken by the Slice-1 clip popup;
   in MV3 an action either opens a popup or fires `onClicked`, not both — hence a
   separate trigger.)
2. **Placement:** a right-edge overlay mounted in a Shadow DOM.
3. **Toggle / dismiss:** re-invoking the trigger **closes** the panel; an X button
   and the **Esc** key also close it. Clicking elsewhere on the page does **not**
   dismiss it.
4. **Query timing:** the context is captured **once on open** and queried once.

## Architecture

### Delivery & toggle

`src/panel/panel-in-page.ts` is its **own esbuild entry** bundled to a standalone
`dist/<target>/panel.js` (the fourth entry alongside `background`/`popup`/`options`/
`capture`). It is injected with
`chrome.scripting.executeScript({ target:{ tabId }, files:["panel.js"] })`.

`panel.js` is **self-toggling and stateless** — no open/closed state is tracked in
the SW; re-injection *is* the toggle:

- On run, look for the host element `#nimbus-related-host` on `document.documentElement`.
- **Present** → tear down (see below) and return → toggle-closed.
- **Absent** → create the host + a Shadow root, mount the overlay in the loading
  state, read the page context, and message the SW.

**Teardown via `AbortController`.** Mounting creates one `AbortController`; every
page/document listener (the X button, the document `keydown`) is registered with
`{ signal: controller.signal }`. Closing (X, Esc, or re-invoke) calls
`controller.abort()` and removes the host element — one call detaches all
listeners, so no orphaned handlers survive a toggle.

**Esc must not leak to the host page.** The `keydown` listener is attached in the
**capture phase** and, when it consumes **Esc** (closing the panel), calls
`event.stopPropagation()` + `event.preventDefault()` so host apps with their own
Esc handling (Docs, Jira, GitHub) don't also react. Other keys pass through
untouched.

Files injected via `executeScript({ files })` come from the extension package and
do **not** need `web_accessible_resources`.

### Permissions

No new permissions. `activeTab` + `scripting` (already declared in Slice 1) cover
injection: `activeTab` is granted on the popup/action click **and** on a `commands`
hotkey invocation, so the panel reaches the active tab without any broad
`host_permissions`. The only manifest addition is the `commands` entry.

### Token isolation

The injected panel never calls the gateway. It uses `chrome.runtime.sendMessage`
to reach the SW, which owns `postRelated` and the token — identical to `handleClip`.
The token is never placed in the page/Shadow DOM and never logged (Biome `noConsole`).

### Module layout (new / changed)

```
src/
  shared/
    related.ts          # NEW (pure): RelatedHit/RelatedQuery types, buildRelatedQuery(),
                        #   isRelatedHit() / isRelatedResponse() guards
    messages.ts         # MOD: RelatedRequest / RelatedResponse + isRelatedRequest()
  panel/
    panel-view.ts       # NEW: pure DOM builders (renderHits/renderHit/renderError) that
                        #   create nodes via textContent only — jsdom-unit-tested (XSS backstop)
    panel-in-page.ts    # NEW esbuild entry → dist/<target>/panel.js: self-toggle, mount
                        #   Shadow-DOM overlay, read context, message SW, delegate render to panel-view
  background/
    gateway-client.ts   # MOD: postRelated() — fetch + Bearer + status→reason + RelatedError
    handlers.ts         # MOD: handleRelated() — getConnection → buildRelatedQuery → postRelated
    service-worker.ts   # MOD: route "related"; chrome.commands.onCommand → inject panel.js
  browser/
    scripting.ts        # MOD: injectPanel(tabId) — executeScript({ files:["panel.js"] })
  popup/
    popup.{html,ts}     # MOD: "Show related" button → injectPanel(activeTab.id) → window.close()
  manifest/
    manifest.ts         # MOD: commands.show_related (suggested Alt+Shift+R)
esbuild.mjs             # MOD: add the `panel` entry
scripts/check-build.mjs # MOD: require panel.js per target
docs/development.md     # MOD: Slice-2 manual checklist
CHANGELOG.md            # MOD: Slice 2 under [Unreleased]
```

## Component contracts

```ts
// shared/related.ts (pure)
interface RelatedHit { id: string; title: string; service: string; snippet: string; url: string | null }
interface RelatedQuery { title?: string; canonicalUrl?: string; selection?: string; limit: number }

const RELATED_LIMIT = 10;

// Drop blank fields (conditional spread for exactOptionalPropertyTypes); include
// selection only when non-blank. Returns exactly the gateway request body.
buildRelatedQuery(
  ctx: { title?: string; canonicalUrl?: string; selection?: string },
  limit?: number,
): RelatedQuery
isRelatedHit(v: unknown): v is RelatedHit
isRelatedResponse(v: unknown): v is RelatedResponse

// shared/messages.ts (additive)
interface RelatedRequest { kind: "related"; title?: string; canonicalUrl?: string; selection?: string }
type RelatedError = "not_paired" | "unauthorized" | "unreachable" | "server_error"
type RelatedResponse =
  | { kind: "related"; ok: true;  items: RelatedHit[] }
  | { kind: "related"; ok: false; reason: RelatedError }
isRelatedRequest(v: unknown): v is RelatedRequest

// background/gateway-client.ts (additive; fetch injected for tests; ~8s AbortController timeout)
postRelated(
  origin: string, token: string, query: RelatedQuery, doFetch?: FetchLike,
): Promise<{ ok: true; items: RelatedHit[] } | { ok: false; reason: RelatedError }>
//   200 + valid {items:RelatedHit[]} → ok; 401 → unauthorized;
//   throw/abort → unreachable; 400/500/malformed body → server_error

// background/handlers.ts (additive; mirrors handleClip)
handleRelated(deps: RelatedDeps, req: RelatedRequest): Promise<RelatedResponse>
//   conn = getConnection(); null → { ok:false, reason:"not_paired" }
//   else postRelated(conn.origin, conn.token, buildRelatedQuery(req)) → map

// browser/scripting.ts (additive)
injectPanel(tabId: number): Promise<void>   // executeScript({ target:{tabId}, files:["panel.js"] })

// panel/panel-view.ts (pure DOM builders — textContent only, never innerHTML; jsdom-tested)
renderHits(doc: Document, items: RelatedHit[]): HTMLElement   // list, or the empty-state node
renderHit(doc: Document, hit: RelatedHit): HTMLElement        // link when url is a string, else text
renderError(doc: Document, message: string): HTMLElement
```

Cross-boundary data (the SW message, the gateway response) is typed `unknown` and
narrowed by a guard before use — never `any`.

## Data flow (open)

1. User clicks popup **Show related** or presses the hotkey.
2. **Popup path:** `activeTab()` → `injectPanel(id)` → `window.close()`.
   **Hotkey path:** SW `chrome.commands.onCommand` → `activeTab()` → `injectPanel(id)`.
3. `panel.js` runs: host present? → remove + stop (toggle-closed). Else mount the
   Shadow-DOM root (loading), read `document.title`, `link[rel="canonical"]`, and
   `window.getSelection()?.toString()`.
4. `panel.js` → `sendMessage({ kind:"related", title, canonicalUrl, selection })`
   (blank fields omitted).
5. SW `handleRelated` → `getConnection` → `postRelated(origin, token, buildRelatedQuery(req))`
   → returns `items` or a `reason`.
6. `panel.js` narrows the response with `isRelatedResponse` and renders: the hit
   list / "No related items found." / the mapped error message.
7. **Close** via X, Esc, or re-invoking the trigger → teardown removes the host
   element and the keydown listener.

- Each hit row: **title**, a **service badge** (e.g. `gmail`, `drive`), and a
  **snippet**. When `url` is a non-null string the title is an
  `<a target="_blank" rel="noopener noreferrer">`; when `url` is `null` the title
  is plain text.
- States: **loading** (immediately on mount), **list**, **empty**
  ("No related items found."), **error** (mapped message).
- **Safe rendering — `textContent` only.** Every gateway field (`title`,
  `snippet`, `service`) is written with `Element.textContent` / `createElement` —
  **never `innerHTML`**. The indexed content is attacker-influenceable (an email
  subject, a page title), and the contract types `snippet` as a plain string with
  no highlight markup, so plain-text rendering is both correct and the XSS
  backstop. For a link hit, only `href` is set (to the validated `url` string) and
  the visible text is the title via `textContent`.
- **Self-contained styles.** All CSS is an **inlined string** bundled into
  `panel.js` and injected as a `<style>` element in the shadow root — no `<link>`,
  no `chrome.runtime.getURL`, and therefore no `web_accessible_resources` entry.
- Shadow-DOM CSS isolation: the sidecar root sets `:host { all: initial; … }` to
  drop inherited typography/color, and references only its **own** namespaced
  `--nimbus-*` custom properties (never a host `:root` token — `all: initial` does
  not reset custom properties). Fixed to the right edge with a high `z-index`.
- **Color scheme.** The inlined styles honor the user's preference via
  `@media (prefers-color-scheme: dark)` swapping the `--nimbus-*` token set
  (light + dark), consistent with the Slice-1 popup/options (`color-scheme:
  light dark`). The host page's background is **not** sniffed.

## Error handling

| Condition | Source | Panel message |
| --- | --- | --- |
| Not paired | no `Connection` | "Pair a browser first (Options)." |
| Token rejected | `401 {error:"unauthorized"}` | "Pairing expired — re-pair in Options." |
| Gateway unreachable | `fetch` throws / abort timeout | "Can't reach Nimbus — is the gateway running?" |
| Server / malformed | `400`/`500` / bad body | "Nimbus had an error fetching related items." |
| No results | `200 { items: [] }` | "No related items found." |
| Unexpected message | failed `isRelatedResponse` | "Unexpected response." |

**Restricted pages.** Injection into `chrome:`/`about:`/`edge:`/extension-store
pages rejects. On the **popup-button** path the popup catches it and shows "Nimbus
can't show related on browser system pages." On the **hotkey** path there is no
page surface to render into, so the SW swallows the rejected injection (fails
closed, silent) — this is expected behavior. (Surfacing the hotkey-path failure
via a temporary action badge is **deferred** — see Design review resolutions.)

## Security posture

- **Loopback only** — unchanged; `postRelated` goes through the same `gateway-client`
  origin (the stored `Connection`), so the existing loopback constraint applies. No
  new `host_permissions`.
- **On-demand only** — no declared `content_scripts`; the panel is injected solely
  on a click or hotkey via `activeTab` + `scripting`.
- **Token isolation** — the token stays in the SW; the panel only ever receives
  rendered `RelatedHit` data, never the token.
- **DOM-XSS backstop** — gateway-returned strings are rendered with `textContent`
  only, never `innerHTML` (see Rendering). The indexed content is
  attacker-influenceable, and the Shadow root, while style-isolated, is **not** a
  security boundary against script — plain-text rendering is the actual defense.
- **Outbound links** — hit links open with `rel="noopener noreferrer"` and
  `target="_blank"`.

## Testing

Vitest, node environment — same philosophy as Slice 1 (pure/seam-mocked units
carry coverage; the Shadow-DOM/injection UI is dev-loaded / manual).

**Unit-tested:**
- `shared/related.ts` — `buildRelatedQuery` (drops blank fields; selection only when
  non-blank; `limit` default + override; `exactOptionalPropertyTypes` safety);
  `isRelatedHit` / `isRelatedResponse` (valid, wrong kind, malformed items, `url`
  null vs string vs non-string).
- `shared/messages.ts` — `isRelatedRequest` (valid, wrong kind, non-object).
- `background/gateway-client.ts` — `postRelated` with an **injected fake `fetch`**:
  assert URL (via `endpointUrl(origin, "related")`), `Bearer` header, JSON body,
  and every status→reason mapping (200 valid, 200 malformed→`server_error`, 401,
  400, 500, network throw, abort/timeout).
- `background/handlers.ts` — `handleRelated`: `not_paired` short-circuit (no fetch),
  paired→posts the built query + returns items, propagates `unauthorized` /
  `unreachable`.
- `panel/panel-view.ts` (**jsdom**, via the `@vitest-environment jsdom` docblock) —
  `renderHit`/`renderHits`/`renderError`: a `url:null` hit renders as a non-link
  text node; a `url` string renders an `<a>` with `target="_blank"` +
  `rel="noopener noreferrer"`; **XSS regression** — a hit whose `title`/`snippet`
  contains `"<img src=x onerror=…>"` yields a text node with that literal string
  and **zero** element children (proves `textContent`, not `innerHTML`).

**Manual (dev-load checklist in `docs/development.md`):** `panel.js` injection +
self-toggle + `AbortController` teardown, Shadow-DOM isolation on a real page, the
hotkey (incl. Esc not leaking to the host app), link opens in a new tab,
empty/error/not-paired states, restricted-page behavior, dark-mode appearance,
Firefox parity.

No hard local coverage thresholds; SonarCloud's "Sonar way" gate (80% new code)
governs.

## Open decisions (resolved at brainstorm, 2026-06-23)

1. **Trigger:** popup "Show related" button **+** a `chrome.commands` hotkey
   (`Alt+Shift+R` suggested). (Rejected: toolbar `onClicked` — taken by the clip
   popup; context-menu-only — less discoverable.)
2. **Toggle / dismiss:** re-invoke toggles closed; X + Esc close; no click-outside.
   (Rejected: click-outside dismissal; refresh-on-re-invoke.)
3. **Refresh:** query once on open; close + reopen to re-run. (Rejected: refresh
   button; auto re-query on selection change — YAGNI for this slice.)
4. **Delivery:** injected Shadow-DOM sidecar, SW does the fetch. (Rejected:
   popup-rendered list — not a sidecar; declared `content_scripts` — violates
   on-demand posture.)
5. **Query building:** the SW builds the `RelatedQuery` via the pure
   `buildRelatedQuery`, keeping `panel-in-page` thin (symmetry with `handleClip` +
   `buildClipPayload`).
6. **Limit:** fixed `RELATED_LIMIT = 10` for this slice.

## Design review resolutions (2026-06-23)

From [the Slice 2 design review](./2026-06-23-web-clipper-extension-slice2-design-review.md):

1. **Snippet/title DOM-XSS (fixed).** All gateway fields render via `textContent`,
   never `innerHTML`; `snippet` is a plain string per the contract. Added to
   Rendering + Security posture. The unit tests for the (pure) render-model mapper
   assert no markup is interpreted.
2. **Shadow-DOM style delivery (fixed).** Styles are an inlined string injected as
   a `<style>` element in the shadow root — no `<link>`, no `getURL`, no
   `web_accessible_resources`. Stated in Rendering.
3. **Esc propagation (fixed).** The `keydown` listener runs in the capture phase
   and calls `stopPropagation()` + `preventDefault()` when it consumes Esc, so host
   apps don't double-handle it. Stated in Delivery & toggle.
4. **Listener cleanup (fixed).** Teardown uses a single `AbortController` whose
   `signal` is passed to every listener; `abort()` on close detaches them all.
   Stated in Delivery & toggle.
5. **Restricted-page feedback (deferred / partially rejected).** Console logging is
   **rejected** — Biome `noConsole` bans `console.*` in `src/` and the extension
   ships none. A temporary action-badge ("Err"/"N/A") on the silent hotkey path is
   **deferred** as YAGNI: it adds badge set/clear/timeout state for a by-design edge
   case, and the popup-button path already shows a clear message. Revisit if users
   report confusion.
6. **Dark mode (fixed, lightweight).** The inlined styles honor
   `@media (prefers-color-scheme: dark)` via the `--nimbus-*` tokens, matching the
   Slice-1 popup/options. The alternative — sniffing the host page's background
   brightness — is **rejected** as fragile and complex.
