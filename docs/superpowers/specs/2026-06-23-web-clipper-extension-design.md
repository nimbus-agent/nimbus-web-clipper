# Web Clipper Extension (Plan B) — Design Spec

**Date:** 2026-06-23
**Status:** Approved (brainstorm) — ready for implementation plan
**Repo:** `nimbus-agent/nimbus-web-clipper` (this repo)
**Upstream contract:** locked by Nimbus PR #718 (gateway "Plan A", shipped 2026-06-22)

## Summary

A Chrome + Firefox **MV3** browser extension that clips the readable article or
the current text selection into the user's local-first Nimbus index, and (Slice 2)
surfaces related indexed items in an on-demand Shadow-DOM panel. It is the
**inbound-push** client of the gateway's already-shipped HTTP surface: the
extension pushes clips into the gateway over loopback; the engine never pulls.

This spec covers the whole extension design. The **build is phased into two
slices**, each getting its own implementation plan:

- **Slice 1 (this plan):** pairing + capture + clip ingest — the end-to-end
  "save pages to Nimbus" core (browser seam, options/pairing UI, popup, capture,
  token storage, gateway client, error handling).
- **Slice 2 (separate plan):** the related-items sidecar overlay.

## Goals

- Clip the readable article (Mozilla Readability) **or** the current selection
  into the local index, with optional tags applied at capture time.
- Re-clipping an article updates the existing item (gateway dedups by canonical URL).
- Owner-consented pairing: the extension holds a long-lived bearer token minted
  by the gateway's `nimbus clip pair` handshake.
- (Slice 2) On-demand panel of related local items for the current page.
- Loopback-only, no telemetry, no cloud calls; the bearer token is the only secret.

## Non-Goals

- Chrome Web Store / AMO publishing — dev-loadable / sideloadable builds now;
  store submission is a follow-on (the release zips are submission-ready).
- Safari (requires an Xcode/Swift wrapper) — deferred.
- Auto-on-page-load capture or sidecar — on-demand only (privacy/perf).
- Full raw-HTML archival — readable text only.
- A background offline retry queue — the user retries from the popup (Slice 1).
  A queued-clips feature may be a later slice.
- Multiple paired gateways per browser profile — one `Connection` record.

## The locked HTTP contract (do NOT redesign)

