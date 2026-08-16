# Web Clipper Extension — Slice 3 (Offline retry queue) Design Addendum

**Date:** 2026-06-27
**Status:** Approved (brainstorm) — ready for implementation plan
**Repo:** `nimbus-agent/nimbus-web-clipper` (this repo)
**Parent spec:** [`2026-06-23-web-clipper-extension-design.md`](./2026-06-23-web-clipper-extension-design.md) (§ Non-Goals — "A queued-clips feature may be a later slice")
**Upstream contract:** locked by Nimbus PR #718 (`POST /v1/clips`) — **no contract change**

## Summary

A **local offline retry queue** for clip ingest. Today a clip that fails because
the gateway is down (or times out) is lost unless the user manually re-clicks.
Slice 3 persists those failed clips in `chrome.storage.local` and drains them
automatically when the gateway returns — woken by a `chrome.alarms` periodic flush
plus opportunistic flushes (service-worker startup and each new clip). A
**toolbar badge** shows the pending count and the popup gains a **queue manager**
(list of waiting clips with per-item Retry/Remove and a Retry-all button).

The queue reuses every Slice 1/2 invariant: the bearer **token is never stored in
the queue** (re-read from the connection record at flush time), all gateway I/O
stays in the service worker, the network surface stays loopback-only, and the
manager renders gateway/page-influenced strings `textContent`-only (DOM-XSS
backstop). No new gateway endpoint, no contract change — the queue replays the
existing `POST /v1/clips` call.

This addendum builds on Slice 1 (shipped): `gateway-client.postClip`, the
connection store, `buildClipPayload`/`ClipPayload`, the typed message envelope,
and the `src/browser/` `chrome.*` seam all already exist.

## Goals

- **Never silently lose a clip** to a transient failure: persist it and retry.
- **Auto-drain** the queue when the gateway is reachable again — without requiring
  the user to reopen the popup (the `chrome.alarms` flush survives SW teardown).
- Give the user **visibility and control**: a toolbar count badge and an in-popup
  manager with per-item Retry/Remove and Retry-all.
- Keep the load-bearing invariants: token + all gateway I/O in the SW; the token
  never enters the queue; loopback only; `textContent`-only rendering.

## Non-Goals

- **Queuing user-action failures.** Only *transient* failures (`unreachable`,
  `server_error`) are queued. `not_paired` / `unauthorized` / `invalid_request`
  need the user to act and are surfaced immediately, exactly as today — never
  queued.
- **Auto-expiry / auto-give-up.** An entry leaves the queue only on success or
  explicit user removal. No TTL and no max-attempts auto-drop in this slice (the
  gentle ~1-min cadence makes indefinite retry harmless). A possible later slice.
- **A background offline *capture*** — only the *ingest* (POST) is retried; the
  page is captured at clip time as now. We never re-open or re-read the page.
- **Live popup refresh** while open — the manager fetches on open and re-renders
  after each action; it does not subscribe to background flush events.
- **Any new gateway endpoint or contract change** (`POST /v1/clips` is locked).
- **Multiple paired gateways** — still one `Connection` record (unchanged).

## The locked HTTP contract (do NOT redesign)

