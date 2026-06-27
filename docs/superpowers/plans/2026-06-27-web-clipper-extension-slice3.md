# Web Clipper Extension — Slice 3 (Offline retry queue) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a local offline retry queue — clips that fail because the gateway is unreachable are persisted, drained automatically by a `chrome.alarms` flush, surfaced by a toolbar badge, and managed from an in-popup queue manager.

**Architecture:** A new background subsystem owns a `QueuedClip[]` in `chrome.storage.local`. `handleClip` enqueues on a *transient* failure (`unreachable`/`server_error`) and the service worker drains the queue via `flushQueue` — woken by a `chrome.alarms` alarm (live only while the queue is non-empty), on SW startup, and by popup Retry buttons. All queue writes go through a **serialized** `updateQueue(mutator)` (a module-level promise lock) applying pure `QueuedClip[] → QueuedClip[]` deltas, so concurrent SW/alarm/popup mutations can't lose updates. Pure logic (queue ops, view builders) is unit-tested; the SW glue and popup DOM wiring are dev-loaded / manual, as in Slices 1–2.

**Tech Stack:** TypeScript 6 strict, esbuild (run via `bun`), Vitest (+ jsdom for the DOM-builder tests), Biome. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-06-27-web-clipper-extension-slice3-design.md` (and its design-review resolutions). Builds on Slices 1–2. The HTTP contract is locked by Nimbus PR #718 (`POST /v1/clips`, **unchanged**).

## Global Constraints

- **TypeScript strict; no `any`.** Cross-boundary data (storage values, SW messages) is `unknown`, narrowed by a type guard. Biome enforces `noExplicitAny`, `noNonNullAssertion`, `useConst`.
- **No `console.*` in `src/`** (Biome `noConsole`). Tests and `scripts/` may log.
- **Never log or DOM-expose the bearer token or pairing code.** The token stays in the connection store + SW; it is **never** stored in the queue — `flushQueue` re-reads it from `getConnection()` at drain time.
- **Loopback only.** No new `host_permissions`; no new fetch destinations. The queue replays `postClip` against the stored `Connection.origin`. `navigator.onLine` is **not** used to gate flushes (the gateway is on `127.0.0.1`, reachable with no internet).
- **DOM-XSS backstop:** every gateway/page-influenced string (`title`, host) renders via `Element.textContent` / `createElement` — **never `innerHTML`**. The manager renders **no `href`** (host as text only).
- **Only one new permission:** `"alarms"`. The badge uses `chrome.action`, which needs no permission.
- **`exactOptionalPropertyTypes` is on** — build optional fields by conditional spread, never assign `undefined`.
- **Each task ends green:** `bun run typecheck && bun run lint && bun run test` must pass before its commit. Run `bun run build && bun run check-build` on tasks that touch the build/manifest (Tasks 7, 10).
- **Run via `bun`.** Tests: `bunx vitest run <file>`. Lint: `bun run lint`. Typecheck: `bun run typecheck`.
- **Merge imports when appending tests/code.** When a task appends code whose `import` duplicates a module already imported at the top of that file, **merge the new bindings into the existing import statement** — Biome requires a single import per module and `bun run lint` fails otherwise.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/shared/queue.ts` (new) | `QueuedClip`/`QueuedClipView`/`MAX_QUEUE` + pure `enqueue`/`removeFromQueue`/`markAttempt`/`toView` + `isQueuedClip`. |
| `src/background/clip-queue-store.ts` (new) | `getQueue` + serialized `updateQueue(mutator)` with quota fail-safe over `chrome.storage.local`. |
| `src/background/queue-flush.ts` (new) | `flushQueue(deps, opts)` — drain orchestration. |
| `src/browser/alarms.ts` (new) | `ensureAlarm`/`clearAlarm`/`addAlarmListener` over `chrome.alarms`. |
| `src/browser/action.ts` (new) | `setBadgeCount`/`setBadgeBackground` over `chrome.action`. |
| `src/popup/queue-view.ts` (new) | `textContent`-only DOM builders + `hostOf`/`formatAge` (jsdom-tested). |
| `src/shared/messages.ts` (modify) | Queue request/response envelope + guards; `ClipResponse` gains `queued?`. |
| `src/background/handlers.ts` (modify) | `handleClip` enqueues on transient failure; add `handleQueueList`/`handleQueueRetry`/`handleQueueRemove`. |
| `src/background/service-worker.ts` (modify) | Route queue messages; alarm listener + startup flush; badge + alarm lifecycle. |
| `src/popup/popup.{html,ts,css}` (modify) | Queue-manager section + wiring. |
| `src/manifest/manifest.ts` (modify) | Add the `"alarms"` permission. |
| `test/unit/chrome-stub.ts` (modify) | Record `alarms`/`action` calls; optional `failFirstSet`. |
| `docs/development.md` (modify) | Slice-3 manual checklist. |
| `CHANGELOG.md` (modify) | Slice 3 under `[Unreleased]`. |

---

## Task 1: Queue types + pure operations

**Files:**
- Create: `src/shared/queue.ts`
- Test: `test/unit/queue.test.ts`

**Interfaces:**
- Consumes: `ClipPayload` (`./clip.ts`), `ClipError` (`./types.ts`).
- Produces:
  - `interface QueuedClip { payload: ClipPayload; queuedAt: number; attempts: number; lastReason?: ClipError }`
  - `interface QueuedClipView { url: string; title: string; queuedAt: number; attempts: number; lastReason?: ClipError }`
  - `const MAX_QUEUE = 50`
  - `enqueue(queue: QueuedClip[], entry: QueuedClip): QueuedClip[]`
  - `removeFromQueue(queue: QueuedClip[], url: string): QueuedClip[]`
  - `markAttempt(queue: QueuedClip[], url: string, reason: ClipError): QueuedClip[]`
  - `toView(entry: QueuedClip): QueuedClipView`
  - `isQueuedClip(v: unknown): v is QueuedClip`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/queue.test.ts
import { describe, expect, test } from "vitest";
import {
  enqueue,
  isQueuedClip,
  MAX_QUEUE,
  markAttempt,
  removeFromQueue,
  toView,
} from "../../src/shared/queue.ts";
import type { QueuedClip } from "../../src/shared/queue.ts";

function entry(url: string, overrides: Partial<QueuedClip> = {}): QueuedClip {
  return {
    payload: {
      url,
      title: `T ${url}`,
      mode: "article",
      body: "b",
      tags: [],
      capturedAt: 1,
    },
    queuedAt: 1,
    attempts: 0,
    ...overrides,
  };
}

describe("enqueue", () => {
  test("appends a new entry", () => {
    expect(enqueue([], entry("a")).map((e) => e.payload.url)).toEqual(["a"]);
  });
  test("replaces an existing entry with the same url (dedup, last-write-wins)", () => {
    const q = enqueue([entry("a"), entry("b")], entry("a", { attempts: 9 }));
    expect(q.map((e) => e.payload.url)).toEqual(["b", "a"]);
    expect(q[1]?.attempts).toBe(9);
  });
  test("evicts the oldest when over MAX_QUEUE", () => {
    let q: QueuedClip[] = [];
    for (let i = 0; i < MAX_QUEUE + 5; i++) {
      q = enqueue(q, entry(`u${i}`));
    }
    expect(q.length).toBe(MAX_QUEUE);
    expect(q[0]?.payload.url).toBe("u5");
  });
});

describe("removeFromQueue", () => {
  test("drops the entry with the matching url", () => {
    expect(removeFromQueue([entry("a"), entry("b")], "a").map((e) => e.payload.url)).toEqual(["b"]);
  });
});

describe("markAttempt", () => {
  test("increments attempts and sets lastReason on the matching entry only", () => {
    const q = markAttempt([entry("a"), entry("b")], "a", "unreachable");
    expect(q[0]).toMatchObject({ attempts: 1, lastReason: "unreachable" });
    expect(q[1]).toMatchObject({ attempts: 0 });
    expect("lastReason" in (q[1] ?? {})).toBe(false);
  });
});

describe("toView", () => {
  test("projects without the body; omits lastReason when absent", () => {
    expect(toView(entry("a"))).toEqual({ url: "a", title: "T a", queuedAt: 1, attempts: 0 });
  });
  test("includes lastReason when present", () => {
    expect(toView(entry("a", { lastReason: "server_error" })).lastReason).toBe("server_error");
  });
});

