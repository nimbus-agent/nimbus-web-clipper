import { describe, expect, it, test, vi } from "vitest";
import {
  handleAgentRun,
  handleAgentState,
  handleCapture,
  handleClip,
  handleConnectionStatus,
  handleDiscover,
  handleFetch,
  handlePair,
  handleQueueList,
  handleQueueRemove,
  handleQueueRetry,
  handleRecognise,
  handleRelated,
  handleResolve,
  handleUnpair,
} from "../../src/background/handlers.ts";
import type { QueuedClip } from "../../src/shared/queue.ts";
import { AGENT_LANES, type Connection } from "../../src/shared/types.ts";

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

describe("handleCapture", () => {
  const PAGE = "https://wiki.example.com/runbook";
  const capture = {
    url: PAGE,
    title: "Runbook",
    mode: "article" as const,
    body: "the body text",
    readableFound: true,
  };

  test("preview on → returns the capture and a built preview", async () => {
    const res = await handleCapture(
      {
        captureTab: async () => ({ ok: true, capture }),
        previewEnabled: async () => true,
        now: () => 1_700_000_000_000,
      },
      { kind: "capture", pageUrl: PAGE },
      7,
    );
    expect(res.kind).toBe("capture");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.capture).toEqual(capture);
      expect(res.preview).not.toBeNull();
      // The token invariant: a preview names its fields explicitly and can never
      // carry a secret. Assert the shape rather than trusting the builder.
      expect(res.preview?.fields.some((f) => /token/i.test(f.label))).toBe(false);
    }
  });

  test("preview off → preview is null so the panel sends immediately", async () => {
    const res = await handleCapture(
      {
        captureTab: async () => ({ ok: true, capture }),
        previewEnabled: async () => false,
        now: () => 1,
      },
      { kind: "capture", pageUrl: PAGE },
      7,
    );
    expect(res.ok && res.preview).toBeNull();
  });

  test("a refusal from captureTab is passed through with its reason", async () => {
    const res = await handleCapture(
      {
        captureTab: async () => ({ ok: false, reason: "url-changed" }),
        previewEnabled: async () => true,
        now: () => 1,
      },
      { kind: "capture", pageUrl: PAGE },
      7,
    );
    expect(res).toEqual({ kind: "capture", ok: false, reason: "url-changed" });
  });

  test("the pinned url is passed to captureTab as the expected url", async () => {
    let seen: string | null = null;
    await handleCapture(
      {
        captureTab: async (_tabId, expected) => {
          seen = expected;
          return { ok: true, capture };
        },
        previewEnabled: async () => false,
        now: () => 1,
      },
      { kind: "capture", pageUrl: PAGE },
      7,
    );
    expect(seen).toBe(PAGE);
  });
});

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
        clearRuns: async () => undefined,
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
        clearRuns: async () => undefined,
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
        clearRuns: async () => undefined,
        nowMs: () => 1,
      },
      { kind: "pair", origin: "http://127.0.0.1:8765", code: "000000" },
    );
    expect(res).toEqual({ kind: "pair", ok: false, reason: "pairing_failed" });
  });

  test("a successful pair clears cached agent runs after storing the connection", async () => {
    let setConnectionCalls = 0;
    let clearRunsCalls = 0;
    const res = await handlePair(
      {
        confirmPair: async () => ({ ok: true, token: "tok-xyz", label: "chrome" }),
        setConnection: async () => {
          setConnectionCalls += 1;
        },
        clearRuns: async () => {
          clearRunsCalls += 1;
        },
        nowMs: () => 100,
      },
      { kind: "pair", origin: "http://127.0.0.1:8765", code: "429173" },
    );
    expect(res).toEqual({ kind: "pair", ok: true, label: "chrome" });
    expect(setConnectionCalls).toBe(1);
    expect(clearRunsCalls).toBe(1);
  });

  test("a failed pair does not clear cached agent runs", async () => {
    let setConnectionCalls = 0;
    let clearRunsCalls = 0;
    const res = await handlePair(
      {
        confirmPair: async () => ({ ok: false, reason: "pairing_failed" }),
        setConnection: async () => {
          setConnectionCalls += 1;
        },
        clearRuns: async () => {
          clearRunsCalls += 1;
        },
        nowMs: () => 1,
      },
      { kind: "pair", origin: "http://127.0.0.1:8765", code: "000000" },
    );
    expect(res).toEqual({ kind: "pair", ok: false, reason: "pairing_failed" });
    expect(setConnectionCalls).toBe(0);
    expect(clearRunsCalls).toBe(0);
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

describe("handleUnpair", () => {
  test("clears the connection and returns { paired: false }", async () => {
    let cleared = false;
    const res = await handleUnpair({
      clearConnection: async () => {
        cleared = true;
      },
      clearRuns: async () => undefined,
    });
    expect(cleared).toBe(true);
    expect(res).toEqual({ kind: "connection", paired: false });
  });

  it("forgets cached agent runs on unpair", async () => {
    let cleared = 0;
    const res = await handleUnpair({
      clearConnection: async () => undefined,
      clearRuns: async () => {
        cleared += 1;
      },
    });
    expect(cleared).toBe(1);
    expect(res).toEqual({ kind: "connection", paired: false });
  });
});

describe("handleRecognise", () => {
  it("classifies a built-in origin", async () => {
    const res = await handleRecognise(
      { getOrigins: async () => [] },
      { kind: "recognise", pageUrl: "https://github.com/acme/web/pull/482" },
    );
    expect(res).toEqual({
      kind: "recognition",
      ok: true,
      recognition: {
        ok: true,
        product: "github",
        kind: "pr",
        label: "GitHub PR",
        ref: "acme/web #482",
        resolveUrl: "https://github.com/acme/web/pull/482",
      },
    });
  });

  it("classifies a configured self-hosted origin", async () => {
    const res = await handleRecognise(
      { getOrigins: async () => [{ origin: "https://corp.example/jira", product: "jira" }] },
      { kind: "recognise", pageUrl: "https://corp.example/jira/browse/abc-12" },
    );
    expect(res).toMatchObject({
      ok: true,
      recognition: { ok: true, product: "jira", ref: "ABC-12" },
    });
  });

  it("reports an unrecognised page as a miss, not an error", async () => {
    const res = await handleRecognise(
      { getOrigins: async () => [] },
      { kind: "recognise", pageUrl: "https://example.com/whatever" },
    );
    expect(res).toEqual({
      kind: "recognition",
      ok: true,
      recognition: { ok: false, reason: "unknown-host" },
    });
  });

  // This route exists so the panel can ask "same item?" on every navigation. If it
  // ever touched the gateway or the token it would be a per-navigation network
  // call under a client whose whole story is that nothing leaves without asking.
  it("never reads a connection and never calls the gateway", async () => {
    const getConnection = vi.fn();
    const resolveItem = vi.fn();
    await handleRecognise(
      { getOrigins: async () => [], ...({ getConnection, resolveItem } as object) },
      { kind: "recognise", pageUrl: "https://github.com/acme/web/pull/482" },
    );
    expect(getConnection).not.toHaveBeenCalled();
    expect(resolveItem).not.toHaveBeenCalled();
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
        readConnectorHealth: async () => null,
        readAgentRoster: async () => ({ unavailable: true }),
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
        readConnectorHealth: async () => null,
        readAgentRoster: async () => ({ unavailable: true }),
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
        readConnectorHealth: async () => null,
        readAgentRoster: async () => ({ unavailable: true }),
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
        readConnectorHealth: async () => null,
        readAgentRoster: async () => ({ unavailable: true }),
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
        readConnectorHealth: async () => null,
        readAgentRoster: async () => ({ unavailable: true }),
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
        readConnectorHealth: async () => null,
        readAgentRoster: async () => ({ unavailable: true }),
      },
      { kind: "resolve", pageUrl: "https://corp.example/jira/browse/plat-9?x=1" },
    );
    expect(sent).toBe("https://corp.example/jira/browse/PLAT-9?x=1");
  });

  it("answers a home page without calling the gateway", async () => {
    let resolveCalls = 0;
    const deps = {
      getOrigins: async () => [],
      getConnection: async () => ({ origin: "http://127.0.0.1:7777", token: "t", label: "dev" }),
      resolveItem: async () => {
        resolveCalls += 1;
        return { ok: true as const, outcome: { kind: "not-indexed" as const, fetchable: false } };
      },
      readConnectorHealth: async () => null,
      readAgentRoster: async () => ({ unavailable: true as const }),
    };

    const res = await handleResolve(deps, {
      kind: "resolve",
      pageUrl: "https://github.com/",
      title: "GitHub",
    });

    expect(resolveCalls).toBe(0);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.recognition.ok).toBe(true);
    if (!res.recognition.ok) return;
    expect(res.recognition.kind).toBe("home");
  });

  it("reports not_paired on a dashboard when unpaired, without calling resolve", async () => {
    let resolveCalls = 0;
    const deps = {
      getOrigins: async () => [],
      getConnection: async () => null,
      resolveItem: async () => {
        resolveCalls += 1;
        return { ok: true as const, outcome: { kind: "not-indexed" as const, fetchable: false } };
      },
      readConnectorHealth: async () => null,
      readAgentRoster: async () => ({ unavailable: true as const }),
    };

    const res = await handleResolve(deps, {
      kind: "resolve",
      pageUrl: "https://github.com/",
      title: "GitHub",
    });

    expect(resolveCalls).toBe(0);
    expect(res).toMatchObject({ ok: false, reason: "not_paired" });
  });
});

