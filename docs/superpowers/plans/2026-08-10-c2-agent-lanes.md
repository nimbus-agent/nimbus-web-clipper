# C2 — Agent Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a resolved pull request, expanding a lane runs the agent that answers it and renders the brief — surviving a service-worker eviction and the panel closing.

**Architecture:** The service worker owns run state and polls the gateway; the panel asks the worker for state and repaints. Two cadences, deliberately separate. Briefs render as text, never parsed HTML.

**Tech Stack:** TypeScript (strict, no `any`), Vitest (node env; jsdom via a first-line `// @vitest-environment jsdom` comment), esbuild, Biome, bun.

**Spec:** [`docs/superpowers/specs/2026-08-10-c2-agent-lanes-design.md`](../specs/2026-08-10-c2-agent-lanes-design.md)

## Global Constraints

- TypeScript **strict**; **no `any`** — cross-boundary data is `unknown`, narrowed by a guard.
- **No `console.*` in `src/`.** Tests and `scripts/` may log.
- **Never log the bearer token or the pairing code.**
- **Loopback only** — no destination beyond `127.0.0.1` / `localhost`.
- **Every gateway-provided string renders via `textContent`, never `innerHTML`.** The brief is the largest and least predictable such string; see the security section below.
- **`panel-view.ts` owns all user-facing copy.** State objects carry `kind`/`reason`, never prose.
- DOM tests keep their first-line `// @vitest-environment jsdom` **line comment** (repo convention across all DOM test files). Preserve it when editing.
- Green bar: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`.
- `CHANGELOG.md` entry under `## [Unreleased]` for anything user-visible.

**Every task ends fully green.** The additions here are additive; a red `tsc` or a failing test at the end of any task is a defect, not sequencing.

**Baseline:** branch off `739f6fa` (merged `main`). **514 tests / 41 files**, all five checks green. Measure before Task 1 and correct this line if it differs — a stale baseline makes a later reviewer think coverage was lost.

## The contract, verified against merged upstream source

`C:/gitrep/Nimbus` @ v1.26.0 — `ipc/http-write-routes.ts`, `ipc/http-server.ts`, `agent-runs/agent-run-store.ts`, `ipc/agents-rpc.ts`.

```
POST /v1/agents/{agent}    Bearer, scope `agents`; body passed VERBATIM to the
                           gateway's own validator — no schema is mirrored here
  202 { runId } · 404 unknown_agent · 429 busy +Retry-After:1
  403 insufficient_scope · 401 unauthorized · 500 internal_error

GET  /v1/agents/runs/{id}  Bearer, scope `agents`
  200 { status:"running"|"done"|"failed", brief, findings, failureReason? }
  404 not_found (unknown OR lost to restart) · 410 expired
```

Facts that constrain the code. Do not re-derive them; do not "improve" past them:

1. **`AGENT_RUN_TTL_MS` = 10 min, not refreshed on access.** The client cache expiry mirrors it.
2. **`MAX_CONCURRENT_AGENT_RUNS` = 3.** Two lanes leave a slot free in the common case.
3. **`MAX_RETAINED_TERMINAL_AGENT_RUNS` = 16**, oldest evicted first. The client cache cap matches.
4. **`Retry-After: 1`** on busy — slots free when a run *finishes*, in seconds. A 429 is normal, not an error.
5. **404 and 410 both mean re-issue**, never keep waiting. They collapse to one client state.
6. **`chrome.alarms` has a one-minute floor**; runs finish in seconds. Alarms are the eviction net only.

Agent input shapes — the body goes through verbatim, so these must be exact:

```
agents.impact  { fileOrPrUrl: string, depth?: number, service?: string }
agents.expert  { topicOrFile: string, limit?: number }
```

`agents.why` is **not** in this slice: its `ref` is a local filesystem path answered by git blame on a local checkout. See the spec.

## File Structure

**Created:** `src/background/agent-run-store.ts`, `test/unit/agent-run-store.test.ts`

**Modified:** `src/shared/gateway.ts`, `src/shared/types.ts`, `src/shared/messages.ts`, `src/background/gateway-client.ts`, `src/background/handlers.ts`, `src/background/service-worker.ts`, `src/panel/panel-view.ts`, `src/panel/panel-in-page.ts`, `CHANGELOG.md`, `docs/architecture.md`, `docs/development.md`, `ROADMAP.md`, and their tests.

---

### Task 1: Path bases for the two agent routes

Both routes carry a path parameter, which the static `GATEWAY_PATHS` map cannot express. Add **bases** and build the rest at the call site.

**Files:** Modify `src/shared/gateway.ts`, `test/unit/gateway.test.ts`

**Interfaces:**
- Produces: `GATEWAY_PATHS.agents = "/v1/agents"`, `GATEWAY_PATHS.agentRuns = "/v1/agents/runs"`.

- [ ] **Step 1: Write the failing test**

Update the full-map assertion in `test/unit/gateway.test.ts` — it is exhaustive by design, so extend it rather than loosening it:

