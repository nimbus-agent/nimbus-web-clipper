import { describe, expect, it, test, vi } from "vitest";
import {
  handleAgentRun,
  handleAgentState,
  handleClip,
  handleConnectionStatus,
  handleFetch,
  handlePair,
  handleQueueList,
  handleQueueRemove,
  handleQueueRetry,
  handleRelated,
  handleResolve,
  handleUnpair,
} from "../../src/background/handlers.ts";
import type { QueuedClip } from "../../src/shared/queue.ts";
import type { Connection } from "../../src/shared/types.ts";

const conn: Connection = {
  origin: "http://127.0.0.1:8765",
  token: "tok",
  label: "chrome",
  pairedAt: 100,
};
const capture = {
  url: "https://ex.com/p",
  title: "T",
  mode: "article" as const,
  body: "b",
  readableFound: true,
};

describe("handlePair", () => {
  test("rejects a non-loopback origin without calling the gateway", async () => {
    let called = false;
    const res = await handlePair(
      {
        confirmPair: async () => {
          called = true;
          return { ok: true, token: "t", label: "l" };
        },
        setConnection: async () => undefined,
        nowMs: () => 1,
      },
      { kind: "pair", origin: "http://evil.com", code: "1" },
    );
    expect(res).toEqual({ kind: "pair", ok: false, reason: "bad_origin" });
    expect(called).toBe(false);
  });
  test("on 200 stores the connection and returns the label (never the token)", async () => {
    let stored: Connection | null = null;
    const res = await handlePair(
      {
        confirmPair: async () => ({ ok: true, token: "tok-xyz", label: "chrome" }),
        setConnection: async (c) => {
          stored = c;
        },
        nowMs: () => 100,
      },
      { kind: "pair", origin: "http://127.0.0.1:8765", code: "429173" },
    );
    expect(res).toEqual({ kind: "pair", ok: true, label: "chrome" });
    expect(JSON.stringify(res)).not.toContain("tok-xyz");
    expect(stored).toEqual({
      origin: "http://127.0.0.1:8765",
      token: "tok-xyz",
      label: "chrome",
      pairedAt: 100,
    });
  });
  test("propagates a pairing failure", async () => {
    const res = await handlePair(
      {
        confirmPair: async () => ({ ok: false, reason: "pairing_failed" }),
        setConnection: async () => undefined,
        nowMs: () => 1,
      },
      { kind: "pair", origin: "http://127.0.0.1:8765", code: "000000" },
    );
    expect(res).toEqual({ kind: "pair", ok: false, reason: "pairing_failed" });
  });
});

describe("handleClip", () => {
  test("not paired → not_paired without posting", async () => {
    let called = false;
    const res = await handleClip(
      {
        getConnection: async () => null,
        postClip: async () => {
          called = true;
          return { ok: true, status: "created" };
        },
        updateQueue: async (m) => m([]),
        nowMs: () => 1,
      },
      { kind: "clip", capture, tags: [] },
    );
    expect(res).toEqual({ kind: "clip", ok: false, reason: "not_paired" });
    expect(called).toBe(false);
  });
  test("paired → posts and returns status + bookmarked=false for a readable article", async () => {
    let postedTo = "";
    const res = await handleClip(
      {
        getConnection: async () => conn,
        postClip: async (origin) => {
          postedTo = origin;
          return { ok: true, status: "created" };
        },
        updateQueue: async (m) => m([]),
        nowMs: () => 1,
      },
      { kind: "clip", capture, tags: ["a"] },
    );
    expect(postedTo).toBe("http://127.0.0.1:8765");
    expect(res).toEqual({ kind: "clip", ok: true, status: "created", bookmarked: false });
  });
  test("bookmarked=true when the capture was a fallback", async () => {
    const res = await handleClip(
      {
        getConnection: async () => conn,
        postClip: async () => ({ ok: true, status: "created" }),
        updateQueue: async (m) => m([]),
        nowMs: () => 1,
      },
      { kind: "clip", capture: { ...capture, readableFound: false }, tags: [] },
    );
    expect(res).toEqual({ kind: "clip", ok: true, status: "created", bookmarked: true });
  });
  test("propagates unauthorized", async () => {
    const res = await handleClip(
      {
        getConnection: async () => conn,
        postClip: async () => ({ ok: false, reason: "unauthorized" }),
        updateQueue: async (m) => m([]),
        nowMs: () => 1,
      },
      { kind: "clip", capture, tags: [] },
    );
    expect(res).toEqual({ kind: "clip", ok: false, reason: "unauthorized" });
  });
});