describe("isQueuedClip", () => {
  test("accepts a well-formed entry", () => {
    expect(isQueuedClip(entry("a"))).toBe(true);
  });
  test("rejects a bad payload, missing fields, and non-objects", () => {
    expect(isQueuedClip({ ...entry("a"), payload: { url: 1 } })).toBe(false);
    expect(isQueuedClip({ payload: entry("a").payload, attempts: 0 })).toBe(false);
    expect(isQueuedClip(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/queue.test.ts`
Expected: FAIL — module `../../src/shared/queue.ts` not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/shared/queue.ts
// The offline retry queue's data model and pure operations. Every op is a
// QueuedClip[] -> QueuedClip[] transform so it composes as a mutator passed to the
// serialized updateQueue in clip-queue-store (each write applies to fresh state).
import type { ClipPayload } from "./clip.ts";
import type { ClipError } from "./types.ts";

export interface QueuedClip {
  readonly payload: ClipPayload;
  readonly queuedAt: number;
  readonly attempts: number;
  readonly lastReason?: ClipError;
}

/** What the popup sees — the (potentially large) body is never sent to the popup. */
export interface QueuedClipView {
  readonly url: string;
  readonly title: string;
  readonly queuedAt: number;
  readonly attempts: number;
  readonly lastReason?: ClipError;
}

/** Bound the queue so storage and serialization stay cheap. */
export const MAX_QUEUE = 50;

/** Replace-by-URL (dedup, last-write-wins) then evict the oldest over the cap. */
export function enqueue(queue: QueuedClip[], entry: QueuedClip): QueuedClip[] {
  const deduped = queue.filter((e) => e.payload.url !== entry.payload.url);
  deduped.push(entry);
  return deduped.length > MAX_QUEUE ? deduped.slice(deduped.length - MAX_QUEUE) : deduped;
}

export function removeFromQueue(queue: QueuedClip[], url: string): QueuedClip[] {
  return queue.filter((e) => e.payload.url !== url);
}

export function markAttempt(queue: QueuedClip[], url: string, reason: ClipError): QueuedClip[] {
  return queue.map((e) =>
    e.payload.url === url ? { ...e, attempts: e.attempts + 1, lastReason: reason } : e,
  );
}

export function toView(entry: QueuedClip): QueuedClipView {
  return {
    url: entry.payload.url,
    title: entry.payload.title,
    queuedAt: entry.queuedAt,
    attempts: entry.attempts,
    ...(entry.lastReason !== undefined ? { lastReason: entry.lastReason } : {}),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isClipPayload(v: unknown): v is ClipPayload {
  return (
    isObject(v) &&
    typeof v["url"] === "string" &&
    (v["canonicalUrl"] === undefined || typeof v["canonicalUrl"] === "string") &&
    typeof v["title"] === "string" &&
    (v["mode"] === "article" || v["mode"] === "selection") &&
    typeof v["body"] === "string" &&
    Array.isArray(v["tags"]) &&
    v["tags"].every((t) => typeof t === "string") &&
    typeof v["capturedAt"] === "number"
  );
}

export function isQueuedClip(v: unknown): v is QueuedClip {
  return (
    isObject(v) &&
    isClipPayload(v["payload"]) &&
    typeof v["queuedAt"] === "number" &&
    typeof v["attempts"] === "number" &&
    (v["lastReason"] === undefined || typeof v["lastReason"] === "string")
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/queue.ts test/unit/queue.test.ts
git commit -m "feat(queue): QueuedClip model + pure enqueue/remove/markAttempt/toView + guard"
```

---

## Task 2: Clip-queue store (serialized updateQueue)

**Files:**
- Create: `src/background/clip-queue-store.ts`
- Modify: `test/unit/chrome-stub.ts` (add a `failFirstSet` option so the quota fail-safe is testable)
- Test: `test/unit/clip-queue-store.test.ts`

**Interfaces:**
- Consumes: `storageGet`/`storageSet` (`../browser/storage.ts`); `isQueuedClip`/`enqueue`/`QueuedClip` (`../shared/queue.ts`).
- Produces:
  - `getQueue(): Promise<QueuedClip[]>`
  - `updateQueue(mutator: (q: QueuedClip[]) => QueuedClip[]): Promise<QueuedClip[]>`

- [ ] **Step 1: Extend the chrome-stub to allow an injected set failure**

In `test/unit/chrome-stub.ts`, add `failFirstSet?: boolean` to `StubOptions`:

```typescript
interface StubOptions {
  storage?: Record<string, unknown>;
  tab?: { id?: number; url?: string; title?: string };
  executeResults?: Array<{ result?: unknown }>;
  failFirstSet?: boolean;
}
```

Inside `installChromeStub`, declare a counter above `const fake = {` and make `set` honor it:

```typescript
  let failsLeft = opts.failFirstSet ? 1 : 0;
```

Replace the `storage.local.set` line with:

```typescript
        set: async (items: Record<string, unknown>) => {
          if (failsLeft > 0) {
            failsLeft--;
            throw new Error("QUOTA_BYTES quota exceeded");
          }
          for (const [k, v] of Object.entries(items)) storage.set(k, v);
        },
```

- [ ] **Step 2: Write the failing test**

```typescript
// test/unit/clip-queue-store.test.ts
import { afterEach, describe, expect, test } from "vitest";
import { getQueue, updateQueue } from "../../src/background/clip-queue-store.ts";
import { enqueue } from "../../src/shared/queue.ts";
import type { QueuedClip } from "../../src/shared/queue.ts";
import { installChromeStub } from "./chrome-stub.ts";

afterEach(() => {
  (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
});

function entry(url: string): QueuedClip {
  return {
    payload: { url, title: url, mode: "article", body: "b", tags: [], capturedAt: 1 },
    queuedAt: 1,
    attempts: 0,
  };
}

describe("getQueue", () => {
  test("returns [] when unset or malformed; keeps only well-formed entries", async () => {
    installChromeStub();
    expect(await getQueue()).toEqual([]);
    installChromeStub({ storage: { clipQueue: [entry("a"), { bad: true }] } });
    expect((await getQueue()).map((e) => e.payload.url)).toEqual(["a"]);
  });
});

describe("updateQueue", () => {
  test("applies the mutator and persists", async () => {
    installChromeStub({ storage: { clipQueue: [] } });
    const out = await updateQueue((q) => enqueue(q, entry("a")));
    expect(out.map((e) => e.payload.url)).toEqual(["a"]);
    expect((await getQueue()).map((e) => e.payload.url)).toEqual(["a"]);
  });

  test("serializes concurrent read-modify-writes (no lost update)", async () => {
    // Both calls are invoked synchronously, so without the lock both reads would see
    // [] at the first await and each write a single entry — the result would be ["a"]
    // or ["b"], never ["a","b"]. This assertion therefore fails the moment the
    // promise-chain lock is removed (a real regression guard, not just a happy path).
    installChromeStub({ storage: { clipQueue: [] } });
    const p1 = updateQueue((q) => enqueue(q, entry("a")));
    const p2 = updateQueue((q) => enqueue(q, entry("b")));
    await Promise.all([p1, p2]);
    expect((await getQueue()).map((e) => e.payload.url)).toEqual(["a", "b"]);
  });

  test("quota fail-safe: on a write rejection while growing, evicts oldest and retries", async () => {
    installChromeStub({ failFirstSet: true, storage: { clipQueue: [entry("a"), entry("b")] } });
    const out = await updateQueue((q) => enqueue(q, entry("c")));
    expect(out.map((e) => e.payload.url)).toEqual(["b", "c"]);
    expect((await getQueue()).map((e) => e.payload.url)).toEqual(["b", "c"]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bunx vitest run test/unit/clip-queue-store.test.ts`
Expected: FAIL — module `../../src/background/clip-queue-store.ts` not found.

- [ ] **Step 4: Write the implementation**

```typescript
// src/background/clip-queue-store.ts
// The offline queue's persistence. Exposes a read (getQueue) and a *serialized*
// read-modify-write (updateQueue). The SW is single-threaded but not single-task:
// an alarm flush and a popup message both await storage and would otherwise clobber
// each other. updateQueue chains every mutation on a module-level promise so each
// runs against freshly-read state — the single-writer guarantee.
import { storageGet, storageSet } from "../browser/storage.ts";
import { isQueuedClip, type QueuedClip } from "../shared/queue.ts";

const QUEUE_KEY = "clipQueue";

export async function getQueue(): Promise<QueuedClip[]> {
  const value = await storageGet(QUEUE_KEY);
  return Array.isArray(value) ? value.filter(isQueuedClip) : [];
}

let chain: Promise<unknown> = Promise.resolve();

export function updateQueue(
  mutator: (q: QueuedClip[]) => QueuedClip[],
): Promise<QueuedClip[]> {
  const next = chain.then(async () => {
    const current = await getQueue();
    let desired = mutator(current);
    try {
      await storageSet(QUEUE_KEY, desired);
    } catch {
      // Quota fail-safe: if this write grew the queue, drop the oldest entry and
      // retry once. If it still fails (or wasn't a growth), surface by throwing —
      // the prior persisted queue is left intact (we never wrote a partial array).
      if (desired.length > current.length && desired.length > 1) {
        desired = desired.slice(1);
        await storageSet(QUEUE_KEY, desired);
      } else {
        throw new Error("clip queue write failed");
      }
    }
    return desired;
  });
  // Keep the lock chain alive whether or not this call resolved or rejected.
  chain = next.catch(() => undefined);
  return next;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bunx vitest run test/unit/clip-queue-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint + full test (the stub change touches shared test infra)**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS (the `failFirstSet` option is additive; existing tests omit it).

- [ ] **Step 7: Commit**

```bash
git add src/background/clip-queue-store.ts test/unit/clip-queue-store.test.ts test/unit/chrome-stub.ts
git commit -m "feat(queue): serialized updateQueue store with quota fail-safe + getQueue"
```

---

## Task 3: Queue message envelope

**Files:**
- Modify: `src/shared/messages.ts`
- Test: `test/unit/messages.test.ts` (extend)

**Interfaces:**
- Consumes: `QueuedClipView` (`./queue.ts`).
- Produces:
  - `interface QueueListRequest { kind: "queue-list" }`
  - `interface QueueRetryRequest { kind: "queue-retry"; url?: string }`
  - `interface QueueRemoveRequest { kind: "queue-remove"; url: string }`
  - `type QueueResponse = { kind: "queue"; items: QueuedClipView[] }`
  - `ClipResponse` failure variant gains `queued?: boolean`.
  - `ExtensionRequest` += the three queue requests; `ExtensionResponse` += `QueueResponse`.
  - `isQueueListRequest`/`isQueueRetryRequest`/`isQueueRemoveRequest`/`isQueueResponse`.

- [ ] **Step 1: Write the failing test (append to the existing file)**

```typescript
// append to test/unit/messages.test.ts
// (merge the new bindings into the existing import from "../../src/shared/messages.ts")
import {
  isQueueListRequest,
  isQueueRemoveRequest,
  isQueueResponse,
  isQueueRetryRequest,
} from "../../src/shared/messages.ts";

describe("queue request guards", () => {
  test("accept their kinds and the optional/required url", () => {
    expect(isQueueListRequest({ kind: "queue-list" })).toBe(true);
    expect(isQueueRetryRequest({ kind: "queue-retry" })).toBe(true);
    expect(isQueueRetryRequest({ kind: "queue-retry", url: "u" })).toBe(true);
    expect(isQueueRemoveRequest({ kind: "queue-remove", url: "u" })).toBe(true);
  });
  test("reject wrong kinds, bad url types, and a remove without a url", () => {
    expect(isQueueListRequest({ kind: "clip" })).toBe(false);
    expect(isQueueRetryRequest({ kind: "queue-retry", url: 1 })).toBe(false);
    expect(isQueueRemoveRequest({ kind: "queue-remove" })).toBe(false);
  });
});

describe("isQueueResponse", () => {
  const view = { url: "u", title: "T", queuedAt: 1, attempts: 0 };
  test("accepts a well-formed view list", () => {
    expect(isQueueResponse({ kind: "queue", items: [view] })).toBe(true);
    expect(isQueueResponse({ kind: "queue", items: [] })).toBe(true);
  });
  test("rejects malformed items and the wrong kind", () => {
    expect(isQueueResponse({ kind: "queue", items: [{ url: 1 }] })).toBe(false);
    expect(isQueueResponse({ kind: "clip", items: [] })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/messages.test.ts`
Expected: FAIL — the queue guards are not exported.

- [ ] **Step 3: Write the implementation**

In `src/shared/messages.ts`, extend the type import on line 6 to add `QueuedClipView`:

```typescript
import type { CaptureResult, ClipError, PairError, RelatedError, RelatedHit } from "./types.ts";
import type { QueuedClipView } from "./queue.ts";
```

Add the three request interfaces after `RelatedRequest` (before the `ExtensionRequest` line):

```typescript
export interface QueueListRequest {
  readonly kind: "queue-list";
}

export interface QueueRetryRequest {
  readonly kind: "queue-retry";
  readonly url?: string;
}

export interface QueueRemoveRequest {
  readonly kind: "queue-remove";
  readonly url: string;
}
```

Replace the `ExtensionRequest` line with:

```typescript
export type ExtensionRequest =
  | PairRequest
  | ClipRequest
  | RelatedRequest
  | QueueListRequest
  | QueueRetryRequest
  | QueueRemoveRequest;
```

Replace the `ClipResponse` type with (adds `queued?` to the failure arm):

```typescript
export type ClipResponse =
  | {
      readonly kind: "clip";
      readonly ok: true;
      readonly status: "created" | "updated";
      readonly bookmarked: boolean;
    }
  | { readonly kind: "clip"; readonly ok: false; readonly reason: ClipError; readonly queued?: boolean };
```

Add the `QueueResponse` type and extend `ExtensionResponse` (replace the existing `ExtensionResponse` line):

```typescript
export type QueueResponse = { readonly kind: "queue"; readonly items: QueuedClipView[] };

export type ExtensionResponse = PairResponse | ClipResponse | RelatedResponse | QueueResponse;
```

Append the guards at the end of the file:

```typescript
export function isQueueListRequest(v: unknown): v is QueueListRequest {
  return isObject(v) && v["kind"] === "queue-list";
}

export function isQueueRetryRequest(v: unknown): v is QueueRetryRequest {
  return isObject(v) && v["kind"] === "queue-retry" && (v["url"] === undefined || typeof v["url"] === "string");
}

export function isQueueRemoveRequest(v: unknown): v is QueueRemoveRequest {
  return isObject(v) && v["kind"] === "queue-remove" && typeof v["url"] === "string";
}

function isQueuedClipView(v: unknown): v is QueuedClipView {
  return (
    isObject(v) &&
    typeof v["url"] === "string" &&
    typeof v["title"] === "string" &&
    typeof v["queuedAt"] === "number" &&
    typeof v["attempts"] === "number" &&
    (v["lastReason"] === undefined || typeof v["lastReason"] === "string")
  );
}

export function isQueueResponse(v: unknown): v is QueueResponse {
  return isObject(v) && v["kind"] === "queue" && Array.isArray(v["items"]) && v["items"].every(isQueuedClipView);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/messages.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/messages.ts test/unit/messages.test.ts
git commit -m "feat(messages): queue list/retry/remove envelope + guards; ClipResponse.queued"
```

---

## Task 4: handleClip enqueue + queue handlers

**Files:**
- Modify: `src/background/handlers.ts`
- Test: `test/unit/handlers.test.ts` (extend)

**Interfaces:**
- Consumes: `enqueue`/`removeFromQueue`/`toView`/`QueuedClip` (`../shared/queue.ts`); `QueueResponse`/`QueueRetryRequest`/`QueueRemoveRequest` (`../shared/messages.ts`).
- Produces:
  - `ClipDeps` gains `updateQueue: (m: (q: QueuedClip[]) => QueuedClip[]) => Promise<QueuedClip[]>`.
  - `handleClip` enqueues on `unreachable`/`server_error` and returns `queued: true`.
  - `interface QueueListDeps { getQueue: () => Promise<QueuedClip[]> }` + `handleQueueList(deps): Promise<QueueResponse>`
  - `interface QueueRetryDeps { flush: (opts: { url?: string; manual: boolean }) => Promise<void>; getQueue: () => Promise<QueuedClip[]> }` + `handleQueueRetry(deps, req): Promise<QueueResponse>`
  - `interface QueueRemoveDeps { updateQueue: (m: (q: QueuedClip[]) => QueuedClip[]) => Promise<QueuedClip[]> }` + `handleQueueRemove(deps, req): Promise<QueueResponse>`

- [ ] **Step 1: Write the failing test (append)**

```typescript
// append to test/unit/handlers.test.ts
// (merge handleQueueList/handleQueueRetry/handleQueueRemove into the existing import
//  from "../../src/background/handlers.ts")
import {
  handleQueueList,
  handleQueueRemove,
  handleQueueRetry,
} from "../../src/background/handlers.ts";
import type { QueuedClip } from "../../src/shared/queue.ts";

function queued(url: string): QueuedClip {
  return {
    payload: { url, title: url, mode: "article", body: "b", tags: [], capturedAt: 1 },
    queuedAt: 1,
    attempts: 0,
  };
}

describe("handleClip — offline queue", () => {
  test("enqueues on a transient failure and reports queued:true", async () => {
    let enqueued: QueuedClip[] = [];
    const res = await handleClip(
      {
        getConnection: async () => conn,
        postClip: async () => ({ ok: false, reason: "unreachable" }),
        updateQueue: async (m) => {
          enqueued = m(enqueued);
          return enqueued;
        },
        nowMs: () => 42,
      },
      { kind: "clip", capture, tags: [] },
    );
    expect(res).toEqual({ kind: "clip", ok: false, reason: "unreachable", queued: true });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.payload.url).toBe("https://ex.com/p");
    expect(enqueued[0]?.queuedAt).toBe(42);
  });
  test("does NOT enqueue a non-transient failure (unauthorized)", async () => {
    let called = false;
    const res = await handleClip(
      {
        getConnection: async () => conn,
        postClip: async () => ({ ok: false, reason: "unauthorized" }),
        updateQueue: async (m) => {
          called = true;
          return m([]);
        },
        nowMs: () => 1,
      },
      { kind: "clip", capture, tags: [] },
    );
    expect(res).toEqual({ kind: "clip", ok: false, reason: "unauthorized" });
    expect(called).toBe(false);
  });
});

describe("handleQueue* handlers", () => {
  test("handleQueueList returns the queue projected to views (no body)", async () => {
    const res = await handleQueueList({ getQueue: async () => [queued("a")] });
    expect(res).toEqual({ kind: "queue", items: [{ url: "a", title: "a", queuedAt: 1, attempts: 0 }] });
  });
  test("handleQueueRetry flushes (manual) with the given url, then returns the list", async () => {
    let flushOpts: unknown;
    const res = await handleQueueRetry(
      {
        flush: async (opts) => {
          flushOpts = opts;
        },
        getQueue: async () => [queued("a")],
      },
      { kind: "queue-retry", url: "a" },
    );
    expect(flushOpts).toEqual({ url: "a", manual: true });
    expect(res.items.map((i) => i.url)).toEqual(["a"]);
  });
  test("handleQueueRemove drops the url and returns the remaining list", async () => {
    let state = [queued("a"), queued("b")];
    const res = await handleQueueRemove(
      {
        updateQueue: async (m) => {
          state = m(state);
          return state;
        },
      },
      { kind: "queue-remove", url: "a" },
    );
    expect(res.items.map((i) => i.url)).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/handlers.test.ts`
Expected: FAIL — `updateQueue` missing on `ClipDeps`; queue handlers not exported.

- [ ] **Step 3: Write the implementation**

In `src/background/handlers.ts`, extend the imports. Add the queue + message imports and merge the types:

```typescript
import { buildRelatedQuery, type RelatedQuery } from "../shared/related.ts";
import { enqueue, removeFromQueue, toView, type QueuedClip } from "../shared/queue.ts";
import type {
  ClipRequest,
  ClipResponse,
  PairRequest,
  PairResponse,
  QueueRemoveRequest,
  QueueResponse,
  QueueRetryRequest,
  RelatedRequest,
  RelatedResponse,
} from "../shared/messages.ts";
```

Add `updateQueue` to `ClipDeps`:

```typescript
export interface ClipDeps {
  readonly getConnection: () => Promise<Connection | null>;
  readonly postClip: (
    origin: string,
    token: string,
    payload: ReturnType<typeof buildClipPayload>,
  ) => Promise<{ ok: true; status: "created" | "updated" } | { ok: false; reason: ClipError }>;
  readonly updateQueue: (mutator: (q: QueuedClip[]) => QueuedClip[]) => Promise<QueuedClip[]>;
  readonly nowMs: () => number;
}
```

Replace the body of `handleClip` (from the `const r = ...` line onward) so a transient failure enqueues:

```typescript
export async function handleClip(deps: ClipDeps, req: ClipRequest): Promise<ClipResponse> {
  const conn = await deps.getConnection();
  if (conn === null) {
    return { kind: "clip", ok: false, reason: "not_paired" };
  }
  const payload = buildClipPayload(req.capture, req.tags, deps.nowMs());
  const r = await deps.postClip(conn.origin, conn.token, payload);
  if (r.ok) {
    return { kind: "clip", ok: true, status: r.status, bookmarked: !req.capture.readableFound };
  }
  if (r.reason === "unreachable" || r.reason === "server_error") {
    await deps.updateQueue((q) => enqueue(q, { payload, queuedAt: deps.nowMs(), attempts: 0 }));
    return { kind: "clip", ok: false, reason: r.reason, queued: true };
  }
  return { kind: "clip", ok: false, reason: r.reason };
}
```

Append the queue handlers at the end of the file:

```typescript
export interface QueueListDeps {
  readonly getQueue: () => Promise<QueuedClip[]>;
}

export async function handleQueueList(deps: QueueListDeps): Promise<QueueResponse> {
  const q = await deps.getQueue();
  return { kind: "queue", items: q.map(toView) };
}

export interface QueueRetryDeps {
  readonly flush: (opts: { url?: string; manual: boolean }) => Promise<void>;
  readonly getQueue: () => Promise<QueuedClip[]>;
}

export async function handleQueueRetry(
  deps: QueueRetryDeps,
  req: QueueRetryRequest,
): Promise<QueueResponse> {
  await deps.flush({ ...(req.url !== undefined ? { url: req.url } : {}), manual: true });
  const q = await deps.getQueue();
  return { kind: "queue", items: q.map(toView) };
}

export interface QueueRemoveDeps {
  readonly updateQueue: (mutator: (q: QueuedClip[]) => QueuedClip[]) => Promise<QueuedClip[]>;
}

export async function handleQueueRemove(
  deps: QueueRemoveDeps,
  req: QueueRemoveRequest,
): Promise<QueueResponse> {
  const q = await deps.updateQueue((qq) => removeFromQueue(qq, req.url));
  return { kind: "queue", items: q.map(toView) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/background/handlers.ts test/unit/handlers.test.ts
git commit -m "feat(background): handleClip enqueues transient failures + queue list/retry/remove handlers"
```

---

## Task 5: queue-flush orchestration

**Files:**
- Create: `src/background/queue-flush.ts`
- Test: `test/unit/queue-flush.test.ts`

**Interfaces:**
- Consumes: `markAttempt`/`removeFromQueue`/`QueuedClip` (`../shared/queue.ts`); `ClipPayload` (`../shared/clip.ts`); `ClipError`/`Connection` (`../shared/types.ts`).
- Produces:
  - `interface FlushDeps { getConnection; getQueue; updateQueue; postClip }`
  - `flushQueue(deps: FlushDeps, opts?: { url?: string; manual?: boolean }): Promise<{ remaining: number }>`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/queue-flush.test.ts
import { describe, expect, test } from "vitest";
import { flushQueue } from "../../src/background/queue-flush.ts";
import type { ClipPayload } from "../../src/shared/clip.ts";
import type { QueuedClip } from "../../src/shared/queue.ts";
import type { ClipError, Connection } from "../../src/shared/types.ts";

const conn: Connection = { origin: "http://127.0.0.1:8765", token: "tok", label: "c", pairedAt: 1 };

function entry(url: string, lastReason?: ClipError): QueuedClip {
  return {
    payload: { url, title: url, mode: "article", body: "b", tags: [], capturedAt: 1 },
    queuedAt: 1,
    attempts: 0,
    ...(lastReason !== undefined ? { lastReason } : {}),
  };
}

/** A live mutable-store harness mirroring clip-queue-store semantics. */
function store(initial: QueuedClip[]) {
  let q = initial;
  return {
    getQueue: async () => q,
    updateQueue: async (m: (x: QueuedClip[]) => QueuedClip[]) => {
      q = m(q);
      return q;
    },
    current: () => q,
  };
}

describe("flushQueue", () => {
  test("unpaired → no-op, queue intact", async () => {
    const s = store([entry("a")]);
    const out = await flushQueue({
      getConnection: async () => null,
      getQueue: s.getQueue,
      updateQueue: s.updateQueue,
      postClip: async () => ({ ok: true, status: "created" }),
    });
    expect(out).toEqual({ remaining: 1 });
    expect(s.current()).toHaveLength(1);
  });

  test("success drains every entry", async () => {
    const s = store([entry("a"), entry("b")]);
    const out = await flushQueue({
      getConnection: async () => conn,
      getQueue: s.getQueue,
      updateQueue: s.updateQueue,
      postClip: async () => ({ ok: true, status: "updated" }),
    });
    expect(out).toEqual({ remaining: 0 });
    expect(s.current()).toEqual([]);
  });

  test("unreachable stops the batch and keeps all entries (marks the first)", async () => {
    const s = store([entry("a"), entry("b")]);
    let calls = 0;
    await flushQueue({
      getConnection: async () => conn,
      getQueue: s.getQueue,
      updateQueue: s.updateQueue,
      postClip: async () => {
        calls++;
        return { ok: false, reason: "unreachable" };
      },
    });
    expect(calls).toBe(1); // stopped after the first
    expect(s.current().map((e) => e.payload.url)).toEqual(["a", "b"]);
    expect(s.current()[0]?.attempts).toBe(1);
  });

  test("server_error marks and continues to the next entry", async () => {
    const s = store([entry("a"), entry("b")]);
    let calls = 0;
    await flushQueue({
      getConnection: async () => conn,
      getQueue: s.getQueue,
      updateQueue: s.updateQueue,
      postClip: async () => {
        calls++;
        return { ok: false, reason: "server_error" };
      },
    });
    expect(calls).toBe(2);
    expect(s.current().map((e) => e.attempts)).toEqual([1, 1]);
  });

  test("auto flush skips an invalid_request entry; manual attempts it", async () => {
    const tried: string[] = [];
    const post = async (_o: string, _t: string, p: ClipPayload): Promise<{ ok: true; status: "created" } | { ok: false; reason: ClipError }> => {
      tried.push(p.url);
      return { ok: true, status: "created" };
    };
    const s1 = store([entry("a", "invalid_request")]);
    await flushQueue({ getConnection: async () => conn, getQueue: s1.getQueue, updateQueue: s1.updateQueue, postClip: post });
    expect(tried).toEqual([]); // skipped on auto

    const s2 = store([entry("a", "invalid_request")]);
    await flushQueue(
      { getConnection: async () => conn, getQueue: s2.getQueue, updateQueue: s2.updateQueue, postClip: post },
      { manual: true },
    );
    expect(tried).toEqual(["a"]); // attempted on manual
  });

  test("opts.url retries just that entry", async () => {
    const s = store([entry("a"), entry("b")]);
    const tried: string[] = [];
    await flushQueue(
      {
        getConnection: async () => conn,
        getQueue: s.getQueue,
        updateQueue: s.updateQueue,
        postClip: async (_o, _t, p) => {
          tried.push(p.url);
          return { ok: true, status: "created" };
        },
      },
      { url: "b" },
    );
    expect(tried).toEqual(["b"]);
    expect(s.current().map((e) => e.payload.url)).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/queue-flush.test.ts`
Expected: FAIL — module `../../src/background/queue-flush.ts` not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/background/queue-flush.ts
// Drains the offline queue: posts each pending clip and removes it on success.
// An entry leaves the queue ONLY on success — failures are marked and kept. The
// token is re-read from the connection here (never stored in the queue). Each
// outcome is applied as a delta through the serialized updateQueue, so a concurrent
// popup remove is never clobbered by the flush's own write.
import type { ClipPayload } from "../shared/clip.ts";
import { markAttempt, removeFromQueue, type QueuedClip } from "../shared/queue.ts";
import type { ClipError, Connection } from "../shared/types.ts";

export interface FlushDeps {
  readonly getConnection: () => Promise<Connection | null>;
  readonly getQueue: () => Promise<QueuedClip[]>;
  readonly updateQueue: (mutator: (q: QueuedClip[]) => QueuedClip[]) => Promise<QueuedClip[]>;
  readonly postClip: (
    origin: string,
    token: string,
    payload: ClipPayload,
  ) => Promise<{ ok: true; status: "created" | "updated" } | { ok: false; reason: ClipError }>;
}

export async function flushQueue(
  deps: FlushDeps,
  opts: { url?: string; manual?: boolean } = {},
): Promise<{ remaining: number }> {
  const conn = await deps.getConnection();
  const queue = await deps.getQueue();
  if (conn === null) {
    return { remaining: queue.length };
  }

  const snapshot = queue.filter((e) => {
    if (opts.url !== undefined) {
      return e.payload.url === opts.url;
    }
    // An automatic flush skips entries that already failed with invalid_request —
    // a 400 won't self-fix, so only an explicit user retry (manual) attempts them.
    if (opts.manual !== true && e.lastReason === "invalid_request") {
      return false;
    }
    return true;
  });

  for (const entry of snapshot) {
    const r = await deps.postClip(conn.origin, conn.token, entry.payload);
    if (r.ok) {
      await deps.updateQueue((q) => removeFromQueue(q, entry.payload.url));
      continue;
    }
    await deps.updateQueue((q) => markAttempt(q, entry.payload.url, r.reason));
    if (r.reason === "unreachable" || r.reason === "unauthorized") {
      break; // gateway down or token dead — no point trying the rest this round
    }
    // server_error / invalid_request: keep the entry, continue to the next
  }

  return { remaining: (await deps.getQueue()).length };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/queue-flush.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/background/queue-flush.ts test/unit/queue-flush.test.ts
git commit -m "feat(queue): flushQueue drain — success-only removal, batch-stop, invalid_request skip"
```

---

## Task 6: Browser seams — alarms + action (badge)

**Files:**
- Create: `src/browser/alarms.ts`, `src/browser/action.ts`
- Modify: `test/unit/chrome-stub.ts` (record alarm + badge calls)
- Test: `test/unit/browser-seam.test.ts` (extend)

**Interfaces:**
- Produces:
  - `ensureAlarm(name: string, periodInMinutes: number): void`
  - `clearAlarm(name: string): Promise<void>`
  - `addAlarmListener(fn: (name: string) => void): void`
  - `setBadgeCount(n: number): Promise<void>`
  - `setBadgeBackground(color: string): Promise<void>`

- [ ] **Step 1: Extend the chrome-stub to record alarms + badge**

In `test/unit/chrome-stub.ts`, extend the return type and recorders. Change the return type annotation to add the new arrays:

```typescript
export function installChromeStub(opts: StubOptions = {}): {
  storage: Map<string, unknown>;
  executeCalls: unknown[];
  alarmCalls: unknown[];
  badgeTexts: string[];
} {
```

Declare the recorders alongside `executeCalls`:

```typescript
  const alarmCalls: unknown[] = [];
  const badgeTexts: string[] = [];
```

Add `alarms` and `action` properties to the `fake` object (after `scripting`):

```typescript
    alarms: {
      create: (name: string, info: unknown) => {
        alarmCalls.push({ create: name, info });
      },
      clear: async (name: string) => {
        alarmCalls.push({ clear: name });
        return true;
      },
      onAlarm: { addListener: () => undefined },
    },
    action: {
      setBadgeText: async (details: { text: string }) => {
        badgeTexts.push(details.text);
      },
      setBadgeBackgroundColor: async () => undefined,
    },
```

Change the return statement:

```typescript
  return { storage, executeCalls, alarmCalls, badgeTexts };
```

- [ ] **Step 2: Write the failing tests (append)**

```typescript
// append to test/unit/browser-seam.test.ts
// (merge these into the existing imports at the top of the file)
import { clearAlarm, ensureAlarm } from "../../src/browser/alarms.ts";
import { setBadgeCount } from "../../src/browser/action.ts";

describe("alarms seam", () => {
  test("ensureAlarm creates a periodic alarm; clearAlarm clears it", async () => {
    const { alarmCalls } = installChromeStub();
    ensureAlarm("flush-clip-queue", 1);
    await clearAlarm("flush-clip-queue");
    expect(alarmCalls).toEqual([
      { create: "flush-clip-queue", info: { periodInMinutes: 1 } },
      { clear: "flush-clip-queue" },
    ]);
  });
});

describe("action badge seam", () => {
  test("setBadgeCount shows the number when > 0 and clears at 0", async () => {
    const { badgeTexts } = installChromeStub();
    await setBadgeCount(3);
    await setBadgeCount(0);
    expect(badgeTexts).toEqual(["3", ""]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bunx vitest run test/unit/browser-seam.test.ts`
Expected: FAIL — `../../src/browser/alarms.ts` / `action.ts` not found.

- [ ] **Step 4: Write the implementations**

```typescript
// src/browser/alarms.ts
// Thin typed seam over chrome.alarms — the only place we touch the alarm API.
export function ensureAlarm(name: string, periodInMinutes: number): void {
  chrome.alarms.create(name, { periodInMinutes });
}

export async function clearAlarm(name: string): Promise<void> {
  await chrome.alarms.clear(name);
}

export function addAlarmListener(fn: (name: string) => void): void {
  chrome.alarms.onAlarm.addListener((alarm) => fn(alarm.name));
}
```

```typescript
// src/browser/action.ts
// Thin typed seam over chrome.action's toolbar badge — no permission required.
export async function setBadgeCount(n: number): Promise<void> {
  await chrome.action.setBadgeText({ text: n > 0 ? String(n) : "" });
}

export async function setBadgeBackground(color: string): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color });
}
```

- [ ] **Step 5: Run tests + full gate (the stub change touches shared test infra)**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS (the new stub arrays are additive; existing tests destructure only what they use).

- [ ] **Step 6: Commit**

```bash
git add src/browser/alarms.ts src/browser/action.ts test/unit/browser-seam.test.ts test/unit/chrome-stub.ts
git commit -m "feat(seam): chrome.alarms + chrome.action badge seams"
```

---

## Task 7: Manifest — alarms permission

**Files:**
- Modify: `src/manifest/manifest.ts`
- Test: `test/unit/manifest.test.ts` (extend)

**Interfaces:**
- Produces: `composeManifest(...).permissions` includes `"alarms"`.

- [ ] **Step 1: Write the failing test (append)**

```typescript
// append to test/unit/manifest.test.ts
// (merge BROWSER_TARGETS/composeManifest into the existing import if needed)
describe("composeManifest — alarms permission", () => {
  for (const target of BROWSER_TARGETS) {
    test(`${target} declares the alarms permission (for the offline-queue flush)`, () => {
      expect(composeManifest(target, "1.2.3").permissions).toContain("alarms");
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/manifest.test.ts`
Expected: FAIL — `permissions` does not contain `"alarms"`.

- [ ] **Step 3: Write the implementation**

In `src/manifest/manifest.ts`, add `"alarms"` to the `permissions` array in `base` and update the comment:

```typescript
    // Minimal, capability-scoped: storage holds the paired bearer token; activeTab +
    // scripting let the popup capture the current page on user action (no broad host
    // access); alarms wakes the SW to drain the offline retry queue.
    permissions: ["activeTab", "scripting", "storage", "alarms"],
```

- [ ] **Step 4: Run tests + build the manifest into both targets**

Run: `bunx vitest run test/unit/manifest.test.ts && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/manifest/manifest.ts test/unit/manifest.test.ts
git commit -m "feat(manifest): add the alarms permission for the offline-queue flush"
```

---

## Task 8: Queue-view pure DOM builders

**Files:**
- Create: `src/popup/queue-view.ts`
- Test: `test/unit/queue-view.test.ts` (jsdom)

**Interfaces:**
- Consumes: `QueuedClipView` (`../shared/queue.ts`).
- Produces:
  - `hostOf(url: string): string`
  - `formatAge(nowMs: number, queuedAt: number): string`
  - `renderQueueItem(doc: Document, item: QueuedClipView, nowMs: number): HTMLElement`
  - `renderQueueList(doc: Document, items: QueuedClipView[], nowMs: number): HTMLElement`

> The builders carry no behavior — Retry/Remove buttons hold the entry URL in `dataset.url`; the popup (Task 9) attaches a delegated click listener. Keeping them pure makes them jsdom-testable like `panel-view.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// @vitest-environment jsdom
// test/unit/queue-view.test.ts
import { describe, expect, test } from "vitest";
import { formatAge, hostOf, renderQueueItem, renderQueueList } from "../../src/popup/queue-view.ts";
import type { QueuedClipView } from "../../src/shared/queue.ts";

const base: QueuedClipView = { url: "https://ex.com/p", title: "Doc", queuedAt: 0, attempts: 0 };

describe("hostOf", () => {
  test("returns the host for a valid URL; echoes a bad one", () => {
    expect(hostOf("https://ex.com/a/b")).toBe("ex.com");
    expect(hostOf("not a url")).toBe("not a url");
  });
});

describe("formatAge", () => {
  test("buckets seconds/minutes/hours/days", () => {
    expect(formatAge(30_000, 0)).toBe("just now");
    expect(formatAge(120_000, 0)).toBe("2m ago");
    expect(formatAge(3 * 3_600_000, 0)).toBe("3h ago");
    expect(formatAge(2 * 86_400_000, 0)).toBe("2d ago");
  });
});

describe("renderQueueItem", () => {
  test("renders title, host·age, and Retry/Remove buttons carrying the url", () => {
    const el = renderQueueItem(document, base, 120_000);
    expect(el.querySelector(".queue__item-title")?.textContent).toBe("Doc");
    expect(el.querySelector(".queue__item-meta")?.textContent).toBe("ex.com · 2m ago");
    expect(el.querySelector(".queue__retry")?.getAttribute("data-url")).toBe("https://ex.com/p");
    expect(el.querySelector(".queue__remove")?.getAttribute("data-url")).toBe("https://ex.com/p");
    // renders no anchor — the manager never navigates (no javascript: href surface)
    expect(el.querySelector("a")).toBeNull();
  });
  test("shows a status line with the reason + attempt count when attempted", () => {
    const el = renderQueueItem(document, { ...base, attempts: 3, lastReason: "unreachable" }, 0);
    expect(el.querySelector(".queue__item-status")?.textContent).toBe("Can't reach Nimbus · 3 tries");
  });
  test("XSS backstop — markup in the title is inert text", () => {
    const el = renderQueueItem(document, { ...base, title: "<img src=x onerror=alert(1)>" }, 0);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".queue__item-title")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("renderQueueList", () => {
  test("renders one item per entry", () => {
    const list = renderQueueList(document, [base, { ...base, url: "https://ex.com/q" }], 0);
    expect(list.querySelectorAll(".queue__item").length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/unit/queue-view.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/popup/queue-view.ts
// Pure DOM builders for the popup queue manager. Every entry string is written via
// textContent (never innerHTML); the host is parsed with a guarded new URL and the
// row renders NO href — the manager does not navigate, so there is no javascript:
// href surface. Retry/Remove buttons carry the entry url in dataset.url; the popup
// attaches a single delegated click listener.
import type { QueuedClipView } from "../shared/queue.ts";

const REASON_LABELS: Record<string, string> = {
  unreachable: "Can't reach Nimbus",
  server_error: "Nimbus had an error",
  unauthorized: "Pairing expired",
  invalid_request: "Couldn't save — won't retry automatically",
  not_paired: "Not paired",
};

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function formatAge(nowMs: number, queuedAt: number): string {
  const sec = Math.max(0, Math.floor((nowMs - queuedAt) / 1000));
  if (sec < 60) {
    return "just now";
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min}m ago`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}h ago`;
  }
  return `${Math.floor(hr / 24)}d ago`;
}

export function renderQueueItem(
  doc: Document,
  item: QueuedClipView,
  nowMs: number,
): HTMLElement {
  const li = doc.createElement("li");
  li.className = "queue__item";

  const title = doc.createElement("span");
  title.className = "queue__item-title";
  title.textContent = item.title !== "" ? item.title : hostOf(item.url);

  const meta = doc.createElement("span");
  meta.className = "queue__item-meta";
  meta.textContent = `${hostOf(item.url)} · ${formatAge(nowMs, item.queuedAt)}`;

  li.append(title, meta);

  if (item.attempts > 0 || item.lastReason !== undefined) {
    const status = doc.createElement("span");
    status.className = "queue__item-status";
    const label =
      item.lastReason !== undefined ? (REASON_LABELS[item.lastReason] ?? "Couldn't save") : "Pending";
    status.textContent =
      item.attempts > 0
        ? `${label} · ${item.attempts} ${item.attempts === 1 ? "try" : "tries"}`
        : label;
    li.append(status);
  }

  const actions = doc.createElement("span");
  actions.className = "queue__item-actions";
  const retry = doc.createElement("button");
  retry.type = "button";
  retry.className = "queue__retry";
  retry.dataset["url"] = item.url;
  retry.textContent = "Retry";
  const remove = doc.createElement("button");
  remove.type = "button";
  remove.className = "queue__remove";
  remove.dataset["url"] = item.url;
  remove.textContent = "Remove";
  actions.append(retry, remove);
  li.append(actions);

  return li;
}

export function renderQueueList(
  doc: Document,
  items: QueuedClipView[],
  nowMs: number,
): HTMLElement {
  const list = doc.createElement("ul");
  list.className = "queue__list";
  for (const item of items) {
    list.append(renderQueueItem(doc, item, nowMs));
  }
  return list;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/unit/queue-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/popup/queue-view.ts test/unit/queue-view.test.ts
git commit -m "feat(popup): pure textContent-only queue-manager DOM builders (jsdom-tested)"
```

---

## Task 9: Popup wiring (queue manager)

**Files:**
- Modify: `src/popup/popup.html`, `src/popup/popup.css`, `src/popup/popup.ts`

**Interfaces:**
- Consumes: `sendMessage` (`../browser/runtime.ts`); `renderQueueList` (`./queue-view.ts`); `isQueueResponse` (`../shared/messages.ts`).

> The popup DOM wiring is verified by the Task 11 manual checklist (consistent with Slices 1–2); its pure builder (`queue-view`) is already unit-tested.

- [ ] **Step 1: Add the queue section to the popup HTML**

In `src/popup/popup.html`, insert after the `show-related` button and before the `status` paragraph:

```html
      <button id="show-related" type="button" class="popup__related">Show related</button>
      <section id="queue" class="queue" hidden>
        <h2 class="queue__heading">Waiting to sync (<span id="queue-count">0</span>)</h2>
        <div id="queue-list"></div>
        <button id="queue-retry-all" type="button" class="queue__retry-all">Retry all</button>
      </section>
      <p id="status" class="popup__status" role="status"></p>
```

- [ ] **Step 2: Style the queue section**

Append to `src/popup/popup.css`:

```css
.queue { margin-top: 12px; border-top: 1px solid rgba(128, 128, 128, 0.3); padding-top: 8px; }
.queue__heading { margin: 0 0 8px; font-size: 12px; font-weight: 600; opacity: 0.8; }
/* Cap the list height so a long backlog scrolls inside the section rather than
   pushing "Retry all" past the browser's ~600px popup ceiling. */
.queue__list { list-style: none; margin: 0; padding: 0; max-height: 260px; overflow-y: auto; }
.queue__item { display: flex; flex-direction: column; gap: 2px; padding: 8px 0; border-bottom: 1px solid rgba(128, 128, 128, 0.2); }
.queue__item-title { font-size: 13px; font-weight: 600; }
.queue__item-meta { font-size: 11px; opacity: 0.7; }
.queue__item-status { font-size: 11px; opacity: 0.8; }
.queue__item-actions { display: flex; gap: 8px; margin-top: 4px; }
.queue__item-actions button { font-size: 12px; padding: 2px 8px; cursor: pointer; }
.queue__retry-all { width: 100%; margin-top: 8px; padding: 6px; cursor: pointer; }
```

- [ ] **Step 3: Wire the popup script**

In `src/popup/popup.ts`, add the queue-view import and fold `isQueueResponse` into the
existing messages import. The file currently has `import type { ClipResponse } from "../shared/messages.ts";` —
**replace that line** (Biome forbids two imports from one module) with a combined
type+value import, and add the queue-view import:

```typescript
import { renderQueueList } from "./queue-view.ts";
import { isQueueResponse, type ClipResponse } from "../shared/messages.ts";
```

Update the `clip()` failure branch to surface the offline-queued state and refresh the manager. Replace the existing `} else {` block at the end of `clip()`:

```typescript
  } else {
    setStatus(
      res.queued === true
        ? "Saved offline — will sync when Nimbus is back."
        : (CLIP_MESSAGES[res.reason] ?? "Couldn't save this page."),
    );
    await refreshQueue();
  }
```

Add the queue functions before the `DOMContentLoaded` listener:

```typescript
function renderQueue(res: unknown): void {
  const section = document.getElementById("queue");
  const list = document.getElementById("queue-list");
  const count = document.getElementById("queue-count");
  if (!(section instanceof HTMLElement) || list === null || count === null) {
    return;
  }
  if (!isQueueResponse(res) || res.items.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  count.textContent = String(res.items.length);
  list.replaceChildren(renderQueueList(document, res.items, Date.now()));
}

async function refreshQueue(): Promise<void> {
  renderQueue(await sendMessage({ kind: "queue-list" }));
}

async function onQueueClick(event: MouseEvent): Promise<void> {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  const url = target.dataset["url"];
  if (url === undefined) {
    return;
  }
  if (target.classList.contains("queue__retry")) {
    renderQueue(await sendMessage({ kind: "queue-retry", url }));
  } else if (target.classList.contains("queue__remove")) {
    renderQueue(await sendMessage({ kind: "queue-remove", url }));
  }
}
```

Add the wiring inside the existing `DOMContentLoaded` callback:

```typescript
  document.getElementById("queue-list")?.addEventListener("click", (event) => {
    if (event instanceof MouseEvent) {
      void onQueueClick(event);
    }
  });
  document.getElementById("queue-retry-all")?.addEventListener("click", () => {
    void (async () => renderQueue(await sendMessage({ kind: "queue-retry" })))();
  });
  void refreshQueue();
```

> `ClipResponse` is kept in the import (now combined with `isQueueResponse`) so `res.queued` typechecks against the failure arm; `isClipResponse` in this file already narrows to `ClipResponse`.

- [ ] **Step 4: Build + full gate**

Run: `bun run build && bun run check-build && bun run typecheck && bun run lint && bun run test`
Expected: PASS — bundles include the queue wiring; no test regressions.

- [ ] **Step 5: Commit**

```bash
git add src/popup/popup.html src/popup/popup.css src/popup/popup.ts
git commit -m "feat(popup): offline-queue manager UI (list, retry/remove, retry-all, offline status)"
```

---

## Task 10: Service-worker wiring (routing + alarm + badge lifecycle)

**Files:**
- Modify: `src/background/service-worker.ts`

**Interfaces:**
- Consumes: `getQueue`/`updateQueue` (`./clip-queue-store.ts`); `flushQueue` (`./queue-flush.ts`); `handleQueueList`/`handleQueueRetry`/`handleQueueRemove` (`./handlers.ts`); `isQueueListRequest`/`isQueueRetryRequest`/`isQueueRemoveRequest` (`../shared/messages.ts`); `ensureAlarm`/`clearAlarm`/`addAlarmListener` (`../browser/alarms.ts`); `setBadgeCount`/`setBadgeBackground` (`../browser/action.ts`).

> The SW routing/alarm/badge glue is verified by the Task 11 manual checklist, not unit tests — consistent with Slices 1–2.

- [ ] **Step 1: Replace the service worker**

Replace the contents of `src/background/service-worker.ts` with:

```typescript
// MV3 background service worker / Firefox event page. Owns the bearer token and all
// gateway I/O; the popup, options page, and injected panel reach it via messages. It
// also owns the offline retry queue: it drains on a chrome.alarms tick (the alarm is
// live only while the queue is non-empty), on startup, and on popup retries, and it
// keeps the toolbar badge in sync with the pending count.
import { setBadgeBackground, setBadgeCount } from "../browser/action.ts";
import { addAlarmListener, clearAlarm, ensureAlarm } from "../browser/alarms.ts";
import { addCommandListener, addMessageListener } from "../browser/runtime.ts";
import { injectPanel } from "../browser/scripting.ts";
import { activeTab } from "../browser/tabs.ts";
import {
  isClipRequest,
  isPairRequest,
  isQueueListRequest,
  isQueueRemoveRequest,
  isQueueRetryRequest,
  isRelatedRequest,
} from "../shared/messages.ts";
import { getQueue, updateQueue } from "./clip-queue-store.ts";
import { getConnection, setConnection } from "./connection-store.ts";
import { confirmPair, postClip, postRelated } from "./gateway-client.ts";
import {
  handleClip,
  handlePair,
  handleQueueList,
  handleQueueRemove,
  handleQueueRetry,
  handleRelated,
} from "./handlers.ts";
import { flushQueue } from "./queue-flush.ts";

const FLUSH_ALARM = "flush-clip-queue";
const flushDeps = { getConnection, getQueue, updateQueue, postClip };

// Reconcile the toolbar badge and the flush alarm with the current queue length:
// the alarm exists only while there is work to do (no idle wakeups).
async function syncQueueState(): Promise<void> {
  const n = (await getQueue()).length;
  await setBadgeCount(n);
  if (n > 0) {
    ensureAlarm(FLUSH_ALARM, 1);
  } else {
    await clearAlarm(FLUSH_ALARM);
  }
}

addMessageListener((message, respond) => {
  if (isPairRequest(message)) {
    handlePair({ confirmPair, setConnection, nowMs: () => Date.now() }, message)
      .then(respond)
      .catch(() => {
        respond({ kind: "pair", ok: false, reason: "server_error" });
      });
    return true;
  }
  if (isClipRequest(message)) {
    handleClip({ getConnection, postClip, updateQueue, nowMs: () => Date.now() }, message)
      .then(async (res) => {
        await syncQueueState();
        respond(res);
      })
      .catch(() => {
        respond({ kind: "clip", ok: false, reason: "server_error" });
      });
    return true;
  }
  if (isRelatedRequest(message)) {
    handleRelated({ getConnection, postRelated }, message)
      .then(respond)
      .catch(() => {
        respond({ kind: "related", ok: false, reason: "server_error" });
      });
    return true;
  }
  if (isQueueListRequest(message)) {
    handleQueueList({ getQueue })
      .then(respond)
      .catch(() => {
        respond({ kind: "queue", items: [] });
      });
    return true;
  }
  if (isQueueRetryRequest(message)) {
    handleQueueRetry(
      { flush: (opts) => flushQueue(flushDeps, opts).then(() => undefined), getQueue },
      message,
    )
      .then(async (res) => {
        await syncQueueState();
        respond(res);
      })
      .catch(() => {
        respond({ kind: "queue", items: [] });
      });
    return true;
  }
  if (isQueueRemoveRequest(message)) {
    handleQueueRemove({ updateQueue }, message)
      .then(async (res) => {
        await syncQueueState();
        respond(res);
      })
      .catch(() => {
        respond({ kind: "queue", items: [] });
      });
    return true;
  }
  return false;
});

// The hotkey injects the related panel into the active tab. activeTab is granted on
// the command gesture; a restricted page rejects injection — fail closed silently.
addCommandListener((command) => {
  if (command === "show_related") {
    activeTab()
      .then((tab) => injectPanel(tab.id))
      .catch(() => undefined);
  }
});

// The periodic alarm drains the queue, then reconciles the badge + alarm lifecycle.
addAlarmListener((name) => {
  if (name === FLUSH_ALARM) {
    flushQueue(flushDeps).then(syncQueueState).catch(() => undefined);
  }
});

// On startup, run the sequence deterministically (awaited, not three concurrent
// top-level promises): set the badge color, paint the persisted backlog immediately,
// then attempt a drain and reconcile once more. Sequencing avoids a race where the
// initial badge paint could resolve after the post-drain one and show a stale count.
void (async () => {
  await setBadgeBackground("#5b6470").catch(() => undefined);
  await syncQueueState().catch(() => undefined);
  await flushQueue(flushDeps).then(syncQueueState).catch(() => undefined);
})();
```

- [ ] **Step 2: Build + full gate**

Run: `bun run build && bun run check-build && bun run typecheck && bun run lint && bun run test`
Expected: PASS — both targets build; check-build OK; no regressions.

- [ ] **Step 3: Commit**

```bash
git add src/background/service-worker.ts
git commit -m "feat(background): route queue messages + alarm-driven flush + badge/alarm lifecycle"
```

---

## Task 11: Manual checklist + changelog + full gate

**Files:**
- Modify: `docs/development.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the Slice-3 manual checklist**

Append to `docs/development.md` (before the `## Security check` section):

```markdown
## Manual verification — Slice 3 (offline retry queue)

Prereq: paired (Slice 1). To force the transient path, stop the gateway (or point
the Options origin at an unused port) so clips fail with "Can't reach Nimbus".

1. **Queue on failure:** with the gateway stopped, Clip page → status reads
   "Saved offline — will sync when Nimbus is back."; the popup shows a "Waiting to
   sync (1)" section and the toolbar badge shows `1`.
2. **Dedup:** re-clip the same page → still one entry (payload replaced), badge `1`.
   Clip a second page → badge `2`, two rows.
3. **Auto-drain:** start the gateway and wait ~1 min (or reopen the popup) → the
   queue drains, the section hides, the badge clears.
4. **Manual retry:** queue some clips offline, start the gateway, open the popup,
   press **Retry all** (and a per-row **Retry**) → those entries sync and disappear.
5. **Remove:** press a row's **Remove** → the entry is dropped; badge decrements.
6. **Unpaired backlog:** with entries queued, unpair (Options) → the badge still
   shows the backlog; entries don't drain until re-paired.
7. **Restart persistence:** queue offline, then disable+enable the extension (or
   restart the browser) → the queue and badge survive; it drains when the gateway
   returns.
8. **Not-queued errors:** while paired but mid-session token loss (or a 400) → the
   clip reports its error and is **not** queued.
9. Repeat 1–5 in Firefox.
```

- [ ] **Step 2: Add the changelog entry**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Added`, append:

```markdown
- **Slice 3 — offline retry queue.** Clips that fail because the gateway is
  unreachable (or errors) are saved to a local queue and retried automatically — a
  `chrome.alarms` flush (live only while the queue is non-empty) plus drains on
  service-worker startup and on demand. A toolbar **badge** shows the pending count
  and the popup gains a **queue manager** (per-item Retry/Remove + Retry all). The
  bearer token is never stored in the queue (re-read at flush time); queue writes are
  serialized to prevent lost updates; the manager renders `textContent`-only and no
  links. Adds only the `alarms` permission; still loopback-only.
```

- [ ] **Step 3: Run the full gate**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/development.md CHANGELOG.md
git commit -m "docs: Slice 3 manual checklist + changelog entry"
```

- [ ] **Step 5: Push and open the PR (once GitHub access is restored)**

```bash
git push -u origin spec/offline-queue
gh pr create --base main --fill
```

> **Blocked locally:** the GitHub account is suspended, so this step is deferred. The branch is complete and green; push + PR when access returns. Verify CI (build-test, CodeQL, Sonar) goes green before merge.

---

## Plan review resolutions (2026-06-27)

From [the Slice 3 plan review](./2026-06-27-web-clipper-extension-slice3-review.md):

1. **Service-worker startup race (fixed).** The three top-level startup promises in
   Task 10 are now sequenced inside an awaited async IIFE (set badge color → paint the
   persisted backlog → drain → reconcile), removing any window where the initial badge
   paint could resolve after the post-drain one and show a stale count.
2. **Popup reflow / long-backlog headroom (fixed, lightweight).** Task 9's
   `.queue__list` gains `max-height: 260px; overflow-y: auto`, so a long queue scrolls
   inside the section instead of pushing "Retry all" past the browser's ~600px popup
   ceiling. The popup is otherwise auto-height already (no fixed height to fight).
3. **Explicit delayed-mutator serialization test (deferred — redundant).** The Task 2
   parallel test already deterministically catches a lost update: both `updateQueue`
   calls are invoked synchronously, so without the lock both reads see `[]` and the
   result is `["a"]`/`["b"]`, never `["a","b"]` — the assertion fails the moment the
   lock is removed. The suggested "delay inside the mutator" also mis-fits the design
   (the mutator is a synchronous `(q) => QueuedClip[]`; the only awaitable point is the
   storage write in the seam). A clarifying comment was added to the existing test
   rather than a second, redundant one.

## Self-Review Notes (author)

- **Spec coverage:** queue model + dedup/evict (T1); serialized store + quota fail-safe (T2); message envelope + `queued` flag (T3); enqueue-on-transient + queue handlers (T4); flush drain semantics — success-only removal, `unreachable`/`unauthorized` batch-stop, `server_error` continue, `invalid_request` auto-skip / manual-retry, single-`url` retry (T5); alarms + badge seams (T6); `alarms` permission (T7); `textContent`-only manager builders + no-href + age/host (T8); popup manager wiring + offline status (T9); SW routing + alarm-driven flush + badge/alarm lifecycle + startup drain (T10); manual checklist + changelog (T11). Design-review resolutions: serialized `updateQueue` + per-entry deltas (T2/T5), conditional alarm (T10), `invalid_request` skip (T5), no-href manager (T8), quota fail-safe (T2), `navigator.onLine` deliberately absent (T5/T10).
- **Type consistency:** `QueuedClip`/`QueuedClipView`/`MAX_QUEUE` defined once in `queue.ts` (T1); `updateQueue(mutator)` signature identical across store (T2), `ClipDeps`/`QueueRemoveDeps` (T4), `FlushDeps` (T5), and the SW (T10); `QueueResponse`/queue requests defined in `messages.ts` (T3) consumed by handlers (T4) + SW (T10) + popup (T9); `flushQueue(deps, {url?, manual?})` consumed by the retry handler via the injected `flush` (T4) and the SW (T10).
- **Token posture:** the token never enters a `QueuedClip` (only `ClipPayload` is stored); `flushQueue` re-reads it from `getConnection` (T5). Never logged, never in the popup DOM.
- **No new permissions beyond `alarms`** (T7); injection/badge ride existing APIs; `postClip` reuses the stored `Connection` origin (loopback only).
- **Intentional non-unit-tested surfaces:** `service-worker.ts` glue and the popup DOM wiring — covered by the Task 11 manual checklist; their pure dependencies (`queue`, `queue-flush`, `queue-view`, handlers, store, seams) are unit-tested.
```