```ts
  it("is the six contracted gateway paths", () => {
    expect(GATEWAY_PATHS).toEqual({
      ingest: "/v1/clips",
      pairConfirm: "/v1/clips/pair/confirm",
      related: "/v1/clips/related",
      resolve: "/v1/items/resolve",
      itemsFetch: "/v1/items/fetch",
      agents: "/v1/agents",
      agentRuns: "/v1/agents/runs",
    });
  });

  it("builds an agent invoke URL from the base plus the agent name", () => {
    expect(`${endpointUrl("http://127.0.0.1:8765/", "agents")}/impact`).toBe(
      "http://127.0.0.1:8765/v1/agents/impact",
    );
  });

  it("builds a run-poll URL from the base plus the run id", () => {
    expect(`${endpointUrl("http://127.0.0.1:8765", "agentRuns")}/abc123`).toBe(
      "http://127.0.0.1:8765/v1/agents/runs/abc123",
    );
  });
```

(The existing test name says "five" — rename to "six"... there are now **seven** entries. Count them in the object above and name it accurately.)

- [ ] **Step 2: Run it and watch it fail**

Run: `bunx vitest run test/unit/gateway.test.ts`
Expected: FAIL — `agents` / `agentRuns` are not in the map.

- [ ] **Step 3: Implement**

In `src/shared/gateway.ts`, add to `GATEWAY_PATHS`:

```ts
  /**
   * BASES, not complete paths: both agent routes carry a path parameter
   * (`/v1/agents/{agent}`, `/v1/agents/runs/{id}`) which this static map cannot
   * express. Callers append the segment. Kept here anyway so every contracted
   * path still has exactly one home — a second map is what Task 1 of the resolve
   * slice existed to delete.
   */
  agents: "/v1/agents",
  agentRuns: "/v1/agents/runs",
```

The appended segment must be percent-encoded at the call site (Task 3) — a run id is gateway-generated, but an agent name is a literal from our own union, and encoding both costs nothing.

- [ ] **Step 4: Run the tests**

Run: `bun run typecheck && bun run test`
Expected: typecheck clean, all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/gateway.ts test/unit/gateway.test.ts
git commit -m "feat(gateway): add path bases for the agent invoke and run routes"
```

---

### Task 2: Domain types

**Files:** Modify `src/shared/types.ts`. No test cycle — pure type declarations.

- [ ] **Step 1: Write the types**

```ts
/**
 * The lanes this phase ships, and the agent each maps to.
 *
 * `why` is deliberately ABSENT. `agents.why` takes `{ ref, line? }` where `ref` is
 * a LOCAL filesystem path resolved against configured `[[filesystem.roots]]` and
 * answered by git blame on a local checkout — it answers "why does this line
 * exist", not "why does this change exist", and a browser on a pull-request page
 * has neither the path nor necessarily the repo. The roadmap's C2.1 brief names it
 * (and `whyPeek`, which is HTTP-excluded); both are corrected there.
 */
export const AGENT_LANES = ["impact", "expert"] as const;
export type AgentLane = (typeof AGENT_LANES)[number];

/** What one lane is doing. `collapsed` is also the state of a lane never opened. */
export type LaneState =
  | { readonly kind: "collapsed" }
  | { readonly kind: "running"; readonly runId: string }
  | { readonly kind: "done"; readonly brief: string }
  | { readonly kind: "failed"; readonly reason: AgentError };

/**
 * `stale` collapses the poll's 404 and 410. Upstream distinguishes them —
 * unknown-or-lost-to-restart vs known-and-expired — but states the client response
 * to both is to re-issue, never to keep waiting. One state, one "Re-run".
 *
 * There is no `busy`: a 429 is handled inside the client by backing off for
 * `Retry-After` and retrying. Upstream sized that header at one second precisely
 * because a slot frees when a run finishes, in seconds. Surfacing it would report
 * a normal condition as a failure.
 */
export type AgentError =
  | "not_paired"
  | "unauthorized"
  | "insufficient_scope"
  /** 404 — unknown agent, or this gateway has no agents surface. */
  | "unsupported"
  | "stale"
  | "unreachable"
  | "server_error";
```

`findings` is deliberately not modelled: it is `unknown` upstream ("the shape is per-agent") and nothing renders it. The resolve slice already had to prune one such field.

- [ ] **Step 2: Verify nothing broke**

Run: `bun run typecheck && bun run test`
Expected: clean and green — additive, unused so far.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "types: model the agent lanes and their run states"
```

---

### Task 3: The agent client

**Files:** Modify `src/background/gateway-client.ts`, `test/unit/gateway-client.test.ts`

**Interfaces:**
```ts
export async function invokeAgent(
  origin: string, token: string, agent: AgentLane, params: unknown, doFetch?: FetchLike,
): Promise<
  | { ok: true; runId: string }
  | { ok: false; reason: AgentError; scopeGap?: { required: string; granted: string[] } }
  | { ok: false; reason: "busy"; retryAfterMs: number }
>

export async function getAgentRun(
  origin: string, token: string, runId: string, doFetch?: FetchLike,
): Promise<
  | { ok: true; status: "running" }
  | { ok: true; status: "done"; brief: string }
  | { ok: true; status: "failed"; failureReason: string }
  | { ok: false; reason: AgentError; scopeGap?: { required: string; granted: string[] } }
>
```

`busy` is a client-internal reason on `invokeAgent` only — it never reaches `AgentError`, because the caller retries rather than reporting it.

