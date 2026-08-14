# Slice 1 — Setup That Works: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Nimbus Web Clipper set itself up — find the local gateway without the user typing a URL, show honestly whether the connection is alive, and say in one place exactly where data goes.

**Architecture:** Options becomes four ordered stages driven by a pure `stagesFrom(status)` decision, not by DOM branching. A new unauthenticated `GET /v1/health` probe backs both gateway discovery and a live reachability indicator. The connection record grows two facts it never kept — when the last clip succeeded, and whether the token has been rejected — and the service worker sets the second from a single wrap around `respond`, so every route reports a dead token without ten separate hooks.

**Tech Stack:** TypeScript (strict, no `any`), Vitest (node env; DOM tests opt into jsdom via a docblock), Biome, esbuild, MV3 (Chrome + Firefox), Bun as the runner.

**Spec:** [`docs/superpowers/specs/2026-08-14-setup-trust-and-lane-inputs-design.md`](../specs/2026-08-14-setup-trust-and-lane-inputs-design.md) — read the "Slice 1 — Setup that works" section and the "Review dispositions" table before starting.

## Global Constraints

Copied from the spec and `CLAUDE.md`. Every task's requirements implicitly include this section.

- **Loopback only.** The only network destination is `127.0.0.1` / `localhost`. Never add a host permission or a fetch beyond those. Origin validation lives in `src/shared/gateway.ts` (**I6**).
- **No port scanning.** Discovery probes exactly two candidates: `http://127.0.0.1:7474`, then `http://localhost:7474`. Not a range, not a sweep.
- **Probe order is `127.0.0.1` first, and probes stay sequential.** Never concurrent — see the spec's "The order is load-bearing".
- **The bearer token is never logged, never rendered, never crosses into a page DOM.** The pairing code is treated the same.
- **No `console.*` anywhere in `src/`.** Biome enforces `noConsole` there. Tests and `scripts/` may log.
- **TypeScript strict, no `any`.** Cross-boundary data is `unknown`, narrowed by a guard in `src/shared/messages.ts`.
- **Keep pure logic out of the `chrome.*` seam** (`src/browser/`) so it stays unit-testable.
- **Bundled, no runtime deps.** Add no dependency.
- **Health probe timeout: 800 ms.** Named constant, not a literal at the call site.
- **Locking is for never-configured, never for broken.** A stage that has completed once never returns to `locked`.
- **Green bar:** `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build` must pass before any commit.

---

## File Structure

**Create:**
- `src/shared/discovery.ts` — pure: the ordered candidate origins and the pick decision. No `chrome.*`, no `fetch`.
- `src/options/setup-view.ts` — pure: `stagesFrom(status)` → each stage's state. No DOM.
- `test/unit/discovery.test.ts`, `test/unit/setup-view.test.ts`

**Modify:**
- `src/shared/gateway.ts` — add the `health` endpoint to `GATEWAY_PATHS`
- `src/background/gateway-client.ts` — add `probeHealth`
- `src/shared/types.ts` — `Connection` grows `lastClipAt?` / `stale?`
- `src/background/connection-store.ts` — `markClipSuccess`, `markStale`, `clearStale`, and a shared write chain that `setConnection` / `clearConnection` now also use
- `src/shared/messages.ts` — `ConnectionResponse` paired arm grows four fields; add `DiscoverRequest` / `DiscoverResponse` + guards
- `src/background/handlers.ts` — `handleConnectionStatus` extended; new `handleDiscover`
- `src/background/service-worker.ts` — wrap `respond`; route `discover`
- `src/options/options.html`, `src/options/options.css`, `src/options/options.ts` — the four stages and the trust panel
- `CHANGELOG.md`, `docs/architecture.md`, `docs/development.md`

**Existing tests to extend:** `test/unit/gateway.test.ts`, `test/unit/gateway-client.test.ts`, `test/unit/connection-store.test.ts`, `test/unit/messages.test.ts`, `test/unit/handlers.test.ts`, `test/unit/service-worker.test.ts`, `test/unit/options.test.ts`

---

## Task 1: Discovery candidates (pure)

**Files:**
- Create: `src/shared/discovery.ts`
- Test: `test/unit/discovery.test.ts`

**Interfaces:**
- Consumes: `isLoopbackOrigin` from `src/shared/gateway.ts`
- Produces: `DISCOVERY_CANDIDATES: readonly string[]`, `pickReachable(results: readonly ProbeResult[]): string | null`, `type ProbeResult = { readonly origin: string; readonly reachable: boolean }`

- [ ] **Step 1: Write the failing test**

Create `test/unit/discovery.test.ts`:

```ts
// test/unit/discovery.test.ts
import { describe, expect, test } from "vitest";
import {
  DISCOVERY_CANDIDATES,
  pickReachable,
  type ProbeResult,
} from "../../src/shared/discovery.ts";
import { isLoopbackOrigin } from "../../src/shared/gateway.ts";

describe("discovery candidates", () => {
  test("probes exactly two origins — never a port range", () => {
    expect(DISCOVERY_CANDIDATES).toHaveLength(2);
  });

  test("127.0.0.1 is probed first", () => {
    expect(DISCOVERY_CANDIDATES[0]).toBe("http://127.0.0.1:7474");
    expect(DISCOVERY_CANDIDATES[1]).toBe("http://localhost:7474");
  });

  test("every candidate is a loopback origin (I6)", () => {
    for (const origin of DISCOVERY_CANDIDATES) {
      expect(isLoopbackOrigin(origin)).toBe(true);
    }
  });
});

describe("pickReachable", () => {
  test("returns the first reachable origin in candidate order", () => {
    const results: ProbeResult[] = [
      { origin: "http://127.0.0.1:7474", reachable: true },
      { origin: "http://localhost:7474", reachable: true },
    ];
    expect(pickReachable(results)).toBe("http://127.0.0.1:7474");
  });

  test("falls through to a later candidate when the first is unreachable", () => {
    const results: ProbeResult[] = [
      { origin: "http://127.0.0.1:7474", reachable: false },
      { origin: "http://localhost:7474", reachable: true },
    ];
    expect(pickReachable(results)).toBe("http://localhost:7474");
  });

  test("no reachable candidate → null, so the manual field stays the answer", () => {
    const results: ProbeResult[] = [
      { origin: "http://127.0.0.1:7474", reachable: false },
      { origin: "http://localhost:7474", reachable: false },
    ];
    expect(pickReachable(results)).toBeNull();
  });

  test("empty results → null", () => {
    expect(pickReachable([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- discovery`
Expected: FAIL — `Cannot find module '../../src/shared/discovery.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/shared/discovery.ts`:

```ts
// Zero-config gateway discovery (roadmap 3.5). Pure: the candidate list and the
// pick decision only — the probing itself is gateway-client.ts's job, because it
// touches the network.

/**
 * The origins discovery probes, in order.
 *
 * TWO candidates, never a range. A port sweep is slow, it is the one behaviour in
 * this extension that would look like malware to anyone watching the socket
 * table, and it buys a case the manual URL field already covers.
 *
 * `127.0.0.1` is FIRST because the gateway binds `127.0.0.1` and nothing else
 * (invariant I6) — it is the literal address of the thing we are looking for.
 * `localhost` is a fallback for a gateway reached by name and will rarely fire:
 * on Windows it may resolve to `::1` under dual-stack resolution, which a gateway
 * bound to IPv4 loopback refuses. That is exactly why it must not be probed first.
 */
export const DISCOVERY_CANDIDATES: readonly string[] = Object.freeze([
  "http://127.0.0.1:7474",
  "http://localhost:7474",
]);

export interface ProbeResult {
  readonly origin: string;
  readonly reachable: boolean;
}

/**
 * The first reachable origin, or null when none answered.
 *
 * Null is not a failure state — it means "ask the user", and the manual URL field
 * does not go away just because discovery exists.
 */
export function pickReachable(results: readonly ProbeResult[]): string | null {
  return results.find((r) => r.reachable)?.origin ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- discovery`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/discovery.ts test/unit/discovery.test.ts