describe("handleResolve attaches the offered lanes", () => {
  const prResolveDeps = {
    getOrigins: async () => [],
    getConnection: async () => ({ origin: "http://127.0.0.1:8765", token: "t", label: "MacBook" }),
    resolveItem: async () => ({
      ok: true as const,
      outcome: { kind: "not-indexed" as const, fetchable: true },
    }),
    readConnectorHealth: async () => null,
    readAgentRoster: async () => ({ unavailable: true as const }),
  };

  it("attaches the lanes the gateway can serve", async () => {
    const res = await handleResolve(
      {
        getOrigins: async () => [],
        getConnection: async () => ({
          origin: "http://127.0.0.1:8765",
          token: "t",
          label: "MacBook",
        }),
        resolveItem: async () => ({ ok: true, outcome: { kind: "not-indexed", fetchable: true } }),
        readConnectorHealth: async () => null,
        readAgentRoster: async () => ({ names: ["why", "impact"], version: "7.6.0" }),
      },
      { kind: "resolve", pageUrl: "https://github.com/acme/web/pull/482" },
    );
    expect(res.ok).toBe(true);
    expect(res.ok === true && res.offeredLanes).toEqual(["impact", "why"]);
  });

  // The roster read failing must leave the panel exactly as it renders without one.
  it("omits the offered lanes when the roster could not be read", async () => {
    const res = await handleResolve(
      { ...prResolveDeps, readAgentRoster: async () => ({ unavailable: true }) },
      { kind: "resolve", pageUrl: "https://github.com/acme/web/pull/482" },
    );
    expect(res.ok === true && "offeredLanes" in res).toBe(false);
  });

  // The gate is computed for the PAGE's own surface, and these two are the only
  // handler-level tests that can tell. Everything above resolves a GitHub PR or a
  // GitHub dashboard, where the floor never applies — so replacing
  // `recognition.kind` with a literal `"pr"` in `offeredFor`'s call would leave
  // the whole suite green while offering the three item lanes to every gateway
  // below the floor, which is the exact failure this gate exists to prevent.
  const JIRA_ISSUE = "https://acme.atlassian.net/browse/PLAT-91";

  it("floors the item lanes on an issue when the gateway reports no version", async () => {
    const res = await handleResolve(
      {
        ...prResolveDeps,
        readAgentRoster: async () => ({ names: [...AGENT_LANES], version: null }),
      },
      { kind: "resolve", pageUrl: JIRA_ISSUE },
    );
    expect(res.ok).toBe(true);
    const offered = res.ok === true ? res.offeredLanes : undefined;
    expect(offered).toBeDefined();
    expect(offered).not.toContain("why");
    expect(offered).not.toContain("expert");
    expect(offered).not.toContain("ownership");
  });

  it("offers the item lanes on an issue when the gateway is at the floor", async () => {
    const res = await handleResolve(
      {
        ...prResolveDeps,
        readAgentRoster: async () => ({ names: [...AGENT_LANES], version: "7.6.0" }),
      },
      { kind: "resolve", pageUrl: JIRA_ISSUE },
    );
    expect(res.ok).toBe(true);
    const offered = res.ok === true ? res.offeredLanes : undefined;
    expect(offered).toContain("why");
    expect(offered).toContain("expert");
    expect(offered).toContain("ownership");
  });

  // A dashboard gets the list too: the three service lanes are roster-gated like
  // every other lane, on top of the connector-health gate they already have.
  it("attaches the offered lanes on a dashboard", async () => {
    const res = await handleResolve(
      {
        ...prResolveDeps,
        readAgentRoster: async () => ({ names: ["catchup"], version: "7.6.0" }),
      },
      { kind: "resolve", pageUrl: "https://github.com/" },
    );
    expect(res.ok === true && res.offeredLanes).toEqual(["catchup"]);
  });

  // No pairing, no bearer, no roster read — the same rule every gateway call here
  // follows. Assert the CALL never happens, not merely that the field is absent.
  it("does not read the roster when unpaired", async () => {
    let called = false;
    await handleResolve(
      {
        ...prResolveDeps,
        getConnection: async () => null,
        readAgentRoster: async () => {
          called = true;
          return { unavailable: true };
        },
      },
      { kind: "resolve", pageUrl: "https://github.com/acme/web/pull/482" },
    );
    expect(called).toBe(false);
  });
});

