import { describe, expect, test } from "vitest";
import type { QueuedClip } from "../../src/shared/queue.ts";
import {
  enqueue,
  isQueuedClip,
  MAX_QUEUE,
  markAttempt,
  removeFromQueue,
  toView,
} from "../../src/shared/queue.ts";

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