- [ ] **Step 1: Write the failing tests**

```ts
describe("invokeAgent", () => {
  function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json", ...headers },
    });
  }

  it("POSTs to /v1/agents/<agent> with the params verbatim and a bearer header", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const doFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonRes({ runId: "r1" }, 202);
    };
    await invokeAgent(
      "http://127.0.0.1:8765", "tok", "impact",
      { fileOrPrUrl: "https://github.com/a/b/pull/1" }, doFetch,
    );

    const call = calls[0];
    expect(call?.url).toBe("http://127.0.0.1:8765/v1/agents/impact");
    expect(call?.init?.method).toBe("POST");
    // Verbatim: the gateway owns validation, so we must not reshape the body.
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      fileOrPrUrl: "https://github.com/a/b/pull/1",
    });
    expect((call?.init?.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
    expect(call?.url).not.toContain("tok");
    expect(String(call?.init?.body)).not.toContain("tok");
  });

  it("maps 202 to the run id", async () => {
    const doFetch = async () => jsonRes({ runId: "run-42" }, 202);
    expect(await invokeAgent("http://127.0.0.1:8765", "t", "expert", {}, doFetch)).toEqual({
      ok: true, runId: "run-42",
    });
  });

  it("rejects a 202 with no runId rather than inventing one", async () => {
    const doFetch = async () => jsonRes({}, 202);
    expect(await invokeAgent("http://127.0.0.1:8765", "t", "expert", {}, doFetch)).toEqual({
      ok: false, reason: "server_error",
    });
  });

  it("maps 429 to busy and parses Retry-After", async () => {
    const doFetch = async () => jsonRes({ error: "busy" }, 429, { "retry-after": "1" });
    expect(await invokeAgent("http://127.0.0.1:8765", "t", "impact", {}, doFetch)).toEqual({
      ok: false, reason: "busy", retryAfterMs: 1000,
    });
  });

  it("maps 404 / 401 / 403 / 500", async () => {
    const cases: Array<[unknown, number, string]> = [
      [{ error: "unknown_agent" }, 404, "unsupported"],
      [{ error: "unauthorized" }, 401, "unauthorized"],
      [{}, 500, "server_error"],
    ];
    for (const [body, status, reason] of cases) {
      const doFetch = async () => jsonRes(body, status);
      expect(await invokeAgent("http://127.0.0.1:8765", "t", "impact", {}, doFetch))
        .toMatchObject({ ok: false, reason });
    }
    const scoped = async () =>
      jsonRes({ error: "insufficient_scope", required: "agents", granted: ["clip"] }, 403);
    expect(await invokeAgent("http://127.0.0.1:8765", "t", "impact", {}, scoped)).toEqual({
      ok: false, reason: "insufficient_scope",
      scopeGap: { required: "agents", granted: ["clip"] },
    });
  });
});

describe("getAgentRun", () => {
  function jsonRes(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json" },
    });
  }

  it("GETs /v1/agents/runs/<id>", async () => {
    const calls: string[] = [];
    const doFetch = async (url: string) => {
      calls.push(url);
      return jsonRes({ status: "running" });
    };
    await getAgentRun("http://127.0.0.1:8765", "t", "run-42", doFetch);
    expect(calls[0]).toBe("http://127.0.0.1:8765/v1/agents/runs/run-42");
  });

  it("maps running, done and failed", async () => {
    const running = async () => jsonRes({ status: "running", brief: null });
    expect(await getAgentRun("http://127.0.0.1:8765", "t", "r", running)).toEqual({
      ok: true, status: "running",
    });

    const done = async () => jsonRes({ status: "done", brief: "## Impact\n\nthings" });
    expect(await getAgentRun("http://127.0.0.1:8765", "t", "r", done)).toEqual({
      ok: true, status: "done", brief: "## Impact\n\nthings",
    });

    const failed = async () => jsonRes({ status: "failed", failureReason: "no index" });
    expect(await getAgentRun("http://127.0.0.1:8765", "t", "r", failed)).toEqual({
      ok: true, status: "failed", failureReason: "no index",
    });
  });

  it("rejects done with no brief — a done run without one is malformed", async () => {
    const doFetch = async () => jsonRes({ status: "done", brief: null });
    expect(await getAgentRun("http://127.0.0.1:8765", "t", "r", doFetch)).toEqual({
      ok: false, reason: "server_error",
    });
  });

  // THE collapse for this task: upstream distinguishes these two, and says the
  // client's answer to both is to re-issue. One state, one affordance.
  it("collapses poll 404 and 410 into `stale`", async () => {
    for (const [body, status] of [
      [{ error: "not_found" }, 404],
      [{ error: "expired" }, 410],
    ] as Array<[unknown, number]>) {
      const doFetch = async () => jsonRes(body, status);
      expect(await getAgentRun("http://127.0.0.1:8765", "t", "r", doFetch)).toEqual({
        ok: false, reason: "stale",
      });
    }
  });

  it("treats an unknown status as server_error, never as a terminal answer", async () => {
    for (const body of [null, {}, { status: "vibes" }]) {
      const doFetch = async () => jsonRes(body);
      expect(await getAgentRun("http://127.0.0.1:8765", "t", "r", doFetch)).toEqual({
        ok: false, reason: "server_error",
      });
    }
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bunx vitest run test/unit/gateway-client.test.ts`
Expected: FAIL — neither function is exported.

