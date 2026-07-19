# Gateway Rate Limiting (429) — Design

**Date:** 2026-07-19
**Status:** Approved (brainstorming) — ready for implementation plan

## Goal

Handle the gateway's `429 rate_limited` response on `POST /v1/clips` as a
first-class, transient outcome: a distinct `rate_limited` clip error, a queued
(not lost) clip, an offline-queue flush that stops the round instead of hammering,
and a next flush paced off the gateway's `Retry-After` rather than the fixed
one-minute alarm.

## The gateway behaviour we are building against

Verified against the Nimbus monorepo source (`packages/gateway/src/ipc/`), not
against prose:

- **20 requests/min for `POST /v1/clips`**; every other write route stays 60/min
  (`http-write-routes.ts` — `MAX_REQUESTS_PER_WINDOW_CLIP` / `_DEFAULT`). The
  window is 60 000 ms, fixed at server construction.
- It is a **sliding-window log**, not a fixed bucket — there is no boundary reset.
- The clip bucket is keyed on the **constant fingerprint `"clip"`**, computed
  *before* the clip token is verified. The 20/min budget is therefore **global
  across every paired device**, not per-token and not per-IP.
- On refusal: status **429**, body exactly `{"error":"rate_limited"}`, headers
  `Retry-After` (**delta-seconds**, e.g. `"45"`), plus
  `X-RateLimit-Limit` / `-Remaining` / `-Reset`. `X-RateLimit-Reset` is an
  **absolute Unix epoch second**, not a delta.
- The `X-RateLimit-*` trio rides on every response emitted *after* the limit
  check, including `200`s and the `413`.
- The rate limit runs **before** the body cap, so a `413` consumes a slot; a
  refused `429` does **not** consume one (no self-extending lockout).
- The limiter is in-memory and per-process: a gateway restart clears all buckets.

## Non-goals

- **Proactive pacing off `X-RateLimit-Remaining`.** Breaking the flush round on
  the first 429 already bounds a round to ~21 requests, and a refused request
  costs the client nothing at the gateway, so reading the remaining-count on 200s
  buys no headroom for real complexity.
- **`/pair/confirm` and `/related` 429 handling.** Both sit at 60/min; pairing is
  a single deliberate user action and related is one query per panel open.
  Neither can plausibly reach the limit, and inventing a `PairError` /
  `RelatedError` variant for it is speculative.
- **Surfacing the remaining wait to the user** ("retry in 45s"). The pause is at
  most 60s and the queue drains itself; a live countdown is UI churn.
- **HTTP-date `Retry-After` parsing.** `host_permissions` is loopback-only, so no
  CDN or proxy can interpose a differently-formatted header; the only writer is
  the gateway's `String(Math.ceil(...))`. Parsing a date would also reintroduce
  the clock-skew dependence this design rejects `X-RateLimit-Reset` for. A
  non-numeric value already falls back to 60s.
- **Syncing pause state to the popup via `storage.onChanged`.** Nothing renders
  the pause; the queue list already refreshes on open and after each action. This
  becomes real only if a "retrying in Ns" affordance is ever added.
- **Changing the gateway HTTP contract.** Client-only.

## Constraints (non-negotiable)

- Locked contract, loopback-only, bearer token never logged — unchanged.
- TypeScript strict, no `any`; no `console.*` in `src/`; Biome clean.
- Pure logic stays out of the `chrome.*` seam so it remains unit-testable.

## Architecture

### 1. Wire seam — `background/gateway-client.ts`

`postClip` maps `429` → `{ ok: false, reason: "rate_limited", retryAfterMs }`.

We read **`Retry-After`**, deliberately *not* `X-RateLimit-Reset`: Reset is an
absolute epoch second and would misfire whenever the browser and gateway clocks
disagree, while a delta is clock-independent. Parse rules:

- integer seconds → `retryAfterMs`;
- missing, non-numeric, or negative → **60 000 ms** (the full window);
- clamped to a **120 000 ms** maximum, so a buggy or hostile header cannot wedge
  the queue indefinitely.

The `postClip` result type is currently written inline in three places
(`gateway-client.ts`, `ClipDeps` in `handlers.ts`, `FlushDeps` in
`queue-flush.ts`). The failure arm now carries an optional field, and silent
drift between three copies is a real hazard — so it is extracted to one exported
`ClipPostResult` alias in `shared/types.ts` and referenced from all three.