git commit -m "feat(discovery): the two loopback candidates, in order"
```

---

## Task 2: The health probe

**Files:**
- Modify: `src/shared/gateway.ts` (add `health` to `GATEWAY_PATHS`)
- Modify: `src/background/gateway-client.ts` (add `HEALTH_TIMEOUT_MS` + `probeHealth`)
- Test: `test/unit/gateway.test.ts`, `test/unit/gateway-client.test.ts`

**Interfaces:**
- Consumes: `endpointUrl` and `isLoopbackOrigin` from `src/shared/gateway.ts`; `FetchLike` from `src/background/gateway-client.ts`
- Produces: `probeHealth(origin: string, doFetch?: FetchLike): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/gateway.test.ts`:

```ts
describe("health endpoint", () => {
  test("health is a contracted path", () => {
    expect(endpointUrl("http://127.0.0.1:7474", "health")).toBe(
      "http://127.0.0.1:7474/v1/health",
    );
  });
});
```

Append to `test/unit/gateway-client.test.ts`:

```ts
describe("probeHealth", () => {
  test("200 with status ok → reachable", async () => {
    const doFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ status: "ok", gateway: "read_only_http" }), {
        status: 200,
      });
    expect(await probeHealth("http://127.0.0.1:7474", doFetch)).toBe(true);
  });

  test("a non-200 is not reachable", async () => {
    const doFetch = async (): Promise<Response> => new Response("nope", { status: 404 });
    expect(await probeHealth("http://127.0.0.1:7474", doFetch)).toBe(false);
  });

  test("a 200 that is not this gateway's health shape is not reachable", async () => {
    const doFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ hello: "world" }), { status: 200 });
    expect(await probeHealth("http://127.0.0.1:7474", doFetch)).toBe(false);
  });

  test("a thrown fetch (connection refused, abort) is not reachable", async () => {
    const doFetch = async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    };
    expect(await probeHealth("http://127.0.0.1:7474", doFetch)).toBe(false);
  });

  test("a non-loopback origin is refused WITHOUT a request (I6)", async () => {
    let called = false;
    const doFetch = async (): Promise<Response> => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    expect(await probeHealth("https://evil.example", doFetch)).toBe(false);
    expect(called).toBe(false);
  });

  test("a loopback lookalike host is refused without a request", async () => {
    let called = false;
    const doFetch = async (): Promise<Response> => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    expect(await probeHealth("http://127.0.0.1.attacker.com", doFetch)).toBe(false);
    expect(called).toBe(false);
  });
});
```

Add `probeHealth` to that file's existing import from `../../src/background/gateway-client.ts`, and `endpointUrl` to `gateway.test.ts`'s imports if it is not already there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- gateway`
Expected: FAIL — `probeHealth is not a function`, and `endpointUrl(..., "health")` is a type error

- [ ] **Step 3: Write the implementation**

In `src/shared/gateway.ts`, add to `GATEWAY_PATHS` (after `itemsFetch`, before the `agents` block comment):

```ts
  /**
   * Unauthenticated liveness — the ONLY route this client calls without a bearer
   * token. Served by the same server as the clip routes
   * (packages/gateway/src/ipc/http-server.ts, dispatchReadOnlyDataGet), so an
   * answer here means the gateway that ingests clips is up, not merely that
   * something is listening on the port.
   */
  health: "/v1/health",
```

In `src/background/gateway-client.ts`, add the timeout beside the others:

```ts
const HEALTH_TIMEOUT_MS = 800;
```