Verified against the as-shipped gateway code (PR #718). The gateway binds
`127.0.0.1` only (invariant **I6**) and starts its HTTP surface only when
`NIMBUS_HTTP_PORT` is set — **there is no default port**, so the extension must
obtain the gateway origin from the user (see Pairing).

| Route | Auth | Request body | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /v1/clips` | `Authorization: Bearer <token>` | `{ url, canonicalUrl?, title, mode:"article"\|"selection", body, tags?, capturedAt }` | `200 { id, status:"created"\|"updated" }` | `401 {error:"unauthorized"}` · `400 {error:"invalid_request", field?}` · `500 {error:"internal_error"}` |
| `POST /v1/clips/pair/confirm` | none (pairing-code gated) | `{ code }` | `200 { token, label }` | `403 {error:"pairing_failed"}` |
| `POST /v1/clips/related` | `Authorization: Bearer <token>` | `{ title?, canonicalUrl?, selection?, limit? }` | `200 { items: RelatedHit[] }` | `401 {error:"unauthorized"}` · `400 {error:"invalid_json"}` |

`RelatedHit = { id: string; title: string; service: string; snippet: string; url: string | null }`
— note `url` is **nullable** (Slice 2 renders URL-less hits as plain text).

Pairing: the owner runs `nimbus clip pair [--label <device>]` on the gateway host
to open a short, single-use, in-memory window (TTL ~120s, attempt-capped) and the
CLI prints a 6-digit code. The window is fail-closed (invariant **I30**): no live
window → `403`, no token. Minted tokens persist in the gateway's Vault and are
revoked with `nimbus clip revoke`.

## Architecture

**Load-bearing principle: the bearer token and all gateway I/O live in the
background service worker.** The popup and options page never hold the token or
call the gateway directly — they message the SW, which owns `fetch` and the token
store. Page capture runs in the tab via **on-demand injection** (`activeTab` +
`scripting`, no declared `content_scripts`), so the extension only touches a page
on an explicit click.

```text
┌───────────── Browser extension (MV3) ─────────────┐         ┌──────────────────────────────┐
│  options page ──┐                                  │  HTTP   │  Nimbus gateway (127.0.0.1)   │
│  popup ─────────┤ runtime msg                       │ (bearer)│  POST /v1/clips              │
│                 ▼                                   │ ──────► │  POST /v1/clips/pair/confirm │
│        background service worker                    │         │  POST /v1/clips/related      │
│          • connection store (storage.local)         │ ◄────── │  (binds 127.0.0.1, I6/I30)   │
│          • gateway-client (fetch + Bearer)          │  JSON   └──────────────────────────────┘
│  capture (injected into active tab on click) ──────►│
└────────────────────────────────────────────────────┘
   owner runs `nimbus clip pair` → prints the 6-digit code
```

### Module layout (Slice 1)

```
src/
  browser/              # the ONLY place chrome.* is touched (thin typed seam; mocked in tests)
    storage.ts          #   getConnection / setConnection / clearConnection  (chrome.storage.local)
    tabs.ts             #   activeTab() → { id, url, title }
    scripting.ts        #   runCapture(tabId, mode) → injects capture-in-page, returns CaptureResult
    runtime.ts          #   typed sendMessage / addMessageListener
  shared/
    gateway.ts          # endpointUrl(origin, endpoint) + CLIP_PATHS  (exists)
    messages.ts         # discriminated Request/Response union + guards  (extends the stub)
    clip.ts             # ClipPayload type, buildClipPayload(), parseTags()  (pure)
  capture/
    capture-in-page.ts  # injected fn: Readability on a document clone, or selection text
    fallback.ts         # fallbackBody(meta) = description ?? url  (pure)
  background/
    service-worker.ts   # message router: handlePair(), handleClip()  (entry)
    gateway-client.ts   # confirmPair(), postClip() — fetch + Bearer + status→reason mapping
    connection-store.ts # connection read/write over browser/storage + loopback-origin validation
  popup/                # popup.ts/html/css — Clip page / Clip selection / tags / status
  options/              # options.ts/html/css — gateway URL + code → pair; show paired label
  manifest/             # composeManifest(target, version)  (exists)
```

Each unit has one purpose, communicates through a typed interface, and is testable
in isolation. `chrome.*` is reachable only through `src/browser/`, so the rest of
the codebase is unit-testable against mocks.

### Component contracts

```ts
// browser/storage.ts
interface Connection { origin: string; token: string; label: string; pairedAt: number }
getConnection(): Promise<Connection | null>
setConnection(c: Connection): Promise<void>
clearConnection(): Promise<void>

// browser/tabs.ts
activeTab(): Promise<{ id: number; url: string; title: string }>

// browser/scripting.ts
runCapture(tabId: number, mode: "article" | "selection"): Promise<CaptureResult>

// capture — CaptureResult is what the injected function returns
interface CaptureResult {
  url: string; canonicalUrl?: string; title: string;
  mode: "article" | "selection"; body: string;
  readableFound: boolean;   // false → popup shows the "saved as a bookmark" notice
}
fallbackBody(meta: { description?: string; url: string }): string   // description ?? url

// shared/clip.ts (pure)
interface ClipPayload {     // exactly the gateway request shape
  url: string; canonicalUrl?: string; title: string;
  mode: "article" | "selection"; body: string; tags: string[]; capturedAt: number;
}
buildClipPayload(c: CaptureResult, tags: string[], nowMs: number): ClipPayload
parseTags(input: string): string[]   // "a, b ,a" → ["a","b"]  (trim, drop empties, dedupe)

// shared/messages.ts (discriminated union + type guards)
type Request =
  | { kind: "pair"; origin: string; code: string }
  | { kind: "clip"; capture: CaptureResult; tags: string[] }
type PairError = "pairing_failed" | "bad_origin" | "unreachable" | "server_error"
type ClipError = "not_paired" | "unauthorized" | "invalid_request" | "unreachable" | "server_error"
type Response =
  | { kind: "pair"; ok: true; label: string }
  | { kind: "pair"; ok: false; reason: PairError }
  | { kind: "clip"; ok: true; status: "created" | "updated"; bookmarked: boolean }
  | { kind: "clip"; ok: false; reason: ClipError }

// background/gateway-client.ts (fetch injected for tests)
confirmPair(origin: string, code: string): Promise<{ ok: true; token: string; label: string } | { ok: false; reason: PairError }>
postClip(origin: string, token: string, payload: ClipPayload): Promise<{ ok: true; status: "created" | "updated" } | { ok: false; reason: ClipError }>
```

Cross-boundary data (messages, gateway responses, injected-capture results) is
typed `unknown` and narrowed by a guard before use — never `any`.

## Data flows

### Pairing

1. **Options page:** user enters the gateway URL (e.g. `http://127.0.0.1:8765`)
   and the 6-digit code → `sendMessage({ kind:"pair", origin, code })`.
2. **SW `handlePair`:** validate `origin` is a loopback host (else `bad_origin`);
   `confirmPair(origin, code)` → on `200 { token, label }` write
   `{ origin, token, label, pairedAt }` to `storage.local`; return
   `{ ok:true, label }`. On `403` → `{ ok:false, reason:"pairing_failed" }`; on
   `fetch` throw → `unreachable`; on `5xx` → `server_error`.
3. **Options page** shows "Paired as `<label>`" or the failure message. **The
   token never enters the options DOM.**

### Clip

1. **Popup:** user clicks **Clip page** (article) or **Clip selection** (enabled
   only when the active tab has a selection), with optional tags typed in the popup.
2. **Popup:** `activeTab()` → `runCapture(tabId, mode)` injects `capture-in-page`,
   which returns a `CaptureResult`. In article mode with no Readability result the
   injected function sets `readableFound:false` and `body = fallbackBody(...)`.
3. **Popup:** `sendMessage({ kind:"clip", capture, tags: parseTags(input) })`.
4. **SW `handleClip`:** `getConnection()`; if none → `{ ok:false, reason:"not_paired" }`.
   Else `buildClipPayload(capture, tags, Date.now())` → `postClip(origin, token, payload)`
   → map `200 {id,status}` / `401`→`unauthorized` / `400`→`invalid_request` /
   throw→`unreachable` / `5xx`→`server_error`.
5. **Popup** renders the outcome (see Error handling).

## Error handling

| Condition | Detected as | User-facing message |
| --- | --- | --- |
| Not paired (clip) | no `Connection` | "Pair a browser first (Options)." |
| Bad gateway origin | not a loopback host | "Enter a 127.0.0.1 / localhost URL." |
| Gateway unreachable | `fetch` throws / abort timeout | "Can't reach Nimbus — is the gateway running?" + Retry |
| Token rejected | `401 {error:"unauthorized"}` | "Pairing expired — re-pair in Options." |
| Bad payload | `400 {error:"invalid_request", field?}` | "Couldn't save (`field`)." (shouldn't occur — payload is typed) |
| Server error | `500 {error:"internal_error"}` | "Nimbus had an error saving this." |
| Pairing failed | `403 {error:"pairing_failed"}` | "Code wrong or expired — run `nimbus clip pair` again." |
| Saved | `200 {status:"created"}` | "Saved to Nimbus." |
| Re-clip | `200 {status:"updated"}` | "Updated in Nimbus." |
| No readable article | `readableFound:false` | "Saved as a bookmark." |

`confirmPair`/`postClip` wrap `fetch` in an `AbortController` timeout (~5s). No
background retry in Slice 1.

## Security posture

- **Loopback only.** `host_permissions` stays `http://127.0.0.1/*` +
  `http://localhost/*`; the user-entered origin is validated to be a loopback host
  before any request. No remote origin is ever contacted.
- **Token isolation.** The bearer token lives in `chrome.storage.local` and the
  service worker only. It is never placed in the popup/options/page DOM, never
  logged, and never included in an error string. It leaves the SW solely as the
  `Authorization: Bearer` header on a loopback request. Biome `noConsole` in
  `src/` backs this.
- **On-demand only.** No declared `content_scripts`; capture (Slice 1) and the
  sidecar (Slice 2) are injected via `activeTab` + `scripting` only on a click.
- **Pairing code.** Passed straight through to the one confirm request; never
  logged or persisted.
- **Revocation.** Carrying the gateway spec's threat model: the token lives
  outside the Vault boundary, is localhost-scoped, and `nimbus clip revoke` is the
  cut-off (any holder then gets `401`, which prompts a re-pair).

## Testing

Vitest, node environment. Pure logic and seam-mocked units carry the coverage;
browser-integration is dev-loaded / manual.

**Unit-tested:**
- `shared/clip.ts` — `buildClipPayload` (field mapping incl. `capturedAt`, optional
  `canonicalUrl`), `parseTags` (trim / drop empties / dedupe).
- `capture/fallback.ts` — `fallbackBody` (description vs url).
- `shared/messages.ts` — request/response guards (valid, wrong kind, non-object).
- `background/gateway-client.ts` — `confirmPair` / `postClip` with an **injected
  fake `fetch`**: assert URL (via `endpointUrl`), `Bearer` header, JSON body, and
  every status→reason mapping (200 created/updated, 401, 400, 403, 500, network
  throw, abort/timeout).
- `background/connection-store.ts` + `handlePair` / `handleClip` — with a **mocked
  `browser/` seam**: pair writes the connection and the response never carries the
  token; clip-when-unpaired short-circuits to `not_paired`; loopback-origin
  validation rejects a non-loopback origin.
- `manifest/manifest.ts`, `shared/gateway.ts` — already covered.

**Manual (dev-load checklist in `docs/`):** popup/options DOM wiring,
`scripting.executeScript` injection, Readability extraction on real pages, the
Slice-2 Shadow-DOM sidecar. `capture-in-page.ts` stays thin (a Readability call +
a selection read) so little logic escapes unit coverage.

No hard local coverage thresholds; SonarCloud's "Sonar way" gate (80% new code)
governs, as in the template.

## Slice 2 — Related-items sidecar (specified; planned separately)

On-demand only: a toolbar action / hotkey injects a content script that mounts a
panel in a **Shadow DOM**. Per the gateway design's CSS-isolation note, the
sidecar root applies an `all: initial` reset for inherited typography/color and
references only its **own** namespaced `--*` custom properties (never a host
`:root` token), since `all: initial` does not reset custom properties. The SW does
`POST /v1/clips/related` (bearer) with the page `title` + `canonicalUrl` + any
`selection` (selection is the primary query; the gateway de-prioritizes the page's
own host). The panel lists each `RelatedHit` — title, service badge, snippet, and
a link — rendering a `url:null` hit as non-link text. Slice 2 gets its own spec
addendum / plan before implementation.

## Open decisions (resolved at brainstorm, 2026-06-23)

1. **Gateway origin discovery:** user enters the full origin in Options (no default
   port exists). Persisted in the `Connection` record. (Rejected: port auto-probe,
   single pasted pairing string.) The scaffold's placeholder
   `DEFAULT_GATEWAY_ORIGIN` in `shared/gateway.ts` is removed in Slice 1 — there
   is no default origin; it always comes from the stored `Connection`.
2. **Cross-browser API:** a thin typed `src/browser/` wrapper over native `chrome.*`,
   no runtime dependency. (Rejected: `webextension-polyfill`, raw inline `chrome.*`.)
3. **Readability fallback:** lightweight bookmark (`body = metaDescription ?? url`)
   + a non-blocking popup notice; the clip always succeeds. (Rejected: prompt to
   select text; clip visible page text.)
4. **Build phasing:** two slices — clip first, sidecar second. (Rejected: one
   all-in-one plan.)
5. **Token storage:** `chrome.storage.local` (persists across restarts).
6. **Gateway I/O ownership:** the background service worker owns the token + all
   gateway calls; popup/options message it.
