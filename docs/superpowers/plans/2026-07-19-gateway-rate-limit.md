# Gateway Rate Limiting (429) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Handle the gateway's `429 rate_limited` on `POST /v1/clips` as a distinct, transient, queued outcome, and pace the offline-queue flush off the gateway's `Retry-After`.

**Architecture:** A new `rate_limited` member of `ClipError` flows from the fetch seam (`gateway-client.ts`) through the pure handler/flush logic to three user-facing surfaces. A persisted pause timestamp (`chrome.storage.local`) is written by a single `postClip` wrapper in the service worker, read as a gate by `flushQueue`, and used to re-arm the flush alarm. Pure modules gain no `chrome.*` dependency.

**Tech Stack:** TypeScript (strict, no `any`), Vitest (node env), Biome, esbuild, bun.

**Spec:** `docs/superpowers/specs/2026-07-19-gateway-rate-limit-design.md`

## Global Constraints

- TypeScript **strict**, **no `any`** — external data is `unknown`, narrowed by a type guard.
- **No `console.*` in `src/`.** Tests and `scripts/` may log.
- **Never log the bearer token or the pairing code.**
- **Loopback only** — no new host permissions, no new fetch destinations.
- No new runtime dependencies; no new extension permissions (`alarms` and `storage` are already granted).
- WebExtension APIs are touched **only** inside `src/browser/`.
- User-facing copy is identical across the popup status line and the quick-clip toast (the `#17` precedent).
- Exact copy, verbatim:
  - popup + toast: `Nimbus is busy — queued, will retry shortly.`
  - queue row label: `Nimbus is busy`