describe("handleRelated", () => {
  const conn: Connection = {
    origin: "http://127.0.0.1:8765",
    token: "tok",
    label: "chrome",
    pairedAt: 1,
  };
  const hit = { id: "1", title: "Doc", service: "drive", snippet: "…", url: null };

  test("not paired → not_paired without posting", async () => {
    let called = false;
    const res = await handleRelated(
      {
        getConnection: async () => null,
        postRelated: async () => {
          called = true;
          return { ok: true, items: [] };
        },
      },
      { kind: "related", title: "T" },
    );
    expect(res).toEqual({ kind: "related", ok: false, reason: "not_paired" });
    expect(called).toBe(false);
  });
  test("paired → builds the query, posts to the connection origin, returns items", async () => {
    let postedTo = "";
    let postedQuery: unknown;
    const res = await handleRelated(
      {
        getConnection: async () => conn,
        postRelated: async (origin, _token, query) => {
          postedTo = origin;
          postedQuery = query;
          return { ok: true, items: [hit] };
        },
      },
      { kind: "related", title: "  Hello  ", canonicalUrl: "https://ex.com/p", selection: "" },
    );
    expect(postedTo).toBe("http://127.0.0.1:8765");
    expect(postedQuery).toEqual({ title: "Hello", canonicalUrl: "https://ex.com/p", limit: 10 });
    expect(res).toEqual({ kind: "related", ok: true, items: [hit] });
  });
  test("propagates unauthorized", async () => {
    const res = await handleRelated(
      {
        getConnection: async () => conn,
        postRelated: async () => ({ ok: false, reason: "unauthorized" }),
      },
      { kind: "related", title: "T" },
    );
    expect(res).toEqual({ kind: "related", ok: false, reason: "unauthorized" });
  });
});

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
  test("does NOT enqueue a payload_too_large failure (it's permanently too big, not offline)", async () => {
    let called = false;
    const res = await handleClip(
      {
        getConnection: async () => conn,
        postClip: async () => ({ ok: false, reason: "payload_too_large" }),
        updateQueue: async (m) => {
          called = true;
          return m([]);
        },
        nowMs: () => 1,
      },
      { kind: "clip", capture, tags: [] },
    );
    expect(res).toEqual({ kind: "clip", ok: false, reason: "payload_too_large" });
    expect(called).toBe(false);
  });
});