### 2. Error model — `shared/types.ts`

`ClipError` gains `"rate_limited"`. It is **transient**: `handleClip` queues it
alongside `unreachable` / `server_error`, and it is **not** added to
`queue-flush`'s auto-skip list (which exists for the terminal `invalid_request` /
`payload_too_large`).

### 3. The pause is set at the seam, not in the pure logic

The service worker wraps the shared `postClip` dependency exactly once:

```
postClipPaced(origin, token, payload):
  r = postClip(origin, token, payload)
  if r is rate_limited:  setPauseUntil(now() + r.retryAfterMs)
  if r is ok:            clearPause()          # a 200 proves a slot was free
  return r
```

A success **clears** the pause rather than letting it expire: a 200 is direct
evidence the window has room, so waiting out the remainder would be dead time.
This covers the popup's manual retry (which bypasses the gate and may well
succeed) without special-casing it. `clearPause` reads before writing, so the
common case — a successful clip with no pause set — costs no storage write.

On a fresh 429 the **newest** `Retry-After` wins, even when it is shorter than a
pause already stored. The value is computed from the gateway's live sliding
window, so the latest response is the authoritative one; taking the maximum would
idle longer than the gateway asked for.

Both the interactive clip path (`clipDeps`) and the flush path (`flushDeps`) are
built on that one wrapper, so a 429 from *either* arms the pause, and
`handlers.ts` / `queue-flush.ts` stay pure with no new pause-writing dependency.

`background/rate-limit-pause.ts` (new) is a tiny store over `chrome.storage.local`
beside the queue: `getPauseUntil(): Promise<number>` and
`setPauseUntil(ms): Promise<void>`. It is persisted rather than held in memory
because an MV3 service worker is evicted after ~30s idle and every subsequent
wake runs the startup drain — an in-memory pause would be silently lost exactly
when it matters.

### 4. Flush — `background/queue-flush.ts`

- **Gate:** new `pausedUntilMs` and `nowMs` deps. When `now < pausedUntil` and
  `opts.manual !== true`, return `{ remaining }` without posting anything. The
  popup's per-item Retry and Retry-all pass `manual: true` and so bypass the gate
  — a deliberate user action is allowed to spend a slot.
- **Break:** a `rate_limited` result marks the entry (`markAttempt`) and then
  `break`s the round, exactly as `unreachable` / `unauthorized` already do. There
  is no point posting the rest of the queue into a closed window.

### 5. Alarm — `browser/alarms.ts` + `service-worker.ts`

While a pause is active, `syncQueueState` arms the flush alarm with
`{ delayInMinutes: max(0.5, remainingMs / 60000), periodInMinutes: 1 }`, so the
next tick lands at the gateway's own reset time instead of an arbitrary point in
the fixed one-minute cadence.