- Retry-After parsing: strict digits only; missing/non-numeric/negative → `60_000` ms; clamp to `120_000` ms.
- Alarm delay floor: `0.5` minutes (Chrome's 30s minimum).
- Green gate before "done": `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `test/unit/chrome-stub.ts` | add `alarms.get` to the fake `chrome` | 1 |
| `src/browser/alarms.ts` | idempotent `ensureAlarm`; new `rearmAlarm` | 1 |
| `src/shared/types.ts` | `ClipError` + `"rate_limited"`; new `ClipPostResult` alias | 2 |
| `src/background/gateway-client.ts` | 429 → `rate_limited` + `Retry-After` parse | 3 |
| `src/background/rate-limit-pause.ts` | **new** — persisted pause timestamp | 4 |
| `src/background/handlers.ts` | queue on `rate_limited` | 5 |
| `src/background/queue-flush.ts` | pause gate + break on `rate_limited` | 6 |
| `src/popup/popup.ts`, `src/background/quick-clip.ts`, `src/popup/queue-view.ts` | wording | 7 |
| `src/background/service-worker.ts` | paced `postClip` wrapper; alarm re-arm | 8 |
| `CHANGELOG.md` | two `### Fixed` entries | 1, 8 |

Task 1 is an independent pre-existing bugfix and lands as its own commit ahead of the 429 work.

---

### Task 1: Fix flush-alarm starvation (independent bugfix)

`chrome.alarms.create` cancels and replaces a same-named alarm, and `ensureAlarm` passes only `periodInMinutes`, whose first fire is one whole period out. `syncQueueState` runs after every clip and every queue mutation, so clipping more often than once a minute resets the countdown forever and the flush alarm never fires — the offline queue then drains only on service-worker startup.

**Files:**
- Modify: `test/unit/chrome-stub.ts:53-62` (add `alarms.get`)
- Modify: `test/unit/helpers/chrome-mock.ts:24-25,67-68,112-120,193-199` (add `alarms.get`)
- Modify: `src/browser/alarms.ts:1-8`
- Modify: `src/background/service-worker.ts:55-63` (await the now-async `ensureAlarm`)
- Modify: `CHANGELOG.md`
- Test: `test/unit/browser-seam.test.ts:56-66`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ensureAlarm(name: string, periodInMinutes: number): Promise<void>` — creates **only if absent** (note: now async; it was sync).
  - `rearmAlarm(name: string, delayInMinutes: number, periodInMinutes: number): void` — always replaces.
  - `clearAlarm(name: string): Promise<void>` — unchanged.

- [ ] **Step 1: Add `alarms.get` to the chrome stub**

In `test/unit/chrome-stub.ts`, replace the `alarms` block with one that tracks live alarms so `get` can answer truthfully:

```ts
    alarms: {
      create: (name: string, info: unknown) => {
        liveAlarms.set(name, info);
        alarmCalls.push({ create: name, info });
      },
      get: async (name: string) => {
        const info = liveAlarms.get(name);
        return info === undefined ? undefined : { name, ...(info as Record<string, unknown>) };
      },
      clear: async (name: string) => {
        liveAlarms.delete(name);
        alarmCalls.push({ clear: name });
        return true;
      },
      onAlarm: { addListener: () => undefined },
    },
```

Declare the backing map next to the other recorders (near `const alarmCalls: unknown[] = [];`):

```ts
  const liveAlarms = new Map<string, unknown>();
```

- [ ] **Step 2: Add `alarms.get` to the richer chrome mock**

`test/unit/helpers/chrome-mock.ts` is a **separate** harness used by
`service-worker.test.ts` and `popup.test.ts`. Without this the now-async
`ensureAlarm` calls `chrome.alarms.get` on an object that doesn't define it and
every service-worker test throws.

Replace the `alarmsCreate` / `alarmsClear` declarations (lines 67-68) with:

```ts
  // Track live alarms so `get` can answer truthfully — ensureAlarm depends on it.
  const liveAlarms = new Map<string, unknown>();
  const alarmsCreate = vi.fn((name: string, info: unknown): void => {
    liveAlarms.set(name, info);
  });
  const alarmsGet = vi.fn(async (name: string): Promise<unknown> => {
    const info = liveAlarms.get(name);
    return info === undefined ? undefined : { name, ...(info as Record<string, unknown>) };
  });
  const alarmsClear = vi.fn(async (name: string): Promise<boolean> => {
    liveAlarms.delete(name);
    return true;
  });
```

Add `get: alarmsGet,` to the `alarms:` object (line 112-120), add
`readonly alarmsGet: ReturnType<typeof vi.fn>;` to the `ChromeHarness` interface
(next to `alarmsCreate`, line 24), and add `alarmsGet,` to the returned object
(next to `alarmsCreate`, line 198).

- [ ] **Step 3: Write the failing tests**

Replace the `alarms seam` describe block in `test/unit/browser-seam.test.ts` with:

```ts
describe("alarms seam", () => {
  test("ensureAlarm creates a periodic alarm; clearAlarm clears it", async () => {
    const { alarmCalls } = installChromeStub();
    await ensureAlarm("flush-clip-queue", 1);
    await clearAlarm("flush-clip-queue");
    expect(alarmCalls).toEqual([
      { create: "flush-clip-queue", info: { periodInMinutes: 1 } },
      { clear: "flush-clip-queue" },
    ]);
  });

  // Regression: chrome.alarms.create REPLACES a same-named alarm, restarting its
  // countdown. syncQueueState runs after every clip, so a re-create on each call
  // would push the flush alarm out forever and the queue would never drain.
  test("ensureAlarm does not re-create an alarm that already exists", async () => {
    const { alarmCalls } = installChromeStub();
    await ensureAlarm("flush-clip-queue", 1);
    await ensureAlarm("flush-clip-queue", 1);
    await ensureAlarm("flush-clip-queue", 1);
    expect(alarmCalls).toEqual([{ create: "flush-clip-queue", info: { periodInMinutes: 1 } }]);
  });

  test("ensureAlarm creates again after the alarm is cleared", async () => {
    const { alarmCalls } = installChromeStub();
    await ensureAlarm("flush-clip-queue", 1);
    await clearAlarm("flush-clip-queue");
    await ensureAlarm("flush-clip-queue", 1);
    expect(alarmCalls.filter((c) => "create" in (c as object))).toHaveLength(2);
  });

  test("rearmAlarm always replaces, with a delay and a period", () => {
    const { alarmCalls } = installChromeStub();
    rearmAlarm("flush-clip-queue", 0.75, 1);
    rearmAlarm("flush-clip-queue", 0.5, 1);
    expect(alarmCalls).toEqual([
      { create: "flush-clip-queue", info: { delayInMinutes: 0.75, periodInMinutes: 1 } },
      { create: "flush-clip-queue", info: { delayInMinutes: 0.5, periodInMinutes: 1 } },
    ]);
  });
});
```

Update the import on line 3 to:

```ts
import { clearAlarm, ensureAlarm, rearmAlarm } from "../../src/browser/alarms.ts";
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `bun run test -- browser-seam`
Expected: FAIL — `rearmAlarm` is not exported, and the "does not re-create" test sees three `create` calls.

- [ ] **Step 5: Implement**

Replace `src/browser/alarms.ts` lines 1-8 with:

```ts
// Thin typed seam over chrome.alarms — the only place we touch the alarm API.

// create() CANCELS AND REPLACES a same-named alarm, restarting its countdown. This
// is called on every queue change, so it must be a genuine "ensure": re-creating
// would push the next fire out indefinitely and the queue would never drain.
export async function ensureAlarm(name: string, periodInMinutes: number): Promise<void> {
  const existing = await chrome.alarms.get(name);
  if (existing === undefined) {
    chrome.alarms.create(name, { periodInMinutes });
  }
}

/** Deliberately replace the alarm, firing first after `delayInMinutes`. */
export function rearmAlarm(name: string, delayInMinutes: number, periodInMinutes: number): void {
  chrome.alarms.create(name, { delayInMinutes, periodInMinutes });
}
```

In `src/background/service-worker.ts`, `syncQueueState` must now await it — change line 59 from `ensureAlarm(FLUSH_ALARM, 1);` to:

```ts
    await ensureAlarm(FLUSH_ALARM, 1);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run test -- browser-seam service-worker`
Expected: PASS.

- [ ] **Step 7: Add the changelog entry**

Under `## [Unreleased]`, add a `### Fixed` bullet (the section already exists — append to it):

```markdown
- **The offline queue could stop draining for frequent clippers.** The flush alarm
  was re-created on every queue change, and `chrome.alarms.create` replaces a
  same-named alarm and restarts its countdown — so clipping more often than once a
  minute pushed the next flush out indefinitely and queued clips drained only when
  the service worker restarted. The alarm is now created once and left alone.
```

- [ ] **Step 8: Commit**

```bash
git add src/browser/alarms.ts src/background/service-worker.ts test/unit/browser-seam.test.ts test/unit/chrome-stub.ts CHANGELOG.md
git commit -m "fix(queue): stop re-creating the flush alarm on every queue change"
```

---

### Task 2: `rate_limited` error + shared `ClipPostResult`

**Files:**
- Modify: `src/shared/types.ts:18-24`
- Modify: `src/background/gateway-client.ts:75` (use the alias)
- Modify: `src/background/handlers.ts:36-40` (use the alias)
- Modify: `src/background/queue-flush.ts:15-19` (use the alias)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ClipError` now includes `"rate_limited"`.
  - `ClipPostResult` — the single shared shape of a `postClip` result.

- [ ] **Step 1: Add the type**

In `src/shared/types.ts`, replace the `ClipError` declaration with:

```ts
export type ClipError =
  | "not_paired"
  | "unauthorized"
  | "invalid_request"
  | "payload_too_large"
  | "rate_limited"
  | "unreachable"
  | "server_error";

/**
 * The result of a clip POST. Shared by the fetch seam, the clip handler and the
 * queue flush so the optional `retryAfterMs` cannot drift between three copies.
 * Only ever set alongside `reason: "rate_limited"`.
 */
export type ClipPostResult =
  | { readonly ok: true; readonly status: "created" | "updated" }
  | { readonly ok: false; readonly reason: ClipError; readonly retryAfterMs?: number };
```

- [ ] **Step 2: Use the alias in the three declaration sites**

`src/background/gateway-client.ts` — change the `postClip` signature (line 70-75) to:

```ts
export async function postClip(
  origin: string,
  token: string,
  payload: ClipPayload,
  doFetch: FetchLike = fetch,
): Promise<ClipPostResult> {
```

and add `ClipPostResult` to the type import from `../shared/types.ts`.

`src/background/handlers.ts` — in `ClipDeps`, replace the inline `postClip` return type:

```ts
  readonly postClip: (
    origin: string,
    token: string,
    payload: ReturnType<typeof buildClipPayload>,
  ) => Promise<ClipPostResult>;
```

and add `ClipPostResult` to its type import.

`src/background/queue-flush.ts` — in `FlushDeps`:

```ts
  readonly postClip: (
    origin: string,
    token: string,
    payload: ClipPayload,
  ) => Promise<ClipPostResult>;
```

and change its type import to exactly:

```ts
import type { ClipPostResult, Connection } from "../shared/types.ts";
```

`ClipError` was referenced **only** by that inline `postClip` type, so leaving it in the import list is an unused import and Biome will fail the lint.

- [ ] **Step 3: Verify the refactor is behaviour-neutral**

Run: `bun run typecheck && bun run test`
Expected: typecheck clean, all existing tests PASS. No test changes — this step is a pure type refactor.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/background/gateway-client.ts src/background/handlers.ts src/background/queue-flush.ts
git commit -m "refactor(types): add rate_limited ClipError and share the ClipPostResult shape"
```

---

### Task 3: Map 429 and parse `Retry-After`

**Files:**
- Modify: `src/background/gateway-client.ts` (add the parser + the 429 branch)
- Test: `test/unit/gateway-client.test.ts`

**Interfaces:**
- Consumes: `ClipPostResult` (Task 2).
- Produces: `postClip` returns `{ ok: false, reason: "rate_limited", retryAfterMs: number }` on a 429. Exported for test: `parseRetryAfterMs(header: string | null): number`.

- [ ] **Step 1: Write the failing tests**

Append to the `postClip` describe block in `test/unit/gateway-client.test.ts`:

```ts
  test("429 → rate_limited with Retry-After parsed to ms", async () => {
    const res = new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "45" },
    });
    expect(await postClip(ORIGIN, "tok", payload, async () => res)).toEqual({
      ok: false,
      reason: "rate_limited",
      retryAfterMs: 45_000,
    });
  });

  test("429 without Retry-After → the full 60s window", async () => {
    const res = new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 });
    expect(await postClip(ORIGIN, "tok", payload, async () => res)).toEqual({
      ok: false,
      reason: "rate_limited",
      retryAfterMs: 60_000,
    });
  });
});

describe("parseRetryAfterMs", () => {
  test("plain delta-seconds", () => {
    expect(parseRetryAfterMs("45")).toBe(45_000);
    expect(parseRetryAfterMs(" 45 ")).toBe(45_000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  // The gateway is loopback-only and emits String(Math.ceil(seconds)); anything
  // else is untrustworthy, so fall back rather than guess. An HTTP-date would also
  // reintroduce the clock skew this design deliberately avoids.
  test("missing, non-numeric, or negative → the 60s default", () => {
    expect(parseRetryAfterMs(null)).toBe(60_000);
    expect(parseRetryAfterMs("")).toBe(60_000);
    expect(parseRetryAfterMs("soon")).toBe(60_000);
    expect(parseRetryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT")).toBe(60_000);
    expect(parseRetryAfterMs("-5")).toBe(60_000);
    expect(parseRetryAfterMs("45abc")).toBe(60_000);
  });

  test("an absurd value is clamped so it cannot wedge the queue", () => {
    expect(parseRetryAfterMs("999999")).toBe(120_000);
  });
```

Note the closing `});` placement: the first two tests go **inside** the existing `describe("postClip", ...)`, then that block closes and a new `describe("parseRetryAfterMs", ...)` opens. Update the import on line 2 to include `parseRetryAfterMs`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- gateway-client`
Expected: FAIL — `parseRetryAfterMs` is not exported; the 429 cases currently return `server_error`.

- [ ] **Step 3: Implement**

In `src/background/gateway-client.ts`, add below the timeout constants:

```ts
const DEFAULT_RETRY_AFTER_MS = 60_000; // the gateway's full rate-limit window
const MAX_RETRY_AFTER_MS = 120_000;

/**
 * Parse a `Retry-After` delta-seconds header into ms.
 *
 * Strict digits only. We deliberately do NOT accept the HTTP-date form: the only
 * writer is the loopback gateway (no proxy or CDN can interpose), and resolving a
 * date would depend on the browser and gateway clocks agreeing — the very thing
 * that makes `X-RateLimit-Reset` unusable here. Anything unparseable waits out the
 * full window; anything absurd is clamped so a bad header cannot wedge the queue.
 */
export function parseRetryAfterMs(header: string | null): number {
  if (header === null || !/^\d+$/.test(header.trim())) {
    return DEFAULT_RETRY_AFTER_MS;
  }
  return Math.min(Number(header.trim()) * 1000, MAX_RETRY_AFTER_MS);
}
```

In `postClip`, insert **after** the 413 branch and **before** the final `server_error` return:

```ts
  if (res.status === 429) {
    return {
      ok: false,
      reason: "rate_limited",
      retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
    };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- gateway-client`
Expected: PASS, including the untouched 200/400/401/413 cases.

- [ ] **Step 5: Commit**

```bash
git add src/background/gateway-client.ts test/unit/gateway-client.test.ts
git commit -m "feat(gateway): map 429 to rate_limited and parse Retry-After"
```

---

### Task 4: The persisted pause store

**Files:**
- Create: `src/background/rate-limit-pause.ts`
- Test: `test/unit/rate-limit-pause.test.ts` (new)

**Interfaces:**
- Consumes: `storageGet` / `storageSet` from `src/browser/storage.ts`.
- Produces:
  - `getPauseUntil(): Promise<number>` — epoch ms; `0` when unset or malformed.
  - `setPauseUntil(untilMs: number): Promise<void>`
  - `clearPause(): Promise<void>` — no write when nothing is stored.

- [ ] **Step 1: Write the failing test**

Create `test/unit/rate-limit-pause.test.ts`:

```ts
// test/unit/rate-limit-pause.test.ts
import { afterEach, describe, expect, test } from "vitest";
import { clearPause, getPauseUntil, setPauseUntil } from "../../src/background/rate-limit-pause.ts";
import { installChromeStub } from "./chrome-stub.ts";

afterEach(() => {
  (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
});

describe("rate-limit pause store", () => {
  test("absent key → 0", async () => {
    installChromeStub();
    expect(await getPauseUntil()).toBe(0);
  });

  test("set then get round-trips", async () => {
    installChromeStub();
    await setPauseUntil(1_700_000_000_000);
    expect(await getPauseUntil()).toBe(1_700_000_000_000);
  });

  // The stored value is external data crossing a trust boundary like any other.
  test("a malformed stored value reads as 0 rather than NaN", async () => {
    installChromeStub({ storage: { clipRateLimitPauseUntil: "soon" } });
    expect(await getPauseUntil()).toBe(0);
  });

  test("clearPause resets an active pause", async () => {
    installChromeStub();
    await setPauseUntil(1_700_000_000_000);
    await clearPause();
    expect(await getPauseUntil()).toBe(0);
  });

  // clearPause runs after EVERY successful clip; it must not write when idle.
  test("clearPause writes nothing when no pause is stored", async () => {
    const { storage } = installChromeStub();
    await clearPause();
    expect(storage.has("clipRateLimitPauseUntil")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- rate-limit-pause`
Expected: FAIL — cannot resolve `../../src/background/rate-limit-pause.ts`.

- [ ] **Step 3: Implement**

Create `src/background/rate-limit-pause.ts`:

```ts
// src/background/rate-limit-pause.ts
// When the gateway rate-limits a clip (429), we stop flushing until its Retry-After
// has elapsed. The deadline is PERSISTED, not held in memory: an MV3 service worker
// is evicted after ~30s idle and every wake runs the startup drain, so an in-memory
// pause would be lost exactly when it matters.
import { storageGet, storageSet } from "../browser/storage.ts";

const PAUSE_KEY = "clipRateLimitPauseUntil";

/** Epoch ms until which automatic flushes are paused; 0 = not paused. */
export async function getPauseUntil(): Promise<number> {
  const value = await storageGet(PAUSE_KEY);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function setPauseUntil(untilMs: number): Promise<void> {
  await storageSet(PAUSE_KEY, untilMs);
}

/**
 * Drop the pause — a successful clip proves a slot was free, so there is no reason
 * to wait out the remainder. Reads first: this runs after every successful clip and
 * the common case (no pause set) should cost no write.
 */
export async function clearPause(): Promise<void> {
  if ((await getPauseUntil()) !== 0) {
    await setPauseUntil(0);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- rate-limit-pause`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/background/rate-limit-pause.ts test/unit/rate-limit-pause.test.ts
git commit -m "feat(queue): persist the rate-limit pause deadline"
```

---

### Task 5: Queue a rate-limited clip instead of dropping it

**Files:**
- Modify: `src/background/handlers.ts:74-78`
- Test: `test/unit/handlers.test.ts`

**Interfaces:**
- Consumes: `ClipError` with `"rate_limited"` (Task 2).
- Produces: `handleClip` returns `{ kind: "clip", ok: false, reason: "rate_limited", queued: true }`.

- [ ] **Step 1: Write the failing test**

Add to the `handleClip` describe block in `test/unit/handlers.test.ts` (mirror the existing `unreachable`-enqueues test's harness):

```ts
  // 429 is transient — the window reopens within a minute — so the clip is queued
  // and auto-retried, unlike the terminal 400/413 reasons.
  test("rate_limited enqueues and reports queued", async () => {
    let queue: QueuedClip[] = [];
    const res = await handleClip(
      {
        getConnection: async () => conn,
        postClip: async () => ({ ok: false, reason: "rate_limited", retryAfterMs: 45_000 }),
        updateQueue: async (m) => {
          queue = m(queue);
          return queue;
        },
        nowMs: () => 1,
      },
      { kind: "clip", capture, tags: [] },
    );
    expect(res).toEqual({ kind: "clip", ok: false, reason: "rate_limited", queued: true });
    expect(queue).toHaveLength(1);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- handlers`
Expected: FAIL — `queued` is absent, and nothing is enqueued (the reason falls through to the terminal branch).

- [ ] **Step 3: Implement**

In `src/background/handlers.ts`, change the queueing condition (line 74):

```ts
  // Transient failures are queued and retried; 400/413 are terminal and are not.
  if (r.reason === "unreachable" || r.reason === "server_error" || r.reason === "rate_limited") {
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- handlers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background/handlers.ts test/unit/handlers.test.ts
git commit -m "feat(clip): queue a rate-limited clip for retry"
```

---

### Task 6: Flush — pause gate and break on 429

**Files:**
- Modify: `src/background/queue-flush.ts`
- Test: `test/unit/queue-flush.test.ts`

**Interfaces:**
- Consumes: `ClipPostResult` (Task 2).
- Produces: `FlushDeps` gains `pausedUntilMs: () => Promise<number>` and `nowMs: () => number`. `flushQueue(deps, opts)` signature is otherwise unchanged.

- [ ] **Step 1: Write the failing tests**

In `test/unit/queue-flush.test.ts`, add two shared defaults near the `store` helper so existing tests keep compiling:

```ts
const noPause = { pausedUntilMs: async () => 0, nowMs: () => 1000 };
```

Add `...noPause,` to the deps object of every existing `flushQueue` call in the file, then append these tests:

```ts
  test("rate_limited marks the entry and stops the round", async () => {
    const s = store([entry("a"), entry("b")]);
    let calls = 0;
    await flushQueue({
      getConnection: async () => conn,
      getQueue: s.getQueue,
      updateQueue: s.updateQueue,
      ...noPause,
      postClip: async () => {
        calls++;
        return { ok: false, reason: "rate_limited", retryAfterMs: 45_000 };
      },
    });
    expect(calls).toBe(1); // no point posting the rest into a closed window
    expect(s.current().map((e) => e.payload.url)).toEqual(["a", "b"]);
    expect(s.current()[0]?.attempts).toBe(1);
    expect(s.current()[0]?.lastReason).toBe("rate_limited");
  });

  test("an active pause makes an automatic flush a no-op", async () => {
    const s = store([entry("a")]);
    let calls = 0;
    const out = await flushQueue({
      getConnection: async () => conn,
      getQueue: s.getQueue,
      updateQueue: s.updateQueue,
      pausedUntilMs: async () => 5000,
      nowMs: () => 1000,
      postClip: async () => {
        calls++;
        return { ok: true, status: "created" };
      },
    });
    expect(calls).toBe(0);
    expect(out).toEqual({ remaining: 1 });
  });

  test("a manual retry bypasses the pause", async () => {
    const s = store([entry("a")]);
    let calls = 0;
    await flushQueue(
      {
        getConnection: async () => conn,
        getQueue: s.getQueue,
        updateQueue: s.updateQueue,
        pausedUntilMs: async () => 5000,
        nowMs: () => 1000,
        postClip: async () => {
          calls++;
          return { ok: true, status: "created" };
        },
      },
      { manual: true },
    );
    expect(calls).toBe(1);
    expect(s.current()).toEqual([]);
  });

  test("an expired pause does not block", async () => {
    const s = store([entry("a")]);
    let calls = 0;
    await flushQueue({
      getConnection: async () => conn,
      getQueue: s.getQueue,
      updateQueue: s.updateQueue,
      pausedUntilMs: async () => 500,
      nowMs: () => 1000,
      postClip: async () => {
        calls++;
        return { ok: true, status: "created" };
      },
    });
    expect(calls).toBe(1);
  });

  // rate_limited is transient, so unlike invalid_request / payload_too_large it is
  // NOT skipped by the next automatic flush.
  test("auto flush retries a rate_limited entry once the pause expires", async () => {
    const s = store([entry("a", "rate_limited")]);
    const tried: string[] = [];
    await flushQueue({
      getConnection: async () => conn,
      getQueue: s.getQueue,
      updateQueue: s.updateQueue,
      ...noPause,
      postClip: async (_o, _t, p) => {
        tried.push(p.url);
        return { ok: true, status: "created" };
      },
    });
    expect(tried).toEqual(["a"]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- queue-flush`
Expected: FAIL — the round does not stop on `rate_limited` (`calls` is 2), and the pause is ignored (`calls` is 1 where 0 is expected).

- [ ] **Step 3: Implement**

In `src/background/queue-flush.ts`, add to `FlushDeps`:

```ts
  /** Epoch ms until which automatic flushes are paused (0 = not paused). */
  readonly pausedUntilMs: () => Promise<number>;
  readonly nowMs: () => number;
```

Insert the gate immediately after the `conn === null` early return:

```ts
  // The gateway rate-limited us recently; posting again before its Retry-After has
  // elapsed just earns another 429. A manual retry is a deliberate user action and
  // is allowed to spend a slot.
  if (opts.manual !== true && deps.nowMs() < (await deps.pausedUntilMs())) {
    return { remaining: queue.length };
  }
```

Extend the break condition:

```ts
    if (r.reason === "unreachable" || r.reason === "unauthorized" || r.reason === "rate_limited") {
      break; // gateway down, token dead, or window closed — stop this round
    }
```

Update the trailing comment to read:

```ts
    // server_error / invalid_request / payload_too_large: keep the entry, continue
    // to the next (the last two are skipped by the next automatic flush)
```

(unchanged text — `rate_limited` now breaks above, so it must not be listed here).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- queue-flush`
Expected: PASS — all pre-existing tests plus the five new ones.

- [ ] **Step 5: Commit**

```bash
git add src/background/queue-flush.ts test/unit/queue-flush.test.ts
git commit -m "feat(queue): pause the flush and break the round on a 429"
```

---

### Task 7: User-facing wording on all three surfaces

**Files:**
- Modify: `src/popup/popup.ts:8-15,59-66`
- Modify: `src/background/quick-clip.ts:25-54`
- Modify: `src/popup/queue-view.ts:9-16`
- Test: `test/unit/popup.test.ts`, `test/unit/quick-clip.test.ts`, `test/unit/queue-view.test.ts`

**Interfaces:**
- Consumes: `ClipError` with `"rate_limited"` (Task 2); `handleClip`'s `queued: true` response (Task 5).
- Produces: no new exports. Copy, verbatim: `Nimbus is busy — queued, will retry shortly.` and `Nimbus is busy`.

Both `popup.ts` and `quick-clip.ts` currently short-circuit on `queued === true` to the offline text, so `rate_limited` **must** be checked ahead of that branch or the new copy is unreachable. That ordering is the substance of this task.

- [ ] **Step 1: Write the failing tests**

In `test/unit/queue-view.test.ts`, add:

```ts
  test("a rate-limited entry reads as busy, not as an error", () => {
    const li = renderQueueItem(
      document,
      { url: "https://ex.com/p", title: "T", queuedAt: 0, attempts: 2, lastReason: "rate_limited" },
      0,
    );
    expect(li.querySelector(".queue__item-status")?.textContent).toBe("Nimbus is busy · 2 tries");
  });
```

In `test/unit/quick-clip.test.ts`, add (following the file's existing `toToastState` cases):

```ts
  // Queued, but NOT the offline wording — the gateway is up, just throttling.
  test("rate_limited is the busy toast, not the offline one", () => {
    expect(
      toToastState({ kind: "clip", ok: false, reason: "rate_limited", queued: true }),
    ).toEqual({ variant: "offline", text: "Nimbus is busy — queued, will retry shortly." });
  });
```

In `test/unit/popup.test.ts`, add to the `clip error mapping` describe block, next to the existing `queued:true` test:

```ts
  // rate_limited is queued too, but the gateway is UP — it must not claim otherwise.
  test("rate_limited reports the busy status rather than the offline one", async () => {
    harness.executeScript
      .mockResolvedValueOnce([{ result: undefined }])
      .mockResolvedValueOnce([{ result: ARTICLE_CAPTURE }]);
    harness.sendMessage
      .mockResolvedValueOnce({ kind: "clip", ok: false, reason: "rate_limited", queued: true })
      .mockResolvedValueOnce({ kind: "queue", items: [] });

    click("clip-page");

    await vi.waitFor(() =>
      expect(statusText()).toBe("Nimbus is busy — queued, will retry shortly."),
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- popup quick-clip queue-view`
Expected: FAIL — all three currently produce the offline/generic text.

- [ ] **Step 3: Implement**

`src/popup/popup.ts` — add the constant above `CLIP_MESSAGES`, register it, and reorder the failure branch:

```ts
const RATE_LIMITED_MESSAGE = "Nimbus is busy — queued, will retry shortly.";

const CLIP_MESSAGES: Record<string, string> = {
  not_paired: "Pair a browser first (Options).",
  unauthorized: "Pairing expired — re-pair in Options.",
  invalid_request: "Couldn't save this page.",
  payload_too_large: "Too large for Nimbus to save.",
  rate_limited: RATE_LIMITED_MESSAGE,
  unreachable: "Can't reach Nimbus — is the gateway running?",
  server_error: "Nimbus had an error saving this.",
};
```

and replace the `else` branch body (lines 59-66) with:

```ts
  } else {
    // rate_limited is queued too, but it must not read as "Nimbus is down" — so it
    // is checked BEFORE the generic queued wording.
    let message: string;
    if (res.reason === "rate_limited") {
      message = RATE_LIMITED_MESSAGE;
    } else if (res.queued === true) {
      message = "Saved offline — will sync when Nimbus is back.";
    } else {
      message = CLIP_MESSAGES[res.reason] ?? "Couldn't save this page.";
    }
    setStatus(message);
    await refreshQueue();
  }
```

`src/background/quick-clip.ts` — add the constant, register it in `ERROR_TEXT`, and branch before the queued check:

```ts
const RATE_LIMITED_TEXT = "Nimbus is busy — queued, will retry shortly.";
```

Add to `ERROR_TEXT`: `rate_limited: RATE_LIMITED_TEXT,` and change `toToastState`'s failure path to:

```ts
  // Queued like the offline case, but the gateway is up — say so.
  if (res.reason === "rate_limited") {
    return { variant: "offline", text: RATE_LIMITED_TEXT };
  }
  if (res.queued === true) {
    return { variant: "offline", text: "Saved offline — will sync when Nimbus is back." };
  }
  return { variant: "error", text: ERROR_TEXT[res.reason] ?? "Couldn't save this page." };
```

`src/popup/queue-view.ts` — add to `REASON_LABELS`:

```ts
  rate_limited: "Nimbus is busy",
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- popup quick-clip queue-view`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/popup/popup.ts src/popup/queue-view.ts src/background/quick-clip.ts test/unit/popup.test.ts test/unit/quick-clip.test.ts test/unit/queue-view.test.ts
git commit -m "feat(ui): distinct busy wording for a rate-limited clip"
```

---

### Task 8: Wire the service worker and finish the changelog

**Files:**
- Modify: `src/background/service-worker.ts:44-67` (wrapper, deps, `syncQueueState`)
- Modify: `CHANGELOG.md`
- Test: `test/unit/service-worker.test.ts`

**Interfaces:**
- Consumes: `postClip` (Task 3), `getPauseUntil`/`setPauseUntil`/`clearPause` (Task 4), `flushQueue`'s new deps (Task 6), `ensureAlarm`/`rearmAlarm` (Task 1).
- Produces: nothing exported; this is the composition root.

- [ ] **Step 1: Write the failing tests**

Append this describe block to `test/unit/service-worker.test.ts`. It follows the
file's established shape: `await load()` **first** (empty storage, so the startup
drain is a no-op and never touches the real network), then seed storage and stub
`globalThis.fetch`.

```ts
describe("rate-limit pacing", () => {
  const PAUSE_KEY = "clipRateLimitPauseUntil";
  const NOW = 1_700_000_000_000;

  function rateLimitedRes(retryAfter: string): Response {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": retryAfter },
    });
  }

  test("a 429 clip queues it, arms the pause, and re-arms the alarm with the delay", async () => {
    // Fake ONLY Date — `settle()` relies on real setTimeout to drain the SW's
    // fire-and-forget promise chains.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    harness.alarmsCreate.mockClear();
    globalThis.fetch = vi.fn().mockResolvedValue(rateLimitedRes("45"));

    const res = await harness.emitMessage({ kind: "clip", capture, tags: [] });

    expect(res).toEqual({ kind: "clip", ok: false, reason: "rate_limited", queued: true });
    expect(harness.storage.get(PAUSE_KEY)).toBe(NOW + 45_000);
    expect(harness.alarmsCreate).toHaveBeenCalledWith(FLUSH_ALARM, {
      delayInMinutes: 0.75,
      periodInMinutes: 1,
    });
    vi.useRealTimers();
  });

  // Chrome ignores a delay under 0.5 and logs a warning, so short waits round up.
  test("a sub-30s Retry-After is clamped to the 0.5-minute alarm floor", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    harness.alarmsCreate.mockClear();
    globalThis.fetch = vi.fn().mockResolvedValue(rateLimitedRes("5"));

    await harness.emitMessage({ kind: "clip", capture, tags: [] });

    expect(harness.alarmsCreate).toHaveBeenCalledWith(FLUSH_ALARM, {
      delayInMinutes: 0.5,
      periodInMinutes: 1,
    });
    vi.useRealTimers();
  });

  test("a successful clip clears an existing pause", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    harness.storage.set(PAUSE_KEY, Date.now() + 45_000);
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(200, { id: "1", status: "created" }));

    const res = await harness.emitMessage({ kind: "clip", capture, tags: [] });

    expect(res).toEqual({ kind: "clip", ok: true, status: "created", bookmarked: false });
    expect(harness.storage.get(PAUSE_KEY)).toBe(0);
  });

  test("an alarm flush during an active pause posts nothing", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    harness.storage.set(QUEUE_KEY, [queued("https://ex.com/a")]);
    harness.storage.set(PAUSE_KEY, Date.now() + 45_000);
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(200, { id: "1", status: "created" }));
    globalThis.fetch = fetchMock;

    harness.emitAlarm(FLUSH_ALARM);
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.storage.get(QUEUE_KEY)).toHaveLength(1);
  });

  test("an alarm flush after the pause expires drains the queue", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    harness.storage.set(QUEUE_KEY, [queued("https://ex.com/a")]);
    harness.storage.set(PAUSE_KEY, Date.now() - 1000);
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(200, { id: "1", status: "created" }));

    harness.emitAlarm(FLUSH_ALARM);
    await settle();

    expect(harness.storage.get(QUEUE_KEY)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- service-worker`
Expected: FAIL — nothing writes the pause key and the alarm carries no delay.

- [ ] **Step 3: Implement**

In `src/background/service-worker.ts`, add the imports:

```ts
import { addAlarmListener, clearAlarm, ensureAlarm, rearmAlarm } from "../browser/alarms.ts";
import { clearPause, getPauseUntil, setPauseUntil } from "./rate-limit-pause.ts";
```

Replace the `flushDeps` line (44-45) with the paced wrapper and both dep bundles:

```ts
const FLUSH_ALARM = "flush-clip-queue";

// The one place the rate-limit pause is written. Wrapping the seam — rather than
// threading a dependency through handleClip and flushQueue — keeps both of those
// pure and means a 429 from EITHER path (interactive clip or queue drain) paces the
// next drain. A storage failure here must never fail the clip itself.
const postClipPaced: typeof postClip = async (origin, token, payload) => {
  const r = await postClip(origin, token, payload);
  if (r.ok) {
    await clearPause().catch(() => undefined);
  } else if (r.reason === "rate_limited") {
    await setPauseUntil(Date.now() + (r.retryAfterMs ?? 60_000)).catch(() => undefined);
  }
  return r;
};

const flushDeps = {
  getConnection,
  getQueue,
  updateQueue,
  postClip: postClipPaced,
  pausedUntilMs: getPauseUntil,
  nowMs: () => Date.now(),
};
```

Change `clipDeps` (line 67) to use the wrapper:

```ts
const clipDeps = { getConnection, postClip: postClipPaced, updateQueue, nowMs: () => Date.now() };
```

Replace `syncQueueState` with:

```ts
// Reconcile the toolbar badge and the flush alarm with the current queue length:
// the alarm exists only while there is work to do (no idle wakeups). While a
// rate-limit pause is active the alarm is re-armed to fire at the gateway's own
// reset time instead of an arbitrary point in the fixed one-minute cadence.
async function syncQueueState(): Promise<void> {
  const n = (await getQueue()).length;
  await setBadgeCount(n);
  if (n === 0) {
    await clearAlarm(FLUSH_ALARM);
    return;
  }
  const remainingMs = (await getPauseUntil()) - Date.now();
  if (remainingMs > 0) {
    // Chrome honours a 30s floor (values under 0.5 are ignored and warn), so a
    // shorter Retry-After rounds up. An early or late tick is harmless — the pause
    // gate in flushQueue no-ops it.
    rearmAlarm(FLUSH_ALARM, Math.max(0.5, remainingMs / 60_000), 1);
    return;
  }
  await ensureAlarm(FLUSH_ALARM, 1);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- service-worker`
Expected: PASS.

- [ ] **Step 5: Add the changelog entry**

Under `## [Unreleased]` → `### Fixed`, add (alongside Task 1's entry):

```markdown
- **Clips are no longer lost or hammered when the gateway rate-limits.** The
  gateway caps `POST /v1/clips` at 20/min and answers `429` with a `Retry-After`;
  this was previously mapped to the generic `server_error`, so the popup reported a
  server failure and the offline queue re-POSTed every entry on the next tick. A
  `429` is now a distinct `rate_limited` reason: the clip is queued (it is
  transient, not terminal), the popup and quick-clip toast both say "Nimbus is busy
  — queued, will retry shortly.", the flush stops the round on the first `429`
  instead of draining into a closed window, and the next flush is paced off the
  gateway's `Retry-After` rather than the fixed one-minute alarm. A successful clip
  clears the pause early.
```

- [ ] **Step 6: Run the full green gate**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
Expected: all five pass. Report the actual output — do not claim done without it.

- [ ] **Step 7: Commit**

```bash
git add src/background/service-worker.ts test/unit/service-worker.test.ts CHANGELOG.md
git commit -m "feat(queue): pace clip flushes off the gateway's Retry-After"
```

---

## Manual verification (add to `docs/development.md`)

Not unit-testable; run once against a live gateway before the release tag:

1. Pair the extension, then clip 25 distinct pages in under a minute (the cap is 20/min).
2. Expect: the first ~20 save; the rest show **"Nimbus is busy — queued, will retry shortly."** and appear in the popup queue labelled **"Nimbus is busy"**.
3. Expect: the badge count stops growing and the queue drains on its own within ~1–2 minutes, with no burst of failures in the gateway's audit log.
4. Press **Retry all** while paused — it should attempt immediately rather than wait.