describe("handleResolve attaches connector health on a dashboard", () => {
  const conn = { origin: "http://127.0.0.1:7777", token: "t", label: "dev" };
  const okOutcome = async () => ({
    ok: true as const,
    outcome: { kind: "not-indexed" as const, fetchable: false },
  });

  it("reports the health of the recognised product's connector", async () => {
    const res = await handleResolve(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: okOutcome,
        readConnectorHealth: async () => new Map([["github", { state: "healthy" as const }]]),
        readAgentRoster: async () => ({ unavailable: true }),
      },
      { kind: "resolve", pageUrl: "https://github.com/" },
    );
    expect(res.ok && res.connector?.state).toBe("healthy");
  });

  it("reports unknown when the read failed — never a state it did not see", async () => {
    const res = await handleResolve(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: okOutcome,
        readConnectorHealth: async () => null,
        readAgentRoster: async () => ({ unavailable: true }),
      },
      { kind: "resolve", pageUrl: "https://github.com/" },
    );
    expect(res.ok && res.connector?.state).toBe("unknown");
  });

  it("reports not_configured when the gateway listed no row for this connector", async () => {
    // `getAllConnectorHealth` selects FROM sync_state, whose only production insert is
    // inside `transitionHealth` — so a connector the scheduler never touched has no row
    // and is simply omitted. That is the ordinary never-configured connector this gate
    // exists for, NOT an unreadable answer, and upstream's own single-connector
    // accessor answers `not_configured` for the same missing row.
    const res = await handleResolve(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: okOutcome,
        readConnectorHealth: async () => new Map(),
        readAgentRoster: async () => ({ unavailable: true }),
      },
      { kind: "resolve", pageUrl: "https://github.com/" },
    );
    expect(res.ok && res.connector?.state).toBe("not_configured");
  });

  it("keeps a failed read and an absent row distinct", async () => {
    // The whole point of the pair above: `unknown` must mean "could not ask" and
    // nothing else, because `unknown` is the only state that renders the ungated
    // panel. If these two ever collapse, either every older gateway starts
    // withholding lanes, or every unconfigured connector goes back to answering
    // three times with nothing.
    const absent = await handleResolve(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: okOutcome,
        readConnectorHealth: async () => new Map(),
        readAgentRoster: async () => ({ unavailable: true }),
      },
      { kind: "resolve", pageUrl: "https://github.com/" },
    );
    const failed = await handleResolve(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: okOutcome,
        readConnectorHealth: async () => null,
        readAgentRoster: async () => ({ unavailable: true }),
      },
      { kind: "resolve", pageUrl: "https://github.com/" },
    );
    expect(absent.ok && absent.connector?.state).not.toBe(
      failed.ok ? failed.connector?.state : undefined,
    );
  });

  it("still reports the connector's own state when the gateway did list it", async () => {
    // The absent-row rule must not swallow a real answer.
    const res = await handleResolve(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: okOutcome,
        readConnectorHealth: async () => new Map([["github", { state: "degraded" as const }]]),
        readAgentRoster: async () => ({ unavailable: true }),
      },
      { kind: "resolve", pageUrl: "https://github.com/" },
    );
    expect(res.ok && res.connector?.state).toBe("degraded");
  });

  it("makes no health read on a non-dashboard page", async () => {
    let calls = 0;
    await handleResolve(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: okOutcome,
        readConnectorHealth: async () => {
          calls++;
          return null;
        },
        readAgentRoster: async () => ({ unavailable: true }),
      },
      { kind: "resolve", pageUrl: "https://github.com/acme/web/pull/1" },
    );
    expect(calls).toBe(0);
  });

  it("makes no health read when unpaired", async () => {
    // Pairing is the consent moment; an unpaired extension makes no gateway reads.
    let calls = 0;
    const res = await handleResolve(
      {
        getOrigins: async () => [],
        getConnection: async () => null,
        resolveItem: okOutcome,
        readConnectorHealth: async () => {
          calls++;
          return null;
        },
        readAgentRoster: async () => ({ unavailable: true }),
      },
      { kind: "resolve", pageUrl: "https://github.com/" },
    );
    expect(res.ok).toBe(false);
    expect(calls).toBe(0);
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

  // The three item lanes on an issue. Each sends the page URL under `itemUrl` —
  // upstream's arm name, mutually exclusive with prUrl / topicOrFile / service.
  //
  // A local deps factory rather than a file-level fixture, and the URL is one
  // `recognise.test.ts` pins: a URL the recogniser rejects would make every one of
  // these pass for the wrong reason, failing at `not_resolved` before any param is
  // built.
  //
  // The Jira page is deliberately NOT already canonical. Its key is lower-cased
  // and it carries a query string, so `recognise` upper-cases the key on its way
  // to `resolveUrl` (`jira.ts`) and the two strings differ — which is the only
  // reason this case can tell `resolveUrl` from the raw `pageUrl` at all. Spec
  // §2.1 requires the byte-identical `resolveUrl`, and with three already-canonical
  // URLs every one of these would pass for a build that sent either. The
  // neighbouring `why`-on-a-PR test carries a sub-tab segment and a query for
  // exactly the same reason. (Note what Jira does NOT do: the query survives —
  // canonicalisation is the gateway's job — so the case difference is the whole
  // signal here.)
  const ITEM_PAGES = [
    [
      "a Jira issue",
      "https://acme.atlassian.net/browse/plat-91?filter=1",
      "https://acme.atlassian.net/browse/PLAT-91?filter=1",
    ],
    [
      "a Linear issue",
      "https://linear.app/acme/issue/ENG-123/fix-the-thing",
      "https://linear.app/acme/issue/ENG-123/fix-the-thing",
    ],
    [
      "a PagerDuty incident",
      "https://acmeco.pagerduty.com/incidents/PT4KHLK",
      "https://acmeco.pagerduty.com/incidents/PT4KHLK",
    ],
  ] as const;

  const itemLaneCases = (["why", "expert", "ownership"] as const).flatMap((lane) =>
    ITEM_PAGES.map(([where, pageUrl, itemUrl]) => ({ lane, where, pageUrl, itemUrl })),
  );

  it.each(itemLaneCases)("sends $lane an itemUrl on $where", async ({ lane, pageUrl, itemUrl }) => {
    const invoked: unknown[] = [];
    await handleAgentRun(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: async () => ({
          ok: true as const,
          outcome: { kind: "found" as const, item, matchKind: "exact" as const },
        }),
        invokeAgent: async (_o: string, _t: string, _agent: string, params: unknown) => {
          invoked.push(params);
          return { ok: true as const, runId: "r1" };
        },
        getRun: async () => null,
        putRun: async () => undefined,
      },
      { kind: "agent-run", lane, pageUrl },
    );
    expect(invoked).toEqual([{ itemUrl }]);
  });

  // §4.3: a page that resolves to nothing is a condition of the PAGE, and it is
  // already spelled. The item lanes reuse `not_resolved` rather than inventing a
  // second vocabulary for the same fact.
  it("reports not_resolved for an item lane on an unindexed issue", async () => {
    const res = await handleAgentRun(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: async () => ({
          ok: true as const,
          outcome: { kind: "not-indexed" as const, fetchable: true },
        }),
        invokeAgent: async () => {
          throw new Error("must not invoke for a page that resolves to nothing");
        },
        getRun: async () => null,
        putRun: async () => undefined,
      },
      { kind: "agent-run", lane: "why", pageUrl: "https://acme.atlassian.net/browse/PLAT-91" },
    );
    expect(res.state).toEqual({ kind: "failed", reason: "not_resolved" });
  });

  // Unchanged, and the point of carrying the surface: same lane, same `item`
  // scope, different arm — a PR page has served `prUrl` for releases, so widening
  // the table must not move it. `impact`'s and `expert`'s PR arms are pinned by
  // "sends impact the page URL and expert the item title" above, and `why`'s by
  // the test below.
  it("still sends ownership a service on a dashboard, not an itemUrl", async () => {
    const invoked: Array<{ agent: string; params: unknown }> = [];
    await handleAgentRun(
      {
        getOrigins: async () => [],
        getConnection: async () => conn,
        resolveItem: async () => {
          throw new Error("must not resolve on a dashboard");
        },
        invokeAgent: async (_o: string, _t: string, agent: string, params: unknown) => {
          invoked.push({ agent, params });
          return { ok: true as const, runId: "r1" };
        },
        getRun: async () => null,
        putRun: async () => undefined,
      },
      { kind: "agent-run", lane: "ownership", pageUrl: "https://github.com/" },
    );
    expect(invoked).toEqual([{ agent: "ownership", params: { service: "github" } }]);
  });

  it("the why lane is asked with the page's PR URL, not the item title, and unnormalised", async () => {
    // Same URL impact receives. Sending `topicOrFile` here would be the
    // wrong-question-wrong-input bug LANE_RULES exists to prevent, one layer
    // down. The sub-tab segment and query string are deliberate, not
    // incidental: `resolveUrl` must arrive at the gateway byte-identical to
    // what recognise() produced (spec §2.1) — a pageUrl that already happened
    // to be canonical would let a trimming or query-stripping implementation
    // pass this test by accident.
    const seen: Array<{ agent: string; params: unknown }> = [];
    await handleAgentRun(
      {
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
      },
      {
        kind: "agent-run",
        lane: "why",
        pageUrl: "https://github.com/a/b/pull/1/files?w=1",
      },
    );

    expect(seen[0]).toEqual({
      agent: "why",
      params: { prUrl: "https://github.com/a/b/pull/1/files?w=1" },
    });
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
          subject: { kind: "item" as const, id: "gh-1" },
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
          subject: { kind: "item" as const, id: "gh-1" },
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
      {
        subject: { kind: "item", id: "gh-1" },
        lane: "impact",
        runId: "r9",
        state: { kind: "running", runId: "r9" },
      },
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

describe("handleAgentRun — a candidate the user picked (C2.5)", () => {
  const conn = { origin: "http://127.0.0.1:8765", token: "t", label: "chrome", pairedAt: 0 };
  const candidates = [
    { id: "gh-1", service: "github", type: "pr", title: "One", url: null },
    { id: "gh-2", service: "github", type: "pr", title: "Two", url: null },
  ];
  const ambiguous = {
    ok: true as const,
    outcome: { kind: "ambiguous" as const, candidates, fetchable: false, truncated: false },
  };

  function deps(seen: Array<{ params: unknown }>, subjects: Array<unknown> = []) {
    return {
      getOrigins: async () => [],
      getConnection: async () => conn,
      resolveItem: async () => ambiguous,
      invokeAgent: async (_o: string, _t: string, _agent: string, params: unknown) => {
        seen.push({ params });
        return { ok: true as const, runId: "r1" };
      },
      getRun: async () => null,
      putRun: async (run: { subject: unknown }) => {
        subjects.push(run.subject);
      },
    };
  }

  it("answers about the picked candidate instead of refusing the ambiguity", async () => {
    const seen: Array<{ params: unknown }> = [];
    const subjects: unknown[] = [];
    const res = await handleAgentRun(deps(seen, subjects), {
      kind: "agent-run",
      lane: "expert",
      pageUrl: "https://github.com/a/b/pull/1",
      itemId: "gh-2",
    });
    expect(res.state).toEqual({ kind: "running", runId: "r1" });
    // The PICKED candidate's title, not the first one's — the whole point.
    expect(seen[0]?.params).toEqual({ topicOrFile: "Two" });
    // And it caches under that item, so the answer cannot leak to its sibling.
    expect(subjects[0]).toEqual({ kind: "item", id: "gh-2" });
  });

  // The id comes from a content script. An id the gateway never offered is
  // refused exactly like any other unverified cross-boundary value.
  it("refuses an id that is not among the candidates this resolve produced", async () => {
    const seen: Array<{ params: unknown }> = [];
    const res = await handleAgentRun(deps(seen), {
      kind: "agent-run",
      lane: "expert",
      pageUrl: "https://github.com/a/b/pull/1",
      itemId: "gh-999",
    });
    expect(res.state).toEqual({ kind: "failed", reason: "not_resolved" });
    expect(seen).toEqual([]);
  });

  it("still refuses an ambiguous page when no candidate was picked", async () => {
    const seen: Array<{ params: unknown }> = [];
    const res = await handleAgentRun(deps(seen), {
      kind: "agent-run",
      lane: "expert",
      pageUrl: "https://github.com/a/b/pull/1",
    });
    expect(res.state).toEqual({ kind: "failed", reason: "not_resolved" });
    expect(seen).toEqual([]);
  });
});

describe("handleAgentRun — the glossary lane takes a term", () => {
  const conn = { origin: "http://127.0.0.1:8765", token: "t", label: "chrome", pairedAt: 0 };

  function deps(seen: Array<{ agent: string; params: unknown }>, subjects: unknown[] = []) {
    return {
      getOrigins: async () => {
        throw new Error("a term lane must not consult the recogniser's origins");
      },
      getConnection: async () => conn,
      resolveItem: async () => {
        throw new Error("a term lane must not resolve the page");
      },
      invokeAgent: async (_o: string, _t: string, agent: string, params: unknown) => {
        seen.push({ agent, params });
        return { ok: true as const, runId: "r1" };
      },
      getRun: async () => null,
      putRun: async (run: { subject: unknown }) => {
        subjects.push(run.subject);
      },
    };
  }

  // The decision this lane turns on: `POST /v1/agents/glossary` takes `{term}`
  // and no URL, so the recogniser gate — which exists to decide which page URLs
  // may reach the gateway — has nothing to gate. Both throwing deps above are
  // the assertion; reaching either would fail the test.
  it("answers on a page the recogniser would reject, with no resolve call", async () => {
    const seen: Array<{ agent: string; params: unknown }> = [];
    const subjects: unknown[] = [];
    const res = await handleAgentRun(deps(seen, subjects), {
      kind: "agent-run",
      lane: "glossary",
      pageUrl: "https://wiki.internal.example/runbooks/deploy",
      term: "blast radius",
    });
    expect(res.state).toEqual({ kind: "running", runId: "r1" });
    expect(seen[0]).toEqual({ agent: "glossary", params: { term: "blast radius" } });
    expect(subjects[0]).toEqual({ kind: "term", term: "blast radius" });
  });

  it("still needs a pairing", async () => {
    const seen: Array<{ agent: string; params: unknown }> = [];
    const res = await handleAgentRun(
      { ...deps(seen), getConnection: async () => null },
      { kind: "agent-run", lane: "glossary", pageUrl: "https://example.com", term: "canary" },
    );
    expect(res.state).toEqual({ kind: "failed", reason: "not_paired" });
    expect(seen).toEqual([]);
  });

  // Unreachable from the shipped UI — the panel materialises the lane only once
  // a term exists — so this is the answer to a forged message. `no_term` and not
  // `not_resolved`: the page is not what is missing.
  it("reports no_term when a forged message omits the term", async () => {
    const seen: Array<{ agent: string; params: unknown }> = [];
    const res = await handleAgentRun(deps(seen), {
      kind: "agent-run",
      lane: "glossary",
      pageUrl: "https://example.com",
    });
    expect(res.state).toEqual({ kind: "failed", reason: "no_term" });
    expect(seen).toEqual([]);
  });

  it("keeps two terms apart in the cache", async () => {
    const subjects: unknown[] = [];
    const seen: Array<{ agent: string; params: unknown }> = [];
    await handleAgentRun(deps(seen, subjects), {
      kind: "agent-run",
      lane: "glossary",
      pageUrl: "https://example.com",
      term: "canary",
    });
    await handleAgentRun(deps(seen, subjects), {
      kind: "agent-run",
      lane: "glossary",
      pageUrl: "https://example.com",
      term: "blast radius",
    });
    expect(subjects).toEqual([
      { kind: "term", term: "canary" },
      { kind: "term", term: "blast radius" },
    ]);
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
          subject: { kind: "item" as const, id: "gh-1" },
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

describe("service lanes on a home page", () => {
  it("invokes with the service and never calls resolve", async () => {
    let resolveCalls = 0;
    const invoked: Array<{ agent: string; params: unknown }> = [];
    const deps = {
      getOrigins: async () => [
        { origin: "https://jenkins.corp.example", product: "jenkins" as const },
      ],
      getConnection: async () => ({ origin: "http://127.0.0.1:7777", token: "t", label: "dev" }),
      resolveItem: async () => {
        resolveCalls += 1;
        throw new Error("resolve must not be called on a home page");
      },
      invokeAgent: async (_o: string, _t: string, agent: string, params: unknown) => {
        invoked.push({ agent, params });
        return { ok: true as const, runId: "run_1" };
      },
      getRun: async () => null,
      putRun: async () => undefined,
    };

    const res = await handleAgentRun(deps, {
      kind: "agent-run",
      lane: "catchup",
      pageUrl: "https://jenkins.corp.example/",
    });

    expect(resolveCalls).toBe(0);
    expect(invoked).toEqual([{ agent: "catchup", params: { service: "jenkins" } }]);
    expect(res.state).toEqual({ kind: "running", runId: "run_1" });
  });

  it("caches a service run under the service, not a page", async () => {
    const puts: unknown[] = [];
    const deps = {
      getOrigins: async () => [],
      getConnection: async () => ({ origin: "http://127.0.0.1:7777", token: "t", label: "dev" }),
      resolveItem: async () => {
        throw new Error("unused");
      },
      invokeAgent: async () => ({ ok: true as const, runId: "run_2" }),
      getRun: async () => null,
      putRun: async (r: unknown) => {
        puts.push(r);
      },
    };

    await handleAgentRun(deps, {
      kind: "agent-run",
      lane: "decisions",
      pageUrl: "https://github.com/",
    });

    expect(puts).toEqual([
      {
        subject: { kind: "service", service: "github" },
        lane: "decisions",
        runId: "run_2",
        state: { kind: "running", runId: "run_2" },
      },
    ]);
  });

  it("replays a cached service answer without a second invoke", async () => {
    let invokes = 0;
    const deps = {
      getOrigins: async () => [],
      getConnection: async () => ({ origin: "http://127.0.0.1:7777", token: "t", label: "dev" }),
      resolveItem: async () => {
        throw new Error("unused");
      },
      invokeAgent: async () => {
        invokes += 1;
        return { ok: true as const, runId: "run_3" };
      },
      getRun: async () => ({
        subject: { kind: "service" as const, service: "github" },
        lane: "catchup" as const,
        runId: "run_old",
        state: { kind: "done" as const, brief: "Yesterday: 3 merges." },
        expiresAtMs: Number.MAX_SAFE_INTEGER,
      }),
      putRun: async () => undefined,
    };

    const res = await handleAgentRun(deps, {
      kind: "agent-run",
      lane: "catchup",
      pageUrl: "https://github.com/",
    });

    expect(invokes).toBe(0);
    expect(res.state).toEqual({ kind: "done", brief: "Yesterday: 3 merges." });
  });

  it("refuses a service lane when the page is not recognised", async () => {
    const deps = {
      getOrigins: async () => [],
      getConnection: async () => ({ origin: "http://127.0.0.1:7777", token: "t", label: "dev" }),
      resolveItem: async () => {
        throw new Error("unused");
      },
      invokeAgent: async () => {
        throw new Error("must not invoke");
      },
      getRun: async () => null,
      putRun: async () => undefined,
    };

    const res = await handleAgentRun(deps, {
      kind: "agent-run",
      lane: "catchup",
      pageUrl: "https://example.com/whatever",
    });

    expect(res.state).toEqual({ kind: "failed", reason: "not_resolved" });
  });
});

describe("lane/surface pairing enforcement", () => {
  // `LANE_SURFACES` gates which lanes the panel ever renders per surface — the
  // panel would never send this pair. But `agent-run` arrives from a content
  // script, and `isAgentRunRequest` validates only that `lane` is an `AgentLane`
  // and `pageUrl` a string, never the pairing between them — so the handler must
  // enforce it itself. `invokeAgent` (and `getConnection`/`resolveItem`) throw
  // below so a leak past the gate cannot pass silently.

  it("refuses impact requested on a dashboard, never invoking", async () => {
    const res = await handleAgentRun(
      {
        getOrigins: async () => [],
        getConnection: async () => {
          throw new Error("must not read the connection");
        },
        resolveItem: async () => {
          throw new Error("must not resolve");
        },
        invokeAgent: async () => {
          throw new Error("must not invoke");
        },
        getRun: async () => null,
        putRun: async () => undefined,
      },
      { kind: "agent-run", lane: "impact", pageUrl: "https://github.com/" },
    );

    expect(res.state).toEqual({ kind: "failed", reason: "not_resolved" });
  });

  it("refuses catchup requested on a resolved pull-request URL, never invoking", async () => {
    const res = await handleAgentRun(
      {
        getOrigins: async () => [],
        getConnection: async () => {
          throw new Error("must not read the connection");
        },
        resolveItem: async () => {
          throw new Error("must not resolve");
        },
        invokeAgent: async () => {
          throw new Error("must not invoke");
        },
        getRun: async () => null,
        putRun: async () => undefined,
      },
      { kind: "agent-run", lane: "catchup", pageUrl: "https://github.com/a/b/pull/1" },
    );

    expect(res.state).toEqual({ kind: "failed", reason: "not_resolved" });
  });
});

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