and add `probeHealth` (place it directly after `confirmPair`, since discovery precedes pairing in the user's journey), importing `isLoopbackOrigin` from `../shared/gateway.ts`:

```ts
/**
 * Is a Nimbus gateway answering on this origin?
 *
 * The only tokenless call this client makes. That is exactly why the loopback
 * check is repeated here rather than assumed: every other route carries a bearer
 * token and inherits the origin discipline of the stored connection, so this must
 * not become the one place I6 is enforced more loosely. Today `DISCOVERY_CANDIDATES`
 * is a frozen constant and the check cannot fail — it is asserted anyway, for
 * whoever makes that list configurable.
 *
 * Returns a plain boolean: a probe has exactly two outcomes the caller can act
 * on, and any richer result would tempt a caller into treating "the gateway said
 * something odd" as "the gateway is up".
 */
export async function probeHealth(
  origin: string,
  doFetch: FetchLike = fetch,
): Promise<boolean> {
  if (!isLoopbackOrigin(origin)) {
    return false;
  }
  let res: Response;
  try {
    res = await getJsonAt(doFetch, endpointUrl(origin, "health"), {}, HEALTH_TIMEOUT_MS);
  } catch {
    // Connection refused, DNS failure, or the 800ms abort. All mean "not here".
    return false;
  }
  if (!res.ok) {
    return false;
  }
  // Shape-check the body: something else listening on 7474 can return 200.
  //
  // `readJson` is deliberately OUTSIDE the try above, and that is safe: it is
  // total — it catches its own `res.json()` rejection and returns null
  // (gateway-client.ts:119-125), so a non-JSON body from whatever else is on
  // this port yields `null` here, not a throw. Do not widen the try to cover it;
  // a catch that can never fire reads as a real failure mode to the next person.
  const data = await readJson(res);
  return isObject(data) && data["status"] === "ok";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- gateway`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/gateway.ts src/background/gateway-client.ts test/unit/gateway.test.ts test/unit/gateway-client.test.ts
git commit -m "feat(gateway): probe /v1/health, loopback-checked, 800ms"
```

---

## Task 3: The connection record remembers two more facts

**Files:**
- Modify: `src/shared/types.ts:10-15` (the `Connection` interface)
- Modify: `src/background/connection-store.ts`
- Test: `test/unit/connection-store.test.ts`

**Interfaces:**
- Consumes: `Connection` from `src/shared/types.ts`; `getConnection` / `setConnection` from `src/background/connection-store.ts`
- Produces: `markClipSuccess(nowMs: number): Promise<void>`, `markStale(): Promise<void>`, `clearStale(): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/connection-store.test.ts` (extend the existing import to include the three new functions):

```ts
describe("connection health facts", () => {
  test("a record without the new fields still loads (migration)", async () => {
    installChromeStub({ storage: { connection: conn } });
    const loaded = await getConnection();
    expect(loaded?.label).toBe("chrome");
    expect(loaded?.lastClipAt).toBeUndefined();
    expect(loaded?.stale).toBeUndefined();
  });

  test("markClipSuccess records the timestamp", async () => {
    installChromeStub();
    await setConnection(conn);
    await markClipSuccess(1234);
    expect((await getConnection())?.lastClipAt).toBe(1234);
  });

  test("markClipSuccess also clears a stale flag — a clip proves the token works", async () => {
    installChromeStub();
    await setConnection({ ...conn, stale: true });
    await markClipSuccess(1234);
    expect((await getConnection())?.stale).toBe(false);
  });

  test("markStale sets the flag without touching the token", async () => {
    installChromeStub();
    await setConnection(conn);
    await markStale();
    const loaded = await getConnection();
    expect(loaded?.stale).toBe(true);
    expect(loaded?.token).toBe("tok");
  });

  test("clearStale unsets it", async () => {
    installChromeStub();
    await setConnection({ ...conn, stale: true });
    await clearStale();
    expect((await getConnection())?.stale).toBe(false);
  });

  test("marking with no connection stored is a no-op, not a crash", async () => {
    installChromeStub();
    await markStale();
    await markClipSuccess(1);
    expect(await getConnection()).toBeNull();
  });

  test("a re-pair racing a 401 keeps the NEW token, not the old one", async () => {
    installChromeStub();
    await setConnection(conn);
    const fresh: Connection = { ...conn, token: "new-tok", label: "re-paired", pairedAt: 99 };

    // A queue flush 401s at the same moment the user re-pairs. Both are started
    // before either is awaited, which is exactly how they interleave in the
    // service worker.
    const marking = markStale();
    const pairing = setConnection(fresh);
    await Promise.all([marking, pairing]);

    const stored = await getConnection();
    expect(stored?.token).toBe("new-tok");
    expect(stored?.label).toBe("re-paired");
    // THIS is the assertion that distinguishes fixed from unfixed, so do not
    // drop it as redundant. On the shared chain, markStale runs FIRST (it was
    // enqueued first) and setConnection's whole-record write lands after it, so
    // the fresh record has no `stale` field at all. Without the chain,
    // setConnection writes immediately and markStale's read-modify-write lands
    // after it — re-flagging the brand-new token as rejected.
    expect(stored?.stale).toBeUndefined();
  });

  test("unpair racing a clip success leaves nothing behind", async () => {
    installChromeStub();
    await setConnection(conn);

    const marking = markClipSuccess(5);
    const clearing = clearConnection();
    await Promise.all([marking, clearing]);

    expect(await getConnection()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- connection-store`
Expected: FAIL — `markClipSuccess is not a function`

- [ ] **Step 3: Write the implementation**

In `src/shared/types.ts`, extend the interface:

```ts
export interface Connection {
  readonly origin: string;
  readonly token: string;
  readonly label: string;
  readonly pairedAt: number;
  /**
   * When a clip last succeeded against this gateway. OPTIONAL because pairings
   * made before this shipped do not have it — absent means "no clip yet", which
   * is also true of a fresh pairing, so no migration is needed.
   */
  readonly lastClipAt?: number;
  /**
   * The gateway has rejected this token (401). Surfaced as "needs re-pairing",
   * which is the one thing a user can act on and cannot guess: a revoked token
   * and a stopped gateway look identical from the outside.
   */
  readonly stale?: boolean;
}
```

In `src/background/connection-store.ts`, keep `isConnection` as-is — the new fields are optional and an old record must still load — and add the write chain. **`setConnection` and `clearConnection` must be routed through it too**, not left as direct writes:

```ts
/**
 * ONE serialised chain for every write to the connection key.
 *
 * The read-modify-write helpers below are the obvious reason: a clip success and
 * a 401 arriving together would both read the pre-change record, and the second
 * write would drop the first one's edit — the same lost-update guard
 * `options.ts`'s `mutateOrigins` applies to the origin list.
 *
 * The NON-obvious reason is why `setConnection` and `clearConnection` go through
 * it as well. They replace the whole record, and their callers are `handlePair`
 * and `handleUnpair`. A queue flush that 401s while the user is re-pairing would
 * otherwise interleave as: `mutate` reads the OLD record → `setConnection` writes
 * the NEW one → `mutate` writes back its transform of the old one. The fresh
 * token is silently reverted to the dead one it just replaced, and the user is
 * told to re-pair a browser they have just re-paired. Narrow window, severe
 * outcome, and it costs one shared chain to close.
 *
 * In-memory only, and that is sufficient: the chain orders overlapping writes
 * within one service-worker lifetime, and MV3 runs exactly one service-worker
 * instance. Across an eviction there is no chain — and no concurrency either,
 * because there is no other writer alive to race with.
 */
let writes: Promise<void> = Promise.resolve();

function enqueue(op: () => Promise<void>): Promise<void> {
  writes = writes.catch(() => undefined).then(op);
  return writes;
}

/**
 * Read-modify-write the stored connection, or do nothing when there is none.
 *
 * `transform` returns a NEW object (`{ ...c, stale: true }`); it must never
 * mutate its argument in place, since callers elsewhere may hold the record it
 * was handed.
 */
function mutate(transform: (c: Connection) => Connection): Promise<void> {
  return enqueue(async () => {
    const current = await getConnection();
    if (current === null) {
      return;
    }
    await storageSet(CONNECTION_KEY, transform(current));
  });
}

/** A successful clip proves the token works, so it also clears `stale`. */
export function markClipSuccess(nowMs: number): Promise<void> {
  return mutate((c) => ({ ...c, lastClipAt: nowMs, stale: false }));
}

export function markStale(): Promise<void> {
  return mutate((c) => ({ ...c, stale: true }));
}

export function clearStale(): Promise<void> {
  return mutate((c) => ({ ...c, stale: false }));
}
```

Then change the two existing whole-record writers to use the chain. Their
signatures and behaviour are unchanged — only their ordering guarantee improves:

```ts
export function setConnection(c: Connection): Promise<void> {
  return enqueue(() => storageSet(CONNECTION_KEY, c));
}

export function clearConnection(): Promise<void> {
  return enqueue(() => storageRemove(CONNECTION_KEY));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- connection-store`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/background/connection-store.ts test/unit/connection-store.test.ts
git commit -m "feat(connection): remember the last clip and a rejected token"
```

---

## Task 4: The connection status message carries the health facts

**Files:**
- Modify: `src/shared/messages.ts:228-236` (`ConnectionResponse`), plus `isConnectionResponse`
- Test: `test/unit/messages.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `ConnectionResponse` paired arm now `{ kind, paired: true, label, origin, pairedAt, lastClipAt?, queueDepth, reachable, stale }`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/messages.test.ts`:

```ts
describe("ConnectionResponse health fields", () => {
  test("a full paired response is accepted", () => {
    expect(
      isConnectionResponse({
        kind: "connection",
        paired: true,
        label: "chrome",
        origin: "http://127.0.0.1:7474",
        pairedAt: 1,
        lastClipAt: 2,
        queueDepth: 3,
        reachable: true,
        stale: false,
      }),
    ).toBe(true);
  });

  test("lastClipAt is optional — a fresh pairing has never clipped", () => {
    expect(
      isConnectionResponse({
        kind: "connection",
        paired: true,
        label: "chrome",
        origin: "http://127.0.0.1:7474",
        pairedAt: 1,
        queueDepth: 0,
        reachable: true,
        stale: false,
      }),
    ).toBe(true);
  });

  test("a paired response missing queueDepth is rejected", () => {
    expect(
      isConnectionResponse({
        kind: "connection",
        paired: true,
        label: "chrome",
        origin: "http://127.0.0.1:7474",
        pairedAt: 1,
        reachable: true,
        stale: false,
      }),
    ).toBe(false);
  });

  test("the unpaired arm is unchanged", () => {
    expect(isConnectionResponse({ kind: "connection", paired: false })).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- messages`
Expected: FAIL — the "missing queueDepth is rejected" case returns `true`

- [ ] **Step 3: Write the implementation**

Replace the paired arm in `src/shared/messages.ts`:

```ts
export type ConnectionResponse =
  | { readonly kind: "connection"; readonly paired: false }
  | {
      readonly kind: "connection";
      readonly paired: true;
      readonly label: string;
      readonly origin: string;
      readonly pairedAt: number;
      /** Absent when no clip has ever succeeded — including on a fresh pairing. */
      readonly lastClipAt?: number;
      readonly queueDepth: number;
      readonly reachable: boolean;
      readonly stale: boolean;
    };
```

Then update `isConnectionResponse` so the paired arm requires the three new non-optional fields. Locate the existing function and extend its paired branch:

```ts
  return (
    typeof v["label"] === "string" &&
    typeof v["origin"] === "string" &&
    typeof v["pairedAt"] === "number" &&
    typeof v["queueDepth"] === "number" &&
    typeof v["reachable"] === "boolean" &&
    typeof v["stale"] === "boolean" &&
    (v["lastClipAt"] === undefined || typeof v["lastClipAt"] === "number")
  );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- messages`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/messages.ts test/unit/messages.test.ts
git commit -m "feat(messages): connection status carries queue depth, reachability, staleness"
```

---

## Task 5: `handleConnectionStatus` answers with them, and `handleDiscover` finds a gateway

**Files:**
- Modify: `src/background/handlers.ts:616-632`
- Modify: `src/shared/messages.ts` (add `DiscoverRequest` / `DiscoverResponse` + guard, extend `ExtensionRequest` / `ExtensionResponse`)
- Test: `test/unit/handlers.test.ts`

**Interfaces:**
- Consumes: `ProbeResult`, `DISCOVERY_CANDIDATES`, `pickReachable` (Task 1); `probeHealth` (Task 2)
- Produces:
  - `ConnectionStatusDeps = { getConnection, getQueueDepth: () => Promise<number>, probeReachable: (origin: string) => Promise<boolean> }`
  - `handleDiscover(deps: DiscoverDeps): Promise<DiscoverResponse>` where `DiscoverDeps = { probeReachable: (origin: string) => Promise<boolean> }`
  - `DiscoverResponse = { readonly kind: "discover"; readonly origin: string | null }`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/handlers.test.ts`:

```ts
describe("handleConnectionStatus", () => {
  const conn = {
    origin: "http://127.0.0.1:7474",
    token: "tok",
    label: "chrome",
    pairedAt: 10,
    lastClipAt: 20,
  };

  test("unpaired needs no probe and no queue read", async () => {
    let probed = false;
    const res = await handleConnectionStatus({
      getConnection: async () => null,
      getQueueDepth: async () => 5,
      probeReachable: async () => {
        probed = true;
        return true;
      },
    });
    expect(res).toEqual({ kind: "connection", paired: false });
    expect(probed).toBe(false);
  });

  test("paired reports depth, reachability and the last clip", async () => {
    const res = await handleConnectionStatus({
      getConnection: async () => conn,
      getQueueDepth: async () => 3,
      probeReachable: async () => true,
    });
    expect(res).toEqual({
      kind: "connection",
      paired: true,
      label: "chrome",
      origin: "http://127.0.0.1:7474",
      pairedAt: 10,
      lastClipAt: 20,
      queueDepth: 3,
      reachable: true,
      stale: false,
    });
  });

  test("the token never crosses the boundary", async () => {
    const res = await handleConnectionStatus({
      getConnection: async () => conn,
      getQueueDepth: async () => 0,
      probeReachable: async () => true,
    });
    expect(JSON.stringify(res)).not.toContain("tok");
  });

  test("a stored stale flag is reported as stale", async () => {
    const res = await handleConnectionStatus({
      getConnection: async () => ({ ...conn, stale: true }),
      getQueueDepth: async () => 0,
      probeReachable: async () => true,
    });
    expect(res).toMatchObject({ paired: true, stale: true });
  });

  test("an unreachable gateway is reported, not thrown", async () => {
    const res = await handleConnectionStatus({
      getConnection: async () => conn,
      getQueueDepth: async () => 0,
      probeReachable: async () => false,
    });
    expect(res).toMatchObject({ paired: true, reachable: false });
  });
});

describe("handleDiscover", () => {
  test("returns the first candidate that answers", async () => {
    const res = await handleDiscover({
      probeReachable: async (origin) => origin === "http://127.0.0.1:7474",
    });
    expect(res).toEqual({ kind: "discover", origin: "http://127.0.0.1:7474" });
  });

  test("probes sequentially and stops at the first hit", async () => {
    const seen: string[] = [];
    await handleDiscover({
      probeReachable: async (origin) => {
        seen.push(origin);
        return true;
      },
    });
    expect(seen).toEqual(["http://127.0.0.1:7474"]);
  });

  test("falls through to the second candidate", async () => {
    const seen: string[] = [];
    const res = await handleDiscover({
      probeReachable: async (origin) => {
        seen.push(origin);
        return origin === "http://localhost:7474";
      },
    });
    expect(seen).toEqual(["http://127.0.0.1:7474", "http://localhost:7474"]);
    expect(res).toEqual({ kind: "discover", origin: "http://localhost:7474" });
  });

  test("nothing answers → null, so Options keeps the manual field", async () => {
    const res = await handleDiscover({ probeReachable: async () => false });
    expect(res).toEqual({ kind: "discover", origin: null });
  });

  test("a throwing probe does not cost the next candidate its turn", async () => {
    const seen: string[] = [];
    const res = await handleDiscover({
      probeReachable: async (origin) => {
        seen.push(origin);
        if (origin === "http://127.0.0.1:7474") {
          throw new Error("boom");
        }
        return true;
      },
    });
    expect(seen).toEqual(["http://127.0.0.1:7474", "http://localhost:7474"]);
    expect(res).toEqual({ kind: "discover", origin: "http://localhost:7474" });
  });

  test("every probe throwing is a miss, not a rejection", async () => {
    const res = await handleDiscover({
      probeReachable: async () => {
        throw new Error("boom");
      },
    });
    expect(res).toEqual({ kind: "discover", origin: null });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- handlers`
Expected: FAIL — `handleDiscover is not a function`, and `handleConnectionStatus` rejects the new deps

- [ ] **Step 3: Write the implementation**

In `src/shared/messages.ts`, add the request/response and guard, and add `DiscoverRequest` to `ExtensionRequest` and `DiscoverResponse` to `ExtensionResponse`:

```ts
/** Ask the service worker to find a local gateway (roadmap 3.5). */
export interface DiscoverRequest {
  readonly kind: "discover";
}

export type DiscoverResponse = {
  readonly kind: "discover";
  /** The origin that answered, or null — null means "ask the user", not "error". */
  readonly origin: string | null;
};

export function isDiscoverRequest(v: unknown): v is DiscoverRequest {
  return isObject(v) && v["kind"] === "discover";
}
```

In `src/background/handlers.ts`, replace `handleConnectionStatus` and add `handleDiscover`:

```ts
export interface ConnectionStatusDeps {
  readonly getConnection: () => Promise<Connection | null>;
  readonly getQueueDepth: () => Promise<number>;
  readonly probeReachable: (origin: string) => Promise<boolean>;
}

export async function handleConnectionStatus(
  deps: ConnectionStatusDeps,
): Promise<ConnectionResponse> {
  const conn = await deps.getConnection();
  if (conn === null) {
    // No probe and no queue read: there is no origin to probe, and an unpaired
    // browser has nothing to report. Doing the work anyway would put a network
    // call behind opening Options on a fresh install.
    return { kind: "connection", paired: false };
  }
  const [queueDepth, reachable] = await Promise.all([
    deps.getQueueDepth(),
    deps.probeReachable(conn.origin),
  ]);
  // Explicit field-by-field projection — the token is deliberately omitted so it
  // never crosses the messaging boundary into the Options page.
  return {
    kind: "connection",
    paired: true,
    label: conn.label,
    origin: conn.origin,
    pairedAt: conn.pairedAt,
    ...(conn.lastClipAt === undefined ? {} : { lastClipAt: conn.lastClipAt }),
    queueDepth,
    reachable,
    stale: conn.stale === true,
  };
}

export interface DiscoverDeps {
  readonly probeReachable: (origin: string) => Promise<boolean>;
}

/**
 * Probe the candidates IN ORDER and stop at the first hit.
 *
 * Sequential on purpose — see the design spec. Concurrent probing would always
 * dial a candidate we expect to fail, and needs a tiebreak between two routes to
 * the same gateway that buys nothing.
 */
export async function handleDiscover(deps: DiscoverDeps): Promise<DiscoverResponse> {
  const results: ProbeResult[] = [];
  for (const origin of DISCOVERY_CANDIDATES) {
    // One candidate's failure must never cost the next candidate its turn.
    // `probeHealth` does not throw today, but the guard belongs HERE rather than
    // in the probe: this loop's contract is "try each candidate", and it should
    // hold for any probe implementation, including a future one that throws.
    const reachable = await deps.probeReachable(origin).catch(() => false);
    results.push({ origin, reachable });
    if (reachable) {
      break;
    }
  }
  return { kind: "discover", origin: pickReachable(results) };
}
```

Add the imports at the top of `handlers.ts`:

```ts
import { DISCOVERY_CANDIDATES, pickReachable, type ProbeResult } from "../shared/discovery.ts";
```

and add `DiscoverResponse` to the existing `../shared/messages.ts` type import.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- handlers`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/messages.ts src/background/handlers.ts test/unit/handlers.test.ts
git commit -m "feat(handlers): connection health, and discovery that stops at the first hit"
```

---

## Task 6: Wire it into the service worker, and mark a rejected token once

**Files:**
- Modify: `src/background/service-worker.ts:501` (wrap `respond`), the `connection-status` route at `:633`, and add a `discover` route
- Test: `test/unit/service-worker.test.ts`

**Interfaces:**
- Consumes: `handleDiscover`, `ConnectionStatusDeps` (Task 5); `markClipSuccess`, `markStale`, `clearStale` (Task 3); `probeHealth` (Task 2); `getQueue` from `src/background/clip-queue-store.ts`
- Produces: no new exports — this is wiring

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/service-worker.test.ts`, following the file's existing pattern for dispatching a message through the registered listener:

```ts
describe("a rejected token is remembered", () => {
  test("a 401 from the gateway sets stale on the stored connection", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(401, { error: "unauthorized" }));

    const res = await harness.emitMessage({ kind: "clip", capture, tags: [] });
    await settle();

    expect(res).toMatchObject({ kind: "clip", ok: false, reason: "unauthorized" });
    expect((harness.storage.get(CONNECTION_KEY) as Connection).stale).toBe(true);
  });

  test("a successful clip records the time and leaves stale false", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, { ...conn, stale: true });
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes(200, { id: "1", status: "created" }));

    await harness.emitMessage({ kind: "clip", capture, tags: [] });
    await settle();

    const stored = harness.storage.get(CONNECTION_KEY) as Connection;
    expect(stored.stale).toBe(false);
    expect(typeof stored.lastClipAt).toBe("number");
  });

  test("an unreachable gateway is NOT a rejected token", async () => {
    await load();
    harness.storage.set(CONNECTION_KEY, conn);
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await harness.emitMessage({ kind: "clip", capture, tags: [] });
    await settle();

    expect((harness.storage.get(CONNECTION_KEY) as Connection).stale).toBeUndefined();
  });
});

describe("discover route", () => {
  test("responds with the first origin that answers", async () => {
    await load();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonRes(200, { status: "ok", gateway: "read_only_http" }));

    const res = await harness.emitMessage({ kind: "discover" });

    expect(res).toEqual({ kind: "discover", origin: "http://127.0.0.1:7474" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:7474/v1/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  test("nothing listening responds with null, not an error", async () => {
    await load();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await harness.emitMessage({ kind: "discover" });

    expect(res).toEqual({ kind: "discover", origin: null });
  });

  test("discovery needs no pairing — it is the step before pairing", async () => {
    await load();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonRes(200, { status: "ok", gateway: "read_only_http" }));

    const res = await harness.emitMessage({ kind: "discover" });

    expect(res).toEqual({ kind: "discover", origin: "http://127.0.0.1:7474" });
    // No Authorization header on the only tokenless route in the client.
    const init = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1];
    expect(JSON.stringify(init)).not.toContain("Authorization");
  });
});
```

> **Harness note.** These use the file's existing helpers exactly as the
> surrounding tests do: `load()` installs a fresh chrome mock and imports the
> service worker, `harness.emitMessage(msg)` drives the message listener,
> `harness.storage` is the backing `chrome.storage.local` map, `jsonRes(status,
> body)` builds a response, and `settle()` lets fire-and-forget storage writes
> land. `markStale` is fire-and-forget, so **`await settle()` before asserting on
> storage** — without it the assertion races the write. Add `Connection` to the
> file's existing type import from `../../src/shared/types.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- service-worker`
Expected: FAIL — no `discover` route; nothing marks stale

- [ ] **Step 3: Write the implementation**

At the top of the message listener in `src/background/service-worker.ts`, rename the parameter and wrap it:

```ts
/**
 * True when a response tells us the gateway rejected our token.
 *
 * Checked in ONE place rather than hooked into each handler: every route that can
 * 401 already reports it the same way, so a single wrap around `respond` cannot
 * drift, and adding a route later gets the behaviour for free.
 */
function carriesUnauthorized(res: unknown): boolean {
  return (
    typeof res === "object" &&
    res !== null &&
    (res as { reason?: unknown }).reason === "unauthorized"
  );
}

addMessageListener((message, rawRespond, sender) => {
  const respond = (res: unknown): void => {
    if (carriesUnauthorized(res)) {
      // Fire-and-forget: the user's answer must not wait on a storage write, and
      // a failed write only means the flag is set on the next 401.
      //
      // `.catch` is REQUIRED, not decoration. `void` does not attach a rejection
      // handler, so a failing `chrome.storage.local.set` here would surface as an
      // unhandled rejection in the service worker — and fail the Vitest run. This
      // is the same `.catch(() => undefined)` the file already uses for its other
      // fire-and-forget calls (`injectPanel`, `endPause`, `ensureAlarm`).
      void markStale().catch(() => undefined);
    }
    rawRespond(res);
  };
  // ... the existing body is unchanged from here down
```

Update the `connection-status` route to supply the new deps:

```ts
  if (isConnectionStatusRequest(message)) {
    handleConnectionStatus({
      getConnection,
      getQueueDepth: async () => (await getQueue()).length,
      probeReachable: (origin) => probeHealth(origin),
    })
      .then(respond)
      .catch(() => {
        respond({ kind: "connection", paired: false });
      });
    return true;
  }
```

Add the `discover` route beside it:

```ts
  if (isDiscoverRequest(message)) {
    handleDiscover({ probeReachable: (origin) => probeHealth(origin) })
      .then(respond)
      .catch(() => {
        // A discovery failure is "we did not find one", never an error state —
        // the manual URL field is the fallback and it is always present.
        respond({ kind: "discover", origin: null });
      });
    return true;
  }
```

In the clip route, record success. Locate the `isClipRequest` branch and extend its `.then`:

```ts
      .then((res) => {
        if (res.ok) {
          // Same rule as markStale above: `void` alone would leave a rejection
          // unhandled.
          void markClipSuccess(Date.now()).catch(() => undefined);
        }
        respond(res);
      })
```

In the pair route, clear staleness on a confirmed pair — a new token is by definition not rejected yet. `handlePair` already calls `setConnection`, which writes a record with no `stale` field, so no extra call is needed; **verify this** by asserting in `test/unit/handlers.test.ts` that a re-pair produces a record with `stale` absent or `false`. If `handlePair` merges rather than replaces, call `clearStale()` after it.

Add the imports:

```ts
import { markClipSuccess, markStale } from "./connection-store.ts";
import { getQueue } from "./clip-queue-store.ts";
import { probeHealth } from "./gateway-client.ts";
import { handleDiscover } from "./handlers.ts";
import { isDiscoverRequest } from "../shared/messages.ts";
```

Merge each into the **existing** grouped import from that module rather than
adding a second import statement — Biome flags duplicates. Do **not** import
`clearStale` here: it is only needed if the re-pair verification above shows
`handlePair` merging rather than replacing the record, and an unused import
fails lint.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- service-worker` then `bun run test`
Expected: PASS, whole suite green

- [ ] **Step 5: Commit**

```bash
git add src/background/service-worker.ts test/unit/service-worker.test.ts
git commit -m "feat(background): route discovery, and notice a rejected token once"
```

---

## Task 7: The stage decision (pure)

**Files:**
- Create: `src/options/setup-view.ts`
- Test: `test/unit/setup-view.test.ts`

**Interfaces:**
- Consumes: `ConnectionResponse` from `src/shared/messages.ts`
- Produces: `type StageState = "active" | "done" | "needs-attention" | "locked"`, `type Stages = { connect: StageState; connection: StageState; sites: StageState; trust: StageState }`, `stagesFrom(res: ConnectionResponse): Stages`, `healthLine(res: ConnectionResponse, nowMs: number): string`

- [ ] **Step 1: Write the failing test**

Create `test/unit/setup-view.test.ts`:

```ts
// test/unit/setup-view.test.ts
import { describe, expect, test } from "vitest";
import { healthLine, stagesFrom } from "../../src/options/setup-view.ts";
import type { ConnectionResponse } from "../../src/shared/messages.ts";

const unpaired: ConnectionResponse = { kind: "connection", paired: false };
const paired: ConnectionResponse = {
  kind: "connection",
  paired: true,
  label: "chrome",
  origin: "http://127.0.0.1:7474",
  pairedAt: 1_000,
  queueDepth: 0,
  reachable: true,
  stale: false,
};

describe("stagesFrom", () => {
  test("a fresh install shows one thing to do", () => {
    expect(stagesFrom(unpaired)).toEqual({
      connect: "active",
      connection: "locked",
      sites: "locked",
      trust: "active",
    });
  });

  test("trust is never locked — it must be readable before pairing", () => {
    expect(stagesFrom(unpaired).trust).toBe("active");
  });

  test("pairing unlocks the rest", () => {
    expect(stagesFrom(paired)).toEqual({
      connect: "done",
      connection: "active",
      sites: "active",
      trust: "active",
    });
  });

  test("a stale token flags stage 1 but does NOT re-lock 2 and 3", () => {
    const stages = stagesFrom({ ...paired, stale: true });
    expect(stages.connect).toBe("needs-attention");
    expect(stages.connection).toBe("active");
    expect(stages.sites).toBe("active");
  });

  test("an unreachable gateway flags stage 1 but does NOT re-lock 2 and 3", () => {
    const stages = stagesFrom({ ...paired, reachable: false });
    expect(stages.connect).toBe("needs-attention");
    expect(stages.connection).toBe("active");
    expect(stages.sites).toBe("active");
  });
});

describe("healthLine", () => {
  test("unpaired says so", () => {
    expect(healthLine(unpaired, 0)).toBe("Not paired.");
  });

  test("a stale token names the fix, not the symptom", () => {
    expect(healthLine({ ...paired, stale: true }, 0)).toContain("Needs re-pairing");
  });

  test("stale wins over unreachable — re-pairing is the actionable one", () => {
    expect(healthLine({ ...paired, stale: true, reachable: false }, 0)).toContain(
      "Needs re-pairing",
    );
  });

  test("unreachable asks about the gateway", () => {
    expect(healthLine({ ...paired, reachable: false }, 0)).toContain("Can't reach");
  });

  test("healthy names the origin", () => {
    expect(healthLine(paired, 0)).toContain("http://127.0.0.1:7474");
  });

  test("a pending queue is reported", () => {
    expect(healthLine({ ...paired, queueDepth: 2 }, 0)).toContain("2 waiting to sync");
  });

  test("never-clipped does not claim a clip time", () => {
    expect(healthLine(paired, 0)).not.toContain("Last clip");
  });

  test("a recorded clip time is shown", () => {
    expect(healthLine({ ...paired, lastClipAt: 1 }, 1)).toContain("Last clip");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- setup-view`
Expected: FAIL — `Cannot find module '../../src/options/setup-view.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/options/setup-view.ts`:

```ts
// Pure stage-state decision for the Options page. No DOM, no chrome.* — this is
// the branching that used to live in options.ts's render functions, lifted out so
// it can be tested without a page.
import type { ConnectionResponse } from "../shared/messages.ts";
import { formatPairedSince } from "./connection-view.ts";

export type StageState = "active" | "done" | "needs-attention" | "locked";

export interface Stages {
  readonly connect: StageState;
  readonly connection: StageState;
  readonly sites: StageState;
  readonly trust: StageState;
}

/**
 * Which stages are open, and which one needs the user.
 *
 * LOCKING IS FOR NEVER-CONFIGURED, NEVER FOR BROKEN. A stale token or an
 * unreachable gateway flags stage 1 and leaves 2 and 3 open, because Unpair lives
 * in stage 2 — re-locking it would hide the only control that fixes the very
 * condition that caused the lock. Revoking page access (stage 3) has to stay
 * reachable for the same reason: a user withdrawing access is most likely to want
 * it when something is wrong.
 *
 * Stage 4 is ALWAYS open. "Where does my data go?" has to be answerable before
 * you commit, or it is answering a question you have already had to decide.
 */
export function stagesFrom(res: ConnectionResponse): Stages {
  if (!res.paired) {
    return { connect: "active", connection: "locked", sites: "locked", trust: "active" };
  }
  const healthy = !res.stale && res.reachable;
  return {
    connect: healthy ? "done" : "needs-attention",
    connection: "active",
    sites: "active",
    trust: "active",
  };
}

/**
 * One line of honest connection state.
 *
 * `stale` is checked BEFORE `reachable` deliberately: a revoked token and a
 * stopped gateway are indistinguishable from the outside, and only one of them
 * has a fix the user can act on. Telling someone to check whether their gateway
 * is running when the real answer is "re-pair" is the silent failure this exists
 * to end.
 */
export function healthLine(res: ConnectionResponse, nowMs: number): string {
  if (!res.paired) {
    return "Not paired.";
  }
  if (res.stale) {
    // A plain string, not a template literal: there is nothing to interpolate,
    // and Biome's noUnusedTemplateLiteral rejects the backtick form.
    return "Needs re-pairing — Nimbus rejected this browser's token. Run `nimbus clip pair` and pair again.";
  }
  if (!res.reachable) {
    return `Can't reach ${res.origin} — is the gateway running?`;
  }
  const parts = [`Connected to ${res.origin} as "${res.label}", since ${formatPairedSince(res.pairedAt)}.`];
  if (res.lastClipAt !== undefined) {
    parts.push(`Last clip ${formatPairedSince(res.lastClipAt)}.`);
  }
  if (res.queueDepth > 0) {
    parts.push(`${res.queueDepth} waiting to sync.`);
  }
  return parts.join(" ");
}
```

> `nowMs` is accepted but unused by the current copy. Keep the parameter — it is
> the seam a relative "3 minutes ago" would use, and adding it later would change
> every call site. If Biome flags the unused parameter, prefix it `_nowMs`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- setup-view`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git add src/options/setup-view.ts test/unit/setup-view.test.ts
git commit -m "feat(options): the stage decision, and one honest health line"
```

---

## Task 8: The four-stage Options markup

**Files:**
- Modify: `src/options/options.html`
- Modify: `src/options/options.css`
- Test: `test/unit/options.test.ts`

**Interfaces:**
- Consumes: nothing — markup only
- Produces: element ids `stage-connect`, `stage-connection`, `stage-sites`, `stage-trust`, `discover`, `discover-status`, `health-line`, `trust-origin`, `trust-hosts`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/options.test.ts` (the file already reads `options.html` from disk — follow its existing pattern):

```ts
describe("options.html stages", () => {
  test("has all four stages", () => {
    for (const id of ["stage-connect", "stage-connection", "stage-sites", "stage-trust"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test("has the discovery control and its status output", () => {
    expect(html).toContain('id="discover"');
    expect(html).toContain('id="discover-status"');
  });

  test("has a health line and the trust panel's data-driven slots", () => {
    expect(html).toContain('id="health-line"');
    expect(html).toContain('id="trust-origin"');
    expect(html).toContain('id="trust-hosts"');
  });

  test("the trust panel states the popup-lookup caveat", () => {
    expect(html).toContain("opening the popup");
  });

  test("the trust panel does not overclaim about the hotkey path", () => {
    expect(html).toContain("the hotkey shows you after");
  });

  test("the manual gateway URL field survives — discovery never removes it", () => {
    expect(html).toContain('id="origin"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- options`
Expected: FAIL — none of the new ids are present

- [ ] **Step 3: Write the implementation**

Rewrite the `<main>` of `src/options/options.html`. Keep every existing id (`origin`, `code`, `pair`, `pairing-status`, `connection-status`, `unpair`, `unpair-cancel`, `surface-origin`, `surface-product`, `surface-add`, `surface-status`, `surface-list`) — `options.ts` and its tests reference them, and renaming them is out of scope for this slice.

```html
    <main class="options">
      <h1>Nimbus Web Clipper</h1>

      <section id="stage-connect" class="stage">
        <h2><span class="stage__num">1</span> Connect</h2>
        <p>Nimbus runs on your own machine. Let's find it.</p>
        <button id="discover" type="button">Find my gateway</button>
        <output id="discover-status" class="options__status"></output>
        <label for="origin">Gateway URL</label>
        <input id="origin" type="text" placeholder="http://127.0.0.1:7474" />
        <p>Run <code>nimbus clip pair</code> on that machine, then enter the 6-digit code it prints.</p>
        <label for="code">Pairing code</label>
        <input id="code" type="text" inputmode="numeric" placeholder="429173" />
        <button id="pair" type="button">Pair this browser</button>
        <output id="pairing-status" class="options__status"></output>
      </section>

      <section id="stage-connection" class="stage">
        <h2><span class="stage__num">2</span> Connection</h2>
        <output id="health-line" class="options__status"></output>
        <output id="connection-status" class="options__status"></output>
        <button id="unpair" type="button">Unpair this browser</button>
        <button id="unpair-cancel" type="button" hidden>Cancel</button>
      </section>

      <section id="stage-sites" class="stage">
        <h2><span class="stage__num">3</span> Your sites</h2>
        <p>Nimbus recognises Bitbucket Cloud, GitHub, GitLab and Jira Cloud out of the box — grant page access below to use them. Add self-hosted instances too: include the full URL and any sub-path, e.g. <code>https://corp.example/jira</code>.</p>
        <label for="surface-origin">Instance URL</label>
        <input id="surface-origin" type="text" placeholder="https://corp.example/jira" />
        <label for="surface-product">What is it?</label>
        <select id="surface-product">
          <option value="bitbucket">Bitbucket</option>
          <option value="github">GitHub</option>
          <option value="gitlab">GitLab</option>
          <option value="jenkins">Jenkins</option>
          <option value="jira">Jira</option>
        </select>
        <button id="surface-add" type="button">Add surface</button>
        <output id="surface-status" class="options__status"></output>
        <div id="surface-list"></div>
        <p class="options__status">Granting page access lets Nimbus recognise pages on that site without you opening the panel first. It never changes where Nimbus can send data — that stays your local gateway only. <strong>Surface automatically</strong> goes one step further: on a page Nimbus has indexed, a small cue appears in the corner so you don't have to open the panel to find out. Nothing runs until you click it.</p>
      </section>

      <section id="stage-trust" class="stage">
        <h2><span class="stage__num">4</span> Where your data goes</h2>
        <p><strong>One destination.</strong> Nimbus talks to <span id="trust-origin">your local gateway</span> and nowhere else. There is no cloud service, no analytics, and no remote host — the extension cannot reach one, because it asks for no permission to.</p>
        <p><strong>Page access is separate, and it is yours to give.</strong> Nimbus can currently read the URL of pages on: <span id="trust-hosts">no sites yet</span>. Nothing is granted until you grant it, and revoking is one click in stage 3.</p>
        <p><strong>What we send, and when.</strong> Clipping from the toolbar shows you the whole payload first, so nothing leaves without you seeing it — the hotkey shows you after, in the confirmation toast, because its whole point is being one gesture. And opening the popup sends the page's URL to your gateway to check whether you have already saved it.</p>
        <p><strong>The secret stays secret.</strong> Your pairing token lives in extension storage, is never shown on this page, never written to a log, and never placed in any web page.</p>
        <p><strong>You can check all of this.</strong> The extension is MIT-licensed, has no runtime dependencies, and its build is reproducible from source.</p>
      </section>
    </main>
```

Add to `src/options/options.css`:

```css
.stage[data-state="locked"] { opacity: 0.45; }
.stage[data-state="locked"] button,
.stage[data-state="locked"] input,
.stage[data-state="locked"] select { pointer-events: none; }
.stage[data-state="needs-attention"] .stage__num { color: #b23; }
.stage__num { font-variant-numeric: tabular-nums; opacity: 0.6; margin-right: 0.4em; }
```

> Locked stages are dimmed and inert, **not** `hidden`. A hidden stage is
> indistinguishable from a missing feature, and the whole point of the staged flow
> is to show what comes next.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- options`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/options/options.html src/options/options.css test/unit/options.test.ts
git commit -m "feat(options): four stages, and a trust panel that states its caveats"
```

---

## Task 9: Wire the Options page

**Files:**
- Modify: `src/options/options.ts`
- Test: `test/unit/options.test.ts`

**Interfaces:**
- Consumes: `stagesFrom`, `healthLine` (Task 7); `isConnectionResponse` (Task 4); `isDiscoverRequest`'s response type `DiscoverResponse` (Task 5); `BUILT_IN_SURFACES`, `hasOrigin` (existing)
- Produces: no exports — this is the page's glue

- [ ] **Step 1: Write the failing test**

Append to `test/unit/options.test.ts`. This is a jsdom test, so put it in a **new** file `test/unit/options-stages.test.ts` with the docblock (the existing `options.test.ts` is a node-env file that string-matches the HTML):

```ts
// @vitest-environment jsdom
// test/unit/options-stages.test.ts
import { describe, expect, test } from "vitest";
import { applyStages, stagesFrom } from "../../src/options/setup-view.ts";
import type { ConnectionResponse } from "../../src/shared/messages.ts";

function pageWithStages(): Document {
  const doc = document.implementation.createHTMLDocument("t");
  for (const id of ["stage-connect", "stage-connection", "stage-sites", "stage-trust"]) {
    const section = doc.createElement("section");
    section.id = id;
    doc.body.appendChild(section);
  }
  return doc;
}

const unpaired: ConnectionResponse = { kind: "connection", paired: false };

describe("applyStages", () => {
  test("stamps each stage's state onto data-state", () => {
    const doc = pageWithStages();
    applyStages(doc, stagesFrom(unpaired));
    expect(doc.getElementById("stage-connect")?.dataset["state"]).toBe("active");
    expect(doc.getElementById("stage-connection")?.dataset["state"]).toBe("locked");
    expect(doc.getElementById("stage-sites")?.dataset["state"]).toBe("locked");
    expect(doc.getElementById("stage-trust")?.dataset["state"]).toBe("active");
  });

  test("a missing section is skipped, not thrown on", () => {
    const doc = document.implementation.createHTMLDocument("t");
    expect(() => applyStages(doc, stagesFrom(unpaired))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- options-stages`
Expected: FAIL — `applyStages is not exported`

- [ ] **Step 3: Write the implementation**

Add `applyStages` to `src/options/setup-view.ts` (it takes a `Document`, so it stays testable without a browser and keeps the DOM write in one named place):

```ts
/** Stamp the stage states onto the page. The CSS does the rest. */
export function applyStages(doc: Document, stages: Stages): void {
  const ids: ReadonlyArray<readonly [string, StageState]> = [
    ["stage-connect", stages.connect],
    ["stage-connection", stages.connection],
    ["stage-sites", stages.sites],
    ["stage-trust", stages.trust],
  ];
  for (const [id, state] of ids) {
    const el = doc.getElementById(id);
    if (el !== null) {
      el.dataset["state"] = state;
    }
  }
}
```

In `src/options/options.ts`, extend `renderConnection` and add discovery. Replace `renderConnection` with:

```ts
function renderConnection(res: unknown): void {
  if (!isConnectionResponse(res)) {
    return;
  }
  applyStages(document, stagesFrom(res));
  const health = document.getElementById("health-line");
  if (health !== null) {
    health.textContent = healthLine(res, Date.now());
  }
  const status = document.getElementById("connection-status");
  if (status !== null) {
    // Stage 2's detail line stays as it was; healthLine above carries the state.
    status.textContent = res.paired ? `Paired as "${res.label}".` : "";
  }
  if (!res.paired) {
    disarmUnpair();
  }
  const trustOrigin = document.getElementById("trust-origin");
  if (trustOrigin !== null) {
    trustOrigin.textContent = res.paired ? res.origin : "your local gateway (not paired yet)";
  }
}
```

Add the discovery handler:

```ts
function isDiscoverResponse(v: unknown): v is DiscoverResponse {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "discover";
}

function setDiscoverStatus(text: string): void {
  const el = document.getElementById("discover-status");
  if (el !== null) {
    el.textContent = text;
  }
}

async function discover(): Promise<void> {
  const originEl = document.getElementById("origin");
  if (!(originEl instanceof HTMLInputElement)) {
    return;
  }
  setDiscoverStatus("Looking…");
  try {
    const res = await sendMessage({ kind: "discover" });
    if (!isDiscoverResponse(res)) {
      setDiscoverStatus("Unexpected response.");
      return;
    }
    if (res.origin === null) {
      setDiscoverStatus("No gateway found. Start Nimbus, or enter its URL below.");
      return;
    }
    originEl.value = res.origin;
    setDiscoverStatus(`Found Nimbus at ${res.origin}.`);
  } catch {
    setDiscoverStatus("Couldn't reach the extension — please try again.");
  }
}
```

Fill the trust panel's host list from the same source stage 3 renders (extend `refreshSurfaces`):

```ts
async function refreshSurfaces(): Promise<void> {
  const rows = await surfaceRows();
  const list = document.getElementById("surface-list");
  if (list !== null) {
    list.replaceChildren(renderSurfaceList(document, rows));
  }
  const hosts = document.getElementById("trust-hosts");
  if (hosts !== null) {
    const granted = rows.filter((r) => r.granted).map((r) => r.origin);
    // textContent, never innerHTML — these strings are user-supplied origins.
    hosts.textContent = granted.length === 0 ? "no sites yet" : granted.join(", ");
  }
}
```

Register the button in the `DOMContentLoaded` handler:

```ts
  document.getElementById("discover")?.addEventListener("click", () => void discover());
```

Add the imports:

```ts
import { applyStages, healthLine, stagesFrom } from "./setup-view.ts";
import type { DiscoverResponse } from "../shared/messages.ts";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test`
Expected: PASS, whole suite green

- [ ] **Step 5: Verify the whole gate, then commit**

```bash
bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build
git add src/options/options.ts src/options/setup-view.ts test/unit/options-stages.test.ts
git commit -m "feat(options): wire discovery, health and the trust panel"
```

---

## Task 10: Docs, changelog, and the manual pass

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]`)
- Modify: `docs/architecture.md`
- Modify: `docs/development.md`
- Modify: `ROADMAP.md` (mark 3.5 / 1.4 / 1.2 shipped)

**Interfaces:** none — documentation

- [ ] **Step 1: Add the changelog entries**

Under `## [Unreleased]` → `### Added` in `CHANGELOG.md`, in the user-facing voice the existing entries use:

```markdown
- **Nimbus can find itself.** Setting up no longer starts with typing a URL:
  press **Find my gateway** and the extension checks the two places a local
  Nimbus listens. It checks exactly those two — it does not scan your ports.
  The URL field is still there for a gateway on a different port.
- **Options tells you the truth about the connection.** One line now says where
  you are connected, when the last clip landed, and how many are waiting to sync
  — and when your gateway has rejected this browser, it says *"Needs
  re-pairing"* instead of leaving you to guess whether Nimbus is even running.
- **One page that answers "where does my data go?"** Options now states the one
  destination Nimbus talks to, which sites you have granted page access to, what
  gets sent and when, and what happens to your pairing token — driven by your
  real settings, not by a fixed blurb.
```

- [ ] **Step 2: Document the load-bearing decisions**

Add a section to `docs/architecture.md` covering:
- Discovery: two candidates, why `127.0.0.1` is first, why sequential, why never a scan.
- `probeHealth` as the only tokenless call, and why `isLoopbackOrigin` is re-asserted there.
- `stale` set from one wrap around `respond` rather than per-handler hooks.
- The staged Options flow, and the rule that locking is for never-configured, never for broken — naming the Unpair-in-stage-2 reason.

- [ ] **Step 3: Extend the manual verification checklist**

Add to `docs/development.md` a dev-load pass for this slice. **Also run the outstanding C2.3 pass, which has never been run** — the spec folds it in here:

1. Load unpacked in Chrome. On a fresh profile, Options shows stage 1 active and 2–3 dimmed.
2. With the gateway stopped, press **Find my gateway** → "No gateway found", URL field still editable.
3. Start the gateway, press it again → the URL fills in.
4. Pair. Stages 2 and 3 open; the health line names the origin.
5. Clip a page, reopen Options → the health line reports the last clip.
6. Stop the gateway, reopen Options → "Can't reach …", and stages 2 and 3 are **still usable** (confirm Unpair is clickable).
7. Repeat 1–6 in Firefox.
8. **C2.3 backlog:** on a GitHub/GitLab/Bitbucket/Jira/Jenkins dashboard, confirm the three service lanes render and answer, and that the ambient cue stays silent there.

- [ ] **Step 4: Update the roadmap**

Mark **3.5**, **1.4** and **1.2** shipped with a short `**Status**` line each, following the format used by C1.3 / C2.3. Record honestly that C1.5's shortcut visibility is **not** in this slice — it is slice 2.

- [ ] **Step 5: Commit**

```bash
bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build
git add CHANGELOG.md docs/architecture.md docs/development.md ROADMAP.md
git commit -m "docs: record slice 1 — discovery, connection health, the trust panel"
```

---

## Self-Review Notes

**Spec coverage.** Every "Slice 1 — Setup that works" requirement maps to a task:

| Spec requirement | Task |
| --- | --- |
| Four ordered stages, pure `stagesFrom` | 7, 8, 9 |
| Locking is for never-configured, never for broken | 7 (tested), 8 (CSS), 9 |
| Stage 4 always open | 7 (tested) |
| `GET /v1/health`, two candidates, no scan | 1, 2 |
| `127.0.0.1` first, sequential | 1 (tested), 5 (tested) |
| Probe re-asserts `isLoopbackOrigin` | 2 (tested, asserts no request is made) |
| `{ paired, origin, label, pairedAt, lastClipAt, queueDepth, reachable, stale }` | 4, 5 |
| `lastClipAt` in `connection-store.ts`, cleared by unpair | 3 (`clearConnection` already removes the whole record) |
| `stale` on 401 → "needs re-pairing" | 3, 6, 7 |
| Trust panel driven by the real origin and real granted hosts | 8, 9 |
| Trust panel states both caveats | 8 (tested) |
| Token never rendered | 5 (tested) |
| C2.3's outstanding manual pass folded in | 10 |

**Out of scope, by design:** the preview off-switch named for stage 4 in the spec arrives with slice 3 (there is nothing to switch until the preview exists); the shortcut-binding readout in stage 2 arrives with slice 2; persisted `scopes` arrive with slice 5.

**Known follow-up:** `src/options/options.ts` is 325 lines and grows here. It stays under the threshold that would justify a split, and slice 2 adds only a shortcut readout. If slice 2 pushes it past ~450 lines, split the surfaces half into `src/options/surfaces-controller.ts` at that point — not now.

---

## Review Dispositions

Findings from
[2026-08-14-slice-1-setup-that-works-review.md](./2026-08-14-slice-1-setup-that-works-review.md),
each checked against the code before being accepted or argued with.

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | `readJson` outside the try in `probeHealth` | **Premise declined; real version fixed one layer up.** |
| 2 | `void markStale()` can leave a rejection unhandled | **Fixed as proposed**, and extended to `markClipSuccess`. |
| 3 | Notes on the write chain's scope and copy semantics | **Both answered; the investigation found a real race, now fixed.** |

**On 1 — the premise is wrong, the instinct is right.** `readJson` cannot throw:
it catches its own `res.json()` rejection and returns `null`
(`gateway-client.ts:119-125`), so a non-JSON body from whatever else is listening
on 7474 yields `null`, not an exception. Widening the try to cover it would add a
catch that can never fire, which reads to the next maintainer as a real failure
mode and invites someone to "handle" it. **But the consequence the finding
describes — one bad candidate costing the next its turn — was genuinely
unguarded**, just not where it was reported: `handleDiscover`'s loop awaited
`probeReachable` bare. The guard now lives there, because that loop's contract is
"try each candidate" and it should hold for any probe implementation, including a
future one that does throw. Two tests were added for it.

**On 2 — correct, and it matches an existing convention.** `void` does not attach
a rejection handler, so a failing `chrome.storage.local.set` would surface as an
unhandled rejection in the service worker and fail the Vitest run. The file
already uses `.catch(() => undefined)` for its other fire-and-forget calls
(`injectPanel`, `endPause`, `ensureAlarm`, `syncQueueState`). The review flagged
`markStale`; `markClipSuccess` in the clip route has the identical problem and is
fixed with it.

**On 3 — both notes answered, and a third thing found.** The two questions asked
have clean answers, and both are now written into the code comment: the in-memory
chain is sufficient because it orders overlapping writes within one
service-worker lifetime and MV3 runs exactly one instance — across an eviction
there is no chain and no concurrent writer either; and `transform` returning
`{ ...c, stale: true }` is a fresh object, so no caller's record is mutated in
place.

Tracing who else writes that key turned up a defect neither note named.
**`setConnection` and `clearConnection` bypassed the chain entirely**, and their
callers are `handlePair` and `handleUnpair`. A queue flush that 401s while the
user is re-pairing interleaves as: `mutate` reads the OLD record →
`setConnection` writes the NEW one → `mutate` writes back its transform of the
old one. The fresh token is silently reverted to the dead one it just replaced,
and the user is told to re-pair a browser they have just re-paired. Both writers
now share the chain, with a regression test whose `stale` assertion is what
distinguishes the fixed ordering from the broken one.