- [ ] **Step 3: Implement**

Add a timeout constant and the two functions. Reuse the existing `postJson`, `getJson`, `readJson`, `isObject`, `parseScopeGap` and `parseRetryAfterMs` — **do not write second copies**. `parseScopeGap` in particular carries the label/scope validation added in the fetch slice and is security-relevant.

```ts
const AGENT_TIMEOUT_MS = 15_000;

/** `POST /v1/agents/{agent}` — invoke, returning a run id to poll. */
export async function invokeAgent(
  origin: string,
  token: string,
  agent: AgentLane,
  params: unknown,
  doFetch: FetchLike = fetch,
): Promise<
  | { ok: true; runId: string }
  | { ok: false; reason: AgentError; scopeGap?: { required: string; granted: string[] } }
  | { ok: false; reason: "busy"; retryAfterMs: number }
> {
  let res: Response;
  try {
    res = await postJsonAt(
      doFetch,
      `${endpointUrl(origin, "agents")}/${encodeURIComponent(agent)}`,
      params,
      { authorization: `Bearer ${token}` },
      AGENT_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 202) {
    const data = await readJson(res);
    return isObject(data) && typeof data["runId"] === "string"
      ? { ok: true, runId: data["runId"] }
      : { ok: false, reason: "server_error" };
  }
  if (res.status === 429) {
    return {
      ok: false,
      reason: "busy",
      retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
    };
  }
  if (res.status === 401) {
    return { ok: false, reason: "unauthorized" };
  }
  if (res.status === 403) {
    const gap = parseScopeGap(await readJson(res));
    return gap === null
      ? { ok: false, reason: "insufficient_scope" }
      : { ok: false, reason: "insufficient_scope", scopeGap: gap };
  }
  if (res.status === 404) {
    return { ok: false, reason: "unsupported" };
  }
  return { ok: false, reason: "server_error" };
}
```

`postJson`/`getJson` currently take a `GatewayEndpoint` and build the URL themselves. These routes need a caller-built URL, so extract the URL-taking core of each (`postJsonAt`, `getJsonAt`) and have the existing wrappers call it. That keeps one timeout/abort implementation rather than a parallel one — the same reasoning that kept `parseScopeGap` single.

`getAgentRun` follows the same shape against `${endpointUrl(origin, "agentRuns")}/${encodeURIComponent(runId)}`, mapping 200 by `status`, 404 **and** 410 to `stale`, and everything else as above.

- [ ] **Step 4: Run the tests**

Run: `bun run typecheck && bun run test`
Expected: typecheck clean, all PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(gateway): invoke agents and poll their runs"
```

---

### Task 4: The run store

**Files:** Create `src/background/agent-run-store.ts`, `test/unit/agent-run-store.test.ts`

**Interfaces:**
```ts
export interface StoredRun {
  readonly itemId: string;
  readonly lane: AgentLane;
  readonly runId: string;
  readonly state: LaneState;
  readonly expiresAtMs: number;
}
export async function getRun(itemId: string, lane: AgentLane, nowMs: number): Promise<StoredRun | null>;
export async function putRun(run: StoredRun, nowMs: number): Promise<void>;
export async function listRunning(nowMs: number): Promise<StoredRun[]>;
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.ts";
import { getRun, listRunning, putRun } from "../../src/background/agent-run-store.ts";
import { AGENT_RUN_CACHE_TTL_MS, MAX_STORED_RUNS } from "../../src/background/agent-run-store.ts";

const NOW = 1_800_000_000_000;
const run = (itemId: string, lane: "impact" | "expert", expiresAtMs: number) => ({
  itemId, lane, runId: `${itemId}-${lane}`,
  state: { kind: "done" as const, brief: "b" }, expiresAtMs,
});