**Alarm granularity.** Chrome honours a 30-second floor: values below `0.5` are
"not honored and cause a warning" ([alarms
reference](https://developer.chrome.com/docs/extensions/reference/api/alarms)),
lowered from one minute in Chrome 120. Firefox documents no floor. Hence the
`0.5` clamp — a `Retry-After` under 30s is rounded up rather than tripping a
console warning, and a packed Chrome build may therefore resume up to ~30s late.
That is harmless: the pause gate makes an early or late tick a no-op, and the
periodic alarm re-arms it. Note that an **unpacked** extension has no floor at
all, so sub-30s timing looks exact under `bun run watch` and silently degrades in
the shipped zip — never tune this against a dev load.

**Pre-existing bug fixed here.** `chrome.alarms.create` with an existing name
"will be cancelled and replaced by this alarm", and `ensureAlarm(FLUSH_ALARM, 1)`
passes only `periodInMinutes`, whose first fire is one whole period out. Because
`syncQueueState` runs after every clip and every queue mutation, a user clipping
more often than once a minute resets the countdown each time and the flush alarm
can **never fire** — the offline queue would then drain only on service-worker
startup. This is independent of rate limiting (it dates from Slice 3), but the
pacing work re-arms the alarm more often and would worsen it, so it is fixed as
part of this change:

- `ensureAlarm(name, periodInMinutes)` becomes genuinely idempotent — it consults
  `chrome.alarms.get(name)` and creates only when the alarm is absent.
- `rearmAlarm(name, delayInMinutes, periodInMinutes)` (new) is the explicit
  replace, used only for the deliberate pause re-arm.

## User-facing wording

One vocabulary across all three surfaces, following the `#17` precedent that the
popup status line and the quick-clip toast must not invent separate words for the
same outcome:

| Surface | Text |
|---|---|
| Popup status (`popup.ts` `CLIP_MESSAGES`) | `Nimbus is busy — queued, will retry shortly.` |
| Quick-clip toast (`quick-clip.ts` `toToastState`), variant `offline` | `Nimbus is busy — queued, will retry shortly.` |
| Queue row (`queue-view.ts` `REASON_LABELS`) | `Nimbus is busy` |

Both `popup.ts` and `quick-clip.ts` currently short-circuit on `queued === true`
straight to the offline text, so each must check `rate_limited` **ahead of** that
branch — otherwise the new wording is unreachable.

The wording says "Nimbus is busy", not "you are clipping too fast", precisely
because the bucket is global: another paired device may have spent the budget, so
blaming the user would often be wrong.

## Error handling / edge cases

- **429 on an interactive clip** (popup or quick-clip) → queued, busy wording, and
  the pause is armed by the seam wrapper, so the follow-up flush waits.
- **`Retry-After` missing or garbage** → 60s default (the full window).
- **Absurd `Retry-After`** (e.g. `999999`) → clamped to 120s.
- **Gateway restarted during a pause** → the bucket is cleared server-side but the
  client still waits out its pause; worst case is one wasted minute, and the
  popup's manual Retry bypasses it immediately — and its success then clears the
  pause for the automatic path too.
- **Queue larger than the budget** (e.g. 40 entries, 20/min) → the round posts
  until the first 429, breaks, and paces; successive rounds drain the rest.
- **A 413 consumes a slot** — already terminal and auto-skipped after `#17`, so an
  oversized entry cannot repeatedly burn budget on automatic flushes.

## Testing

**Unit (Vitest):**

- `gateway-client.test.ts` — 429 → `rate_limited`; `Retry-After` parsed to ms;
  missing / non-numeric / negative → 60 000; oversized → clamped to 120 000;
  existing 200/400/401/413 mappings unchanged.
- `handlers.test.ts` — `rate_limited` enqueues and responds
  `{ ok: false, reason: "rate_limited", queued: true }`.
- `queue-flush.test.ts` — `rate_limited` marks the entry and **stops** the round
  (call count, mirroring the `unreachable` test); the pause gate no-ops an
  automatic flush and is **bypassed** by `manual: true`; a `rate_limited` entry is
  **not** auto-skipped on the next round once the pause expires.
- `rate-limit-pause.test.ts` (new) — get/set round-trip, absent key → `0`, and
  `clearPause` performs no write when no pause is stored.
- `browser-seam.test.ts` — `ensureAlarm` does **not** re-create an alarm that
  already exists (the countdown-reset starvation guard), and `rearmAlarm` does.
- `popup.test.ts` / `quick-clip.test.ts` — the busy wording wins over the generic
  queued text on both surfaces, and the two strings are identical.
- `queue-view.test.ts` — the `Nimbus is busy` row label.
- `service-worker.test.ts` — a `rate_limited` post arms the pause via the wrapper
  and re-arms the flush alarm with the delay (clamped to `0.5`); a successful post
  clears the pause.

**Green gate:** `bun run typecheck && bun run lint && bun run test && bun run
build && bun run check-build`.

## File structure

- **Create:** `src/background/rate-limit-pause.ts`;
  `test/unit/rate-limit-pause.test.ts`.
- **Modify:** `src/shared/types.ts` (`ClipError` + `ClipPostResult`),
  `src/background/gateway-client.ts` (429 mapping + `Retry-After`),
  `src/background/handlers.ts` (queue on `rate_limited`, use `ClipPostResult`),
  `src/background/queue-flush.ts` (gate + break, use `ClipPostResult`),
  `src/background/service-worker.ts` (paced `postClip` wrapper, alarm delay),
  `src/browser/alarms.ts` (idempotent `ensureAlarm` + new `rearmAlarm`),
  `src/popup/popup.ts`, `src/background/quick-clip.ts`,
  `src/popup/queue-view.ts` (wording), `CHANGELOG.md`.