describe("handleQueue* handlers", () => {
  test("handleQueueList returns the queue projected to views (no body)", async () => {
    const res = await handleQueueList({ getQueue: async () => [queued("a")] });
    expect(res).toEqual({
      kind: "queue",
      items: [{ url: "a", title: "a", queuedAt: 1, attempts: 0 }],
    });
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

describe("handleConnectionStatus", () => {
  test("not paired → { paired: false }", async () => {
    const res = await handleConnectionStatus({ getConnection: async () => null });
    expect(res).toEqual({ kind: "connection", paired: false });
  });
  test("paired → token-free projection (label/origin/pairedAt; NO token)", async () => {
    // `conn` (defined at the top of this file) carries a token; the response must not.
    const res = await handleConnectionStatus({ getConnection: async () => conn });
    expect(res).toEqual({
      kind: "connection",
      paired: true,
      label: "chrome",
      origin: "http://127.0.0.1:8765",
      pairedAt: 100,
    });
    expect("token" in res).toBe(false);
  });
});

describe("handleUnpair", () => {
  test("clears the connection and returns { paired: false }", async () => {
    let cleared = false;
    const res = await handleUnpair({
      clearConnection: async () => {
        cleared = true;
      },
    });
    expect(cleared).toBe(true);
    expect(res).toEqual({ kind: "connection", paired: false });
  });
});

describe("handleResolve", () => {
  const conn = {
    origin: "http://127.0.0.1:7474",
    token: "tok",
    label: "MacBook",
    pairedAt: 0,
  };
  const PR = "https://github.com/acme/web/pull/1/files";

  it("passes the recogniser's resolveUrl to the gateway and returns the outcome", async () => {
    const seen: string[] = [];
    const res = await handleResolve(
      {
        getOrigins: async () => [],
        getConnection: async () => ({
          origin: "http://127.0.0.1:8765",
          token: "t",
          label: "MacBook",
        }),
        resolveItem: async (_o, _t, url) => {
          seen.push(url);
          return { ok: true, outcome: { kind: "not-indexed", fetchable: true } };
        },
      },
      // Note: recognise() preserves the query string deliberately — the gateway
      // owns canonicalisation, so the recogniser's resolveUrl (asserted below)
      // matches the raw pageUrl verbatim.
      { kind: "resolve", pageUrl: "https://github.com/a/b/pull/1?files=1" },
    );

    expect(seen).toEqual(["https://github.com/a/b/pull/1?files=1"]);
    expect(res).toEqual({
      kind: "resolve",
      ok: true,
      recognition: expect.objectContaining({ ok: true, label: "GitHub PR" }),
      outcome: { kind: "not-indexed", fetchable: true },
    });
  });

  it("keeps the recognition on an insufficient_scope failure", async () => {
    const res = await handleResolve(
      {
        getOrigins: async () => [],
        getConnection: async () => ({
          origin: "http://127.0.0.1:8765",
          token: "t",
          label: "MacBook",
        }),
        resolveItem: async () => ({ ok: false, reason: "insufficient_scope" }),
      },
      { kind: "resolve", pageUrl: "https://github.com/a/b/pull/1" },
    );

    expect(res).toEqual({
      kind: "resolve",
      ok: false,
      recognition: expect.objectContaining({ ok: true, ref: "a/b #1" }),
      reason: "insufficient_scope",
    });
  });

  it("attaches the connection's own label to the scope gap from the 403", async () => {
    const res = await handleResolve(
      {
        getOrigins: async () => [],
        getConnection: async () => ({
          origin: "http://127.0.0.1:8765",
          token: "t",
          label: "chrome",
        }),
        resolveItem: async () => ({
          ok: false,
          reason: "insufficient_scope",
          scopeGap: { required: "resolve", granted: ["clip", "briefs"] },
        }),
      },
      { kind: "resolve", pageUrl: "https://github.com/a/b/pull/1" },
    );

    expect(res).toEqual({
      kind: "resolve",
      ok: false,
      recognition: expect.objectContaining({ ok: true, ref: "a/b #1" }),
      reason: "insufficient_scope",
      scopeGap: { label: "chrome", required: "resolve", granted: ["clip", "briefs"] },
    });
  });

  it("makes no gateway call for an unrecognised page", async () => {
    let called = false;
    const res = await handleResolve(
      {
        getOrigins: async () => [],
        getConnection: async () => ({
          origin: "http://127.0.0.1:8765",
          token: "t",
          label: "MacBook",
        }),
        resolveItem: async () => {
          called = true;
          return { ok: false, reason: "server_error" };
        },
      },
      { kind: "resolve", pageUrl: "https://example.com/whatever" },
    );

    expect(called).toBe(false);
    expect(res).toEqual({
      kind: "resolve",
      ok: true,
      recognition: { ok: false, reason: "unknown-host" },
      outcome: { kind: "not-indexed", fetchable: false },
    });
  });

  test("not paired short-circuits before the gateway call", async () => {
    let called = false;
    const res = await handleResolve(
      {
        getConnection: async () => null,
        getOrigins: async () => [],
        resolveItem: async () => {
          called = true;
          return { ok: true, outcome: { kind: "not-indexed", fetchable: true } };
        },
      },
      { kind: "resolve", pageUrl: PR },
    );
    expect(called).toBe(false);
    expect(res).toMatchObject({ ok: false, reason: "not_paired" });
  });

  test("a configured self-hosted origin is used for recognition", async () => {
    let sent: string | null = null;
    await handleResolve(
      {
        getConnection: async () => conn,
        getOrigins: async () => [{ origin: "https://corp.example/jira", product: "jira" as const }],
        resolveItem: async (_o, _t, url) => {
          sent = url;
          return { ok: true, outcome: { kind: "not-indexed", fetchable: true } };
        },
      },
      { kind: "resolve", pageUrl: "https://corp.example/jira/browse/plat-9?x=1" },
    );
    expect(sent).toBe("https://corp.example/jira/browse/PLAT-9?x=1");
  });
});

describe("handleFetch", () => {
  const conn = { origin: "http://127.0.0.1:8765", token: "t", label: "chrome", pairedAt: 0 };

  it("makes NO gateway call for an unrecognised page", async () => {
    let called = false;
    const res = await handleFetch(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        fetchItem: async () => {
          called = true;
          return { ok: false as const, reason: "server_error" as const };
        },
      },
      { kind: "fetch", pageUrl: "https://example.com/whatever" },
    );

    // This is the security boundary: a fetch is an OUTBOUND request under the
    // user's stored credential, so an unrecognised URL must never reach it.
    expect(called).toBe(false);
    // A settled "can't fetch this", not a gateway error — mirrors
    // handleResolve's equivalent branch (recognition rides on the `ok: true` arm).
    expect(res).toEqual({
      kind: "fetch",
      ok: true,
      recognition: { ok: false, reason: "unknown-host" },
      outcome: { kind: "unfetchable" },
    });
  });

  it("passes the recogniser's resolveUrl and carries the outcome", async () => {
    const seen: string[] = [];
    const res = await handleFetch(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        fetchItem: async (_o, _t, url) => {
          seen.push(url);
          return { ok: true as const, outcome: { kind: "indexed" as const, itemId: "i1" } };
        },
      },
      { kind: "fetch", pageUrl: "https://github.com/a/b/pull/1" },
    );

    expect(seen).toEqual(["https://github.com/a/b/pull/1"]);
    expect(res).toEqual({
      kind: "fetch",
      ok: true,
      recognition: expect.objectContaining({ ok: true, label: "GitHub PR" }),
      outcome: { kind: "indexed", itemId: "i1" },
    });
  });

  it("attaches the device label to a scope gap", async () => {
    const res = await handleFetch(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        fetchItem: async () => ({
          ok: false as const,
          reason: "insufficient_scope" as const,
          scopeGap: { required: "fetch", granted: ["clip", "briefs"] },
        }),
      },
      { kind: "fetch", pageUrl: "https://github.com/a/b/pull/1" },
    );

    expect(res).toMatchObject({
      ok: false,
      reason: "insufficient_scope",
      scopeGap: { label: "chrome", required: "fetch", granted: ["clip", "briefs"] },
    });
  });

  it("short-circuits when not paired", async () => {
    const res = await handleFetch(
      {
        getOrigins: async () => [],
        getConnection: async () => null,
        fetchItem: async () => {
          throw new Error("must not be called");
        },
      },
      { kind: "fetch", pageUrl: "https://github.com/a/b/pull/1" },
    );
    expect(res).toMatchObject({ ok: false, reason: "not_paired" });
  });
});

describe("handleAgentRun", () => {
  const conn = { origin: "http://127.0.0.1:8765", token: "t", label: "chrome", pairedAt: 0 };
  const item = {
    id: "gh-1",
    service: "github",
    type: "pr",
    title: "Cache it",
    url: "https://github.com/a/b/pull/1",
    modifiedAt: 1,
  };

  it("makes NO gateway call for an unrecognised page", async () => {
    let called = false;
    const res = await handleAgentRun(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: async () => ({
          ok: true as const,
          outcome: { kind: "found" as const, item, matchKind: "exact" as const },
        }),
        invokeAgent: async () => {
          called = true;
          return { ok: false as const, reason: "server_error" as const };
        },
        getRun: async () => null,
        putRun: async () => undefined,
      },
      { kind: "agent-run", lane: "impact", pageUrl: "https://example.com/x" },
    );
    expect(called).toBe(false);
    expect(res).toMatchObject({ kind: "agent-state", lane: "impact" });
    // `not_resolved`, never `unsupported`: a page condition, not a gateway one —
    // a weaker `toMatchObject({kind:"failed"})` alone would pass either way.
    expect(res.state).toEqual({ kind: "failed", reason: "not_resolved" });
  });

  it("sends impact the page URL and expert the item title", async () => {
    const seen: Array<{ agent: string; params: unknown }> = [];
    // The brief's parameter is unused inside the factory itself — each caller
    // below passes the matching `req.lane`, so it's kept for readability at the
    // call sites and prefixed to satisfy noUnusedFunctionParameters.
    const deps = (_lane: "impact" | "expert") => ({
      getOrigins: async () => [],
      getConnection: async () => conn,
      resolveItem: async () => ({
        ok: true as const,
        outcome: { kind: "found" as const, item, matchKind: "exact" as const },
      }),
      invokeAgent: async (_o: string, _t: string, agent: string, params: unknown) => {
        seen.push({ agent, params });
        return { ok: true as const, runId: "r1" };
      },
      getRun: async () => null,
      putRun: async () => undefined,
    });
    await handleAgentRun(deps("impact"), {
      kind: "agent-run",
      lane: "impact",
      pageUrl: "https://github.com/a/b/pull/1",
    });
    await handleAgentRun(deps("expert"), {
      kind: "agent-run",
      lane: "expert",
      pageUrl: "https://github.com/a/b/pull/1",
    });

    expect(seen[0]).toEqual({
      agent: "impact",
      params: { fileOrPrUrl: "https://github.com/a/b/pull/1" },
    });
    expect(seen[1]).toEqual({ agent: "expert", params: { topicOrFile: "Cache it" } });
  });

  it("does not re-invoke when a cached done run exists", async () => {
    let called = false;
    const res = await handleAgentRun(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: async () => ({
          ok: true as const,
          outcome: { kind: "found" as const, item, matchKind: "exact" as const },
        }),
        invokeAgent: async () => {
          called = true;
          return { ok: true as const, runId: "r2" };
        },
        getRun: async () => ({
          itemId: "gh-1",
          lane: "impact" as const,
          runId: "r1",
          state: { kind: "done" as const, brief: "b" },
          expiresAtMs: 9e15,
        }),
        putRun: async () => undefined,
      },
      { kind: "agent-run", lane: "impact", pageUrl: "https://github.com/a/b/pull/1" },
    );
    expect(called).toBe(false);
    expect(res.state).toEqual({ kind: "done", brief: "b" });
  });

  // A cached `failed` must NOT short-circuit — unlike `done`/`running` above —
  // or the Re-run button `AgentError`'s doc comment promises ("one state, one
  // Re-run") would be inert until the 10-minute TTL expires.
  it("DOES re-invoke when a cached failed run exists (Re-run must stay live)", async () => {
    let called = false;
    const res = await handleAgentRun(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: async () => ({
          ok: true as const,
          outcome: { kind: "found" as const, item, matchKind: "exact" as const },
        }),
        invokeAgent: async () => {
          called = true;
          return { ok: true as const, runId: "r-rerun" };
        },
        getRun: async () => ({
          itemId: "gh-1",
          lane: "impact" as const,
          runId: "r1",
          state: { kind: "failed" as const, reason: "stale" as const },
          expiresAtMs: 9e15,
        }),
        putRun: async () => undefined,
      },
      { kind: "agent-run", lane: "impact", pageUrl: "https://github.com/a/b/pull/1" },
    );
    expect(called).toBe(true);
    expect(res.state).toEqual({ kind: "running", runId: "r-rerun" });
  });

  it("refuses when the page resolves to a miss — there is no item to ask about", async () => {
    const res = await handleAgentRun(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: async () => ({
          ok: true as const,
          outcome: { kind: "not-indexed" as const, fetchable: true },
        }),
        invokeAgent: async () => {
          throw new Error("must not be called");
        },
        getRun: async () => null,
        putRun: async () => undefined,
      },
      { kind: "agent-run", lane: "impact", pageUrl: "https://github.com/a/b/pull/1" },
    );
    expect(res.state).toMatchObject({ kind: "failed" });
    // A resolve miss is a page condition, not a gateway one — `not_resolved`.
    expect(res.state).toEqual({ kind: "failed", reason: "not_resolved" });
  });

  it("short-circuits before resolving when not paired", async () => {
    let resolveCalled = false;
    const res = await handleAgentRun(
      {
        getOrigins: async () => [],
        getConnection: async () => null,
        resolveItem: async () => {
          resolveCalled = true;
          return { ok: true as const, outcome: { kind: "not-indexed" as const, fetchable: true } };
        },
        invokeAgent: async () => {
          throw new Error("must not be called");
        },
        getRun: async () => null,
        putRun: async () => undefined,
      },
      { kind: "agent-run", lane: "impact", pageUrl: "https://github.com/a/b/pull/1" },
    );
    expect(resolveCalled).toBe(false);
    expect(res.state).toEqual({ kind: "failed", reason: "not_paired" });
  });

  it("persists a running state under the resolved item's id and lane", async () => {
    const puts: unknown[] = [];
    const res = await handleAgentRun(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: async () => ({
          ok: true as const,
          outcome: { kind: "found" as const, item, matchKind: "exact" as const },
        }),
        invokeAgent: async () => ({ ok: true as const, runId: "r9" }),
        getRun: async () => null,
        putRun: async (run) => {
          puts.push(run);
        },
      },
      { kind: "agent-run", lane: "impact", pageUrl: "https://github.com/a/b/pull/1" },
    );
    expect(puts).toEqual([
      { itemId: "gh-1", lane: "impact", runId: "r9", state: { kind: "running", runId: "r9" } },
    ]);
    expect(res.state).toEqual({ kind: "running", runId: "r9" });
  });

  // Behaviour 4: on `busy` the handler waits the given `retryAfterMs` and retries
  // exactly once. Fake timers stand in for the real wait so the test stays fast.
  //
  // A DIFFERENT, sharper reason to reach for `vi.useFakeTimers()` lives in
  // test/unit/service-worker.test.ts, not here: this file drives `handleAgentRun`
  // directly against injected stub `deps`, so nothing here ever schedules a real
  // timer. But driving the SAME `agent-run` message through the real service
  // worker (service-worker.test.ts) makes a successful invoke persist a `running`
  // state, and agentRunDeps.putRun's side effect there starts the in-worker poll
  // loop with a genuine `setTimeout`. `vi.resetModules()` between tests does not
  // cancel that pending real timer — leave it unguarded and it can fire during a
  // LATER, unrelated test, hitting whatever `chrome`/`fetch` mock happens to be
  // active then and non-deterministically breaking a `not.toHaveBeenCalled()`
  // assertion there. Any new test in service-worker.test.ts that drives a
  // successful `agent-run` must wrap it in `vi.useFakeTimers()` / `vi.useRealTimers()`
  // for that reason — see the existing agent-run tests there for the pattern.
  it("on busy, waits retryAfterMs and retries once, then succeeds if the retry does", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = handleAgentRun(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: async () => ({
          ok: true as const,
          outcome: { kind: "found" as const, item, matchKind: "exact" as const },
        }),
        invokeAgent: async () => {
          calls++;
          return calls === 1
            ? { ok: false as const, reason: "busy" as const, retryAfterMs: 1000 }
            : { ok: true as const, runId: "r-retry" };
        },
        getRun: async () => null,
        putRun: async () => undefined,
      },
      { kind: "agent-run", lane: "impact", pageUrl: "https://github.com/a/b/pull/1" },
    );
    await vi.advanceTimersByTimeAsync(1000);
    const res = await promise;
    vi.useRealTimers();

    expect(calls).toBe(2);
    expect(res.state).toEqual({ kind: "running", runId: "r-retry" });
  });

  // A second 429 within the retry window means genuine contention, not something
  // a longer wait would fix — report server_error rather than backing off again.
  it("on a second busy, reports server_error rather than retrying again", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = handleAgentRun(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: async () => ({
          ok: true as const,
          outcome: { kind: "found" as const, item, matchKind: "exact" as const },
        }),
        invokeAgent: async () => {
          calls++;
          return { ok: false as const, reason: "busy" as const, retryAfterMs: 1000 };
        },
        getRun: async () => null,
        putRun: async () => undefined,
      },
      { kind: "agent-run", lane: "impact", pageUrl: "https://github.com/a/b/pull/1" },
    );
    await vi.advanceTimersByTimeAsync(1000);
    const res = await promise;
    vi.useRealTimers();

    expect(calls).toBe(2);
    expect(res.state).toEqual({ kind: "failed", reason: "server_error" });
  });

  // Only a SECOND `busy` collapses to `server_error` — any other retry failure is
  // the real answer and must be reported as itself, scope gap included. Collapsing
  // a 403 here would strip the guidance that actually fixes it.
  it("on a first busy then a 403 with a scope gap, reports the 403 (not server_error)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = handleAgentRun(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: async () => ({
          ok: true as const,
          outcome: { kind: "found" as const, item, matchKind: "exact" as const },
        }),
        invokeAgent: async () => {
          calls++;
          return calls === 1
            ? { ok: false as const, reason: "busy" as const, retryAfterMs: 1000 }
            : {
                ok: false as const,
                reason: "insufficient_scope" as const,
                scopeGap: { required: "agents", granted: ["clip", "resolve"] },
              };
        },
        getRun: async () => null,
        putRun: async () => undefined,
      },
      { kind: "agent-run", lane: "impact", pageUrl: "https://github.com/a/b/pull/1" },
    );
    await vi.advanceTimersByTimeAsync(1000);
    const res = await promise;
    vi.useRealTimers();

    expect(calls).toBe(2);
    expect(res.state).toEqual({
      kind: "failed",
      reason: "insufficient_scope",
      scopeGap: { label: "chrome", required: "agents", granted: ["clip", "resolve"] },
    });
  });

  // Same shape, a transport failure instead of a scope failure — e.g. the gateway
  // restarted between the two attempts. Also must not collapse to server_error.
  it("on a first busy then unreachable, reports unreachable (not server_error)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = handleAgentRun(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: async () => ({
          ok: true as const,
          outcome: { kind: "found" as const, item, matchKind: "exact" as const },
        }),
        invokeAgent: async () => {
          calls++;
          return calls === 1
            ? { ok: false as const, reason: "busy" as const, retryAfterMs: 1000 }
            : { ok: false as const, reason: "unreachable" as const };
        },
        getRun: async () => null,
        putRun: async () => undefined,
      },
      { kind: "agent-run", lane: "impact", pageUrl: "https://github.com/a/b/pull/1" },
    );
    await vi.advanceTimersByTimeAsync(1000);
    const res = await promise;
    vi.useRealTimers();

    expect(calls).toBe(2);
    expect(res.state).toEqual({ kind: "failed", reason: "unreachable" });
  });

  it("attaches the device label to a 403's scope gap from invokeAgent", async () => {
    const res = await handleAgentRun(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: async () => ({
          ok: true as const,
          outcome: { kind: "found" as const, item, matchKind: "exact" as const },
        }),
        invokeAgent: async () => ({
          ok: false as const,
          reason: "insufficient_scope" as const,
          scopeGap: { required: "agents", granted: ["clip", "resolve"] },
        }),
        getRun: async () => null,
        putRun: async () => undefined,
      },
      { kind: "agent-run", lane: "impact", pageUrl: "https://github.com/a/b/pull/1" },
    );
    expect(res.state).toEqual({
      kind: "failed",
      reason: "insufficient_scope",
      scopeGap: { label: "chrome", required: "agents", granted: ["clip", "resolve"] },
    });
  });

  it("a 403 with no scope detail produces a failed state with no scopeGap, never a fabricated one", async () => {
    const res = await handleAgentRun(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: async () => ({
          ok: true as const,
          outcome: { kind: "found" as const, item, matchKind: "exact" as const },
        }),
        invokeAgent: async () => ({ ok: false as const, reason: "insufficient_scope" as const }),
        getRun: async () => null,
        putRun: async () => undefined,
      },
      { kind: "agent-run", lane: "impact", pageUrl: "https://github.com/a/b/pull/1" },
    );
    expect(res.state).toEqual({ kind: "failed", reason: "insufficient_scope" });
    expect("scopeGap" in res.state).toBe(false);
  });

  it("attaches the device label to a 403's scope gap from resolveItem too", async () => {
    const res = await handleAgentRun(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: async () => ({
          ok: false as const,
          reason: "insufficient_scope" as const,
          scopeGap: { required: "resolve", granted: ["clip"] },
        }),
        invokeAgent: async () => {
          throw new Error("must not be called");
        },
        getRun: async () => null,
        putRun: async () => undefined,
      },
      { kind: "agent-run", lane: "impact", pageUrl: "https://github.com/a/b/pull/1" },
    );
    expect(res.state).toEqual({
      kind: "failed",
      reason: "insufficient_scope",
      scopeGap: { label: "chrome", required: "resolve", granted: ["clip"] },
    });
  });
});