| Route | Auth | Request body | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /v1/clips` | `Authorization: Bearer <token>` | `{ url, canonicalUrl?, title, mode, body, tags?, capturedAt }` | `200 { id, status:"created"\|"updated" }` | `401 unauthorized` · `400 invalid_request` |

The queue replays this unchanged via the existing
`postClip(origin, token, payload)`. `capturedAt` is preserved from the original
clip moment (set in `buildClipPayload` at enqueue time), so a clip that drains
hours later still records when it was actually captured.

### Retryability of `ClipError` (the queuing decision)

`ClipError = "not_paired" | "unauthorized" | "invalid_request" | "unreachable" | "server_error"`.

| Reason | Transient? | Queue behavior |
| --- | --- | --- |
| `unreachable` | yes | **Enqueue** at clip time; on flush, **stop the batch** (gateway down). |
| `server_error` | yes (maybe entry-specific) | **Enqueue** at clip time; on flush, mark attempt and **continue** to the next entry. |
| `unauthorized` | no | Not queued at clip time. If hit during flush (token died mid-drain): **stop the batch**, keep entries; surfaced via the manager. |
| `not_paired` | no | Not queued (nothing to send to). |
| `invalid_request` | no | Not queued at clip time. If hit during flush: keep + mark, then **skip on automatic flushes** (a 400 won't self-fix) — retried only when the user explicitly hits Retry on it; labelled in the manager. |

## Interaction model (resolved at brainstorm, 2026-06-27)

1. **Clip still posts immediately.** A healthy gateway gives instant feedback as
   today. Only a transient failure diverts the clip into the queue, and the popup
   reports *"Saved offline — will sync when Nimbus is back."*
2. **Retry trigger:** a `chrome.alarms` alarm (`flush-clip-queue`, ~1 min) wakes
   the SW to flush, **plus** an opportunistic flush on SW startup and after each
   new clip, **plus** the popup's Retry / Retry-all buttons. (Rejected:
   opportunistic-only — a pending clip could sit indefinitely; manual-only — barely
   better than today's re-clip.)
3. **Visibility:** a toolbar **count badge** (`chrome.action.setBadgeText`, no new
   permission) and a **full queue manager** in the popup. (Rejected: silent/minimal
   — no ongoing visibility; the user explicitly chose the full manager.)
4. **Dedup:** **replace by URL** — one pending entry per URL; a re-clip overwrites
   the queued payload/tags and resets attempts, matching the gateway's own upsert
   (last-write-wins). (Rejected: allow duplicates — noisy list, redundant retries.)

## Data model

```ts
// src/shared/queue.ts
interface QueuedClip {
  readonly payload: ClipPayload;     // exactly what we POST; payload.url is the identity
  readonly queuedAt: number;         // when first enqueued — drives "age" in the manager
  readonly attempts: number;         // flush attempts so far
  readonly lastReason?: ClipError;   // last transient failure, shown in the manager
}

/** What the popup sees — the body is never sent to the popup (size + need-to-know). */
interface QueuedClipView {
  readonly url: string;
  readonly title: string;
  readonly queuedAt: number;
  readonly attempts: number;
  readonly lastReason?: ClipError;
}

