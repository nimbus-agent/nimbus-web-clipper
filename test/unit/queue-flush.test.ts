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
      postClip: post,
    });
    expect(tried).toEqual([]); // skipped on auto

    const s2 = store([entry("a", "invalid_request")]);
    await flushQueue(
      {
        getConnection: async () => conn,
        getQueue: s2.getQueue,
        updateQueue: s2.updateQueue,
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
