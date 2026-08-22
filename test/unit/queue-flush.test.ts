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

const noPause = { pausedUntilMs: async () => 0, nowMs: () => 1000 };

describe("flushQueue", () => {
  test("unpaired → no-op, queue intact", async () => {
    const s = store([entry("a")]);
    const out = await flushQueue({
      getConnection: async () => null,
      getQueue: s.getQueue,
      updateQueue: s.updateQueue,
      ...noPause,
      postClip: async () => ({ ok: true, status: "created" }),
    });
    expect(out).toEqual({ remaining: 1 });
    expect(s.current()).toHaveLength(1);
  });

  // The easy miss: a queued clip is re-validated on flush, so a guard that
  // does not know about `source` drops the metadata of every clip captured
  // offline — silently, and only offline, which is the worst way to find a bug.
  test("a clip queued offline keeps its source metadata when it flushes", async () => {
    const base = entry("a");
    const source = { author: "Ada Lovelace", publishedAt: 1_710_149_400_000 };
    const s = store([{ ...base, payload: { ...base.payload, source } }]);
    const posted: ClipPayload[] = [];
    const out = await flushQueue({
      getConnection: async () => conn,
      getQueue: s.getQueue,
      updateQueue: s.updateQueue,
      ...noPause,
      postClip: async (_origin, _token, payload) => {
        posted.push(payload);
        return { ok: true, status: "created" };
      },
    });
    expect(out).toEqual({ remaining: 0 });
    expect(posted[0]?.source).toEqual(source);
  });

  test("success drains every entry", async () => {
    const s = store([entry("a"), entry("b")]);
    const out = await flushQueue({
      getConnection: async () => conn,
      getQueue: s.getQueue,
      updateQueue: s.updateQueue,
      ...noPause,
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
      ...noPause,
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
      ...noPause,
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
    const post = async (
      _o: string,
      _t: string,
      p: ClipPayload,
    ): Promise<{ ok: true; status: "created" } | { ok: false; reason: ClipError }> => {
      tried.push(p.url);
      return { ok: true, status: "created" };
    };
    const s1 = store([entry("a", "invalid_request")]);
    await flushQueue({
      getConnection: async () => conn,
      getQueue: s1.getQueue,
      updateQueue: s1.updateQueue,
      ...noPause,
      postClip: post,
    });
    expect(tried).toEqual([]); // skipped on auto

    const s2 = store([entry("a", "invalid_request")]);
    await flushQueue(
      {
        getConnection: async () => conn,
        getQueue: s2.getQueue,
        updateQueue: s2.updateQueue,
        ...noPause,
        postClip: post,
      },
      { manual: true },
    );
    expect(tried).toEqual(["a"]); // attempted on manual
  });

  test("auto flush skips a payload_too_large entry; manual attempts it", async () => {
    const tried: string[] = [];
    const post = async (
      _o: string,
      _t: string,
      p: ClipPayload,
    ): Promise<{ ok: true; status: "created" } | { ok: false; reason: ClipError }> => {
      tried.push(p.url);
      return { ok: true, status: "created" };
    };
    const s1 = store([entry("a", "payload_too_large")]);
    await flushQueue({
      getConnection: async () => conn,
      getQueue: s1.getQueue,
      updateQueue: s1.updateQueue,
      ...noPause,
      postClip: post,
    });
    expect(tried).toEqual([]); // skipped on auto

    const s2 = store([entry("a", "payload_too_large")]);
    await flushQueue(
      {
        getConnection: async () => conn,
        getQueue: s2.getQueue,
        updateQueue: s2.updateQueue,
        ...noPause,
        postClip: post,
      },
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
        ...noPause,
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
});