const MAX_QUEUE = 50;
```

The full queue is `QueuedClip[]`, persisted in `chrome.storage.local` under key
`"clipQueue"`. **The bearer token is never part of an entry** — `flushQueue`
re-reads it from the connection record, so the token stays confined to the
connection store + SW (invariant preserved). `payload.url` is the entry identity
(dedup guarantees one entry per URL, so no id generation is needed).

### Pure queue operations (`src/shared/queue.ts`, array → array)

- `enqueue(queue, entry): QueuedClip[]` — drop any existing entry with the same
  `payload.url`, append the new one, then if `length > MAX_QUEUE` evict the oldest
  (FIFO front).
- `removeFromQueue(queue, url): QueuedClip[]`
- `markAttempt(queue, url, reason): QueuedClip[]` — increment `attempts` and set
  `lastReason` on the matching entry.
- `toView(entry): QueuedClipView` — project for the popup (no body).
- `isQueuedClip(v): v is QueuedClip` — narrow `unknown` from storage (validates the
  nested `ClipPayload`).

Each of these is a pure `QueuedClip[] → QueuedClip[]` mutator, so they compose
directly as the argument to the serialized `updateQueue` below — every write is
expressed as a function of the *current* persisted state, never a stale snapshot.

## Module layout (mirrors the Slice 1/2 split: pure logic vs. `chrome.*` seam)

| File | Kind | Responsibility |
| --- | --- | --- |
| `src/shared/queue.ts` | new, pure | `QueuedClip`/`QueuedClipView`/`MAX_QUEUE` + `enqueue`/`removeFromQueue`/`markAttempt`/`toView` + `isQueuedClip` |
| `src/background/clip-queue-store.ts` | new | `getQueue` + **serialized** `updateQueue(mutator)` (read-modify-write under a module-level promise lock) over `chrome.storage.local` (mirrors `connection-store.ts`) |
| `src/background/queue-flush.ts` | new | `flushQueue(deps, opts)` — dep-injected drain orchestration |
| `src/browser/alarms.ts` | new seam | `ensureAlarm(name, periodInMinutes)` / `clearAlarm(name)` + `addAlarmListener(fn)` over `chrome.alarms` |
| `src/browser/action.ts` | new seam | `setBadgeCount(n)` over `chrome.action.setBadgeText` / `setBadgeBackgroundColor` |
| `src/popup/queue-view.ts` | new, pure | `textContent`-only DOM builders for the manager (jsdom-tested, like `panel-view.ts`) |
| `src/shared/messages.ts` | modify | `queue-list` / `queue-retry` / `queue-remove` requests + `QueueResponse` + guards; `ClipResponse` gains `queued?` |
| `src/background/handlers.ts` | modify | `handleClip` enqueues on transient failure; add `handleQueueList`/`handleQueueRetry`/`handleQueueRemove` |
| `src/background/service-worker.ts` | modify | ensure/clear the flush alarm by queue state + startup flush; route queue messages; refresh the badge after every queue mutation |
| `src/popup/popup.{html,ts,css}` | modify | the queue-manager section |
| `src/manifest/manifest.ts` | modify | add the `"alarms"` permission (+ interface unchanged — permissions is already `string[]`) |

No new esbuild entry (`popup` already exists); `check-build` is unchanged.

## Data flow

### Enqueue (clip-time) — `handleClip`

`handleClip` gains queue deps (`updateQueue`, the pure `enqueue`, `nowMs`):

1. `getConnection()` null → `{ ok:false, reason:"not_paired" }` (unchanged; not queued).
2. `postClip(...)` → `ok` → return success (unchanged).
3. `!ok`, reason ∈ {`unreachable`, `server_error`} → `updateQueue(q => enqueue(q, entry))`,
   return `{ kind:"clip", ok:false, reason, queued:true }`.
4. `!ok`, reason ∈ {`unauthorized`, `invalid_request`} → return `{ ok:false, reason }`
   (unchanged; not queued).

After the handler resolves, the SW refreshes the badge from the queue length and
(if the queue went from empty → non-empty) ensures the flush alarm exists.

### Flush (drain) — `flushQueue(deps)`

```ts
interface FlushDeps {
  readonly getConnection: () => Promise<Connection | null>;
  readonly getQueue: () => Promise<QueuedClip[]>;
  readonly updateQueue: (mutator: (q: QueuedClip[]) => QueuedClip[]) => Promise<QueuedClip[]>;
  readonly postClip: ClipDeps["postClip"];
}
// flushQueue(deps, opts?: { url?: string; manual?: boolean }): Promise<{ remaining: number }>
```

- `getConnection()` null → return `{ remaining: queue.length }`, queue untouched
  (can't drain while unpaired; the badge still shows the backlog).
- Empty queue → `{ remaining: 0 }`.
- Take a **snapshot** of the entries to attempt: `opts.url` selects one entry for a
  single-item retry; otherwise all entries, **except** that an *automatic* flush
  (`manual` falsy) skips entries whose `lastReason === "invalid_request"` (they
  won't self-fix — see the retryability table). A `manual` flush (any popup Retry)
  attempts everything, including those.
- Walk the snapshot FIFO, posting each. **An entry leaves the queue only on `ok`.**
  After each result, apply the outcome as a *delta against current state* via
  `updateQueue` — `updateQueue(q => removeFromQueue(q, url))` on success,
  `updateQueue(q => markAttempt(q, url, reason))` on a kept failure. Never write a
  whole stale array (this is what makes a concurrent popup Remove safe — see
  Concurrency). Per the retryability table: `unreachable`/`unauthorized` **stop the
  batch** (keep the rest); `server_error`/`invalid_request` mark and **continue**.
- Return the remaining count (`(await getQueue()).length`).

Triggers, all funneling into `flushQueue` + a badge refresh: the `chrome.alarms`
alarm (only live while the queue is non-empty — see Alarm lifecycle), SW startup
(`onStartup`/top-level), and the popup Retry (`manual: true`) / Retry-all messages.

### Manager (popup)

On open the popup sends `queue-list` → renders `QueuedClipView[]`. The section is
**hidden when empty**. Each row: title (or host if untitled) · host · relative age
· a status line when `attempts > 0`/`lastReason` is set (an `invalid_request` entry
reads as e.g. *"Couldn't save — won't retry automatically"*). Per-row **Retry**
(`queue-retry { url }`) and **Remove** (`queue-remove { url }`), and a **Retry all**
(`queue-retry {}`) button. Each action messages the SW and re-renders from the
returned `QueueResponse`. All gateway/page strings render `textContent`-only.

**No navigable links.** The manager does **not** render `payload.url` as an `href`
— the row shows the host as `textContent` (parsed with a guarded `new URL(url)`;
an unparseable URL falls back to the raw string as text). There is therefore no
`javascript:`-href surface in this slice. If a future slice adds an "open page"
link, it MUST reuse the http(s) scheme allowlist already shipped as `safeHttpUrl`
in `panel-view.ts` (Slice 2) rather than assigning `.href` directly.

## Concurrency & invariants

- **Serialized read-modify-write (no lost updates).** The service worker is
  single-*threaded* but not single-*task*: an alarm flush and a popup `queue-remove`
  are both `async` and interleave at `await` points, so two naïve
  `getQueue → mutate → setQueue` cycles would clobber each other (the later write
  wins, resurrecting a just-removed entry). The store therefore exposes **only**
  `getQueue` (read) and a serialized `updateQueue(mutator)` — every write is a pure
  `QueuedClip[] → QueuedClip[]` function applied to the *freshly-read current* state,
  and `updateQueue` chains calls on a module-level promise so read-modify-write runs
  atomically end-to-end. `flushQueue` never holds the lock across a `postClip`
  network call: it snapshots, posts unlocked, then applies each outcome as a small
  delta (`removeFromQueue`/`markAttempt`) through `updateQueue`. The popup **never**
  writes storage directly; it only messages the SW.
- **Token confinement.** The token is never serialized into the queue; `flushQueue`
  re-reads it from `getConnection()` at drain time.
- **Loopback only.** No new `host_permissions`, no new fetch destinations — the
  queue replays `postClip` against the stored `Connection.origin`.
- **DOM-XSS backstop.** `queue-view.ts` writes every entry string via
  `textContent`/`createElement`, never `innerHTML` (titles are page-influenced).
- **New permission:** `"alarms"` only. The badge uses `chrome.action`, which needs
  no permission. Both `chrome.alarms` and `chrome.action` badges work on Chrome and
  Firefox MV3.

## Badge

The SW sets the badge to the pending count after every queue mutation (enqueue,
flush, remove) and on startup: `setBadgeCount(n)` → `setBadgeText(n > 0 ? String(n) : "")`
with a neutral background color set once. The badge clears to empty when the queue
drains to zero. Display caps at `MAX_QUEUE`.

## Alarm lifecycle (efficiency)

The flush alarm is **only scheduled while there is work to do** — it is *not* a
permanent 1-min heartbeat. `ensureAlarm("flush-clip-queue", 1)` is called when the
queue transitions empty → non-empty (i.e. on enqueue), and `clearAlarm` is called
when a flush drains it to zero. On SW startup the alarm is (re-)ensured iff the
persisted queue is non-empty. This removes idle wakeups entirely when nothing is
pending, which is the real resource cost — a single ~1-min `POST` to a *loopback*
gateway while a backlog exists is cheap. (Note: `navigator.onLine` is deliberately
**not** used to gate the flush — the gateway is on `127.0.0.1`, so it is reachable
even when the machine has no internet, e.g. on a plane; `navigator.onLine` reflects
internet reachability, not loopback, and would wrongly block local-first draining.
Exponential backoff is deferred — see Deferred.)

## Error handling & edge cases

- **Unpaired at flush** → no-op, queue intact, badge still shows the backlog.
- **Re-clip while pending** → `enqueue` replaces the URL's entry (fresh
  payload/tags, `attempts` reset) — last-write-wins, matching the gateway upsert.
- **Overflow at `MAX_QUEUE`** → evict the oldest entry on enqueue.
- **Mid-drain auth death** (`unauthorized`) → stop the batch, keep entries; the
  manager shows the reason so the user knows to re-pair in Options.
- **Malformed stored queue** (`isQueuedClip` rejects) → treat as empty (fail safe),
  consistent with `getConnection`'s `isConnection` guard.
- **Persistent `invalid_request`** → kept and labelled, but **skipped by automatic
  flushes** (only an explicit user Retry attempts it) so a permanently-rejected
  payload doesn't burn a `POST` every minute. The user can Remove it.
- **Storage quota** → bounded on two sides: `MAX_QUEUE` caps the count, and the
  body is **readable text only** (raw-HTML archival is a project non-goal), so a
  payload is typically tens of KB, not megabytes. The write itself is still treated
  as fallible: `updateQueue` wraps the `storage.set` in try/catch and, on a quota
  rejection during enqueue, evicts the oldest entry and retries once; if it still
  fails it leaves the existing queue intact and the enqueue surfaces as a normal
  clip failure to the popup (no partial/corrupt write). A hard per-payload byte cap
  / body truncation is deferred (see Deferred) as YAGNI given readable-text-only.

## Testing

Pure/dep-injected units carry the coverage (Vitest; jsdom where noted). The SW
glue, alarm registration, and popup DOM wiring go on the manual checklist, exactly
as Slices 1–2.

- `queue.test.ts` — replace-by-URL, FIFO eviction at `MAX_QUEUE`, remove,
  `markAttempt`, `toView` (no body), `isQueuedClip` guard.
- `queue-flush.test.ts` — empty/unpaired no-ops; success drains; `unreachable` and
  `unauthorized` stop the batch and keep entries; `server_error` marks-and-continues;
  `invalid_request` **skipped on auto flush but attempted on `manual`**; single-`url`
  retry; mixed batch; **a remove applied (via `updateQueue`) mid-drain is not clobbered
  by the flush's own write** (the serialization regression test).
- `clip-queue-store.test.ts` — `updateQueue` serializes concurrent
  read-modify-writes (two overlapping mutators both land; no lost update).
- `handlers.test.ts` — `handleClip` enqueues on transient, **not** on
  `unauthorized`/`invalid_request`, returns `queued:true`; the queue handlers
  list/retry/remove.
- the `alarms` (`ensureAlarm`/`clearAlarm`/listener) + `action` (`setBadgeCount`) seams
  via the chrome-stub; the alarm is **ensured on enqueue and cleared on drain-to-zero**.
- `messages.test.ts` — the queue request/response guards.
- `manifest.test.ts` — `"alarms"` present for both targets.
- `queue-view.test.ts` (jsdom) — `textContent`-only rendering, age formatting,
  empty/hidden state.
- **Manual checklist** (`docs/development.md`) — offline clip → badge increments →
  reconnect → auto-drain to zero; per-item Retry/Remove; Retry all; overflow; the
  unpaired-with-backlog state; cross-browser (Firefox).

## Scope note

This is a **larger slice than Slice 2**: a new background subsystem (queue store +
flush + alarm), two new `chrome.*` seams, one new permission, and a full popup
manager. It is expected to be ~9–11 implementation-plan tasks, but remains a single
coherent slice.

## Deferred (out of scope; possible later slices)

- **Auto-expiry / max-attempts give-up** with a "failed" state in the manager.
- **Live popup refresh** via a background→popup push when a flush changes the queue,
  and a `setInterval` ticking the relative ages while the popup is open — both polish
  for a transient popup; static "age at open" is sufficient this slice.
- **Exponential flush backoff** (2 → 5 → 10 min) on repeated `unreachable`. The
  conditional alarm already eliminates idle wakeups; a fixed 1-min cadence against a
  loopback gateway while a backlog exists is cheap, so backoff is YAGNI for now.
- **Per-payload body size cap / truncation** and `unlimitedStorage`. Bounded today by
  `MAX_QUEUE` + readable-text-only bodies + the `updateQueue` quota fail-safe.
- **Per-entry capture refresh** (re-reading the page before a late drain).
- **Clip-status pre-fetch** ("Already clipped" + prior tags) — still blocked on a
  new gateway endpoint (locked contract); unchanged from the Slice 2 deferral.

## Design review resolutions (2026-06-27)

From the Slice 3 design review (pruned once the feature shipped; see git history):

1. **Async read-modify-write race (fixed).** The "single writer" claim conflated
   single-threaded with atomic; concurrent `async` mutations interleave at `await`s
   and can lose updates. Resolved by replacing `setQueue` with a serialized
   `updateQueue(mutator)` (module-level promise lock; pure-function deltas applied to
   freshly-read state) and by having `flushQueue` apply per-entry deltas rather than
   writing a stale whole-array. See Concurrency & the flush section.
2. **Storage quota with large bodies (partially fixed; rest deferred).** `updateQueue`
   now treats the write as fallible (evict-oldest-and-retry on quota rejection, else
   fail safe). A hard per-payload byte cap / truncation is deferred — bodies are
   readable-text-only (raw-HTML archival is a non-goal), so multi-MB payloads aren't
   expected, and `MAX_QUEUE` bounds the count.
3. **Alarm cadence / battery (fixed via conditional alarm; two sub-points rejected
   or deferred).** The alarm is now scheduled only while the queue is non-empty and
   cleared on drain-to-zero, removing idle wakeups. `navigator.onLine` gating is
   **rejected**: the gateway is loopback (`127.0.0.1`), reachable with no internet, so
   that guard would wrongly block local-first draining. Exponential backoff is
   deferred as YAGNI against a loopback gateway.
4. **Safe URL navigation (clarified — no behavior change needed).** The manager
   renders no `href` (host as `textContent` only), so there is no `javascript:`-href
   surface; any future "open page" link must reuse Slice 2's `safeHttpUrl` allowlist.
   The **live-age `setInterval`** suggestion is deferred as YAGNI for a transient popup.
5. **Persistent `invalid_request` (fixed).** Such entries are kept and labelled but
   **skipped by automatic flushes** — only an explicit user Retry attempts them — so a
   permanently-rejected payload isn't re-`POST`ed every minute. See the retryability
   table and Error handling.
