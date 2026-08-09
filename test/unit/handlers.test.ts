import { describe, expect, it, test } from "vitest";
import {
  handleClip,
  handleConnectionStatus,
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
        getConnection: async () => ({ origin: "http://127.0.0.1:8765", token: "t" }),
        resolveItem: async (_o, _t, url) => {
          seen.push(url);
          return { ok: true, outcome: { kind: "not-indexed", fetchable: true } };
        },
      },
      // Note: recognise() canonicalises away the query string, so the recogniser's
      // resolveUrl (asserted below) differs from the raw pageUrl — that's the point.
      { kind: "resolve", pageUrl: "https://github.com/a/b/pull/1?files=1" },
    );

    expect(seen).toEqual(["https://github.com/a/b/pull/1"]);
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
        getConnection: async () => ({ origin: "http://127.0.0.1:8765", token: "t" }),
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

  it("makes no gateway call for an unrecognised page", async () => {
    let called = false;
    const res = await handleResolve(
      {
        getOrigins: async () => [],
        getConnection: async () => ({ origin: "http://127.0.0.1:8765", token: "t" }),
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
    expect(sent).toBe("https://corp.example/jira/browse/PLAT-9");
  });
});