describe("agent-run-store", () => {
  beforeEach(() => { installChromeMock(); });

  it("round-trips a run", async () => {
    await putRun(run("i1", "impact", NOW + 1000), NOW);
    expect(await getRun("i1", "impact", NOW)).toMatchObject({ runId: "i1-impact" });
  });

  it("keys by item AND lane — two lanes on one item do not collide", async () => {
    await putRun(run("i1", "impact", NOW + 1000), NOW);
    await putRun(run("i1", "expert", NOW + 1000), NOW);
    expect((await getRun("i1", "impact", NOW))?.runId).toBe("i1-impact");
    expect((await getRun("i1", "expert", NOW))?.runId).toBe("i1-expert");
  });

  // The cache must never outlive the gateway's own run TTL: a brief we still hold
  // after the gateway has forgotten it cannot be re-polled.
  it("drops an entry past its expiry on read", async () => {
    await putRun(run("i1", "impact", NOW + 1000), NOW);
    expect(await getRun("i1", "impact", NOW + 1001)).toBeNull();
  });

  it("mirrors the gateway's 10-minute run TTL", () => {
    expect(AGENT_RUN_CACHE_TTL_MS).toBe(10 * 60_000);
  });

  it("caps entries at the gateway's own retained-run count, evicting oldest first", async () => {
    expect(MAX_STORED_RUNS).toBe(16);
    for (let i = 0; i < MAX_STORED_RUNS + 2; i++) {
      await putRun(run(`i${i}`, "impact", NOW + 60_000), NOW + i);
    }
    expect(await getRun("i0", "impact", NOW)).toBeNull();
    expect(await getRun("i1", "impact", NOW)).toBeNull();
    expect(await getRun(`i${MAX_STORED_RUNS + 1}`, "impact", NOW)).not.toBeNull();
  });

  it("lists only running entries, and only unexpired ones", async () => {
    await putRun({ ...run("i1", "impact", NOW + 1000), state: { kind: "running", runId: "r1" } }, NOW);
    await putRun(run("i2", "impact", NOW + 1000), NOW);                       // done
    await putRun({ ...run("i3", "impact", NOW - 1), state: { kind: "running", runId: "r3" } }, NOW);
    const out = await listRunning(NOW);
    expect(out.map((r) => r.itemId)).toEqual(["i1"]);
  });

  it("survives malformed stored data rather than throwing", async () => {
    // Storage is external input: a hand-edited or partially-written value must not
    // take the panel down.
    chrome.storage.local.set({ agentRuns: { nonsense: 42 } });
    expect(await getRun("i1", "impact", NOW)).toBeNull();
    expect(await listRunning(NOW)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bunx vitest run test/unit/agent-run-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Model on `src/background/clip-queue-store.ts` — same `storageGet`/`storageSet` seam, same "stored data is external input, filter through a guard, never cast" rule.

```ts
/**
 * Mirrors the gateway's `AGENT_RUN_TTL_MS` (agent-runs/agent-run-store.ts), not a
 * number chosen here. A cached brief must never outlive the run it came from: the
 * gateway drops runs at ten minutes and does NOT refresh on access, so anything we
 * hold past that is unre-pollable.
 */
export const AGENT_RUN_CACHE_TTL_MS = 10 * 60_000;

/**
 * Deliberately the gateway's own `MAX_RETAINED_TERMINAL_AGENT_RUNS`. Holding more
 * would cache briefs the gateway has already evicted; holding fewer would discard
 * ones still live upstream. Two lanes per item spans eight recent items.
 */
export const MAX_STORED_RUNS = 16;
```

Key by `${itemId}\u0000${lane}` (a separator that cannot occur in either). Guard every read.

- [ ] **Step 4: Run the tests**

Run: `bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background/agent-run-store.ts test/unit/agent-run-store.test.ts
git commit -m "feat(background): persist agent runs so they outlive the panel"
```

---

### Task 5: Messages, handler and the recogniser gate

**Files:** Modify `src/shared/messages.ts`, `src/background/handlers.ts`, `src/background/service-worker.ts` and their tests.

**Interfaces:**
- `AgentRunRequest { kind:"agent-run"; lane: AgentLane; pageUrl: string }`
- `AgentStateRequest { kind:"agent-state"; lane: AgentLane; pageUrl: string }`
- `AgentStateResponse { kind:"agent-state"; lane: AgentLane; state: LaneState }`
- `handleAgentRun(deps, req)`, `handleAgentState(deps, req)`

- [ ] **Step 1: Write the failing tests**

```ts
describe("handleAgentRun", () => {
  const conn = { origin: "http://127.0.0.1:8765", token: "t", label: "chrome", pairedAt: 0 };
  const item = { id: "gh-1", service: "github", type: "pr", title: "Cache it",
                 url: "https://github.com/a/b/pull/1", modifiedAt: 1 };

  it("makes NO gateway call for an unrecognised page", async () => {
    let called = false;
    const res = await handleAgentRun(
      { getOrigins: async () => [], getConnection: async () => conn,
        resolveItem: async () => ({ ok: true as const, outcome: { kind: "found" as const, item, matchKind: "exact" as const } }),
        invokeAgent: async () => { called = true; return { ok: false as const, reason: "server_error" as const }; },
        getRun: async () => null, putRun: async () => undefined },
      { kind: "agent-run", lane: "impact", pageUrl: "https://example.com/x" },
    );
    expect(called).toBe(false);
    expect(res).toMatchObject({ kind: "agent-state", lane: "impact" });
  });

  it("sends impact the page URL and expert the item title", async () => {
    const seen: Array<{ agent: string; params: unknown }> = [];
    const deps = (lane: "impact" | "expert") => ({
      getOrigins: async () => [], getConnection: async () => conn,
      resolveItem: async () => ({ ok: true as const, outcome: { kind: "found" as const, item, matchKind: "exact" as const } }),
      invokeAgent: async (_o: string, _t: string, agent: string, params: unknown) => {
        seen.push({ agent, params });
        return { ok: true as const, runId: "r1" };
      },
      getRun: async () => null, putRun: async () => undefined,
    });
    await handleAgentRun(deps("impact"), { kind: "agent-run", lane: "impact", pageUrl: "https://github.com/a/b/pull/1" });
    await handleAgentRun(deps("expert"), { kind: "agent-run", lane: "expert", pageUrl: "https://github.com/a/b/pull/1" });

    expect(seen[0]).toEqual({ agent: "impact", params: { fileOrPrUrl: "https://github.com/a/b/pull/1" } });
    expect(seen[1]).toEqual({ agent: "expert", params: { topicOrFile: "Cache it" } });
  });

  it("does not re-invoke when a cached done run exists", async () => {
    let called = false;
    const res = await handleAgentRun(
      { getOrigins: async () => [], getConnection: async () => conn,
        resolveItem: async () => ({ ok: true as const, outcome: { kind: "found" as const, item, matchKind: "exact" as const } }),
        invokeAgent: async () => { called = true; return { ok: true as const, runId: "r2" }; },
        getRun: async () => ({ itemId: "gh-1", lane: "impact" as const, runId: "r1",
                               state: { kind: "done" as const, brief: "b" }, expiresAtMs: 9e15 }),
        putRun: async () => undefined },
      { kind: "agent-run", lane: "impact", pageUrl: "https://github.com/a/b/pull/1" },
    );
    expect(called).toBe(false);
    expect(res.state).toEqual({ kind: "done", brief: "b" });
  });

  it("refuses when the page resolves to a miss — there is no item to ask about", async () => {
    const res = await handleAgentRun(
      { getOrigins: async () => [], getConnection: async () => conn,
        resolveItem: async () => ({ ok: true as const, outcome: { kind: "not-indexed" as const, fetchable: true } }),
        invokeAgent: async () => { throw new Error("must not be called"); },
        getRun: async () => null, putRun: async () => undefined },
      { kind: "agent-run", lane: "impact", pageUrl: "https://github.com/a/b/pull/1" },
    );
    expect(res.state).toMatchObject({ kind: "failed" });
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bunx vitest run test/unit/handlers.test.ts test/unit/messages.test.ts`
Expected: FAIL — `handleAgentRun` does not exist.

- [ ] **Step 3: Implement**

`handleAgentRun` resolves the page first (it needs the item id to key the cache, and the title for `expert`), returns any cached non-`collapsed` state without invoking, then invokes and persists `{kind:"running", runId}`. On `busy` it waits `retryAfterMs` and retries **once** before reporting `server_error` — a second 429 within a second means genuine contention, and the lane's own re-run affordance covers it.

Guards in `messages.ts` validate the **domain** shape; `isScopeGap` is reused.

Route both messages in `service-worker.ts` beside the existing ones.

- [ ] **Step 4: Run the tests**

Run: `bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(background): add the agent-run and agent-state messages"
```

---

### Task 6: Polling that survives eviction

**Files:** Modify `src/background/service-worker.ts`, `src/browser/alarms.ts` if needed, `test/unit/service-worker.test.ts`

- [ ] **Step 1: Write the failing test**

The load-bearing assertion of C2.2 — a run completing **after** the worker is evicted still delivers:

```ts
it("resumes polling a persisted run after a simulated worker eviction", async () => {
  // Persist a running run, then re-import the worker module fresh — the closest
  // this harness gets to an eviction: module state is gone, storage is not.
  await putRun({ itemId: "gh-1", lane: "impact", runId: "r1",
                 state: { kind: "running", runId: "r1" }, expiresAtMs: NOW + 60_000 }, NOW);

  const polls: string[] = [];
  stubFetch((url) => {
    polls.push(url);
    return jsonRes({ status: "done", brief: "answered" });
  });

  await fireAlarm(AGENT_POLL_ALARM);          // what Chrome does after eviction

  expect(polls.some((u) => u.includes("/v1/agents/runs/r1"))).toBe(true);
  expect((await getRun("gh-1", "impact", NOW))?.state).toEqual({ kind: "done", brief: "answered" });
});

it("stops polling a run past its expiry rather than polling forever", async () => {
  await putRun({ itemId: "gh-1", lane: "impact", runId: "r1",
                 state: { kind: "running", runId: "r1" }, expiresAtMs: NOW - 1 }, NOW - 2);
  const polls: string[] = [];
  stubFetch((url) => { polls.push(url); return jsonRes({ status: "running" }); });
  await fireAlarm(AGENT_POLL_ALARM);
  expect(polls).toEqual([]);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bunx vitest run test/unit/service-worker.test.ts`
Expected: FAIL — no alarm handler, no poll loop.

- [ ] **Step 3: Implement**

Two mechanisms, and the plan is explicit that they are **not** the same thing:

```ts
/**
 * The EVICTION NET, not the poll cadence.
 *
 * `chrome.alarms` has a ONE-MINUTE floor and agent runs finish in SECONDS, so an
 * alarm-driven poll would turn a two-second answer into a sixty-second wait. The
 * real cadence is the in-worker timer below, which runs while the worker is alive.
 * This alarm exists only so a run whose worker was evicted mid-flight is still
 * picked up and completed.
 */
export const AGENT_POLL_ALARM = "nimbus-agent-poll";
const POLL_START_MS = 500;
const POLL_MAX_MS = 2_000;
```

- In-worker loop: `setTimeout`, starting at `POLL_START_MS`, backing off (×1.5) to `POLL_MAX_MS`. Stops on terminal state or `expiresAtMs`.
- Alarm handler: `listRunning(now)` → resume the loop for each. Register the alarm when a run starts; clear it when none remain.
- A `stale` poll result is terminal: store `{kind:"failed", reason:"stale"}` and stop. Do **not** auto-re-invoke — that would fire a fresh agent run the user did not ask for.

- [ ] **Step 4: Run the tests**

Run: `bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(background): poll agent runs across a worker eviction"
```

---

### Task 7: Lane rendering

**Files:** Modify `src/panel/panel-view.ts`, `test/unit/panel-view.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("renderLaneBody", () => {
  it("renders a brief as TEXT, never as markup", () => {
    const el = renderLaneBody(document, {
      kind: "done", brief: "## Impact\n\n<img src=x onerror=alert(1)>\n\n- a\n- b",
    });
    // The brief is gateway-generated and, on a configured gateway, LLM-generated.
    // Parsing it would be an XSS path from model output into a Shadow DOM over the
    // user's authenticated session.
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("h2")).toBeNull();
    expect(el.querySelector("li")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(el.textContent).toContain("## Impact");
  });

  it("shows progress while running, with no result text", () => {
    const el = renderLaneBody(document, { kind: "running", runId: "r1" });
    expect(el.textContent).toContain("Working");
  });

  it("offers Re-run on a stale run, and states why", () => {
    const seen: string[] = [];
    const el = renderLaneBody(document, { kind: "failed", reason: "stale" }, () => seen.push("rerun"));
    expect(el.textContent?.toLowerCase()).toContain("gone");
    (el.querySelector("button") as HTMLButtonElement).click();
    expect(seen).toEqual(["rerun"]);
  });

  it("names the agents scope on a scope failure, not resolve or fetch", () => {
    const el = renderLaneBody(document, {
      kind: "failed", reason: "insufficient_scope",
      scopeGap: { label: "chrome", required: "agents", granted: ["clip", "resolve"] },
    });
    expect(el.textContent).toContain("nimbus clip scopes chrome --set clip,resolve,agents");
  });

  // C2.1's done-when: never a silent empty lane.
  it("renders a stated reason for every failure, never nothing", () => {
    for (const reason of ["not_paired", "unauthorized", "unsupported", "unreachable", "server_error"] as const) {
      const el = renderLaneBody(document, { kind: "failed", reason });
      expect(el.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bunx vitest run test/unit/panel-view.test.ts`
Expected: FAIL — `renderLaneBody` is not exported.

- [ ] **Step 3: Implement**

`renderLaneBody(doc, state, onRerun?)`. The `done` arm builds a `<pre class="nimbus-related__brief">` and sets `textContent` — one assignment, no parsing, no `innerHTML`. Add a CSS rule for it in `panel-in-page.ts`'s `STYLES` (`white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin: 0`), since `:host { all: initial }` gives `<pre>` no useful defaults.

The `failed`/`insufficient_scope` arm reuses `appendScopeGuidance` — the helper extracted in the fetch slice — so all three scope messages stay one implementation.

`renderShell`'s lane loop stays untouched.

- [ ] **Step 4: Run the tests**

Run: `bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/panel/panel-view.ts src/panel/panel-in-page.ts test/unit/panel-view.test.ts
git commit -m "feat(panel): render agent briefs as text, never parsed markup"
```

---

### Task 8: Wiring the lanes

**Files:** Modify `src/panel/panel-in-page.ts`, `test/unit/panel-in-page.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("invokes a lane's agent when it is expanded, and only then", async () => {
  const sent: string[] = [];
  const panel = await mountResolvedPanel(sent);
  expect(sent.filter((k) => k === "agent-run")).toHaveLength(0);   // collapsed: nothing

  (panel.querySelector('details[data-lane="impact"] summary') as HTMLElement).click();
  await flush();

  expect(sent.filter((k) => k === "agent-run")).toHaveLength(1);
});

it("does not re-invoke when a done lane is collapsed and expanded again", async () => {
  const sent: string[] = [];
  const panel = await mountResolvedPanel(sent, { impact: { kind: "done", brief: "b" } });
  const summary = panel.querySelector('details[data-lane="impact"] summary') as HTMLElement;
  summary.click(); await flush();
  summary.click(); await flush();
  summary.click(); await flush();
  expect(sent.filter((k) => k === "agent-run")).toHaveLength(1);
});

it("polls agent-state while a lane is running and stops when it settles", async () => {
  const sent: string[] = [];
  const panel = await mountResolvedPanel(sent, {}, [
    { kind: "running", runId: "r1" }, { kind: "running", runId: "r1" },
    { kind: "done", brief: "answered" },
  ]);
  (panel.querySelector('details[data-lane="impact"] summary') as HTMLElement).click();
  await advanceTimers(3_000);

  expect(panel.textContent).toContain("answered");
  const before = sent.filter((k) => k === "agent-state").length;
  await advanceTimers(5_000);
  // Settled: the panel must stop asking. A poll that never stops is a battery bug
  // and keeps the worker alive for no reason.
  expect(sent.filter((k) => k === "agent-state").length).toBe(before);
});

it("shows no lanes when the page is not resolved", async () => {
  const panel = await mountMissPanel();
  expect(panel.querySelector('details[data-lane="impact"]')).toBeNull();
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bunx vitest run test/unit/panel-in-page.test.ts`
Expected: FAIL — no agent lanes are built.

- [ ] **Step 3: Implement**

Build the two lanes **only when the header is `resolved` or `chosen`** — there is no item to ask about otherwise. Each lane's `render` delegates to `renderLaneBody` with that lane's state.

Attach a `toggle` listener per lane: on open, send `agent-run`; start a ~1 s `agent-state` poll while the state is `running`; stop on any terminal state or when the panel closes.

Keep the two cadences separate and say so in a comment: the worker→gateway poll is what completes a run and survives the panel closing; this panel→worker poll only repaints an open panel.

- [ ] **Step 4: Run the tests**

Run: `bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/panel/panel-in-page.ts test/unit/panel-in-page.test.ts
git commit -m "feat(panel): run an agent when its lane is expanded"
```

---

### Task 9: Mock gateway, docs, and the green bar

**Files:** `scripts/screenshots/mock-gateway.ts`, `scripts/screenshots/gateway-fixtures.ts`, `CHANGELOG.md`, `docs/architecture.md`, `docs/development.md`, `ROADMAP.md`, `test/unit/mock-gateway.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("serves POST /v1/agents/impact with a run id, and the run as done", async () => {
  const invoke = await handleRequest(new Request("http://127.0.0.1:8765/v1/agents/impact", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ fileOrPrUrl: "https://github.com/acme/web/pull/482" }),
  }));
  expect(invoke.status).toBe(202);
  const { runId } = (await invoke.json()) as { runId: string };

  const poll = await handleRequest(new Request(`http://127.0.0.1:8765/v1/agents/runs/${runId}`, {
    headers: { authorization: "Bearer test-token" },
  }));
  expect(poll.status).toBe(200);
  expect(await poll.json()).toMatchObject({ status: "done" });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bunx vitest run test/unit/mock-gateway.test.ts`
Expected: FAIL — routes unhandled.

- [ ] **Step 3: Implement and document**

Mock: a fixed `runId`, and a run that reports `done` immediately with a fixed brief. Fixed literals only — these drive reproducible screenshots.

`CHANGELOG.md` under `## [Unreleased]`:

```markdown
### Added

- **Ask an agent about the pull request you are looking at.** On a resolved PR the
  panel now offers two lanes — *what breaks if it lands*, and *who should review
  it*. Expanding one runs the agent behind it; nothing runs until you ask. Answers
  survive closing the panel and are shown again instantly if you reopen it.
```

`docs/architecture.md`: the two routes; the collapse of poll 404/410 into one
"re-run" state; why alarms are the eviction net and not the cadence; and **why the
brief renders as text** — the XSS reasoning is the part most likely to be
"optimised" away later.

`docs/development.md`: manual steps — expand a lane on a resolved PR; close and
reopen the panel mid-run; a lane with only `resolve`+`fetch` granted (scope
guidance naming `agents`).

`ROADMAP.md`: mark C2.1 shipped **with the correction** — it ships two lanes, not
three, and records that `agents.why` needs a local checkout and `agents.whyPeek` is
HTTP-excluded. Add a C2.4 item for a browser-viable "why". Correct C2.2's abort
claim: no upstream cancellation exists, so abort is deferred rather than shipped.

- [ ] **Step 4: Run the full green bar**

Run: `bun run typecheck && bun run lint && bun run test && bun run build && bun run check-build`
Expected: all five PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts CHANGELOG.md docs ROADMAP.md test
git commit -m "docs+fixtures: track the agent lane routes"
```

---

## Self-Review

**Spec coverage:**

| Spec decision | Task |
| --- | --- |
| Two lanes; `why` deferred with reason | 2 (type), 9 (roadmap) |
| `impact` gets the PR URL, `expert` the item title | 5 |
| Expanding a lane runs it | 8 |
| Concurrent dispatch, `Retry-After` honoured | 3 (parse), 5 (retry once) |
| Runs outlive the panel; cached, instant on reopen | 4, 5, 6 |
| Cache TTL and cap mirror the gateway's own | 4 |
| Worker owns polling; alarms are the eviction net | 6 |
| Brief renders as text, never parsed | 7 |
| 404/410 → one `stale` state | 3 |
| Never a silent empty lane | 7 |
| Recogniser gates the invocation | 5 |

**Placeholder scan:** Tasks 6 and 8 reference harness helpers (`stubFetch`, `fireAlarm`, `advanceTimers`, `mountResolvedPanel`, `mountMissPanel`) that the implementer extends from the existing mount/chrome-mock helpers. The assertions are complete; the harness is not, and each step says so.

**Type consistency:** `AgentLane` is defined once in `types.ts` and consumed by the client, store, messages, handler and panel. `LaneState` is the single state shape across the store, the message boundary and the view. `scopeGap` reuses the existing `ScopeGap` and `parseScopeGap` rather than a parallel shape.

**A trap worth naming:** Task 3 requires extracting `postJsonAt`/`getJsonAt` from the existing `postJson`/`getJson`. Do that as a refactor with the existing tests green *before* adding the new callers — if the extraction breaks the clip or resolve paths, that must surface as those tests failing, not as a new agent test failing for an unrelated reason.

**Out of scope, deliberately:** `agents.why`; a markdown renderer; abort (no upstream cancellation exists); C2.3's remaining lanes; notifying when a brief lands while the panel is closed.