describe("handleAgentState", () => {
  const conn = { origin: "http://127.0.0.1:8765", token: "t", label: "chrome", pairedAt: 0 };
  const item = {
    id: "gh-1",
    service: "github",
    type: "pr",
    title: "Cache it",
    url: "https://github.com/a/b/pull/1",
    modifiedAt: 1,
  };

  it("is read-only: never calls invokeAgent-shaped behaviour, just reads the cache", async () => {
    const res = await handleAgentState(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: async () => ({
          ok: true as const,
          outcome: { kind: "found" as const, item, matchKind: "exact" as const },
        }),
        getRun: async () => ({
          itemId: "gh-1",
          lane: "impact" as const,
          runId: "r1",
          state: { kind: "running" as const, runId: "r1" },
          expiresAtMs: 9e15,
        }),
      },
      { kind: "agent-state", lane: "impact", pageUrl: "https://github.com/a/b/pull/1" },
    );
    expect(res).toEqual({
      kind: "agent-state",
      lane: "impact",
      state: { kind: "running", runId: "r1" },
    });
  });

  it("reports collapsed when no run has ever started", async () => {
    const res = await handleAgentState(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: async () => ({
          ok: true as const,
          outcome: { kind: "found" as const, item, matchKind: "exact" as const },
        }),
        getRun: async () => null,
      },
      { kind: "agent-state", lane: "expert", pageUrl: "https://github.com/a/b/pull/1" },
    );
    expect(res).toEqual({ kind: "agent-state", lane: "expert", state: { kind: "collapsed" } });
  });

  it("makes NO gateway call for an unrecognised page", async () => {
    let getRunCalled = false;
    const res = await handleAgentState(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: async () => {
          throw new Error("must not be called");
        },
        getRun: async () => {
          getRunCalled = true;
          return null;
        },
      },
      { kind: "agent-state", lane: "impact", pageUrl: "https://example.com/x" },
    );
    expect(getRunCalled).toBe(false);
    expect(res.state).toEqual({ kind: "failed", reason: "not_resolved" });
  });

  it("attaches the device label to a resolve 403's scope gap", async () => {
    const res = await handleAgentState(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: async () => ({
          ok: false as const,
          reason: "insufficient_scope" as const,
          scopeGap: { required: "resolve", granted: [] },
        }),
        getRun: async () => null,
      },
      { kind: "agent-state", lane: "impact", pageUrl: "https://github.com/a/b/pull/1" },
    );
    expect(res.state).toEqual({
      kind: "failed",
      reason: "insufficient_scope",
      scopeGap: { label: "chrome", required: "resolve", granted: [] },
    });
  });
});
